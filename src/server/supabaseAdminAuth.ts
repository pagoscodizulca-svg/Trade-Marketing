import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { NextFunction, Request, Response } from 'express';
import { serverLogger } from './logger';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_CORPORATE_PASSWORD_LENGTH = 8;

const ALLOWED_COORDINATOR_ROLES = new Set([
  'super_admin',
  'superadmin',
  'coordinacion',
  'coordinadora',
  'coordinador',
  'coordinadora_trade',
  'coordinador_trade',
  'coordinador_regional',
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

export const OPERATIVE_SUCURSALES = [
  'ZULIA',
  'VALENCIA',
  'CENTRO',
  'ORIENTE',
  'CAPITAL',
] as const;

export type OperativeSucursal = (typeof OPERATIVE_SUCURSALES)[number];

export type ServerSucursalCodigo = OperativeSucursal | 'GLOBAL';

export type ServerAllowedRegionCode = 'OCCIDENTE' | 'CENTRO' | 'ANDES';

export function normalizeServerAllowedRegionToken(raw: unknown): ServerAllowedRegionCode | null {
  const norm = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
  if (!norm || norm === 'GLOBAL' || norm === 'TODAS' || norm === 'ALL') return null;
  const clean = norm.replace(/^(REGION|REGIÓN|SUCURSAL|SEDE)\s+/i, '').trim();
  if (
    clean === 'OCCIDENTE' ||
    clean === 'ZULIA' ||
    clean === 'FALCON' ||
    clean === 'TRUJILLO' ||
    clean === 'MARACAIBO'
  ) {
    return 'OCCIDENTE';
  }
  if (
    clean === 'CENTRO' ||
    clean === 'VALENCIA' ||
    clean === 'CARABOBO' ||
    clean === 'ARAGUA' ||
    clean === 'MARACAY' ||
    clean === 'CAPITAL' ||
    clean === 'CARACAS' ||
    clean === 'DISTRITO CAPITAL'
  ) {
    return 'CENTRO';
  }
  if (clean === 'ANDES' || clean === 'TACHIRA' || clean === 'MERIDA' || clean === 'BARINAS') {
    return 'ANDES';
  }
  return null;
}

export function normalizeServerAllowedRegionList(
  rawList: unknown,
  fallbackSingle?: unknown
): ServerAllowedRegionCode[] {
  const result: ServerAllowedRegionCode[] = [];
  const pushToken = (val: unknown) => {
    const token = normalizeServerAllowedRegionToken(val);
    if (token && !result.includes(token)) {
      result.push(token);
    }
  };

  if (Array.isArray(rawList)) {
    for (const item of rawList) pushToken(item);
  } else if (typeof rawList === 'string' && rawList.trim()) {
    for (const part of rawList.split(',')) pushToken(part);
  }

  if (result.length === 0 && fallbackSingle !== undefined && fallbackSingle !== null) {
    pushToken(fallbackSingle);
  }

  return result;
}

export const CORPORATE_MANAGED_ROLES = new Set([
  'super_admin',
  'coordinacion',
  'contraloria',
  'vendedor',
  'promotora',
  'cliente',
  'chofer',
]);

export const CANONICAL_SUPER_ADMIN_EMAIL = 'admin@codizulca.com';

export function normalizeCanonicalEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Verificación criptográfica/servidor de privilegio `super_admin`:
 * - Jamás lee `user_metadata` (modificable por el cliente).
 * - Falla cerrado (`false`) si el perfil existe con `is_active === false`.
 * - Acepta `public.profiles.role === 'super_admin'` activo o respaldo en
 *   `app_metadata.role / app_role === 'super_admin'` exclusivamente para
 *   el correo verificado `admin@codizulca.com`.
 */
export function isVerifiedServerSuperAdmin(params: {
  canonicalEmail?: unknown;
  profile?: { role?: unknown; is_active?: unknown } | null;
  appMetadata?: Record<string, unknown> | null;
}): boolean {
  const email = normalizeCanonicalEmail(params.canonicalEmail);
  const profile = params.profile ?? null;

  if (profile) {
    if (profile.is_active !== true) return false;
    return String(profile.role ?? '').trim().toLowerCase() === 'super_admin';
  }

  const appMeta = (params.appMetadata ?? {}) as Record<string, unknown>;
  const appMetaRole = String(appMeta.role ?? appMeta.app_role ?? '')
    .trim()
    .toLowerCase();

  return email === CANONICAL_SUPER_ADMIN_EMAIL && appMetaRole === 'super_admin';
}

export function isOperativeServerSucursal(value: unknown): value is OperativeSucursal {
  return (
    value === 'ZULIA' ||
    value === 'VALENCIA' ||
    value === 'CENTRO' ||
    value === 'ORIENTE' ||
    value === 'CAPITAL'
  );
}

export function normalizeServerSucursal(raw: unknown): ServerSucursalCodigo | null {
  const nfdLower = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  if (!nfdLower) return null;

  const tokensText = nfdLower.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!tokensText) return null;

  if (
    tokensText === 'global' ||
    tokensText === 'nacional' ||
    tokensText === 'admin general' ||
    tokensText === 'global nacional' ||
    tokensText === 'administracion general nacional' ||
    tokensText === 'contraloria nacional global'
  ) {
    return 'GLOBAL';
  }

  const strippedPrefix = tokensText.replace(
    /^(sucursal|sede|region|hub|estado|zona|oficina)\s+/,
    ''
  );
  if (strippedPrefix === 'zulia' || strippedPrefix === 'occidente') return 'ZULIA';
  if (strippedPrefix === 'valencia') return 'VALENCIA';
  if (strippedPrefix === 'centro') return 'CENTRO';
  if (strippedPrefix === 'oriente') return 'ORIENTE';
  if (strippedPrefix === 'capital') return 'CAPITAL';

  if (
    /\b(occidente|zulia|maracaibo|san francisco|cabimas|ciudad ojeda|lagunillas|machiques|costa oriental|mara|guajira|coro|punto fijo|la villa)\b/.test(
      tokensText
    ) ||
    tokensText === 'col'
  ) {
    return 'ZULIA';
  }

  if (
    /\b(valencia|carabobo|naguanagua|san diego|guacara|tocuyito|puerto cabello|los guayos|mariara|bejuma)\b/.test(
      tokensText
    )
  ) {
    return 'VALENCIA';
  }

  if (
    /\b(centro|aragua|maracay|turmero|cagua|la victoria|villa de cura|lara|barquisimeto|cabudare|carora|quibor|yaracuy|san felipe|yaritagua|cojedes|san carlos|tinaquillo)\b/.test(
      tokensText
    )
  ) {
    return 'CENTRO';
  }

  if (
    /\b(oriente|anzoategui|barcelona|puerto la cruz|lecheria|el tigre|anaco|cantaura|monagas|maturin|punta de mata|nueva esparta|margarita|porlamar|pampatar|juan griego|sucre|cumana|carupano|puerto ordaz|ciudad guayana|ciudad bolivar|san felix|upata|estado bolivar|delta amacuro|tucupita)\b/.test(
      tokensText
    ) ||
    tokensText === 'bolivar'
  ) {
    return 'ORIENTE';
  }

  if (
    /\b(capital|caracas|distrito capital|dtto capital|gran caracas|miranda|chacao|baruta|el hatillo|petare|los teques|guarenas|guatire|charallave|cua|ocumare del tuy|valles del tuy|higuerote|la guaira|vargas|maiquetia|catia la mar|caraballeda)\b/.test(
      tokensText
    )
  ) {
    return 'CAPITAL';
  }

  return null;
}

export function normalizeOperativeServerSucursal(raw: unknown): OperativeSucursal | null {
  const norm = normalizeServerSucursal(raw);
  return isOperativeServerSucursal(norm) ? norm : null;
}

export function extractRawActiveSucursalHeader(req: Request): string {
  const raw = req?.headers?.['x-sucursal-activa'];
  const val = Array.isArray(raw) ? raw[0] : raw;
  return typeof val === 'string' ? val.trim() : '';
}

function normalizeServerRoleAlias(rawRole: unknown): string {
  const clean = String(rawRole ?? '').trim().toLowerCase();
  if (
    clean === 'supervisor' ||
    clean === 'supervisora' ||
    clean === 'supervisor_trade' ||
    clean === 'coordinador_trade' ||
    clean === 'coordinadora_trade' ||
    clean === 'coordinador_regional' ||
    clean === 'coordinador'
  ) {
    return 'coordinacion';
  }
  if (clean === 'fdv' || clean === 'fuerza_ventas') {
    return 'vendedor';
  }
  return clean;
}

/**
 * Resuelve de forma segura `activeSucursalHeader`:
 * - Solo actores globales (`GLOBAL` / `super_admin`) pueden cambiar su hub vía cabecera `x-sucursal-activa`.
 * - Actores regionales quedan fijados estrictamente a su propia `sucursal` verificada (impide spoofing de cabecera).
 */
function resolveSafeActiveSucursalHeaderForActor(
  req: Request,
  isGlobalActor: boolean,
  verifiedSucursal: ServerSucursalCodigo | null,
  allowedRegions?: readonly ServerAllowedRegionCode[] | null
): OperativeSucursal | null {
  if (isGlobalActor) {
    return normalizeOperativeServerSucursal(extractRawActiveSucursalHeader(req));
  }
  const requested = normalizeOperativeServerSucursal(extractRawActiveSucursalHeader(req));
  if (requested && Array.isArray(allowedRegions) && allowedRegions.length > 0) {
    const requestedRegion = normalizeServerAllowedRegionToken(requested);
    if (requestedRegion && allowedRegions.includes(requestedRegion)) {
      return requested;
    }
  }
  return isOperativeServerSucursal(verifiedSucursal) ? verifiedSucursal : null;
}

function extractSucursalCandidateFromRecord(row: Record<string, unknown>): ServerSucursalCodigo | null {
  return (
    normalizeServerSucursal(row.region) ??
    normalizeServerSucursal(row.sucursal) ??
    normalizeServerSucursal(row.zona) ??
    normalizeServerSucursal(row.ciudad) ??
    normalizeServerSucursal(row.estado) ??
    normalizeServerSucursal(row.direccion) ??
    null
  );
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

async function resolvePromotoraByCanonicalEmail(
  lookup: SupabaseClient,
  canonicalEmail: string
): Promise<{
  matched: boolean;
  explicitlyInactive: boolean;
  sucursal: OperativeSucursal | null;
  staffId: string | null;
}> {
  let matched = false;
  let explicitlyInactive = false;
  let sucursal: OperativeSucursal | null = null;
  let staffId: string | null = null;

  try {
    const { data: staffRows, error: staffErr } = await lookup
      .from('staff')
      .select('*')
      .ilike('email', `%${canonicalEmail}%`)
      .limit(10);

    if (!staffErr) {
      const list = Array.isArray(staffRows)
        ? (staffRows as Record<string, unknown>[])
        : staffRows && typeof staffRows === 'object'
          ? [staffRows as Record<string, unknown>]
          : [];
      const staffMatch = list.find((r) => normalizeCanonicalEmail(r.email) === canonicalEmail);
      if (staffMatch) {
        let memberStatus = String(staffMatch.status ?? 'Activo').trim();
        let category = '';
        let statusAddress = '';
        let statusAssigned = '';
        if (memberStatus.startsWith('{')) {
          try {
            const parsed = JSON.parse(memberStatus) as Record<string, unknown>;
            memberStatus = String(parsed.status ?? 'Activo').trim();
            category = String(parsed.category ?? '').trim().toLowerCase();
            statusAddress = String(parsed.address ?? '');
            statusAssigned = String(parsed.assignedLocation ?? '');
          } catch {
            memberStatus = 'Activo';
          }
        }
        const roleLower = String(staffMatch.role ?? '').toLowerCase();
        if (memberStatus.toLowerCase() === 'inactivo') {
          explicitlyInactive = true;
        } else if (category !== 'merchandising' && !roleLower.includes('merchandising')) {
          matched = true;
          if (UUID_REGEX.test(String(staffMatch.id ?? ''))) {
            staffId = String(staffMatch.id);
          }
          sucursal =
            normalizeOperativeServerSucursal(extractSucursalCandidateFromRecord(staffMatch)) ??
            normalizeOperativeServerSucursal(statusAddress) ??
            normalizeOperativeServerSucursal(statusAssigned);
        }
      }
    }
  } catch {
    // Continúa a tabla promotoras si staff no está disponible
  }

  if (!sucursal && !explicitlyInactive) {
    try {
      let promRows: unknown = null;
      let promErr: unknown = null;

      // La tabla real `public.promotoras` usa columna `correo`; respaldo a `email` solo si `correo` no existe
      const byCorreo = await lookup
        .from('promotoras')
        .select('*')
        .ilike('correo', `%${canonicalEmail}%`)
        .limit(10);

      if (!byCorreo.error) {
        promRows = byCorreo.data;
      } else {
        const byEmail = await lookup
          .from('promotoras')
          .select('*')
          .ilike('email', `%${canonicalEmail}%`)
          .limit(10);
        promRows = byEmail.data;
        promErr = byEmail.error;
      }

      if (!promErr) {
        const list = Array.isArray(promRows)
          ? (promRows as Record<string, unknown>[])
          : promRows && typeof promRows === 'object'
            ? [promRows as Record<string, unknown>]
            : [];
        const promMatch = list.find(
          (r) => normalizeCanonicalEmail(r.correo ?? r.email) === canonicalEmail
        );
        if (promMatch) {
          const isInactive =
            promMatch.activo === false ||
            String(promMatch.estado_laboral ?? promMatch.estatus ?? 'Activo')
              .trim()
              .toLowerCase() === 'inactivo';
          if (isInactive) {
            if (!matched) explicitlyInactive = true;
          } else {
            matched = true;
            if (!staffId && promMatch.id !== undefined && promMatch.id !== null) {
              staffId = String(promMatch.id);
            }
            const rawRegion = String(promMatch.region ?? '').trim().toLowerCase();
            const fromExplicitRegion: OperativeSucursal | null =
              rawRegion === 'valencia'
                ? 'VALENCIA'
                : rawRegion === 'occidente'
                  ? 'ZULIA'
                  : null;
            sucursal =
              sucursal ??
              fromExplicitRegion ??
              normalizeOperativeServerSucursal(extractSucursalCandidateFromRecord(promMatch)) ??
              (canonicalEmail === 'joseabraham.barroso@gmail.com' ? 'ZULIA' : null);
          }
        }
      }
    } catch {
      // Tabla promotoras opcional en mocks mínimos
    }
  }

  return { matched, explicitlyInactive, sucursal, staffId };
}

export async function resolveEffectiveServerAppRole(
  userId: string,
  accessToken: string,
  jwtAppRole: string,
  jwtSucursal?: unknown,
  userEmail?: unknown,
  jwtRegions?: unknown
): Promise<{
  role: string;
  isActive: boolean;
  sucursal: ServerSucursalCodigo | null;
  allowedRegions?: ServerAllowedRegionCode[] | null;
  staffId?: string | null;
}> {
  const canonicalEmail = normalizeCanonicalEmail(userEmail);
  const lookup = getAdminSupabaseClient() || createUserScopedSupabaseClient(accessToken);

  let profileData: Record<string, unknown> | null = null;

  if (lookup && UUID_REGEX.test(userId)) {
    try {
      const { data, error } = await lookup
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (!error && data && typeof data === 'object') {
        profileData = data as Record<string, unknown>;
      }
    } catch {
      // Fallback por correo canónico LOWER(TRIM(email)) o app_metadata
    }
  }

  if (!profileData && lookup && canonicalEmail && STRICT_EMAIL_REGEX.test(canonicalEmail)) {
    try {
      const { data: rows, error } = await lookup
        .from('profiles')
        .select('*')
        .ilike('email', `%${canonicalEmail}%`)
        .limit(10);

      if (!error) {
        const list = Array.isArray(rows)
          ? (rows as Record<string, unknown>[])
          : rows && typeof rows === 'object'
            ? [rows as Record<string, unknown>]
            : [];
        const matched = list.find((r) => normalizeCanonicalEmail(r.email) === canonicalEmail);
        if (matched) {
          profileData = matched;
        }
      }
    } catch {
      // Continúa a respaldo en staff / promotoras o JWT
    }
  }

  if (profileData) {
    if (profileData.is_active === false) {
      return { role: '', isActive: false, sucursal: null };
    }
    const profileRole = normalizeServerRoleAlias(profileData.role);
    if (profileRole) {
      let sucursal =
        sanitizeSucursalForServerRole(
          profileRole,
          extractSucursalCandidateFromRecord(profileData)
        ) ?? sanitizeSucursalForServerRole(profileRole, jwtSucursal);
      let staffId: string | null = null;

      if (profileRole === 'promotora' && lookup && canonicalEmail && !sucursal) {
        const promFallback = await resolvePromotoraByCanonicalEmail(lookup, canonicalEmail);
        if (promFallback.explicitlyInactive) {
          return { role: '', isActive: false, sucursal: null };
        }
        sucursal = sucursal ?? promFallback.sucursal;
        staffId = promFallback.staffId;
      }

      const isStrictGlobalRole =
        profileRole === 'super_admin' ||
        profileRole === 'superadmin' ||
        profileRole === 'admin' ||
        profileRole === 'gerencia' ||
        profileRole === 'gerente_admin';
      const resolvedRegions = isStrictGlobalRole
        ? null
        : normalizeServerAllowedRegionList(
            profileData.regiones_asignadas ?? jwtRegions,
            profileData.region ?? sucursal ?? jwtSucursal
          );
      if (!sucursal && resolvedRegions && resolvedRegions.length > 0) {
        sucursal =
          resolvedRegions[0] === 'OCCIDENTE'
            ? 'ZULIA'
            : resolvedRegions[0] === 'CENTRO'
              ? 'CENTRO'
              : null;
      }

      return {
        role: profileRole,
        isActive: true,
        sucursal,
        allowedRegions:
          resolvedRegions && resolvedRegions.length > 0 ? resolvedRegions : null,
        staffId,
      };
    }
  }

  const normalizedJwtRole = normalizeServerRoleAlias(jwtAppRole);

  if (
    (normalizedJwtRole === 'promotora' || !normalizedJwtRole) &&
    lookup &&
    canonicalEmail &&
    STRICT_EMAIL_REGEX.test(canonicalEmail)
  ) {
    const promFallback = await resolvePromotoraByCanonicalEmail(lookup, canonicalEmail);
    if (promFallback.explicitlyInactive) {
      return { role: '', isActive: false, sucursal: null, allowedRegions: null };
    }
    if (promFallback.matched) {
      const promSucursal =
        promFallback.sucursal ?? sanitizeSucursalForServerRole('promotora', jwtSucursal);
      const promRegions = normalizeServerAllowedRegionList(jwtRegions, promSucursal);
      return {
        role: 'promotora',
        isActive: true,
        sucursal: promSucursal,
        allowedRegions: promRegions.length > 0 ? promRegions : null,
        staffId: promFallback.staffId,
      };
    }
  }

  const jwtSanitizedSucursal = sanitizeSucursalForServerRole(normalizedJwtRole, jwtSucursal);
  const isStrictJwtGlobal =
    normalizedJwtRole === 'super_admin' ||
    normalizedJwtRole === 'superadmin' ||
    normalizedJwtRole === 'admin' ||
    normalizedJwtRole === 'gerencia' ||
    normalizedJwtRole === 'gerente_admin';
  const jwtAllowedRegions = isStrictJwtGlobal
    ? null
    : normalizeServerAllowedRegionList(jwtRegions, jwtSanitizedSucursal ?? jwtSucursal);

  return {
    role: normalizedJwtRole,
    isActive: true,
    sucursal:
      jwtSanitizedSucursal ??
      (jwtAllowedRegions && jwtAllowedRegions[0] === 'OCCIDENTE'
        ? 'ZULIA'
        : jwtAllowedRegions && jwtAllowedRegions[0] === 'CENTRO'
          ? 'CENTRO'
          : null),
    allowedRegions:
      jwtAllowedRegions && jwtAllowedRegions.length > 0 ? jwtAllowedRegions : null,
  };
}

export interface AuthenticatedServerUser {
  id: string;
  email: string;
  appRole: string;
  sucursal?: ServerSucursalCodigo | null;
  /** Lista normalizada de regiones permitidas (`['CENTRO', 'ANDES']`, `['OCCIDENTE']`, o `null` para Global) */
  allowedRegions?: ServerAllowedRegionCode[] | null;
  activeSucursalHeader?: OperativeSucursal | null;
  staffId?: string | null;
  isSuperAdmin?: boolean;
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

function decodeServerJwtRole(rawKey: string): string | null {
  const parts = rawKey.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return typeof payload?.role === 'string' ? payload.role.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Valida que `SUPABASE_SERVICE_ROLE_KEY` corresponda realmente a una llave secreta de servidor
 * (`sb_secret_*` o JWT con `role: "service_role"`).
 * Si por error se colocó una llave pública (`sb_publishable_*` o JWT `anon`) en Render, devuelve
 * `false` para impedir que el servidor consulte PostgreSQL como `anon` (error `42501`) y permitir
 * la degradación segura al cliente acotado por JWT `authenticated` bajo RLS.
 */
export function isValidServerServiceRoleKey(rawKey: string, supabaseUrl = ''): boolean {
  const clean = String(rawKey ?? '').trim();
  if (!clean) return false;

  // Rechazar explícitamente llaves públicas/anon o placeholders
  if (/^sb_publishable_/i.test(clean)) return false;
  if (/^(your[_-]|placeholder|changeme|example)/i.test(clean)) return false;

  if (clean.startsWith('sb_secret_') && clean.length >= 20) {
    return true;
  }

  if (clean.startsWith('eyJ')) {
    const role = decodeServerJwtRole(clean);
    if (role === 'service_role') return true;
    if (role === 'anon' || role === 'authenticated') return false;
  }

  // En pruebas unitarias locales contra loopback (127.0.0.1 / localhost), permitir tokens mock no-publicos
  if (
    process.env.NODE_TEST_CONTEXT &&
    /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(supabaseUrl)
  ) {
    return true;
  }

  return false;
}

let invalidServiceKeyWarned = false;

export function getAdminSupabaseClient(): SupabaseClient | null {
  const url = getSupabaseProjectUrl();
  const serviceKey = getSupabaseServiceRoleKey();
  if (!url || !serviceKey) return null;
  if (!isValidServerServiceRoleKey(serviceKey, url)) {
    if (!invalidServiceKeyWarned) {
      invalidServiceKeyWarned = true;
      serverLogger.error('invalid_service_role_key_ignored', {
        detail:
          'SUPABASE_SERVICE_ROLE_KEY contiene una llave pública/anon o inválida (se requiere sb_secret_* o JWT service_role). Se ignorará para evitar consultas como rol anon (42501) y usar el JWT authenticated del usuario bajo RLS.',
      });
    }
    return null;
  }
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
 * Cuando se indica `activeSucursalHeader` válido entre los 5 hubs operativos, propaga
 * `x-sucursal-activa` para acotar lecturas/escrituras de actores nacionales (`GLOBAL`).
 */
export function createUserScopedSupabaseClient(
  accessToken: string,
  activeSucursalHeader?: unknown
): SupabaseClient | null {
  const url = getSupabaseProjectUrl();
  const anonKey = getSupabaseAnonKey();
  const cleanToken = String(accessToken || '').trim();
  if (!url || !anonKey || !cleanToken) return null;

  const normalizedActiveHub = normalizeOperativeServerSucursal(activeSucursalHeader);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cleanToken}`,
    ...(normalizedActiveHub ? { 'x-sucursal-activa': normalizedActiveHub } : {}),
  };

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers,
    },
  });
}

export function isCoordinatorOrAdminRole(rawRole: string): boolean {
  return ALLOWED_COORDINATOR_ROLES.has(String(rawRole || '').trim().toLowerCase());
}

export function isTorreViewerRole(rawRole: string): boolean {
  return ALLOWED_TORRE_VIEWER_ROLES.has(String(rawRole || '').trim().toLowerCase());
}

export function isCadenaLogoViewerRole(rawRole: string): boolean {
  const clean = String(rawRole || '').trim().toLowerCase();
  return clean === 'cliente' || ALLOWED_TORRE_VIEWER_ROLES.has(clean);
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
      appMeta.sucursal ?? appMeta.region,
      data.user.email,
      appMeta.regions
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

    const isGlobalActor =
      appRole === 'super_admin' || appRole === 'superadmin' || effective.sucursal === 'GLOBAL';
    req.authUser = {
      id: data.user.id,
      email: normalizeCanonicalEmail(data.user.email),
      appRole,
      sucursal: effective.sucursal,
      allowedRegions: isGlobalActor ? null : (effective.allowedRegions ?? null),
      activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
        req,
        isGlobalActor,
        effective.sucursal,
        effective.allowedRegions
      ),
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
 * Middleware Zero Trust para lectura autenticada de logotipos secundarios de cadenas comerciales
 * (`GET /api/cadenas-comerciales/:id/logo`):
 * - Valida criptográficamente el Bearer JWT contra Supabase Auth (cero acceso `anon`).
 * - Acepta perfiles activos de Torre (`super_admin`, `contraloria`, `coordinacion`) y `cliente`
 *   (el aislamiento regional y vínculo en `cliente_portal_accesos` se aplica en `cadenaLogoHandler.ts`).
 */
export async function requireCadenaLogoViewerAuth(
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
      appMeta.sucursal ?? appMeta.region,
      data.user.email,
      appMeta.regions
    );
    const appRole = effective.role;

    if (!effective.isActive) {
      res.status(403).json({
        error: 'Acceso denegado: la cuenta se encuentra suspendida.',
        code: 'ACCOUNT_SUSPENDED',
      });
      return;
    }

    if (!isCadenaLogoViewerRole(appRole)) {
      res.status(403).json({
        error:
          'Acceso denegado: tu perfil no cuenta con autorización para consultar logotipos de cadenas comerciales.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    const isGlobalActor =
      appRole === 'super_admin' || appRole === 'superadmin' || effective.sucursal === 'GLOBAL';
    req.authUser = {
      id: data.user.id,
      email: normalizeCanonicalEmail(data.user.email),
      appRole,
      sucursal: effective.sucursal,
      allowedRegions: isGlobalActor ? null : (effective.allowedRegions ?? null),
      activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
        req,
        isGlobalActor,
        effective.sucursal,
        effective.allowedRegions
      ),
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
      appMeta.sucursal ?? appMeta.region,
      data.user.email,
      appMeta.regions
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

    const isGlobalActor =
      appRole === 'super_admin' || appRole === 'superadmin' || effective.sucursal === 'GLOBAL';
    req.authUser = {
      id: data.user.id,
      email: normalizeCanonicalEmail(data.user.email),
      appRole,
      sucursal: effective.sucursal,
      allowedRegions: isGlobalActor ? null : (effective.allowedRegions ?? null),
      activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
        req,
        isGlobalActor,
        effective.sucursal,
        effective.allowedRegions
      ),
      isCoordinatorOrAdmin: isCoordinatorOrAdminRole(appRole),
      isReadOnlyViewer:
        appRole === 'contraloria' ||
        appRole === 'analista_contraloria' ||
        appRole === 'contralor',
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
      appMeta.sucursal ?? appMeta.region,
      data.user.email,
      appMeta.regions
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

    const isGlobalActor =
      appRole === 'super_admin' || appRole === 'superadmin' || effective.sucursal === 'GLOBAL';
    req.authUser = {
      id: data.user.id,
      email: normalizeCanonicalEmail(data.user.email),
      appRole,
      sucursal: effective.sucursal,
      allowedRegions: isGlobalActor ? null : (effective.allowedRegions ?? null),
      activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
        req,
        isGlobalActor,
        effective.sucursal,
        effective.allowedRegions
      ),
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


export function isMasterDataReaderRole(rawRole: string): boolean {
  const clean = String(rawRole || '').trim().toLowerCase();
  return (
    ALLOWED_TORRE_VIEWER_ROLES.has(clean) ||
    clean === 'vendedor' ||
    clean === 'promotora'
  );
}

/**
 * Middleware Zero Trust para lectura autenticada del catálogo maestro de Clientes y Vendedores
 * (`GET /api/maestros/clientes`, `GET /api/maestros/vendedores`, `GET /api/maestros/sedes-resumen`):
 *  - Exige Bearer JWT verificado contra Supabase Auth (cero acceso anónimo).
 *  - Acepta perfiles activos de Torre de Control (`super_admin`, `coordinacion`, `contraloria`,
 *    `admin`, `gerencia`), `vendedor` y `promotora`.
 *  - Propaga `req.authUser.sucursal` y `activeSucursalHeader` para aislar estrictamente por sede.
 */
export async function requireMasterDataReaderAuth(
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
      appMeta.sucursal ?? appMeta.region,
      data.user.email,
      appMeta.regions
    );
    const appRole = effective.role;

    if (!effective.isActive) {
      res.status(403).json({
        error: 'Acceso denegado: la cuenta se encuentra suspendida.',
        code: 'ACCOUNT_SUSPENDED',
      });
      return;
    }

    if (!isMasterDataReaderRole(appRole)) {
      res.status(403).json({
        error: 'Acceso denegado: perfil sin permisos para consultar Data Maestra.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    const isSuperAdmin = appRole === 'super_admin' || appRole === 'superadmin';
    const isGlobalActor = isSuperAdmin || effective.sucursal === 'GLOBAL';
    req.authUser = {
      id: data.user.id,
      email: normalizeCanonicalEmail(data.user.email),
      appRole,
      sucursal: effective.sucursal,
      allowedRegions: isGlobalActor ? null : (effective.allowedRegions ?? null),
      activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
        req,
        isGlobalActor,
        effective.sucursal,
        effective.allowedRegions
      ),
      isSuperAdmin,
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

export interface RateLimitStore {
  /** Registra un intento y devuelve si sigue dentro del límite. Puede lanzar si el almacén falla. */
  hit(key: string, windowMs: number, maxRequests: number): Promise<{ allowed: boolean }>;
}

/** Almacén en memoria (respaldo local / pruebas). No es compartido entre instancias. */
export function createMemoryRateLimitStore(): RateLimitStore {
  const hits = new Map<string, number[]>();
  return {
    async hit(key, windowMs, maxRequests) {
      const now = Date.now();
      const windowStart = now - windowMs;
      const recent = (hits.get(key) || []).filter((ts) => ts > windowStart);
      if (recent.length >= maxRequests) {
        hits.set(key, recent);
        return { allowed: false };
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
      return { allowed: true };
    },
  };
}

/**
 * Almacén distribuido: contadores de ventana fija en PostgreSQL vía `public.rpc_rate_limit_hit`
 * (solo `service_role`). Compartido por todas las instancias del servidor.
 */
export function createPostgresRateLimitStore(): RateLimitStore | null {
  const admin = getAdminSupabaseClient();
  if (!admin) return null;
  return {
    async hit(key, windowMs, maxRequests) {
      const windowSeconds = Math.max(1, Math.min(3600, Math.ceil(windowMs / 1000)));
      const { data, error } = await admin.rpc('rpc_rate_limit_hit', {
        p_key: key.slice(0, 300),
        p_window_seconds: windowSeconds,
        p_max_requests: Math.max(1, Math.min(100000, maxRequests)),
      });
      if (error || !data) {
        throw new Error(error?.message || 'rate limit store unavailable');
      }
      return { allowed: (data as { allowed?: boolean }).allowed !== false };
    },
  };
}

/**
 * Limitador de tasa para endpoints sensibles. Usa PostgreSQL cuando el servidor tiene credenciales
 * de servicio (varias instancias comparten contadores) y degrada a memoria si el almacén falla.
 */
export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  /** Prefijo de espacio de nombres del bucket (evita colisiones entre limitadores). */
  name?: string;
  /** Almacén inyectable (pruebas). Por defecto: PostgreSQL con respaldo en memoria. */
  store?: RateLimitStore;
}) {
  const fallback = createMemoryRateLimitStore();
  let primary: RateLimitStore | null | undefined = options.store;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${options.name || 'rl'}:${req.authUser?.id || req.ip || 'anon'}:${req.path}`;

    void (async () => {
      if (primary === undefined) primary = createPostgresRateLimitStore();
      let allowed = true;
      try {
        const result = primary
          ? await primary.hit(key, options.windowMs, options.maxRequests)
          : await fallback.hit(key, options.windowMs, options.maxRequests);
        allowed = result.allowed;
      } catch {
        const result = await fallback.hit(key, options.windowMs, options.maxRequests);
        allowed = result.allowed;
      }

      if (!allowed) {
        res.status(429).json({
          error: 'Demasiadas solicitudes en poco tiempo. Espere unos segundos e intente de nuevo.',
          code: 'RATE_LIMIT_EXCEEDED',
        });
        return;
      }
      next();
    })().catch(next);
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
      appMeta.sucursal ?? appMeta.region,
      data.user.email,
      appMeta.regions
    );
    const appRole = effective.role;

    if (!effective.isActive || !ALLOWED_COORDINATOR_ROLES.has(appRole)) {
      res.status(403).json({
        error: 'Acceso denegado: este recurso requiere perfil Coordinadora o Admin.',
        code: 'FORBIDDEN_ROLE',
      });
      return;
    }

    const isSuperAdmin = appRole === 'super_admin' || appRole === 'superadmin';
    const resolvedSucursal = isSuperAdmin ? 'GLOBAL' : effective.sucursal;
    req.authUser = {
      id: data.user.id,
      email: normalizeCanonicalEmail(data.user.email),
      appRole,
      sucursal: resolvedSucursal,
      allowedRegions: isSuperAdmin || resolvedSucursal === 'GLOBAL' ? null : (effective.allowedRegions ?? null),
      activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
        req,
        isSuperAdmin || resolvedSucursal === 'GLOBAL',
        resolvedSucursal,
        effective.allowedRegions
      ),
      isSuperAdmin,
      isCoordinatorOrAdmin: true,
      isReadOnlyViewer: false,
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
    const canonicalEmail = normalizeCanonicalEmail(data.user.email);
    const effective = await resolveEffectiveServerAppRole(
      data.user.id,
      token,
      jwtAppRole,
      appMeta.sucursal ?? appMeta.region,
      data.user.email,
      appMeta.regions
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
      const isSuperAdmin = appRole === 'super_admin' || appRole === 'superadmin';
      const resolvedSucursal = isSuperAdmin ? 'GLOBAL' : effective.sucursal;
      req.authUser = {
        id: data.user.id,
        email: canonicalEmail,
        appRole,
        sucursal: resolvedSucursal,
        allowedRegions: isSuperAdmin || resolvedSucursal === 'GLOBAL' ? null : (effective.allowedRegions ?? null),
        activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
          req,
          isSuperAdmin || resolvedSucursal === 'GLOBAL',
          resolvedSucursal,
          effective.allowedRegions
        ),
        staffId:
          typeof appMeta.staff_id === 'string' && UUID_REGEX.test(appMeta.staff_id)
            ? appMeta.staff_id
            : null,
        isSuperAdmin,
        isCoordinatorOrAdmin: true,
        isReadOnlyViewer: false,
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
        email: canonicalEmail,
        appRole,
        sucursal: effective.sucursal,
        activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
          req,
          effective.sucursal === 'GLOBAL',
          effective.sucursal
        ),
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
        : effective.staffId && UUID_REGEX.test(effective.staffId)
          ? effective.staffId
          : null;

    let staffRecord: Record<string, unknown> | null =
      linkedStaff && typeof linkedStaff === 'object'
        ? (linkedStaff as Record<string, unknown>)
        : null;
    if (!staffRecord && candidateClaimId) {
      const { data: claimStaff } = await lookupClient
        .from('staff')
        .select('id, role, status, auth_user_id, sucursal')
        .eq('id', candidateClaimId)
        .maybeSingle();
      if (claimStaff && (!claimStaff.auth_user_id || claimStaff.auth_user_id === data.user.id)) {
        staffRecord = claimStaff as Record<string, unknown>;
      }
    }

    if (!staffRecord && canonicalEmail && STRICT_EMAIL_REGEX.test(canonicalEmail)) {
      try {
        const { data: emailRows } = await lookupClient
          .from('staff')
          .select('*')
          .ilike('email', `%${canonicalEmail}%`)
          .limit(10);
        const list = Array.isArray(emailRows)
          ? (emailRows as Record<string, unknown>[])
          : emailRows && typeof emailRows === 'object'
            ? [emailRows as Record<string, unknown>]
            : [];
        const matched = list.find((r) => normalizeCanonicalEmail(r.email) === canonicalEmail);
        if (matched && (!matched.auth_user_id || matched.auth_user_id === data.user.id)) {
          staffRecord = matched;
        }
      } catch {
        // Respaldo opcional por correo canónico
      }
    }

    if (staffRecord && UUID_REGEX.test(String(staffRecord.id || ''))) {
      const rowSuc = normalizeOperativeServerSucursal(extractSucursalCandidateFromRecord(staffRecord));
      if (rowSuc) {
        resolvedStaffSucursal = resolvedStaffSucursal ?? rowSuc;
      }
      let memberStatus = 'Activo';
      let category = '';
      if (typeof staffRecord.status === 'string' && staffRecord.status.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(staffRecord.status) as Record<string, unknown>;
          memberStatus = String(parsed.status || 'Activo').trim();
          category = String(parsed.category || '').trim().toLowerCase();
          if (!resolvedStaffSucursal) {
            resolvedStaffSucursal =
              normalizeOperativeServerSucursal(parsed.address) ??
              normalizeOperativeServerSucursal(parsed.assignedLocation);
          }
        } catch {
          // Conservar valores por defecto seguros
        }
      } else if (typeof staffRecord.status === 'string') {
        memberStatus = staffRecord.status.trim();
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
      email: canonicalEmail,
      appRole: 'promotora',
      sucursal: resolvedStaffSucursal,
      activeSucursalHeader: resolveSafeActiveSucursalHeaderForActor(
        req,
        false,
        resolvedStaffSucursal
      ),
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

    const rawHeaderSucursal = extractRawActiveSucursalHeader(req);
    const headerSucursal = rawHeaderSucursal ? normalizeServerSucursal(rawHeaderSucursal) : null;
    if (rawHeaderSucursal && !headerSucursal) {
      res.status(400).json({
        error:
          'Cabecera x-sucursal-activa inválida. Hubs permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
        code: 'INVALID_BRANCH',
      });
      return;
    }

    const rawBodySucursal =
      body.sucursal !== undefined && body.sucursal !== null ? String(body.sucursal).trim() : '';
    const requestedSucursal = rawBodySucursal ? normalizeServerSucursal(rawBodySucursal) : null;
    if (rawBodySucursal && !requestedSucursal) {
      res.status(400).json({
        error:
          'Sucursal inválida. Hubs operativos permitidos: ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
        code: 'INVALID_BRANCH',
      });
      return;
    }

    const callerRegionalSucursal = isOperativeServerSucursal(req.authUser?.sucursal)
      ? req.authUser.sucursal
      : null;
    const existingStaffSucursal = normalizeServerSucursal(
      (staffRow as { sucursal?: unknown }).sucursal
    );

    if (callerRegionalSucursal && headerSucursal && headerSucursal !== callerRegionalSucursal) {
      res.status(403).json({
        error: `Cruce de sede bloqueado: tu perfil pertenece a ${callerRegionalSucursal} y no puede operar bajo ${headerSucursal}.`,
        code: 'FORBIDDEN_BRANCH',
      });
      return;
    }

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

    let effectiveSucursal: ServerSucursalCodigo;
    if (effectiveProfileRole === 'super_admin') {
      effectiveSucursal = 'GLOBAL';
    } else if (callerRegionalSucursal) {
      effectiveSucursal = callerRegionalSucursal;
    } else {
      if (requestedSucursal === 'GLOBAL' || headerSucursal === 'GLOBAL') {
        res.status(400).json({
          error:
            'Un perfil GLOBAL debe seleccionar explícitamente un hub operativo (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) para aprovisionar personal regional.',
          code: 'BRANCH_REQUIRED',
        });
        return;
      }
      if (
        headerSucursal &&
        isOperativeServerSucursal(headerSucursal) &&
        existingStaffSucursal &&
        isOperativeServerSucursal(existingStaffSucursal) &&
        headerSucursal !== existingStaffSucursal
      ) {
        res.status(403).json({
          error: `Cruce de sede bloqueado: el contexto activo (${headerSucursal}) no coincide con la sucursal del personal (${existingStaffSucursal}).`,
          code: 'FORBIDDEN_BRANCH',
        });
        return;
      }
      const resolvedRegional =
        (requestedSucursal && isOperativeServerSucursal(requestedSucursal)
          ? requestedSucursal
          : null) ??
        (headerSucursal && isOperativeServerSucursal(headerSucursal) ? headerSucursal : null) ??
        (existingStaffSucursal && isOperativeServerSucursal(existingStaffSucursal)
          ? existingStaffSucursal
          : null);
      if (!resolvedRegional) {
        res.status(400).json({
          error:
            'Se requiere indicar el hub operativo (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL) en sucursal o x-sucursal-activa.',
          code: 'BRANCH_REQUIRED',
        });
        return;
      }
      effectiveSucursal = resolvedRegional;
    }

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

    const canonicalEmail = normalizeCanonicalEmail(data.user.email);
    const { data: profileById, error: profileErr } = await lookup
      .from('profiles')
      .select('role, is_active, email')
      .eq('id', data.user.id)
      .maybeSingle();

    let profile: { role?: unknown; is_active?: unknown; email?: unknown } | null =
      profileById ?? null;

    if (!profileErr && !profile && canonicalEmail && STRICT_EMAIL_REGEX.test(canonicalEmail)) {
      try {
        const { data: emailRows, error: emailErr } = await lookup
          .from('profiles')
          .select('role, is_active, email')
          .ilike('email', `%${canonicalEmail}%`)
          .limit(10);
        if (!emailErr) {
          const list = Array.isArray(emailRows)
            ? (emailRows as Record<string, unknown>[])
            : emailRows && typeof emailRows === 'object'
              ? [emailRows as Record<string, unknown>]
              : [];
          const matched = list.find((r) => normalizeCanonicalEmail(r.email) === canonicalEmail);
          if (matched) {
            profile = matched;
          }
        }
      } catch {
        // Fallback opcional por correo canónico
      }
    }

    const appMetadata = (data.user.app_metadata ?? {}) as Record<string, unknown>;
    const authorizedSuperAdmin =
      !profileErr &&
      isVerifiedServerSuperAdmin({
        canonicalEmail,
        profile,
        appMetadata,
      });

    if (!authorizedSuperAdmin) {
      res.status(403).json({
        error: 'Acceso denegado: esta acción es exclusiva del Administrador General activo.',
        code: 'SUPER_ADMIN_REQUIRED',
      });
      return;
    }

    req.authUser = {
      id: data.user.id,
      email: canonicalEmail,
      appRole: 'super_admin',
      sucursal: 'GLOBAL',
      activeSucursalHeader: normalizeOperativeServerSucursal(extractRawActiveSucursalHeader(req)),
      isSuperAdmin: true,
      isCoordinatorOrAdmin: true,
      isReadOnlyViewer: false,
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
          error:
            'Sucursal inválida. Valores permitidos para contraloria: GLOBAL, ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL.',
          code: 'INVALID_SUCURSAL_FOR_ROLE',
        });
        return;
      }
    }
  } else {
    const candidate = normalizeServerSucursal(rawSucursal);
    if (!isOperativeServerSucursal(candidate)) {
      res.status(400).json({
        error: `El rol ${role} requiere asignar explícitamente un hub operativo (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL; GLOBAL está reservado para roles nacionales).`,
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
