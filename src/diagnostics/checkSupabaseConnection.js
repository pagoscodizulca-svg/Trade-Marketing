import {
  ErrorConfiguracionIncompleta,
  ErrorSeguridadCredenciales,
  assertCredencialesSeguras,
  crearClienteSupabase,
  leerVariablesEntornoPublicas,
  normalizarSupabaseUrl,
} from '../lib/supabaseClient.js';

/**
 * Diagnóstico Seguro de Conexión con Supabase.
 *
 * - Verifica `supabase.auth.getSession()` y la disponibilidad del endpoint `/auth/v1/health`
 *   (detecta errores de red o 404 por URL mal formada, ej. `/rest/v1/rest/v1/`).
 * - Nunca imprime ni devuelve llaves o tokens.
 * - El renderizado en DOM usa exclusivamente `textContent` y `document.createElement`.
 */

const TIEMPO_MAXIMO_MS = 8000;

/**
 * @typedef {Object} ResultadoDiagnosticoSupabase
 * @property {boolean} ok
 * @property {string | null} urlNormalizada
 * @property {boolean} sesionActiva
 * @property {string} mensaje
 */

/**
 * Ejecuta el diagnóstico de conectividad sin exponer credenciales.
 *
 * @param {{
 *   url?: string,
 *   publishableKey?: string,
 *   client?: import('@supabase/supabase-js').SupabaseClient,
 *   fetchImpl?: typeof fetch,
 *   permitirLoopbackPruebas?: boolean,
 *   timeoutMs?: number
 * }} [opciones]
 * @returns {Promise<ResultadoDiagnosticoSupabase>}
 */
export async function verificarConexionSupabase(opciones = {}) {
  const env = leerVariablesEntornoPublicas();
  const urlEntrada = opciones.url ?? env.urlCruda;
  const llaveEntrada = opciones.publishableKey ?? env.llaveCruda;

  let urlNormalizada = null;
  let llave = '';

  // 1. Validación local de credenciales (sin red)
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

  // 2. Verificación del endpoint de Auth (detecta errores de red y rutas mal formadas)
  const fetchFn = opciones.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.max(1000, Math.min(opciones.timeoutMs ?? TIEMPO_MAXIMO_MS, 30000));
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
        mensaje: 'Supabase rechazó la llave pública configurada (401/403). Verifique su sb_publishable_ key.',
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

  // 3. Consultar estado de sesión del SDK
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
 * Pinta el resultado del diagnóstico en el DOM de forma inmune a XSS.
 *
 * @param {HTMLElement} elementoDestino
 * @param {ResultadoDiagnosticoSupabase} resultado
 */
export function pintarEstadoConexionDom(elementoDestino, resultado) {
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

  elementoDestino.replaceChildren(indicador, doc.createTextNode(' — '), detalle, doc.createTextNode(' · '), destino);
}
