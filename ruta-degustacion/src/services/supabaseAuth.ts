import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { AppMode, RutaAppRole, RutaAuthUser, SucursalCodigo } from '../types';
import { clearAuthToken, saveAuthToken } from '../lib/syncCore';

export const UNIFIED_SUPABASE_STORAGE_KEY = 'codizulca.supabase.auth.v1';
export const RUTA_PROFILE_CACHE_KEY = 'codizulca.ruta.profile.v1';
const REQUEST_TIMEOUT_MS = 20_000;

export interface RutaSupabaseConfig {
  url: string;
  publicKey: string;
}

export type RutaAuthVerificationResult =
  | { ok: true; user: RutaAuthUser; accessToken: string }
  | {
      ok: false;
      code:
        | 'UNCONFIGURED'
        | 'NO_SESSION'
        | 'PROFILE_NOT_FOUND'
        | 'ACCOUNT_SUSPENDED'
        | 'FORBIDDEN_ROLE'
        | 'INVALID_BRANCH'
        | 'NETWORK_ERROR';
      error: string;
    };

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLen);
    const decoded =
      typeof atob === 'function'
        ? atob(padded)
        : Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Normaliza la URL raíz del proyecto Supabase removiendo `/rest/v1` y barras finales.
 */
export function normalizarSupabaseUrl(rawUrl: string): string {
  const clean = String(rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1\/?$/i, '');

  if (!clean) {
    throw new Error('VITE_SUPABASE_URL está vacía.');
  }

  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    throw new Error('VITE_SUPABASE_URL no es una URL válida.');
  }

  const isLocal =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new Error('VITE_SUPABASE_URL debe usar protocolo https://.');
  }

  return parsed.origin;
}

/**
 * Guardia activa en tiempo de ejecución: bloquea llaves secretas (`sb_secret_*` o JWT `service_role`)
 * antes de invocar `createClient()`.
 */
export function assertPublicSupabaseKey(rawKey: string): string {
  const key = String(rawKey || '').trim();
  if (!key) {
    throw new Error('Falta la llave pública de Supabase (VITE_SUPABASE_PUBLISHABLE_KEY o VITE_SUPABASE_ANON_KEY).');
  }
  if (/^sb_secret_/i.test(key)) {
    throw new Error(
      'VIOLACIÓN DE SEGURIDAD: se detectó una llave secreta (sb_secret_*) en el cliente de RutaDegustación.',
    );
  }
  if (key.startsWith('eyJ')) {
    const parts = key.split('.');
    if (parts.length === 3 && parts[1]) {
      const payload = decodeBase64UrlJson(parts[1]);
      if (String(payload?.role || '').toLowerCase() === 'service_role') {
        throw new Error(
          'VIOLACIÓN DE SEGURIDAD: se detectó un JWT service_role en el cliente de RutaDegustación.',
        );
      }
    }
  }
  return key;
}

/**
 * Resuelve la configuración pública de Supabase para RutaDegustación.
 * Prioriza `VITE_SUPABASE_PUBLISHABLE_KEY` con respaldo en `VITE_SUPABASE_ANON_KEY`.
 */
export function resolveRutaSupabaseConfig(
  envOverride?: Record<string, string | undefined>,
): { config: RutaSupabaseConfig | null; configError: string | null } {
  const env =
    envOverride ??
    ((typeof import.meta !== 'undefined'
      ? (import.meta as { env?: Record<string, string | undefined> }).env
      : undefined) ?? {});

  const rawUrl = String(env.VITE_SUPABASE_URL || '').trim();
  const rawKey = String(env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '').trim();

  if (!rawUrl || !rawKey) {
    return { config: null, configError: null };
  }

  try {
    const url = normalizarSupabaseUrl(rawUrl);
    const publicKey = assertPublicSupabaseKey(rawKey);
    return { config: { url, publicKey }, configError: null };
  } catch (err) {
    return {
      config: null,
      configError: err instanceof Error ? err.message : 'Configuración de Supabase inválida.',
    };
  }
}

// =============================================================================
// REGLAS PURAS DE RBAC PARA RUTADEGUSTACIÓN (S-06 / D6 / D7)
// =============================================================================

export function normalizeRutaRole(raw: unknown): RutaAppRole | null {
  const role = String(raw || '').trim().toLowerCase();
  if (role === 'super_admin' || role === 'superadmin' || role === 'admin' || role === 'gerente_admin') {
    return 'super_admin';
  }
  if (
    role === 'coordinacion' ||
    role === 'coordinadora' ||
    role === 'coordinadora_trade' ||
    role === 'jefe_trade' ||
    role === 'supervisor'
  ) {
    return 'coordinacion';
  }
  if (role === 'chofer') {
    return 'chofer';
  }
  return null;
}

function normalizeRutaTerritory(raw: unknown): SucursalCodigo | null {
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
    tokensText === 'global nacional'
  ) {
    return 'GLOBAL';
  }

  const strippedPrefix = tokensText.replace(
    /^(sucursal|sede|region|hub|estado|zona|oficina)\s+/,
    ''
  );
  if (strippedPrefix === 'zulia') return 'ZULIA';
  if (strippedPrefix === 'valencia') return 'VALENCIA';
  if (strippedPrefix === 'centro') return 'CENTRO';
  if (strippedPrefix === 'oriente') return 'ORIENTE';
  if (strippedPrefix === 'capital') return 'CAPITAL';

  if (
    /\b(zulia|maracaibo|san francisco|cabimas|ciudad ojeda|lagunillas|machiques|costa oriental|mara|guajira)\b/.test(
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

export function normalizeRutaSucursal(raw: unknown, role: RutaAppRole): SucursalCodigo | null {
  const rawStr = String(raw ?? '').trim();
  const normalized = normalizeRutaTerritory(rawStr);
  if (role === 'super_admin') {
    if (!rawStr || normalized === 'GLOBAL') {
      return 'GLOBAL';
    }
    if (normalized) return normalized;
    return 'GLOBAL';
  }
  if (!normalized || normalized === 'GLOBAL') return null;
  return normalized;
}

export function canAccessOficinaMode(role: RutaAppRole): boolean {
  return role === 'super_admin' || role === 'coordinacion';
}

export function isRutaSuperAdmin(user: Pick<RutaAuthUser, 'role'> | null | undefined): boolean {
  return Boolean(user && user.role === 'super_admin');
}

export function canAccessChoferMode(role: RutaAppRole): boolean {
  return role === 'super_admin' || role === 'coordinacion' || role === 'chofer';
}

export function resolveAllowedModes(role: RutaAppRole): AppMode[] {
  return canAccessOficinaMode(role) ? ['chofer', 'oficina'] : ['chofer'];
}

export function resolveEffectiveMode(requested: AppMode, role: RutaAppRole): AppMode {
  if (requested === 'oficina' && !canAccessOficinaMode(role)) {
    return 'chofer';
  }
  return requested;
}

export function formatRutaRoleLabel(role: RutaAppRole): string {
  if (role === 'super_admin') return 'Super Admin';
  if (role === 'coordinacion') return 'Coordinación Trade';
  return 'Chofer Logística';
}

export function formatSucursalLabel(sucursal: SucursalCodigo): string {
  if (sucursal === 'GLOBAL') return 'Nacional (Global)';
  if (sucursal === 'VALENCIA') return 'Sede Valencia';
  if (sucursal === 'CENTRO') return 'Sede Centro';
  if (sucursal === 'ORIENTE') return 'Sede Oriente';
  if (sucursal === 'CAPITAL') return 'Sede Capital';
  return 'Sede Zulia';
}

// =============================================================================
// CLIENTE SUPABASE ÚNICO CON SESIÓN PERSISTENTE
// =============================================================================

let cachedClient: SupabaseClient | null = null;
let cachedClientKey = '';

export function createRutaSupabaseClient(cfg: RutaSupabaseConfig): SupabaseClient {
  const safeUrl = normalizarSupabaseUrl(cfg.url);
  const safeKey = assertPublicSupabaseKey(cfg.publicKey);
  return createClient(safeUrl, safeKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: UNIFIED_SUPABASE_STORAGE_KEY,
    },
    global: {
      fetch: (input, init) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        return fetch(input, { ...init, signal: init?.signal ?? controller.signal }).finally(() =>
          clearTimeout(timer),
        );
      },
    },
  });
}

export function getRutaSupabaseClient(): SupabaseClient | null {
  const { config } = resolveRutaSupabaseConfig();
  if (!config) return null;
  const key = `${config.url}::${config.publicKey}`;
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = createRutaSupabaseClient(config);
    cachedClientKey = key;
  }
  return cachedClient;
}

function readCachedProfile(expectedUserId: string): RutaAuthUser | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(RUTA_PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RutaAuthUser>;
    if (parsed.id !== expectedUserId) return null;
    const role = normalizeRutaRole(parsed.role);
    if (!role) return null;
    const sucursal = normalizeRutaSucursal(parsed.sucursal, role);
    if (!sucursal) return null;
    return {
      id: parsed.id,
      email: String(parsed.email || ''),
      fullName: String(parsed.fullName || parsed.email || 'Usuario'),
      role,
      sucursal,
    };
  } catch {
    return null;
  }
}

function writeCachedProfile(user: RutaAuthUser | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (!user) localStorage.removeItem(RUTA_PROFILE_CACHE_KEY);
    else localStorage.setItem(RUTA_PROFILE_CACHE_KEY, JSON.stringify(user));
  } catch {
    /* Almacenamiento restringido */
  }
}

async function syncTokenToOutbox(token: string | null): Promise<void> {
  try {
    if (token) await saveAuthToken(token);
    else await clearAuthToken();
  } catch {
    /* IndexedDB no disponible en modo privado */
  }
}

/**
 * Valida la sesión activa contra `public.profiles` (fuente única de verdad del Hito 1).
 * Si el rol no corresponde a logística (`super_admin`, `coordinacion`, `chofer`) o la cuenta está suspendida,
 * revoca la sesión inmediatamente (`signOut`).
 */
export async function verifyRutaProfileAccess(
  client: SupabaseClient,
  session: Session | null,
): Promise<RutaAuthVerificationResult> {
  if (!session?.user?.id || !session.access_token) {
    writeCachedProfile(null);
    await syncTokenToOutbox(null);
    return { ok: false, code: 'NO_SESSION', error: 'Inicie sesión para continuar.' };
  }

  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const canonicalSessionEmail = String(session.user.email || '')
    .trim()
    .toLowerCase();

  let { data: profile, error } = await client
    .from('profiles')
    .select('id, email, full_name, role, sucursal, is_active')
    .eq('id', session.user.id)
    .maybeSingle();

  if (!error && !profile && canonicalSessionEmail) {
    try {
      const baseSelect = client
        .from('profiles')
        .select('id, email, full_name, role, sucursal, is_active');
      if (typeof (baseSelect as { ilike?: unknown }).ilike === 'function') {
        const { data: emailRows, error: emailErr } = await baseSelect
          .ilike('email', `%${canonicalSessionEmail}%`)
          .limit(10);
        if (!emailErr && Array.isArray(emailRows)) {
          const matched = emailRows.find(
            (r) => String(r.email || '').trim().toLowerCase() === canonicalSessionEmail
          );
          if (matched) profile = matched;
        }
      }
    } catch {
      /* Fallback opcional cuando el cliente soporta ilike */
    }
  }

  if (error) {
    // Modo offline real para choferes en ruta con sesión válida ya verificada previamente
    if (isOffline) {
      const cached = readCachedProfile(session.user.id);
      if (cached) {
        await syncTokenToOutbox(session.access_token);
        return { ok: true, user: cached, accessToken: session.access_token };
      }
    }
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      error: 'No se pudo verificar el perfil corporativo contra el servidor. Revise su conexión e intente de nuevo.',
    };
  }

  if (!profile) {
    // Respaldo verificado exclusivamente sobre app_metadata firmado en servidor (jamás user_metadata)
    // para la cuenta maestra `admin@codizulca.com`.
    const appMeta = (session.user.app_metadata ?? {}) as Record<string, unknown>;
    const appMetaRole = normalizeRutaRole(appMeta.role ?? appMeta.app_role);
    if (canonicalSessionEmail === 'admin@codizulca.com' && appMetaRole === 'super_admin') {
      const superAdminUser: RutaAuthUser = {
        id: session.user.id,
        email: canonicalSessionEmail,
        fullName:
          String(appMeta.display_name || '').trim() || 'Administrador General CODIZULCA',
        role: 'super_admin',
        sucursal: 'GLOBAL',
      };
      writeCachedProfile(superAdminUser);
      await syncTokenToOutbox(session.access_token);
      client.realtime.setAuth(session.access_token);
      return { ok: true, user: superAdminUser, accessToken: session.access_token };
    }

    writeCachedProfile(null);
    await syncTokenToOutbox(null);
    await client.auth.signOut().catch(() => {});
    return {
      ok: false,
      code: 'PROFILE_NOT_FOUND',
      error: 'Su cuenta no cuenta con un perfil corporativo activo en public.profiles. Contacte a Super Admin.',
    };
  }

  if (profile.is_active === false) {
    writeCachedProfile(null);
    await syncTokenToOutbox(null);
    await client.auth.signOut().catch(() => {});
    return {
      ok: false,
      code: 'ACCOUNT_SUSPENDED',
      error: 'Su acceso corporativo se encuentra suspendido. Contacte a Administración.',
    };
  }

  const normalizedRole = normalizeRutaRole(profile.role);
  if (!normalizedRole) {
    writeCachedProfile(null);
    await syncTokenToOutbox(null);
    await client.auth.signOut().catch(() => {});
    return {
      ok: false,
      code: 'FORBIDDEN_ROLE',
      error:
        'Acceso denegado: RutaDegustación está restringido a personal autorizado (Chofer, Coordinación Trade o Super Admin).',
    };
  }

  const normalizedSucursal = normalizeRutaSucursal(profile.sucursal, normalizedRole);
  if (!normalizedSucursal) {
    writeCachedProfile(null);
    await syncTokenToOutbox(null);
    await client.auth.signOut().catch(() => {});
    return {
      ok: false,
      code: 'INVALID_BRANCH',
      error:
        'Su perfil no posee una sucursal operativa válida (ZULIA, VALENCIA, CENTRO, ORIENTE o CAPITAL). Contacte a Super Admin.',
    };
  }

  const authUser: RutaAuthUser = {
    id: session.user.id,
    email: String(profile.email || session.user.email || '').trim().toLowerCase(),
    fullName: String(profile.full_name || session.user.email || 'Usuario').trim(),
    role: normalizedRole,
    sucursal: normalizedSucursal,
  };

  writeCachedProfile(authUser);
  await syncTokenToOutbox(session.access_token);
  client.realtime.setAuth(session.access_token);

  return { ok: true, user: authUser, accessToken: session.access_token };
}

export async function restoreRutaSession(): Promise<RutaAuthVerificationResult> {
  const { config, configError } = resolveRutaSupabaseConfig();
  if (configError || !config) {
    return {
      ok: false,
      code: 'UNCONFIGURED',
      error:
        configError ??
        'Falta configurar VITE_SUPABASE_URL y la llave pública (VITE_SUPABASE_PUBLISHABLE_KEY o VITE_SUPABASE_ANON_KEY).',
    };
  }
  const client = getRutaSupabaseClient();
  if (!client) {
    return { ok: false, code: 'UNCONFIGURED', error: 'Cliente Supabase no inicializado.' };
  }

  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    writeCachedProfile(null);
    await syncTokenToOutbox(null);
    return { ok: false, code: 'NO_SESSION', error: 'Inicie sesión para continuar.' };
  }

  return verifyRutaProfileAccess(client, data.session);
}

export async function signInRutaUser(
  email: string,
  password: string,
): Promise<RutaAuthVerificationResult> {
  const client = getRutaSupabaseClient();
  if (!client) {
    return {
      ok: false,
      code: 'UNCONFIGURED',
      error: 'No se pudo conectar: faltan credenciales públicas de Supabase.',
    };
  }

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) {
    return {
      ok: false,
      code: 'NO_SESSION',
      error: 'Ingrese su correo corporativo y contraseña.',
    };
  }

  const { data, error } = await client.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });

  if (error || !data.session) {
    return {
      ok: false,
      code: 'NO_SESSION',
      error: 'Credenciales inválidas o cuenta sin acceso autorizado.',
    };
  }

  return verifyRutaProfileAccess(client, data.session);
}

export async function refreshRutaSession(): Promise<RutaAuthVerificationResult> {
  const client = getRutaSupabaseClient();
  if (!client) {
    return { ok: false, code: 'UNCONFIGURED', error: 'Cliente Supabase no inicializado.' };
  }
  const { data, error } = await client.auth.refreshSession();
  if (error || !data.session) {
    return restoreRutaSession();
  }
  return verifyRutaProfileAccess(client, data.session);
}

export async function signOutRutaUser(): Promise<void> {
  writeCachedProfile(null);
  await syncTokenToOutbox(null);
  const client = getRutaSupabaseClient();
  if (client) {
    await client.auth.signOut().catch(() => {});
  }
}

export function subscribeRutaAuthEvents(handlers: {
  onTokenRefreshed?: (token: string) => void;
  onSignedOut?: () => void;
}): () => void {
  const client = getRutaSupabaseClient();
  if (!client) return () => {};
  const { data } = client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session?.access_token) {
      writeCachedProfile(null);
      void syncTokenToOutbox(null);
      handlers.onSignedOut?.();
      return;
    }
    if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
      void syncTokenToOutbox(session.access_token);
      client.realtime.setAuth(session.access_token);
      handlers.onTokenRefreshed?.(session.access_token);
    }
  });
  return () => {
    data.subscription.unsubscribe();
  };
}
