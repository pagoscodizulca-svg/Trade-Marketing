import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  BUILD_ID_PLACEHOLDER,
  createBuildVersionPlugin,
  generateBuildId,
  stampServiceWorkerFile,
} from '../scripts/lib/buildVersionPlugin';
import {
  IMMUTABLE_ASSET_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  isStaticAssetRequestPath,
  mountSpaRoutes,
} from '../src/server/spaCachePolicy';
import {
  checkAndApplyAppUpdate,
  fetchServerBuildId,
  isChunkLoadErrorMessage,
  isValidProductionBuildId,
  purgeStaticShellCaches,
} from '../src/lib/appVersionGuard';

const ROOT = process.cwd();
const readRepoFile = (relPath: string): string =>
  fs.readFileSync(path.join(ROOT, relPath), 'utf8');

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
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
  };
}

function createFakeCacheStorage(initialKeys: string[]): {
  cacheStorage: CacheStorage;
  remainingKeys: () => string[];
} {
  const keys = new Set(initialKeys);
  const cacheStorage = {
    async keys() {
      return Array.from(keys);
    },
    async delete(key: string) {
      return keys.delete(key);
    },
  } as unknown as CacheStorage;
  return {
    cacheStorage,
    remainingKeys: () => Array.from(keys),
  };
}

async function listenLoopback(
  app: express.Express
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('Capa 1 · Generación automática de Build ID, version.json y estampado de sw.js', async (t) => {
  await t.test('generateBuildId incluye timestamp UTC, commit SHA sanitizado y entropía', () => {
    const id = generateBuildId({
      env: { RENDER_GIT_COMMIT: 'a1b2c3d4e5f6' },
      now: new Date('2026-11-25T19:50:12.000Z'),
      randomHex: '9f8e7d',
    });
    assert.equal(id, '20261125T195012Z-a1b2c3d-9f8e7d');
    assert.equal(isValidProductionBuildId(id), true);

    const a = generateBuildId({ env: {} });
    const b = generateBuildId({ env: {} });
    assert.notEqual(a, b, 'Dos compilaciones consecutivas deben producir buildId distintos');
  });

  await t.test('createBuildVersionPlugin emite version.json y estampa dist/sw.js sin mutar public/sw.js', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codizulca-build-ver-'));
    try {
      const swPath = path.join(tmpDir, 'sw.js');
      fs.writeFileSync(swPath, `const APP_BUILD_ID = '${BUILD_ID_PLACEHOLDER}';\n`, 'utf8');

      const plugin = createBuildVersionPlugin({
        appName: 'trade-marketing',
        buildId: '20261125T200000Z-deadbe',
        builtAt: '2026-11-25T20:00:00.000Z',
        stampFiles: ['sw.js'],
      });

      const cfg = plugin.config();
      assert.equal(cfg.define.__APP_BUILD_ID__, '"20261125T200000Z-deadbe"');

      plugin.configResolved({ root: tmpDir, build: { outDir: tmpDir }, base: '/' });

      const emitted: Array<{ fileName: string; source: string }> = [];
      plugin.generateBundle.call({
        emitFile(file) {
          emitted.push({ fileName: file.fileName, source: file.source });
        },
      });

      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].fileName, 'version.json');
      const parsed = JSON.parse(emitted[0].source);
      assert.equal(parsed.app, 'trade-marketing');
      assert.equal(parsed.buildId, '20261125T200000Z-deadbe');

      plugin.closeBundle.handler();
      const stampedSw = fs.readFileSync(swPath, 'utf8');
      assert.ok(stampedSw.includes('20261125T200000Z-deadbe'));
      assert.equal(stampedSw.includes(BUILD_ID_PLACEHOLDER), false);

      // Re-estampar es idempotente
      assert.equal(stampServiceWorkerFile(swPath, 'otra'), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('Configuraciones Vite raíz y /logistica integran el plugin y excluyen version.json de precache', () => {
    const rootVite = readRepoFile('vite.config.ts');
    const rutaVite = readRepoFile('ruta-degustacion/vite.config.ts');
    assert.match(rootVite, /createBuildVersionPlugin/);
    assert.match(rutaVite, /createBuildVersionPlugin/);
    assert.match(rutaVite, /globIgnores:\s*\[\s*'(\*\*\/)?version\.json'\s*\]/);
  });
});

test('Capa 2 · Cabeceras HTTP anti-caché y fin de cache poisoning en Express SPA', async (t) => {
  await t.test('isStaticAssetRequestPath distingue rutas SPA de archivos estáticos y chunks', () => {
    assert.equal(isStaticAssetRequestPath('/assets/ExecutiveDashboard-OLD.js'), true);
    assert.equal(isStaticAssetRequestPath('/logistica/assets/index-abc123.css'), true);
    assert.equal(isStaticAssetRequestPath('/version.json'), true);
    assert.equal(isStaticAssetRequestPath('/sw.js?v=1'), true);
    assert.equal(isStaticAssetRequestPath('/icons/icon-192.png'), true);

    assert.equal(isStaticAssetRequestPath('/'), false);
    assert.equal(isStaticAssetRequestPath('/portal'), false);
    assert.equal(isStaticAssetRequestPath('/portal/asistencia'), false);
    assert.equal(isStaticAssetRequestPath('/promotoras'), false);
    assert.equal(isStaticAssetRequestPath('/logistica/'), false);
  });

  await t.test('mountSpaRoutes sirve no-store en HTML/version/SW, immutable en /assets y 404 real en chunks faltantes', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codizulca-spa-cache-'));
    try {
      const distMain = path.join(tmpRoot, 'dist');
      const distRuta = path.join(tmpRoot, 'dist-ruta');
      fs.mkdirSync(path.join(distMain, 'assets'), { recursive: true });
      fs.mkdirSync(path.join(distRuta, 'assets'), { recursive: true });

      fs.writeFileSync(path.join(distMain, 'index.html'), '<!doctype html><html><body>MAIN</body></html>');
      fs.writeFileSync(path.join(distMain, 'version.json'), '{"app":"trade-marketing","buildId":"b-main-1"}');
      fs.writeFileSync(path.join(distMain, 'sw.js'), 'self.skipWaiting();');
      fs.writeFileSync(path.join(distMain, 'assets', 'app-abc123.js'), 'console.log("ok");');

      fs.writeFileSync(path.join(distRuta, 'index.html'), '<!doctype html><html><body>RUTA</body></html>');
      fs.writeFileSync(path.join(distRuta, 'version.json'), '{"app":"ruta-degustacion","buildId":"b-ruta-1"}');
      fs.writeFileSync(path.join(distRuta, 'assets', 'ruta-def456.js'), 'console.log("ruta");');

      const app = express();
      mountSpaRoutes(app, '/logistica', distRuta, 'logistica');
      mountSpaRoutes(app, '/', distMain, 'torre');

      const srv = await listenLoopback(app);
      try {
        // 1. Documento raíz y rutas SPA -> 200 HTML + no-store estricto
        const resHome = await fetch(`${srv.base}/portal/asistencia`);
        assert.equal(resHome.status, 200);
        assert.match(resHome.headers.get('content-type') ?? '', /text\/html/i);
        assert.equal(resHome.headers.get('cache-control'), NO_STORE_CACHE_CONTROL);
        assert.equal(resHome.headers.get('pragma'), 'no-cache');

        // 2. version.json -> 200 JSON + no-store
        const resVer = await fetch(`${srv.base}/version.json`);
        assert.equal(resVer.status, 200);
        assert.match(resVer.headers.get('content-type') ?? '', /application\/json/i);
        assert.equal(resVer.headers.get('cache-control'), NO_STORE_CACHE_CONTROL);

        // 3. sw.js -> 200 + no-store + Service-Worker-Allowed
        const resSw = await fetch(`${srv.base}/sw.js`);
        assert.equal(resSw.status, 200);
        assert.equal(resSw.headers.get('cache-control'), NO_STORE_CACHE_CONTROL);
        assert.equal(resSw.headers.get('service-worker-allowed'), '/');

        // 4. Asset con hash existente -> 200 + immutable 1 año
        const resAsset = await fetch(`${srv.base}/assets/app-abc123.js`);
        assert.equal(resAsset.status, 200);
        assert.equal(resAsset.headers.get('cache-control'), IMMUTABLE_ASSET_CACHE_CONTROL);

        // 5. CRÍTICO: Chunk viejo inexistente -> 404 text/plain + no-store (JAMÁS 200 index.html)
        const resMissingMain = await fetch(`${srv.base}/assets/ExecutiveDashboard-OLDHASH.js`);
        assert.equal(resMissingMain.status, 404);
        assert.equal(resMissingMain.headers.get('cache-control'), NO_STORE_CACHE_CONTROL);
        assert.ok(!(resMissingMain.headers.get('content-type') ?? '').includes('text/html'));

        const resMissingRuta = await fetch(`${srv.base}/logistica/assets/ChoferView-OLD.js`);
        assert.equal(resMissingRuta.status, 404);
        assert.equal(resMissingRuta.headers.get('cache-control'), NO_STORE_CACHE_CONTROL);
        assert.ok(!(resMissingRuta.headers.get('content-type') ?? '').includes('text/html'));

        // 6. Redirección `/logistica?modo=chofer` -> `/logistica/?modo=chofer`
        const resRedirect = await fetch(`${srv.base}/logistica?modo=chofer`, { redirect: 'manual' });
        assert.equal(resRedirect.status, 302);
        assert.equal(resRedirect.headers.get('location'), '/logistica/?modo=chofer');
      } finally {
        await srv.close();
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

test('Capa 3 · Blindaje estático del Service Worker y registro updateViaCache none', () => {
  const swSrc = readRepoFile('public/sw.js');
  assert.match(swSrc, /const APP_BUILD_ID = '__APP_BUILD_ID__'/);
  assert.ok(!/codizulca-trade-shell-v335/.test(swSrc), 'No debe quedar versión manual quemada');
  assert.match(swSrc, /\/version\.json/);
  assert.match(swSrc, /!isHtmlResponse\(/);
  assert.match(swSrc, /cache:\s*'reload'/);

  const tradeReg = readRepoFile('src/lib/registerTradeSw.ts');
  assert.match(tradeReg, /updateViaCache:\s*'none'/);
  assert.match(tradeReg, /controllerchange/);

  const rutaReg = readRepoFile('ruta-degustacion/src/lib/registerSw.ts');
  assert.match(rutaReg, /updateViaCache:\s*'none'/);
});

test('Capas 4 y 5 · Guardián de versión cliente, purga selectiva, anti-bucle y recuperación de chunks', async (t) => {
  await t.test('purgeStaticShellCaches purga solo prefijos del App Shell y conserva otras cachés', async () => {
    const fake = createFakeCacheStorage([
      'codizulca-trade-shell-v335',
      'codizulca-trade-shell-20261125T190000Z-abc123',
      'rutadegustacion-fuentes',
    ]);
    const deleted = await purgeStaticShellCaches(['codizulca-trade-'], fake.cacheStorage);
    assert.deepEqual(deleted.sort(), [
      'codizulca-trade-shell-20261125T190000Z-abc123',
      'codizulca-trade-shell-v335',
    ]);
    assert.deepEqual(fake.remainingKeys(), ['rutadegustacion-fuentes']);
  });

  await t.test('fetchServerBuildId rechaza respuestas HTML accidentales y valida JSON real', async () => {
    const htmlFetch: typeof fetch = async () =>
      new Response('<html>fallback</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    assert.equal(await fetchServerBuildId({ fetchImpl: htmlFetch }), null);

    const jsonFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ app: 'trade-marketing', buildId: '20261125T201500Z-123456' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    assert.equal(await fetchServerBuildId({ fetchImpl: jsonFetch }), '20261125T201500Z-123456');
  });

  await t.test('checkAndApplyAppUpdate recarga automáticamente ante build nuevo, respeta anti-bucle y protege formularios', async () => {
    const storage = createMemoryStorage();
    const fakeCaches = createFakeCacheStorage(['codizulca-trade-shell-old1']);
    let reloadCount = 0;

    const makeFetch = (remoteBuildId: string): typeof fetch => async () =>
      new Response(JSON.stringify({ buildId: remoteBuildId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    // 1. Misma versión -> no recarga ni borra caché
    const sameRes = await checkAndApplyAppUpdate({
      localBuildId: '20261125T190000Z-aaa111',
      fetchImpl: makeFetch('20261125T190000Z-aaa111'),
      storage,
      cacheStorage: fakeCaches.cacheStorage,
      reload: () => {
        reloadCount += 1;
      },
      now: 10_000,
    });
    assert.equal(sameRes.status, 'up-to-date');
    assert.equal(reloadCount, 0);
    assert.equal(fakeCaches.remainingKeys().length, 1);

    // 2. Nueva versión mientras el usuario escribe en un input -> difiere sin recargar
    const fakeEditingDoc = {
      body: {},
      documentElement: {},
      activeElement: { tagName: 'INPUT', type: 'text', isContentEditable: false },
    } as unknown as Document;

    const deferredRes = await checkAndApplyAppUpdate({
      localBuildId: '20261125T190000Z-aaa111',
      fetchImpl: makeFetch('20261125T200000Z-bbb222'),
      storage,
      cacheStorage: fakeCaches.cacheStorage,
      doc: fakeEditingDoc,
      respectActiveInput: true,
      reload: () => {
        reloadCount += 1;
      },
      now: 20_000,
    });
    assert.equal(deferredRes.status, 'deferred');
    assert.equal(reloadCount, 0);

    // 3. Nueva versión sin edición activa -> purga caché estática y recarga una sola vez
    const reloadRes = await checkAndApplyAppUpdate({
      localBuildId: '20261125T190000Z-aaa111',
      fetchImpl: makeFetch('20261125T200000Z-bbb222'),
      storage,
      cacheStorage: fakeCaches.cacheStorage,
      doc: null,
      reload: () => {
        reloadCount += 1;
      },
      now: 30_000,
    });
    assert.equal(reloadRes.status, 'reloading');
    assert.equal(reloadCount, 1);
    assert.deepEqual(fakeCaches.remainingKeys(), []);

    // 4. Protección anti-bucle: mismo buildId dentro de los 60s NO vuelve a recargar
    const loopBlockedRes = await checkAndApplyAppUpdate({
      localBuildId: '20261125T190000Z-aaa111',
      fetchImpl: makeFetch('20261125T200000Z-bbb222'),
      storage,
      cacheStorage: fakeCaches.cacheStorage,
      doc: null,
      reload: () => {
        reloadCount += 1;
      },
      now: 45_000,
    });
    assert.equal(loopBlockedRes.status, 'deferred');
    assert.equal(reloadCount, 1);

    // 5. Modo offline -> nunca fuerza recarga
    const offlineRes = await checkAndApplyAppUpdate({
      localBuildId: '20261125T190000Z-aaa111',
      fetchImpl: makeFetch('20261125T210000Z-ccc333'),
      storage,
      cacheStorage: fakeCaches.cacheStorage,
      isOnline: false,
      reload: () => {
        reloadCount += 1;
      },
      now: 50_000,
    });
    assert.equal(offlineRes.status, 'skipped');
    assert.equal(reloadCount, 1);
  });

  await t.test('isChunkLoadErrorMessage identifica errores de módulos dinámicos tras despliegue', () => {
    assert.equal(
      isChunkLoadErrorMessage(new TypeError('Failed to fetch dynamically imported module: /assets/Foo.js')),
      true
    );
    assert.equal(isChunkLoadErrorMessage(new Error('Importing a module script failed.')), true);
    assert.equal(isChunkLoadErrorMessage(new Error('ChunkLoadError: Loading chunk 42 failed')), true);
    assert.equal(isChunkLoadErrorMessage(new Error('Unable to preload CSS for /assets/style.css')), true);
    assert.equal(isChunkLoadErrorMessage(new Error('Credenciales incorrectas')), false);
  });
});
