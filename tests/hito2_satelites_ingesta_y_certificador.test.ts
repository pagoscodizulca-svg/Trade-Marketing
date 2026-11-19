import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
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
import {
  createRateLimiter,
  requireFdvOrTradeAuth,
  type AuthenticatedServerUser,
} from '../src/server/supabaseAdminAuth';
import {
  createFdvSolicitudesHandler,
  getCaracasTodayYmd,
  type FdvSolicitudesGateway,
  type PersistFdvSurveyRecord,
  type StoredFdvSurveyRow,
} from '../src/server/fdvSolicitudesHandler';
import {
  assertPublicSupabaseKey,
  canAccessChoferMode,
  canAccessOficinaMode,
  normalizarSupabaseUrl,
  normalizeRutaRole,
  normalizeRutaSucursal,
  resolveAllowedModes,
  resolveEffectiveMode,
  resolveRutaSupabaseConfig,
  UNIFIED_SUPABASE_STORAGE_KEY,
  verifyRutaProfileAccess,
} from '../ruta-degustacion/src/services/supabaseAuth';
import { buildOutboxHeaders } from '../ruta-degustacion/src/lib/syncCore';
import { esClaveAuth, esBaseAuth } from '../ruta-degustacion/src/services/cleanSync';
import {
  assertSafeEnvironment,
  CRITICAL_SCHEMA_TABLES,
  REQUIRED_SCHEMA_FUNCTIONS,
  redactSecrets,
  runRemoteCertification,
  runStaticCertification,
  SecurityEnvViolationError,
  type RemoteCatalogPayload,
} from '../scripts/certifySchemaProduction';

const ROOT_DIR = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'supabase', 'migrations');
const HITO2_MIGRATION = '20261118000500_hito2_fdv_ingesta_idempotente_y_certificador.sql';

function loadAllMigrations(): MigrationFile[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

function buildCompliantRemoteCatalog(): RemoteCatalogPayload {
  const functions: Record<string, boolean> = {
    vincular_mi_usuario_auth: false,
  };
  for (const fn of REQUIRED_SCHEMA_FUNCTIONS) {
    functions[fn] = true;
  }

  return {
    certified_at: new Date().toISOString(),
    schema: 'public',
    sucursal_codigo_enum: ['ZULIA', 'VALENCIA', 'GLOBAL'],
    tables: CRITICAL_SCHEMA_TABLES.map((table_name) => ({
      table_name,
      exists: true,
      rls_enabled: true,
      force_rls: true,
      has_sucursal_column: true,
      sucursal_type: 'sucursal_codigo',
      policy_count: 3,
      anon_policy_count: 0,
      unfiltered_legacy_policies: [],
    })),
    legacy_tables: {
      perfiles_acceso_exists: false,
      perfiles_acceso_deprecado_exists: true,
    },
    functions,
    indexes: {
      uq_surveys_degustacion_key_active: true,
      idx_surveys_autor_user_id: true,
      idx_clientes_vendedor_id: true,
      idx_clientes_codigo_vendedor: true,
    },
    surveys_columns: {
      autor_user_id: true,
      sucursal: true,
      degustacion_key: true,
    },
    anon_table_grants: [],
  };
}

function futureCaracasDate(daysAhead = 5): string {
  const today = getCaracasTodayYmd();
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + daysAhead));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

test('HITO 2 — RutaDegustación Zero-Trust (S-06), Ingesta FDV Idempotente (N-07) y Certificador (B-04)', async (t) => {
  await t.test('1) Migración 20261118000500: analizador estático 0 errores, clave idempotente y RPC de catálogo', () => {
    const files = loadAllMigrations();
    const analysis = analyzeMigrations(files);
    assert.equal(
      analysis.errors.length,
      0,
      `Errores en cadena de migraciones:\n${formatIssues(analysis.errors)}`
    );

    const hito2Sql = fs.readFileSync(path.join(MIGRATIONS_DIR, HITO2_MIGRATION), 'utf8');
    assert.doesNotMatch(hito2Sql, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(hito2Sql, /\bTRUNCATE\b/i);

    const surveysCols = analysis.tables.get('surveys');
    assert.ok(surveysCols?.has('degustacion_key'), 'public.surveys debe incluir degustacion_key');
    assert.ok(surveysCols?.has('autor_user_id'), 'public.surveys debe conservar autor_user_id');
    assert.ok(surveysCols?.has('sucursal'), 'public.surveys debe conservar sucursal');

    assert.match(hito2Sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_surveys_degustacion_key_active/i);
    assert.match(hito2Sql, /CREATE TRIGGER trg_surveys_normalizar_degustacion_key/i);
    assert.match(hito2Sql, /CREATE OR REPLACE FUNCTION public\.rpc_certificar_esquema_trade\(\)/i);
    assert.match(
      hito2Sql,
      /REVOKE ALL ON FUNCTION public\.rpc_certificar_esquema_trade\(\) FROM PUBLIC, anon/i
    );
    assert.match(hito2Sql, /SET search_path = pg_catalog, public/i);
    assert.match(hito2Sql, /public\.is_super_admin\(\)/i);
    assert.equal(
      analysis.functions.has('public.rpc_certificar_esquema_trade'),
      true,
      'rpc_certificar_esquema_trade debe quedar registrada en el esquema'
    );
  });

  await t.test('2) S-06 ruta-degustacion: persistSession: true, validación de llaves, RBAC, cleanSync y JWT en syncCore', async () => {
    const repoSource = fs.readFileSync(
      path.join(ROOT_DIR, 'ruta-degustacion', 'src', 'services', 'supabaseRepository.ts'),
      'utf8'
    );
    const authSource = fs.readFileSync(
      path.join(ROOT_DIR, 'ruta-degustacion', 'src', 'services', 'supabaseAuth.ts'),
      'utf8'
    );
    const mainSource = fs.readFileSync(
      path.join(ROOT_DIR, 'ruta-degustacion', 'src', 'main.tsx'),
      'utf8'
    );
    const appSource = fs.readFileSync(
      path.join(ROOT_DIR, 'ruta-degustacion', 'src', 'App.tsx'),
      'utf8'
    );

    // Regresión S-06: eliminado `persistSession: false` y el arranque previo a autenticación
    assert.doesNotMatch(repoSource, /persistSession\s*:\s*false/i);
    assert.doesNotMatch(mainSource, /entregasRepo\.start\(\)/);
    assert.match(authSource, /persistSession:\s*true/);
    assert.match(authSource, /autoRefreshToken:\s*true/);
    assert.equal(UNIFIED_SUPABASE_STORAGE_KEY, 'codizulca.supabase.auth.v1');
    assert.match(appSource, /RutaAuthGate/);

    // Normalización de URL y bloqueo de llaves secretas
    assert.equal(
      normalizarSupabaseUrl('https://apaxdgxtaoeyswlfblgi.supabase.co/rest/v1/'),
      'https://apaxdgxtaoeyswlfblgi.supabase.co'
    );
    assert.throws(
      () => assertPublicSupabaseKey('sb_secret_fake_123456'),
      /sb_secret_/i
    );
    assert.throws(
      () => assertPublicSupabaseKey(MOCK_SERVICE_ROLE_KEY),
      /service_role/i
    );
    assert.equal(assertPublicSupabaseKey('sb_publishable_demo_key_123'), 'sb_publishable_demo_key_123');

    const resolvedPub = resolveRutaSupabaseConfig({
      VITE_SUPABASE_URL: 'https://apaxdgxtaoeyswlfblgi.supabase.co/rest/v1/',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_demo_key_123',
      VITE_SUPABASE_ANON_KEY: MOCK_PUBLIC_ANON_KEY,
    });
    assert.equal(resolvedPub.configError, null);
    assert.equal(resolvedPub.config?.publicKey, 'sb_publishable_demo_key_123');

    const blockedSecret = resolveRutaSupabaseConfig({
      VITE_SUPABASE_URL: 'https://apaxdgxtaoeyswlfblgi.supabase.co',
      VITE_SUPABASE_ANON_KEY: MOCK_SERVICE_ROLE_KEY,
    });
    assert.equal(blockedSecret.config, null);
    assert.match(blockedSecret.configError || '', /service_role/i);

    // Reglas RBAC puras
    assert.equal(normalizeRutaRole('chofer'), 'chofer');
    assert.equal(normalizeRutaRole('coordinacion'), 'coordinacion');
    assert.equal(normalizeRutaRole('super_admin'), 'super_admin');
    for (const denied of ['vendedor', 'promotora', 'cliente', 'contraloria']) {
      assert.equal(normalizeRutaRole(denied), null, `${denied} no debe entrar en RutaDegustación`);
    }
    assert.equal(canAccessChoferMode('chofer'), true);
    assert.equal(canAccessOficinaMode('chofer'), false);
    assert.deepEqual(resolveAllowedModes('chofer'), ['chofer']);
    assert.equal(resolveEffectiveMode('oficina', 'chofer'), 'chofer');
    assert.deepEqual(resolveAllowedModes('coordinacion'), ['chofer', 'oficina']);
    assert.deepEqual(resolveAllowedModes('super_admin'), ['chofer', 'oficina']);
    assert.equal(normalizeRutaSucursal('GLOBAL', 'coordinacion'), null);
    assert.equal(normalizeRutaSucursal('GLOBAL', 'chofer'), null);
    assert.equal(normalizeRutaSucursal('ZULIA', 'chofer'), 'ZULIA');
    assert.equal(normalizeRutaSucursal('GLOBAL', 'super_admin'), 'GLOBAL');

    // `syncCore.buildOutboxHeaders` exige Bearer JWT del usuario y prohíbe usar `anonKey` como Authorization
    const userJwt = buildMockJwt({ sub: crypto.randomUUID(), role: 'authenticated' });
    const headers = buildOutboxHeaders(
      { url: 'https://apaxdgxtaoeyswlfblgi.supabase.co', anonKey: MOCK_PUBLIC_ANON_KEY },
      userJwt
    );
    assert.equal(headers.apikey, MOCK_PUBLIC_ANON_KEY);
    assert.equal(headers.Authorization, `Bearer ${userJwt}`);
    assert.throws(
      () =>
        buildOutboxHeaders(
          { url: 'https://apaxdgxtaoeyswlfblgi.supabase.co', anonKey: MOCK_PUBLIC_ANON_KEY },
          MOCK_PUBLIC_ANON_KEY
        ),
      /Token de sesión ausente o inválido/i
    );

    // `cleanSync` de ruta-degustacion preserva claves corporativas `codizulca.*` y `sb-*`
    assert.equal(esClaveAuth('sb-apaxdgxtaoeyswlfblgi-auth-token'), true);
    assert.equal(esClaveAuth('codizulca.supabase.auth.v1'), true);
    assert.equal(esClaveAuth('codizulca.ruta.profile.v1'), true);
    assert.equal(esClaveAuth('rutadegustacion:v1:modo'), false);
    assert.equal(esBaseAuth('rutadegustacion-offline'), true);

    // `verifyRutaProfileAccess` verifica `public.profiles` y hace `signOut()` inmediato si el rol no está permitido o está suspendido
    const makeMockClient = (profileRow: Record<string, unknown> | null) => {
      let signedOut = false;
      let realtimeToken: string | null = null;
      const client = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: profileRow, error: null }),
            }),
          }),
        }),
        auth: {
          signOut: async () => {
            signedOut = true;
            return { error: null };
          },
        },
        realtime: {
          setAuth: (tok: string) => {
            realtimeToken = tok;
          },
        },
      } as unknown as SupabaseClient;
      return {
        client,
        wasSignedOut: () => signedOut,
        getRealtimeToken: () => realtimeToken,
      };
    };

    const choferId = crypto.randomUUID();
    const choferSession = {
      access_token: userJwt,
      user: { id: choferId, email: 'chofer.zulia@codizulca.com' },
    } as unknown as Session;

    const okMock = makeMockClient({
      id: choferId,
      email: 'chofer.zulia@codizulca.com',
      full_name: 'Carlos Chofer',
      role: 'chofer',
      sucursal: 'ZULIA',
      is_active: true,
    });
    const okRes = await verifyRutaProfileAccess(okMock.client, choferSession);
    assert.equal(okRes.ok, true);
    if (okRes.ok) {
      assert.equal(okRes.user.role, 'chofer');
      assert.equal(okRes.user.sucursal, 'ZULIA');
    }
    assert.equal(okMock.getRealtimeToken(), userJwt);
    assert.equal(okMock.wasSignedOut(), false);

    const deniedRoleMock = makeMockClient({
      id: choferId,
      email: 'vendedor@codizulca.com',
      full_name: 'Vendedor No Logistica',
      role: 'vendedor',
      sucursal: 'ZULIA',
      is_active: true,
    });
    const deniedRes = await verifyRutaProfileAccess(deniedRoleMock.client, choferSession);
    assert.equal(deniedRes.ok, false);
    if (!deniedRes.ok) assert.equal(deniedRes.code, 'FORBIDDEN_ROLE');
    assert.equal(deniedRoleMock.wasSignedOut(), true, 'Rol no autorizado debe ejecutar signOut inmediato');

    const suspendedMock = makeMockClient({
      id: choferId,
      email: 'chofer.susp@codizulca.com',
      full_name: 'Chofer Suspendido',
      role: 'chofer',
      sucursal: 'ZULIA',
      is_active: false,
    });
    const suspRes = await verifyRutaProfileAccess(suspendedMock.client, choferSession);
    assert.equal(suspRes.ok, false);
    if (!suspRes.ok) assert.equal(suspRes.code, 'ACCOUNT_SUSPENDED');
    assert.equal(suspendedMock.wasSignedOut(), true, 'Cuenta suspendida debe ejecutar signOut inmediato');
  });

  await t.test('3) N-07 E2E: POST /api/fdv/solicitudes-degustacion (JWT, Zod, sede, anti auto-aprobación y carrera Promise.all)', async () => {
    const vendedorZuliaA = crypto.randomUUID();
    const vendedorZuliaB = crypto.randomUUID();
    const superAdminId = crypto.randomUUID();
    const promotoraId = crypto.randomUUID();
    const contraloriaId = crypto.randomUUID();
    const suspendedVendedorId = crypto.randomUUID();

    const tokenFor = (sub: string, email: string, appRole: string, sucursal: string) =>
      buildMockJwt({
        sub,
        email,
        role: 'authenticated',
        app_metadata: { app_role: appRole, role: appRole, sucursal },
      });

    const tokens = {
      vendedorA: tokenFor(vendedorZuliaA, 'vendedor.a@codizulca.com', 'vendedor', 'ZULIA'),
      vendedorB: tokenFor(vendedorZuliaB, 'vendedor.b@codizulca.com', 'vendedor', 'ZULIA'),
      superAdmin: tokenFor(superAdminId, 'admin@codizulca.com', 'super_admin', 'GLOBAL'),
      promotora: tokenFor(promotoraId, 'promotora@codizulca.com', 'promotora', 'ZULIA'),
      contraloria: tokenFor(contraloriaId, 'contraloria@codizulca.com', 'contraloria', 'GLOBAL'),
      suspended: tokenFor(suspendedVendedorId, 'susp@codizulca.com', 'vendedor', 'ZULIA'),
    };

    const userMap = new Map<
      string,
      { id: string; email: string; role: string; sucursal: string; is_active: boolean }
    >([
      [tokens.vendedorA, { id: vendedorZuliaA, email: 'vendedor.a@codizulca.com', role: 'vendedor', sucursal: 'ZULIA', is_active: true }],
      [tokens.vendedorB, { id: vendedorZuliaB, email: 'vendedor.b@codizulca.com', role: 'vendedor', sucursal: 'ZULIA', is_active: true }],
      [tokens.superAdmin, { id: superAdminId, email: 'admin@codizulca.com', role: 'super_admin', sucursal: 'GLOBAL', is_active: true }],
      [tokens.promotora, { id: promotoraId, email: 'promotora@codizulca.com', role: 'promotora', sucursal: 'ZULIA', is_active: true }],
      [tokens.contraloria, { id: contraloriaId, email: 'contraloria@codizulca.com', role: 'contraloria', sucursal: 'GLOBAL', is_active: true }],
      [tokens.suspended, { id: suspendedVendedorId, email: 'susp@codizulca.com', role: 'vendedor', sucursal: 'ZULIA', is_active: false }],
    ]);

    const profilesById = new Map(
      [...userMap.values()].map((u) => [u.id, u])
    );

    // Servidor mock local de Supabase Auth + PostgREST `/rest/v1/profiles`
    const mockSupabaseServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/auth/v1/user') {
        const auth = String(req.headers.authorization || '');
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        const u = userMap.get(bearer);
        if (!u) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Invalid JWT' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: u.id,
            email: u.email,
            app_metadata: { app_role: u.role, role: u.role, sucursal: u.sucursal },
          })
        );
        return;
      }

      if (url.pathname === '/rest/v1/profiles') {
        const idParam = url.searchParams.get('id') || '';
        const id = idParam.replace(/^eq\./, '');
        const profile = profilesById.get(id) ?? null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            profile
              ? { role: profile.role, is_active: profile.is_active, sucursal: profile.sucursal }
              : null
          )
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise<void>((resolve) => mockSupabaseServer.listen(0, '127.0.0.1', resolve));
    const mockPort = (mockSupabaseServer.address() as AddressInfo).port;
    const prevEnv = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };

    process.env.SUPABASE_URL = `http://127.0.0.1:${mockPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = MOCK_PUBLIC_ANON_KEY;
    process.env.SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;

    // Gateway en memoria que simula el índice UNIQUE `uq_surveys_degustacion_key_active` + latencia de carrera real
    const rowsById = new Map<string, StoredFdvSurveyRow>();
    const idByKey = new Map<string, string>();

    const gateway: FdvSolicitudesGateway = {
      async findActiveByKey(authUser: AuthenticatedServerUser, degustacionKey: string) {
        // Pequeña pausa asincrónica para que un `Promise.all` sí entre simultáneamente en carrera antes del INSERT
        await new Promise((r) => setTimeout(r, 15));
        const existingId = idByKey.get(degustacionKey);
        if (!existingId) return null;
        const row = rowsById.get(existingId) ?? null;
        if (!row) return null;
        // Simular RLS: un vendedor solo ve sus propias filas
        if (!authUser.isCoordinatorOrAdmin && row.autor_user_id !== authUser.id) {
          return null;
        }
        return row;
      },
      async insertSolicitud(_authUser: AuthenticatedServerUser, record: PersistFdvSurveyRecord) {
        // Simulación atómica del índice UNIQUE `uq_surveys_degustacion_key_active` (PG 23505)
        if (idByKey.has(record.degustacion_key)) {
          return { status: 'conflict' };
        }
        const created: StoredFdvSurveyRow = {
          id: crypto.randomUUID(),
          ...record,
          en_historial: false,
        };
        rowsById.set(created.id, created);
        idByKey.set(record.degustacion_key, created.id);
        return { status: 'inserted', row: created };
      },
      async updateSolicitud(
        _authUser: AuthenticatedServerUser,
        id: string,
        record: Omit<PersistFdvSurveyRecord, 'created_at' | 'autor_user_id'>
      ) {
        const cur = rowsById.get(id);
        assert.ok(cur, 'Fila debe existir para actualizar');
        const updated: StoredFdvSurveyRow = { ...cur, ...record };
        rowsById.set(id, updated);
        return updated;
      },
    };

    const app = express();
    app.use(express.json());
    app.post(
      '/api/fdv/solicitudes-degustacion',
      requireFdvOrTradeAuth,
      createRateLimiter({ windowMs: 60_000, maxRequests: 15 }),
      createFdvSolicitudesHandler(gateway)
    );

    const apiServer = http.createServer(app);
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const apiPort = (apiServer.address() as AddressInfo).port;
    const baseApi = `http://127.0.0.1:${apiPort}/api/fdv/solicitudes-degustacion`;
    const validFecha = futureCaracasDate(5);

    try {
      // 3.a Sin token -> 401
      const noAuthRes = await fetch(baseApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clienteNombre: 'PDV SIN AUTH', fecha: validFecha, productos: ['MORTADELA'] }),
      });
      assert.equal(noAuthRes.status, 401);

      // 3.b Roles no permitidos y cuenta suspendida -> 403
      for (const [label, tok] of [
        ['promotora', tokens.promotora],
        ['contraloria', tokens.contraloria],
        ['suspended', tokens.suspended],
      ] as const) {
        const res = await fetch(baseApi, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ clienteNombre: 'PDV DENEGADO', fecha: validFecha, productos: ['MORTADELA'] }),
        });
        assert.equal(res.status, 403, `${label} debe recibir 403`);
      }

      // 3.c Payload inválido (Zod) -> 400
      const badZod = await fetch(baseApi, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.vendedorA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clienteNombre: 'A', fecha: '2020-01-01', productos: [] }),
      });
      assert.equal(badZod.status, 400);
      const badZodJson = (await badZod.json()) as { code: string };
      assert.equal(badZodJson.code, 'INVALID_SOLICITUD_PAYLOAD');

      // 3.d Vendedor ZULIA intentando escribir en VALENCIA -> 403 FORBIDDEN_BRANCH
      const crossBranch = await fetch(baseApi, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.vendedorA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clienteNombre: 'AUTOMERCADO VALENCIA',
          fecha: validFecha,
          productos: ['MORTADELA'],
          sucursal: 'VALENCIA',
        }),
      });
      assert.equal(crossBranch.status, 403);
      const crossJson = (await crossBranch.json()) as { code: string };
      assert.equal(crossJson.code, 'FORBIDDEN_BRANCH');

      // 3.e Vendedor ZULIA válido con intento de auto-aprobación y spoofing de autor -> servidor sella todo
      const createRes = await fetch(baseApi, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.vendedorA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          degustacionId: 'DEG-HITO2-SINGLE-01',
          clienteCodigo: 'CLI-001',
          clienteNombre: 'SUPERMERCADO ZULIA CENTRAL',
          fecha: validFecha,
          turno: 'MANANA',
          productos: ['MORTADELA ASTURIAS', 'CHULETA AHUMADA'],
          kilosEstimados: 4,
          personasEstimadas: 90,
          // Intentos de manipulación que el servidor debe ignorar
          estado: 'APROBADA',
          autor_user_id: superAdminId,
        }),
      });
      assert.equal(createRes.status, 201);
      const createBody = (await createRes.json()) as {
        ok: boolean;
        idempotentHit: boolean;
        solicitud: StoredFdvSurveyRow;
      };
      assert.equal(createBody.ok, true);
      assert.equal(createBody.idempotentHit, false);
      assert.equal(createBody.solicitud.autor_user_id, vendedorZuliaA);
      assert.equal(createBody.solicitud.sucursal, 'ZULIA');
      assert.equal(createBody.solicitud.degustacion_key, 'hito2-single-01');
      assert.equal(createBody.solicitud.leido_trade, false);
      const parsedComments = JSON.parse(createBody.solicitud.comments) as Record<string, unknown>;
      assert.equal(parsedComments.estado, 'SOLICITADA', 'Jamás permitir auto-aprobación del vendedor');

      // 3.f Carrera paralela (`Promise.all`) con el mismo degustacionId -> 1 sola fila única!
      const racePayload = JSON.stringify({
        degustacionId: 'deg-hito2-race-99',
        clienteNombre: 'HIPERMERCADO MARACAIBO',
        fecha: validFecha,
        turno: 'TARDE',
        productos: ['JAMON SUPERIOR'],
      });
      const [r1, r2] = await Promise.all([
        fetch(baseApi, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.vendedorA}`, 'Content-Type': 'application/json' },
          body: racePayload,
        }),
        fetch(baseApi, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.vendedorA}`, 'Content-Type': 'application/json' },
          body: racePayload,
        }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      assert.deepEqual(statuses, [200, 201], 'Una petición inserta (201) y su gemela concurrente resuelve idempotente (200)');
      const b1 = (await r1.json()) as { solicitud: StoredFdvSurveyRow; idempotentHit: boolean };
      const b2 = (await r2.json()) as { solicitud: StoredFdvSurveyRow; idempotentHit: boolean };
      assert.equal(b1.solicitud.id, b2.solicitud.id, 'Ambas respuestas paralelas deben devolver exactamente el mismo ID');
      const raceMatches = [...rowsById.values()].filter(
        (row) => row.degustacion_key === 'hito2-race-99'
      );
      assert.equal(raceMatches.length, 1, 'Cero duplicados ante Promise.all paralelo');

      // 3.g Vendedor B intenta colisionar sobre el degustacionId de Vendedor A -> 409 DEGUSTACION_ID_CONFLICT
      const hijackRes = await fetch(baseApi, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.vendedorB}`, 'Content-Type': 'application/json' },
        body: racePayload,
      });
      assert.equal(hijackRes.status, 409);
      const hijackBody = (await hijackRes.json()) as { code: string };
      assert.equal(hijackBody.code, 'DEGUSTACION_ID_CONFLICT');

      // 3.h Super Admin GLOBAL debe especificar sucursal operativa
      const globalMissing = await fetch(baseApi, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.superAdmin}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clienteNombre: 'PDV GLOBAL SIN SEDE',
          fecha: validFecha,
          productos: ['MORTADELA'],
        }),
      });
      assert.equal(globalMissing.status, 400);

      const globalOk = await fetch(baseApi, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.superAdmin}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          degustacionId: 'deg-hito2-valencia-01',
          clienteNombre: 'CENTRAL MADEIRENSE VALENCIA',
          fecha: validFecha,
          productos: ['ESPALDA'],
          sucursal: 'VALENCIA',
        }),
      });
      assert.equal(globalOk.status, 201);
      const globalBody = (await globalOk.json()) as { solicitud: StoredFdvSurveyRow };
      assert.equal(globalBody.solicitud.sucursal, 'VALENCIA');
    } finally {
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
      await new Promise<void>((resolve) => mockSupabaseServer.close(() => resolve()));
      process.env.SUPABASE_URL = prevEnv.SUPABASE_URL;
      process.env.SUPABASE_PUBLISHABLE_KEY = prevEnv.SUPABASE_PUBLISHABLE_KEY;
      process.env.SUPABASE_ANON_KEY = prevEnv.SUPABASE_ANON_KEY;
      process.env.SUPABASE_SERVICE_ROLE_KEY = prevEnv.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  await t.test('4) B-04 Certificador de esquema: solo lectura, cero .env, bloqueo VITE_* secreto y verificación remota mock', async () => {
    const certifierSource = fs.readFileSync(
      path.join(ROOT_DIR, 'scripts', 'certifySchemaProduction.ts'),
      'utf8'
    );
    // Jamás importa dotenv ni lee archivos `.env`
    assert.doesNotMatch(certifierSource, /from\s+['"]dotenv['"]/);
    assert.doesNotMatch(certifierSource, /dotenv\.config/);
    assert.doesNotMatch(certifierSource, /readFileSync\([^)]*\.env/i);

    // 4.a Modo estático sobre las migraciones reales -> PASS
    const staticReport = runStaticCertification(MIGRATIONS_DIR);
    assert.equal(
      staticReport.passed,
      true,
      `Certificación estática falló:\n${staticReport.checks
        .filter((c) => !c.passed)
        .map((c) => `${c.id}: ${c.detail}`)
        .join('\n')}`
    );
    assert.equal(
      staticReport.duplicateVersionWarnings.length,
      3,
      'Debe reportar las 3 advertencias conocidas de versiones duplicadas (20261029, 20261112, 20261116)'
    );

    // 4.b Guardia de seguridad: se niega a correr si VITE_* contiene sb_secret_ o JWT service_role
    const secretSample = 'sb_secret_DEMO_LEAK_9999999';
    assert.throws(
      () =>
        assertSafeEnvironment({
          VITE_SUPABASE_PUBLISHABLE_KEY: secretSample,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SecurityEnvViolationError);
        assert.equal(err.code, 'SECRET_IN_VITE_ENV');
        assert.ok(!err.message.includes(secretSample), 'El error jamás debe imprimir la llave secreta');
        return true;
      }
    );

    assert.throws(
      () =>
        assertSafeEnvironment({
          VITE_SUPABASE_ANON_KEY: MOCK_SERVICE_ROLE_KEY,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SecurityEnvViolationError);
        assert.equal(err.code, 'SERVICE_ROLE_JWT_IN_VITE_ENV');
        assert.ok(!err.message.includes(MOCK_SERVICE_ROLE_KEY));
        return true;
      }
    );

    assert.equal(
      redactSecrets(`tok=${MOCK_SERVICE_ROLE_KEY} sec=${secretSample}`),
      'tok=[REDACTED_JWT] sec=[REDACTED_SB_SECRET]'
    );

    // 4.c Nunca usa VITE_SUPABASE_URL como respaldo en modo remoto
    await assert.rejects(
      () =>
        runRemoteCertification({
          VITE_SUPABASE_URL: 'https://apaxdgxtaoeyswlfblgi.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: MOCK_SERVICE_ROLE_KEY,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SecurityEnvViolationError);
        assert.equal(err.code, 'MISSING_SUPABASE_URL');
        return true;
      }
    );

    // 4.d Modo remoto contra RPC simulada de catálogo (PASS y FAIL)
    let nextPayload: RemoteCatalogPayload = buildCompliantRemoteCatalog();
    let rpcCalls = 0;

    const mockCatalogServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/rest/v1/rpc/rpc_certificar_esquema_trade') {
        rpcCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nextPayload));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    await new Promise<void>((resolve) => mockCatalogServer.listen(0, '127.0.0.1', resolve));
    const catalogPort = (mockCatalogServer.address() as AddressInfo).port;

    try {
      const passRemote = await runRemoteCertification(
        {
          SUPABASE_URL: `http://127.0.0.1:${catalogPort}`,
          SUPABASE_SERVICE_ROLE_KEY: MOCK_SERVICE_ROLE_KEY,
        },
        { allowLocalhostForTest: true }
      );
      assert.equal(passRemote.passed, true);
      assert.equal(rpcCalls, 1);

      // Simular fuga de política `anon` + falta de índice único -> debe devolver FAIL
      const broken = buildCompliantRemoteCatalog();
      broken.tables![0]!.anon_policy_count = 1;
      broken.indexes!.uq_surveys_degustacion_key_active = false;
      broken.anon_table_grants = [{ table_name: 'surveys', select: true }];
      nextPayload = broken;

      const failRemote = await runRemoteCertification(
        {
          SUPABASE_URL: `http://127.0.0.1:${catalogPort}`,
          SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_demo_key_123',
          CERTIFIER_BEARER_TOKEN: buildMockJwt({ sub: crypto.randomUUID(), role: 'authenticated' }),
        },
        { allowLocalhostForTest: true }
      );
      assert.equal(failRemote.passed, false);
      const failedIds = new Set(failRemote.checks.filter((c) => !c.passed).map((c) => c.id));
      assert.ok(failedIds.has('remote.zero_anon_policies'));
      assert.ok(failedIds.has('remote.zero_anon_table_grants'));
      assert.ok(failedIds.has('remote.required_indexes'));
    } finally {
      await new Promise<void>((resolve) => mockCatalogServer.close(() => resolve()));
    }
  });

  await t.test('5) N-07 qa-sync-suite: alineación Zero-Anon, profiles + sucursal y servidor wired', () => {
    const seedSrc = fs.readFileSync(
      path.join(ROOT_DIR, 'qa-sync-suite', 'scripts', 'seed-qa-environment.mjs'),
      'utf8'
    );
    const teardownSrc = fs.readFileSync(
      path.join(ROOT_DIR, 'qa-sync-suite', 'scripts', 'teardown-qa-environment.mjs'),
      'utf8'
    );
    const specSrc = fs.readFileSync(
      path.join(ROOT_DIR, 'qa-sync-suite', 'tests', 'qa-sync-suite.spec.mjs'),
      'utf8'
    );
    const serverSrc = fs.readFileSync(path.join(ROOT_DIR, 'server.ts'), 'utf8');

    assert.match(seedSrc, /\.from\('profiles'\)\s*\.upsert\(/);
    assert.match(seedSrc, /appRole:\s*'coordinacion'/);
    assert.match(seedSrc, /sucursal:\s*qaSucursal/);
    assert.match(teardownSrc, /table_or_bucket:\s*'profiles'/);
    assert.match(specSrc, /\/api\/fdv\/solicitudes-degustacion/);
    assert.match(specSrc, /VULNERABILIDAD \(N-07\): rol anon pudo leer public\.surveys/);
    assert.match(specSrc, /VULNERABILIDAD \(S-06\): rol anon pudo leer public\.entregas_degustacion/);
    assert.match(serverSrc, /\/api\/fdv\/solicitudes-degustacion/);
    assert.match(serverSrc, /requireFdvOrTradeAuth/);
  });
});
