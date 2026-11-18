import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { buildMockJwt, MOCK_PUBLIC_ANON_KEY, MOCK_SERVICE_ROLE_KEY } from './antigravity_audit/localMockInfra';

const ROOT_DIR = process.cwd();

test('FASE 1 (MVP-01, MVP-02, MVP-03) — Certificación Integral de Blindaje RLS, Baseline SQL y RBAC', async (t) => {
  await t.test('MVP-02: Baseline reproducible, orden lexicográfico de migraciones y fixes SQL', () => {
    const configToml = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'config.toml'), 'utf8');
    assert.match(configToml, /enable_signup\s*=\s*false/, 'config.toml debe deshabilitar signUp público');
    assert.match(
      configToml,
      /minimum_password_length\s*=\s*8/,
      'config.toml debe exigir contraseña mínima de 8 caracteres'
    );

    const migrationFiles = fs
      .readdirSync(path.join(ROOT_DIR, 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    assert.ok(
      migrationFiles.includes('001_blindaje_trade_sucursales.sql'),
      'Debe incluir 001_blindaje_trade_sucursales.sql'
    );

    const timestampMigrations = migrationFiles.filter(
      (f) => f !== '001_blindaje_trade_sucursales.sql'
    );

    assert.equal(
      timestampMigrations[0],
      '20261001000000_baseline_core_tables.sql',
      'La migración baseline timestamped debe ejecutarse antes de las demás migraciones timestamped'
    );
    assert.equal(
      timestampMigrations[1],
      '20261001000100_schema_maestros.sql',
      'schema_maestros debe tener prefijo timestamp estándar'
    );
    assert.equal(
      timestampMigrations[2],
      '20261001000200_rls_y_rpc_sync.sql',
      'rls_y_rpc_sync debe tener prefijo timestamp estándar'
    );
    assert.equal(
      timestampMigrations[timestampMigrations.length - 1],
      '20261118000100_fase1_lockdown_rls_rbac_and_fixes.sql',
      'La migración de cierre Fase 1 debe ejecutarse al final'
    );
    assert.ok(
      !migrationFiles.some((f) => /^0[12]_/.test(f)),
      'No deben existir migraciones con prefijos legados 01_ / 02_'
    );

    const baselineSql = fs.readFileSync(
      path.join(ROOT_DIR, 'supabase', 'migrations', '20261001000000_baseline_core_tables.sql'),
      'utf8'
    );
    for (const table of ['staff', 'surveys', 'prices', 'inventory', 'checkins', 'entregas_degustacion']) {
      assert.match(
        baselineSql,
        new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, 'i'),
        `Baseline debe declarar CREATE TABLE IF NOT EXISTS public.${table}`
      );
    }
    assert.match(
      baselineSql,
      /CREATE OR REPLACE FUNCTION private\.current_active_promotora_id\(\)/i,
      'Baseline debe definir private.current_active_promotora_id() para evitar fallos de orden'
    );

    const fase1Sql = fs.readFileSync(
      path.join(
        ROOT_DIR,
        'supabase',
        'migrations',
        '20261118000100_fase1_lockdown_rls_rbac_and_fixes.sql'
      ),
      'utf8'
    );
    assert.match(
      fase1Sql,
      /DROP INDEX IF EXISTS public\.idx_cronograma_deg_idempotency_active/i,
      'Debe eliminar el índice legado idx_cronograma_deg_idempotency_active'
    );
    assert.match(
      fase1Sql,
      /pg_catalog\.pg_trigger_depth\(\)\s*>\s*1/i,
      'Debe permitir propagación de CHECKOUT post-medianoche vía pg_trigger_depth() > 1'
    );
    assert.match(
      fase1Sql,
      /ejecutar_cierre_dominical_degustaciones\(NOW\(\),\s*'America\/Caracas',\s*FALSE\)/i,
      'Debe reprogramar pg_cron apuntando a ejecutar_cierre_dominical_degustaciones'
    );
  });

  await t.test('MVP-01: Cierre al 100% del rol anon en RLS y Segregación de Funciones en BD', () => {
    const fase1Sql = fs.readFileSync(
      path.join(
        ROOT_DIR,
        'supabase',
        'migrations',
        '20261118000100_fase1_lockdown_rls_rbac_and_fixes.sql'
      ),
      'utf8'
    );

    assert.match(
      fase1Sql,
      /DROP TRIGGER IF EXISTS on_auth_user_created ON auth\.users/i,
      'Debe eliminar el trigger con correos cableados en auth.users'
    );
    assert.match(
      fase1Sql,
      /REVOKE ALL ON TABLE public\.%I FROM PUBLIC,\s*anon/i,
      'Debe revocar privilegios de tabla a PUBLIC y anon en todas las tablas gestionadas'
    );
    assert.match(
      fase1Sql,
      /'anon'\s*=\s*ANY\(roles\)/i,
      'Debe purgar dinámicamente cualquier política RLS previa otorgada a anon'
    );
    assert.match(
      fase1Sql,
      /CREATE POLICY solicitudes_contraloria_update_contraloria[\s\S]*?is_contraloria_or_admin\(\)/i,
      'Solo Contraloría o Super Admin deben poder hacer UPDATE en solicitudes_contraloria'
    );

    const rutaSql = fs.readFileSync(
      path.join(
        ROOT_DIR,
        'ruta-degustacion',
        'supabase',
        'migrations',
        '20261106_entregas_degustacion.sql'
      ),
      'utf8'
    );
    assert.doesNotMatch(
      rutaSql,
      /to\s+anon\s*,\s*authenticated/i,
      'La migración de ruta-degustacion no debe otorgar políticas ni permisos a anon'
    );
  });

  await t.test('MVP-03: Dominio de 5 roles corporativos, matriz RoleGuard y eliminación de auth.signUp()', async () => {
    const userMgmtSource = fs.readFileSync(
      path.join(ROOT_DIR, 'src', 'services', 'userManagementService.ts'),
      'utf8'
    );
    assert.doesNotMatch(
      userMgmtSource,
      /\.auth\.signUp\s*\(/,
      'userManagementService.ts jamás debe invocar auth.signUp() público en cliente'
    );

    const userMgmt = await import('../src/services/userManagementService');
    const authSvc = await import('../src/services/authService');
    const headerMod = await import('../src/components/common/Header');

    assert.deepEqual(userMgmt.MANAGED_USER_ROLES, [
      'super_admin',
      'contraloria',
      'coordinacion',
      'supervisor',
      'vendedor',
    ]);
    assert.equal(userMgmt.MIN_SUPABASE_PASSWORD_LENGTH, 8);

    // Verificar extracción de perfil Contraloría (accede a Torre de Control pero NO es operador Trade)
    const contraloriaProfile = authSvc.extractVerifiedProfileFromAuthUser({
      id: '33333333-3333-4333-8333-333333333333',
      email: 'auditor@codizulca.com',
      app_metadata: {
        role: 'contraloria',
        app_role: 'contraloria',
        display_name: 'Analista Contraloría',
        must_change_password: true,
      },
      user_metadata: {
        role: 'super_admin', // intento malicioso en user_metadata debe ignorarse
      },
    } as any);

    assert.ok(contraloriaProfile);
    assert.equal(contraloriaProfile.appRole, 'contraloria');
    assert.equal(contraloriaProfile.iamRole, 'contraloria');
    assert.equal(contraloriaProfile.legacyRole, 'analista_contraloria');
    assert.equal(contraloriaProfile.isCoordinatorOrAdmin, false);
    assert.equal(contraloriaProfile.canAccessTorreControl, true);
    assert.equal(contraloriaProfile.mustChangePassword, true);

    // Verificar extracción de perfil Supervisor
    const supervisorProfile = authSvc.extractVerifiedProfileFromAuthUser({
      id: '44444444-4444-4444-8444-444444444444',
      email: 'supervisor@codizulca.com',
      app_metadata: {
        role: 'supervisor',
        display_name: 'Supervisor Zulia',
      },
      user_metadata: {},
    } as any);

    assert.ok(supervisorProfile);
    assert.equal(supervisorProfile.appRole, 'supervisor');
    assert.equal(supervisorProfile.iamRole, 'supervisor');
    assert.equal(supervisorProfile.isCoordinatorOrAdmin, true);
    assert.equal(supervisorProfile.canAccessTorreControl, true);
    assert.equal(supervisorProfile.mustChangePassword, false);

    // Verificar Segregación de Módulos en Header / App
    const rolesMatrix = headerMod.MODULE_ALLOWED_ROLES;
    assert.ok(!rolesMatrix.promotoras.includes('contraloria'));
    assert.ok(!rolesMatrix.llenado_cronograma.includes('contraloria'));
    assert.ok(rolesMatrix.contraloria.includes('contraloria'));
    assert.ok(rolesMatrix.kpis_trazabilidad.includes('contraloria'));
    assert.ok(!rolesMatrix.contraloria.includes('supervisor'));
    assert.deepEqual(rolesMatrix.gestion_usuarios, ['super_admin']);
  });

  await t.test('MVP-03 Backend: POST /api/admin/corporate-users con RBAC estricto y rollback ante fallo RPC', async () => {
    const SUPER_ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const COORD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
    const SUSPENDED_ADMIN_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';

    const superAdminToken = buildMockJwt({
      sub: SUPER_ADMIN_ID,
      email: 'root@codizulca.local',
      role: 'authenticated',
      app_metadata: { role: 'super_admin', app_role: 'super_admin' },
      exp: 2100000000,
    });
    const coordToken = buildMockJwt({
      sub: COORD_ID,
      email: 'coord@codizulca.local',
      role: 'authenticated',
      app_metadata: { role: 'coordinacion', app_role: 'coordinacion' },
      exp: 2100000000,
    });
    const suspendedAdminToken = buildMockJwt({
      sub: SUSPENDED_ADMIN_ID,
      email: 'suspended@codizulca.local',
      role: 'authenticated',
      app_metadata: { role: 'super_admin', app_role: 'super_admin' },
      exp: 2100000000,
    });

    const createdAuthUsers = new Map<string, { email: string; app_metadata: unknown }>();
    const deletedUserIds: string[] = [];
    let simulateFinalizeRpcFailure = false;

    const mockSupabaseServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const jsonBody = bodyText ? JSON.parse(bodyText) : {};

      res.setHeader('Content-Type', 'application/json');

      // 1. Verificación JWT GET /auth/v1/user
      if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
        const auth = String(req.headers.authorization || '');
        if (auth === `Bearer ${superAdminToken}`) {
          res.end(
            JSON.stringify({
              id: SUPER_ADMIN_ID,
              email: 'root@codizulca.local',
              app_metadata: { role: 'super_admin' },
            })
          );
          return;
        }
        if (auth === `Bearer ${coordToken}`) {
          res.end(
            JSON.stringify({
              id: COORD_ID,
              email: 'coord@codizulca.local',
              app_metadata: { role: 'coordinacion' },
            })
          );
          return;
        }
        if (auth === `Bearer ${suspendedAdminToken}`) {
          res.end(
            JSON.stringify({
              id: SUSPENDED_ADMIN_ID,
              email: 'suspended@codizulca.local',
              app_metadata: { role: 'super_admin' },
            })
          );
          return;
        }
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'Invalid token' }));
        return;
      }

      // 2. Consulta PostgREST GET /rest/v1/profiles
      if (req.method === 'GET' && url.pathname === '/rest/v1/profiles') {
        const idFilter = url.searchParams.get('id') || '';
        if (idFilter === `eq.${SUPER_ADMIN_ID}`) {
          res.end(JSON.stringify({ role: 'super_admin', is_active: true }));
          return;
        }
        if (idFilter === `eq.${COORD_ID}`) {
          res.end(JSON.stringify({ role: 'coordinacion', is_active: true }));
          return;
        }
        if (idFilter === `eq.${SUSPENDED_ADMIN_ID}`) {
          res.end(JSON.stringify({ role: 'super_admin', is_active: false }));
          return;
        }
        res.end('null');
        return;
      }

      // 3. Admin Create User POST /auth/v1/admin/users
      if (req.method === 'POST' && url.pathname === '/auth/v1/admin/users') {
        const email = String(jsonBody.email || '').toLowerCase();
        for (const existing of createdAuthUsers.values()) {
          if (existing.email === email) {
            res.statusCode = 422;
            res.end(JSON.stringify({ message: 'User already registered', code: 'email_exists' }));
            return;
          }
        }
        const newId = crypto.randomUUID();
        createdAuthUsers.set(newId, { email, app_metadata: jsonBody.app_metadata });
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            user: {
              id: newId,
              email,
              app_metadata: jsonBody.app_metadata,
            },
          })
        );
        return;
      }

      // 4. Admin Get/Delete User /auth/v1/admin/users/:id (rollback compensatorio)
      if (req.method === 'GET' && url.pathname.startsWith('/auth/v1/admin/users/')) {
        const userId = url.pathname.split('/').pop() || '';
        const found = createdAuthUsers.get(userId);
        if (!found) {
          res.statusCode = 404;
          res.end(JSON.stringify({ message: 'User not found' }));
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            id: userId,
            email: found.email,
            app_metadata: found.app_metadata,
          })
        );
        return;
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/auth/v1/admin/users/')) {
        const userId = url.pathname.split('/').pop() || '';
        createdAuthUsers.delete(userId);
        deletedUserIds.push(userId);
        res.statusCode = 200;
        res.end(JSON.stringify({ user: { id: userId } }));
        return;
      }

      // 5. RPC POST /rest/v1/rpc/admin_finalize_created_user
      if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/admin_finalize_created_user') {
        if (simulateFinalizeRpcFailure) {
          res.statusCode = 400;
          res.end(JSON.stringify({ message: 'Simulated DB constraint error', code: '23514' }));
          return;
        }
        const targetId = String(jsonBody.p_target_user_id || '');
        const created = createdAuthUsers.get(targetId);
        res.statusCode = 200;
        res.end(
          JSON.stringify([
            {
              id: targetId,
              email: created?.email || '',
              full_name: jsonBody.p_full_name,
              role: jsonBody.p_role,
              is_active: true,
              must_change_password: Boolean(jsonBody.p_must_change_password),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ])
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Mock route not found' }));
    });

    await new Promise<void>((resolve) => mockSupabaseServer.listen(0, '127.0.0.1', () => resolve()));
    const mockPort = (mockSupabaseServer.address() as AddressInfo).port;
    const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

    const prevUrl = process.env.SUPABASE_URL;
    const prevAnon = process.env.SUPABASE_ANON_KEY;
    const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY;

    process.env.SUPABASE_URL = mockBaseUrl;
    process.env.SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;

    const { handleCreateCorporateUser, requireSuperAdminAuth } = await import(
      '../src/server/supabaseAdminAuth'
    );

    const app = express();
    app.use(express.json());
    app.post('/api/admin/corporate-users', requireSuperAdminAuth, handleCreateCorporateUser);

    const apiServer = http.createServer(app);
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', () => resolve()));
    const apiPort = (apiServer.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${apiPort}/api/admin/corporate-users`;

    try {
      // Caso A: Sin token -> 401
      const noTokenRes = await fetch(endpoint, { method: 'POST', body: '{}' });
      assert.equal(noTokenRes.status, 401);

      // Caso B: Coordinación intenta crear usuario -> 403
      const coordRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${coordToken}`,
        },
        body: JSON.stringify({
          fullName: 'Intento Escalación',
          email: 'escalacion@codizulca.local',
          password: 'PasswordSegura123!',
          role: 'super_admin',
        }),
      });
      assert.equal(coordRes.status, 403);

      // Caso C: Super Admin suspendido -> 403
      const suspendedRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${suspendedAdminToken}`,
        },
        body: JSON.stringify({
          fullName: 'Intento Suspendido',
          email: 'suspendido@codizulca.local',
          password: 'PasswordSegura123!',
          role: 'vendedor',
        }),
      });
      assert.equal(suspendedRes.status, 403);

      // Caso D: Validación de rol no permitido y contraseña débil -> 400
      const invalidRoleRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          fullName: 'Portal Externo',
          email: 'cliente@codizulca.local',
          password: 'PasswordSegura123!',
          role: 'cliente',
        }),
      });
      assert.equal(invalidRoleRes.status, 400);

      const shortPassRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          fullName: 'Clave Corta',
          email: 'corta@codizulca.local',
          password: '1234567',
          role: 'supervisor',
        }),
      });
      assert.equal(shortPassRes.status, 400);

      // Caso E: Creación exitosa de rol `contraloria` con `mustChangePassword = true` -> 201
      const okRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          fullName: '  Laura   Contraloría  ',
          email: '  LAURA.CONTRALORIA@CODIZULCA.LOCAL ',
          password: 'PasswordSegura123!',
          role: 'contraloria',
          mustChangePassword: true,
        }),
      });
      assert.equal(okRes.status, 201);
      const okJson = (await okRes.json()) as {
        ok: boolean;
        profile: {
          email: string;
          full_name: string;
          role: string;
          must_change_password: boolean;
        };
      };
      assert.equal(okJson.ok, true);
      assert.equal(okJson.profile.email, 'laura.contraloria@codizulca.local');
      assert.equal(okJson.profile.full_name, 'Laura Contraloría');
      assert.equal(okJson.profile.role, 'contraloria');
      assert.equal(okJson.profile.must_change_password, true);

      // Caso F: Duplicado -> 409
      const dupRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          fullName: 'Laura Duplicada',
          email: 'laura.contraloria@codizulca.local',
          password: 'PasswordSegura123!',
          role: 'contraloria',
        }),
      });
      assert.equal(dupRes.status, 409);

      // Caso G: Rollback compensatorio automático si falla `admin_finalize_created_user`
      simulateFinalizeRpcFailure = true;
      const beforeCount = createdAuthUsers.size;
      const rollbackRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${superAdminToken}`,
        },
        body: JSON.stringify({
          fullName: 'Usuario Rollback',
          email: 'rollback@codizulca.local',
          password: 'PasswordSegura123!',
          role: 'supervisor',
        }),
      });
      assert.equal(rollbackRes.status, 400);
      assert.equal(
        createdAuthUsers.size,
        beforeCount,
        'No debe quedar ningún usuario huérfano en auth.users tras fallo de RPC'
      );
      assert.equal(deletedUserIds.length, 1, 'Debe ejecutarse deleteUser compensatorio');
    } finally {
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
      await new Promise<void>((resolve) => mockSupabaseServer.close(() => resolve()));
      if (prevUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevUrl;
      if (prevAnon === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = prevAnon;
      if (prevService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = prevService;
    }
  });
});
