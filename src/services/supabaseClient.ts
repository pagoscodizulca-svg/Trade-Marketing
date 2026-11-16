import { createClient, Session, SupabaseClient } from '@supabase/supabase-js';
import type { MasterDataDatabase } from '../types/masterData';

/**
 * Única fuente de configuración pública: variables de entorno (.env.local / entorno de despliegue).
 * SEGURIDAD ZERO TRUST:
 *  - Solo se leen la URL pública del proyecto y la clave pública anon/publishable.
 *  - Prohibido usar llaves secretas (sb_secret_* o service_role) en código cliente.
 *  - Prohibido inyectar cabeceras personalizadas falsificables (x-promotora-id / x-codizulca-scope).
 *  - Toda autorización de fila y canal Realtime descansa en el JWT firmado de Supabase Auth.
 */
function readEnvString(key: string): string {
  const viteVal = (import.meta.env?.[key] as string | undefined)?.trim() || '';
  if (viteVal) return viteVal;
  if (typeof process !== 'undefined' && process.env && typeof process.env[key] === 'string') {
    return process.env[key]!.trim();
  }
  return '';
}

function normalizeProjectBaseUrl(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
}

/**
 * Candado de ciberseguridad en tiempo de ejecución:
 * Impide inicializar cualquier cliente accesible al navegador si por error se colocó
 * una llave administrativa (`sb_secret_*` o JWT `service_role`) en variables `VITE_*`.
 */
export function assertPublicKeyIsNotSecret(key: string, envName = 'VITE_SUPABASE_ANON_KEY'): void {
  const trimmed = String(key || '').trim();
  if (!trimmed) return;

  if (trimmed.startsWith('sb_secret_')) {
    throw new Error(
      `SEGURIDAD CRÍTICA: ${envName} contiene una llave secreta (sb_secret_*). Use únicamente la Publishable/Anon Key pública.`
    );
  }

  if (trimmed.startsWith('eyJ')) {
    const parts = trimmed.split('.');
    if (parts.length === 3 && parts[1]) {
      try {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const json =
          typeof atob === 'function'
            ? atob(base64)
            : Buffer.from(base64, 'base64').toString('utf8');
        const payload = JSON.parse(json) as { role?: string };
        if (payload.role === 'service_role') {
          throw new Error(
            `SEGURIDAD CRÍTICA: ${envName} contiene un token service_role. Use únicamente la llave pública anon/publishable.`
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('SEGURIDAD CRÍTICA:')) {
          throw err;
        }
      }
    }
  }
}

const rawEnvUrl = readEnvString('VITE_SUPABASE_URL');
export const SUPABASE_PROJECT_URL = normalizeProjectBaseUrl(rawEnvUrl);
export const SUPABASE_REST_URL = SUPABASE_PROJECT_URL ? `${SUPABASE_PROJECT_URL}/rest/v1` : '';
export const SUPABASE_ANON_KEY = readEnvString('VITE_SUPABASE_ANON_KEY');

const rawMasterEnvUrl = readEnvString('VITE_SUPABASE_MASTER_URL');
const rawMasterAnonKey = readEnvString('VITE_SUPABASE_MASTER_ANON_KEY');
export const SUPABASE_MASTER_PROJECT_URL =
  normalizeProjectBaseUrl(rawMasterEnvUrl) || SUPABASE_PROJECT_URL;
export const SUPABASE_MASTER_ANON_KEY = rawMasterAnonKey || SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(SUPABASE_PROJECT_URL && SUPABASE_ANON_KEY);
export const isMasterDataSupabaseConfigured = Boolean(
  SUPABASE_MASTER_PROJECT_URL && SUPABASE_MASTER_ANON_KEY
);

export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  'Sin conexión configurada: defina VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.';

export function assertSupabaseConfigured(): void {
  if (!isSupabaseConfigured) {
    throw new Error(SUPABASE_NOT_CONFIGURED_MESSAGE);
  }
  assertPublicKeyIsNotSecret(SUPABASE_ANON_KEY, 'VITE_SUPABASE_ANON_KEY');
}

export function assertMasterDataSupabaseConfigured(): void {
  if (!isMasterDataSupabaseConfigured) {
    throw new Error(SUPABASE_NOT_CONFIGURED_MESSAGE);
  }
  assertPublicKeyIsNotSecret(
    SUPABASE_MASTER_ANON_KEY,
    rawMasterAnonKey ? 'VITE_SUPABASE_MASTER_ANON_KEY' : 'VITE_SUPABASE_ANON_KEY'
  );
}

let unifiedClient: SupabaseClient | null = null;
let dedicatedMasterClient: SupabaseClient<MasterDataDatabase> | null = null;
let cachedAccessToken: string | null = null;
let authListenerBound = false;

function bindAuthTokenSync(client: SupabaseClient): void {
  if (authListenerBound) return;
  authListenerBound = true;

  void client.auth.getSession().then(({ data }) => {
    const token = data.session?.access_token || null;
    cachedAccessToken = token;
    if (token) {
      client.realtime.setAuth(token);
    }
  });

  client.auth.onAuthStateChange((_event, session: Session | null) => {
    const token = session?.access_token || null;
    cachedAccessToken = token;
    client.realtime.setAuth(token ?? SUPABASE_ANON_KEY);
  });
}

/**
 * Devuelve el token JWT de sesión autenticado actual en memoria (o `null` si no hay sesión).
 * Nunca registra ni expone tokens en consola.
 */
export function getCachedAccessToken(): string | null {
  return cachedAccessToken;
}

/**
 * Cliente unificado `@supabase/supabase-js` compartido por Auth, PostgREST y Realtime WebSockets
 * para garantizar que el JWT verificado y su refresco automático protejan todas las capas.
 */
export function getSupabaseClient(): SupabaseClient {
  assertSupabaseConfigured();
  if (!unifiedClient) {
    const isBrowser = typeof window !== 'undefined';
    unifiedClient = createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: isBrowser,
        autoRefreshToken: isBrowser,
        detectSessionInUrl: isBrowser,
        storageKey: 'codizulca.supabase.auth.v1',
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    });
    bindAuthTokenSync(unifiedClient);
  }
  return unifiedClient;
}

/** Alias compatible con módulos existentes para suscripciones Realtime autenticadas. */
export function getSupabaseRealtimeClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  return getSupabaseClient();
}

/**
 * Alias compatible con servicios de Coordinación: opera exclusivamente con el JWT
 * de Supabase Auth del usuario autenticado (cero cabeceras personalizadas falsificables).
 */
export function getSupabaseCoordinatorClient(): SupabaseClient {
  return getSupabaseClient();
}

/**
 * Cliente tipado para la Fuente Única de Verdad (`vendedores`, `clientes`, `lotes_sincronizacion`).
 * - Si `VITE_SUPABASE_MASTER_URL` apunta al mismo proyecto que `VITE_SUPABASE_URL` (o no se definió),
 *   reutiliza el cliente unificado compartiendo automáticamente la sesión JWT y canales Realtime.
 * - Si apunta a un proyecto dedicado de Data Maestra, instancia un cliente aislado con su propio storageKey.
 */
export function getMasterDataSupabaseClient(): SupabaseClient<MasterDataDatabase> {
  assertMasterDataSupabaseConfigured();

  const sharesPrimaryProject =
    SUPABASE_MASTER_PROJECT_URL === SUPABASE_PROJECT_URL &&
    SUPABASE_MASTER_ANON_KEY === SUPABASE_ANON_KEY;

  if (sharesPrimaryProject) {
    return getSupabaseClient() as unknown as SupabaseClient<MasterDataDatabase>;
  }

  if (!dedicatedMasterClient) {
    const isBrowser = typeof window !== 'undefined';
    dedicatedMasterClient = createClient<MasterDataDatabase>(
      SUPABASE_MASTER_PROJECT_URL,
      SUPABASE_MASTER_ANON_KEY,
      {
        auth: {
          persistSession: isBrowser,
          autoRefreshToken: isBrowser,
          detectSessionInUrl: isBrowser,
          storageKey: 'codizulca.supabase.master.auth.v1',
        },
        realtime: {
          params: {
            eventsPerSecond: 10,
          },
        },
      }
    );
  }

  return dedicatedMasterClient;
}
