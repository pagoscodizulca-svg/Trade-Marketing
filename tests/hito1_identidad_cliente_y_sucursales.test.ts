import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  buildMockJwt,
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
} from './antigravity_audit/localMockInfra';
import {
  analyzeMigrations,
  formatIssues,
  type MigrationFile,
} from './support/sqlMigrationAnalyzer';

const ROOT_DIR = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'supabase', 'migrations');
const HITO1_MIGRATION = '20261118000400_hito1_identidad_unica_y_aislamiento_sucursales.sql';

const EIGHT_OPERATIONAL_TABLES = [
  'staff',
  'surveys',
  'cronograma_degustaciones',
  'rutas_promotoras',
  'asistencias_jornada',
  'asistencia_evidencias',
  'solicitudes_contraloria',
  'entregas_degustacion',
] as const;

function loadMigrations(): MigrationFile[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

// 1x1 PNG mínimo válido (magic bytes reales 89 50 4E 47 0D 0A 1A 0A)
const VALID_TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('HITO 1 — Identidad Única en profiles, Cliente Único TS y Aislamiento Total Zulia/Valencia/Global', async (t) => {
  const migrations = loadMigrations();
  const hito1Sql = fs.readFileSync(path.join(MIGRATIONS_DIR, HITO1_MIGRATION), 'utf8');
  const analysis = analyzeMigrations(migrations);

  await t.test('1) Analizador estático SQL: 0 errores y cero comandos destructivos en toda la cadena', () => {
    assert.equal(
      analysis.errors.length,
      0,
      `Se detectaron errores en la cadena de migraciones:\n${formatIssues(analysis.errors)}`
    );
    assert.doesNotMatch(hito1Sql, /\bDROP\s+TABLE\b/i, 'Prohibido DROP TABLE en Hito 1');
    assert.doesNotMatch(hito1Sql, /\bTRUNCATE\b/i, 'Prohibido TRUNCATE en Hito 1');
  });

  await t.test('2) N-02 / B-02: Modelo único sobre public.profiles (7 roles + sucursal NOT NULL) y deprecación de perfiles_acceso', () => {
    assert.equal(
      analysis.types.has('sucursal_codigo'),
      true,
      'Debe existir el tipo ENUM public.sucursal_codigo'
    );

    const profileCols = analysis.tables.get('profiles');
    assert.ok(profileCols, 'public.profiles debe existir');
    assert.equal(profileCols.has('sucursal'), true, 'public.profiles debe tener columna sucursal');

    assert.match(hito1Sql, /ALTER TABLE public\.profiles\s+ALTER COLUMN sucursal SET NOT NULL/i);
    assert.match(
      hito1Sql,
      /CHECK\s*\(\s*role\s+IN\s*\(\s*'super_admin',\s*'coordinacion',\s*'contraloria',\s*'vendedor',\s*'promotora',\s*'cliente',\s*'chofer'\s*\)\s*\)/i,
      'public.profiles debe soportar los 7 roles unificados'
    );
    assert.match(
      hito1Sql,
      /ADD CONSTRAINT chk_profiles_sucursal_por_rol/i,
      'Debe restringir GLOBAL exclusivamente a super_admin y contraloria'
    );

    // Deprecación no destructiva de `perfiles_acceso`
    assert.equal(
      analysis.tables.has('perfiles_acceso'),
      false,
      'public.perfiles_acceso no debe seguir activa como tabla paralela'
    );
    assert.equal(
      analysis.tables.has('perfiles_acceso_deprecado_hito1'),
      true,
      'public.perfiles_acceso debe haberse renombrado sin borrar datos'
    );
    assert.match(hito1Sql, /DROP FUNCTION IF EXISTS public\.vincular_mi_usuario_auth\(\)/i);

    // `obtener_mi_rol()` y `obtener_mi_sucursal()` leen exclusivamente de `public.profiles` / `app_metadata`
    const fnRolIdx = hito1Sql.indexOf('CREATE OR REPLACE FUNCTION public.obtener_mi_rol()');
    const fnSucIdx = hito1Sql.indexOf('CREATE OR REPLACE FUNCTION public.obtener_mi_sucursal()');
    const fnEndIdx = hito1Sql.indexOf('CREATE OR REPLACE FUNCTION public.tiene_acceso_sucursal');
    assert.ok(fnRolIdx > 0 && fnSucIdx > fnRolIdx && fnEndIdx > fnSucIdx);

    const helpersBody = hito1Sql.slice(fnRolIdx, fnEndIdx);
    assert.match(helpersBody, /FROM public\.profiles\b/i);
    assert.doesNotMatch(helpersBody, /perfiles_acceso/i);
    assert.doesNotMatch(helpersBody, /user_metadata|raw_user_meta_data/i);
  });

  await t.test('3) N-04 / N-05 / N-06 / B-03: sucursal, FORCE RLS, triggers y ausencia de políticas permisivas sin filtro en las 8 tablas + maestros', () => {
    for (const tbl of [...EIGHT_OPERATIONAL_TABLES, 'clientes', 'vendedores']) {
      const cols = analysis.tables.get(tbl);
      assert.ok(cols, `La tabla public.${tbl} debe existir`);
      assert.equal(
        cols.has('sucursal'),
        true,
        `La tabla public.${tbl} debe poseer la columna sucursal`
      );

      const pols = analysis.policies.get(tbl) ?? new Set<string>();
      for (const p of pols) {
        assert.doesNotMatch(
          p,
          /^rbac_(coordinadora_ops|super_admin_all|coordinadora_select)_/,
          `La política heredada sin filtro de sede "${p}" no debe quedar activa en public.${tbl}`
        );
      }
      assert.ok(pols.size > 0, `public.${tbl} debe tener políticas RLS activas con filtro de sede`);
    }

    // N-05: Escritura en `clientes` para `super_admin` y `coordinacion` dentro de su propia sucursal
    assert.match(
      hito1Sql,
      /CREATE POLICY clientes_insert_trade_sede[\s\S]*?is_coordinadora_or_admin\(\)[\s\S]*?tiene_acceso_sucursal\(sucursal\)/i
    );
    assert.match(
      hito1Sql,
      /CREATE POLICY clientes_update_trade_sede[\s\S]*?is_coordinadora_or_admin\(\)[\s\S]*?tiene_acceso_sucursal\(sucursal\)/i
    );

    // N-06 completo: `surveys` exige autor_user_id = auth.uid() Y tiene_acceso_sucursal(sucursal)
    assert.match(
      hito1Sql,
      /CREATE POLICY surveys_select_authenticated_roles[\s\S]*?tiene_acceso_sucursal\(sucursal\)[\s\S]*?autor_user_id\s*=\s*\(SELECT auth\.uid\(\)\)/i
    );

    // D6: chofer restringido a actualizar solo campos de entrega en `entregas_degustacion`
    assert.match(
      hito1Sql,
      /TG_TABLE_NAME\s*=\s*'entregas_degustacion'\s+AND\s+v_mi_rol\s*=\s*'chofer'/i
    );
  });

  await t.test('4) N-03: Eliminación física de la capa JS huérfana y consolidación en src/services/supabaseClient.ts', async () => {
    for (const removed of [
      'src/lib/supabaseClient.js',
      'src/auth/authGuard.js',
      'src/diagnostics/checkSupabaseConnection.js',
    ]) {
      assert.equal(
        fs.existsSync(path.join(ROOT_DIR, removed)),
        false,
        `El archivo huérfano ${removed} no debe existir`
      );
    }

    // Verificar que ningún archivo fuente o de pruebas importe la capa JS eliminada
    const scanDirs = [path.join(ROOT_DIR, 'src'), path.join(ROOT_DIR, 'tests')];
    const visit = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...visit(full));
        } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && entry.name !== 'env.js') {
          if (full !== path.join(ROOT_DIR, 'tests', 'hito1_identidad_cliente_y_sucursales.test.ts')) {
            out.push(full);
          }
        }
      }
      return out;
    };

    for (const file of scanDirs.flatMap(visit)) {
      const content = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(
        content,
        /from\s+['"][^'"]*(?:lib\/supabaseClient|auth\/authGuard|diagnostics\/checkSupabaseConnection)/,
        `Importación huérfana residual detectada en ${path.relative(ROOT_DIR, file)}`
      );
    }

    const supa = await import('../src/services/supabaseClient');
    assert.equal(supa.UNIFIED_SUPABASE_STORAGE_KEY, 'codizulca.supabase.auth.v1');
    assert.equal(supa.esClavePublicaSupabaseValida('sb_publishable_clave_valida_0123456789'), true);
    assert.equal(supa.esClavePublicaSupabaseValida(MOCK_PUBLIC_ANON_KEY), true);
    assert.equal(supa.esClavePublicaSupabaseValida(MOCK_SERVICE_ROLE_KEY), false);
    assert.equal(supa.esClavePublicaSupabaseValida('sb_secret_prohibida_123'), false);
  });

  await t.test('5) Backend IAM + Evidencias: validación de GLOBAL por rol y bloqueo 403 FORBIDDEN_BRANCH entre Zulia y Valencia', async () => {
    const IDS = {
      superAdmin: 'd0000000-0000-4000-8000-000000000001',
      coordZulia: 'd0000000-0000-4000-8000-000000000002',
      contraloriaVal: 'd0000000-0000-4000-8000-000000000003',
      contraloriaGlobal: 'd0000000-0000-4000-8000-000000000004',
      staffZulia: 'e0000000-0000-4000-8000-000000000011',
      staffValencia: 'e0000000-0000-4000-8000-000000000022',
      evZulia: 'f0000000-0000-4000-8000-000000000011',
      evValencia: 'f0000000-0000-4000-8000-000000000022',
    };

    const mkToken = (sub: string, email: string, role: string, sucursal: string) =>
      buildMockJwt({
        sub,
        email,
        role: 'authenticated',
        app_metadata: { role, app_role: role, sucursal },
        exp: 2100000000,
      });

    const TOKENS = {
      superAdmin: mkToken(IDS.superAdmin, 'root@codizulca.local', 'super_admin', 'GLOBAL'),
      coordZulia: mkToken(IDS.coordZulia, 'coord.zulia@codizulca.local', 'coordinacion', 'ZULIA'),
      contraloriaVal: mkToken(
        IDS.contraloriaVal,
        'audit.val@codizulca.local',
        'contraloria',
        'VALENCIA'
      ),
      contraloriaGlobal: mkToken(
        IDS.contraloriaGlobal,
        'audit.nac@codizulca.local',
        'contraloria',
        'GLOBAL'
      ),
    };

    const profilesById = new Map([
      [IDS.superAdmin, { role: 'super_admin', sucursal: 'GLOBAL', is_active: true }],
      [IDS.coordZulia, { role: 'coordinacion', sucursal: 'ZULIA', is_active: true }],
      [IDS.contraloriaVal, { role: 'contraloria', sucursal: 'VALENCIA', is_active: true }],
      [IDS.contraloriaGlobal, { role: 'contraloria', sucursal: 'GLOBAL', is_active: true }],
    ]);

    const tokenToUser = new Map([
      [TOKENS.superAdmin, { id: IDS.superAdmin, email: 'root@codizulca.local' }],
      [TOKENS.coordZulia, { id: IDS.coordZulia, email: 'coord.zulia@codizulca.local' }],
      [TOKENS.contraloriaVal, { id: IDS.contraloriaVal, email: 'audit.val@codizulca.local' }],
      [TOKENS.contraloriaGlobal, { id: IDS.contraloriaGlobal, email: 'audit.nac@codizulca.local' }],
    ]);

    const mockSupabase = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const u = tokenToUser.get(bearer);
        if (!u) {
          res.statusCode = 401;
          res.end(JSON.stringify({ message: 'Invalid token' }));
          return;
        }
        const prof = profilesById.get(u.id)!;
        res.end(
          JSON.stringify({
            id: u.id,
            email: u.email,
            app_metadata: { role: prof.role, app_role: prof.role, sucursal: prof.sucursal },
          })
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/rest/v1/profiles') {
        const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
        res.end(JSON.stringify(profilesById.get(idEq) ?? null));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth/v1/admin/users') {
        const newId = crypto.randomUUID();
        res.end(
          JSON.stringify({
            user: {
              id: newId,
              email: body.email,
              app_metadata: body.app_metadata,
            },
          })
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/admin_finalize_created_user') {
        res.end(
          JSON.stringify([
            {
              id: body.p_target_user_id,
              email: 'nuevo@codizulca.local',
              full_name: body.p_full_name,
              role: body.p_role,
              sucursal: body.p_sucursal,
              is_active: true,
              must_change_password: Boolean(body.p_must_change_password),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ])
        );
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });

    await new Promise<void>((r) => mockSupabase.listen(0, '127.0.0.1', () => r()));
    const supaBase = `http://127.0.0.1:${(mockSupabase.address() as AddressInfo).port}`;

    const prevEnv = {
      url: process.env.SUPABASE_URL,
      pub: process.env.SUPABASE_PUBLISHABLE_KEY,
      srv: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    process.env.SUPABASE_URL = supaBase;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_hito1_test_0123456789';
    process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;

    const authMod = await import('../src/server/supabaseAdminAuth');
    const evMod = await import('../src/server/attendanceEvidencesHandler');

    const gateway = {
      async lookupStaffProfile(promotoraId: string) {
        if (promotoraId === IDS.staffValencia) {
          return {
            id: IDS.staffValencia,
            name: 'Promotora Valencia',
            email: 'prom.val@codizulca.local',
            assignedStore: 'PDV Valencia',
            address: 'Naguanagua',
            sucursal: 'VALENCIA' as const,
            active: true,
            isMerchandising: false,
            masterProfile: 'FIJA' as const,
          };
        }
        return null;
      },
      async findJornadaByDateAndPromotora() {
        return null;
      },
      async findEvidencesWithOwnerByIds(ids: string[]) {
        const all = [
          {
            evidencia: {
              id: IDS.evZulia,
              storage_path: 'asistencia/2026-11-18/Z/JORNADA_INGRESO.png',
              sucursal: 'ZULIA' as const,
            },
            promotoraId: IDS.staffZulia,
            sucursal: 'ZULIA' as const,
          },
          {
            evidencia: {
              id: IDS.evValencia,
              storage_path: 'asistencia/2026-11-18/V/JORNADA_INGRESO.png',
              sucursal: 'VALENCIA' as const,
            },
            promotoraId: IDS.staffValencia,
            sucursal: 'VALENCIA' as const,
          },
        ];
        return all.filter((item) => ids.includes(item.evidencia.id)) as any;
      },
      async createSignedUrls(_bucket: string, paths: string[]) {
        return Object.fromEntries(paths.map((p) => [p, `https://signed.local/${p}`]));
      },
    };

    const handlers = evMod.createAttendanceEvidencesHandlers({
      resolveGateway: () => gateway as any,
      now: () => new Date('2026-11-18T15:00:00Z'),
    });

    const app = express();
    app.post(
      '/api/admin/corporate-users',
      express.json(),
      authMod.requireSuperAdminAuth,
      authMod.handleCreateCorporateUser
    );
    app.post(
      '/api/asistencia/evidencias',
      authMod.requireAttendanceActorAuth,
      express.raw({ type: '*/*', limit: '6mb' }),
      handlers.handleUploadEvidence
    );
    app.post(
      '/api/asistencia/evidencias/signed-urls',
      authMod.requireAttendanceActorAuth,
      express.json(),
      handlers.handleBatchSignedUrls
    );

    const api = http.createServer(app);
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    try {
      // A) Rol regional (`vendedor` / `coordinacion`) con sucursal `GLOBAL` -> 400 INVALID_SUCURSAL_FOR_ROLE
      for (const regionalRole of ['vendedor', 'coordinacion', 'promotora', 'cliente', 'chofer']) {
        const badGlobal = await fetch(`${apiBase}/api/admin/corporate-users`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKENS.superAdmin}`,
          },
          body: JSON.stringify({
            fullName: `Prueba ${regionalRole}`,
            email: `${regionalRole}@codizulca.local`,
            password: 'PasswordSegura123!',
            role: regionalRole,
            sucursal: 'GLOBAL',
          }),
        });
        assert.equal(badGlobal.status, 400);
        const badJson = (await badGlobal.json()) as { code?: string };
        assert.equal(badJson.code, 'INVALID_SUCURSAL_FOR_ROLE');
      }

      // B) Creación válida de `chofer` en `VALENCIA` y `cliente` en `ZULIA` -> 201
      const okChofer = await fetch(`${apiBase}/api/admin/corporate-users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKENS.superAdmin}`,
        },
        body: JSON.stringify({
          fullName: 'Chofer Ruta Valencia',
          email: 'chofer.val@codizulca.local',
          password: 'PasswordSegura123!',
          role: 'chofer',
          sucursal: 'valencia',
        }),
      });
      assert.equal(okChofer.status, 201);
      const choferJson = (await okChofer.json()) as { profile: { role: string; sucursal: string } };
      assert.equal(choferJson.profile.role, 'chofer');
      assert.equal(choferJson.profile.sucursal, 'VALENCIA');

      // C) Coordinadora ZULIA: ve Zulia (200), bloqueada en Valencia (403 FORBIDDEN_BRANCH)
      const coordZuliaOk = await fetch(`${apiBase}/api/asistencia/evidencias/signed-urls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKENS.coordZulia}`,
        },
        body: JSON.stringify({ evidenciaIds: [IDS.evZulia] }),
      });
      assert.equal(coordZuliaOk.status, 200);

      const coordZuliaCross = await fetch(`${apiBase}/api/asistencia/evidencias/signed-urls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKENS.coordZulia}`,
        },
        body: JSON.stringify({ evidenciaIds: [IDS.evValencia] }),
      });
      assert.equal(coordZuliaCross.status, 403);
      assert.equal(((await coordZuliaCross.json()) as { code?: string }).code, 'FORBIDDEN_BRANCH');

      // Coordinadora ZULIA intentando subir evidencia para promotora de VALENCIA -> 403 FORBIDDEN_BRANCH
      const metaHeader = Buffer.from(
        JSON.stringify({
          promotoraId: IDS.staffValencia,
          fechaJornada: '2026-11-18',
          slotFoto: 'JORNADA_INGRESO',
          pdvNombre: 'PDV Valencia',
        }),
        'utf8'
      ).toString('base64');
      const coordCrossUpload = await fetch(`${apiBase}/api/asistencia/evidencias`, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/png',
          Authorization: `Bearer ${TOKENS.coordZulia}`,
          'x-asistencia-meta': metaHeader,
        },
        body: VALID_TINY_PNG,
      });
      assert.equal(coordCrossUpload.status, 403);
      assert.equal(((await coordCrossUpload.json()) as { code?: string }).code, 'FORBIDDEN_BRANCH');

      // D) Contraloría regional VALENCIA: ve Valencia (200), bloqueada en Zulia (403 FORBIDDEN_BRANCH)
      const auditValOk = await fetch(`${apiBase}/api/asistencia/evidencias/signed-urls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKENS.contraloriaVal}`,
        },
        body: JSON.stringify({ evidenciaIds: [IDS.evValencia] }),
      });
      assert.equal(auditValOk.status, 200);

      const auditValCross = await fetch(`${apiBase}/api/asistencia/evidencias/signed-urls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKENS.contraloriaVal}`,
        },
        body: JSON.stringify({ evidenciaIds: [IDS.evZulia] }),
      });
      assert.equal(auditValCross.status, 403);
      assert.equal(((await auditValCross.json()) as { code?: string }).code, 'FORBIDDEN_BRANCH');

      // E) Contraloría nacional GLOBAL y Super Admin GLOBAL: ven ambas sedes simultáneamente (200)
      for (const globalToken of [TOKENS.contraloriaGlobal, TOKENS.superAdmin]) {
        const resBoth = await fetch(`${apiBase}/api/asistencia/evidencias/signed-urls`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${globalToken}`,
          },
          body: JSON.stringify({ evidenciaIds: [IDS.evZulia, IDS.evValencia] }),
        });
        assert.equal(resBoth.status, 200);
        const bodyBoth = (await resBoth.json()) as { signedUrls: Record<string, unknown> };
        assert.ok(bodyBoth.signedUrls[IDS.evZulia]);
        assert.ok(bodyBoth.signedUrls[IDS.evValencia]);
      }
    } finally {
      await new Promise<void>((r) => api.close(() => r()));
      await new Promise<void>((r) => mockSupabase.close(() => r()));
      if (prevEnv.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = prevEnv.url;
      if (prevEnv.pub === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
      else process.env.SUPABASE_PUBLISHABLE_KEY = prevEnv.pub;
      if (prevEnv.srv === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = prevEnv.srv;
    }
  });
});
