import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { NextFunction, Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_COORDINATOR_ROLES = new Set([
  'coordinadora',
  'coordinadora_trade',
  'jefe_trade',
  'supervisor',
  'gerente_admin',
  'gerencia',
  'admin',
]);

export interface AuthenticatedServerUser {
  id: string;
  email: string;
  appRole: string;
  staffId?: string | null;
  isCoordinatorOrAdmin?: boolean;
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
  return (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();
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
let adminClient: SupabaseClient | null = null;

export function getVerifierSupabaseClient(): SupabaseClient | null {
  const url = getSupabaseProjectUrl();
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) return null;
  if (!verifierClient) {
    verifierClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return verifierClient;
}

export function getAdminSupabaseClient(): SupabaseClient | null {
  const url = getSupabaseProjectUrl();
  const serviceKey = getSupabaseServiceRoleKey();
  if (!url || !serviceKey) return null;
  if (!adminClient) {
    adminClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
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
    const appRole = String(appMeta.app_role ?? appMeta.role ?? '')
      .trim()
      .toLowerCase();

    if (!ALLOWED_COORDINATOR_ROLES.has(appRole)) {
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
    const appRole = String(appMeta.app_role ?? appMeta.role ?? '')
      .trim()
      .toLowerCase();

    if (isCoordinatorOrAdminRole(appRole)) {
      req.authUser = {
        id: data.user.id,
        email: String(data.user.email || ''),
        appRole,
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
    const { data: linkedStaff } = await lookupClient
      .from('staff')
      .select('id, role, status, auth_user_id')
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
        .select('id, role, status, auth_user_id')
        .eq('id', candidateClaimId)
        .maybeSingle();
      if (claimStaff && (!claimStaff.auth_user_id || claimStaff.auth_user_id === data.user.id)) {
        staffRecord = claimStaff;
      }
    }

    if (staffRecord && UUID_REGEX.test(String(staffRecord.id || ''))) {
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

  if (requestedRole === 'admin' && req.authUser?.appRole !== 'admin' && req.authUser?.appRole !== 'gerente_admin') {
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
      .select('id, name, email, status, auth_user_id')
      .eq('id', staffId)
      .maybeSingle();

    if (staffFetchErr || !staffRow) {
      res.status(404).json({
        error: 'El registro de personal no existe en public.staff.',
        code: 'STAFF_NOT_FOUND',
      });
      return;
    }

    const loginEmail = normalizeStaffLoginEmail(
      rawEmail || String(staffRow.email || ''),
      name || String(staffRow.name || ''),
      staffId
    );

    const appMetadata = {
      app_role: requestedRole,
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
      })
      .eq('id', staffId);

    res.status(200).json({
      ok: true,
      authUserId,
      loginEmail,
    });
  } catch {
    res.status(500).json({
      error: 'Error interno procesando el aprovisionamiento de credenciales.',
      code: 'STAFF_AUTH_INTERNAL_ERROR',
    });
  }
}
