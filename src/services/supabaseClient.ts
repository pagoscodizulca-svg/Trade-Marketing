import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Única fuente de configuración: variables de entorno (.env.local / entorno de despliegue).
 * No existen URL ni claves de respaldo: si faltan, la app lo informa y no intenta conectarse a ninguna base.
 */
const rawEnvUrl = (import.meta.env?.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/+$/, '') || '';

export const SUPABASE_REST_URL = rawEnvUrl
  ? rawEnvUrl.endsWith('/rest/v1')
    ? rawEnvUrl
    : `${rawEnvUrl}/rest/v1`
  : '';

export const SUPABASE_PROJECT_URL = SUPABASE_REST_URL.replace(/\/rest\/v1\/?$/, '');

export const SUPABASE_ANON_KEY = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';

export const isSupabaseConfigured = Boolean(SUPABASE_REST_URL && SUPABASE_ANON_KEY);

export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  'Sin conexión configurada: defina VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.';

/** Lanza un error claro si no hay credenciales; se invoca antes de cualquier petición. */
export function assertSupabaseConfigured(): void {
  if (!isSupabaseConfigured) {
    throw new Error(SUPABASE_NOT_CONFIGURED_MESSAGE);
  }
}

let singletonClient: SupabaseClient | null = null;
let coordinatorClient: SupabaseClient | null = null;

/** Cliente realtime, o `null` si no hay credenciales configuradas. */
export function getSupabaseRealtimeClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!singletonClient) {
    singletonClient = createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    });
  }
  return singletonClient;
}

/**
 * Cliente oficial parametrizado `@supabase/supabase-js` con alcance `trade_coordinator`
 * para consultas y RPCs seguras hacia `public.cargas_archivos` y `public.cronograma_degustaciones`.
 */
export function getSupabaseCoordinatorClient(): SupabaseClient {
  assertSupabaseConfigured();
  if (!coordinatorClient) {
    coordinatorClient = createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          'x-codizulca-scope': 'trade_coordinator',
        },
      },
    });
  }
  return coordinatorClient;
}
