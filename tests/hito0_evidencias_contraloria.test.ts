import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { buildMockJwt, MOCK_SERVICE_ROLE_KEY } from './antigravity_audit/localMockInfra';

const PUBLISHABLE_FICTICIA = 'sb_publishable_clave_ficticia_hito0_evidencias';

const IDS = {
  contraloria: 'c0000000-0000-4000-8000-000000000001',
  contraloriaSuspendida: 'c0000000-0000-4000-8000-000000000002',
  coordinacion: 'c0000000-0000-4000-8000-000000000003',
  vendedor: 'c0000000-0000-4000-8000-000000000004',
  promotoraA: 'c0000000-0000-4000-8000-000000000005',
  staffA: 'a1000000-0000-4000-8000-000000000001',
  staffB: 'a1000000-0000-4000-8000-000000000002',
  evidenciaA: 'e1000000-0000-4000-8000-000000000001',
  evidenciaB: 'e1000000-0000-4000-8000-000000000002',
};

function token(sub: string, email: string, role: string): string {
  return buildMockJwt({
    sub,
    email,
    role: 'authenticated',
    app_metadata: { app_role: role },
    exp: 2100000000,
  });
}

const TOKENS = {
  contraloria: token(IDS.contraloria, 'contraloria@test.local', 'contraloria'),
  contraloriaSuspendida: token(IDS.contraloriaSuspendida, 'susp@test.local', 'contraloria'),
  coordinacion: token(IDS.coordinacion, 'coord@test.local', 'coordinacion'),
  vendedor: token(IDS.vendedor, 'vend@test.local', 'vendedor'),
  promotoraA: token(IDS.promotoraA, 'promo@test.local', 'promotora'),
};

/** Simula Supabase Auth (GET /auth/v1/user) y PostgREST (profiles y staff). */
function startMockSupabase(): Promise<{ server: http.Server; baseUrl: string }> {
  const users: Record<string, { id: string; email: string; role: string; profile: { role: string; is_active: boolean } | null }> = {
    [TOKENS.contraloria]: { id: IDS.contraloria, email: 'contraloria@test.local', role: 'contraloria', profile: { role: 'contraloria', is_active: true } },
    [TOKENS.contraloriaSuspendida]: { id: IDS.contraloriaSuspendida, email: 'susp@test.local', role: 'contraloria', profile: { role: 'contraloria', is_active: false } },
    [TOKENS.coordinacion]: { id: IDS.coordinacion, email: 'coord@test.local', role: 'coordinacion', profile: { role: 'coordinacion', is_active: true } },
    [TOKENS.vendedor]: { id: IDS.vendedor, email: 'vend@test.local', role: 'vendedor', profile: { role: 'vendedor', is_active: true } },
    [TOKENS.promotoraA]: { id: IDS.promotoraA, email: 'promo@test.local', role: 'promotora', profile: null },
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const u = users[bearer];
      if (!u) {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'invalid token' }));
        return;
      }
      res.end(
        JSON.stringify({
          id: u.id,
          email: u.email,
          app_metadata: { app_role: u.role, ...(u.role === 'promotora' ? { staff_id: IDS.staffA } : {}) },
        })
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/rest/v1/profiles') {
      const idFilter = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      const found = Object.values(users).find((u) => u.id === idFilter);
      res.end(JSON.stringify(found?.profile ?? null));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/rest/v1/staff') {
      const authFilter = (url.searchParams.get('auth_user_id') || '').replace(/^eq\./, '');
      if (authFilter === IDS.promotoraA) {
        res.end(JSON.stringify({ id: IDS.staffA, role: 'Promotora', status: 'Activo', auth_user_id: IDS.promotoraA }));
        return;
      }
      res.end('null');
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('HITO 0 — Contraloría consulta evidencias en solo lectura (N-08)', async (t) => {
  const saved = {
    url: process.env.SUPABASE_URL,
    publishable: process.env.SUPABASE_PUBLISHABLE_KEY,
    anon: process.env.SUPABASE_ANON_KEY,
    viteAnon: process.env.VITE_SUPABASE_ANON_KEY,
    vitePublishable: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const mock = await startMockSupabase();
  process.env.SUPABASE_URL = mock.baseUrl;
  process.env.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE_FICTICIA;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.VITE_SUPABASE_ANON_KEY;
  delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;

  const auth = await import('../src/server/supabaseAdminAuth');
  const handlerMod = await import('../src/server/attendanceEvidencesHandler');

  let signedPathsRequested: string[] = [];
  const gateway = {
    async findEvidencesWithOwnerByIds(ids: string[]) {
      const all = [
        {
          evidencia: { id: IDS.evidenciaA, storage_path: 'asistencia/2026-11-18/A/JORNADA_INGRESO.png' },
          promotoraId: IDS.staffA,
        },
        {
          evidencia: { id: IDS.evidenciaB, storage_path: 'asistencia/2026-11-18/B/JORNADA_INGRESO.png' },
          promotoraId: IDS.staffB,
        },
      ];
      return all.filter((r) => ids.includes(r.evidencia.id)) as any;
    },
    async createSignedUrls(_bucket: string, paths: string[]) {
      signedPathsRequested = paths;
      return Object.fromEntries(paths.map((p) => [p, `https://storage.test/firmada/${encodeURIComponent(p)}`]));
    },
  };

  const handlers = handlerMod.createAttendanceEvidencesHandlers({
    resolveGateway: () => gateway as any,
    signedUrlTtlSeconds: 300,
  });

  const app = express();
  app.post(
    '/api/asistencia/evidencias',
    auth.requireAttendanceActorAuth,
    express.raw({ type: '*/*', limit: '6mb' }),
    handlers.handleUploadEvidence
  );
  app.post(
    '/api/asistencia/evidencias/signed-urls',
    auth.requireAttendanceActorAuth,
    express.json(),
    handlers.handleBatchSignedUrls
  );

  const api = http.createServer(app);
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const postSigned = (bearer: string | null, ids: string[]) =>
    fetch(`${apiBase}/api/asistencia/evidencias/signed-urls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ evidenciaIds: ids }),
    });

  const postUpload = (bearer: string) =>
    fetch(`${apiBase}/api/asistencia/evidencias`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${bearer}` },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

  try {
    await t.test('isTorreViewerRole reconoce a contraloría y rechaza vendedor/promotora/vacío', () => {
      assert.equal(auth.isTorreViewerRole('contraloria'), true);
      assert.equal(auth.isTorreViewerRole('Analista_Contraloria'), true);
      assert.equal(auth.isTorreViewerRole('coordinacion'), true);
      assert.equal(auth.isTorreViewerRole('super_admin'), true);
      assert.equal(auth.isTorreViewerRole('vendedor'), false);
      assert.equal(auth.isTorreViewerRole('promotora'), false);
      assert.equal(auth.isTorreViewerRole(''), false);
    });

    await t.test('El servidor lee la Publishable Key (sb_publishable_*) para verificar sesiones', () => {
      assert.equal(auth.getSupabaseAnonKey(), PUBLISHABLE_FICTICIA);
    });

    await t.test('Contraloría: URLs firmadas de CUALQUIER promotora (200), sin 403', async () => {
      const res = await postSigned(TOKENS.contraloria, [IDS.evidenciaA, IDS.evidenciaB]);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; signedUrls: Record<string, { url: string }> };
      assert.equal(body.ok, true);
      assert.deepEqual(Object.keys(body.signedUrls).sort(), [IDS.evidenciaA, IDS.evidenciaB].sort());
      assert.equal(signedPathsRequested.length, 2);
    });

    await t.test('Contraloría: NO puede cargar ni reemplazar evidencias (403 READ_ONLY_ROLE)', async () => {
      const res = await postUpload(TOKENS.contraloria);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'READ_ONLY_ROLE');
    });

    await t.test('Contraloría suspendida: 403 ACCOUNT_SUSPENDED', async () => {
      const res = await postSigned(TOKENS.contraloriaSuspendida, [IDS.evidenciaA]);
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { code: string }).code, 'ACCOUNT_SUSPENDED');
    });

    await t.test('Coordinación conserva su comportamiento: ve evidencias de todas las promotoras', async () => {
      const res = await postSigned(TOKENS.coordinacion, [IDS.evidenciaA, IDS.evidenciaB]);
      assert.equal(res.status, 200);
    });

    await t.test('Vendedor sigue bloqueado en ambos endpoints (403 FORBIDDEN_ROLE)', async () => {
      const signed = await postSigned(TOKENS.vendedor, [IDS.evidenciaA]);
      assert.equal(signed.status, 403);
      assert.equal(((await signed.json()) as { code: string }).code, 'FORBIDDEN_ROLE');
      const upload = await postUpload(TOKENS.vendedor);
      assert.equal(upload.status, 403);
      assert.equal(((await upload.json()) as { code: string }).code, 'FORBIDDEN_ROLE');
    });

    await t.test('Promotora: solo ve las suyas (anti-IDOR intacto)', async () => {
      const own = await postSigned(TOKENS.promotoraA, [IDS.evidenciaA]);
      assert.equal(own.status, 200);
      const foreign = await postSigned(TOKENS.promotoraA, [IDS.evidenciaA, IDS.evidenciaB]);
      assert.equal(foreign.status, 403);
      assert.equal(((await foreign.json()) as { code: string }).code, 'FORBIDDEN_OWNERSHIP');
    });

    await t.test('Sin token o con token inválido: 401', async () => {
      assert.equal((await postSigned(null, [IDS.evidenciaA])).status, 401);
      assert.equal(
        (await postSigned('token-invalido-pero-suficientemente-largo-123', [IDS.evidenciaA])).status,
        401
      );
    });
  } finally {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('SUPABASE_URL', saved.url);
    restore('SUPABASE_PUBLISHABLE_KEY', saved.publishable);
    restore('SUPABASE_ANON_KEY', saved.anon);
    restore('VITE_SUPABASE_ANON_KEY', saved.viteAnon);
    restore('VITE_SUPABASE_PUBLISHABLE_KEY', saved.vitePublishable);
    restore('SUPABASE_SERVICE_ROLE_KEY', saved.service);
  }
});
