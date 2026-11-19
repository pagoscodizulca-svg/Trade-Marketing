import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  MIN_HSTS_MAX_AGE_SECONDS,
  SecurityEnvViolationError,
  UNAUTHORIZED_PROBE_ORIGIN,
  redactSecrets,
  resolveDeploymentTargetConfig,
  verifyLiveDeploymentHeaders,
} from '../scripts/verifyLiveDeploymentHeaders';
import {
  buildApiOriginGuard,
  buildCorsMiddleware,
  buildSecurityHeaders,
  parseAllowedOrigins,
} from '../src/server/securityMiddleware';

const ROOT = process.cwd();
const readRepoFile = (relPath: string): string =>
  fs.readFileSync(path.join(ROOT, relPath), 'utf8');

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

test('Compuerta G4 · Unificación en npm, exclusiones .dockerignore y destilación rules/AGENTS.md', async (t) => {
  await t.test('1. Eliminación total de artefactos Bun y estandarización en npm + package-lock.json', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'bun.lock')), false, 'bun.lock no debe existir');
    assert.equal(fs.existsSync(path.join(ROOT, 'bun.lockb')), false, 'bun.lockb no debe existir');
    assert.equal(
      fs.existsSync(path.join(ROOT, '.bun-version')),
      false,
      '.bun-version no debe existir'
    );
    assert.equal(
      fs.existsSync(path.join(ROOT, 'package-lock.json')),
      true,
      'package-lock.json raíz obligatorio'
    );
    assert.equal(
      fs.existsSync(path.join(ROOT, 'ruta-degustacion', 'package-lock.json')),
      true,
      'ruta-degustacion/package-lock.json obligatorio'
    );

    const gitignore = readRepoFile('.gitignore');
    const dockerignore = readRepoFile('.dockerignore');
    for (const entry of ['bun.lock', 'bun.lockb', '.bun-version']) {
      assert.match(gitignore, new RegExp(`^${entry.replace('.', '\\.')}$`, 'm'));
      assert.match(dockerignore, new RegExp(`^${entry.replace('.', '\\.')}$`, 'm'));
    }

    const dockerfile = readRepoFile('Dockerfile');
    const ciYaml = readRepoFile('.github/workflows/ci.yml');
    assert.match(dockerfile, /npm ci/);
    assert.match(dockerfile, /npm --prefix ruta-degustacion ci/);
    assert.match(dockerfile, /npm ci --omit=dev/);
    assert.ok(!/\bbun\s+(install|ci|run)\b/i.test(dockerfile), 'Dockerfile 100% npm');
    assert.ok(!/\bbun\s+(install|ci|run)\b/i.test(ciYaml), 'CI workflow 100% npm');
  });

  await t.test('2. .dockerignore excluye todos los archivos de secretos del contexto Docker', () => {
    const dockerignore = readRepoFile('.dockerignore');
    assert.match(dockerignore, /^\.env$/m);
    assert.match(dockerignore, /^\.env\.\*$/m);
    assert.match(dockerignore, /^!\.env\.example$/m);
    assert.match(dockerignore, /^src\/config\/env\.js$/m);
    assert.match(dockerignore, /^ruta-degustacion\/\.env$/m);
    assert.match(dockerignore, /^ruta-degustacion\/\.env\.\*$/m);
    assert.match(dockerignore, /^qa-sync-suite\/\.env\.test$/m);
  });

  await t.test('3. rules/AGENTS.md documenta secciones permanentes 7 (Inspect-Before-Create) y 8 (5 Regiones + Email)', () => {
    const agentsDoc = readRepoFile('rules/AGENTS.md');
    assert.match(agentsDoc, /## 7\. Política "Inspect-Before-Create" y Cero DDL Destructivo en Supabase/);
    for (const token of [
      'information_schema.tables',
      'information_schema.columns',
      'pg_policies',
      'supabase_migrations.schema_migrations',
      'DROP TABLE',
      'DROP COLUMN',
      'TRUNCATE',
      'ALTER TYPE ... ADD VALUE IF NOT EXISTS',
    ]) {
      assert.ok(agentsDoc.includes(token), `rules/AGENTS.md debe incluir "${token}"`);
    }

    assert.match(agentsDoc, /## 8\. Modelo Oficial de las 5 Regiones Activas \(`public\.regiones`\) y Login por Correo/);
    for (const hub of ['Zulia', 'Valencia', 'Centro', 'Oriente', 'Capital']) {
      assert.ok(agentsDoc.includes(`**${hub}**`), `rules/AGENTS.md debe listar región ${hub}`);
    }
    for (const token of [
      "LOWER(TRIM(auth.jwt() ->> 'email'))",
      'RegionGateSelector',
      'x-sucursal-activa',
      'rpc_comparativo_regiones_resumen',
    ]) {
      assert.ok(agentsDoc.includes(token), `rules/AGENTS.md debe documentar "${token}"`);
    }
  });
});

test('Compuerta G4 · verifyLiveDeploymentHeaders (Zero-Trust + Cabeceras + CORS)', async (t) => {
  await t.test('1. Zero-Trust estático: cero dotenv, cero lecturas .env*, bloqueo VITE_* secreto y redacción', () => {
    const scriptSrc = readRepoFile('scripts/verifyLiveDeploymentHeaders.ts');
    const codeOnly = scriptSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bdotenv\b/.test(codeOnly), 'Prohibido importar dotenv');
    assert.ok(!/readFileSync|readFile/.test(codeOnly), 'Prohibido leer archivos de entorno desde disco');
    assert.ok(!/\bconsole\.log\b/.test(codeOnly), 'Salida CLI redactada vía stdout sin console.log crudo');

    // Rechaza sb_secret_ en VITE_*
    assert.throws(
      () =>
        resolveDeploymentTargetConfig({
          env: {
            DEPLOY_BASE_URL: 'https://torre.codizulca.com',
            VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_fuga_critica_12345',
          },
        }),
      (err: unknown) =>
        err instanceof SecurityEnvViolationError && err.code === 'SECRET_IN_VITE_ENV'
    );

    // Rechaza ausencia de DEPLOY_BASE_URL / RENDER_EXTERNAL_URL
    assert.throws(
      () => resolveDeploymentTargetConfig({ env: {} }),
      (err: unknown) =>
        err instanceof SecurityEnvViolationError && err.code === 'MISSING_DEPLOY_BASE_URL'
    );

    // Rechaza credenciales embebidas en URL
    assert.throws(
      () =>
        resolveDeploymentTargetConfig({
          env: { DEPLOY_BASE_URL: 'https://admin:secret@torre.codizulca.com' },
        }),
      (err: unknown) =>
        err instanceof SecurityEnvViolationError && err.code === 'CREDENTIALS_IN_DEPLOY_URL'
    );

    // Redacción efectiva de JWTs y sb_secret_*
    const fakeServiceJwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.firma_super_secreta';
    const redacted = redactSecrets(`Bearer ${fakeServiceJwt} key=sb_secret_999888777`);
    assert.ok(!redacted.includes('firma_super_secreta'));
    assert.ok(!redacted.includes('999888777'));
    assert.match(redacted, /\[REDACTED_JWT\]/);
    assert.match(redacted, /\[REDACTED_SB_SECRET\]/);
  });

  await t.test('2. Certificación positiva completa contra servidor Express local con cabeceras de producción', async () => {
    const allowedOrigins = parseAllowedOrigins(
      'https://torre.codizulca.com, https://portal.codizulca.com'
    );
    const app = express();
    app.disable('x-powered-by');
    for (const mw of buildSecurityHeaders({ isProduction: true })) {
      app.use(mw);
    }
    app.use('/api', buildCorsMiddleware({ allowedOrigins, isProduction: true }));
    app.use('/api', buildApiOriginGuard({ allowedOrigins, isProduction: true }));
    app.get('/api/health', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ status: 'ok' });
    });

    const srv = await listenLoopback(app);
    try {
      const report = await verifyLiveDeploymentHeaders({
        env: {
          RENDER_EXTERNAL_URL: srv.base,
          CORS_ALLOWED_ORIGINS: 'https://torre.codizulca.com, https://portal.codizulca.com',
        },
      });

      assert.equal(
        report.passed,
        true,
        `Todos los chequeos deben aprobar: ${JSON.stringify(report.checks)}`
      );

      const byId = new Map(report.checks.map((c) => [c.id, c]));
      assert.equal(byId.get('health.status_and_no_store')?.passed, true);
      assert.equal(byId.get('headers.content_security_policy')?.passed, true);
      assert.equal(byId.get('headers.strict_transport_security')?.passed, true);
      assert.equal(byId.get('headers.nosniff_and_no_powered_by')?.passed, true);
      assert.equal(byId.get('cors.allowed_origin_match')?.passed, true);
      assert.equal(byId.get('cors.unauthorized_origin_blocked')?.passed, true);
    } finally {
      await srv.close();
    }
  });

  await t.test('3. Detección determinista de regresiones mediante fetchImpl inyectado (CSP débil, HSTS corto, X-Powered-By, fuga CORS)', async () => {
    const insecureFetch: typeof fetch = async (_input, init) => {
      const reqHeaders = new Headers(init?.headers);
      const origin = reqHeaders.get('origin');
      const resHeaders = new Headers({
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60',
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
        'strict-transport-security': `max-age=${MIN_HSTS_MAX_AGE_SECONDS - 100}`,
        'x-powered-by': 'Express',
      });
      if (origin === UNAUTHORIZED_PROBE_ORIGIN) {
        resHeaders.set('access-control-allow-origin', '*');
      }
      return new Response(JSON.stringify({ status: 'ok', ports: { http: 3000 } }), {
        status: 200,
        headers: resHeaders,
      });
    };

    const report = await verifyLiveDeploymentHeaders({
      env: {
        DEPLOY_BASE_URL: 'https://staging.codizulca.invalid',
        EXPECTED_ALLOWED_ORIGIN: 'https://torre.codizulca.com',
      },
      fetchImpl: insecureFetch,
    });

    assert.equal(report.passed, false);
    const byId = new Map(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.get('health.status_and_no_store')?.passed, false);
    assert.equal(byId.get('headers.content_security_policy')?.passed, false);
    assert.equal(byId.get('headers.strict_transport_security')?.passed, false);
    assert.equal(byId.get('headers.nosniff_and_no_powered_by')?.passed, false);
    assert.equal(byId.get('cors.allowed_origin_match')?.passed, false);
    assert.equal(byId.get('cors.unauthorized_origin_blocked')?.passed, false);
  });
});
