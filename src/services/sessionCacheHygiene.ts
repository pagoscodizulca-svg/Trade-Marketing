/**
 * Motor unificado de higiene de caché multi-sesión y multi-región.
 *
 * REGLA DE SEGURIDAD (OWASP A01 / Zero Cross-Session Leakage):
 * Al cerrar sesión (`sign_out`), expirar token (`token_expired`), cambiar de usuario
 * (`user_switch`) o cambiar de sucursal (`region_switch`) en el mismo navegador,
 * purga de forma determinista:
 *   1. Cachés en memoria registrados (maestros, catálogos, perfiles).
 *   2. `sessionStorage` completo.
 *   3. `localStorage` (preservando únicamente la preferencia visual `codizulca.ui_theme`
 *      y `app_clean_sync_version`, más los tokens de sesión solo si `preserveAuthSession: true`).
 *   4. Bases `IndexedDB` de snapshots/colas offline (`codizulca_portal_offline_v1`,
 *      `rutadegustacion-offline`, etc.) y cachés privadas del Service Worker.
 */
import { APP_CLEAN_SYNC_VERSION_KEY, UI_THEME_STORAGE_KEY } from './cleanSync';
import { requestSwPurgePrivateCaches } from '../lib/registerTradeSw';

export type CachePurgeReason = 'sign_out' | 'token_expired' | 'user_switch' | 'region_switch';

export interface PurgeSessionCachesOptions {
  reason?: CachePurgeReason;
  /** True solo al cambiar de sucursal dentro de la misma sesión autenticada. */
  preserveAuthSession?: boolean;
  /** Inyección opcional para pruebas unitarias deterministas sin DOM real. */
  localStorageImpl?: Storage | null;
  sessionStorageImpl?: Storage | null;
  indexedDbImpl?: IDBFactory | null;
}

export interface PurgeSessionCachesReport {
  reason: CachePurgeReason;
  memoryCallbacksInvoked: number;
  localStorageRemoved: string[];
  sessionStorageCleared: boolean;
  indexedDbDeleted: string[];
  swPurgeRequested: boolean;
}

const KNOWN_SENSITIVE_IDB_NAMES = [
  'codizulca_portal_offline_v1',
  'rutadegustacion-offline',
  'codizulca_trade_cache_v1',
] as const;

const memoryPurgeCallbacks = new Set<() => void>();

export function registerMemoryCachePurgeCallback(cb: () => void): () => void {
  memoryPurgeCallbacks.add(cb);
  return () => {
    memoryPurgeCallbacks.delete(cb);
  };
}

function isSupabaseAuthKey(key: string): boolean {
  return (
    key.startsWith('sb-') ||
    key.startsWith('codizulca.supabase.') ||
    key === 'codizulca.supabase.auth.v1' ||
    key === 'codizulca.supabase.master.auth.v1'
  );
}

function shouldPreserveLocalStorageKey(key: string, preserveAuthSession: boolean): boolean {
  if (key === UI_THEME_STORAGE_KEY || key === APP_CLEAN_SYNC_VERSION_KEY) {
    return true;
  }
  if (preserveAuthSession && isSupabaseAuthKey(key)) {
    return true;
  }
  return false;
}

async function purgeSensitiveIndexedDbs(idb: IDBFactory | null | undefined): Promise<string[]> {
  if (!idb || typeof idb.deleteDatabase !== 'function') {
    return [];
  }

  const targetNames = new Set<string>(KNOWN_SENSITIVE_IDB_NAMES);

  try {
    const ext = idb as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    if (typeof ext.databases === 'function') {
      const list = await ext.databases();
      for (const entry of list) {
        const name = String(entry?.name ?? '').trim();
        const lower = name.toLowerCase();
        if (
          name &&
          (lower.startsWith('codizulca') ||
            lower.startsWith('rutadegustacion') ||
            lower.startsWith('trade-'))
        ) {
          targetNames.add(name);
        }
      }
    }
  } catch {
    // Algunos navegadores no implementan indexedDB.databases(): usamos la lista conocida
  }

  const deleted: string[] = [];
  await Promise.all(
    Array.from(targetNames).map(
      (dbName) =>
        new Promise<void>((resolve) => {
          try {
            const req = idb.deleteDatabase(dbName);
            deleted.push(dbName);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          } catch {
            resolve();
          }
        })
    )
  );

  return deleted;
}

export async function purgeAllSessionCaches(
  options: PurgeSessionCachesOptions = {}
): Promise<PurgeSessionCachesReport> {
  const reason: CachePurgeReason = options.reason ?? 'sign_out';
  const preserveAuthSession = options.preserveAuthSession === true;

  // 1. Purgar todos los cachés en memoria registrados
  let memoryCallbacksInvoked = 0;
  for (const cb of memoryPurgeCallbacks) {
    try {
      cb();
      memoryCallbacksInvoked += 1;
    } catch {
      // Nunca abortar el resto de la purga por un callback aislado
    }
  }

  // 2. Purgar `sessionStorage` completo
  let sessionStorageCleared = false;
  const sessStore =
    options.sessionStorageImpl !== undefined
      ? options.sessionStorageImpl
      : typeof window !== 'undefined'
        ? window.sessionStorage
        : null;
  if (sessStore) {
    try {
      sessStore.clear();
      sessionStorageCleared = true;
    } catch {
      sessionStorageCleared = false;
    }
  }

  // 3. Purgar `localStorage` (conservando solo tema visual y, si aplica, token de la sesión actual)
  const localStorageRemoved: string[] = [];
  const locStore =
    options.localStorageImpl !== undefined
      ? options.localStorageImpl
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;
  if (locStore) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < locStore.length; i += 1) {
        const k = locStore.key(i);
        if (k) keys.push(k);
      }
      for (const key of keys) {
        if (shouldPreserveLocalStorageKey(key, preserveAuthSession)) continue;
        locStore.removeItem(key);
        localStorageRemoved.push(key);
      }
    } catch {
      // Navegador con almacenamiento restringido
    }
  }

  // 4. Purgar bases `IndexedDB` de snapshots/colas offline y caché privada de Service Worker
  const idb =
    options.indexedDbImpl !== undefined
      ? options.indexedDbImpl
      : typeof indexedDB !== 'undefined'
        ? indexedDB
        : null;
  const indexedDbDeleted = await purgeSensitiveIndexedDbs(idb);

  let swPurgeRequested = false;
  try {
    requestSwPurgePrivateCaches();
    swPurgeRequested = true;
  } catch {
    swPurgeRequested = false;
  }

  return {
    reason,
    memoryCallbacksInvoked,
    localStorageRemoved,
    sessionStorageCleared,
    indexedDbDeleted,
    swPurgeRequested,
  };
}
