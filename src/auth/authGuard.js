import { crearClienteSupabase, supabase as clientePorDefecto } from '../lib/supabaseClient.js';

/**
 * Guardia de Autenticación, Lista Blanca y Renderizado Seguro de Sede (ES6+).
 *
 * Cumplimiento OWASP:
 *   1. Sanitización estricta de correo (`trim().toLowerCase()`), longitudes y formato UUID.
 *   2. Vinculación en servidor mediante `rpc('vincular_mi_usuario_auth')` y verificación
 *      autoritativa sobre `public.perfiles_acceso`.
 *   3. Cierre inmediato de sesión (`signOut()`) cuando el correo no posee perfil activo.
 *   4. Cero uso de métodos inseguros de inyección DOM: toda etiqueta o texto proveniente
 *      de la base de datos se asigna exclusivamente con `textContent`, `value` y `createElement`.
 */

export const MENSAJE_PERFIL_NO_ACTIVO =
  'Tu correo no tiene perfil activo asignado. Contacta al Administrador General';

export const MENSAJE_CREDENCIALES_INVALIDAS = 'Correo electrónico o contraseña incorrectos.';

const REGEX_EMAIL_ESTRICTO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REGEX_UUID_RFC4122 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGEX_UUID_GENERAL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLES_VALIDOS = new Set(['promotora', 'coordinadora', 'admin_general']);
const SUCURSALES_VALIDAS = new Set(['Zulia', 'Valencia']);

/**
 * Valida si una cadena tiene formato UUID seguro antes de enviarla a PostgreSQL.
 * @param {unknown} valor
 * @returns {boolean}
 */
export function esUuidValido(valor) {
  const limpio = String(valor ?? '').trim();
  return REGEX_UUID_RFC4122.test(limpio) || REGEX_UUID_GENERAL.test(limpio);
}

/**
 * Sanitiza texto plano eliminando caracteres de control invisibles y acotando longitud.
 * @param {unknown} texto
 * @param {number} [maxLongitud=500]
 * @returns {string}
 */
export function sanitizarTextoEntrada(texto, maxLongitud = 500) {
  const limite = Math.max(1, Math.min(Math.trunc(maxLongitud) || 500, 4000));
  return String(texto ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, limite);
}

/**
 * Normaliza y valida sintácticamente un correo electrónico (`trim().toLowerCase()`).
 * @param {unknown} emailCrudo
 * @returns {string}
 */
export function sanitizarCorreoAcceso(emailCrudo) {
  const limpio = String(emailCrudo ?? '').trim().toLowerCase();
  if (limpio.length < 5 || limpio.length > 254 || !REGEX_EMAIL_ESTRICTO.test(limpio)) {
    throw new Error('Ingresa un correo electrónico válido.');
  }
  return limpio;
}

/**
 * Resuelve el texto exacto e inmutable de la etiqueta de sede activa.
 * @param {'promotora' | 'coordinadora' | 'admin_general'} rol
 * @param {'Zulia' | 'Valencia' | null} sucursal
 * @returns {'Sucursal Zulia' | 'Sucursal Valencia' | 'Administración General - Nacional'}
 */
export function obtenerEtiquetaSede(rol, sucursal) {
  if (rol === 'admin_general') {
    return 'Administración General - Nacional';
  }
  if (sucursal === 'Zulia') {
    return 'Sucursal Zulia';
  }
  if (sucursal === 'Valencia') {
    return 'Sucursal Valencia';
  }
  throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
}

/**
 * Valida la integridad de la fila obtenida desde `public.perfiles_acceso`.
 * @param {Record<string, unknown> | null | undefined} fila
 * @returns {{
 *   rol: 'promotora' | 'coordinadora' | 'admin_general',
 *   sucursal: 'Zulia' | 'Valencia' | null,
 *   nombreCompleto: string,
 *   promotoraId: string | null,
 *   etiquetaSede: 'Sucursal Zulia' | 'Sucursal Valencia' | 'Administración General - Nacional'
 * } | null}
 */
function validarPerfilAcceso(fila) {
  if (!fila || typeof fila !== 'object') return null;
  if (fila.activo !== true) return null;

  const rol = String(fila.rol ?? '').trim();
  if (!ROLES_VALIDOS.has(rol)) return null;

  const sucursalCruda = fila.sucursal == null ? null : String(fila.sucursal).trim();
  if (rol === 'admin_general') {
    if (sucursalCruda !== null && !SUCURSALES_VALIDAS.has(sucursalCruda)) {
      return null;
    }
  } else if (!sucursalCruda || !SUCURSALES_VALIDAS.has(sucursalCruda)) {
    return null;
  }

  const sucursal = /** @type {'Zulia' | 'Valencia' | null} */ (
    rol === 'admin_general' ? null : sucursalCruda
  );
  const rolTipado = /** @type {'promotora' | 'coordinadora' | 'admin_general'} */ (rol);
  const nombreCompleto =
    sanitizarTextoEntrada(fila.nombre_completo, 160) || 'Usuario Trade Marketing';
  const promotoraId =
    fila.promotora_id && esUuidValido(fila.promotora_id)
      ? String(fila.promotora_id).trim()
      : null;

  return {
    rol: rolTipado,
    sucursal,
    nombreCompleto,
    promotoraId,
    etiquetaSede: obtenerEtiquetaSede(rolTipado, sucursal),
  };
}

/**
 * Autentica por correo y contraseña, enlaza la cuenta contra la lista blanca en servidor
 * (`vincular_mi_usuario_auth`) y consulta el perfil activo en `public.perfiles_acceso`.
 *
 * Si el correo no existe en `perfiles_acceso` o tiene `activo === false`, cierra la sesión
 * de inmediato con `supabase.auth.signOut()` y lanza el mensaje genérico seguro.
 *
 * @param {string} email
 * @param {string} password
 * @param {{ client?: import('@supabase/supabase-js').SupabaseClient }} [opciones]
 * @returns {Promise<{
 *   rol: 'promotora' | 'coordinadora' | 'admin_general',
 *   sucursal: 'Zulia' | 'Valencia' | null,
 *   nombreCompleto: string,
 *   promotoraId: string | null,
 *   etiquetaSede: 'Sucursal Zulia' | 'Sucursal Valencia' | 'Administración General - Nacional'
 * }>}
 */
export async function iniciarSesionPorCorreo(email, password, opciones = {}) {
  const emailSanitizado = sanitizarCorreoAcceso(email);
  const clave = String(password ?? '');

  if (clave.trim().length === 0 || clave.length > 256) {
    throw new Error('Ingresa tu contraseña para continuar.');
  }

  const supabase = opciones.client ?? clientePorDefecto;

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: emailSanitizado,
    password: clave,
  });

  if (authError || !authData?.user?.id || !esUuidValido(authData.user.id)) {
    throw new Error(MENSAJE_CREDENCIALES_INVALIDAS);
  }

  try {
    // 1. Vincular `auth_user_id = auth.uid()` en servidor si estaba pendiente en la lista blanca
    const { error: rpcError } = await supabase.rpc('vincular_mi_usuario_auth');
    if (rpcError) {
      await supabase.auth.signOut();
      throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
    }

    // 2. Consultar exclusivamente el perfil propio autorizado por RLS
    const { data: filaPerfil, error: perfilError } = await supabase
      .from('perfiles_acceso')
      .select('id, auth_user_id, email, nombre_completo, rol, sucursal, promotora_id, activo')
      .eq('auth_user_id', authData.user.id)
      .maybeSingle();

    const perfilVerificado = !perfilError ? validarPerfilAcceso(filaPerfil) : null;

    if (!perfilVerificado) {
      await supabase.auth.signOut();
      throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
    }

    return perfilVerificado;
  } catch (err) {
    if (err instanceof Error && err.message === MENSAJE_PERFIL_NO_ACTIVO) {
      throw err;
    }
    await supabase.auth.signOut().catch(() => {});
    throw new Error(MENSAJE_PERFIL_NO_ACTIVO);
  }
}

/**
 * Revalida la sesión actual al cargar una pantalla protegida; si el perfil fue desactivado,
 * ejecuta `signOut()` inmediatamente.
 *
 * @param {{ client?: import('@supabase/supabase-js').SupabaseClient }} [opciones]
 */
export async function verificarSesionActiva(opciones = {}) {
  const supabase = opciones.client ?? crearClienteSupabase();
  const { data: userData, error: userErr } = await supabase.auth.getUser();

  if (userErr || !userData?.user?.id || !esUuidValido(userData.user.id)) {
    return null;
  }

  await supabase.rpc('vincular_mi_usuario_auth').catch(() => {});

  const { data: filaPerfil, error: perfilError } = await supabase
    .from('perfiles_acceso')
    .select('id, auth_user_id, email, nombre_completo, rol, sucursal, promotora_id, activo')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();

  const perfilVerificado = !perfilError ? validarPerfilAcceso(filaPerfil) : null;
  if (!perfilVerificado) {
    await supabase.auth.signOut().catch(() => {});
    return null;
  }

  return perfilVerificado;
}

/**
 * Pinta de forma 100% inmune a XSS la etiqueta de sede activa y el nombre del usuario
 * usando exclusivamente `document.createElement` y `textContent`.
 *
 * @param {HTMLElement} nodoContenedor
 * @param {{
 *   rol: 'promotora' | 'coordinadora' | 'admin_general',
 *   sucursal: 'Zulia' | 'Valencia' | null,
 *   nombreCompleto: string
 * }} sesionPerfil
 */
export function renderizarInsigniaSedeSegura(nodoContenedor, sesionPerfil) {
  if (!nodoContenedor || typeof nodoContenedor.replaceChildren !== 'function') {
    throw new Error('Se requiere un nodo DOM válido para pintar la etiqueta de sede.');
  }

  const doc = nodoContenedor.ownerDocument;
  const textoSede = obtenerEtiquetaSede(sesionPerfil.rol, sesionPerfil.sucursal);

  const badgeSede = doc.createElement('span');
  badgeSede.className = 'trade-sede-badge';
  badgeSede.dataset.rol = sesionPerfil.rol;
  badgeSede.dataset.sucursal = sesionPerfil.sucursal ?? 'Nacional';
  badgeSede.textContent = textoSede;

  const etiquetaUsuario = doc.createElement('strong');
  etiquetaUsuario.className = 'trade-usuario-nombre';
  etiquetaUsuario.textContent = sanitizarTextoEntrada(sesionPerfil.nombreCompleto, 160);

  nodoContenedor.replaceChildren(badgeSede, doc.createTextNode(' · '), etiquetaUsuario);
}
