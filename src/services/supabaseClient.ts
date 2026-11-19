import { createClient, Session, SupabaseClient } from '@supabase/supabase-js';
import type { MasterDataDatabase } from '../types/masterData';
import type { OperativeSucursal } from './userManagementService';

/**
 * Cliente Único, Centralizado y Seguro de Supabase (TypeScript) — Programa de Trade Marketing.
 *
 * SEGURIDAD ZERO TRUST (Hito 1 · N-03):
 *  1. Única instancia y clave de sesión unificada `codizulca.supabase.auth.v1` compartida por
 *     Auth, PostgREST y Realtime WebSockets.
 *  2. `assertCredencialesSeguras()` y `validarClavePublicaNoSecreta()` bloquean llaves secretas
 *     (`sb_secret_*` y JWT `service_role`) ANTES de invocar `createClient()` y sin tráfico de red.
 *  3. Acepta únicamente llaves públicas válidas (`sb_publishable_*` o JWT público `anon`).
 *  4. Prohibido inyectar cabeceras personalizadas falsificables (`x-promotora-id`, `x-codizulca-scope`)
 *     o imprimir llaves/tokens en consola.
 *  5. Toda autorización de datos descansa en políticas RLS sobre `public.profiles` en PostgreSQL.
 */

export const UNIFIED_SUPABASE_STORAGE_KEY = 'codizulca.supabase.auth.v1';
export const DEDICATED_MASTER_STORAGE_KEY = 'codizulca.supabase.master.auth.v1';
export const URL_PROYECTO_REFERENCIA = 'https://apaxdgxtaoeyswlfblgi.supabase.co';
export const PLACEHOLDER_PUBLISHABLE_KEY = 'PEGA_AQUI_TU_SB_PUBLISHABLE_KEY';
export const ARCHIVO_CONFIGURACION_LOCAL = '.env.local';

const REGEX_URL_SUPABASE = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
const REGEX_URL_LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;
const DIAGNOSTIC_TIMEOUT_DEFAULT_MS = 8000;

/** Error de seguridad crítico: credencial administrativa o llave inválida detectada en cliente. */
export class ErrorSeguridadCredenciales extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorSeguridadCredenciales';
  }
}

/** Error de configuración: falta URL o llave pública en la configuración de entorno. */
export class ErrorConfiguracionIncompleta extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorConfiguracionIncompleta';
  }
}

export interface NormalizarUrlOpciones {
  permitirLoopbackPruebas?: boolean;
}

export interface AssertCredencialesOpciones extends NormalizarUrlOpciones {
  silenciarGuia?: boolean;
}

export interface CrearClienteSupabaseOpciones extends NormalizarUrlOpciones {
  url?: string;
  publishableKey?: string;
  anonKey?: string;
  storage?: Storage;
  fetch?: typeof fetch;
}

export interface ResultadoDiagnosticoSupabase {
  ok: boolean;
  urlNormalizada: string | null;
  sesionActiva: boolean;
  mensaje: string;
}

function readEnvString(key: string): string {
  const viteVal = (import.meta.env?.[key] as string | undefined)?.trim() || '';
  if (viteVal) return viteVal;
  if (typeof process !== 'undefined' && process.env && typeof process.env[key] === 'string') {
    return process.env[key]!.trim();
  }
  return '';
}

function stripSupabaseApiSuffixes(rawUrl: string): string {
  let clean = String(rawUrl ?? '').trim();
  let previous = '';
  while (previous !== clean) {
    previous = clean;
    clean = clean
      .replace(/\/+$/, '')
      .replace(/\/(rest|auth|storage|realtime|functions)\/v1$/i, '');
  }
  return clean;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const jsonText =
      typeof globalThis.atob === 'function'
        ? globalThis.atob(base64 + pad)
        : Buffer.from(base64 + pad, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(jsonText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Normaliza la URL raíz del proyecto Supabase:
 *  - Elimina espacios, barras finales y sufijos accidentales (`/rest/v1/`, `/auth/v1/`, etc.).
 *  - Exige protocolo `https://` y dominio `.supabase.co` (salvo `permitirLoopbackPruebas` en suites locales).
 */
export function normalizarSupabaseUrl(
  url: string,
  opciones: NormalizarUrlOpciones = {}
): string {
  const limpia = stripSupabaseApiSuffixes(url);
  if (!limpia) {
    throw new ErrorConfiguracionIncompleta(
      `Falta VITE_SUPABASE_URL. Configure ${ARCHIVO_CONFIGURACION_LOCAL} con ${URL_PROYECTO_REFERENCIA}`
    );
  }

  if (opciones.permitirLoopbackPruebas === true && REGEX_URL_LOOPBACK.test(limpia)) {
    return limpia;
  }

  if (!/^https:\/\//i.test(limpia)) {
    throw new ErrorConfiguracionIncompleta(
      'La URL de Supabase debe usar protocolo seguro https://.'
    );
  }

  if (!REGEX_URL_SUPABASE.test(limpia)) {
    throw new ErrorConfiguracionIncompleta(
      'La URL de Supabase debe ser la raíz del proyecto con dominio .supabase.co (ej. https://<ref>.supabase.co).'
    );
  }

  return limpia.toLowerCase();
}

/**
 * Bloquea llaves secretas (`sb_secret_*` o JWT `service_role`) antes de cualquier uso en cliente.
 */
export function assertPublicKeyIsNotSecret(
  key: string,
  envName = 'VITE_SUPABASE_PUBLISHABLE_KEY'
): void {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) return;

  if (trimmed.startsWith('sb_secret_')) {
    throw new ErrorSeguridadCredenciales(
      `SEGURIDAD CRÍTICA: ${envName} contiene una llave secreta (sb_secret_*). Use únicamente la llave pública sb_publishable_* o anon.`
    );
  }

  if (trimmed.startsWith('eyJ')) {
    const payload = decodeJwtPayload(trimmed);
    const role = typeof payload?.role === 'string' ? payload.role.trim().toLowerCase() : '';
    if (role === 'service_role' || role === 'supabase_admin' || role === 'postgres') {
      throw new ErrorSeguridadCredenciales(
        `SEGURIDAD CRÍTICA: ${envName} contiene un token privilegiado (${role}). Use únicamente la llave pública sb_publishable_* o anon.`
      );
    }
  }
}

/** Alias compatible con suites de validación OWASP/seguridad de credenciales. */
export function validarClavePublicaNoSecreta(clavePublica: string): void {
  assertPublicKeyIsNotSecret(clavePublica, 'VITE_SUPABASE_PUBLISHABLE_KEY');
}

/**
 * Comprueba si una cadena no secreta corresponde a un formato válido de llave pública Supabase:
 *  - Publishable Key moderna: `sb_publishable_<...>` (longitud mínima 20).
 *  - Legacy Anon JWT público: token JWT de 3 segmentos con `role === 'anon'`.
 */
export function esClavePublicaSupabaseValida(clavePublica: string): boolean {
  const limpia = String(clavePublica ?? '').trim();
  if (!limpia || limpia === PLACEHOLDER_PUBLISHABLE_KEY) return false;

  try {
    assertPublicKeyIsNotSecret(limpia);
  } catch {
    return false;
  }

  if (limpia.startsWith('sb_publishable_') && limpia.length >= 20) {
    return true;
  }

  if (limpia.startsWith('eyJ')) {
    const payload = decodeJwtPayload(limpia);
    return payload?.role === 'anon';
  }

  return false;
}

/**
 * Guardia activa ejecutada ANTES de `createClient()`:
 *  1. Bloquea `sb_secret_*` y JWT `service_role` con `ErrorSeguridadCredenciales` (sin tocar red).
 *  2. Detecta llave vacía o marcador sin reemplazar con `ErrorConfiguracionIncompleta`.
 *  3. Exige llave pública válida (`sb_publishable_*` o JWT `anon`).
 *  4. Normaliza y valida la URL del proyecto.
 */
export function assertCredencialesSeguras(
  url: string,
  key: string,
  opciones: AssertCredencialesOpciones = {}
): { urlNormalizada: string; llave: string } {
  const llave = String(key ?? '').trim();

  // 1. Seguridad primero: evaluar llaves secretas incluso si la URL es inválida
  assertPublicKeyIsNotSecret(llave, 'VITE_SUPABASE_PUBLISHABLE_KEY');

  // 2. Llave vacía o placeholder
  if (!llave || llave === PLACEHOLDER_PUBLISHABLE_KEY) {
    if (opciones.silenciarGuia !== true) {
      console.warn(
        `[Supabase] Configuración pendiente: abra ${ARCHIVO_CONFIGURACION_LOCAL} (ignorado por Git) y defina:\n` +
          `  VITE_SUPABASE_URL=${URL_PROYECTO_REFERENCIA}\n` +
          '  VITE_SUPABASE_PUBLISHABLE_KEY=<su llave sb_publishable_...>\n' +
          'Luego reinicie el servidor de desarrollo (npm run dev).'
      );
    }
    throw new ErrorConfiguracionIncompleta(
      `Falta VITE_SUPABASE_PUBLISHABLE_KEY en ${ARCHIVO_CONFIGURACION_LOCAL}.`
    );
  }

  // 3. Aceptar únicamente llaves públicas válidas (sb_publishable_* o JWT anon)
  if (!esClavePublicaSupabaseValida(llave)) {
    throw new ErrorSeguridadCredenciales(
      'SEGURIDAD: La llave configurada no es una llave pública válida de Supabase (se requiere sb_publishable_* o JWT público anon).'
    );
  }

  const urlNormalizada = normalizarSupabaseUrl(url, opciones);
  return { urlNormalizada, llave };
}

export function leerVariablesEntornoPublicas(): { urlCruda: string; llaveCruda: string } {
  const urlCruda = readEnvString('VITE_SUPABASE_URL');
  const primary = readEnvString('VITE_SUPABASE_PUBLISHABLE_KEY');
  const legacy = readEnvString('VITE_SUPABASE_ANON_KEY');

  const candidatas = [primary, legacy].filter(Boolean);
  const llaveCruda =
    candidatas.find((v) => v !== PLACEHOLDER_PUBLISHABLE_KEY) || candidatas[0] || '';

  return { urlCruda, llaveCruda };
}

export function obtenerEstadoConfiguracionSupabase(): {
  configurado: boolean;
  urlNormalizada: string | null;
  motivo: string;
} {
  const { urlCruda, llaveCruda } = leerVariablesEntornoPublicas();
  const isDevOrTestLoopback = REGEX_URL_LOOPBACK.test(stripSupabaseApiSuffixes(urlCruda));
  try {
    const { urlNormalizada } = assertCredencialesSeguras(urlCruda, llaveCruda, {
      silenciarGuia: true,
      permitirLoopbackPruebas: isDevOrTestLoopback,
    });
    return { configurado: true, urlNormalizada, motivo: 'Configuración pública válida.' };
  } catch (err) {
    let urlNormalizada: string | null = null;
    try {
      urlNormalizada = normalizarSupabaseUrl(urlCruda, {
        permitirLoopbackPruebas: isDevOrTestLoopback,
      });
    } catch {
      urlNormalizada = null;
    }
    return {
      configurado: false,
      urlNormalizada,
      motivo: err instanceof Error ? err.message : 'Configuración de Supabase inválida.',
    };
  }
}

function resolveInitialProjectUrl(rawUrl: string): string {
  const stripped = stripSupabaseApiSuffixes(rawUrl);
  if (!stripped) return '';
  if (REGEX_URL_LOOPBACK.test(stripped)) return stripped;
  try {
    return normalizarSupabaseUrl(stripped);
  } catch {
    return '';
  }
}

function readPublicKeyEnv(primaryKey: string, legacyKey: string): string {
  const primary = readEnvString(primaryKey);
  if (primary && primary !== PLACEHOLDER_PUBLISHABLE_KEY) return primary;
  const legacy = readEnvString(legacyKey);
  if (legacy && legacy !== PLACEHOLDER_PUBLISHABLE_KEY) return legacy;
  return '';
}

const rawEnvUrl = readEnvString('VITE_SUPABASE_URL');
export const SUPABASE_PROJECT_URL = resolveInitialProjectUrl(rawEnvUrl);
export const SUPABASE_REST_URL = SUPABASE_PROJECT_URL ? `${SUPABASE_PROJECT_URL}/rest/v1` : '';
export const SUPABASE_ANON_KEY = readPublicKeyEnv(
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_ANON_KEY'
);

const rawMasterEnvUrl = readEnvString('VITE_SUPABASE_MASTER_URL');
const rawMasterAnonKey = readPublicKeyEnv(
  'VITE_SUPABASE_MASTER_PUBLISHABLE_KEY',
  'VITE_SUPABASE_MASTER_ANON_KEY'
);
export const SUPABASE_MASTER_PROJECT_URL =
  resolveInitialProjectUrl(rawMasterEnvUrl) || SUPABASE_PROJECT_URL;
export const SUPABASE_MASTER_ANON_KEY = rawMasterAnonKey || SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(
  SUPABASE_PROJECT_URL && esClavePublicaSupabaseValida(SUPABASE_ANON_KEY)
);
export const isMasterDataSupabaseConfigured = Boolean(
  SUPABASE_MASTER_PROJECT_URL && esClavePublicaSupabaseValida(SUPABASE_MASTER_ANON_KEY)
);

export const SUPABASE_NOT_CONFIGURED_MESSAGE =
  'Sin conexión configurada: defina VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en .env.local.';

export function assertSupabaseConfigured(): void {
  assertPublicKeyIsNotSecret(SUPABASE_ANON_KEY, 'VITE_SUPABASE_PUBLISHABLE_KEY');
  if (!isSupabaseConfigured) {
    throw new ErrorConfiguracionIncompleta(SUPABASE_NOT_CONFIGURED_MESSAGE);
  }
}

export function assertMasterDataSupabaseConfigured(): void {
  assertPublicKeyIsNotSecret(
    SUPABASE_MASTER_ANON_KEY,
    rawMasterAnonKey ? 'VITE_SUPABASE_MASTER_ANON_KEY' : 'VITE_SUPABASE_PUBLISHABLE_KEY'
  );
  if (!isMasterDataSupabaseConfigured) {
    throw new ErrorConfiguracionIncompleta(SUPABASE_NOT_CONFIGURED_MESSAGE);
  }
}

const VALID_ACTIVE_SUCURSAL_HEADERS = new Set<OperativeSucursal>([
  'ZULIA',
  'VALENCIA',
  'CENTRO',
  'ORIENTE',
  'CAPITAL',
]);

let unifiedClient: SupabaseClient | null = null;
let dedicatedMasterClient: SupabaseClient<MasterDataDatabase> | null = null;
let cachedAccessToken: string | null = null;
let activeSucursalHeader: OperativeSucursal | null = null;
let authListenerBound = false;

/**
 * Define o limpia la cabecera activa de sucursal (`x-sucursal-activa`) inyectada en cada
 * petición del cliente Supabase hacia PostgreSQL (`obtener_sucursal_contexto_activo()`).
 */
export function setActiveClientSucursalHeader(sucursal: OperativeSucursal | null): void {
  if (sucursal === null || sucursal === undefined) {
    activeSucursalHeader = null;
    return;
  }
  const normalized = String(sucursal).trim().toUpperCase() as OperativeSucursal;
  activeSucursalHeader = VALID_ACTIVE_SUCURSAL_HEADERS.has(normalized) ? normalized : null;
}

/**
 * Devuelve la sucursal operativa actualmente activa en la cabecera `x-sucursal-activa` (o `null`).
 */
export function getActiveClientSucursalHeader(): OperativeSucursal | null {
  return activeSucursalHeader;
}

function buildSucursalAwareFetch(baseFetch?: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const fetchFn = baseFetch ?? globalThis.fetch;
    const currentSucursal = activeSucursalHeader;
    if (!currentSucursal) {
      return fetchFn(input, init);
    }

    const headers = new Headers(
      init?.headers ??
        (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
    );
    if (!headers.has('x-sucursal-activa')) {
      headers.set('x-sucursal-activa', currentSucursal);
    }

    return fetchFn(input, {
      ...init,
      headers,
    });
  };
}

function bindAuthTokenSync(client: SupabaseClient, fallbackKey: string): void {
  if (authListenerBound) return;
  authListenerBound = true;

  void client.auth.getSession().then(({ data }) => {
    const token = data.session?.access_token || null;
    cachedAccessToken = token;
    if (token) {
      client.realtime.setAuth(token);
    }
  });

  client.auth.onAuthStateChange((event, session: Session | null) => {
    const token = session?.access_token || null;
    cachedAccessToken = token;
    if (event === 'SIGNED_OUT') {
      activeSucursalHeader = null;
    }
    client.realtime.setAuth(token ?? fallbackKey);
  });
}

/**
 * Devuelve el token JWT de sesión autenticado actual en memoria (o `null` si no hay sesión).
 */
export function getCachedAccessToken(): string | null {
  return cachedAccessToken;
}

/**
 * Crea un cliente Supabase validado con la clave de almacenamiento unificada
 * `codizulca.supabase.auth.v1`. Cuando se especifican `opciones` explícitas (p. ej.
 * `storage` aislado o URL loopback en pruebas), retorna una instancia aislada sin
 * contaminar el singleton de aplicación.
 */
export function crearClienteSupabase(
  opciones: CrearClienteSupabaseOpciones = {}
): SupabaseClient {
  const hasCustomOptions = Boolean(
    opciones.url !== undefined ||
      opciones.publishableKey !== undefined ||
      opciones.anonKey !== undefined ||
      opciones.storage !== undefined ||
      opciones.fetch !== undefined
  );

  if (!hasCustomOptions) {
    return getSupabaseClient();
  }

  const env = leerVariablesEntornoPublicas();
  const urlEntrada = opciones.url ?? env.urlCruda;
  const llaveEntrada = opciones.publishableKey ?? opciones.anonKey ?? env.llaveCruda;

  const { urlNormalizada, llave } = assertCredencialesSeguras(urlEntrada, llaveEntrada, {
    permitirLoopbackPruebas: opciones.permitirLoopbackPruebas === true,
  });

  const shouldPersist = Boolean(opciones.storage) || typeof window !== 'undefined';

  return createClient(urlNormalizada, llave, {
    global: {
      fetch: buildSucursalAwareFetch(opciones.fetch),
    },
    auth: {
      persistSession: shouldPersist,
      autoRefreshToken: shouldPersist,
      detectSessionInUrl: typeof window !== 'undefined' && !opciones.storage,
      storageKey: UNIFIED_SUPABASE_STORAGE_KEY,
      ...(opciones.storage ? { storage: opciones.storage } : {}),
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
}

/**
 * Cliente unificado `@supabase/supabase-js` compartido por Auth, PostgREST y Realtime WebSockets.
 */
export function getSupabaseClient(): SupabaseClient {
  assertSupabaseConfigured();
  if (!unifiedClient) {
    const isBrowser = typeof window !== 'undefined';
    unifiedClient = createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY, {
      global: {
        fetch: buildSucursalAwareFetch(),
      },
      auth: {
        persistSession: isBrowser,
        autoRefreshToken: isBrowser,
        detectSessionInUrl: isBrowser,
        storageKey: UNIFIED_SUPABASE_STORAGE_KEY,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    });
    bindAuthTokenSync(unifiedClient, SUPABASE_ANON_KEY);
  }
  return unifiedClient;
}

export function getSupabaseRealtimeClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  return getSupabaseClient();
}

export function getSupabaseCoordinatorClient(): SupabaseClient {
  return getSupabaseClient();
}

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
        global: {
          fetch: buildSucursalAwareFetch(),
        },
        auth: {
          persistSession: isBrowser,
          autoRefreshToken: isBrowser,
          detectSessionInUrl: isBrowser,
          storageKey: DEDICATED_MASTER_STORAGE_KEY,
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

/**
 * Diagnóstico seguro de conectividad contra `/auth/v1/health` y estado de sesión
 * sin imprimir ni devolver llaves ni tokens.
 */
export async function verificarConexionSupabase(
  opciones: {
    url?: string;
    publishableKey?: string;
    client?: SupabaseClient;
    fetchImpl?: typeof fetch;
    permitirLoopbackPruebas?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<ResultadoDiagnosticoSupabase> {
  const env = leerVariablesEntornoPublicas();
  const urlEntrada = opciones.url ?? env.urlCruda;
  const llaveEntrada = opciones.publishableKey ?? env.llaveCruda;

  let urlNormalizada: string | null = null;
  let llave = '';

  try {
    const validado = assertCredencialesSeguras(urlEntrada, llaveEntrada, {
      permitirLoopbackPruebas: opciones.permitirLoopbackPruebas === true,
      silenciarGuia: true,
    });
    urlNormalizada = validado.urlNormalizada;
    llave = validado.llave;
  } catch (err) {
    try {
      urlNormalizada = normalizarSupabaseUrl(urlEntrada, {
        permitirLoopbackPruebas: opciones.permitirLoopbackPruebas === true,
      });
    } catch {
      urlNormalizada = null;
    }
    const esSeguridad = err instanceof ErrorSeguridadCredenciales;
    const esConfig = err instanceof ErrorConfiguracionIncompleta;
    return {
      ok: false,
      urlNormalizada,
      sesionActiva: false,
      mensaje: esSeguridad
        ? 'Conexión bloqueada por seguridad: credencial no permitida en el frontend.'
        : esConfig
          ? `Configuración incompleta: ${err.message}`
          : 'Configuración de Supabase inválida.',
    };
  }

  const fetchFn = opciones.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.max(
    1000,
    Math.min(opciones.timeoutMs ?? DIAGNOSTIC_TIMEOUT_DEFAULT_MS, 30000)
  );
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);

  try {
    const respuesta = await fetchFn(`${urlNormalizada}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: llave },
      signal: controlador.signal,
    });

    if (respuesta.status === 404) {
      return {
        ok: false,
        urlNormalizada,
        sesionActiva: false,
        mensaje:
          'Endpoint de Auth no encontrado (404): verifique que VITE_SUPABASE_URL sea la raíz del proyecto sin /rest/v1/.',
      };
    }

    if (respuesta.status === 401 || respuesta.status === 403) {
      return {
        ok: false,
        urlNormalizada,
        sesionActiva: false,
        mensaje: 'Supabase rechazó la llave pública configurada (401/403).',
      };
    }

    if (!respuesta.ok) {
      return {
        ok: false,
        urlNormalizada,
        sesionActiva: false,
        mensaje: `El servicio de Auth respondió con estado HTTP ${respuesta.status}.`,
      };
    }
  } catch {
    return {
      ok: false,
      urlNormalizada,
      sesionActiva: false,
      mensaje: 'No se pudo contactar el servidor de Supabase (error de red o tiempo de espera agotado).',
    };
  } finally {
    clearTimeout(temporizador);
  }

  try {
    const cliente =
      opciones.client ??
      crearClienteSupabase({
        url: urlNormalizada,
        publishableKey: llave,
        permitirLoopbackPruebas: opciones.permitirLoopbackPruebas === true,
      });

    const { data, error } = await cliente.auth.getSession();
    if (error) {
      return {
        ok: false,
        urlNormalizada,
        sesionActiva: false,
        mensaje: 'Supabase Auth respondió con error al consultar la sesión.',
      };
    }

    const sesionActiva = Boolean(data?.session?.user?.id);
    return {
      ok: true,
      urlNormalizada,
      sesionActiva,
      mensaje: sesionActiva
        ? 'Conexión verificada: sesión autenticada activa.'
        : 'Conexión verificada: endpoint disponible (sin sesión iniciada).',
    };
  } catch {
    return {
      ok: false,
      urlNormalizada,
      sesionActiva: false,
      mensaje: 'Error inesperado al consultar la sesión de Supabase.',
    };
  }
}

/**
 * Renderiza el resultado del diagnóstico en el DOM usando exclusivamente `createElement` y `textContent`.
 */
export function pintarEstadoConexionDom(
  elementoDestino: HTMLElement,
  resultado: ResultadoDiagnosticoSupabase
): void {
  if (!elementoDestino || typeof elementoDestino.replaceChildren !== 'function') {
    throw new Error('Se requiere un elemento DOM válido para mostrar el diagnóstico.');
  }

  const doc = elementoDestino.ownerDocument;

  const indicador = doc.createElement('strong');
  indicador.className = resultado.ok ? 'supabase-estado-ok' : 'supabase-estado-error';
  indicador.textContent = resultado.ok ? 'Conectado' : 'Sin conexión';

  const detalle = doc.createElement('span');
  detalle.className = 'supabase-estado-detalle';
  detalle.textContent = String(resultado.mensaje ?? '');

  const destino = doc.createElement('small');
  destino.className = 'supabase-estado-url';
  destino.textContent = resultado.urlNormalizada ?? 'URL no configurada';

  elementoDestino.replaceChildren(
    indicador,
    doc.createTextNode(' — '),
    detalle,
    doc.createTextNode(' · '),
    destino
  );
}
