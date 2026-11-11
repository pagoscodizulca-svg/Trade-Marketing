/**
 * Validación de arranque: purga cualquier dato de prueba o caché heredado de sesiones anteriores
 * guardado en el navegador. Se ejecuta UNA vez por versión, antes de montar React.
 *
 * Se conservan únicamente:
 *  - sesiones reales de autenticación (claves `sb-*` de Supabase Auth);
 *  - el registro de notificaciones ya leídas (`codizulca_trade_read_degustaciones_v1`), que no contiene datos de prueba.
 */
export const APP_CLEAN_SYNC_VERSION = 'production-v1';
export const APP_CLEAN_SYNC_VERSION_KEY = 'app_clean_sync_version';

const PRESERVED_EXACT_KEYS = new Set<string>([
  APP_CLEAN_SYNC_VERSION_KEY,
  'codizulca_trade_read_degustaciones_v1',
]);

function isPreservedKey(key: string): boolean {
  return PRESERVED_EXACT_KEYS.has(key) || key.startsWith('sb-');
}

function purgeStorage(storage: Storage): string[] {
  const removed: string[] = [];
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k) keys.push(k);
  }
  for (const key of keys) {
    if (isPreservedKey(key)) continue;
    storage.removeItem(key);
    removed.push(key);
  }
  return removed;
}

async function purgeIndexedDb(): Promise<void> {
  try {
    const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
    if (typeof idb.databases !== 'function') return;
    const dbs = await idb.databases();
    for (const db of dbs) {
      if (db.name && !db.name.toLowerCase().startsWith('supabase')) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  } catch {
    // IndexedDB no disponible: nada que purgar
  }
}

/**
 * Devuelve las claves eliminadas (vacío si la versión ya estaba al día).
 * La purga de localStorage/sessionStorage es síncrona; la de IndexedDB corre en segundo plano.
 */
export function runCleanSyncMigration(): string[] {
  try {
    if (localStorage.getItem(APP_CLEAN_SYNC_VERSION_KEY) === APP_CLEAN_SYNC_VERSION) {
      return [];
    }
    const removed = [...purgeStorage(localStorage), ...purgeStorage(sessionStorage)];
    void purgeIndexedDb();
    localStorage.setItem(APP_CLEAN_SYNC_VERSION_KEY, APP_CLEAN_SYNC_VERSION);
    return removed;
  } catch {
    // Almacenamiento bloqueado por el navegador: la app funciona solo en memoria
    return [];
  }
}
