import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { analyzeMigrations, formatIssues, type MigrationFile } from './support/sqlMigrationAnalyzer';
import {
  createMemoryRateLimitStore,
  createRateLimiter,
  type RateLimitStore,
} from '../src/server/supabaseAdminAuth';
import { createLogger, redactString, redactValue } from '../src/server/logger';
import {
  buildApiOriginGuard,
  buildCorsMiddleware,
  buildSecurityHeaders,
  isOriginAllowed,
  parseAllowedOrigins,
} from '../src/server/securityMiddleware';
import {
  MAX_XLSX_ROWS_PER_SHEET,
  UnsupportedSpreadsheetError,
  loadXlsxAsSheetShim,
  readFirstSheetAsStringMatrix,
} from '../src/utils/excelSheetShim';
import { extractTabularDegustacionFile } from '../src/utils/degustacionesTabularParser';
import { convertirWorkbookBufferAMatriz } from '../src/services/masterDataSyncService';
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function toAB(buf: Buffer | ArrayBuffer | Uint8Array): ArrayBuffer {
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('Hito 6 · P-04/S-02 limitador de tasa distribuido', async (t) => {
  await t.test('migración 20261118000900: solo service_role, RLS forzoso, sin DDL destructivo', () => {
    const dir = path.join(ROOT, 'supabase', 'migrations');
    const files: MigrationFile[] = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
    const result = analyzeMigrations(files);
    assert.equal(result.errors.length, 0, formatIssues(result.errors));

    const sql = files.find((f) => f.name.startsWith('20261118000900'))!.sql;
    assert.match(sql, /ALTER TABLE public\.api_rate_limits FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.api_rate_limits FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.rpc_rate_limit_hit\(TEXT, INTEGER, INTEGER\) TO service_role/);
    assert.ok(!/GRANT EXECUTE[^;]*rpc_rate_limit_hit[^;]*(authenticated|anon)/i.test(sql));
    assert.ok(!/\bDROP\s+TABLE\b|\bTRUNCATE\b/i.test(sql));
  });

  await t.test('dos instancias comparten el contador del almacén y responden 429', async () => {
    const counters = new Map<string, number>();
    const shared: RateLimitStore = {
      async hit(key, _w, max) {
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        return { allowed: n <= max };
      },
    };
    const mk = () => {
      const app = express();
      app.use('/x', createRateLimiter({ windowMs: 60_000, maxRequests: 2, name: 't', store: shared }));
      app.get('/x', (_req, res) => res.json({ ok: true }));
      return app;
    };
    const a = await listen(mk());
    const b = await listen(mk());
    try {
      const codes: number[] = [];
      for (const base of [a.base, b.base, a.base, b.base]) {
        codes.push((await fetch(`${base}/x`)).status);
      }
      assert.deepEqual(codes, [200, 200, 429, 429]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  await t.test('si el almacén falla, degrada a memoria (no cae el servicio) y sigue limitando', async () => {
    const broken: RateLimitStore = {
      async hit() {
        throw new Error('db down');
      },
    };
    const app = express();
    app.use('/y', createRateLimiter({ windowMs: 60_000, maxRequests: 1, store: broken }));
    app.get('/y', (_req, res) => res.json({ ok: true }));
    const s = await listen(app);
    try {
      assert.equal((await fetch(`${s.base}/y`)).status, 200);
      assert.equal((await fetch(`${s.base}/y`)).status, 429);
    } finally {
      await s.close();
    }
  });

  await t.test('almacén en memoria respeta la ventana', async () => {
    const store = createMemoryRateLimitStore();
    assert.equal((await store.hit('k', 60_000, 1)).allowed, true);
    assert.equal((await store.hit('k', 60_000, 1)).allowed, false);
    assert.equal((await store.hit('otra', 60_000, 1)).allowed, true);
  });
});

test('Hito 6 · M-05 logger JSON con redacción', async (t) => {
  await t.test('redacta JWT, llaves Supabase, Bearer y claves sensibles', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.firmafirmafirma';
    assert.equal(redactString(`token ${jwt}`), 'token [REDACTED_JWT]');
    assert.ok(!redactString('k sb_secret_abcdef123456').includes('abcdef'));
    assert.ok(!redactString('Authorization: Bearer abcdefghijklmnop1234').includes('abcdefghijklmnop'));
    assert.ok(!redactString('/x?token=abc123&y=1').includes('abc123'));

    const out = redactValue({
      password: 'hunter2',
      authorization: 'Bearer zzzzzzzzzzzzzzzz',
      nested: { apiKey: 'k', ok: 'visible' },
      list: [jwt],
    }) as Record<string, unknown>;
    assert.equal(out.password, '[REDACTED]');
    assert.equal(out.authorization, '[REDACTED]');
    assert.equal((out.nested as Record<string, unknown>).apiKey, '[REDACTED]');
    assert.equal((out.nested as Record<string, unknown>).ok, 'visible');
    assert.deepEqual(out.list, ['[REDACTED_JWT]']);
  });

  await t.test('emite una línea JSON válida y respeta el nivel mínimo', () => {
    const lines: string[] = [];
    const log = createLogger({
      minLevel: 'warn',
      sink: { write: (l) => lines.push(l) },
      base: { service: 'test' },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    log.info('ignorado');
    log.error('fallo', { err: new Error('boom sb_secret_zzzz1234'), password: 'x' });
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.level, 'error');
    assert.equal(rec.service, 'test');
    assert.equal(rec.ts, '2026-01-01T00:00:00.000Z');
    assert.equal(rec.password, '[REDACTED]');
    assert.ok(!lines[0].includes('zzzz1234'));
  });
});

test('Hito 6 · P-04 helmet, CSP y CORS por origen', async (t) => {
  await t.test('parseo y reglas de orígenes', () => {
    assert.deepEqual(parseAllowedOrigins('https://a.com, http://b.com:8080/ruta, javascript:x, ,nope'), [
      'https://a.com',
      'http://b.com:8080',
    ]);
    assert.equal(isOriginAllowed(undefined, [], true), true);
    assert.equal(isOriginAllowed('https://a.com', ['https://a.com'], true), true);
    assert.equal(isOriginAllowed('https://evil.com', ['https://a.com'], true), false);
    assert.equal(isOriginAllowed('http://localhost:5173', [], true), false);
    assert.equal(isOriginAllowed('http://localhost:5173', [], false), true);
  });

  await t.test('producción: CSP estricta, HSTS y bloqueo de origen no autorizado', async () => {
    const app = express();
    for (const mw of buildSecurityHeaders({ isProduction: true })) app.use(mw);
    app.use('/api', buildCorsMiddleware({ allowedOrigins: ['https://app.codizulca.com'], isProduction: true }));
    app.use('/api', buildApiOriginGuard({ allowedOrigins: ['https://app.codizulca.com'], isProduction: true }));
    app.get('/', (_q, r) => r.send('ok'));
    app.get('/api/ping', (_q, r) => r.json({ ok: true }));
    const s = await listen(app);
    try {
      const home = await fetch(`${s.base}/`);
      const csp = home.headers.get('content-security-policy') || '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /connect-src[^;]*https:\/\/\*\.supabase\.co/);
      assert.match(home.headers.get('strict-transport-security') || '', /max-age=\d+/);
      assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
      assert.match(home.headers.get('permissions-policy') || '', /geolocation=\(self\)/);
      assert.equal(home.headers.get('x-powered-by'), null);

      const ok = await fetch(`${s.base}/api/ping`, { headers: { Origin: 'https://app.codizulca.com' } });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.codizulca.com');

      const evil = await fetch(`${s.base}/api/ping`, { headers: { Origin: 'https://evil.example' } });
      assert.equal(evil.status, 403);
      assert.equal(evil.headers.get('access-control-allow-origin'), null);
    } finally {
      await s.close();
    }
  });

  await t.test('server.ts: health mínimo, métricas protegidas y SPA unificado', () => {
    const src = read('server.ts');
    assert.match(src, /buildSecurityHeaders/);
    assert.match(src, /buildCorsMiddleware/);
    assert.match(src, /res\.json\(\{ status: 'ok' \}\)/);
    assert.ok(!/rutaDegustacionActive|ports:\s*\{/.test(src), '/api/health no debe revelar puertos');
    assert.match(src, /'\/api\/admin\/metrics',\s*requireSuperAdminAuth/);
    assert.match(src, /serveSpa\('\/logistica'/);
    assert.match(src, /dist-server/);
  });
});

test('Hito 6 · S-01/P-03 lectura Excel sin SheetJS', async (t) => {
  const ExcelJS = (await import('exceljs')).default;

  async function makeWorkbook(build: (wb: InstanceType<typeof ExcelJS.Workbook>) => void): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    build(wb);
    return toAB(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer));
  }

  await t.test('extrae degustaciones de un .xlsx real (fechas, merges, fórmulas, hoja oculta)', async () => {
    const buf = await makeWorkbook((wb) => {
      const hidden = wb.addWorksheet('Oculta');
      hidden.state = 'hidden';
      hidden.addRow(['FECHA', 'CLIENTE']);
      hidden.addRow(['01/01/2026', 'NO DEBE LEERSE']);

      const ws = wb.addWorksheet('Cronograma');
      ws.addRow(['CODIZULCA - PLANIFICACION']);
      ws.addRow([]);
      ws.addRow(['DIA', 'TURNO', 'CLIENTE', 'MORTADELA', 'ESPALDA', 'VENDEDOR', 'PROMOTORA']);
      ws.addRow(['16/11/2026', 'TARDE', 'FAMILIA CENTER, C.A.', { formula: '1+1', result: 2 }, 1.5, 'LUIS FDV', 'ANA']);
    });
    const out = await extractTabularDegustacionFile(buf, 'xlsx');
    assert.equal(out.selectedSheetName, 'Cronograma');
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].fecha, '2026-11-16');
    assert.equal(out.rows[0].turno, 'TARDE');
    assert.equal(out.rows[0].cantidadKilos, 3.5);
  });

  await t.test('fechas reales de Excel (celdas Date) se normalizan sin desfase de zona horaria', async () => {
    const buf = await makeWorkbook((wb) => {
      const ws = wb.addWorksheet('Octubre');
      ws.addRow(['DIA', 'TURNO', 'CLIENTE', 'MORTADELA']);
      ws.addRow([new Date(Date.UTC(2026, 9, 12)), 'MAÑANA', 'PDV A', 2]);
    });
    const out = await extractTabularDegustacionFile(buf, 'xlsx');
    assert.equal(out.rows[0]?.fecha, '2026-10-12');
  });

  await t.test('rechaza .xls binario (OLE), archivos no-ZIP, exceso de filas y archivos > 10 MB', async () => {
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await assert.rejects(loadXlsxAsSheetShim(ole), /\.xls\) ya no es compatible/);
    await assert.rejects(loadXlsxAsSheetShim(new TextEncoder().encode('<html>no es excel</html>')), UnsupportedSpreadsheetError);
    await assert.rejects(
      loadXlsxAsSheetShim(new Uint8Array(10 * 1024 * 1024 + 1)),
      /10 MB/
    );

    const big = await makeWorkbook((wb) => {
      const ws = wb.addWorksheet('Grande');
      ws.getCell(`A${MAX_XLSX_ROWS_PER_SHEET + 5}`).value = 'x';
    });
    const shim = await loadXlsxAsSheetShim(big);
    assert.throws(() => shim.Sheets['Grande'], /supera el límite/);
  });

  await t.test('importador de maestros usa la matriz de la primera hoja', async () => {
    const buf = await makeWorkbook((wb) => {
      const ws = wb.addWorksheet('Maestros');
      ws.addRow(['codigo', 'nombre']);
      ws.addRow(['C-1', 'Cliente Uno']);
    });
    assert.deepEqual(await convertirWorkbookBufferAMatriz(buf), [
      ['codigo', 'nombre'],
      ['C-1', 'Cliente Uno'],
    ]);
    assert.deepEqual(await readFirstSheetAsStringMatrix(buf), [
      ['codigo', 'nombre'],
      ['C-1', 'Cliente Uno'],
    ]);
  });

  await t.test('package.json: xlsx fuera de producción, helmet/cors/exceljs presentes', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.dependencies.xlsx, undefined, 'xlsx no debe ser dependencia de producción');
    assert.ok(pkg.devDependencies.xlsx, 'xlsx solo como devDependency (fixtures de scripts)');
    for (const d of ['helmet', 'cors', 'exceljs', 'docx', 'read-excel-file']) {
      assert.ok(pkg.dependencies[d], `falta ${d}`);
    }
    const srcFiles = ['src/utils/degustacionesTabularParser.ts', 'src/services/masterDataSyncService.ts', 'src/utils/excelWorkbookReader.ts'];
    for (const f of srcFiles) {
      assert.ok(!/from 'xlsx'|import\('xlsx'\)/.test(read(f)), `${f} no debe importar xlsx`);
    }
  });
});

test('Hito 6 · B-09/P-06 despliegue, CI y ErrorBoundary', async (t) => {
  await t.test('engines LTS, scripts de build/test y servidor compilado', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.engines.node, /^>=22/);
    assert.equal(pkg.engines.bun, undefined);
    assert.match(pkg.scripts.start, /node dist-server\/server\.js/);
    assert.ok(!/tsx/.test(pkg.scripts.start), 'producción sin tsx');
    assert.match(pkg.scripts['build:server'], /esbuild server\.ts/);
    assert.match(pkg.scripts['build:logistica'], /ruta-degustacion/);
    assert.match(pkg.scripts['build:all'], /build:web.*build:logistica.*build:server/);
    // Render (`bun run build`) debe producir Torre + logística + servidor compilado y bajar deps de ruta-degustacion
    assert.match(pkg.scripts.build, /ruta-degustacion ci/);
    assert.match(pkg.scripts.build, /build:all/);
    assert.match(pkg.scripts.test, /--test/);
    assert.match(pkg.scripts['audit:prod'], /--omit=dev --audit-level=high/);
  });

  await t.test('sin _redirects; Dockerfile multi-etapa, no-root y sin secretos', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'public', '_redirects')), false);
    const docker = read('Dockerfile');
    assert.ok((docker.match(/^FROM /gm) || []).length >= 3);
    assert.match(docker, /USER node/);
    assert.match(docker, /HEALTHCHECK/);
    assert.match(docker, /CMD \["node", "dist-server\/server\.js"\]/);
    const dockerCode = docker
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    assert.ok(!/SERVICE_ROLE|sb_secret_|service_role|OPENAI_API_KEY|CRON_SECRET/.test(dockerCode));
    assert.ok(!/ARG\s+SUPABASE_SERVICE/.test(dockerCode));
    const ignore = read('.dockerignore');
    assert.match(ignore, /^\.env$/m);
    assert.match(ignore, /qa-sync-suite\/\.env\.test/);
  });

  await t.test('ruta-degustacion se publica bajo /logistica/', () => {
    assert.match(read('ruta-degustacion/vite.config.ts'), /base: command === 'build' \? '\/logistica\/' : '\/'/);
    const manifest = JSON.parse(read('ruta-degustacion/public/manifest.json'));
    assert.equal(manifest.scope, '/logistica/');
    assert.match(manifest.start_url, /^\/logistica\//);
    for (const icon of manifest.icons) assert.match(icon.src, /^\/logistica\/icons\//);
    assert.match(read('ruta-degustacion/src/lib/registerSw.ts'), /import\.meta\.env\.BASE_URL/);
  });

  await t.test('CI: tsc, auditoría, certificador, pruebas y build', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const step of ['npx tsc --noEmit', 'audit:prod', 'certifySchemaProduction.ts --mode static', 'npm test', 'build:all']) {
      assert.ok(ci.includes(step), `CI sin paso: ${step}`);
    }
    assert.match(ci, /permissions:\s*\n\s*contents: read/);
  });

  await t.test('ErrorBoundary global montado y con estado de error sin filtrar detalles', () => {
    assert.match(read('src/main.tsx'), /<ErrorBoundary>/);
    const derived = ErrorBoundary.getDerivedStateFromError();
    assert.equal(derived.hasError, true);
    assert.match(derived.errorId, /^ERR-[A-Z0-9]+-[A-Z0-9]{4}$/);
    assert.ok(!/error\.message|error\.stack/.test(read('src/components/common/ErrorBoundary.tsx').split('render()')[1] ?? ''));
  });
});
