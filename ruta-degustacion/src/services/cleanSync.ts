/**
 * Purga única del almacenamiento del navegador. Garantiza que no sobreviva ningún dato de prueba,
 * semilla o caché antiguo de versiones anteriores: la única fuente de datos es Supabase.
 */
export const APP_CLEAN_SYNC_VERSION = 'production-v1';

const VERSION_KEY = 'rutadegustacion:clean_sync_version';
const PREFIJO_PROPIO = 'rutadegustacion:v1:';
/** Claves de sesión de Supabase Auth que se conservan. */
const esClaveAuth = (k: string) => k.startsWith('sb-');
/**
 * Bases IndexedDB que se conservan: autenticación y la base OFFLINE del chofer, que solo contiene datos reales
 * (copia del servidor + acciones pendientes de subir). Borrarla haría perder entregas aún no sincronizadas.
 */
export const BASE_OFFLINE = 'rutadegustacion-offline';
const esBaseAuth = (nombre: string) =>
  nombre === BASE_OFFLINE || /^(sb-|supabase)/i.test(nombre) || /auth/i.test(nombre);

function borrarPrefijo(storage: Storage) {
  const claves: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(PREFIJO_PROPIO) && !esClaveAuth(k)) claves.push(k);
  }
  claves.forEach((k) => storage.removeItem(k));
}

function borrarBase(nombre: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(nombre);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Ejecuta la purga si la versión guardada no coincide. Debe llamarse antes de montar React. */
export async function ejecutarCleanSync(): Promise<void> {
  try {
    if (localStorage.getItem(VERSION_KEY) === APP_CLEAN_SYNC_VERSION) return;

    borrarPrefijo(localStorage);
    borrarPrefijo(sessionStorage);

    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      const bases = await indexedDB.databases();
      const limpieza = Promise.all(
        bases.filter((b) => b.name && !esBaseAuth(b.name)).map((b) => borrarBase(b.name as string)),
      );
      // No bloquear el arranque si el navegador tarda en cerrar alguna base.
      await Promise.race([limpieza, new Promise<void>((r) => window.setTimeout(r, 1500))]);
    }

    localStorage.setItem(VERSION_KEY, APP_CLEAN_SYNC_VERSION);
  } catch (err) {
    console.warn('[RutaDegustación] No se pudo completar la purga de almacenamiento:', err);
  }
}
