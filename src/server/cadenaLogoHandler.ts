import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { serverLogger } from './logger';
import {
  type AuthenticatedServerUser,
  createUserScopedSupabaseClient,
  extractRawActiveSucursalHeader,
  getAdminSupabaseClient,
  isCadenaLogoViewerRole,
  isCoordinatorOrAdminRole,
  isOperativeServerSucursal,
  isTorreViewerRole,
  normalizeOperativeServerSucursal,
  normalizeServerSucursal,
  OPERATIVE_SUCURSALES,
  type OperativeSucursal,
} from './supabaseAdminAuth';

export const CADENAS_LOGOS_PRIVATE_BUCKET_ID = 'cadenas-logos';
export const MAX_CADENA_LOGO_BYTES = 512 * 1024; // 512 KB exactos
const MAX_LOGO_DIMENSION_PX = 4096;

export type AllowedCadenaLogoMime = 'image/png' | 'image/webp';
export type AllowedCadenaLogoExt = 'png' | 'webp';

export interface VerifiedCadenaLogoBinary {
  mimeType: AllowedCadenaLogoMime;
  extension: AllowedCadenaLogoExt;
  sizeBytes: number;
  sha256Hex: string;
}

export class CadenaLogoSecurityError extends Error {
  public readonly statusCode: number;
  public readonly code:
    | 'EMPTY_FILE_PAYLOAD'
    | 'FILE_TOO_LARGE'
    | 'DANGEROUS_CONTENT_DETECTED'
    | 'UNSUPPORTED_LOGO_FORMAT'
    | 'INVALID_IMAGE_DIMENSIONS'
    | 'INVALID_PATH_COMPONENTS';

  constructor(
    statusCode: number,
    code: CadenaLogoSecurityError['code'],
    message: string
  ) {
    super(message);
    this.name = 'CadenaLogoSecurityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const UUID_STRICT_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CadenaIdParamSchema = z.object({
  id: z.string().trim().regex(UUID_STRICT_REGEX, 'Identificador UUID de cadena comercial inválido.'),
});

/**
 * Valida estrictamente los *magic bytes* del logotipo secundario:
 * - Acepta ÚNICAMENTE formatos rasterizados puros `image/png` (`89 50 4E 47 0D 0A 1A 0A`)
 *   e `image/webp` (`52 49 46 46 ... 57 45 42 50`) de hasta `512 KB`.
 * - Rechaza con `415` cualquier `.svg`, `.xml`, `.html`, `<script>`, ejecutable (`MZ`/`ELF`),
 *   PDF (`%PDF`) o JPEG (`FF D8 FF`) aunque haya sido renombrado a `.png` o `.webp`.
 */
export function verifyCadenaLogoMagicBytes(
  buffer: Buffer,
  maxBytes: number = MAX_CADENA_LOGO_BYTES
): VerifiedCadenaLogoBinary {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    throw new CadenaLogoSecurityError(
      400,
      'EMPTY_FILE_PAYLOAD',
      'No se recibió ningún archivo binario de logotipo.'
    );
  }

  if (buffer.byteLength > maxBytes) {
    throw new CadenaLogoSecurityError(
      413,
      'FILE_TOO_LARGE',
      'El logotipo supera el tamaño máximo permitido de 512 KB.'
    );
  }

  if (buffer.byteLength < 16) {
    throw new CadenaLogoSecurityError(
      415,
      'UNSUPPORTED_LOGO_FORMAT',
      'Archivo demasiado pequeño o corrupto. Solo se permiten logotipos PNG o WebP.'
    );
  }

  // Escaneo explícito Anti-XSS / Anti-XXE / Anti-Polyglot sobre cabecera y carga textual
  const headText = buffer
    .subarray(0, Math.min(1024, buffer.byteLength))
    .toString('utf8')
    .trimStart()
    .toLowerCase();
  const fullAsciiSample = buffer
    .subarray(0, Math.min(16384, buffer.byteLength))
    .toString('latin1')
    .toLowerCase();

  if (
    (buffer[0] === 0x4d && buffer[1] === 0x5a) || // Windows PE
    (buffer[0] === 0x7f &&
      buffer[1] === 0x45 &&
      buffer[2] === 0x4c &&
      buffer[3] === 0x46) || // Linux ELF
    headText.startsWith('<svg') ||
    headText.startsWith('<?xml') ||
    headText.startsWith('<!doctype') ||
    headText.startsWith('<html') ||
    headText.startsWith('<script') ||
    fullAsciiSample.includes('<svg') ||
    fullAsciiSample.includes('<script') ||
    fullAsciiSample.includes('<!entity')
  ) {
    throw new CadenaLogoSecurityError(
      415,
      'DANGEROUS_CONTENT_DETECTED',
      'Formato bloqueado por seguridad: se prohíben archivos SVG, XML, HTML o ejecutables.'
    );
  }

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A + chunk IHDR en bytes 12..15
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    if (
      buffer.byteLength < 24 ||
      buffer.subarray(12, 16).toString('ascii') !== 'IHDR'
    ) {
      throw new CadenaLogoSecurityError(
        415,
        'UNSUPPORTED_LOGO_FORMAT',
        'Cabecera PNG inválida (chunk IHDR ausente).'
      );
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (
      width === 0 ||
      height === 0 ||
      width > MAX_LOGO_DIMENSION_PX ||
      height > MAX_LOGO_DIMENSION_PX
    ) {
      throw new CadenaLogoSecurityError(
        415,
        'INVALID_IMAGE_DIMENSIONS',
        `Dimensiones PNG fuera de rango permitido (1..${MAX_LOGO_DIMENSION_PX}px).`
      );
    }

    return {
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: buffer.byteLength,
      sha256Hex: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  }

  // 2. WebP: "RIFF" (bytes 0..3) + "WEBP" (bytes 8..11)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return {
      mimeType: 'image/webp',
      extension: 'webp',
      sizeBytes: buffer.byteLength,
      sha256Hex: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  }

  throw new CadenaLogoSecurityError(
    415,
    'UNSUPPORTED_LOGO_FORMAT',
    'Formato no permitido (magic bytes inválidos). Solo se aceptan imágenes PNG o WebP reales (máx. 512 KB).'
  );
}

/**
 * Construye una ruta determinística en servidor inmune a Path Traversal:
 * `cadenas-logos/{SUCURSAL}/{cadena_id}/logo_{uuid}.{png|webp}`
 */
export function buildDeterministicCadenaLogoStoragePath(params: {
  sucursal: OperativeSucursal;
  cadenaId: string;
  extension: AllowedCadenaLogoExt;
  fileUuid?: string;
}): string {
  const cleanSucursal = String(params.sucursal || '').trim().toUpperCase();
  const cleanCadenaId = String(params.cadenaId || '').trim().toLowerCase();
  const cleanFileUuid = (params.fileUuid || crypto.randomUUID()).trim().toLowerCase();

  if (
    !(OPERATIVE_SUCURSALES as readonly string[]).includes(cleanSucursal) ||
    !UUID_STRICT_REGEX.test(cleanCadenaId) ||
    !UUID_STRICT_REGEX.test(cleanFileUuid) ||
    (params.extension !== 'png' && params.extension !== 'webp')
  ) {
    throw new CadenaLogoSecurityError(
      400,
      'INVALID_PATH_COMPONENTS',
      'Componentes inválidos para construir la ruta privada del logotipo.'
    );
  }

  return `cadenas-logos/${cleanSucursal}/${cleanCadenaId}/logo_${cleanFileUuid}.${params.extension}`;
}

export interface CadenaComercialLogoDbRow {
  id: string;
  codigo: string;
  nombre: string;
  sucursal: OperativeSucursal | null;
  region_id: string | null;
  activo: boolean;
  logo_storage_path: string | null;
  logo_mime_type: string | null;
  logo_updated_at: string | null;
  logo_updated_by: string | null;
}

export interface CadenaLogoGateway {
  findCadenaById(cadenaId: string): Promise<CadenaComercialLogoDbRow | null>;
  hasClientePortalAccessToCadena(
    userId: string,
    cadenaId: string,
    cadenaSucursal: OperativeSucursal
  ): Promise<boolean>;
  uploadPrivateLogoObject(params: {
    bucket: string;
    path: string;
    buffer: Buffer;
    mimeType: AllowedCadenaLogoMime;
  }): Promise<void>;
  downloadPrivateLogoObject(bucket: string, path: string): Promise<Buffer | null>;
  deletePrivateLogoObjects(bucket: string, paths: string[]): Promise<void>;
  updateCadenaLogoMetadata(params: {
    cadenaId: string;
    sucursal: OperativeSucursal;
    logoStoragePath: string | null;
    logoMimeType: AllowedCadenaLogoMime | null;
    updatedAtIso: string;
    updatedByUid: string;
  }): Promise<CadenaComercialLogoDbRow>;
}

function canActorWriteBranch(
  actor: AuthenticatedServerUser,
  cadenaSucursal: OperativeSucursal,
  activeHeaderHub: OperativeSucursal | null
): boolean {
  if (actor.sucursal === 'GLOBAL') {
    return activeHeaderHub ? activeHeaderHub === cadenaSucursal : true;
  }
  return actor.sucursal === cadenaSucursal;
}

function canActorViewBranch(
  actor: AuthenticatedServerUser,
  cadenaSucursal: OperativeSucursal,
  activeHeaderHub: OperativeSucursal | null
): boolean {
  if (actor.sucursal === 'GLOBAL') {
    return activeHeaderHub ? activeHeaderHub === cadenaSucursal : true;
  }
  return actor.sucursal === cadenaSucursal;
}

function createSupabaseCadenaLogoGateway(
  actor: AuthenticatedServerUser
): CadenaLogoGateway | null {
  const adminClient = getAdminSupabaseClient();
  if (!adminClient) return null;

  return {
    async findCadenaById(cadenaId) {
      const { data, error } = await adminClient
        .from('cadenas_comerciales')
        .select(
          'id, codigo, nombre, sucursal, region_id, activo, logo_storage_path, logo_mime_type, logo_updated_at, logo_updated_by'
        )
        .eq('id', cadenaId)
        .maybeSingle();

      if (error || !data) return null;
      const raw = data as Record<string, unknown>;
      const normalizedSuc = normalizeServerSucursal(raw.sucursal);
      return {
        id: String(raw.id || ''),
        codigo: String(raw.codigo || ''),
        nombre: String(raw.nombre || ''),
        sucursal: isOperativeServerSucursal(normalizedSuc) ? normalizedSuc : null,
        region_id: raw.region_id ? String(raw.region_id) : null,
        activo: raw.activo !== false,
        logo_storage_path: raw.logo_storage_path ? String(raw.logo_storage_path) : null,
        logo_mime_type: raw.logo_mime_type ? String(raw.logo_mime_type) : null,
        logo_updated_at: raw.logo_updated_at ? String(raw.logo_updated_at) : null,
        logo_updated_by: raw.logo_updated_by ? String(raw.logo_updated_by) : null,
      };
    },

    async hasClientePortalAccessToCadena(userId, cadenaId, cadenaSucursal) {
      const { data: accesos, error } = await adminClient
        .from('cliente_portal_accesos')
        .select('id, cliente_id, cadena_id, sucursal, activo')
        .eq('user_id', userId)
        .eq('activo', true);

      if (error || !Array.isArray(accesos) || accesos.length === 0) return false;

      const clienteIdsToCheck: string[] = [];
      for (const acc of accesos as Array<Record<string, unknown>>) {
        const accSuc = normalizeServerSucursal(acc.sucursal);
        if (accSuc && accSuc !== cadenaSucursal) continue;
        if (acc.cadena_id && String(acc.cadena_id).toLowerCase() === cadenaId.toLowerCase()) {
          return true;
        }
        if (acc.cliente_id && UUID_STRICT_REGEX.test(String(acc.cliente_id))) {
          clienteIdsToCheck.push(String(acc.cliente_id));
        }
      }

      if (clienteIdsToCheck.length === 0) return false;

      const { data: clientes, error: cliErr } = await adminClient
        .from('clientes')
        .select('id, cadena_id, sucursal, activo')
        .in('id', clienteIdsToCheck)
        .eq('activo', true);

      if (cliErr || !Array.isArray(clientes)) return false;

      return (clientes as Array<Record<string, unknown>>).some((cli) => {
        const cliSuc = normalizeServerSucursal(cli.sucursal);
        if (cliSuc && cliSuc !== cadenaSucursal) return false;
        return (
          Boolean(cli.cadena_id) &&
          String(cli.cadena_id).toLowerCase() === cadenaId.toLowerCase()
        );
      });
    },

    async uploadPrivateLogoObject({ bucket, path, buffer, mimeType }) {
      const { error } = await adminClient.storage.from(bucket).upload(path, buffer, {
        contentType: mimeType,
        upsert: false,
      });
      if (error) {
        throw new Error(error.message || 'No se pudo almacenar el logotipo en el bucket privado.');
      }
    },

    async downloadPrivateLogoObject(bucket, path) {
      const { data, error } = await adminClient.storage.from(bucket).download(path);
      if (error || !data) return null;
      const ab = await data.arrayBuffer();
      return Buffer.from(ab);
    },

    async deletePrivateLogoObjects(bucket, paths) {
      if (paths.length === 0) return;
      await adminClient.storage.from(bucket).remove(paths);
    },

    async updateCadenaLogoMetadata({
      cadenaId,
      sucursal,
      logoStoragePath,
      logoMimeType,
      updatedAtIso,
      updatedByUid,
    }) {
      const scopedClient = actor.accessToken
        ? createUserScopedSupabaseClient(actor.accessToken, sucursal)
        : null;
      const writer = scopedClient ?? adminClient;

      const { data, error } = await writer
        .from('cadenas_comerciales')
        .update({
          logo_storage_path: logoStoragePath,
          logo_mime_type: logoMimeType,
          logo_updated_at: updatedAtIso,
          logo_updated_by: updatedByUid,
        })
        .eq('id', cadenaId)
        .select(
          'id, codigo, nombre, sucursal, region_id, activo, logo_storage_path, logo_mime_type, logo_updated_at, logo_updated_by'
        )
        .single();

      if (error || !data) {
        throw new Error(
          error?.message || 'No se pudo actualizar el metadato del logotipo en cadenas_comerciales.'
        );
      }

      const raw = data as Record<string, unknown>;
      const normalizedSuc = normalizeServerSucursal(raw.sucursal);
      return {
        id: String(raw.id || ''),
        codigo: String(raw.codigo || ''),
        nombre: String(raw.nombre || ''),
        sucursal: isOperativeServerSucursal(normalizedSuc) ? normalizedSuc : sucursal,
        region_id: raw.region_id ? String(raw.region_id) : null,
        activo: raw.activo !== false,
        logo_storage_path: raw.logo_storage_path ? String(raw.logo_storage_path) : null,
        logo_mime_type: raw.logo_mime_type ? String(raw.logo_mime_type) : null,
        logo_updated_at: raw.logo_updated_at ? String(raw.logo_updated_at) : null,
        logo_updated_by: raw.logo_updated_by ? String(raw.logo_updated_by) : null,
      };
    },
  };
}

/**
 * `POST /api/cadenas-comerciales/:id/logo`
 */
export function createUploadCadenaLogoHandler(
  gatewayOverride?: CadenaLogoGateway
): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const actor = req.authUser;
    if (!actor) {
      res.status(401).json({
        error: 'Sesión no autenticada.',
        code: 'UNAUTHENTICATED',
      });
      return;
    }

    if (!isCoordinatorOrAdminRole(actor.appRole)) {
      res.status(403).json({
        error:
          'Acceso denegado: solo Coordinación Regional o Super Admin pueden modificar logotipos de cadenas comerciales.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    const parsedParams = CadenaIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        error: parsedParams.error.issues[0]?.message || 'Identificador de cadena inválido.',
        code: 'INVALID_CADENA_ID',
      });
      return;
    }

    const rawHeaderBranch = extractRawActiveSucursalHeader(req);
    const activeHeaderHub =
      actor.activeSucursalHeader ?? normalizeOperativeServerSucursal(rawHeaderBranch);
    if (rawHeaderBranch && !activeHeaderHub) {
      res.status(400).json({
        error:
          'Cabecera x-sucursal-activa inválida. Regiones válidas: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
        code: 'INVALID_SUCURSAL',
      });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let verifiedLogo: VerifiedCadenaLogoBinary;
    try {
      verifiedLogo = verifyCadenaLogoMagicBytes(rawBody);
    } catch (err) {
      if (err instanceof CadenaLogoSecurityError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      res.status(415).json({
        error: 'Archivo de logotipo inválido.',
        code: 'UNSUPPORTED_LOGO_FORMAT',
      });
      return;
    }

    const gateway = gatewayOverride ?? createSupabaseCadenaLogoGateway(actor);
    if (!gateway) {
      res.status(503).json({
        error: 'Almacenamiento Supabase no disponible en el servidor.',
        code: 'SUPABASE_SERVER_UNCONFIGURED',
      });
      return;
    }

    const cadenaId = parsedParams.data.id;
    const existingCadena = await gateway.findCadenaById(cadenaId);
    if (!existingCadena || !existingCadena.sucursal) {
      res.status(404).json({
        error: 'La cadena comercial indicada no existe o carece de región asignada.',
        code: 'CADENA_NOT_FOUND',
      });
      return;
    }

    if (!canActorWriteBranch(actor, existingCadena.sucursal, activeHeaderHub)) {
      res.status(403).json({
        error: `Aislamiento regional: no tienes autorización para modificar cadenas de la región ${existingCadena.sucursal}.`,
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

    const newStoragePath = buildDeterministicCadenaLogoStoragePath({
      sucursal: existingCadena.sucursal,
      cadenaId: existingCadena.id,
      extension: verifiedLogo.extension,
    });
    const previousStoragePath = existingCadena.logo_storage_path;
    const nowIso = new Date().toISOString();

    try {
      await gateway.uploadPrivateLogoObject({
        bucket: CADENAS_LOGOS_PRIVATE_BUCKET_ID,
        path: newStoragePath,
        buffer: rawBody,
        mimeType: verifiedLogo.mimeType,
      });
    } catch (err) {
      serverLogger.error('cadena_logo_storage_upload_failed', {
        cadenaId,
        sucursal: existingCadena.sucursal,
        err,
      });
      res.status(502).json({
        error: 'No se pudo almacenar el logotipo en el repositorio privado.',
        code: 'STORAGE_UPLOAD_FAILED',
      });
      return;
    }

    try {
      const updated = await gateway.updateCadenaLogoMetadata({
        cadenaId: existingCadena.id,
        sucursal: existingCadena.sucursal,
        logoStoragePath: newStoragePath,
        logoMimeType: verifiedLogo.mimeType,
        updatedAtIso: nowIso,
        updatedByUid: actor.id,
      });

      if (previousStoragePath && previousStoragePath !== newStoragePath) {
        try {
          await gateway.deletePrivateLogoObjects(CADENAS_LOGOS_PRIVATE_BUCKET_ID, [
            previousStoragePath,
          ]);
        } catch (cleanupErr) {
          serverLogger.warn('cadena_logo_previous_cleanup_failed', {
            cadenaId,
            cleanupErr,
          });
        }
      }

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        ok: true,
        cadena: {
          id: updated.id,
          codigo: updated.codigo,
          nombre: updated.nombre,
          sucursal: updated.sucursal,
          hasLogo: true,
          logoMimeType: updated.logo_mime_type,
          logoUpdatedAt: updated.logo_updated_at,
          sha256Hex: verifiedLogo.sha256Hex,
          sizeBytes: verifiedLogo.sizeBytes,
        },
      });
    } catch (dbErr) {
      // Rollback transaccional inmediato en Storage si falla el registro en PostgreSQL
      try {
        await gateway.deletePrivateLogoObjects(CADENAS_LOGOS_PRIVATE_BUCKET_ID, [newStoragePath]);
      } catch (rollbackErr) {
        serverLogger.error('cadena_logo_rollback_failed', { cadenaId, rollbackErr });
      }
      serverLogger.error('cadena_logo_db_update_failed', { cadenaId, dbErr });
      res.status(500).json({
        error:
          'Falló la actualización en base de datos; el archivo subido fue revertido automáticamente.',
        code: 'DB_UPDATE_ROLLED_BACK',
      });
    }
  };
}

/**
 * `DELETE /api/cadenas-comerciales/:id/logo`
 */
export function createDeleteCadenaLogoHandler(
  gatewayOverride?: CadenaLogoGateway
): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const actor = req.authUser;
    if (!actor) {
      res.status(401).json({ error: 'Sesión no autenticada.', code: 'UNAUTHENTICATED' });
      return;
    }

    if (!isCoordinatorOrAdminRole(actor.appRole)) {
      res.status(403).json({
        error:
          'Acceso denegado: solo Coordinación Regional o Super Admin pueden retirar logotipos de cadenas comerciales.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    const parsedParams = CadenaIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        error: parsedParams.error.issues[0]?.message || 'Identificador de cadena inválido.',
        code: 'INVALID_CADENA_ID',
      });
      return;
    }

    const rawHeaderBranch = extractRawActiveSucursalHeader(req);
    const activeHeaderHub =
      actor.activeSucursalHeader ?? normalizeOperativeServerSucursal(rawHeaderBranch);
    if (rawHeaderBranch && !activeHeaderHub) {
      res.status(400).json({
        error: 'Cabecera x-sucursal-activa inválida.',
        code: 'INVALID_SUCURSAL',
      });
      return;
    }

    const gateway = gatewayOverride ?? createSupabaseCadenaLogoGateway(actor);
    if (!gateway) {
      res.status(503).json({
        error: 'Almacenamiento Supabase no disponible en el servidor.',
        code: 'SUPABASE_SERVER_UNCONFIGURED',
      });
      return;
    }

    const existingCadena = await gateway.findCadenaById(parsedParams.data.id);
    if (!existingCadena || !existingCadena.sucursal) {
      res.status(404).json({
        error: 'La cadena comercial indicada no existe.',
        code: 'CADENA_NOT_FOUND',
      });
      return;
    }

    if (!canActorWriteBranch(actor, existingCadena.sucursal, activeHeaderHub)) {
      res.status(403).json({
        error: `Aislamiento regional: no tienes autorización para modificar cadenas de la región ${existingCadena.sucursal}.`,
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

    const previousStoragePath = existingCadena.logo_storage_path;
    const nowIso = new Date().toISOString();

    await gateway.updateCadenaLogoMetadata({
      cadenaId: existingCadena.id,
      sucursal: existingCadena.sucursal,
      logoStoragePath: null,
      logoMimeType: null,
      updatedAtIso: nowIso,
      updatedByUid: actor.id,
    });

    if (previousStoragePath) {
      try {
        await gateway.deletePrivateLogoObjects(CADENAS_LOGOS_PRIVATE_BUCKET_ID, [
          previousStoragePath,
        ]);
      } catch (cleanupErr) {
        serverLogger.warn('cadena_logo_delete_storage_cleanup_failed', {
          cadenaId: existingCadena.id,
          cleanupErr,
        });
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      cadena: {
        id: existingCadena.id,
        codigo: existingCadena.codigo,
        nombre: existingCadena.nombre,
        sucursal: existingCadena.sucursal,
        hasLogo: false,
        logoMimeType: null,
        logoUpdatedAt: nowIso,
      },
    });
  };
}

/**
 * `GET /api/cadenas-comerciales/:id/logo`
 */
export function createGetCadenaLogoHandler(
  gatewayOverride?: CadenaLogoGateway
): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const actor = req.authUser;
    if (!actor) {
      res.status(401).json({ error: 'Sesión no autenticada.', code: 'UNAUTHENTICATED' });
      return;
    }

    if (!isCadenaLogoViewerRole(actor.appRole)) {
      res.status(403).json({
        error: 'Acceso denegado para este rol.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    const parsedParams = CadenaIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        error: parsedParams.error.issues[0]?.message || 'Identificador de cadena inválido.',
        code: 'INVALID_CADENA_ID',
      });
      return;
    }

    const rawHeaderBranch = extractRawActiveSucursalHeader(req);
    const activeHeaderHub =
      actor.activeSucursalHeader ?? normalizeOperativeServerSucursal(rawHeaderBranch);

    const gateway = gatewayOverride ?? createSupabaseCadenaLogoGateway(actor);
    if (!gateway) {
      res.status(503).json({
        error: 'Almacenamiento Supabase no disponible en el servidor.',
        code: 'SUPABASE_SERVER_UNCONFIGURED',
      });
      return;
    }

    const cadena = await gateway.findCadenaById(parsedParams.data.id);
    if (!cadena || !cadena.sucursal) {
      res.status(404).json({
        error: 'Cadena comercial no encontrada.',
        code: 'CADENA_NOT_FOUND',
      });
      return;
    }

    if (!canActorViewBranch(actor, cadena.sucursal, activeHeaderHub)) {
      res.status(403).json({
        error: `Aislamiento regional: no tienes autorización para consultar recursos de la región ${cadena.sucursal}.`,
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

    if (!isTorreViewerRole(actor.appRole)) {
      const hasPortalLink = await gateway.hasClientePortalAccessToCadena(
        actor.id,
        cadena.id,
        cadena.sucursal
      );
      if (!hasPortalLink) {
        res.status(403).json({
          error: 'No tienes acceso autorizado a esta cadena comercial en cliente_portal_accesos.',
          code: 'FORBIDDEN_CADENA_ACCESS',
        });
        return;
      }
    }

    if (!cadena.logo_storage_path || !cadena.logo_mime_type) {
      res.status(404).json({
        error: 'La cadena comercial aún no tiene un logotipo secundario registrado.',
        code: 'LOGO_NOT_CONFIGURED',
      });
      return;
    }

    const binary = await gateway.downloadPrivateLogoObject(
      CADENAS_LOGOS_PRIVATE_BUCKET_ID,
      cadena.logo_storage_path
    );
    if (!binary) {
      res.status(404).json({
        error: 'El archivo binario del logotipo no se encontró en el almacén privado.',
        code: 'LOGO_BINARY_MISSING',
      });
      return;
    }

    // Defensa en profundidad: revalidar magic bytes antes de servir al navegador
    let verified: VerifiedCadenaLogoBinary;
    try {
      verified = verifyCadenaLogoMagicBytes(binary);
    } catch {
      res.status(415).json({
        error: 'El binario almacenado no superó la verificación de integridad.',
        code: 'STORED_LOGO_INVALID',
      });
      return;
    }

    res.setHeader('Content-Type', verified.mimeType);
    res.setHeader('Content-Length', String(verified.sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
    res.status(200).end(binary);
  };
}

export const handleUploadCadenaLogo = createUploadCadenaLogoHandler();
export const handleDeleteCadenaLogo = createDeleteCadenaLogoHandler();
export const handleGetCadenaLogo = createGetCadenaLogoHandler();
