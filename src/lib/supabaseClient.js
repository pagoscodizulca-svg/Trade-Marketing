import { createClient } from '@supabase/supabase-js';

/**
 * Cliente Centralizado y Seguro de Supabase — Programa de Trade Marketing (ES6+ / Vite).
 *
 * Reglas de seguridad aplicadas (ver `rules/AGENTS.md`):
 *   1. Solo URL raíz `https://<ref>.supabase.co` (sin `/rest/v1/`) y llave pública `sb_publishable_*`.
 *   2. `assertCredencialesSeguras()` se ejecuta SIEMPRE antes de `createClient()`: bloquea
 *      `sb_secret_*` y JWT `service_role` sin realizar ninguna petición de red.
 *   3. Jamás se imprime el valor de ninguna llave o token en consola.
 *   4. Toda autorización de datos depende exclusivamente de políticas RLS en Supabase.
 */

export const URL_PROYECTO_REFERENCIA = 'https://apaxdgxtaoeyswlfblgi.supabase.co';
export const PLACEHOLDER_PUBLISHABLE_KEY = 'PEGA_AQUI_TU_SB_PUBLISHABLE_KEY';
export const ARCHIVO_CONFIGURACION_LOCAL = '.env.local';

const STORAGE_KEY_SESION = 'codizulca.trade.sucursales.auth.v1';
const REGEX_URL_SUPABASE = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
const REGEX_URL_LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

/** Error de seguridad crítico: credencial administrativa detectada en el frontend. */
export class ErrorSeguridadCredenciales extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorSeguridadCredenciales';
  }
}

/** Error de configuración: falta URL o llave pública en el archivo local. */
export class ErrorConfiguracionIncompleta extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorConfiguracionIncompleta';
  }
}

/**
 * Decodifica el payload Base64URL de un JWT únicamente para detectar el rol `service_role`.
 * No verifica firma ni registra contenido.
 * @param {string} token
 * @returns {Record<string, unknown> | null}
 */
function decodificarPayloadJwt(token) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3 || !partes[1]) return null;

  try {
    const base64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
    const relleno = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
    const jsonTexto =
      typeof globalThis.atob === 'function'
        ? globalThis.atob(base64 + relleno)
        : Buffer.from(base64 + relleno, 'base64').toString('utf8');
    const parsed = JSON.parse(jsonTexto);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Normaliza la URL del proyecto Supabase:
 *  - Elimina espacios, barras finales y sufijos accidentales `/rest/v1/` (o `/auth/v1/`).
 *  - Exige protocolo `https://` y dominio `.supabase.co`.
 *
 * @param {string} url
 * @param {{ permitirLoopbackPruebas?: boolean }} [opciones] Solo para suites locales en 127.0.0.1.
 * @returns {string} URL raíz normalizada (ej. `https://apaxdgxtaoeyswlfblgi.supabase.co`).
 */
export function normalizarSupabaseUrl(url, opciones = {}) {
  let limpia = String(url ?? '').trim();
  if (!limpia) {
    throw new ErrorConfiguracionIncompleta(
      `Falta VITE_SUPABASE_URL. Configure ${ARCHIVO_CONFIGURACION_LOCAL} con ${URL_PROYECTO_REFERENCIA}`
    );
  }

  // Remover sufijos de API y barras finales de forma repetida (ej. "/rest/v1/rest/v1/")
  let anterior = '';
  while (anterior !== limpia) {
    anterior = limpia;
    limpia = limpia
      .replace(/\/+$/, '')
      .replace(/\/(rest|auth|storage|realtime|functions)\/v1$/i, '');
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
 * Detector de credenciales administrativas (compatibilidad con módulos previos).
 * Lanza `ErrorSeguridadCredenciales` si la llave es `sb_secret_*` o JWT `service_role`.
 * @param {string} clavePublica
 */
export function validarClavePublicaNoSecreta(clavePublica) {
  const limpia = String(clavePublica ?? '').trim();
  if (!limpia) return;

  if (limpia.startsWith('sb_secret_')) {
    throw new ErrorSeguridadCredenciales(
      '[SEGURIDAD CRÍTICA] Se detectó una llave secreta (sb_secret_*) en el frontend. Inicialización bloqueada: use exclusivamente la llave pública sb_publishable_*.'
    );
  }

  if (limpia.startsWith('eyJ')) {
    const payload = decodificarPayloadJwt(limpia);
    if (payload && payload.role === 'service_role') {
      throw new ErrorSeguridadCredenciales(
        '[SEGURIDAD CRÍTICA] Se detectó un token con rol service_role en el frontend. Inicialización bloqueada: use exclusivamente la llave pública sb_publishable_*.'
      );
    }
  }
}

/**
 * Guardia activa ejecutada ANTES de `createClient()`.
 *  - Bloquea `sb_secret_*` y JWT `service_role` (sin tráfico de red).
 *  - Si la llave está vacía o conserva el marcador, muestra guía en consola y detiene la inicialización.
 *  - Exige prefijo `sb_publishable_` para la llave pública.
 *
 * @param {string} url
 * @param {string} key
 * @param {{ permitirLoopbackPruebas?: boolean, silenciarGuia?: boolean }} [opciones]
 * @returns {{ urlNormalizada: string, llave: string }}
 */
export function assertCredencialesSeguras(url, key, opciones = {}) {
  const llave = String(key ?? '').trim();

  // 1. Seguridad primero: bloquear credenciales administrativas incluso si la URL es inválida
  validarClavePublicaNoSecreta(llave);

  // 2. Llave vacía o marcador de posición sin reemplazar
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

  // 3. Solo se aceptan llaves públicas modernas con prefijo sb_publishable_
  if (!llave.startsWith('sb_publishable_') || llave.length < 20) {
    throw new ErrorSeguridadCredenciales(
      '[SEGURIDAD] La llave configurada no es una Publishable Key válida (prefijo sb_publishable_ requerido).'
    );
  }

  const urlNormalizada = normalizarSupabaseUrl(url, opciones);
  return { urlNormalizada, llave };
}

/**
 * Lee las variables públicas desde `import.meta.env` (Vite) con respaldo a `process.env`
 * exclusivamente para pruebas automatizadas en Node. Prioriza `VITE_SUPABASE_PUBLISHABLE_KEY`.
 * @returns {{ urlCruda: string, llaveCruda: string }}
 */
export function leerVariablesEntornoPublicas() {
  const viteEnv =
    typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};
  const nodeEnv =
    typeof globalThis.process !== 'undefined' && globalThis.process?.env
      ? globalThis.process.env
      : {};

  const urlCruda = String(viteEnv.VITE_SUPABASE_URL || nodeEnv.VITE_SUPABASE_URL || '').trim();

  const candidatas = [
    viteEnv.VITE_SUPABASE_PUBLISHABLE_KEY,
    nodeEnv.VITE_SUPABASE_PUBLISHABLE_KEY,
    viteEnv.VITE_SUPABASE_ANON_KEY,
    nodeEnv.VITE_SUPABASE_ANON_KEY,
  ]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);

  const preferida =
    candidatas.find((v) => v !== PLACEHOLDER_PUBLISHABLE_KEY) || candidatas[0] || '';

  return { urlCruda, llaveCruda: preferida };
}

/**
 * Estado de configuración consultable sin lanzar excepciones ni exponer llaves.
 * @returns {{ configurado: boolean, urlNormalizada: string | null, motivo: string }}
 */
export function obtenerEstadoConfiguracionSupabase() {
  const { urlCruda, llaveCruda } = leerVariablesEntornoPublicas();
  try {
    const { urlNormalizada } = assertCredencialesSeguras(urlCruda, llaveCruda, {
      silenciarGuia: true,
    });
    return { configurado: true, urlNormalizada, motivo: 'Configuración pública válida.' };
  } catch (err) {
    let urlNormalizada = null;
    try {
      urlNormalizada = normalizarSupabaseUrl(urlCruda);
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

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let clienteUnico = null;
let huellaClienteUnico = '';

/**
 * Crea (o reutiliza) el cliente Supabase tras pasar `assertCredencialesSeguras()`.
 *
 * @param {{ url?: string, publishableKey?: string, anonKey?: string, storage?: Storage, permitirLoopbackPruebas?: boolean }} [opciones]
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function crearClienteSupabase(opciones = {}) {
  const env = leerVariablesEntornoPublicas();
  const urlEntrada = opciones.url ?? env.urlCruda;
  const llaveEntrada = opciones.publishableKey ?? opciones.anonKey ?? env.llaveCruda;

  const { urlNormalizada, llave } = assertCredencialesSeguras(urlEntrada, llaveEntrada, {
    permitirLoopbackPruebas: opciones.permitirLoopbackPruebas === true,
  });

  const huella = `${urlNormalizada}::${llave.length}::${llave.slice(-6)}`;
  if (!opciones.storage && clienteUnico && huellaClienteUnico === huella) {
    return clienteUnico;
  }

  const nuevoCliente = createClient(urlNormalizada, llave, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: STORAGE_KEY_SESION,
      ...(opciones.storage ? { storage: opciones.storage } : {}),
    },
  });

  if (!opciones.storage) {
    clienteUnico = nuevoCliente;
    huellaClienteUnico = huella;
  }

  return nuevoCliente;
}

/** Alias explícito para obtener la instancia única configurada por entorno. */
export function obtenerClienteSupabase() {
  return crearClienteSupabase();
}

/**
 * Instancia única `supabase` (inicialización perezosa al primer uso para que la guardia
 * de credenciales se ejecute antes de cualquier petición y el módulo sea importable en pruebas).
 * @type {import('@supabase/supabase-js').SupabaseClient}
 */
export const supabase = new Proxy(/** @type {any} */ ({}), {
  get(_objetivo, propiedad) {
    const instancia = crearClienteSupabase();
    const valor = Reflect.get(instancia, propiedad, instancia);
    return typeof valor === 'function' ? valor.bind(instancia) : valor;
  },
});

export default supabase;
