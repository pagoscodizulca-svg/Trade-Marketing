import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AllowedAttendanceImageMime } from '../types/attendanceEvidences';
import { getCaracasTodayYmd } from '../utils/caracasWeekCycle';
import {
  AttendanceFileSecurityError,
  verifyAttendanceImageMagicBytes,
} from './imageMagicBytesValidator';
import {
  type AuthenticatedServerUser,
  createUserScopedSupabaseClient,
  getAdminSupabaseClient,
  isTorreViewerRole,
} from './supabaseAdminAuth';

export const INCIDENCIAS_PRIVATE_BUCKET_ID = 'incidencias-evidencias';
export const MAX_INCIDENCIA_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TIPO_INCIDENCIA_VALUES = [
  'QUIEBRE_STOCK',
  'PRECIO_INCORRECTO',
  'MATERIAL_POP_DANADO',
  'COMPETENCIA_AGRESIVA',
  'CALIDAD_PRODUCTO',
  'ACCESO_PDV',
  'OTRO',
] as const;

export const SEVERIDAD_INCIDENCIA_VALUES = ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'] as const;

export type TipoIncidenciaPdv = (typeof TIPO_INCIDENCIA_VALUES)[number];
export type SeveridadIncidenciaPdv = (typeof SEVERIDAD_INCIDENCIA_VALUES)[number];

export const SLA_HOURS_BY_SEVERIDAD: Readonly<Record<SeveridadIncidenciaPdv, number>> = {
  CRITICA: 4,
  ALTA: 12,
  MEDIA: 24,
  BAJA: 72,
};

export function computeSlaDeadlineIso(
  severidad: SeveridadIncidenciaPdv,
  baseDate: Date = new Date()
): { slaHoras: number; slaVenceEnIso: string } {
  const slaHoras = SLA_HOURS_BY_SEVERIDAD[severidad] ?? 24;
  const deadlineMs = baseDate.getTime() + slaHoras * 3600 * 1000;
  return {
    slaHoras,
    slaVenceEnIso: new Date(deadlineMs).toISOString(),
  };
}

export const UploadIncidenciaEvidenceMetaSchema = z.object({
  pdvNombre: z.string().trim().min(2, 'El nombre del PDV es obligatorio.').max(180),
  clienteId: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v) => (v && UUID_REGEX.test(v) ? v : null)),
  rutaId: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v) => (v && UUID_REGEX.test(v) ? v : null)),
  tipoIncidencia: z.enum(TIPO_INCIDENCIA_VALUES),
  severidad: z.enum(SEVERIDAD_INCIDENCIA_VALUES),
  descripcion: z
    .string()
    .trim()
    .min(5, 'La descripción de la incidencia debe tener al menos 5 caracteres.')
    .max(1000),
  responsableNombre: z
    .string()
    .trim()
    .min(2)
    .max(140)
    .optional()
    .default('Coordinación Trade'),
  reportadoPorNombre: z.string().trim().min(2).max(140).optional(),
  sucursal: z.enum(['ZULIA', 'VALENCIA']).optional(),
});

export const BatchIncidenciaSignedUrlsSchema = z.object({
  incidenciaIds: z
    .array(z.string().regex(UUID_REGEX))
    .min(1, 'Indique al menos un identificador de incidencia.')
    .max(50, 'Máximo 50 incidencias por consulta.'),
});

export interface IncidenciaPdvDbRow {
  id: string;
  codigo_incidencia: string;
  cliente_id: string | null;
  pdv_nombre: string;
  ruta_id: string | null;
  reportado_por_uid: string;
  reportado_por_nombre: string;
  responsable_uid: string | null;
  responsable_nombre: string;
  tipo_incidencia: TipoIncidenciaPdv;
  severidad: SeveridadIncidenciaPdv;
  descripcion: string;
  estado: 'ABIERTA' | 'EN_PROCESO' | 'RESUELTA' | 'CERRADA';
  sla_horas: number;
  sla_vence_en: string;
  resuelta_en: string | null;
  notas_resolucion: string;
  foto_storage_bucket: string | null;
  foto_storage_path: string | null;
  foto_mime_type: string | null;
  foto_sha256_hex: string | null;
  sucursal: 'ZULIA' | 'VALENCIA' | null;
  created_at: string;
  updated_at: string;
}

export interface IncidenciasEvidencesGateway {
  uploadPrivateObject(params: {
    bucket: string;
    path: string;
    buffer: Buffer;
    mimeType: AllowedAttendanceImageMime;
  }): Promise<void>;
  deletePrivateObjects(bucket: string, paths: string[]): Promise<void>;
  insertIncidenciaRow(params: {
    clienteId: string | null;
    pdvNombre: string;
    rutaId: string | null;
    reportadoPorUid: string;
    reportadoPorNombre: string;
    responsableNombre: string;
    tipoIncidencia: TipoIncidenciaPdv;
    severidad: SeveridadIncidenciaPdv;
    descripcion: string;
    slaHoras: number;
    slaVenceEnIso: string;
    storageBucket: string;
    storagePath: string;
    mimeType: AllowedAttendanceImageMime;
    sha256Hex: string;
    sucursal: 'ZULIA' | 'VALENCIA';
  }): Promise<IncidenciaPdvDbRow>;
  findIncidenciasByIds(ids: string[]): Promise<IncidenciaPdvDbRow[]>;
  createSignedUrls(
    bucket: string,
    paths: string[],
    ttlSeconds: number
  ): Promise<Record<string, string>>;
}

export function buildDeterministicIncidenciaStoragePath(params: {
  sucursal: 'ZULIA' | 'VALENCIA';
  fechaYmd?: string;
  extension: 'jpg' | 'png' | 'webp';
  fileUuid?: string;
}): string {
  const branch = params.sucursal === 'VALENCIA' ? 'VALENCIA' : 'ZULIA';
  const ymd =
    params.fechaYmd && /^\d{4}-\d{2}-\d{2}$/.test(params.fechaYmd)
      ? params.fechaYmd
      : getCaracasTodayYmd();
  const uuid =
    params.fileUuid && UUID_REGEX.test(params.fileUuid)
      ? params.fileUuid.toLowerCase()
      : crypto.randomUUID();
  return `incidencias/${branch}/${ymd}/${uuid}.${params.extension}`;
}

function decodeIncidenciaMetaHeader(req: Request): unknown {
  const raw = req.headers['x-incidencia-meta'];
  const headerStr = Array.isArray(raw) ? raw[0] : raw;
  if (!headerStr || typeof headerStr !== 'string') return null;
  if (headerStr.length > 8192) {
    throw new Error('METADATA_HEADER_TOO_LARGE');
  }

  const normalizedB64 = headerStr.trim().replace(/-/g, '+').replace(/_/g, '/');
  const parsed = JSON.parse(Buffer.from(normalizedB64, 'base64').toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    safe[k] = v;
  }
  return safe;
}

function canActorAccessBranch(
  actor: AuthenticatedServerUser,
  target: 'ZULIA' | 'VALENCIA' | null
): boolean {
  if (actor.sucursal === 'GLOBAL') return true;
  if (!actor.sucursal || !target) return false;
  return actor.sucursal === target;
}

function createSupabaseIncidenciasGateway(
  actor: AuthenticatedServerUser
): IncidenciasEvidencesGateway | null {
  const adminClient = getAdminSupabaseClient();
  const userClient = actor.accessToken
    ? createUserScopedSupabaseClient(actor.accessToken)
    : null;
  if (!adminClient || !userClient) return null;

  return {
    async uploadPrivateObject({ bucket, path, buffer, mimeType }) {
      const { error } = await adminClient.storage.from(bucket).upload(path, buffer, {
        contentType: mimeType,
        upsert: false,
      });
      if (error) {
        throw new Error(error.message || 'No se pudo almacenar la foto de la incidencia.');
      }
    },
    async deletePrivateObjects(bucket, paths) {
      if (paths.length === 0) return;
      await adminClient.storage.from(bucket).remove(paths);
    },
    async insertIncidenciaRow(params) {
      const { data, error } = await userClient
        .from('incidencias_pdv')
        .insert({
          codigo_incidencia: 'AUTO',
          cliente_id: params.clienteId,
          pdv_nombre: params.pdvNombre,
          ruta_id: params.rutaId,
          reportado_por_uid: params.reportadoPorUid,
          reportado_por_nombre: params.reportadoPorNombre,
          responsable_nombre: params.responsableNombre,
          tipo_incidencia: params.tipoIncidencia,
          severidad: params.severidad,
          descripcion: params.descripcion,
          estado: 'ABIERTA',
          sla_horas: params.slaHoras,
          sla_vence_en: params.slaVenceEnIso,
          foto_storage_bucket: params.storageBucket,
          foto_storage_path: params.storagePath,
          foto_mime_type: params.mimeType,
          foto_sha256_hex: params.sha256Hex,
          sucursal: params.sucursal,
        })
        .select('*')
        .single();

      if (error || !data) {
        throw new Error(error?.message || 'No se pudo registrar la incidencia en base de datos.');
      }
      return data as IncidenciaPdvDbRow;
    },
    async findIncidenciasByIds(ids) {
      const { data, error } = await userClient
        .from('incidencias_pdv')
        .select('*')
        .in('id', ids);
      if (error || !Array.isArray(data)) return [];
      return data as IncidenciaPdvDbRow[];
    },
    async createSignedUrls(bucket, paths, ttlSeconds) {
      if (paths.length === 0) return {};
      const { data, error } = await adminClient.storage
        .from(bucket)
        .createSignedUrls(paths, ttlSeconds);
      if (error || !Array.isArray(data)) {
        throw new Error(error?.message || 'No se pudieron generar URLs firmadas temporales.');
      }
      const map: Record<string, string> = {};
      for (const item of data) {
        if (item.path && item.signedUrl) {
          map[item.path] = item.signedUrl;
        }
      }
      return map;
    },
  };
}

export function createUploadIncidenciaEvidenceHandler(
  customGatewayFactory?: (actor: AuthenticatedServerUser) => IncidenciasEvidencesGateway | null
) {
  return async function uploadIncidenciaHandler(req: Request, res: Response): Promise<void> {
    const actor = req.authUser;
    if (!actor) {
      res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    if (actor.appRole === 'contraloria') {
      res.status(403).json({
        error: 'Segregación de Funciones: Contraloría Interna opera en modo solo lectura.',
        code: 'FORBIDDEN_READ_ONLY_ROLE',
      });
      return;
    }

    let rawMeta: unknown;
    try {
      rawMeta = decodeIncidenciaMetaHeader(req);
    } catch {
      res.status(400).json({
        error: 'Cabecera x-incidencia-meta inválida o malformada.',
        code: 'INVALID_METADATA_HEADER',
      });
      return;
    }

    const parsedMeta = UploadIncidenciaEvidenceMetaSchema.safeParse(rawMeta);
    if (!parsedMeta.success) {
      res.status(400).json({
        error: parsedMeta.error.issues[0]?.message || 'Datos de incidencia inválidos.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const meta = parsedMeta.data;
    const effectiveBranch: 'ZULIA' | 'VALENCIA' | null =
      actor.sucursal === 'ZULIA' || actor.sucursal === 'VALENCIA'
        ? actor.sucursal
        : meta.sucursal ?? 'ZULIA';

    if (!canActorAccessBranch(actor, effectiveBranch)) {
      res.status(403).json({
        error: 'Acceso denegado: no puede reportar incidencias en otra sucursal.',
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let verifiedImage;
    try {
      verifiedImage = verifyAttendanceImageMagicBytes(rawBody, MAX_INCIDENCIA_IMAGE_BYTES);
    } catch (err) {
      if (err instanceof AttendanceFileSecurityError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(415).json({
        error: 'Evidencia fotográfica inválida.',
        code: 'INVALID_IMAGE_BINARY',
      });
      return;
    }

    const gateway = customGatewayFactory
      ? customGatewayFactory(actor)
      : createSupabaseIncidenciasGateway(actor);
    if (!gateway) {
      res.status(503).json({
        error: 'Almacenamiento privado de incidencias no configurado en el servidor.',
        code: 'STORAGE_UNCONFIGURED',
      });
      return;
    }

    const storagePath = buildDeterministicIncidenciaStoragePath({
      sucursal: effectiveBranch,
      extension: verifiedImage.extension,
    });
    const { slaHoras, slaVenceEnIso } = computeSlaDeadlineIso(meta.severidad);

    let uploaded = false;
    try {
      await gateway.uploadPrivateObject({
        bucket: INCIDENCIAS_PRIVATE_BUCKET_ID,
        path: storagePath,
        buffer: rawBody,
        mimeType: verifiedImage.mimeType,
      });
      uploaded = true;

      const created = await gateway.insertIncidenciaRow({
        clienteId: meta.clienteId ?? null,
        pdvNombre: meta.pdvNombre,
        rutaId: meta.rutaId ?? null,
        reportadoPorUid: actor.id,
        reportadoPorNombre: meta.reportadoPorNombre || actor.email || 'Operador de Campo',
        responsableNombre: meta.responsableNombre || 'Coordinación Trade',
        tipoIncidencia: meta.tipoIncidencia,
        severidad: meta.severidad,
        descripcion: meta.descripcion,
        slaHoras,
        slaVenceEnIso,
        storageBucket: INCIDENCIAS_PRIVATE_BUCKET_ID,
        storagePath,
        mimeType: verifiedImage.mimeType,
        sha256Hex: verifiedImage.sha256Hex,
        sucursal: effectiveBranch,
      });

      res.status(201).json({
        ok: true,
        incidencia: created,
      });
    } catch (err) {
      if (uploaded) {
        await gateway
          .deletePrivateObjects(INCIDENCIAS_PRIVATE_BUCKET_ID, [storagePath])
          .catch(() => {});
      }
      const message =
        err instanceof Error ? err.message : 'Error registrando la incidencia con evidencia.';
      res.status(500).json({
        error: message,
        code: 'INCIDENCIA_PERSISTENCE_FAILED',
      });
    }
  };
}

export function createBatchIncidenciaSignedUrlsHandler(
  customGatewayFactory?: (actor: AuthenticatedServerUser) => IncidenciasEvidencesGateway | null
) {
  return async function batchSignedUrlsHandler(req: Request, res: Response): Promise<void> {
    const actor = req.authUser;
    if (!actor) {
      res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const parsed = BatchIncidenciaSignedUrlsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Solicitud de URLs firmadas inválida.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const gateway = customGatewayFactory
      ? customGatewayFactory(actor)
      : createSupabaseIncidenciasGateway(actor);
    if (!gateway) {
      res.status(503).json({
        error: 'Servicio de almacenamiento privado no disponible.',
        code: 'STORAGE_UNCONFIGURED',
      });
      return;
    }

    try {
      const rows = await gateway.findIncidenciasByIds(parsed.data.incidenciaIds);
      const isTorre = isTorreViewerRole(actor.appRole);
      const authorizedRows = rows.filter((r) => {
        if (!r.foto_storage_path) return false;
        if (!canActorAccessBranch(actor, r.sucursal)) return false;
        return isTorre || r.reportado_por_uid === actor.id;
      });

      const paths = authorizedRows
        .map((r) => r.foto_storage_path)
        .filter((p): p is string => Boolean(p));
      const signedByPath = await gateway.createSignedUrls(
        INCIDENCIAS_PRIVATE_BUCKET_ID,
        paths,
        DEFAULT_SIGNED_URL_TTL_SECONDS
      );

      const signedUrls: Record<string, string> = {};
      for (const row of authorizedRows) {
        if (row.foto_storage_path && signedByPath[row.foto_storage_path]) {
          signedUrls[row.id] = signedByPath[row.foto_storage_path];
        }
      }

      res.status(200).json({
        ok: true,
        ttlSeconds: DEFAULT_SIGNED_URL_TTL_SECONDS,
        signedUrls,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'No se pudieron emitir URLs firmadas de incidencias.',
        code: 'SIGNED_URL_ERROR',
      });
    }
  };
}

export const handleUploadIncidenciaEvidence = createUploadIncidenciaEvidenceHandler();
export const handleBatchIncidenciaSignedUrls = createBatchIncidenciaSignedUrlsHandler();
