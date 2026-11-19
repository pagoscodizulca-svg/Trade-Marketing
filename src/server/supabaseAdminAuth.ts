import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { NextFunction, Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_CORPORATE_PASSWORD_LENGTH = 8;

const ALLOWED_COORDINATOR_ROLES = new Set([
  'super_admin',
  'superadmin',
  'coordinacion',
  'coordinadora',
  'coordinadora_trade',
  'jefe_trade',
  'supervisor',
  'gerente_admin',
  'gerencia',
  'admin',
]);

const ALLOWED_TORRE_VIEWER_ROLES = new Set([
  ...ALLOWED_COORDINATOR_ROLES,
  'contraloria',
  'analista_contraloria',
  'contralor',
]);

export type ServerSucursalCodigo = 'ZULIA' | 'VALENCIA' | 'GLOBAL';

export const CORPORATE_MANAGED_ROLES = new Set([
  'super_admin',
  'coordinacion',
  'contraloria',
  'vendedor',
  'promotora',
  'cliente',
  'chofer',
]);

function normalizeServerSucursal(raw: unknown): ServerSucursalCodigo | null {
  const clean = String(raw ?? '').trim().toUpperCase();
  if (clean === 'ZULIA' || clean === 'SUCURSAL ZULIA' || clean === 'MARACAIBO') return 'ZULIA';
  if (clean === 'VALENCIA' || clean === 'SUCURSAL VALENCIA' || clean === 'CARABOBO') {
    return 'VALENCIA';
  }
  if (clean === 'GLOBAL' || clean === 'NACIONAL' || clean === 'ADMIN_GENERAL') return 'GLOBAL';
  return null;
}

function sanitizeSucursalForServerRole(
  role: string,
  rawSucursal: unknown
): ServerSucursalCodigo | null {
  const cleanRole = String(role || '').trim().toLowerCase();
  const isStrictAdmin =
    cleanRole === 'super_admin' ||
    cleanRole === 'superadmin' ||
    cleanRole === 'admin' ||
    cleanRole === 'gerencia' ||
    cleanRole === 'gerente_admin';
  if (isStrictAdmin) return 'GLOBAL';

  const normalized = normalizeServerSucursal(rawSucursal);
  if (!normalized) return null;

  const isContraloria =
    cleanRole === 'contraloria' ||
    cleanRole === 'analista_contraloria' ||
    cleanRole === 'contralor';
  if (normalized === 'GLOBAL' && !isContraloria) {
    return null;
  }
  return normalized;
}

async function resolveEffectiveServerAppRole(
  userId: string,
  accessToken: string,
  jwtAppRole: string,
  jwtSucursal?: unknown
): Promise<{ role: string; isActive: boolean; sucursal: ServerSucursalCodigo | null }> {
  const lookup = getAdminSupabaseClient() || createUserScopedSupabaseClient(accessToken);
  if (lookup && UUID_REGEX.test(userId)) {
    try {
      const { data, error } = await lookup
        .from('profiles')
        .select('role, is_active, sucursal')
        .eq('id', userId)
        .maybeSingle();

      if (!error && data) {
        if (data.is_active === false) {
          return { role: '', isActive: false, sucursal: null };
        }
        const rawProfileRole = String(data.role ?? '').trim().toLowerCase();
        const profileRole =
          rawProfileRole === 'supervisor' ||
          rawProfileRole === 'supervisora' ||
          rawProfileRole === 'supervisor_trade'
            ? 'coordinacion'
            : rawProfileRole;
        if (profileRole) {
          const sucursal =
            sanitizeSucursalForServerRole(
              profileRole,
              (data as { sucursal?: unknown }).sucursal
            ) ?? sanitizeSucursalForServerRole(profileRole, jwtSucursal);
          return { role: profileRole, isActive: true, sucursal };
        }
      }
    } catch {
      // Fallback al rol firmado en app_metadata cuando public.profiles aún no existe
    }
  }
  const normalizedJwtRole =
    jwtAppRole === 'supervisor' ||
    jwtAppRole === 'supervisora' ||
    jwtAppRole === 'supervisor_trade'
      ? 'coordinacion'
      : jwtAppRole;
  return {
    role: normalizedJwtRole,
    isActive: true,
    sucursal: sanitizeSucursalForServerRole(normalizedJwtRole, jwtSucursal),
  };
}

export interface AuthenticatedServerUser {
  id: string;
  email: string;
  appRole: string;
  sucursal?: ServerSucursalCodigo | null;
  staffId?: string | null;
  isCoordinatorOrAdmin?: boolean;
  /**
   * Verdadero para roles de supervisión de solo lectura (p. ej. `contraloria`): pueden consultar
   * evidencias pero jamás cargarlas ni reemplazarlas.
   */
  isReadOnlyViewer?: boolean;
  accessToken?: string;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedServerUser;
    }
  }
}

export function getSupabaseProjectUrl(): string {
  const raw = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  return raw.replace(/\/rest\/v1\/?$/, '');
}

export function getSupabaseAnonKey(): string {
  // Prioriza la Publishable Key (`sb_publishable_*`) y conserva compatibilidad con la variable anon previa.
  return (
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  ).trim();
}

export function getSupabaseServiceRoleKey(): string {
  if (process.env.VITE_SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      '⚠️ [Seguridad] Detectada VITE_SUPABASE_SERVICE_ROLE_KEY: renombre inmediatamente a SUPABASE_SERVICE_ROLE_KEY (sin prefijo VITE_) para evitar exposición en cliente.'
    );
  }
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

let verifierClient: SupabaseClient | null = null;
let verifierClientCacheKey = '';
let adminClient: SupabaseClient | null = null;
let adminClientCacheKey = '';

export function getVerifierSupabaseClient(): SupabaseClient | null {
  const url = getSupabaseProjectUrl();
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) return null;
  const cacheKey = `${url}::${anonKey}`;
  if (!verifierClient || verifierClientCacheKey !== cacheKey) {
    verifierClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    verifierClientCacheKey = cacheKey;
  }
  return verifierClient;
}

export function getAdminSupabaseClient(): SupabaseClient | null {
  const url = getSupabaseProjectUrl();
  const serviceKey = getSupabaseServiceRoleKey();
  if (!url || !serviceKey) return null;
  const cacheKey = `${url}::${serviceKey}`;
  if (!adminClient || adminClientCacheKey !== cacheKey) {
    adminClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    adminClientCacheKey = cacheKey;
  }
  return adminClient;
}

/**
 * Construye un cliente Supabase acotado al JWT verificado del usuario autenticado
 * para que PostgreSQL RLS y Storage RLS apliquen todas las políticas por fila.
 */
export function createUserScopedSupabaseClient(accessToken: string): SupabaseClient | null {
  const url = getSupabaseProjectUrl();
  const anonKey = getSupabaseAnonKey();
  const cleanToken = String(accessToken || '').trim();
  if (!url || !anonKey || !cleanToken) return null;

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
      },
    },
  });
}

export function isCoordinatorOrAdminRole(rawRole: string): boolean {
  return ALLOWED_COORDINATOR_ROLES.has(String(rawRole || '').trim().toLowerCase());
}

export function isTorreViewerRole(rawRole: string): boolean {
  return ALLOWED_TORRE_VIEWER_ROLES.has(String(rawRole || '').trim().toLowerCase());
}

export function isFdvIngestionRole(rawRole: string): boolean {
  const clean = String(rawRole || '').trim().toLowerCase();
  return clean === 'vendedor' || ALLOWED_COORDINATOR_ROLES.has(clean);
}

/**
 * Middleware Zero Trust para ingesta de Fuerza de Ventas (`POST /api/fdv/solicitudes-degustacion`):
 * - Valida criptográficamente el Bearer JWT contra Supabase Auth (cero acceso `anon`).
 * - Consulta `public.profiles` para verificar cuenta activa, rol autorizado (`vendedor`,
 *   `coordinacion`, `super_admin`) y sucursal asignada (`ZULIA`, `VALENCIA`, `GLOBAL`).
 */
export async function requireFdvOrTradeAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({
      error: 'Autenticación requerida (Bearer token ausente).',
      code: 'AUTH_TOKEN_MISSING',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) {
    res.status(401).json({
      error: 'Token de sesión inválido.',
      code: 'AUTH_TOKEN_INVALID',
    });
    return;
  }

  const verifier = getVerifierSupabaseClient();
  if (!verifier) {
    res.status(503).json({
      error: 'Servicio de verificación Supabase no configurado en el servidor.',
      code: 'SUPABASE_SERVER_UNCONFIGURED',
    });
    return;
  }

  try {
    const { data, error } = await verifier.auth.getUser(token);
    if (error || !data.user || !UUID_REGEX.test(data.user.id)) {
      res.status(401).json({
        error: 'Sesión inválida o expirada. Inicie sesión nuevamente.',
        code: 'AUTH_SESSION_EXPIRED',
      });
      return;
    }

    const appMeta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
    const jwtAppRole = String(appMeta.app_role ?? appMeta.role ?? '')
      .trim()
      .toLowerCase();
    const effective = await resolveEffectiveServerAppRole(
      data.user.id,
      token,
      jwtAppRole,
      appMeta.sucursal
    );
    const appRole = effective.role;

    if (!effective.isActive) {
      res.status(403).json({
        error: 'Acceso denegado: la cuenta se encuentra suspendida.',
        code: 'ACCOUNT_SUSPENDED',
      });
      return;
    }

    if (!isFdvIngestionRole(appRole)) {
      res.status(403).json({
        error:
          'Acceso denegado: solo vendedores, coordinación o administración pueden registrar solicitudes de degustación.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    req.authUser = {
      id: data.user.id,
      email: String(data.user.email || '').trim().toLowerCase(),
      appRole,
      sucursal: effective.sucursal,
      isCoordinatorOrAdmin: isCoordinatorOrAdminRole(appRole),
      accessToken: token,
    };
    next();
  } catch {
    res.status(502).json({
      error: 'No se pudo verificar la sesión contra el proveedor de identidad.',
      code: 'AUTH_UPSTREAM_ERROR',
    });
  }
}

export function isIncidenciaActorRole(rawRole: string): boolean {
  const clean = String(rawRole || '').trim().toLowerCase();
  return (
    isTorreViewerRole(clean) ||
    clean === 'promotora' ||
    clean === 'vendedor'
  );
}

/**
 * Middleware Zero Trust para evidencias privadas de incidencias en PDV (`M-01`):
 * - Acepta `super_admin`, `coordinacion`, `contraloria` (solo lectura de URLs firmadas),
 *   `promotora` y `vendedor`.
 */
export async function requireIncidenciaActorAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({
      error: 'Autenticación requerida (Bearer token ausente).',
      code: 'AUTH_TOKEN_MISSING',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) {
    res.status(401).json({
      error: 'Token de sesión inválido.',
      code: 'AUTH_TOKEN_INVALID',
    });
    return;
  }

  const verifier = getVerifierSupabaseClient();
  if (!verifier) {
    res.status(503).json({
      error: 'Servicio de verificación Supabase no configurado en el servidor.',
      code: 'SUPABASE_SERVER_UNCONFIGURED',
    });
    return;
  }

  try {
    const { data, error } = await verifier.auth.getUser(token);
    if (error || !data.user || !UUID_REGEX.test(data.user.id)) {
      res.status(401).json({
        error: 'Sesión inválida o expirada. Inicie sesión nuevamente.',
        code: 'AUTH_SESSION_EXPIRED',
      });
      return;
    }

    const appMeta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
    const jwtAppRole = String(appMeta.app_role ?? appMeta.role ?? '')
      .trim()
      .toLowerCase();
    const effective = await resolveEffectiveServerAppRole(
      data.user.id,
      token,
      jwtAppRole,
      appMeta.sucursal
    );
    const appRole = effective.role;

    if (!effective.isActive) {
      res.status(403).json({
        error: 'Acceso denegado: la cuenta se encuentra suspendida.',
        code: 'ACCOUNT_SUSPENDED',
      });
      return;
    }

    if (!isIncidenciaActorRole(appRole)) {
      res.status(403).json({
        error:
          'Acceso denegado: tu rol no cuenta con permisos sobre incidencias operativas en PDV.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    req.authUser = {
      id: data.user.id,
      email: String(data.user.email || '').trim().toLowerCase(),
      appRole,
      sucursal: effective.sucursal,
      isCoordinatorOrAdmin: isCoordinatorOrAdminRole(appRole),
      accessToken: token,
    };
    next();
  } catch {
    res.status(502).json({
      error: 'No se pudo verificar la sesión contra el proveedor de identidad.',
      code: 'AUTH_UPSTREAM_ERROR',
    });
  }
}

/**
 * Middleware Zero Trust para endpoints financieros de Contraloría y Torre de Control:
 * - Valida el Bearer JWT contra Supabase Auth y consulta `public.profiles`.
 * - Acepta únicamente roles autorizados de Torre/Contraloría (`super_admin`, `coordinacion`, `contraloria`).
 */
export async function requireTorreControlAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({
      error: 'Autenticación requerida (Bearer token ausente).',
      code: 'AUTH_TOKEN_MISSING',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) {
    res.status(401).json({
      error: 'Token de sesión inválido.',
      code: 'AUTH_TOKEN_INVALID',
    });
    return;
  }

  const verifier = getVerifierSupabaseClient();
  if (!verifier) {
    res.status(503).json({
      error: 'Servicio de verificación Supabase no configurado en el servidor.',
      code: 'SUPABASE_SERVER_UNCONFIGURED',
    });
    return;
  }

  try {
    const { data, error } = await verifier.auth.getUser(token);
    if (error || !data.user || !UUID_REGEX.test(data.user.id)) {
      res.status(401).json({
        error: 'Sesión inválida o expirada. Inicie sesión nuevamente.',
        code: 'AUTH_SESSION_EXPIRED',
      });
      return;
    }

    const appMeta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
    const jwtAppRole = String(appMeta.app_role ?? appMeta.role ?? '')
      .trim()
      .toLowerCase();
    const effective = await resolveEffectiveServerAppRole(
      data.user.id,
      token,
      jwtAppRole,
      appMeta.sucursal
    );
    const appRole = effective.role;

    if (!effective.isActive) {
      res.status(403).json({
        error: 'Acceso denegado: la cuenta se encuentra suspendida.',
        code: 'ACCOUNT_SUSPENDED',
      });
      return;
    }

    if (!isTorreViewerRole(appRole)) {
      res.status(403).json({
        error:
          'Acceso denegado: solo Contraloría Interna, Coordinación Trade o Administración pueden gestionar comprobantes fiscales.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    req.authUser = {
      id: data.user.id,
      email: String(data.user.email || '').trim().toLowerCase(),
      appRole,
      sucursal: effective.sucursal,
      isCoordinatorOrAdmin: isCoordinatorOrAdminRole(appRole),
      accessToken: token,
    };
    next();
  } catch {
    res.status(502).json({
      error: 'No se pudo verificar la sesión contra el proveedor de identidad.',
      code: 'AUTH_UPSTREAM_ERROR',
    });
  }
}

function normalizeStaffLoginEmail(rawEmail: string, staffName: string, staffId: string): string {
  const cleanEmail = String(rawEmail || '').trim().toLowerCase();
  if (cleanEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return cleanEmail;
  }
  const baseSlug = String(staffName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  const shortSuffix = staffId.slice(0, 6).toLowerCase();
  const safeLocal = baseSlug ? `${baseSlug}.${shortSuffix}` : `promotora.${shortSuffix}`;
  return `${safeLocal}@promotoras.codizulca.local`;
}

/**
 * Limitador de tasa en memoria por ventana deslizante para proteger endpoints sensibles.
 */
export function createRateLimiter(options: { windowMs: number; maxRequests: number }) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${req.authUser?.id || req.ip || 'anon'}:${req.path}`;
    const windowStart = now - options.windowMs;
    const recent = (hits.get(key) || []).filter((ts) => ts > windowStart);

    if (recent.length >= options.maxRequests) {
      res.status(429).json({
        error: 'Demasiadas solicitudes en poco tiempo. Espere unos segundos e intente de nuevo.',
        code: 'RATE_LIMIT_EXCEEDED',
      });
      return;
    }

    recent.push(now);
    hits.set(key, recent);

    if (hits.size > 500) {
      for (const [entryKey, timestamps] of hits.entries()) {
        const filtered = timestamps.filter((ts) => ts > windowStart);
        if (filtered.length === 0) hits.delete(entryKey);
        else hits.set(entryKey, filtered);
      }
    }

    next();
  };
}

/**
 * Middleware Zero Trust: valida criptográficamente el Bearer JWT contra Supabase Auth
 * y exige rol `coordinadora` o `admin` en `app_metadata` (nunca en `user_metadata` ni cabeceras custom).
 */
export async function requireCoordinatorOrAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({
      error: 'Autenticación requerida (Bearer token ausente).',
      code: 'AUTH_TOKEN_MISSING',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) {
    res.status(401).json({
      error: 'Token de sesión inválido.',
      code: 'AUTH_TOKEN_INVALID',
    });
    return;
  }

  const client = getVerifierSupabaseClient();
  if (!client) {
    res.status(503).json({
      error: 'Servicio de verificación Supabase no configurado en el servidor.',
      code: 'SUPABASE_SERVER_UNCONFIGURED',
    });
    return;
  }

  try {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({
        error: 'Sesión inválida o expirada. Inicie sesión nuevamente.',
        code: 'AUTH_SESSION_EXPIRED',
      });
      return;
    }

    const appMeta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
    const jwtAppRole = String(appMeta.app_role ?? appMeta.role ?? '')
      .trim()
      .toLowerCase();
    const effective = await resolveEffectiveServerAppRole(
      data.user.id,
      token,
      jwtAppRole,
      appMeta.sucursal
    );
    const appRole = effective.role;

    if (!effective.isActive || !ALLOWED_COORDINATOR_ROLES.has(appRole)) {
      res.status(403).json({
        error: 'Acceso denegado: este recurso requiere perfil Coordinadora o Admin.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    req.authUser = {
      id: data.user.id,
      email: String(data.user.email || ''),
      appRole,
      sucursal: effective.sucursal,
      isCoordinatorOrAdmin: true,
      accessToken: token,
    };
    next();
  } catch {
    res.status(502).json({
      error: 'No se pudo verificar la sesión contra el proveedor de identidad.',
      code: 'AUTH_UPSTREAM_ERROR',
    });
  }
}

/**
 * Middleware Zero Trust para Asistencia:
 * - Valida criptográficamente el Bearer JWT contra Supabase Auth.
 * - Acepta roles administrativos (`coordinadora`, `admin`, etc.) o `promotora` activa
 *   vinculada unívocamente a su registro en `public.staff`.
 */
export async function requireAttendanceActorAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({
      error: 'Autenticación requerida (Bearer token ausente).',
      code: 'AUTH_TOKEN_MISSING',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) {
    res.status(401).json({
      error: 'Token de sesión inválido.',
      code: 'AUTH_TOKEN_INVALID',
    });
    return;
  }

  const verifier = getVerifierSupabaseClient();
  if (!verifier) {
    res.status(503).json({
      error: 'Servicio de verificación Supabase no configurado en el servidor.',
      code: 'SUPABASE_SERVER_UNCONFIGURED',
    });
    return;
  }

  try {
    const { data, error } = await verifier.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({
        error: 'Sesión inválida o expirada. Inicie sesión nuevamente.',
        code: 'AUTH_SESSION_EXPIRED',
      });
      return;
    }

    const appMeta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
    const jwtAppRole = String(appMeta.app_role ?? appMeta.role ?? '')
      .trim()
      .toLowerCase();
    const effective = await resolveEffectiveServerAppRole(
      data.user.id,
      token,
      jwtAppRole,
      appMeta.sucursal
    );
    const appRole = effective.role;

    if (!effective.isActive) {
      res.status(403).json({
        error: 'Acceso denegado: la cuenta se encuentra suspendida.',
        code: 'ACCOUNT_SUSPENDED',
      });
      return;
    }

    if (isCoordinatorOrAdminRole(appRole)) {
      req.authUser = {
        id: data.user.id,
        email: String(data.user.email || ''),
        appRole,
        sucursal: effective.sucursal,
        staffId:
          typeof appMeta.staff_id === 'string' && UUID_REGEX.test(appMeta.staff_id)
            ? appMeta.staff_id
            : null,
        isCoordinatorOrAdmin: true,
        accessToken: token,
      };
      next();
      return;
    }

    // Roles de supervisión de solo lectura (p. ej. `contraloria`): consultan evidencias,
    // pero el handler les niega cualquier carga o reemplazo (`READ_ONLY_ROLE`).
    if (isTorreViewerRole(appRole)) {
      req.authUser = {
        id: data.user.id,
        email: String(data.user.email || ''),
        appRole,
        sucursal: effective.sucursal,
        staffId: null,
        isCoordinatorOrAdmin: false,
        isReadOnlyViewer: true,
        accessToken: token,
      };
      next();
      return;
    }

    if (appRole !== 'promotora') {
      res.status(403).json({
        error: 'Acceso denegado: su perfil no está autorizado para gestionar evidencias de asistencia.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    // Resolver `staffId` verificado en `public.staff` para la promotora autenticada
    const lookupClient = getAdminSupabaseClient() || createUserScopedSupabaseClient(token);
    if (!lookupClient) {
      res.status(503).json({
        error: 'No se pudo inicializar el cliente de validación de personal.',
        code: 'SUPABASE_SERVER_UNCONFIGURED',
      });
      return;
    }

    let resolvedStaffId: string | null = null;
    let resolvedStaffSucursal: ServerSucursalCodigo | null = effective.sucursal;
    const { data: linkedStaff } = await lookupClient
      .from('staff')
      .select('id, role, status, auth_user_id, sucursal')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();

    const candidateClaimId =
      typeof appMeta.staff_id === 'string' && UUID_REGEX.test(appMeta.staff_id.trim())
        ? appMeta.staff_id.trim()
        : null;

    let staffRecord = linkedStaff;
    if (!staffRecord && candidateClaimId) {
      const { data: claimStaff } = await lookupClient
        .from('staff')
        .select('id, role, status, auth_user_id, sucursal')
        .eq('id', candidateClaimId)
        .maybeSingle();
      if (claimStaff && (!claimStaff.auth_user_id || claimStaff.auth_user_id === data.user.id)) {
        staffRecord = claimStaff;
      }
    }

    if (staffRecord && UUID_REGEX.test(String(staffRecord.id || ''))) {
      const rowSuc = normalizeServerSucursal((staffRecord as { sucursal?: unknown }).sucursal);
      if (rowSuc === 'ZULIA' || rowSuc === 'VALENCIA') {
        resolvedStaffSucursal = resolvedStaffSucursal ?? rowSuc;
      }
      let memberStatus = 'Activo';
      let category = '';
      if (typeof staffRecord.status === 'string' && staffRecord.status.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(staffRecord.status) as Record<string, unknown>;
          memberStatus = String(parsed.status || 'Activo').trim();
          category = String(parsed.category || '').trim().toLowerCase();
        } catch {
          // Conservar valores por defecto seguros
        }
      }
      const roleLower = String(staffRecord.role || '').toLowerCase();
      if (
        memberStatus.toLowerCase() !== 'inactivo' &&
        category !== 'merchandising' &&
        !roleLower.includes('merchandising')
      ) {
        resolvedStaffId = String(staffRecord.id);
      }
    }

    if (!resolvedStaffId) {
      res.status(403).json({
        error: 'Su cuenta de promotora no posee un registro activo válido en public.staff.',
        code: 'PROMOTORA_STAFF_UNLINKED',
      });
      return;
    }

    req.authUser = {
      id: data.user.id,
      email: String(data.user.email || ''),
      appRole: 'promotora',
      sucursal: resolvedStaffSucursal,
      staffId: resolvedStaffId,
      isCoordinatorOrAdmin: false,
      accessToken: token,
    };
    next();
  } catch {
    res.status(502).json({
      error: 'No se pudo verificar la sesión contra el proveedor de identidad.',
      code: 'AUTH_UPSTREAM_ERROR',
    });
  }
}

/**
 * Endpoint administrativo `POST /api/admin/staff-auth`:
 * Crea o actualiza una cuenta en `auth.users` con `app_metadata` firmado (`app_role`, `staff_id`),
 * vincula `public.staff.auth_user_id` y purga cualquier contraseña legacy en `public.staff.status`.
 */
export async function handleProvisionStaffAuth(req: Request, res: Response): Promise<void> {
  const admin = getAdminSupabaseClient();
  if (!admin) {
    res.status(503).json({
      error:
        'Falta configurar SUPABASE_SERVICE_ROLE_KEY en las variables privadas del servidor para aprovisionar cuentas Auth.',
      code: 'SERVICE_ROLE_KEY_MISSING',
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const staffId = String(body.staffId || '').trim();
  const name = String(body.name || '').trim();
  const rawEmail = String(body.email || '').trim();
  const password = String(body.password || '').trim();
  const requestedRole = String(body.appRole || 'promotora').trim().toLowerCase();
  const active = body.active !== false;

  if (!UUID_REGEX.test(staffId) || !name) {
    res.status(400).json({
      error: 'Se requiere un staffId UUID válido y el nombre del integrante.',
      code: 'INVALID_STAFF_PAYLOAD',
    });
    return;
  }

  if (!['promotora', 'coordinadora', 'admin'].includes(requestedRole)) {
    res.status(400).json({
      error: 'Rol solicitado no válido.',
      code: 'INVALID_APP_ROLE',
    });
    return;
  }

  const callerIsStrictAdmin =
    req.authUser?.appRole === 'super_admin' ||
    req.authUser?.appRole === 'superadmin' ||
    req.authUser?.appRole === 'admin' ||
    req.authUser?.appRole === 'gerente_admin';

  if (requestedRole === 'admin' && !callerIsStrictAdmin) {
    res.status(403).json({
      error: 'Solo un administrador puede otorgar el rol admin.',
      code: 'ADMIN_REQUIRED',
    });
    return;
  }

  if (password && password.length < 8) {
    res.status(400).json({
      error: 'La contraseña debe tener al menos 8 caracteres.',
      code: 'WEAK_PASSWORD',
    });
    return;
  }

  try {
    const { data: staffRow, error: staffFetchErr } = await admin
      .from('staff')
      .select('id, name, email, status, auth_user_id, sucursal')
      .eq('id', staffId)
      .maybeSingle();

    if (staffFetchErr || !staffRow) {
      res.status(404).json({
        error: 'El registro de personal no existe en public.staff.',
        code: 'STAFF_NOT_FOUND',
      });
      return;
    }

    const callerRegionalSucursal =
      req.authUser?.sucursal === 'ZULIA' || req.authUser?.sucursal === 'VALENCIA'
        ? req.authUser.sucursal
        : null;
    const existingStaffSucursal = normalizeServerSucursal(
      (staffRow as { sucursal?: unknown }).sucursal
    );

    if (
      callerRegionalSucursal &&
      existingStaffSucursal &&
      existingStaffSucursal !== 'GLOBAL' &&
      existingStaffSucursal !== callerRegionalSucursal
    ) {
      res.status(403).json({
        error: `Cruce de sede bloqueado: tu perfil pertenece a ${callerRegionalSucursal} y no puede aprovisionar personal de ${existingStaffSucursal}.`,
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

    const requestedSucursal = normalizeServerSucursal(body.sucursal);
    if (
      callerRegionalSucursal &&
      requestedSucursal &&
      requestedSucursal !== callerRegionalSucursal
    ) {
      res.status(403).json({
        error: `Cruce de sede bloqueado: no puedes asignar sucursal ${requestedSucursal} desde ${callerRegionalSucursal}.`,
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

    const effectiveProfileRole =
      requestedRole === 'admin'
        ? 'super_admin'
        : requestedRole === 'coordinadora'
          ? 'coordinacion'
          : 'promotora';
    const effectiveSucursal: ServerSucursalCodigo =
      effectiveProfileRole === 'super_admin'
        ? 'GLOBAL'
        : callerRegionalSucursal ||
          (existingStaffSucursal && existingStaffSucursal !== 'GLOBAL'
            ? existingStaffSucursal
            : null) ||
          (requestedSucursal && requestedSucursal !== 'GLOBAL' ? requestedSucursal : null) ||
          'ZULIA';

    const loginEmail = normalizeStaffLoginEmail(
      rawEmail || String(staffRow.email || ''),
      name || String(staffRow.name || ''),
      staffId
    );

    const appMetadata = {
      role: effectiveProfileRole,
      app_role: effectiveProfileRole,
      sucursal: effectiveSucursal,
      staff_id: staffId,
      display_name: name,
    };

    let authUserId = String((staffRow as { auth_user_id?: string | null }).auth_user_id || '').trim();

    if (authUserId && UUID_REGEX.test(authUserId)) {
      const { error: updateErr } = await admin.auth.admin.updateUserById(authUserId, {
        email: loginEmail,
        email_confirm: true,
        ...(password ? { password } : {}),
        app_metadata: appMetadata,
        ban_duration: active ? 'none' : '876000h',
      });

      if (updateErr) {
        res.status(400).json({
          error: `No se pudo actualizar la cuenta Auth: ${updateErr.message}`,
          code: 'AUTH_UPDATE_FAILED',
        });
        return;
      }
    } else {
      if (!password) {
        res.status(400).json({
          error: 'Debe definir una contraseña inicial (mínimo 8 caracteres) para crear la cuenta Auth.',
          code: 'INITIAL_PASSWORD_REQUIRED',
        });
        return;
      }

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: loginEmail,
        password,
        email_confirm: true,
        app_metadata: appMetadata,
      });

      if (createErr || !created.user) {
        res.status(400).json({
          error: `No se pudo crear la cuenta Auth: ${createErr?.message || 'error desconocido'}`,
          code: 'AUTH_CREATE_FAILED',
        });
        return;
      }
      authUserId = created.user.id;
    }

    // Purgar cualquier clave "password" legacy en public.staff.status y vincular auth_user_id
    let sanitizedStatusText = staffRow.status;
    if (typeof staffRow.status === 'string' && staffRow.status.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(staffRow.status) as Record<string, unknown>;
        delete parsed.password;
        sanitizedStatusText = JSON.stringify(parsed);
      } catch {
        sanitizedStatusText = staffRow.status;
      }
    }

    await admin
      .from('staff')
      .update({
        auth_user_id: authUserId,
        email: loginEmail,
        status: sanitizedStatusText,
        ...(effectiveSucursal !== 'GLOBAL' ? { sucursal: effectiveSucursal } : {}),
      })
      .eq('id', staffId);

    // Mantener sincronizada la fuente única `public.profiles`
    await admin.from('profiles').upsert(
      {
        id: authUserId,
        email: loginEmail,
        full_name: name,
        role: effectiveProfileRole,
        sucursal: effectiveSucursal,
        is_active: active,
      },
      { onConflict: 'id' }
    );

    res.status(200).json({
      ok: true,
      authUserId,
      loginEmail,
      sucursal: effectiveSucursal,
    });
    } catch {
      res.status(500).json({
        error: 'Error interno procesando el aprovisionamiento de credenciales.',
        code: 'STAFF_AUTH_INTERNAL_ERROR',
      });
    }
  }

/**
 * Middleware Zero Trust exclusivo para `super_admin` activo:
 * Verifica criptográficamente el Bearer JWT y exige fila activa con `role = 'super_admin'`
 * en `public.profiles`.
 */
export async function requireSuperAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({
      error: 'Autenticación requerida (Bearer token ausente).',
      code: 'AUTH_TOKEN_MISSING',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) {
    res.status(401).json({
      error: 'Token de sesión inválido.',
      code: 'AUTH_TOKEN_INVALID',
    });
    return;
  }

  const verifier = getVerifierSupabaseClient();
  if (!verifier) {
    res.status(503).json({
      error: 'Servicio de verificación Supabase no configurado en el servidor.',
      code: 'SUPABASE_SERVER_UNCONFIGURED',
    });
    return;
  }

  try {
    const { data, error } = await verifier.auth.getUser(token);
    if (error || !data.user || !UUID_REGEX.test(data.user.id)) {
      res.status(401).json({
        error: 'Sesión inválida o expirada. Inicie sesión nuevamente.',
        code: 'AUTH_SESSION_EXPIRED',
      });
      return;
    }

    const lookup = getAdminSupabaseClient() || createUserScopedSupabaseClient(token);
    if (!lookup) {
      res.status(503).json({
        error: 'No se pudo inicializar el cliente de validación IAM en el servidor.',
        code: 'SUPABASE_SERVER_UNCONFIGURED',
      });
      return;
    }

    const { data: profile, error: profileErr } = await lookup
      .from('profiles')
      .select('role, is_active')
      .eq('id', data.user.id)
      .maybeSingle();

    const activeRole = String(profile?.role ?? '').trim().toLowerCase();
    if (profileErr || !profile || profile.is_active !== true || activeRole !== 'super_admin') {
      res.status(403).json({
        error: 'Acceso denegado: esta acción es exclusiva del Administrador General activo.',
        code: 'SUPER_ADMIN_REQUIRED',
      });
      return;
    }

    req.authUser = {
      id: data.user.id,
      email: String(data.user.email || '').trim().toLowerCase(),
      appRole: 'super_admin',
      sucursal: 'GLOBAL',
      isCoordinatorOrAdmin: true,
      accessToken: token,
    };
    next();
  } catch {
    res.status(502).json({
      error: 'No se pudo verificar la sesión contra el proveedor de identidad.',
      code: 'AUTH_UPSTREAM_ERROR',
    });
  }
}

/**
 * Endpoint administrativo `POST /api/admin/corporate-users`:
 * Elimina el uso de `auth.signUp()` público en el cliente (SEC-02).
 * Crea el usuario en `auth.users` con `SUPABASE_SERVICE_ROLE_KEY` (permitiendo mantener
 * cerrado el registro público en Supabase Auth) y finaliza el perfil + auditoría
 * invocando `public.admin_finalize_created_user` bajo el JWT del `super_admin` actor.
 */
export async function handleCreateCorporateUser(req: Request, res: Response): Promise<void> {
  const admin = getAdminSupabaseClient();
  if (!admin) {
    res.status(503).json({
      error:
        'Falta configurar SUPABASE_SERVICE_ROLE_KEY en el servidor para crear usuarios corporativos.',
      code: 'SERVICE_ROLE_KEY_MISSING',
    });
    return;
  }

  const actorToken = String(req.authUser?.accessToken || '').trim();
  const actorClient = createUserScopedSupabaseClient(actorToken);
  if (!actorClient) {
    res.status(401).json({
      error: 'Sesión administrativa no válida.',
      code: 'AUTH_SESSION_EXPIRED',
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const fullName = String(body.fullName ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const role = String(body.role ?? 'vendedor').trim().toLowerCase();
  const mustChangePassword = body.mustChangePassword === true;

  if (fullName.length < 2 || fullName.length > 160) {
    res.status(400).json({
      error: 'El nombre completo debe contener entre 2 y 160 caracteres.',
      code: 'INVALID_FULL_NAME',
    });
    return;
  }

  if (email.length < 5 || email.length > 254 || !STRICT_EMAIL_REGEX.test(email)) {
    res.status(400).json({
      error: 'Ingresa un correo electrónico corporativo válido.',
      code: 'INVALID_EMAIL',
    });
    return;
  }

  if (!CORPORATE_MANAGED_ROLES.has(role)) {
    res.status(400).json({
      error:
        'Rol inválido. Valores permitidos: super_admin, coordinacion, contraloria, vendedor, promotora, cliente, chofer.',
      code: 'INVALID_CORPORATE_ROLE',
    });
    return;
  }

  let resolvedSucursal: ServerSucursalCodigo | null = null;
  const rawSucursal = body.sucursal;
  if (role === 'super_admin') {
    if (
      rawSucursal !== undefined &&
      rawSucursal !== null &&
      String(rawSucursal).trim() !== '' &&
      normalizeServerSucursal(rawSucursal) !== 'GLOBAL'
    ) {
      res.status(400).json({
        error: 'El rol super_admin requiere obligatoriamente sucursal GLOBAL.',
        code: 'INVALID_SUCURSAL_FOR_ROLE',
      });
      return;
    }
    resolvedSucursal = 'GLOBAL';
  } else if (role === 'contraloria') {
    if (rawSucursal === undefined || rawSucursal === null || String(rawSucursal).trim() === '') {
      resolvedSucursal = 'GLOBAL';
    } else {
      resolvedSucursal = normalizeServerSucursal(rawSucursal);
      if (!resolvedSucursal) {
        res.status(400).json({
          error: 'Sucursal inválida. Valores permitidos para contraloria: GLOBAL, ZULIA, VALENCIA.',
          code: 'INVALID_SUCURSAL_FOR_ROLE',
        });
        return;
      }
    }
  } else {
    const candidate = normalizeServerSucursal(rawSucursal);
    if (candidate !== 'ZULIA' && candidate !== 'VALENCIA') {
      res.status(400).json({
        error: `El rol ${role} requiere asignar explícitamente sucursal ZULIA o VALENCIA (GLOBAL está reservado para roles nacionales).`,
        code: 'INVALID_SUCURSAL_FOR_ROLE',
      });
      return;
    }
    resolvedSucursal = candidate;
  }

  if (password.trim().length === 0 || password.length < MIN_CORPORATE_PASSWORD_LENGTH) {
    res.status(400).json({
      error: `La contraseña inicial debe tener al menos ${MIN_CORPORATE_PASSWORD_LENGTH} caracteres.`,
      code: 'WEAK_PASSWORD',
    });
    return;
  }

  let createdUserId: string | null = null;

  try {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        role,
        app_role: role,
        sucursal: resolvedSucursal,
        display_name: fullName,
        is_active: true,
        must_change_password: mustChangePassword,
      },
    });

    if (createErr || !created?.user?.id) {
      const errMsg = String(createErr?.message || '');
      const isDuplicate = /already registered|already exists|email_exists|user_already_exists/i.test(
        errMsg
      );
      res.status(isDuplicate ? 409 : 400).json({
        error: isDuplicate
          ? 'Este correo electrónico ya está registrado en el sistema.'
          : `No se pudo crear la cuenta en Supabase Auth: ${errMsg || 'error desconocido'}`,
        code: isDuplicate ? 'EMAIL_ALREADY_EXISTS' : 'AUTH_CREATE_FAILED',
      });
      return;
    }

    createdUserId = created.user.id;

    const { data: finalizedRows, error: finalizeErr } = await actorClient.rpc(
      'admin_finalize_created_user',
      {
        p_target_user_id: createdUserId,
        p_full_name: fullName,
        p_role: role,
        p_must_change_password: mustChangePassword,
        p_sucursal: resolvedSucursal,
      }
    );

    const profileRow = Array.isArray(finalizedRows) ? finalizedRows[0] : finalizedRows;

    if (finalizeErr || !profileRow) {
      await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      createdUserId = null;
      res.status(400).json({
        error:
          finalizeErr?.message ||
          'No se pudo registrar el perfil corporativo; la operación fue revertida de forma segura.',
        code: 'PROFILE_FINALIZE_FAILED',
      });
      return;
    }

    res.status(201).json({
      ok: true,
      profile: profileRow,
    });
  } catch {
    if (createdUserId) {
      await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
    }
    res.status(500).json({
      error: 'Error interno creando el usuario corporativo.',
      code: 'CORPORATE_USER_INTERNAL_ERROR',
    });
  }
}
