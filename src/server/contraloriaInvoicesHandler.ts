import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  type AllowedFiscalDocumentMime,
  buildDeterministicInvoiceStoragePath,
  CONTRALORIA_FACTURAS_BUCKET_ID,
  FiscalDocumentSecurityError,
  MAX_FISCAL_RECEIPT_BYTES,
  verifyFiscalDocumentMagicBytes,
} from './fiscalReceiptFileValidator';
import {
  type AuthenticatedServerUser,
  createUserScopedSupabaseClient,
  getAdminSupabaseClient,
} from './supabaseAdminAuth';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_INVOICE_SIGNED_URL_TTL_SECONDS = 300;

export const UploadFiscalReceiptMetaSchema = z.object({
  requisicionId: z.string().regex(UUID_REGEX, 'requisicionId debe ser un UUID válido.'),
  conciliacionId: z.string().regex(UUID_REGEX, 'conciliacionId debe ser un UUID válido.'),
  invoiceNumber: z.string().trim().min(2, 'Número de factura obligatorio.').max(80),
  supplierRif: z
    .string()
    .trim()
    .min(5, 'RIF del proveedor obligatorio.')
    .max(30)
    .transform((v) => v.toUpperCase()),
  supplierName: z.string().trim().min(2, 'Razón social del proveedor obligatoria.').max(180),
  concept: z.string().trim().min(2, 'Concepto del gasto obligatorio.').max(300),
  subtotalUsd: z.coerce.number().finite().min(0),
  taxAmountUsd: z.coerce.number().finite().min(0),
  totalUsd: z.coerce.number().finite().positive('El monto total debe ser mayor a 0.'),
});

export const BatchInvoiceSignedUrlsSchema = z.object({
  facturaIds: z
    .array(z.string().regex(UUID_REGEX))
    .min(1, 'Debe indicar al menos un facturaId.')
    .max(50, 'Máximo 50 facturas por lote.'),
});

export interface ContraloriaInvoiceDbRow {
  id: string;
  conciliacion_id: string;
  requisicion_id: string;
  numero_factura: string;
  rif_proveedor: string;
  razon_social_proveedor: string;
  concepto: string;
  subtotal_usd: number;
  impuesto_usd: number;
  total_usd: number;
  storage_bucket: string | null;
  storage_path: string | null;
  mime_type: string | null;
  tamano_bytes: number | null;
  archivo_sha256_hex: string | null;
  validada_contraloria: boolean;
  notas_validacion: string | null;
  sucursal: 'ZULIA' | 'VALENCIA' | null;
  created_at: string;
}

export interface ConciliacionLookupRow {
  id: string;
  requisicion_id: string;
  cerrada: boolean;
  sucursal: 'ZULIA' | 'VALENCIA' | null;
}

export interface ContraloriaInvoicesGateway {
  lookupConciliacion(conciliacionId: string): Promise<ConciliacionLookupRow | null>;
  uploadPrivateInvoiceObject(params: {
    bucket: string;
    path: string;
    buffer: Buffer;
    mimeType: AllowedFiscalDocumentMime;
  }): Promise<void>;
  deletePrivateInvoiceObjects(bucket: string, paths: string[]): Promise<void>;
  insertFiscalReceiptRow(params: {
    conciliacionId: string;
    requisicionId: string;
    numeroFactura: string;
    rifProveedor: string;
    razonSocialProveedor: string;
    concepto: string;
    subtotalUsd: number;
    impuestoUsd: number;
    totalUsd: number;
    storageBucket: string;
    storagePath: string;
    mimeType: AllowedFiscalDocumentMime;
    tamanoBytes: number;
    archivoSha256Hex: string;
    cargadoPorUid: string;
    sucursal: 'ZULIA' | 'VALENCIA';
  }): Promise<ContraloriaInvoiceDbRow>;
  findInvoicesByIds(facturaIds: string[]): Promise<ContraloriaInvoiceDbRow[]>;
  createSignedUrls(
    bucket: string,
    paths: string[],
    ttlSeconds: number
  ): Promise<Record<string, string>>;
}

function normalizeRegionalBranch(raw: unknown): 'ZULIA' | 'VALENCIA' | null {
  const clean = String(raw ?? '').trim().toUpperCase();
  if (clean === 'ZULIA') return 'ZULIA';
  if (clean === 'VALENCIA') return 'VALENCIA';
  return null;
}

function canActorAccessBranch(
  actor: AuthenticatedServerUser,
  targetBranch: 'ZULIA' | 'VALENCIA' | null
): boolean {
  if (actor.sucursal === 'GLOBAL') return true;
  if (!actor.sucursal || !targetBranch) return false;
  return actor.sucursal === targetBranch;
}

function decodeFacturaMetaHeader(req: Request): unknown {
  const rawHeader = req.headers['x-factura-meta'];
  const headerStr = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!headerStr || typeof headerStr !== 'string') return null;
  if (headerStr.length > 4096) {
    throw new Error('METADATA_HEADER_TOO_LARGE');
  }
  const normalizedB64 = headerStr.trim().replace(/-/g, '+').replace(/_/g, '/');
  const jsonText = Buffer.from(normalizedB64, 'base64').toString('utf8');
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const safeCopy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    safeCopy[k] = v;
  }
  return safeCopy;
}

function createSupabaseContraloriaInvoicesGateway(
  accessToken?: string
): ContraloriaInvoicesGateway | null {
  const client =
    getAdminSupabaseClient() || (accessToken ? createUserScopedSupabaseClient(accessToken) : null);
  if (!client) return null;

  return {
    async lookupConciliacion(conciliacionId) {
      const { data, error } = await client
        .from('contraloria_conciliaciones')
        .select('id, requisicion_id, cerrada, sucursal')
        .eq('id', conciliacionId)
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: String(data.id),
        requisicion_id: String(data.requisicion_id),
        cerrada: Boolean(data.cerrada),
        sucursal: normalizeRegionalBranch(data.sucursal),
      };
    },
    async uploadPrivateInvoiceObject({ bucket, path, buffer, mimeType }) {
      const { error } = await client.storage.from(bucket).upload(path, buffer, {
        contentType: mimeType,
        upsert: false,
      });
      if (error) {
        throw new Error(`Storage upload failed: ${error.message}`);
      }
    },
    async deletePrivateInvoiceObjects(bucket, paths) {
      if (paths.length === 0) return;
      await client.storage.from(bucket).remove(paths);
    },
    async insertFiscalReceiptRow(params) {
      const { data, error } = await client
        .from('contraloria_facturas')
        .insert({
          conciliacion_id: params.conciliacionId,
          requisicion_id: params.requisicionId,
          numero_factura: params.numeroFactura.toUpperCase(),
          rif_proveedor: params.rifProveedor.toUpperCase(),
          razon_social_proveedor: params.razonSocialProveedor,
          concepto: params.concepto,
          subtotal_usd: params.subtotalUsd,
          impuesto_usd: params.impuestoUsd,
          total_usd: params.totalUsd,
          storage_bucket: params.storageBucket,
          storage_path: params.storagePath,
          mime_type: params.mimeType,
          tamano_bytes: params.tamanoBytes,
          archivo_sha256_hex: params.archivoSha256Hex,
          validada_contraloria: false,
          cargado_por_uid: params.cargadoPorUid,
          sucursal: params.sucursal,
        })
        .select('*')
        .single();
      if (error || !data) {
        const errObj = new Error(error?.message || 'Error insertando factura fiscal.');
        (errObj as unknown as { pgCode?: string }).pgCode = error?.code;
        throw errObj;
      }
      return data as unknown as ContraloriaInvoiceDbRow;
    },
    async findInvoicesByIds(facturaIds) {
      const { data, error } = await client
        .from('contraloria_facturas')
        .select('*')
        .in('id', facturaIds);
      if (error || !data) return [];
      return data as unknown as ContraloriaInvoiceDbRow[];
    },
    async createSignedUrls(bucket, paths, ttlSeconds) {
      if (paths.length === 0) return {};
      const { data, error } = await client.storage.from(bucket).createSignedUrls(paths, ttlSeconds);
      if (error || !data) return {};
      const out: Record<string, string> = {};
      for (const item of data) {
        if (item.path && item.signedUrl) {
          out[item.path] = item.signedUrl;
        }
      }
      return out;
    },
  };
}

export function createContraloriaInvoicesHandlers(options?: {
  resolveGateway?: (authUser: AuthenticatedServerUser) => ContraloriaInvoicesGateway | null;
  bucketId?: string;
  signedUrlTtlSeconds?: number;
}) {
  const resolveGateway =
    options?.resolveGateway ??
    ((user: AuthenticatedServerUser) => createSupabaseContraloriaInvoicesGateway(user.accessToken));
  const bucketId = options?.bucketId || CONTRALORIA_FACTURAS_BUCKET_ID;
  const ttlSeconds = options?.signedUrlTtlSeconds || DEFAULT_INVOICE_SIGNED_URL_TTL_SECONDS;

  const handleUploadFiscalReceipt = async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    let rawMeta: unknown;
    try {
      rawMeta = decodeFacturaMetaHeader(req);
    } catch {
      res.status(400).json({
        error: 'Cabecera x-factura-meta inválida o corrupta.',
        code: 'INVALID_META_HEADER',
      });
      return;
    }

    const parsedMeta = UploadFiscalReceiptMetaSchema.safeParse(rawMeta);
    if (!parsedMeta.success) {
      res.status(400).json({
        error: parsedMeta.error.issues[0]?.message || 'Metadatos de factura inválidos.',
        code: 'INVALID_FACTURA_METADATA',
      });
      return;
    }

    const rawBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let verifiedBinary;
    try {
      verifiedBinary = verifyFiscalDocumentMagicBytes(rawBuffer, MAX_FISCAL_RECEIPT_BYTES);
    } catch (err) {
      if (err instanceof FiscalDocumentSecurityError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(415).json({
        error: 'Archivo binario rechazado.',
        code: 'UNSUPPORTED_MAGIC_BYTES',
      });
      return;
    }

    const gateway = resolveGateway(authUser);
    if (!gateway) {
      res.status(503).json({
        error: 'Servicio de almacenamiento fiscal no configurado.',
        code: 'STORAGE_UNCONFIGURED',
      });
      return;
    }

    const meta = parsedMeta.data;
    const conc = await gateway.lookupConciliacion(meta.conciliacionId);
    if (!conc || conc.requisicion_id !== meta.requisicionId) {
      res.status(404).json({
        error: 'La conciliación asociada a la requisición no existe.',
        code: 'RECONCILIATION_NOT_FOUND',
      });
      return;
    }

    if (!canActorAccessBranch(authUser, conc.sucursal)) {
      res.status(403).json({
        error: 'Acceso denegado: la conciliación pertenece a otra sucursal.',
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

    if (conc.cerrada) {
      res.status(409).json({
        error: 'La conciliación está cerrada con Paz y Salvo inmutable y no admite más facturas.',
        code: 'RECONCILIATION_CLOSED',
      });
      return;
    }

    const targetBranch: 'ZULIA' | 'VALENCIA' =
      conc.sucursal ?? (authUser.sucursal === 'VALENCIA' ? 'VALENCIA' : 'ZULIA');
    const storagePath = buildDeterministicInvoiceStoragePath({
      sucursal: targetBranch,
      requisicionId: meta.requisicionId,
      extension: verifiedBinary.extension,
    });

    let uploaded = false;
    try {
      await gateway.uploadPrivateInvoiceObject({
        bucket: bucketId,
        path: storagePath,
        buffer: rawBuffer,
        mimeType: verifiedBinary.mimeType,
      });
      uploaded = true;

      const savedRow = await gateway.insertFiscalReceiptRow({
        conciliacionId: meta.conciliacionId,
        requisicionId: meta.requisicionId,
        numeroFactura: meta.invoiceNumber,
        rifProveedor: meta.supplierRif,
        razonSocialProveedor: meta.supplierName,
        concepto: meta.concept,
        subtotalUsd: meta.subtotalUsd,
        impuestoUsd: meta.taxAmountUsd,
        totalUsd: meta.totalUsd,
        storageBucket: bucketId,
        storagePath,
        mimeType: verifiedBinary.mimeType,
        tamanoBytes: verifiedBinary.sizeBytes,
        archivoSha256Hex: verifiedBinary.sha256Hex,
        cargadoPorUid: authUser.id,
        sucursal: targetBranch,
      });

      const signedUrls = await gateway.createSignedUrls(bucketId, [storagePath], ttlSeconds);
      res.status(201).json({
        ok: true,
        factura: savedRow,
        signedUrl: signedUrls[storagePath] || null,
      });
    } catch (err) {
      // Rollback del blob privado para no dejar archivos huérfanos en Storage
      if (uploaded) {
        await gateway.deletePrivateInvoiceObjects(bucketId, [storagePath]).catch(() => undefined);
      }
      const pgCode = (err as { pgCode?: string } | null)?.pgCode;
      const msg = err instanceof Error ? err.message : 'Error registrando factura fiscal.';
      if (pgCode === '23505' || /uq_contraloria_facturas_rif_numero|duplicate key/i.test(msg)) {
        res.status(409).json({
          error:
            'ERROR CRÍTICO ANTIFRAUDE: Ya existe una factura con ese número y RIF de proveedor. Prohibida la doble rendición.',
          code: 'DUPLICATE_INVOICE',
        });
        return;
      }
      res.status(500).json({ error: msg, code: 'INVOICE_UPLOAD_FAILED' });
    }
  };

  const handleBatchFiscalReceiptSignedUrls = async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const parsed = BatchInvoiceSignedUrlsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Solicitud de URLs firmadas inválida.',
        code: 'INVALID_SIGNED_URLS_PAYLOAD',
      });
      return;
    }

    const gateway = resolveGateway(authUser);
    if (!gateway) {
      res.status(503).json({
        error: 'Servicio de almacenamiento fiscal no configurado.',
        code: 'STORAGE_UNCONFIGURED',
      });
      return;
    }

    const rows = await gateway.findInvoicesByIds(parsed.data.facturaIds);
    const authorizedRows = rows.filter(
      (r) => r.storage_path && canActorAccessBranch(authUser, normalizeRegionalBranch(r.sucursal))
    );
    const paths = authorizedRows
      .map((r) => r.storage_path!)
      .filter(Boolean);

    const signedMap = await gateway.createSignedUrls(bucketId, paths, ttlSeconds);
    const urlsByFacturaId: Record<string, string> = {};
    for (const row of authorizedRows) {
      if (row.storage_path && signedMap[row.storage_path]) {
        urlsByFacturaId[row.id] = signedMap[row.storage_path]!;
      }
    }

    res.status(200).json({
      ok: true,
      ttlSeconds,
      urls: urlsByFacturaId,
    });
  };

  return {
    handleUploadFiscalReceipt,
    handleBatchFiscalReceiptSignedUrls,
  };
}

const defaultHandlers = createContraloriaInvoicesHandlers();
export const handleUploadFiscalReceipt = defaultHandlers.handleUploadFiscalReceipt;
export const handleBatchFiscalReceiptSignedUrls = defaultHandlers.handleBatchFiscalReceiptSignedUrls;
