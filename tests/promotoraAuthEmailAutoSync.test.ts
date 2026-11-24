import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createPromotorasHandlers,
  type PromotoraServerRecord,
  type PromotorasGateway,
} from '../src/server/promotorasHandler';
import {
  syncPromotoraIdentityToSupabaseAuth,
  type AuthUserSnapshot,
  type ProfileSnapshot,
  type PromotoraAuthSyncGateway,
} from '../src/server/promotoraAuthSync';
import { createMemoryRateLimitStore, createRateLimiter } from '../src/server/supabaseAdminAuth';
import { registerPromotorasRoutes } from '../server';
import {
  parseSyncEmailsCliArgs,
  runPromotorasEmailDriftSync,
} from '../scripts/sync-promotoras-auth-emails';

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function createInMemoryAuthSyncHarness() {
  const authUsers = new Map<string, AuthUserSnapshot>();
  const profiles = new Map<string, ProfileSnapshot>();
  const authUpdateCalls: Array<{ userId: string; payload: Record<string, unknown> }> = [];
  const profileUpsertCalls: Array<Record<string, unknown>> = [];
  const linkCalls: Array<{ promotoraId: string; authUserId: string }> = [];

  const gateway: PromotoraAuthSyncGateway = {
    async getAuthUserById(userId) {
      return authUsers.get(userId) ?? null;
    },
    async findAuthUserByEmail(email) {
      const target = email.trim().toLowerCase();
      for (const u of authUsers.values()) {
        if ((u.email ?? '').trim().toLowerCase() === target) return u;
      }
      return null;
    },
    async updateAuthUserById(userId, payload) {
      authUpdateCalls.push({ userId, payload: { ...(payload as Record<string, unknown>) } });
      const prev = authUsers.get(userId);
      assert.ok(prev, `Usuario auth no existe: ${userId}`);
      const next: AuthUserSnapshot = {
        ...prev,
        email: payload.email ?? prev.email,
        email_confirmed_at: payload.email_confirm ? '2026-11-24T17:30:00Z' : prev.email_confirmed_at,
        app_metadata: payload.app_metadata ?? prev.app_metadata,
        user_metadata: payload.user_metadata ?? prev.user_metadata,
      };
      authUsers.set(userId, next);
      return next;
    },
    async getProfileById(userId) {
      return profiles.get(userId) ?? null;
    },
    async upsertProfile(payload) {
      profileUpsertCalls.push({ ...payload });
      const id = String(payload.id);
      const prev = profiles.get(id);
      profiles.set(id, {
        id,
        email: (payload.email as string | null) ?? prev?.email ?? null,
        full_name: (payload.full_name as string | null) ?? prev?.full_name ?? null,
        role: (payload.role as string | null) ?? prev?.role ?? null,
        sucursal: (payload.sucursal as string | null) ?? prev?.sucursal ?? null,
        region: (payload.region as string | null) ?? prev?.region ?? null,
        regiones_asignadas: (payload.regiones_asignadas as string[] | null) ?? prev?.regiones_asignadas ?? null,
        region_id: (payload.region_id as string | null) ?? prev?.region_id ?? null,
        is_active: payload.is_active !== undefined ? Boolean(payload.is_active) : prev?.is_active ?? true,
      });
    },
    async linkPromotoraAuthUserId(promotoraId, authUserId) {
      linkCalls.push({ promotoraId, authUserId });
    },
  };

  return { authUsers, profiles, authUpdateCalls, profileUpsertCalls, linkCalls, gateway };
}

test('Auto-sync correos promotoras: PATCH /api/promotoras/:id propaga a Auth + profiles sin alterar contraseña y bloquea colisiones', async () => {
  const OCC_REG_ID = '11111111-1111-4111-8111-000000000001';
  const CEN_REG_ID = '11111111-1111-4111-8111-000000000002';
  const UID_CAMILA = 'd1ff41ac-7e2d-493f-b74b-5f11e477e8f6';
  const UID_ADMIN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const UID_CENTRO = '22222222-2222-4222-8222-000000000025';

  const authHarness = createInMemoryAuthSyncHarness();
  authHarness.authUsers.set(UID_CAMILA, {
    id: UID_CAMILA,
    email: 'camilamorales@gmail.com',
    email_confirmed_at: '2026-11-24T16:43:17Z',
    app_metadata: {
      role: 'promotora',
      app_role: 'promotora',
      promotora_id: '5',
      display_name: 'CAMILA MORALES',
      region: 'OCCIDENTE',
      sucursal: 'OCCIDENTE',
    },
    user_metadata: {
      nombre_completo: 'CAMILA MORALES',
      promotora_id: '5',
      region: 'Occidente',
    },
  });
  authHarness.profiles.set(UID_CAMILA, {
    id: UID_CAMILA,
    email: 'camilamorales@gmail.com',
    full_name: 'CAMILA MORALES',
    role: 'promotora',
    sucursal: 'ZULIA',
    region: 'Occidente',
    regiones_asignadas: ['OCCIDENTE'],
    region_id: OCC_REG_ID,
    is_active: true,
  });
  authHarness.authUsers.set(UID_ADMIN, {
    id: UID_ADMIN,
    email: 'admin@codizulca.com',
    email_confirmed_at: '2026-11-01T00:00:00Z',
    app_metadata: { role: 'super_admin', app_role: 'super_admin' },
  });
  authHarness.authUsers.set(UID_CENTRO, {
    id: UID_CENTRO,
    email: 'paola.old@gmail.com',
    email_confirmed_at: '2026-11-24T16:43:17Z',
    app_metadata: { role: 'promotora', promotora_id: '25', region: 'CENTRO', sucursal: 'CENTRO' },
  });

  const rows: PromotoraServerRecord[] = [
    {
      id: '5',
      nombre_completo: 'CAMILA MORALES',
      email: 'camilamorales@gmail.com',
      telefono: '04121680424',
      ciudad: 'MARA',
      estado: null,
      direccion: 'MARA',
      region: 'Occidente',
      auth_user_id: UID_CAMILA,
      categoria: 'Fijas',
      region_id: OCC_REG_ID,
      sucursal: 'OCCIDENTE',
      supervisor_id: null,
      activo: true,
    },
    {
      id: '25',
      nombre_completo: 'Paola Maldonado',
      email: 'paola.new@gmail.com',
      telefono: '04145816686',
      ciudad: 'Valencia',
      estado: null,
      direccion: 'Valencia',
      region: 'Centro',
      auth_user_id: UID_CENTRO,
      categoria: 'Fijas',
      region_id: CEN_REG_ID,
      sucursal: 'CENTRO',
      supervisor_id: null,
      activo: true,
    },
    {
      id: '45',
      nombre_completo: 'Raynellys Reyes',
      email: 'raynellysreyes31@gmail.com',
      telefono: null,
      ciudad: 'Valencia',
      estado: null,
      direccion: 'Valencia',
      region: 'Centro',
      auth_user_id: null,
      categoria: 'Eventuales',
      region_id: CEN_REG_ID,
      sucursal: 'CENTRO',
      supervisor_id: null,
      activo: true,
    },
  ];

  let dbUpdateCalls = 0;
  const dbGateway: PromotorasGateway = {
    async resolveRegionIdByCode(code) {
      return code === 'OCCIDENTE' ? OCC_REG_ID : code === 'CENTRO' ? CEN_REG_ID : null;
    },
    async listPromotoras() {
      return [...rows];
    },
    async getPromotoraById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async createPromotora(payload) {
      const created: PromotoraServerRecord = {
        id: String(rows.length + 100),
        nombre_completo: String(payload.nombre_completo),
        email: (payload.email as string | null) ?? null,
        telefono: null,
        ciudad: null,
        estado: null,
        direccion: null,
        categoria: 'Fijas',
        region_id: OCC_REG_ID,
        sucursal: 'OCCIDENTE',
        supervisor_id: null,
        activo: true,
      };
      rows.push(created);
      return created;
    },
    async updatePromotora(id, payload) {
      dbUpdateCalls += 1;
      const idx = rows.findIndex((r) => r.id === id);
      assert.ok(idx >= 0);
      const nextEmail =
        payload.email !== undefined
          ? (payload.email as string | null)
          : payload.correo !== undefined
            ? (payload.correo as string | null)
            : rows[idx]!.email;
      rows[idx] = {
        ...rows[idx]!,
        ...(payload.nombre_completo !== undefined ? { nombre_completo: String(payload.nombre_completo) } : {}),
        ...(payload.activo !== undefined ? { activo: Boolean(payload.activo) } : {}),
        email: nextEmail,
      };
      return rows[idx]!;
    },
  };

  const handlers = createPromotorasHandlers({
    gatewayFactory: () => dbGateway,
    authSyncGateway: authHarness.gateway,
  });

  const app = express();
  app.use(express.json());
  registerPromotorasRoutes(app, {
    rateLimiter: createRateLimiter({
      name: 'test-promotoras-sync',
      windowMs: 60_000,
      maxRequests: 100,
      store: createMemoryRateLimitStore(),
    }),
    authMiddleware: (req, _res, next) => {
      const roleHeader = String(req.headers['x-test-role'] || 'coordinacion');
      const sucursalHeader = String(req.headers['x-test-sucursal'] || 'ZULIA');
      req.authUser = {
        id: '99999999-9999-4999-8999-999999999999',
        email: 'coord.occ@codizulca.com',
        appRole: roleHeader,
        sucursal: sucursalHeader as 'ZULIA' | 'GLOBAL',
        isSuperAdmin: roleHeader === 'super_admin',
        isCoordinatorOrAdmin: true,
        isReadOnlyViewer: false,
        accessToken: 'mock-token',
      };
      next();
    },
    listHandler: handlers.handleListPromotoras,
    createHandler: handlers.handleCreatePromotora,
    updateHandler: handlers.handleUpdatePromotora,
    syncAuthHandler: handlers.handleSyncPromotoraAuth,
  });

  const srv = await listen(app);
  try {
    // 1) PATCH con nuevo correo + nombre (usando alias `correo`) -> sincroniza Auth + profiles automáticamente
    const patchRes = await fetch(`${srv.base}/api/promotoras/5`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'coordinacion', 'x-test-sucursal': 'ZULIA' },
      body: JSON.stringify({
        nombre_completo: 'Camila Vilchez',
        correo: 'cv25072006@gmail.com',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchJson = (await patchRes.json()) as {
      ok: boolean;
      item: PromotoraServerRecord;
      authSync: { synced: boolean; status: string; emailChanged: boolean; passwordPreserved: boolean; email: string };
    };
    assert.equal(patchJson.ok, true);
    assert.equal(patchJson.item.email, 'cv25072006@gmail.com');
    assert.equal(patchJson.authSync.synced, true);
    assert.equal(patchJson.authSync.status, 'synced');
    assert.equal(patchJson.authSync.emailChanged, true);
    assert.equal(patchJson.authSync.passwordPreserved, true);

    // Verificar que nunca se pasó `password` a Auth Admin API
    assert.equal(authHarness.authUpdateCalls.length, 1);
    assert.equal('password' in authHarness.authUpdateCalls[0]!.payload, false, 'Nunca debe sobrescribir la contraseña');
    assert.equal(authHarness.authUpdateCalls[0]!.payload.email_confirm, true);

    const updatedAuth = authHarness.authUsers.get(UID_CAMILA)!;
    assert.equal(updatedAuth.email, 'cv25072006@gmail.com');
    assert.equal(updatedAuth.app_metadata?.display_name, 'Camila Vilchez');
    assert.equal(updatedAuth.user_metadata?.nombre_completo, 'Camila Vilchez');

    const updatedProfile = authHarness.profiles.get(UID_CAMILA)!;
    assert.equal(updatedProfile.email, 'cv25072006@gmail.com');
    assert.equal(updatedProfile.full_name, 'Camila Vilchez');
    assert.equal(updatedProfile.sucursal, 'ZULIA', 'Debe preservar sucursal compatible en public.profiles');
    assert.equal(updatedProfile.is_active, true);

    // 2) Colisión de correo contra una cuenta super_admin -> 409 ANTES de tocar public.promotoras
    const dbCallsBeforeCollision = dbUpdateCalls;
    const collisionRes = await fetch(`${srv.base}/api/promotoras/5`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'coordinacion', 'x-test-sucursal': 'ZULIA' },
      body: JSON.stringify({ email: 'admin@codizulca.com' }),
    });
    assert.equal(collisionRes.status, 409);
    const collisionJson = (await collisionRes.json()) as { code: string };
    assert.equal(collisionJson.code, 'EMAIL_ALREADY_IN_USE');
    assert.equal(dbUpdateCalls, dbCallsBeforeCollision, 'No debe escribir en public.promotoras si hay colisión en Auth');

    // 3) Desactivar promotora vía PATCH -> propaga `is_active: false` a public.profiles
    const deactivateRes = await fetch(`${srv.base}/api/promotoras/5`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-role': 'coordinacion', 'x-test-sucursal': 'ZULIA' },
      body: JSON.stringify({ activo: false }),
    });
    assert.equal(deactivateRes.status, 200);
    assert.equal(authHarness.profiles.get(UID_CAMILA)?.is_active, false);

    // 4) Aislamiento regional en POST /api/promotoras/:id/sync-auth -> Coordinadora Occidente NO puede sincronizar Centro (403)
    const crossSyncRes = await fetch(`${srv.base}/api/promotoras/25/sync-auth`, {
      method: 'POST',
      headers: { 'x-test-role': 'coordinacion', 'x-test-sucursal': 'ZULIA' },
    });
    assert.equal(crossSyncRes.status, 403);
    assert.equal(authHarness.authUsers.get(UID_CENTRO)?.email, 'paola.old@gmail.com');

    // 5) Super admin ejecuta POST /api/promotoras/25/sync-auth -> repara drift y segunda llamada es idempotente (`unchanged`)
    const syncRes1 = await fetch(`${srv.base}/api/promotoras/25/sync-auth`, {
      method: 'POST',
      headers: { 'x-test-role': 'super_admin', 'x-test-sucursal': 'GLOBAL' },
    });
    assert.equal(syncRes1.status, 200);
    const syncJson1 = (await syncRes1.json()) as { authSync: { status: string; email: string } };
    assert.equal(syncJson1.authSync.status, 'synced');
    assert.equal(syncJson1.authSync.email, 'paola.new@gmail.com');

    const authUpdatesAfterFirstSync = authHarness.authUpdateCalls.length;
    const syncRes2 = await fetch(`${srv.base}/api/promotoras/25/sync-auth`, {
      method: 'POST',
      headers: { 'x-test-role': 'super_admin', 'x-test-sucursal': 'GLOBAL' },
    });
    assert.equal(syncRes2.status, 200);
    const syncJson2 = (await syncRes2.json()) as { authSync: { status: string } };
    assert.equal(syncJson2.authSync.status, 'unchanged');
    assert.equal(authHarness.authUpdateCalls.length, authUpdatesAfterFirstSync, 'Segunda sincronización debe ser 0 escrituras');

    // 6) Promotora sin cuenta Auth (ID 45) -> responde cleanly `unlinked_no_auth_account` sin fallar
    const unlinkedRes = await fetch(`${srv.base}/api/promotoras/45/sync-auth`, {
      method: 'POST',
      headers: { 'x-test-role': 'super_admin', 'x-test-sucursal': 'GLOBAL' },
    });
    assert.equal(unlinkedRes.status, 200);
    const unlinkedJson = (await unlinkedRes.json()) as { authSync: { synced: boolean; status: string } };
    assert.equal(unlinkedJson.authSync.synced, false);
    assert.equal(unlinkedJson.authSync.status, 'unlinked_no_auth_account');
  } finally {
    await srv.close();
  }
});

test('Seguridad Auth Sync: bloquea intento de modificar cuentas con rol distinto a promotora', async () => {
  const authHarness = createInMemoryAuthSyncHarness();
  const UID_COORD = '33333333-3333-4333-8333-333333333333';
  authHarness.authUsers.set(UID_COORD, {
    id: UID_COORD,
    email: 'coord@codizulca.com',
    email_confirmed_at: '2026-11-01T00:00:00Z',
    app_metadata: { role: 'coordinacion' },
  });

  const res = await syncPromotoraIdentityToSupabaseAuth({
    gateway: authHarness.gateway,
    promotora: {
      id: '99',
      nombre_completo: 'Test Hijack',
      email: 'nuevo@gmail.com',
      region: 'OCCIDENTE',
      activo: true,
      auth_user_id: UID_COORD,
    },
  });

  assert.equal(res.synced, false);
  assert.equal(res.status, 'conflict_non_promotora_account');
  assert.equal(authHarness.authUpdateCalls.length, 0);
  assert.equal(authHarness.authUsers.get(UID_COORD)?.email, 'coord@codizulca.com');
});

test('Script CLI sync-promotoras-auth-emails: dry-run no escribe y apply corrige únicamente desalineadas por región', async () => {
  assert.deepEqual(parseSyncEmailsCliArgs([]), { mode: 'dry-run', region: 'ALL', delayMs: 60 });
  assert.deepEqual(parseSyncEmailsCliArgs(['--apply', '--region=occidente', '--delay-ms=0']), {
    mode: 'apply',
    region: 'OCCIDENTE',
    delayMs: 0,
  });

  const UID_OK = '44444444-4444-4444-8444-000000000001';
  const UID_DRIFT = '44444444-4444-4444-8444-000000000002';
  const authHarness = createInMemoryAuthSyncHarness();

  authHarness.authUsers.set(UID_OK, {
    id: UID_OK,
    email: 'ok@gmail.com',
    email_confirmed_at: '2026-11-24T16:00:00Z',
    app_metadata: { role: 'promotora', promotora_id: '1', display_name: 'Ana OK', region: 'OCCIDENTE', sucursal: 'OCCIDENTE' },
    user_metadata: { nombre_completo: 'Ana OK' },
  });
  authHarness.profiles.set(UID_OK, {
    id: UID_OK,
    email: 'ok@gmail.com',
    full_name: 'Ana OK',
    role: 'promotora',
    sucursal: 'ZULIA',
    region: 'Occidente',
    is_active: true,
  });

  authHarness.authUsers.set(UID_DRIFT, {
    id: UID_DRIFT,
    email: 'old@gmail.com',
    email_confirmed_at: '2026-11-24T16:00:00Z',
    app_metadata: { role: 'promotora', promotora_id: '2', display_name: 'Tania Old', region: 'OCCIDENTE', sucursal: 'OCCIDENTE' },
    user_metadata: { nombre_completo: 'Tania Old' },
  });
  authHarness.profiles.set(UID_DRIFT, {
    id: UID_DRIFT,
    email: 'old@gmail.com',
    full_name: 'Tania Old',
    role: 'promotora',
    sucursal: 'ZULIA',
    region: 'Occidente',
    is_active: true,
  });

  const fakeClient = {
    from(table: string) {
      assert.equal(table, 'promotoras');
      return {
        select() {
          return {
            order() {
              return Promise.resolve({
                data: [
                  { id: 1, nombre_completo: 'Ana OK', correo: 'ok@gmail.com', region: 'OCCIDENTE', sucursal: 'OCCIDENTE', activo: true, auth_user_id: UID_OK },
                  { id: 2, nombre_completo: 'Tania Nueva', correo: 'new@gmail.com', region: 'OCCIDENTE', sucursal: 'OCCIDENTE', activo: true, auth_user_id: UID_DRIFT },
                  { id: 45, nombre_completo: 'Raynellys Reyes', correo: 'ray@gmail.com', region: 'CENTRO', sucursal: 'CENTRO', activo: true, auth_user_id: null },
                ],
                error: null,
              });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  // 1) Dry-run en OCCIDENTE -> detecta 1 desalineada y hace 0 escrituras
  const dry = await runPromotorasEmailDriftSync({
    client: fakeClient,
    gateway: authHarness.gateway,
    mode: 'dry-run',
    region: 'OCCIDENTE',
    delayMs: 0,
  });
  assert.equal(dry.totalEvaluadas, 2);
  assert.equal(dry.sincronizadasPreviamente, 1);
  assert.equal(dry.desincronizadasDetectadas, 1);
  assert.equal(dry.actualizadas, 0);
  assert.equal(authHarness.authUpdateCalls.length, 0);

  // 2) Apply en OCCIDENTE -> corrige la 1 desalineada preservando contraseña
  const applied = await runPromotorasEmailDriftSync({
    client: fakeClient,
    gateway: authHarness.gateway,
    mode: 'apply',
    region: 'OCCIDENTE',
    delayMs: 0,
  });
  assert.equal(applied.actualizadas, 1);
  assert.equal(applied.errores, 0);
  assert.equal(authHarness.authUsers.get(UID_DRIFT)?.email, 'new@gmail.com');
  assert.equal(authHarness.profiles.get(UID_DRIFT)?.email, 'new@gmail.com');
  assert.equal(authHarness.profiles.get(UID_DRIFT)?.full_name, 'Tania Nueva');
});

test('Optimización dual correo/email: detecta y alinea columna `email` nula o desalineada en public.promotoras y valida migración SQL 20261210000100', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { normalizePromotoraMasterRow } = await import('../src/services/masterCatalogSyncService');

  // 1) Normalizador frontend: una columna `email` vacía jamás oculta un `correo` válido
  const normalized = normalizePromotoraMasterRow({
    id: 24,
    nombre_completo: 'Zioreli Grangger',
    correo: '  Ziorelis.Grangger@Codizulca.com ',
    email: '',
    region: 'OCCIDENTE',
    categoria: 'Merchandising',
    activo: true,
  });
  assert.equal(normalized.email, 'ziorelis.grangger@codizulca.com');

  // 2) Script de sincronización: detecta y alinea `email: null` contra `correo` en modo apply
  const UID_ZIORELI = '03780a07-4aff-4c6a-9be2-8a648a5a35b8';
  const authHarness = createInMemoryAuthSyncHarness();
  authHarness.authUsers.set(UID_ZIORELI, {
    id: UID_ZIORELI,
    email: 'ziorelis.grangger@codizulca.com',
    email_confirmed_at: '2026-11-24T20:21:40Z',
    app_metadata: {
      role: 'promotora',
      promotora_id: '24',
      display_name: 'Zioreli Grangger',
      region: 'OCCIDENTE',
      sucursal: 'OCCIDENTE',
    },
    user_metadata: { nombre_completo: 'Zioreli Grangger' },
  });
  authHarness.profiles.set(UID_ZIORELI, {
    id: UID_ZIORELI,
    email: 'ziorelis.grangger@codizulca.com',
    full_name: 'Zioreli Grangger',
    role: 'promotora',
    sucursal: 'ZULIA',
    region: 'Occidente',
    is_active: true,
  });

  const dbUpdates: Array<{ id: string | number; payload: Record<string, unknown> }> = [];
  const dualColClient = {
    from(table: string) {
      assert.equal(table, 'promotoras');
      return {
        select() {
          return {
            order() {
              return Promise.resolve({
                data: [
                  {
                    id: 24,
                    nombre_completo: 'Zioreli Grangger',
                    correo: 'ziorelis.grangger@codizulca.com',
                    email: null,
                    region: 'OCCIDENTE',
                    sucursal: 'OCCIDENTE',
                    activo: true,
                    auth_user_id: UID_ZIORELI,
                  },
                ],
                error: null,
              });
            },
          };
        },
        update(payload: Record<string, unknown>) {
          return {
            async eq(_col: string, val: string | number) {
              dbUpdates.push({ id: val, payload });
              return { error: null };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const dry = await runPromotorasEmailDriftSync({
    client: dualColClient,
    gateway: authHarness.gateway,
    mode: 'dry-run',
    region: 'OCCIDENTE',
    delayMs: 0,
  });
  assert.equal(dry.desincronizadasDetectadas, 1);
  assert.ok(dry.driftItems[0]!.reasons.some((r) => r.startsWith('promotora_email_column_drift')));
  assert.equal(dbUpdates.length, 0);

  const applied = await runPromotorasEmailDriftSync({
    client: dualColClient,
    gateway: authHarness.gateway,
    mode: 'apply',
    region: 'OCCIDENTE',
    delayMs: 0,
  });
  assert.equal(applied.promotorasColumnasAlineadas, 1);
  assert.equal(applied.errores, 0);
  assert.equal(dbUpdates.length, 1);
  assert.equal(dbUpdates[0]!.id, 24);
  assert.equal(dbUpdates[0]!.payload.correo, 'ziorelis.grangger@codizulca.com');
  assert.equal(dbUpdates[0]!.payload.email, 'ziorelis.grangger@codizulca.com');

  // 3) Validación estática de la migración SQL 20261210000100
  const migSql = fs.readFileSync(
    path.resolve(
      process.cwd(),
      'supabase',
      'migrations',
      '20261210000100_sync_promotoras_correo_email_normalizacion.sql'
    ),
    'utf8'
  );
  assert.match(migSql, /fn_trg_sync_promotoras_correo_email/i);
  assert.match(migSql, /SECURITY DEFINER/i);
  assert.match(migSql, /SET search_path = public/i);
  assert.match(migSql, /DROP TRIGGER IF EXISTS trg_promotoras_sync_correo_email/i);
  assert.match(migSql, /REVOKE ALL ON TABLE public\.promotoras FROM PUBLIC, anon/i);
  assert.match(migSql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migSql, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migSql, /NOTIFY pgrst, 'reload schema'/i);
  const execSql = migSql.replace(/--.*$/gm, '');
  assert.doesNotMatch(execSql, /\bDISABLE ROW LEVEL SECURITY\b/i);
  assert.doesNotMatch(execSql, /\b(DROP TABLE|DROP COLUMN|TRUNCATE)\b/i);
});
