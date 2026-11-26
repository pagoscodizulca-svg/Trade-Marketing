import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  extractRawActiveSucursalHeader,
  getAdminSupabaseClient,
  isOperativeServerSucursal,
  normalizeServerSucursal,
  type AuthenticatedServerUser,
  type OperativeSucursal,
} from './supabaseAdminAuth';
import { serverLogger } from './logger';
import {
  OFFICIAL_TRADE_PRODUCTS_MAESTROS,
  findOfficialTradeProduct,
} from '../data/officialTradeProductsCatalog';

export type ShiftLinkRole = 'promotora' | 'chofer';
export type ShiftDurationHours = 8 | 12 | 24;

export const MIN_SHIFT_LINK_SECRET_BYTES = 32;
export const MAX_SHIFT_PHOTO_BYTES = 350 * 1024; // 350 KB estricto para evidencias offline WebP/JPEG/PNG

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_FORMAT_REGEX = /^[A-Za-z0-9_-]{20,256}\.[A-Za-z0-9_-]{43}$/;
const RUTA_CODIGO_REGEX = /^[A-Za-z0-9ÁÉÍÓÚÑáéíóúñ ._-]{1,120}$/;

export interface ShiftTokenPayload {
  v: 1;
  sid: string;
  nonce: string;
  exp: number;
}

export interface StoredShiftSessionSummary {
  id: string;
  rol: ShiftLinkRole;
  personal_id: string | null;
  personal_nombre: string;
  region_id: string;
  region_nombre?: string;
  sucursal: OperativeSucursal;
  ruta_codigo: string;
  duracion_horas: ShiftDurationHours;
  created_by: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface VerifiedShiftSessionContext {
  id: string;
  rol: ShiftLinkRole;
  personal_id: string | null;
  personal_nombre: string;
  region_id: string;
  region_nombre: string;
  sucursal: OperativeSucursal;
  ruta_codigo: string;
  duracion_horas: number;
  expires_at: string;
  last_used_at: string | null;
}

export interface ShiftLinksGateway {
  resolveRegionBySucursal(sucursal: OperativeSucursal): Promise<{
    id: string;
    codigo: OperativeSucursal;
    nombre: string;
  } | null>;
  resolvePersonalInSucursal(
    rol: ShiftLinkRole,
    personalId: string,
    sucursal: OperativeSucursal
  ): Promise<{ id: string; name: string } | null>;
  insertSession(record: {
    id: string;
    token_hash: string;
    rol: ShiftLinkRole;
    personal_id: string | null;
    personal_nombre: string;
    region_id: string;
    sucursal: OperativeSucursal;
    ruta_codigo: string;
    duracion_horas: ShiftDurationHours;
    created_by: string;
    expires_at: string;
  }): Promise<StoredShiftSessionSummary>;
  listSessionsBySucursal(
    sucursal: OperativeSucursal,
    limit?: number
  ): Promise<StoredShiftSessionSummary[]>;
  revokeSession(params: {
    sessionId: string;
    revokedBy: string;
    allowedSucursal: OperativeSucursal | 'GLOBAL';
  }): Promise<
    | { ok: true; session: StoredShiftSessionSummary }
    | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN_BRANCH' }
  >;
  validateSessionRpc(tokenHash: string): Promise<{
    valid: boolean;
    code?: string;
    session?: VerifiedShiftSessionContext;
  }>;
  bootstrapSessionRpc(tokenHash: string): Promise<{
    valid: boolean;
    code?: string;
    session?: VerifiedShiftSessionContext;
    rutas?: unknown[];
    entregas?: unknown[];
    clientes?: unknown[];
    productos?: unknown[];
    synced_at?: string;
  }>;
  applyOfflineMutationRpc(params: {
    tokenHash: string;
    clientMutationId: string;
    tipo: 'PROMOTORA_RUTA_STEP' | 'PROMOTORA_INCIDENCIA' | 'CHOFER_ENTREGA_PATCH';
    payload: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  uploadShiftIncidenciaPhoto(params: {
    sucursal: OperativeSucursal;
    sessionId: string;
    clientMutationId: string;
    bytes: Buffer;
    mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
    extension: 'webp' | 'jpg' | 'png';
  }): Promise<{ storagePath: string; sha256Hex: string }>;
}

// =============================================================================
// CRIPTOGRAFÍA EXCLUSIVA EN SERVIDOR (HMAC-SHA256 + SHA-256 HASH + TIMING-SAFE)
// =============================================================================

export function resolveShiftLinkSecret(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = String(env.SHIFT_LINK_SECRET ?? '').trim();
  if (Buffer.byteLength(raw, 'utf8') < MIN_SHIFT_LINK_SECRET_BYTES) {
    return null;
  }
  return raw;
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function signShiftToken(
  input: { sid: string; expEpochSec: number; nonce?: string },
  secret: string
): { token: string; tokenHash: string; payload: ShiftTokenPayload } {
  if (Buffer.byteLength(secret, 'utf8') < MIN_SHIFT_LINK_SECRET_BYTES) {
    throw new Error('SHIFT_LINK_SECRET debe tener al menos 32 bytes.');
  }
  if (!UUID_REGEX.test(input.sid)) {
    throw new Error('sid debe ser un UUID válido.');
  }

  // Payload estrictamente opaco: CERO PII (ni cédulas, ni correos, ni teléfonos, ni rutas)
  const payload: ShiftTokenPayload = {
    v: 1,
    sid: input.sid,
    nonce: input.nonce ?? crypto.randomBytes(16).toString('hex'),
    exp: Math.trunc(input.expEpochSec),
  };

  const payloadB64Url = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sigB64Url = crypto
    .createHmac('sha256', secret)
    .update(payloadB64Url, 'utf8')
    .digest('base64url');

  const token = `${payloadB64Url}.${sigB64Url}`;
  const tokenHash = sha256Hex(token);
  return { token, tokenHash, payload };
}

export type VerifyTokenSignatureResult =
  | {
      ok: true;
      sid: string;
      expEpochSec: number;
      tokenHash: string;
    }
  | {
      ok: false;
      code: 'MALFORMED_TOKEN' | 'INVALID_SIGNATURE' | 'TOKEN_EXPIRED';
    };

export function verifyShiftTokenSignature(
  rawToken: string,
  secret: string,
  nowMs: number = Date.now()
): VerifyTokenSignatureResult {
  const clean = String(rawToken ?? '').trim();
  if (!TOKEN_FORMAT_REGEX.test(clean)) {
    return { ok: false, code: 'MALFORMED_TOKEN' };
  }

  const dotIdx = clean.indexOf('.');
  if (dotIdx <= 0) {
    return { ok: false, code: 'MALFORMED_TOKEN' };
  }

  const payloadB64Url = clean.slice(0, dotIdx);
  const sigB64Url = clean.slice(dotIdx + 1);

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64Url, 'utf8')
    .digest();

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sigB64Url, 'base64url');
  } catch {
    return { ok: false, code: 'MALFORMED_TOKEN' };
  }

  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(providedSig, expectedSig)
  ) {
    return { ok: false, code: 'INVALID_SIGNATURE' };
  }

  let parsed: Partial<ShiftTokenPayload>;
  try {
    parsed = JSON.parse(
      Buffer.from(payloadB64Url, 'base64url').toString('utf8')
    ) as Partial<ShiftTokenPayload>;
  } catch {
    return { ok: false, code: 'MALFORMED_TOKEN' };
  }

  if (
    parsed.v !== 1 ||
    typeof parsed.sid !== 'string' ||
    !UUID_REGEX.test(parsed.sid) ||
    typeof parsed.exp !== 'number' ||
    !Number.isFinite(parsed.exp)
  ) {
    return { ok: false, code: 'MALFORMED_TOKEN' };
  }

  if (parsed.exp * 1000 <= nowMs) {
    return { ok: false, code: 'TOKEN_EXPIRED' };
  }

  return {
    ok: true,
    sid: parsed.sid,
    expEpochSec: parsed.exp,
    tokenHash: sha256Hex(clean),
  };
}

export function resolvePublicAppOrigin(req: Request): string {
  const envOrigin = String(process.env.PUBLIC_APP_ORIGIN ?? '').trim();
  if (envOrigin) {
    try {
      const u = new URL(envOrigin);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        return u.origin;
      }
    } catch {
      /* continúa al origen de la petición */
    }
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
    .split(',')[0]
    .trim();
  if (host) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    const proto =
      forwardedProto === 'https' || (!isLocal && process.env.NODE_ENV === 'production')
        ? 'https'
        : forwardedProto === 'http'
          ? 'http'
          : req.protocol || 'http';
    try {
      return new URL(`${proto}://${host}`).origin;
    } catch {
      /* fallback */
    }
  }

  return 'https://trade-marketing-qi6j.onrender.com';
}

/**
 * Genera la URL pública estricta del enlace dinámico:
 * únicamente `?t=<token_firmado_opaco>`, sin PII ni parámetros sensibles.
 */
export function buildSignedShiftUrl(params: {
  origin: string;
  rol: ShiftLinkRole;
  token: string;
}): string {
  const safeOrigin = new URL(params.origin).origin;
  const basePath = params.rol === 'chofer' ? '/logistica/' : '/portal';
  return `${safeOrigin}${basePath}?t=${encodeURIComponent(params.token)}`;
}

export function extractShiftTokenFromRequest(req: Request): string {
  const headerToken = req.headers['x-shift-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = String(req.headers.authorization ?? '').trim();
  if (/^Shift\s+/i.test(authHeader)) {
    return authHeader.replace(/^Shift\s+/i, '').trim();
  }
  const bodyToken = (req.body as { token?: unknown } | undefined)?.token;
  if (typeof bodyToken === 'string' && bodyToken.trim()) {
    return bodyToken.trim();
  }
  return '';
}

export function inspectShiftOfflinePhotoBytes(
  rawBase64: string
): {
  bytes: Buffer;
  mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
  extension: 'webp' | 'jpg' | 'png';
} {
  const clean = String(rawBase64 ?? '')
    .trim()
    .replace(/^data:[^;,]+;base64,/i, '')
    .replace(/\s+/g, '');

  if (!clean) {
    throw new Error('Evidencia fotográfica vacía.');
  }

  const bytes = Buffer.from(clean, 'base64');
  if (bytes.byteLength === 0) {
    throw new Error('Evidencia fotográfica vacía.');
  }
  if (bytes.byteLength > MAX_SHIFT_PHOTO_BYTES) {
    throw new Error('La fotografía offline excede el límite máximo de 350 KB.');
  }
  if (bytes.byteLength < 12) {
    throw new Error('Archivo de imagen inválido o corrupto.');
  }

  const head = bytes.subarray(0, Math.min(256, bytes.byteLength)).toString('utf8').trimStart().toLowerCase();
  if (
    (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
    (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) ||
    head.startsWith('<svg') ||
    head.startsWith('<?xml') ||
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('<script') ||
    head.includes('<svg ')
  ) {
    throw new Error('Formato bloqueado por seguridad: SVG, XML, HTML y ejecutables no están permitidos.');
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { bytes, mimeType: 'image/webp', extension: 'webp' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { bytes, mimeType: 'image/png', extension: 'png' };
  }

  throw new Error('Firma binaria inválida. Solo se permiten imágenes WebP, JPEG o PNG reales.');
}

// =============================================================================
// ESQUEMAS ZOD DE VALIDACIÓN DE CONTRATOS HTTP
// =============================================================================

export const GenerateShiftLinkSchema = z.object({
  rol: z.enum(['promotora', 'chofer']),
  duracionHoras: z.union([z.literal(8), z.literal(12), z.literal(24)]).default(12),
  rutaCodigo: z
    .string()
    .trim()
    .min(1, 'Indica el código o nombre de ruta/jornada.')
    .max(120)
    .regex(RUTA_CODIGO_REGEX, 'Código de ruta contiene caracteres no permitidos.'),
  personalId: z.string().trim().regex(UUID_REGEX, 'personalId debe ser UUID válido.').optional().nullable(),
  personalNombre: z.string().trim().max(140).optional(),
  sucursal: z.string().trim().max(60).optional(),
});

export const RevokeShiftLinkSchema = z.object({
  sessionId: z.string().trim().regex(UUID_REGEX, 'sessionId debe ser un UUID válido.'),
});

const OfflineMutationItemSchema = z.object({
  client_mutation_id: z.string().trim().regex(UUID_REGEX, 'client_mutation_id debe ser UUID v4 válido.'),
  tipo: z.enum(['PROMOTORA_RUTA_STEP', 'PROMOTORA_INCIDENCIA', 'CHOFER_ENTREGA_PATCH']),
  payload: z.record(z.string(), z.unknown()),
  photoBase64: z.string().max(600_000).optional().nullable(),
});

export const SyncShiftBatchSchema = z.object({
  mutations: z.array(OfflineMutationItemSchema).min(1).max(50),
});

// =============================================================================
// RESOLUCIÓN ESTRICTA DE SUCURSAL DEL COORDINADOR / SUPER ADMIN
// =============================================================================

function resolveActorTargetSucursal(
  authUser: AuthenticatedServerUser,
  req: Request,
  bodySucursal?: string
): { ok: true; sucursal: OperativeSucursal } | { ok: false; status: number; code: string; error: string } {
  const requestedBody = bodySucursal ? normalizeServerSucursal(bodySucursal) : null;
  if (bodySucursal && !requestedBody) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_BRANCH',
      error: 'Sucursal inválida. Regiones operativas válidas: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
    };
  }

  const rawHeader = extractRawActiveSucursalHeader(req);
  const requestedHeader = rawHeader ? normalizeServerSucursal(rawHeader) : null;
  if (rawHeader && !requestedHeader) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_BRANCH',
      error: 'Cabecera x-sucursal-activa inválida.',
    };
  }

  if (isOperativeServerSucursal(authUser.sucursal)) {
    if (requestedBody && requestedBody !== authUser.sucursal) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN_BRANCH',
        error: `Cruce regional bloqueado: tu perfil pertenece a ${authUser.sucursal} y no puede emitir enlaces para ${requestedBody}.`,
      };
    }
    if (requestedHeader && requestedHeader !== authUser.sucursal) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN_BRANCH',
        error: `Cruce regional bloqueado: tu perfil pertenece a ${authUser.sucursal}.`,
      };
    }
    return { ok: true, sucursal: authUser.sucursal };
  }

  if (authUser.sucursal === 'GLOBAL') {
    const chosen =
      (requestedBody && isOperativeServerSucursal(requestedBody) ? requestedBody : null) ??
      (requestedHeader && isOperativeServerSucursal(requestedHeader) ? requestedHeader : null);
    if (!chosen) {
      return {
        ok: false,
        status: 400,
        code: 'BRANCH_REQUIRED',
        error: 'Selecciona una sucursal operativa (Zulia, Valencia, Centro, Oriente o Capital) antes de operar enlaces.',
      };
    }
    return { ok: true, sucursal: chosen };
  }

  return {
    ok: false,
    status: 403,
    code: 'BRANCH_UNASSIGNED',
    error: 'Tu cuenta no posee una sucursal operativa asignada.',
  };
}

// =============================================================================
// GATEWAY SUPABASE POR DEFECTO (SERVICE_ROLE EXCLUSIVO EN SERVIDOR)
// =============================================================================

const PUBLIC_SESSION_COLUMNS =
  'id, rol, personal_id, personal_nombre, region_id, sucursal, ruta_codigo, duracion_horas, created_by, expires_at, revoked_at, last_used_at, created_at';

function createSupabaseShiftLinksGateway(): ShiftLinksGateway {
  const requireAdmin = () => {
    const client = getAdminSupabaseClient();
    if (!client) {
      throw new Error('SUPABASE_SERVER_UNCONFIGURED');
    }
    return client;
  };

  return {
    async resolveRegionBySucursal(sucursal) {
      const admin = requireAdmin();
      const { data, error } = await admin
        .from('regiones')
        .select('id, codigo, nombre')
        .ilike('codigo', sucursal)
        .eq('activo', true)
        .limit(1)
        .maybeSingle();

      if (error || !data) return null;
      return {
        id: String(data.id),
        codigo: sucursal,
        nombre: String(data.nombre || sucursal),
      };
    },

    async resolvePersonalInSucursal(rol, personalId, sucursal) {
      const admin = requireAdmin();
      if (rol === 'promotora') {
        const { data, error } = await admin
          .from('staff')
          .select('id, name, sucursal')
          .eq('id', personalId)
          .limit(1)
          .maybeSingle();
        if (error || !data) return null;
        if (data.sucursal && normalizeServerSucursal(data.sucursal) !== sucursal) {
          return null;
        }
        return { id: String(data.id), name: String(data.name || '') };
      }

      const { data, error } = await admin
        .from('profiles')
        .select('id, full_name, email, sucursal, role')
        .eq('id', personalId)
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      if (data.sucursal && normalizeServerSucursal(data.sucursal) !== sucursal) {
        return null;
      }
      return {
        id: String(data.id),
        name: String(data.full_name || data.email || 'Chofer'),
      };
    },

    async insertSession(record) {
      const admin = requireAdmin();
      const { data, error } = await admin
        .from('sesiones_jornada')
        .insert(record)
        .select(PUBLIC_SESSION_COLUMNS)
        .single();

      if (error || !data) {
        throw new Error(error?.message || 'No se pudo registrar la sesión de jornada.');
      }
      return data as unknown as StoredShiftSessionSummary;
    },

    async listSessionsBySucursal(sucursal, limit = 40) {
      const admin = requireAdmin();
      const { data, error } = await admin
        .from('sesiones_jornada')
        .select(PUBLIC_SESSION_COLUMNS)
        .eq('sucursal', sucursal)
        .order('created_at', { ascending: false })
        .limit(Math.max(1, Math.min(100, limit)));

      if (error) {
        const code = String(error.code ?? '').toUpperCase();
        const msg = String(error.message ?? '').toLowerCase();
        if (
          code === 'PGRST205' ||
          code === '42P01' ||
          msg.includes('could not find the table') ||
          (msg.includes('relation') && msg.includes('does not exist'))
        ) {
          return [];
        }
        throw new Error(error.message || 'Error consultando enlaces de jornada.');
      }
      return (data ?? []) as unknown as StoredShiftSessionSummary[];
    },

    async revokeSession({ sessionId, revokedBy, allowedSucursal }) {
      const admin = requireAdmin();
      const { data: existing, error: fetchErr } = await admin
        .from('sesiones_jornada')
        .select(PUBLIC_SESSION_COLUMNS)
        .eq('id', sessionId)
        .maybeSingle();

      if (fetchErr || !existing) {
        return { ok: false, code: 'NOT_FOUND' };
      }

      const rowSucursal = normalizeServerSucursal(existing.sucursal);
      if (allowedSucursal !== 'GLOBAL' && rowSucursal !== allowedSucursal) {
        return { ok: false, code: 'FORBIDDEN_BRANCH' };
      }

      const nowIso = new Date().toISOString();
      const { data: updated, error: updErr } = await admin
        .from('sesiones_jornada')
        .update({
          revoked_at: existing.revoked_at || nowIso,
          revoked_by: revokedBy,
        })
        .eq('id', sessionId)
        .select(PUBLIC_SESSION_COLUMNS)
        .single();

      if (updErr || !updated) {
        throw new Error(updErr?.message || 'No se pudo revocar el enlace de jornada.');
      }

      return { ok: true, session: updated as unknown as StoredShiftSessionSummary };
    },

    async validateSessionRpc(tokenHash) {
      const admin = requireAdmin();
      const { data, error } = await admin.rpc('rpc_validar_sesion_jornada', {
        p_token_hash: tokenHash,
      });
      if (error || !data || typeof data !== 'object') {
        throw new Error(error?.message || 'Error validando sesión de jornada.');
      }
      return data as {
        valid: boolean;
        code?: string;
        session?: VerifiedShiftSessionContext;
      };
    },

    async bootstrapSessionRpc(tokenHash) {
      const admin = requireAdmin();
      const { data, error } = await admin.rpc('rpc_bootstrap_sesion_jornada', {
        p_token_hash: tokenHash,
      });
      if (error || !data || typeof data !== 'object') {
        throw new Error(error?.message || 'Error precargando datos de jornada.');
      }
      return data as {
        valid: boolean;
        code?: string;
        session?: VerifiedShiftSessionContext;
        rutas?: unknown[];
        entregas?: unknown[];
        clientes?: unknown[];
        productos?: unknown[];
        synced_at?: string;
      };
    },

    async applyOfflineMutationRpc({ tokenHash, clientMutationId, tipo, payload }) {
      const admin = requireAdmin();
      const { data, error } = await admin.rpc('rpc_aplicar_mutacion_offline_jornada', {
        p_token_hash: tokenHash,
        p_client_mutation_id: clientMutationId,
        p_tipo: tipo,
        p_payload: payload,
      });
      if (error) {
        throw new Error(error.message || 'Error sincronizando mutación offline.');
      }
      return (data ?? { ok: true }) as Record<string, unknown>;
    },

    async uploadShiftIncidenciaPhoto({
      sucursal,
      sessionId,
      clientMutationId,
      bytes,
      mimeType,
      extension,
    }) {
      const admin = requireAdmin();
      const storagePath = `shift/${sucursal.toLowerCase()}/${sessionId}/${clientMutationId}.${extension}`;
      const sha256 = sha256Hex(bytes);
      const { error } = await admin.storage
        .from('incidencias-evidencias')
        .upload(storagePath, bytes, {
          contentType: mimeType,
          upsert: true,
        });
      if (error) {
        throw new Error(error.message || 'No se pudo almacenar la evidencia fotográfica privada.');
      }
      return { storagePath, sha256Hex: sha256 };
    },
  };
}

// =============================================================================
// FÁBRICA DE HANDLERS EXPRESS
// =============================================================================

export function createShiftLinksHandlers(options?: {
  gateway?: ShiftLinksGateway;
  getSecret?: () => string | null;
  nowMs?: () => number;
}) {
  const gateway = options?.gateway ?? createSupabaseShiftLinksGateway();
  const getSecret = options?.getSecret ?? (() => resolveShiftLinkSecret());
  const nowMsFn = options?.nowMs ?? (() => Date.now());

  const handleGenerateShiftLink = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Autenticación requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const secret = getSecret();
    if (!secret) {
      res.status(503).json({
        error: 'Falta configurar SHIFT_LINK_SECRET (>= 32 caracteres) en las variables de servidor.',
        code: 'SHIFT_LINK_SECRET_UNCONFIGURED',
      });
      return;
    }

    const parsed = GenerateShiftLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Parámetros inválidos para generar enlace de jornada.',
        code: 'INVALID_SHIFT_LINK_PAYLOAD',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }

    const input = parsed.data;
    const branchRes = resolveActorTargetSucursal(authUser, req, input.sucursal);
    if (!branchRes.ok) {
      res.status(branchRes.status).json({ error: branchRes.error, code: branchRes.code });
      return;
    }

    try {
      const region = await gateway.resolveRegionBySucursal(branchRes.sucursal);
      if (!region) {
        res.status(404).json({
          error: `No se encontró la región activa ${branchRes.sucursal} en public.regiones.`,
          code: 'REGION_NOT_FOUND',
        });
        return;
      }

      let resolvedPersonalId: string | null = null;
      let resolvedPersonalNombre = (input.personalNombre ?? '').trim().slice(0, 140);

      if (input.personalId) {
        const staffMember = await gateway.resolvePersonalInSucursal(
          input.rol,
          input.personalId,
          branchRes.sucursal
        );
        if (!staffMember) {
          res.status(403).json({
            error: 'El personal seleccionado no existe o no pertenece a tu región operativa.',
            code: 'FORBIDDEN_PERSONAL_BRANCH',
          });
          return;
        }
        resolvedPersonalId = staffMember.id;
        resolvedPersonalNombre = staffMember.name || resolvedPersonalNombre;
      }

      const nowMs = nowMsFn();
      const expiresMs = nowMs + input.duracionHoras * 3600 * 1000;
      const expEpochSec = Math.floor(expiresMs / 1000);
      const sessionId = crypto.randomUUID();

      const { token, tokenHash } = signShiftToken({ sid: sessionId, expEpochSec }, secret);

      const stored = await gateway.insertSession({
        id: sessionId,
        token_hash: tokenHash,
        rol: input.rol,
        personal_id: resolvedPersonalId,
        personal_nombre: resolvedPersonalNombre,
        region_id: region.id,
        sucursal: branchRes.sucursal,
        ruta_codigo: input.rutaCodigo.trim().toUpperCase(),
        duracion_horas: input.duracionHoras,
        created_by: authUser.id,
        expires_at: new Date(expEpochSec * 1000).toISOString(),
      });

      const origin = resolvePublicAppOrigin(req);
      const url = buildSignedShiftUrl({ origin, rol: input.rol, token });

      serverLogger.info('shift_link_generated', {
        sessionId: stored.id,
        rol: stored.rol,
        sucursal: stored.sucursal,
        duracionHoras: stored.duracion_horas,
        createdBy: authUser.id,
      });

      res.status(201).json({
        ok: true,
        url,
        session: {
          ...stored,
          region_nombre: region.nombre,
        },
      });
    } catch (err) {
      serverLogger.error('shift_link_generate_failed', { err });
      res.status(500).json({
        error: 'No se pudo generar el enlace dinámico firmado.',
        code: 'SHIFT_LINK_GENERATE_ERROR',
      });
    }
  };

  const handleVerifyShiftLink = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const secret = getSecret();
    if (!secret) {
      res.status(503).json({
        ok: false,
        valid: false,
        error: 'Servicio de validación de enlaces no configurado.',
        code: 'SHIFT_LINK_SECRET_UNCONFIGURED',
      });
      return;
    }

    const token = extractShiftTokenFromRequest(req);
    const sigCheck = verifyShiftTokenSignature(token, secret, nowMsFn());
    if (!sigCheck.ok) {
      res.status(401).json({
        ok: false,
        valid: false,
        code: sigCheck.code,
        error:
          sigCheck.code === 'TOKEN_EXPIRED'
            ? 'Este enlace de jornada expiró. Solicita uno nuevo a Coordinación.'
            : 'Enlace de jornada inválido o manipulado.',
      });
      return;
    }

    try {
      const dbResult = await gateway.validateSessionRpc(sigCheck.tokenHash);
      if (!dbResult.valid || !dbResult.session) {
        const code = dbResult.code || 'SESSION_INVALID';
        res.status(401).json({
          ok: false,
          valid: false,
          code,
          error:
            code === 'SESSION_REVOKED'
              ? 'Este enlace de jornada fue revocado por Coordinación.'
              : code === 'SESSION_EXPIRED'
                ? 'Este enlace de jornada expiró.'
                : 'Sesión de jornada no autorizada.',
        });
        return;
      }

      res.status(200).json({
        ok: true,
        valid: true,
        session: dbResult.session,
      });
    } catch (err) {
      serverLogger.error('shift_link_verify_failed', { err });
      res.status(500).json({
        ok: false,
        valid: false,
        code: 'SHIFT_LINK_VERIFY_ERROR',
        error: 'Error verificando la vigencia del enlace.',
      });
    }
  };

  const handleRevokeShiftLink = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Autenticación requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const parsed = RevokeShiftLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Identificador de sesión inválido.',
        code: 'INVALID_SESSION_ID',
      });
      return;
    }

    const allowedSucursal: OperativeSucursal | 'GLOBAL' =
      authUser.sucursal === 'GLOBAL'
        ? 'GLOBAL'
        : isOperativeServerSucursal(authUser.sucursal)
          ? authUser.sucursal
          : 'ZULIA';

    if (!isOperativeServerSucursal(authUser.sucursal) && authUser.sucursal !== 'GLOBAL') {
      res.status(403).json({ error: 'Sucursal no asignada.', code: 'BRANCH_UNASSIGNED' });
      return;
    }

    try {
      const result = await gateway.revokeSession({
        sessionId: parsed.data.sessionId,
        revokedBy: authUser.id,
        allowedSucursal,
      });
      if (!result.ok) {
        res.status(result.code === 'FORBIDDEN_BRANCH' ? 403 : 404).json({
          error:
            result.code === 'FORBIDDEN_BRANCH'
              ? 'No puedes revocar enlaces pertenecientes a otra región.'
              : 'Enlace de jornada no encontrado.',
          code: result.code,
        });
        return;
      }

      serverLogger.info('shift_link_revoked', {
        sessionId: result.session.id,
        sucursal: result.session.sucursal,
        revokedBy: authUser.id,
      });

      res.status(200).json({ ok: true, session: result.session });
    } catch (err) {
      serverLogger.error('shift_link_revoke_failed', { err });
      res.status(500).json({
        error: 'No se pudo revocar el enlace de jornada.',
        code: 'SHIFT_LINK_REVOKE_ERROR',
      });
    }
  };

  const handleListShiftLinks = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Autenticación requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const querySucursal = typeof req.query.sucursal === 'string' ? req.query.sucursal : undefined;
    const branchRes = resolveActorTargetSucursal(authUser, req, querySucursal);
    if (!branchRes.ok) {
      res.status(branchRes.status).json({ error: branchRes.error, code: branchRes.code });
      return;
    }

    try {
      const sessions = await gateway.listSessionsBySucursal(branchRes.sucursal, 50);
      res.status(200).json({ ok: true, sucursal: branchRes.sucursal, sessions });
    } catch (err) {
      serverLogger.error('shift_link_list_failed', { err });
      res.status(500).json({
        error: 'No se pudieron consultar los enlaces activos.',
        code: 'SHIFT_LINK_LIST_ERROR',
      });
    }
  };

  const handleBootstrapShiftLink = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const secret = getSecret();
    if (!secret) {
      res.status(503).json({
        ok: false,
        error: 'Servicio de enlaces no configurado.',
        code: 'SHIFT_LINK_SECRET_UNCONFIGURED',
      });
      return;
    }

    const token = extractShiftTokenFromRequest(req);
    const sigCheck = verifyShiftTokenSignature(token, secret, nowMsFn());
    if (!sigCheck.ok) {
      res.status(401).json({
        ok: false,
        code: sigCheck.code,
        error: 'Enlace de jornada expirado o inválido.',
      });
      return;
    }

    try {
      const boot = await gateway.bootstrapSessionRpc(sigCheck.tokenHash);
      if (!boot.valid || !boot.session) {
        res.status(401).json({
          ok: false,
          code: boot.code || 'SESSION_INVALID',
          error: 'La jornada no está vigente o fue revocada.',
        });
        return;
      }

      const rawShiftProds = Array.isArray(boot.productos) ? boot.productos : [];
      const hasNumericCodes = rawShiftProds.some((p) => {
        const rec = p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
        return Boolean(rec && /^\d+$/.test(String(rec.codigo ?? rec.prod_codi ?? '').trim()));
      });
      const resolvedShiftProds = (() => {
        if (rawShiftProds.length === 0) {
          return OFFICIAL_TRADE_PRODUCTS_MAESTROS.map((p) => ({
            id: p.id,
            codigo: p.codigo,
            nombre: p.nombre,
            categoria: p.categoria,
            marca: p.marca,
            unidad_medida: p.unidad_medida,
          }));
        }
        if (!hasNumericCodes) return rawShiftProds;
        const filtered: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        for (const item of rawShiftProds) {
          if (!item || typeof item !== 'object') continue;
          const rec = item as Record<string, unknown>;
          const official = findOfficialTradeProduct({
            codigo: rec.codigo ?? rec.prod_codi,
            nombre: rec.nombre ?? rec.prod_desc,
          });
          if (!official || seen.has(official.codigo)) continue;
          seen.add(official.codigo);
          filtered.push({
            ...rec,
            codigo: official.codigo,
            nombre: official.articulo,
            categoria: `${official.grupo} · ${official.subgrupo}`,
          });
        }
        return filtered.length > 0
          ? filtered
          : OFFICIAL_TRADE_PRODUCTS_MAESTROS.map((p) => ({
              id: p.id,
              codigo: p.codigo,
              nombre: p.nombre,
              categoria: p.categoria,
              marca: p.marca,
              unidad_medida: p.unidad_medida,
            }));
      })();

      res.status(200).json({
        ok: true,
        session: boot.session,
        rutas: boot.rutas ?? [],
        entregas: boot.entregas ?? [],
        clientes: boot.clientes ?? [],
        productos: resolvedShiftProds,
        syncedAt: boot.synced_at ?? new Date().toISOString(),
      });
    } catch (err) {
      serverLogger.error('shift_link_bootstrap_failed', { err });
      res.status(500).json({
        ok: false,
        code: 'SHIFT_BOOTSTRAP_ERROR',
        error: 'No se pudieron descargar los datos acotados de la jornada.',
      });
    }
  };

  const handleSyncShiftOfflineBatch = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const secret = getSecret();
    if (!secret) {
      res.status(503).json({
        ok: false,
        error: 'Servicio de sincronización de jornada no configurado.',
        code: 'SHIFT_LINK_SECRET_UNCONFIGURED',
      });
      return;
    }

    const token = extractShiftTokenFromRequest(req);
    const sigCheck = verifyShiftTokenSignature(token, secret, nowMsFn());
    if (!sigCheck.ok) {
      res.status(401).json({
        ok: false,
        code: sigCheck.code,
        error: 'Tu enlace de jornada expiró o es inválido. Los datos locales deben purgarse.',
      });
      return;
    }

    const parsed = SyncShiftBatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        code: 'INVALID_SYNC_BATCH',
        error: 'Lote de sincronización offline inválido.',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    try {
      const sessionCheck = await gateway.validateSessionRpc(sigCheck.tokenHash);
      if (!sessionCheck.valid || !sessionCheck.session) {
        res.status(401).json({
          ok: false,
          code: sessionCheck.code || 'SESSION_INVALID',
          error: 'Este enlace de jornada fue revocado o expiró.',
        });
        return;
      }

      const results: Array<{
        client_mutation_id: string;
        ok: boolean;
        idempotentHit?: boolean;
        error?: string;
        code?: string;
        data?: Record<string, unknown>;
      }> = [];

      for (const mut of parsed.data.mutations) {
        try {
          const enrichedPayload: Record<string, unknown> = { ...mut.payload };
          if (mut.tipo === 'PROMOTORA_INCIDENCIA' && mut.photoBase64) {
            const inspected = inspectShiftOfflinePhotoBytes(mut.photoBase64);
            const uploaded = await gateway.uploadShiftIncidenciaPhoto({
              sucursal: sessionCheck.session.sucursal,
              sessionId: sessionCheck.session.id,
              clientMutationId: mut.client_mutation_id,
              bytes: inspected.bytes,
              mimeType: inspected.mimeType,
              extension: inspected.extension,
            });
            enrichedPayload.foto_storage_path = uploaded.storagePath;
            enrichedPayload.foto_mime_type = inspected.mimeType;
            enrichedPayload.foto_sha256_hex = uploaded.sha256Hex;
          }

          const rpcRes = await gateway.applyOfflineMutationRpc({
            tokenHash: sigCheck.tokenHash,
            clientMutationId: mut.client_mutation_id,
            tipo: mut.tipo,
            payload: enrichedPayload,
          });

          results.push({
            client_mutation_id: mut.client_mutation_id,
            ok: true,
            idempotentHit: Boolean(rpcRes.idempotent_hit),
            data: rpcRes,
          });
        } catch (mutErr) {
          const msg = mutErr instanceof Error ? mutErr.message : String(mutErr);
          if (/SESSION_REVOKED|SESSION_EXPIRED|SESSION_NOT_FOUND/i.test(msg)) {
            res.status(401).json({
              ok: false,
              code: /SESSION_REVOKED/i.test(msg) ? 'SESSION_REVOKED' : 'SESSION_EXPIRED',
              error: 'El enlace de jornada dejó de estar vigente durante la sincronización.',
              results,
            });
            return;
          }
          results.push({
            client_mutation_id: mut.client_mutation_id,
            ok: false,
            code: /FORBIDDEN_/i.test(msg) ? 'FORBIDDEN_SCOPE' : 'MUTATION_FAILED',
            error: msg,
          });
        }
      }

      res.status(200).json({
        ok: true,
        synced: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      });
    } catch (err) {
      serverLogger.error('shift_link_sync_failed', { err });
      res.status(500).json({
        ok: false,
        code: 'SHIFT_SYNC_ERROR',
        error: 'Error procesando el lote de sincronización offline.',
      });
    }
  };

  return {
    handleGenerateShiftLink,
    handleVerifyShiftLink,
    handleRevokeShiftLink,
    handleListShiftLinks,
    handleBootstrapShiftLink,
    handleSyncShiftOfflineBatch,
  };
}

export const defaultShiftLinksHandlers = createShiftLinksHandlers();
