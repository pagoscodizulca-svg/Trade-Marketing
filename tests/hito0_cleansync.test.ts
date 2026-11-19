import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_CLEAN_SYNC_VERSION,
  APP_CLEAN_SYNC_VERSION_KEY,
  isPreservedIndexedDbName,
  isPreservedKey,
  runCleanSyncMigration,
} from '../src/services/cleanSync';

function createFakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } as Storage;
}

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function clearGlobal(name: string): void {
  delete (globalThis as Record<string, unknown>)[name];
}

function installBrowserLikeGlobals(options: {
  local: Storage;
  session?: Storage;
  databases?: string[];
}): { deleted: string[] } {
  const deleted: string[] = [];
  setGlobal('localStorage', options.local);
  setGlobal('sessionStorage', options.session ?? createFakeStorage());
  setGlobal('indexedDB', {
    databases: async () => (options.databases ?? []).map((name) => ({ name })),
    deleteDatabase: (name: string) => {
      deleted.push(name);
      return {} as IDBOpenDBRequest;
    },
  });
  return { deleted };
}

function uninstallGlobals(): void {
  clearGlobal('localStorage');
  clearGlobal('sessionStorage');
  clearGlobal('indexedDB');
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

test('HITO 0 — cleanSync preserva sesión y colas offline (S-05 / P-02)', async (t) => {
  await t.test('isPreservedKey conserva sb-*, codizulca.* y codizulca_* y descarta el resto', () => {
    for (const key of [
      'sb-abcdef-auth-token',
      'codizulca.supabase.auth.v1',
      'codizulca.trade.sucursales.auth.v1',
      'codizulca.cualquier.cosa',
      'codizulca_trade_read_degustaciones_v1',
      'codizulca_preferencias',
      APP_CLEAN_SYNC_VERSION_KEY,
    ]) {
      assert.equal(isPreservedKey(key), true, `${key} debe conservarse`);
    }
    for (const key of ['visits_cache', 'demo_data', 'mockUsers', 'Codizulca.otro', 'x-sb-token']) {
      assert.equal(isPreservedKey(key), false, `${key} debe purgarse`);
    }
  });

  await t.test('isPreservedIndexedDbName conserva Supabase, la cola de logística y prefijos codizulca/trade-', () => {
    for (const name of [
      'supabase-js-cache',
      'Supabase',
      'rutadegustacion-offline',
      'codizulca-portal-queue',
      'trade-offline-queue',
    ]) {
      assert.equal(isPreservedIndexedDbName(name), true, `${name} debe conservarse`);
    }
    for (const name of ['legacy-cache', 'otra-app', 'tradeX']) {
      assert.equal(isPreservedIndexedDbName(name), false, `${name} debe eliminarse`);
    }
  });

  await t.test('La migración conserva la sesión real y borra datos heredados en localStorage y sessionStorage', async () => {
    const local = createFakeStorage({
      'codizulca.supabase.auth.v1': '{"access_token":"x"}',
      'sb-proyecto-auth-token': '{"access_token":"y"}',
      codizulca_trade_read_degustaciones_v1: '["a"]',
      visits_cache: '[]',
      demo_data: '1',
    });
    const session = createFakeStorage({
      'sb-proyecto-auth-token': 'sesion',
      codizulca_tmp: 'conservar',
      temporal: 'borrar',
    });
    installBrowserLikeGlobals({ local, session });
    try {
      const removed = runCleanSyncMigration();
      await flushAsync();

      assert.deepEqual(removed.sort(), ['demo_data', 'temporal', 'visits_cache']);
      assert.notEqual(local.getItem('codizulca.supabase.auth.v1'), null, 'La sesión unificada debe sobrevivir');
      assert.notEqual(local.getItem('sb-proyecto-auth-token'), null);
      assert.notEqual(local.getItem('codizulca_trade_read_degustaciones_v1'), null);
      assert.equal(local.getItem('visits_cache'), null);
      assert.equal(local.getItem('demo_data'), null);
      assert.equal(local.getItem(APP_CLEAN_SYNC_VERSION_KEY), APP_CLEAN_SYNC_VERSION);
      assert.notEqual(session.getItem('sb-proyecto-auth-token'), null);
      assert.notEqual(session.getItem('codizulca_tmp'), null);
      assert.equal(session.getItem('temporal'), null);
    } finally {
      uninstallGlobals();
    }
  });

  await t.test('Es idempotente por versión: la segunda ejecución no purga nada', async () => {
    const local = createFakeStorage({ visits_cache: '[]' });
    installBrowserLikeGlobals({ local });
    try {
      assert.deepEqual(runCleanSyncMigration(), ['visits_cache']);
      local.setItem('dato_nuevo_legitimo', '1');
      assert.deepEqual(runCleanSyncMigration(), []);
      assert.notEqual(local.getItem('dato_nuevo_legitimo'), null, 'No debe purgar tras la primera ejecución');
      await flushAsync();
    } finally {
      uninstallGlobals();
    }
  });

  await t.test('IndexedDB: elimina solo las bases heredadas y preserva las colas offline', async () => {
    const { deleted } = installBrowserLikeGlobals({
      local: createFakeStorage(),
      databases: [
        'supabase-js-cache',
        'rutadegustacion-offline',
        'codizulca-portal-queue',
        'trade-offline-queue',
        'legacy-cache',
        'otra-app',
      ],
    });
    try {
      runCleanSyncMigration();
      await flushAsync();
      assert.deepEqual(deleted.sort(), ['legacy-cache', 'otra-app']);
    } finally {
      uninstallGlobals();
    }
  });

  await t.test('No falla si el navegador no soporta indexedDB.databases()', async () => {
    setGlobal('localStorage', createFakeStorage({ basura: '1' }));
    setGlobal('sessionStorage', createFakeStorage());
    setGlobal('indexedDB', {});
    try {
      assert.deepEqual(runCleanSyncMigration(), ['basura']);
      await flushAsync();
    } finally {
      uninstallGlobals();
    }
  });

  await t.test('Tolera almacenamiento bloqueado por el navegador (devuelve lista vacía)', () => {
    const blocked = {
      get length(): number {
        throw new Error('SecurityError');
      },
      getItem: () => {
        throw new Error('SecurityError');
      },
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error('SecurityError');
      },
      clear: () => undefined,
    } as unknown as Storage;
    setGlobal('localStorage', blocked);
    setGlobal('sessionStorage', blocked);
    setGlobal('indexedDB', {});
    try {
      assert.deepEqual(runCleanSyncMigration(), []);
    } finally {
      uninstallGlobals();
    }
  });
});
