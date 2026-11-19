/**
 * Validación de arranque: purga cualquier dato de prueba o caché heredado de sesiones anteriores
 * guardado en el navegador. Se ejecuta UNA vez por versión, antes de montar React.
 *
 * Se conservan únicamente:
 *  - sesiones reales de autenticación: claves `sb-*` (SDK por defecto) y `codizulca.*` / `codizulca_*`
 *    (por ejemplo `codizulca.supabase.auth.v1`, la clave de sesión unificada de la app);
 *  - el registro de notificaciones ya leídas (`codizulca_trade_read_degustaciones_v1`);
 *  - las bases IndexedDB de colas offline (portal y logística) y las del propio SDK de Supabase.
 */
export const APP_CLEAN_SYNC_VERSION = 'production-v1';
export const APP_CLEAN_SYNC_VERSION_KEY = 'app_clean_sync_version';
export const UI_THEME_STORAGE_KEY = 'codizulca.ui_theme';

const PRESERVED_EXACT_KEYS = new Set<string>([
  APP_CLEAN_SYNC_VERSION_KEY,
  'codizulca_trade_read_degustaciones_v1',
  UI_THEME_STORAGE_KEY,
]);

/** Prefijos de claves de Web Storage que jamás se purgan (sesión y preferencias reales). */
export const PRESERVED_STORAGE_KEY_PREFIXES: readonly string[] = ['sb-', 'codizulca.', 'codizulca_'];

/** Prefijos de bases IndexedDB que jamás se eliminan (colas offline y almacenamiento del SDK). */
export const PRESERVED_INDEXEDDB_PREFIXES: readonly string[] = [
  'supabase',
  'rutadegustacion-offline',
  'codizulca',
  'trade-',
];

export function isPreservedKey(key: string): boolean {
  return (
    PRESERVED_EXACT_KEYS.has(key) ||
    PRESERVED_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function isPreservedIndexedDbName(name: string): boolean {
  const lower = name.toLowerCase();
  return PRESERVED_INDEXEDDB_PREFIXES.some((prefix) => lower.startsWith(prefix));
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
      if (db.name && !isPreservedIndexedDbName(db.name)) {
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
