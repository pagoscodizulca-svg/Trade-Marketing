import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildMockJwt,
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
} from './antigravity_audit/localMockInfra';
import { checkMigrationNaming } from './support/sqlMigrationAnalyzer';
import { runStaticCertification } from '../scripts/certifySchemaProduction';
import {
  assertReadOnlySelectSql,
  assertSafeCatalogEnvironment,
  DEFAULT_SUPABASE_PROJECT_REF,
  discoverExistingSupabaseCatalog,
  formatDiscoverySummary,
  OFFICIAL_REGIONAL_HUBS,
  reconcileDuplicateMigrationPlan,
  redactCatalogOutput,
  sanitizeRegionRow,
  SecurityEnvViolationError,
  verifyOfficialRegionalHubs,
} from '../scripts/discoverExistingSupabaseCatalog';

const ROOT_DIR = process.cwd();

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('COMPUERTA G1 — Descubrimiento de Catálogo Supabase Solo Lectura y Reconciliación de Migraciones', async (t) => {
  await t.test('1) Higiene Zero-Trust: cero lectura de .env*, cero dotenv y guardia SQL estrictamente SELECT', () => {
    const source = fs.readFileSync(
      path.join(ROOT_DIR, 'scripts', 'discoverExistingSupabaseCatalog.ts'),
      'utf8'
    );

    assert.doesNotMatch(source, /from\s+['"]dotenv['"]/i);
    assert.doesNotMatch(source, /dotenv\.config/i);
    assert.doesNotMatch(source, /from\s+['"](?:node:)?fs['"]/i);
    assert.doesNotMatch(source, /readFileSync/i);
    assert.doesNotMatch(source, /\bconsole\.log\s*\(/);

    // Guardia de consultas SQL: permite SELECT/WITH de lectura y bloquea cualquier escritura o DDL
    assert.doesNotThrow(() =>
      assertReadOnlySelectSql('SELECT version, name FROM supabase_migrations.schema_migrations')
    );
    assert.doesNotThrow(() =>
      assertReadOnlySelectSql('WITH hubs AS (SELECT id FROM public.regiones) SELECT * FROM hubs')
    );
    for (const forbiddenSql of [
      'DELETE FROM public.regiones',
      'UPDATE public.regiones SET activo = false',
      'INSERT INTO public.regiones (nombre) VALUES (\'X\')',
      'WITH mut AS (DELETE FROM public.regiones RETURNING id) SELECT * FROM mut',
      'ALTER TABLE public.clientes ADD COLUMN temp_col text',
      'REVOKE SELECT ON public.regiones FROM authenticated',
    ]) {
      assert.throws(
        () => assertReadOnlySelectSql(forbiddenSql),
        /Operación bloqueada/i,
        `Debe bloquear SQL no-lectura: ${forbiddenSql}`
      );
    }
  });

  await t.test('2) Bloqueo de secretos en VITE_* y redacción exhaustiva de JWT, sb_secret_, sbp_ y URIs', async () => {
    const sampleSecret = 'sb_secret_G1_TEST_SECRET_888888';
    const sampleSbp = 'sbp_0123456789abcdef0123456789abcdef';
    const sampleDbUri = 'postgresql://postgres:supersecret@db.apaxdgxtaoeyswlfblgi.supabase.co:5432/postgres';

    assert.throws(
      () => assertSafeCatalogEnvironment({ VITE_SUPABASE_ANON_KEY: sampleSecret }),
      (err: unknown) => {
        assert.ok(err instanceof SecurityEnvViolationError);
        assert.equal(err.code, 'SECRET_IN_VITE_ENV');
        assert.ok(!err.message.includes(sampleSecret));
        return true;
      }
    );

    assert.throws(
      () => assertSafeCatalogEnvironment({ VITE_SUPABASE_ANON_KEY: MOCK_SERVICE_ROLE_KEY }),
      (err: unknown) => {
        assert.ok(err instanceof SecurityEnvViolationError);
        assert.equal(err.code, 'SERVICE_ROLE_JWT_IN_VITE_ENV');
        assert.ok(!err.message.includes(MOCK_SERVICE_ROLE_KEY));
        return true;
      }
    );

    assert.throws(
      () => assertSafeCatalogEnvironment({ VITE_SUPABASE_ACCESS_TOKEN: sampleSbp }),
      (err: unknown) => {
        assert.ok(err instanceof SecurityEnvViolationError);
        assert.equal(err.code, 'MANAGEMENT_TOKEN_IN_VITE_ENV');
        return true;
      }
    );

    assert.throws(
      () => assertSafeCatalogEnvironment({ VITE_DATABASE_URL: sampleDbUri }),
      (err: unknown) => {
        assert.ok(err instanceof SecurityEnvViolationError);
        assert.equal(err.code, 'DB_URI_IN_VITE_ENV');
        return true;
      }
    );

    // Jamás debe usar VITE_SUPABASE_URL como fallback silencioso
    await assert.rejects(
      () =>
        discoverExistingSupabaseCatalog({
          VITE_SUPABASE_URL: 'https://apaxdgxtaoeyswlfblgi.supabase.co',
          VITE_SUPABASE_ANON_KEY: MOCK_PUBLIC_ANON_KEY,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SecurityEnvViolationError);
        assert.equal(err.code, 'MISSING_DISCOVERY_CREDENTIALS');
        return true;
      }
    );

    const redacted = redactCatalogOutput(
      `jwt=${MOCK_SERVICE_ROLE_KEY} sec=${sampleSecret} pat=${sampleSbp} uri=${sampleDbUri}`
    );
    assert.ok(!redacted.includes(MOCK_SERVICE_ROLE_KEY));
    assert.ok(!redacted.includes(sampleSecret));
    assert.ok(!redacted.includes(sampleSbp));
    assert.ok(!redacted.includes('supersecret'));
    assert.match(redacted, /\[REDACTED_JWT\]/);
    assert.match(redacted, /\[REDACTED_SB_SECRET\]/);
    assert.match(redacted, /\[REDACTED_SBP_TOKEN\]/);
    assert.match(redacted, /\[REDACTED_DB_URI\]/);
  });

  await t.test('3) Sanitización de public.regiones y verificación de los 5 hubs oficiales', () => {
    const rawWithPii = {
      id: '11111111-1111-4111-8111-111111111101',
      codigo: 'ZULIA',
      nombre: 'Zulia',
      activo: true,
      internal_contact_email: 'privado@codizulca.com',
      api_token: 'sb_secret_SHOULD_NOT_APPEAR',
    };
    const clean = sanitizeRegionRow(rawWithPii);
    assert.deepEqual(Object.keys(clean).sort(), ['active', 'code', 'id', 'name']);
    assert.equal(clean.code, 'ZULIA');
    assert.equal(clean.name, 'Zulia');
    assert.equal(clean.active, true);
    assert.equal(JSON.stringify(clean).includes('privado@codizulca.com'), false);

    const allFiveRows = OFFICIAL_REGIONAL_HUBS.map((hub, idx) =>
      sanitizeRegionRow({
        id: `00000000-0000-4000-8000-00000000000${idx + 1}`,
        codigo: hub.toUpperCase(),
        nombre: hub,
        activo: true,
      })
    );
    const okHubs = verifyOfficialRegionalHubs(allFiveRows);
    assert.equal(okHubs.allFiveHubsPresentAndActive, true);
    assert.deepEqual(okHubs.confirmedHubs, [...OFFICIAL_REGIONAL_HUBS]);
    assert.deepEqual(okHubs.missingHubs, []);
    assert.deepEqual(okHubs.inactiveHubs, []);

    // Caso con Oriente faltante y Capital inactivo
    const partialRows = allFiveRows
      .filter((r) => r.code !== 'ORIENTE')
      .map((r) => (r.code === 'CAPITAL' ? { ...r, active: false } : r));
    const partialCheck = verifyOfficialRegionalHubs(partialRows);
    assert.equal(partialCheck.allFiveHubsPresentAndActive, false);
    assert.deepEqual(partialCheck.missingHubs, ['Oriente']);
    assert.deepEqual(partialCheck.inactiveHubs, ['Capital']);
  });

  await t.test('4) Descubrimiento offline vía Management API y fallback a PostgREST OpenAPI + RPC', async () => {
    const mgmtQueries: string[] = [];

    const mockManagementFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      assert.equal(
        url,
        `https://api.supabase.com/v1/projects/${DEFAULT_SUPABASE_PROJECT_REF}/database/query`
      );
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body || '{}')) as {
        query: string;
        read_only?: boolean;
      };
      assert.equal(body.read_only, true);
      mgmtQueries.push(body.query);

      if (body.query.includes('pg_catalog.pg_class')) {
        return jsonResponse(200, [
          { table_name: 'regiones', rls_enabled: true, force_rls: false },
          { table_name: 'clientes', rls_enabled: true, force_rls: true },
          { table_name: 'vendedores', rls_enabled: true, force_rls: true },
          { table_name: 'promotoras', rls_enabled: true, force_rls: true },
          { table_name: 'supervisores', rls_enabled: true, force_rls: false },
          { table_name: 'productos', rls_enabled: true, force_rls: false },
          { table_name: 'profiles', rls_enabled: true, force_rls: true },
          { table_name: 'staff', rls_enabled: true, force_rls: true },
        ]);
      }

      if (body.query.includes('information_schema.columns')) {
        return jsonResponse(200, [
          { table_name: 'regiones', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
          { table_name: 'regiones', column_name: 'codigo', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
          { table_name: 'regiones', column_name: 'nombre', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
          { table_name: 'regiones', column_name: 'activo', data_type: 'boolean', udt_name: 'bool', is_nullable: 'NO' },
          { table_name: 'clientes', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
          { table_name: 'clientes', column_name: 'sucursal', data_type: 'USER-DEFINED', udt_name: 'sucursal_codigo', is_nullable: 'YES' },
          { table_name: 'clientes', column_name: 'zona_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'YES' },
          { table_name: 'clientes', column_name: 'ciudad', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
          { table_name: 'clientes', column_name: 'estado', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
          { table_name: 'supervisores', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
          { table_name: 'supervisores', column_name: 'region_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'YES' },
          { table_name: 'supervisores', column_name: 'email', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
          { table_name: 'productos', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
          { table_name: 'productos', column_name: 'nombre', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
        ]);
      }

      if (body.query.includes('pg_catalog.pg_policies')) {
        return jsonResponse(200, [
          {
            tablename: 'regiones',
            policyname: 'regiones_select_authenticated',
            cmd: 'SELECT',
            permissive: 'PERMISSIVE',
            roles: ['authenticated'],
          },
        ]);
      }

      if (body.query.includes('FROM public.regiones')) {
        return jsonResponse(
          200,
          OFFICIAL_REGIONAL_HUBS.map((hub, i) => ({
            row_data: {
              id: `00000000-0000-4000-8000-00000000001${i}`,
              codigo: hub.toUpperCase(),
              nombre: hub,
              activo: true,
            },
          }))
        );
      }

      if (body.query.includes('supabase_migrations.schema_migrations')) {
        return jsonResponse(200, [
          { version: '20261001000000', name: 'baseline_core_tables' },
          { version: '20261001000100', name: 'schema_maestros' },
        ]);
      }

      return jsonResponse(400, { error: 'Unexpected query' });
    };

    const mgmtReport = await discoverExistingSupabaseCatalog(
      { SUPABASE_ACCESS_TOKEN: 'sbp_mock_token_offline_test' },
      { fetchImpl: mockManagementFetch }
    );
    assert.equal(mgmtReport.source, 'management_api');
    assert.equal(mgmtReport.projectRef, DEFAULT_SUPABASE_PROJECT_REF);
    assert.equal(mgmtReport.regiones.exists, true);
    assert.equal(mgmtReport.regiones.hubVerification.allFiveHubsPresentAndActive, true);
    assert.deepEqual(mgmtReport.tables.clientes?.regionalLinkColumns, [
      'sucursal',
      'zona_id',
      'ciudad',
      'estado',
    ]);
    assert.deepEqual(mgmtReport.tables.supervisores?.regionalLinkColumns, [
      'region_id',
      'email',
    ]);
    assert.equal(mgmtReport.remoteSchemaMigrations.reachable, true);
    assert.equal(mgmtReport.remoteSchemaMigrations.applied.length, 2);
    assert.equal(mgmtQueries.length, 5);

    // Fallback a PostgREST cuando Management API responde 403
    const mockFallbackFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('api.supabase.com')) {
        return jsonResponse(403, { message: 'Forbidden PAT sb_secret_SHOULD_REDACT' });
      }
      if (url.endsWith('/rest/v1/')) {
        return jsonResponse(200, {
          definitions: {
            regiones: {
              required: ['id', 'nombre'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                codigo: { type: 'string', format: 'text' },
                nombre: { type: 'string', format: 'text' },
                activo: { type: 'boolean', format: 'boolean' },
              },
            },
            vendedores: {
              required: ['id'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                zona: { type: 'string', format: 'text' },
                email: { type: 'string', format: 'text' },
              },
            },
          },
        });
      }
      if (url.includes('/rest/v1/regiones')) {
        return jsonResponse(
          200,
          OFFICIAL_REGIONAL_HUBS.map((hub, i) => ({
            id: `00000000-0000-4000-8000-00000000002${i}`,
            codigo: hub.toUpperCase(),
            nombre: hub,
            activo: true,
          }))
        );
      }
      if (url.endsWith('/rest/v1/rpc/rpc_certificar_esquema_trade')) {
        return jsonResponse(200, {
          tables: [
            {
              table_name: 'vendedores',
              exists: true,
              rls_enabled: true,
              force_rls: true,
              has_sucursal_column: true,
              sucursal_type: 'sucursal_codigo',
              policy_count: 4,
              anon_policy_count: 0,
              unfiltered_legacy_policies: [],
            },
          ],
        });
      }
      return jsonResponse(404, {});
    };

    const fallbackReport = await discoverExistingSupabaseCatalog(
      {
        SUPABASE_ACCESS_TOKEN: 'sbp_expired_token',
        SUPABASE_URL: 'https://apaxdgxtaoeyswlfblgi.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: MOCK_PUBLIC_ANON_KEY,
        CERTIFIER_BEARER_TOKEN: buildMockJwt({ sub: 'admin-1', role: 'authenticated' }),
      },
      { fetchImpl: mockFallbackFetch }
    );
    assert.equal(fallbackReport.source, 'postgrest_fallback');
    assert.equal(fallbackReport.regiones.hubVerification.allFiveHubsPresentAndActive, true);
    assert.deepEqual(fallbackReport.tables.vendedores?.regionalLinkColumns, [
      'zona',
      'email',
      'sucursal',
    ]);
    assert.equal(fallbackReport.tables.vendedores?.rls_enabled, true);
    assert.equal(fallbackReport.remoteSchemaMigrations.reachable, false);

    const summaryText = formatDiscoverySummary(fallbackReport);
    assert.doesNotMatch(summaryText, /sb_secret_SHOULD_REDACT/);
    assert.match(summaryText, /\[REDACTED_SB_SECRET\]/);
  });

  await t.test('5) Helper reconcileDuplicateMigrationPlan: 14 dígitos ordenados y preservación de 8 dígitos aplicados', () => {
    const legacyDuplicateSet = [
      '20261001000000_baseline_core_tables.sql',
      '20261029_degustaciones_realtime_notifications.sql',
      '20261029_solicitudes_contraloria_degustaciones.sql',
      '20261112_asistencia_evidencias_perfil_condicional.sql',
      '20261112_fase1_historial_degustaciones.sql',
      '20261112_fase2_cierre_dominical_cron.sql',
      '20261112_zero_trust_fdv_promotoras_portal_ruta.sql',
      '20261116_admin_users_fast_access.sql',
      '20261116_rbac_corporate_profiles_and_rls.sql',
    ];

    // Sin versiones de 8 dígitos aplicadas en remoto -> todas pasan a 14 dígitos únicos en orden exacto
    const cleanPlan = reconcileDuplicateMigrationPlan(legacyDuplicateSet, []);
    assert.deepEqual(
      cleanPlan.map((a) => `${a.from} -> ${a.to}`),
      [
        '20261029_degustaciones_realtime_notifications.sql -> 20261029000100_degustaciones_realtime_notifications.sql',
        '20261029_solicitudes_contraloria_degustaciones.sql -> 20261029000200_solicitudes_contraloria_degustaciones.sql',
        '20261112_asistencia_evidencias_perfil_condicional.sql -> 20261112000100_asistencia_evidencias_perfil_condicional.sql',
        '20261112_fase1_historial_degustaciones.sql -> 20261112000200_fase1_historial_degustaciones.sql',
        '20261112_fase2_cierre_dominical_cron.sql -> 20261112000300_fase2_cierre_dominical_cron.sql',
        '20261112_zero_trust_fdv_promotoras_portal_ruta.sql -> 20261112000400_zero_trust_fdv_promotoras_portal_ruta.sql',
        '20261116_admin_users_fast_access.sql -> 20261116000100_admin_users_fast_access.sql',
        '20261116_rbac_corporate_profiles_and_rls.sql -> 20261116000200_rbac_corporate_profiles_and_rls.sql',
      ]
    );

    // Si schema_migrations remoto ya tiene aplicada 20261112 (fase1_historial_degustaciones), la conserva intacta
    const remoteAppliedPlan = reconcileDuplicateMigrationPlan(legacyDuplicateSet, [
      { version: '20261112', name: 'fase1_historial_degustaciones' },
    ]);
    const group20261112 = remoteAppliedPlan.filter((a) => a.originalVersion === '20261112');
    assert.deepEqual(
      group20261112.map((a) => ({
        to: a.to,
        kept: a.keptAppliedEightDigitVersion,
      })),
      [
        { to: '20261112000100_asistencia_evidencias_perfil_condicional.sql', kept: false },
        { to: '20261112_fase1_historial_degustaciones.sql', kept: true },
        { to: '20261112000200_fase2_cierre_dominical_cron.sql', kept: false },
        { to: '20261112000300_zero_trust_fdv_promotoras_portal_ruta.sql', kept: false },
      ]
    );
  });

  await t.test('6) Reglas duras Compuerta G1: DUPLICATE_VERSION es error, schema_maestros reconciliado y CI bloqueante', () => {
    // DUPLICATE_VERSION bloquea con severidad 'error' tanto en el analizador como en el certificador estático
    const namingIssues = checkMigrationNaming(['20261029_a.sql', '20261029_b.sql']);
    assert.equal(namingIssues.length, 1);
    assert.equal(namingIssues[0]?.code, 'DUPLICATE_VERSION');
    assert.equal(namingIssues[0]?.severity, 'error');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-dup-cert-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '20261029_a.sql'), 'SELECT 1;\n', 'utf8');
      fs.writeFileSync(path.join(tmpDir, '20261029_b.sql'), 'SELECT 1;\n', 'utf8');
      const dupReport = runStaticCertification(tmpDir);
      assert.equal(dupReport.passed, false, 'Versiones duplicadas deben reprobar la certificación estática');
      const uniqueCheck = dupReport.checks.find((c) => c.id === 'static.unique_migration_versions');
      assert.ok(uniqueCheck);
      assert.equal(uniqueCheck.passed, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // schema_maestros declara idempotentemente regiones (con seed de 5 hubs), supervisores y productos
    const maestrosSql = fs.readFileSync(
      path.join(ROOT_DIR, 'supabase', 'migrations', '20261001000100_schema_maestros.sql'),
      'utf8'
    );
    for (const tbl of ['regiones', 'supervisores', 'productos']) {
      assert.match(maestrosSql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${tbl}\\b`, 'i'));
      assert.match(maestrosSql, new RegExp(`ALTER TABLE public\\.${tbl} ENABLE ROW LEVEL SECURITY`, 'i'));
      assert.match(maestrosSql, new RegExp(`REVOKE ALL ON TABLE public\\.${tbl} FROM PUBLIC, anon`, 'i'));
      assert.match(maestrosSql, new RegExp(`GRANT SELECT ON TABLE public\\.${tbl} TO authenticated`, 'i'));
    }
    for (const hub of OFFICIAL_REGIONAL_HUBS) {
      assert.match(maestrosSql, new RegExp(`'${hub}'`));
    }
    assert.match(maestrosSql, /information_schema\.columns/i);

    // CI db-migrations ya no ignora errores
    const ciYaml = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.doesNotMatch(ciYaml, /continue-on-error\s*:\s*true/i);
    assert.match(ciYaml, /supabase db reset --local/);
  });
});
