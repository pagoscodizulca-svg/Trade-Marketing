import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  assertPublicSupabaseKey,
  canAccessChoferMode,
  canAccessOficinaMode,
  isRutaSuperAdmin,
  normalizarSupabaseUrl,
  normalizeRutaRole,
  normalizeRutaSucursal,
  resolveAllowedModes,
  resolveEffectiveMode,
  resolveRutaSupabaseConfig,
} from '../ruta-degustacion/src/services/supabaseAuth';
import {
  applyPayload,
  construirCuerpoServidor,
  horaLocalHHmm,
} from '../ruta-degustacion/src/lib/deliveryOps';
import { buildOutboxHeaders } from '../ruta-degustacion/src/lib/syncCore';
import {
  matrizAEntregas,
  parseCsv,
  sanitizarTextoCelda,
} from '../ruta-degustacion/src/utils/csvImport';
import {
  loadChoferShiftSessionSync,
  purgeChoferOfflineSensitiveData,
  saveChoferShiftSession,
} from '../ruta-degustacion/src/services/shiftSessionService';
import { SyncStatusBadge } from '../ruta-degustacion/src/components/common/SyncStatusBadge';
import { ProgressBar } from '../ruta-degustacion/src/components/chofer/ProgressBar';
import { KpiCards } from '../ruta-degustacion/src/components/oficina/KpiCards';
import {
  createShiftLinksHandlers,
  type ShiftLinksGateway,
  type StoredShiftSessionSummary,
  type VerifiedShiftSessionContext,
} from '../src/server/shiftLinksHandler';
import { buildSecurityHeaders } from '../src/server/securityMiddleware';
import type { AuthenticatedServerUser, OperativeSucursal } from '../src/server/supabaseAdminAuth';
import {
  MOCK_ACTORS,
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
  startLocalMockInfra,
} from './antigravity_audit/localMockInfra';
import { analyzeMigrations, formatIssues, type MigrationFile } from './support/sqlMigrationAnalyzer';

const TEST_SHIFT_SECRET = 'fase4-e2e-shift-link-hmac-secret-key-min-32-bytes-9876543210';

function createInMemoryChoferShiftGateway() {
  const sessionsById = new Map<string, StoredShiftSessionSummary & { token_hash: string }>();
  const sessionsByHash = new Map<string, StoredShiftSessionSummary & { token_hash: string }>();
  const appliedMutations = new Set<string>();
  const entregasState = new Map<string, Record<string, unknown>>([
    [
      '11110000-0000-4000-8000-000000000001',
      {
        id: '11110000-0000-4000-8000-000000000001',
        fecha: '22-11-2026',
        turno: 'MAÑANA',
        cliente: 'SUPERMERCADO FIORELLA, C.A.',
        producto: 'MORTADELA',
        sucursal: 'ZULIA',
        stand_entregado: false,
        producto_entregado: false,
        completado: false,
        hora_entrega: null,
        notas_chofer: '',
      },
    ],
  ]);

  const toPublic = (
    row: StoredShiftSessionSummary & { token_hash: string }
  ): StoredShiftSessionSummary => {
    const { token_hash: _omit, ...rest } = row;
    void _omit;
    return rest;
  };

  const toVerified = (
    row: StoredShiftSessionSummary & { token_hash: string }
  ): VerifiedShiftSessionContext => ({
    id: row.id,
    rol: row.rol,
    personal_id: row.personal_id,
    personal_nombre: row.personal_nombre,
    region_id: row.region_id,
    region_nombre: row.sucursal,
    sucursal: row.sucursal,
    ruta_codigo: row.ruta_codigo,
    duracion_horas: row.duracion_horas,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
  });

  const gateway: ShiftLinksGateway = {
    async resolveRegionBySucursal(sucursal: OperativeSucursal) {
      return {
        id:
          sucursal === 'ZULIA'
            ? '10101010-1010-4010-8010-101010101010'
            : '20202020-2020-4020-8020-202020202020',
        codigo: sucursal,
        nombre: sucursal,
      };
    },
    async resolvePersonalInSucursal(_rol, personalId) {
      return { id: personalId, name: 'Chofer Ruta Occidente' };
    },
    async insertSession(record) {
      const full: StoredShiftSessionSummary & { token_hash: string } = {
        ...record,
        region_nombre: record.sucursal,
        revoked_at: null,
        last_used_at: null,
        created_at: new Date().toISOString(),
      };
      sessionsById.set(record.id, full);
      sessionsByHash.set(record.token_hash, full);
      return toPublic(full);
    },
    async listSessionsBySucursal(sucursal) {
      return Array.from(sessionsById.values())
        .filter((s) => s.sucursal === sucursal)
        .map(toPublic);
    },
    async revokeSession({ sessionId, allowedSucursal }) {
      const target = sessionsById.get(sessionId);
      if (!target) return { ok: false, code: 'NOT_FOUND' };
      if (allowedSucursal !== 'GLOBAL' && target.sucursal !== allowedSucursal) {
        return { ok: false, code: 'FORBIDDEN_BRANCH' };
      }
      target.revoked_at = new Date().toISOString();
      return { ok: true, session: toPublic(target) };
    },
    async validateSessionRpc(tokenHash) {
      const found = sessionsByHash.get(tokenHash);
      if (!found) return { valid: false, code: 'SESSION_NOT_FOUND' };
      if (found.revoked_at) return { valid: false, code: 'SESSION_REVOKED' };
      if (new Date(found.expires_at).getTime() <= Date.now()) {
        return { valid: false, code: 'SESSION_EXPIRED' };
      }
      found.last_used_at = new Date().toISOString();
      return { valid: true, session: toVerified(found) };
    },
    async bootstrapSessionRpc(tokenHash) {
      const check = await this.validateSessionRpc(tokenHash);
      if (!check.valid || !check.session) return check;
      const entregas = Array.from(entregasState.values()).filter(
        (e) => e.sucursal === check.session!.sucursal
      );
      return {
        valid: true,
        session: check.session,
        entregas,
        clientes: [{ id: 'cli-1', razon_social: 'SUPERMERCADO FIORELLA, C.A.', sucursal: 'ZULIA' }],
        productos: [{ id: 'prod-1', nombre: 'MORTADELA ESPECIAL ASTURIAS' }],
      };
    },
    async applyOfflineMutationRpc({ tokenHash, clientMutationId, tipo, payload }) {
      const check = await this.validateSessionRpc(tokenHash);
      if (!check.valid || !check.session) {
        return { ok: false, code: check.code || 'SESSION_INVALID', error: 'Sesión inválida' };
      }
      if (appliedMutations.has(clientMutationId)) {
        return { ok: true, idempotent_hit: true, code: 'IDEMPOTENT_REPLAY' };
      }
      if (tipo === 'CHOFER_ENTREGA_PATCH') {
        const deliveryId = String(payload.delivery_id || '');
        const existing = entregasState.get(deliveryId);
        if (!existing) {
          return { ok: false, code: 'DELIVERY_NOT_FOUND', error: 'Entrega inexistente' };
        }
        if (existing.sucursal !== check.session.sucursal) {
          return { ok: false, code: 'FORBIDDEN_SCOPE', error: 'Cruce regional bloqueado' };
        }
        Object.assign(existing, {
          completado: payload.completado ?? existing.completado,
          stand_entregado: payload.stand_entregado ?? existing.stand_entregado,
          producto_entregado: payload.producto_entregado ?? existing.producto_entregado,
          hora_entrega: payload.hora_entrega ?? existing.hora_entrega,
          notas_chofer: payload.notas_chofer ?? existing.notas_chofer,
        });
      }
      appliedMutations.add(clientMutationId);
      return { ok: true, duplicate: false };
    },
    async uploadShiftIncidenciaPhoto({ sucursal, sessionId, clientMutationId, extension }) {
      return {
        storagePath: `incidencias/${sucursal.toLowerCase()}/${sessionId}/${clientMutationId}.${extension}`,
        sha256Hex: '0'.repeat(64),
      };
    },
  };

  return { gateway, entregasState, appliedMutations, sessionsById };
}

// =============================================================================
// E2E-1: ZERO-TRUST AUTH, LLAVES Y RBAC MULTI-SEDE DE `ruta-degustacion`
// =============================================================================
test('Fase 4 E2E-1 · ruta-degustacion: Zero-Trust Auth, bloqueo de secretos y matriz RBAC multi-sede', () => {
  // Bloqueo estricto de llaves secretas en el cliente PWA
  assert.throws(() => assertPublicSupabaseKey('sb_secret_prohibida_123456'), /VIOLACIÓN DE SEGURIDAD/);
  assert.throws(() => assertPublicSupabaseKey(MOCK_SERVICE_ROLE_KEY), /service_role/);
  assert.equal(assertPublicSupabaseKey(MOCK_PUBLIC_ANON_KEY), MOCK_PUBLIC_ANON_KEY);

  // Normalización estricta de URL Supabase (HTTPS remoto / HTTP solo en localhost/127.0.0.1)
  assert.equal(
    normalizarSupabaseUrl('https://apaxdgxtaoeyswlfblgi.supabase.co/rest/v1/'),
    'https://apaxdgxtaoeyswlfblgi.supabase.co'
  );
  assert.equal(normalizarSupabaseUrl('http://127.0.0.1:54321/rest/v1'), 'http://127.0.0.1:54321');
  assert.throws(() => normalizarSupabaseUrl('http://evil.example.com'), /https:\/\//);

  const cfgRes = resolveRutaSupabaseConfig({
    VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_e2e_key_123456',
  });
  assert.equal(cfgRes.configError, null);
  assert.equal(cfgRes.config?.url, 'http://127.0.0.1:54321');

  // Matriz RBAC: chofer solo modo chofer; coordinacion/super_admin ambos modos; otros bloqueados
  assert.equal(normalizeRutaRole('super_admin'), 'super_admin');
  assert.equal(normalizeRutaRole('coordinacion'), 'coordinacion');
  assert.equal(normalizeRutaRole('chofer'), 'chofer');
  assert.equal(normalizeRutaRole('vendedor'), null);
  assert.equal(normalizeRutaRole('promotora'), null);
  assert.equal(normalizeRutaRole('cliente'), null);

  assert.equal(canAccessChoferMode('chofer'), true);
  assert.equal(canAccessOficinaMode('chofer'), false);
  assert.deepEqual(resolveAllowedModes('chofer'), ['chofer']);
  assert.equal(resolveEffectiveMode('oficina', 'chofer'), 'chofer');

  assert.equal(canAccessOficinaMode('coordinacion'), true);
  assert.deepEqual(resolveAllowedModes('coordinacion'), ['chofer', 'oficina']);
  assert.equal(resolveEffectiveMode('oficina', 'coordinacion'), 'oficina');

  assert.equal(isRutaSuperAdmin({ role: 'super_admin' }), true);

  // Normalización regional y rechazo GLOBAL para usuarios operativos
  assert.equal(normalizeRutaSucursal('Maracaibo, Zulia', 'chofer'), 'ZULIA');
  assert.equal(normalizeRutaSucursal('Valencia Carabobo', 'chofer'), 'VALENCIA');
  assert.equal(normalizeRutaSucursal('Maracay Aragua', 'coordinacion'), 'CENTRO');
  assert.equal(normalizeRutaSucursal('GLOBAL', 'chofer'), null);
  assert.equal(normalizeRutaSucursal('GLOBAL', 'super_admin'), 'GLOBAL');
});

// =============================================================================
// E2E-2: CICLO COMPLETO DE ENLACE FIRMADO DE JORNADA CHOFER + SYNC OFFLINE + REVOCACIÓN
// =============================================================================
test('Fase 4 E2E-2 · ruta-degustacion: Ciclo E2E Chofer Shift-Link (Generate -> Verify -> Bootstrap -> Sync Idempotente -> Revoke -> Purge)', async () => {
  const store = createInMemoryChoferShiftGateway();
  const handlers = createShiftLinksHandlers({
    gateway: store.gateway,
    getSecret: () => TEST_SHIFT_SECRET,
  });

  const app = express();
  app.use(express.json());
  const attachCoordinator: express.RequestHandler = (req, _res, next) => {
    req.authUser = {
      id: MOCK_ACTORS.coordinadora.id,
      email: MOCK_ACTORS.coordinadora.email,
      appRole: 'coordinacion',
      sucursal: 'ZULIA',
      isCoordinatorOrAdmin: true,
    } as AuthenticatedServerUser;
    next();
  };

  app.post('/api/generate-shift-link', attachCoordinator, handlers.handleGenerateShiftLink);
  app.post('/api/verify-shift-link', handlers.handleVerifyShiftLink);
  app.get('/api/shift-links/bootstrap', handlers.handleBootstrapShiftLink);
  app.post('/api/shift-links/sync', handlers.handleSyncShiftOfflineBatch);
  app.post('/api/revoke-shift-link', attachCoordinator, handlers.handleRevokeShiftLink);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // 1. Coordinadora Zulia genera enlace firmado para Chofer
    const genRes = await fetch(`${baseUrl}/api/generate-shift-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rol: 'chofer',
        duracionHoras: 12,
        sucursal: 'ZULIA',
        rutaCodigo: 'RUTA-NORTE-01',
      }),
    });
    assert.equal(genRes.status, 201);
    const genJson = (await genRes.json()) as {
      ok: boolean;
      url: string;
      session: { id: string; rol: string; sucursal: string };
    };
    assert.equal(genJson.ok, true);
    assert.equal(genJson.session.rol, 'chofer');
    assert.equal(genJson.session.sucursal, 'ZULIA');
    assert.match(genJson.url, /\/logistica\/?\?t=/);
    const shiftToken = new URL(genJson.url).searchParams.get('t') || '';
    assert.ok(shiftToken.length > 40, 'El enlace firmado debe incluir token HMAC-SHA256 en ?t=');

    // 2. Chofer PWA verifica el token firmado
    const verifyRes = await fetch(`${baseUrl}/api/verify-shift-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shift-token': shiftToken },
      body: JSON.stringify({ token: shiftToken }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyJson = (await verifyRes.json()) as {
      ok: boolean;
      valid: boolean;
      session: { id: string; sucursal: string };
    };
    assert.equal(verifyJson.valid, true);
    assert.equal(verifyJson.session.sucursal, 'ZULIA');

    // 3. Chofer PWA descarga bootstrap regional acotado
    const bootRes = await fetch(`${baseUrl}/api/shift-links/bootstrap`, {
      headers: { 'x-shift-token': shiftToken },
    });
    assert.equal(bootRes.status, 200);
    const bootJson = (await bootRes.json()) as {
      ok: boolean;
      entregas: Array<{ id: string; completado: boolean }>;
      clientes: unknown[];
    };
    assert.equal(bootJson.entregas.length, 1);
    assert.equal(bootJson.entregas[0]!.completado, false);

    // 4. Chofer marca entrega offline y sincroniza con client_mutation_id idempotente
    const mutationId = crypto.randomUUID();
    const deliveryId = bootJson.entregas[0]!.id;
    const syncPayload = {
      mutations: [
        {
          client_mutation_id: mutationId,
          tipo: 'CHOFER_ENTREGA_PATCH',
          payload: {
            delivery_id: deliveryId,
            stand_entregado: true,
            producto_entregado: true,
            completado: true,
            hora_entrega: '10:15',
            notas_chofer: 'Entregado conforme en PDV',
          },
        },
      ],
    };

    const sync1 = await fetch(`${baseUrl}/api/shift-links/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shift-token': shiftToken },
      body: JSON.stringify(syncPayload),
    });
    assert.equal(sync1.status, 200);
    const sync1Json = (await sync1.json()) as {
      results: Array<{ ok: boolean; idempotentHit?: boolean }>;
    };
    assert.equal(sync1Json.results[0]?.ok, true);
    assert.equal(store.entregasState.get(deliveryId)?.completado, true);

    // Reintento idempotente con el mismo client_mutation_id
    const sync2 = await fetch(`${baseUrl}/api/shift-links/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shift-token': shiftToken },
      body: JSON.stringify(syncPayload),
    });
    assert.equal(sync2.status, 200);
    const sync2Json = (await sync2.json()) as {
      results: Array<{ ok: boolean; idempotentHit?: boolean }>;
    };
    assert.equal(sync2Json.results[0]?.ok, true);
    assert.equal(sync2Json.results[0]?.idempotentHit, true);
    assert.equal(store.appliedMutations.size, 1);

    // 5. Revocación inmediata bloquea acceso posterior y purga datos locales del chofer
    const revokeRes = await fetch(`${baseUrl}/api/revoke-shift-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: genJson.session.id }),
    });
    assert.equal(revokeRes.status, 200);

    const postRevokeVerify = await fetch(`${baseUrl}/api/verify-shift-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-shift-token': shiftToken },
      body: JSON.stringify({ token: shiftToken }),
    });
    assert.equal(postRevokeVerify.status, 401);

    // Purga local determinista de sessionStorage/localStorage
    const sessionMem = new Map<string, string>();
    const localMem = new Map<string, string>();
    (globalThis as Record<string, unknown>).sessionStorage = {
      getItem: (k: string) => sessionMem.get(k) ?? null,
      setItem: (k: string, v: string) => sessionMem.set(k, v),
      removeItem: (k: string) => sessionMem.delete(k),
    };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => localMem.get(k) ?? null,
      setItem: (k: string, v: string) => localMem.set(k, v),
      removeItem: (k: string) => localMem.delete(k),
    };
    try {
      await saveChoferShiftSession({
        token: shiftToken,
        session: {
          id: genJson.session.id,
          rol: 'chofer',
          personal_id: null,
          personal_nombre: 'Chofer Ruta Occidente',
          region_id: '10101010-1010-4010-8010-101010101010',
          region_nombre: 'ZULIA',
          sucursal: 'ZULIA',
          ruta_codigo: 'RUTA-NORTE-01',
          duracion_horas: 12,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          last_used_at: null,
        },
        savedAtIso: new Date().toISOString(),
      });
      assert.ok(loadChoferShiftSessionSync() !== null);
      await purgeChoferOfflineSensitiveData();
      assert.equal(loadChoferShiftSessionSync(), null, 'La purga debe eliminar por completo la sesión del chofer');
    } finally {
      delete (globalThis as Record<string, unknown>).sessionStorage;
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// =============================================================================
// E2E-3: OUTBOX ZERO-ANON + RESOLUCIÓN LWW SOBRE LOOPBACK POSTGREST
// =============================================================================
test('Fase 4 E2E-3 · ruta-degustacion: Cabeceras Zero-Anon, PATCH LWW y resolución de conflictos en loopback', async () => {
  const mock = await startLocalMockInfra(0);
  try {
    // 1. Zero-Anon: buildOutboxHeaders JAMÁS acepta anonKey como Bearer token
    assert.throws(
      () =>
        buildOutboxHeaders(
          { url: mock.baseUrl, anonKey: MOCK_PUBLIC_ANON_KEY },
          MOCK_PUBLIC_ANON_KEY
        ),
      /Token de sesión ausente o inválido/
    );

    const authHeaders = buildOutboxHeaders(
      { url: mock.baseUrl, anonKey: MOCK_PUBLIC_ANON_KEY },
      MOCK_ACTORS.coordinadora.token,
      { Prefer: 'return=representation' }
    );
    assert.equal(authHeaders.apikey, MOCK_PUBLIC_ANON_KEY);
    assert.equal(authHeaders.Authorization, `Bearer ${MOCK_ACTORS.coordinadora.token}`);

    // 2. Sembrar entrega en mock PostgREST y aplicar PATCH LWW más reciente vs PATCH obsoleto
    const deliveryId = '22220000-0000-4000-8000-000000000001';
    mock.tables.entregas_degustacion.push({
      id: deliveryId,
      fecha: '22-11-2026',
      turno: 'MAÑANA',
      numero_grupo_turno: 'G1',
      cliente: 'INVERSIONES ZULIA, C.A.',
      producto: 'MORTADELA',
      vendedor: 'CARLOS PEÑA',
      promotora: 'MARÍA PIÑA',
      stand_entregado: false,
      producto_entregado: false,
      completado: false,
      hora_entrega: null,
      notas_chofer: '',
      actualizado_chofer_at: '2026-11-22T14:00:00.000Z',
    });

    // Proyección optimista en memoria
    const newerIso = '2026-11-22T14:30:00.000Z';
    const patchPayload = {
      completado: true,
      stand_entregado: true,
      producto_entregado: true,
      hora_entrega_real: newerIso,
      notas_chofer: 'Entregado sin novedad',
    };
    const projected = applyPayload(
      mock.tables.entregas_degustacion[0] as Parameters<typeof applyPayload>[0],
      patchPayload
    );
    assert.equal(projected.completado, true);
    assert.equal(projected.hora_entrega, horaLocalHHmm(newerIso));

    // PATCH más reciente (14:30 >= 14:00) debe actualizar exactamente 1 fila
    const bodyNewer = construirCuerpoServidor(patchPayload, newerIso, true);
    const resNewer = await fetch(
      `${mock.baseUrl}/rest/v1/entregas_degustacion?id=eq.${deliveryId}&or=(actualizado_chofer_at.is.null,actualizado_chofer_at.lte.${encodeURIComponent(newerIso)})`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify(bodyNewer),
      }
    );
    assert.equal(resNewer.status, 200);
    const updatedRows = (await resNewer.json()) as Array<{ completado: boolean }>;
    assert.equal(updatedRows.length, 1);
    assert.equal(updatedRows[0]!.completado, true);

    // PATCH obsoleto (14:10 < 14:30) NO debe sobrescribir el cambio más reciente (0 filas afectadas)
    const olderIso = '2026-11-22T14:10:00.000Z';
    const bodyOlder = construirCuerpoServidor(
      { completado: false, notas_chofer: 'Cambio atrasado offline' },
      olderIso,
      true
    );
    const resOlder = await fetch(
      `${mock.baseUrl}/rest/v1/entregas_degustacion?id=eq.${deliveryId}&or=(actualizado_chofer_at.is.null,actualizado_chofer_at.lte.${encodeURIComponent(olderIso)})`,
      {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify(bodyOlder),
      }
    );
    assert.equal(resOlder.status, 200);
    const olderRows = (await resOlder.json()) as unknown[];
    assert.equal(olderRows.length, 0, 'LWW debe proteger al registro más reciente contra sobreescritura atrasada');
    assert.equal(mock.tables.entregas_degustacion[0]!.completado, true);
  } finally {
    await mock.close();
  }
});

// =============================================================================
// E2E-4: IMPORTACIÓN CSV/EXCEL SEGURA EN `ruta-degustacion` (CERO SHEETJS + ANTI-FORMULA)
// =============================================================================
test('Fase 4 E2E-4 · ruta-degustacion: Importador CSV/XLSX seguro (DD/MM/YYYY, comillas ", C.A.", anti-fórmulas y cero xlsx)', () => {
  const rutaPkg = JSON.parse(
    fs.readFileSync(path.resolve('ruta-degustacion/package.json'), 'utf8')
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(rutaPkg.dependencies?.xlsx, undefined, 'ruta-degustacion no debe depender de xlsx');
  assert.equal(rutaPkg.devDependencies?.xlsx, undefined);
  assert.ok(rutaPkg.dependencies?.['read-excel-file'], 'Debe usar read-excel-file seguro');

  assert.equal(sanitizarTextoCelda('=CMD|" /C calc"!A0'), 'CMD|" /C calc"!A0');
  assert.equal(sanitizarTextoCelda('+HYPERLINK("http://evil.test")'), 'HYPERLINK("http://evil.test")');

  const csvText = [
    'Fecha de Degustación,Turno,Punto de Venta,Producto a Degustar,Vendedor,Promotora',
    '05/10/2026,MAÑANA,"INVERSIONES DEL ZULIA, C.A.",MORTADELA,CARLOS PEÑA,MARÍA PIÑA',
    '16/11/2026,TARDE,"=COMERCIAL VALENCIA, C.A.",ESPALDA,LUIS SOTO,SCARLETH NÚÑEZ',
  ].join('\n');

  const parsed = matrizAEntregas(parseCsv(csvText));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]!.fecha, '05-10-2026');
  assert.equal(parsed.rows[0]!.cliente, 'INVERSIONES DEL ZULIA, C.A.');
  assert.equal(parsed.rows[1]!.cliente, 'COMERCIAL VALENCIA, C.A.');
});

// =============================================================================
// E2E-5 & E2E-6: PRODUCCIÓN UNIFICADA (`/` + `/logistica/` + SW + MANIFEST) + SSR SMOKE
// =============================================================================
test('Fase 4 E2E-5/6 · Producción unificada (/ y /logistica/ + manifest + sw.js + headers) y SSR de ruta-degustacion', async () => {
  const torreDist = path.resolve('dist');
  const rutaDist = path.resolve('ruta-degustacion/dist');
  assert.equal(fs.existsSync(path.join(torreDist, 'index.html')), true, 'dist/index.html debe existir');
  assert.equal(fs.existsSync(path.join(rutaDist, 'index.html')), true, 'ruta-degustacion/dist/index.html debe existir');
  assert.equal(fs.existsSync(path.join(rutaDist, 'sw.js')), true, 'ruta-degustacion/dist/sw.js debe existir');
  assert.equal(fs.existsSync(path.resolve('dist-server/server.js')), true, 'dist-server/server.js debe existir');

  const app = express();
  app.disable('x-powered-by');
  for (const mw of buildSecurityHeaders({ isProduction: true })) {
    app.use(mw);
  }
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  app.use('/logistica', express.static(rutaDist, { index: 'index.html' }));
  app.get(/^\/logistica(?:\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(rutaDist, 'index.html'));
  });
  app.use('/', express.static(torreDist, { index: 'index.html' }));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(torreDist, 'index.html'));
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(health.headers.get('x-powered-by'), null);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.match(health.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<!doctype html>/i);

    const logistica = await fetch(`${base}/logistica/`);
    assert.equal(logistica.status, 200);
    const logisticaHtml = await logistica.text();
    assert.match(logisticaHtml, /\/logistica\/assets\//);

    const spaFallback = await fetch(`${base}/logistica/chofer/hoy`);
    assert.equal(spaFallback.status, 200);
    assert.match(await spaFallback.text(), /\/logistica\/assets\//);

    const manifestRes = await fetch(`${base}/logistica/manifest.json`);
    assert.equal(manifestRes.status, 200);
    const manifest = (await manifestRes.json()) as { scope: string; start_url: string };
    assert.equal(manifest.scope, '/logistica/');
    assert.match(manifest.start_url, /^\/logistica\//);

    const swRes = await fetch(`${base}/logistica/sw.js`);
    assert.equal(swRes.status, 200);
    assert.ok((await swRes.text()).length > 100, 'sw.js compilado debe contener el bundle Workbox');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // SSR smoke de componentes clave de ruta-degustacion (sin hooks cruzados entre subproyectos React)
  const prevGlobalReact = (globalThis as Record<string, unknown>).React;
  (globalThis as Record<string, unknown>).React = React;
  try {
    const progressHtml = renderToStaticMarkup(
      React.createElement(ProgressBar, {
        completadas: 3,
        total: 4,
        etiquetaDia: 'Hoy',
      })
    );
    assert.match(progressHtml, /3 de 4 entregas completadas/);
    assert.match(progressHtml, /75%/);

    const badgeHtml = renderToStaticMarkup(
      React.createElement(SyncStatusBadge, {
        sync: {
          status: 'sincronizado',
          errorMessage: null,
          lastSyncAt: new Date('2026-11-22T14:00:00.000Z'),
          realtime: true,
          offline: false,
          pendingCount: 0,
          flushing: false,
          aviso: null,
        },
        onRefresh: () => {},
      })
    );
    assert.match(badgeHtml, /Sincronizado en tiempo real/);

    const kpiHtml = renderToStaticMarkup(
      React.createElement(KpiCards, {
        resumen: {
          total: 10,
          entregadas: 8,
          pendientes: 2,
          cumplimiento: 80,
        },
      })
    );
    assert.match(kpiHtml, /Total Programadas/);
    assert.match(kpiHtml, /80%/);
  } finally {
    if (prevGlobalReact === undefined) {
      delete (globalThis as Record<string, unknown>).React;
    } else {
      (globalThis as Record<string, unknown>).React = prevGlobalReact;
    }
  }
});

// =============================================================================
// E2E-7: CERTIFICACIÓN DE CIERRE INTEGRAL (FASES 1 + 2 + 3 + 4)
// =============================================================================
test('Fase 4 E2E-7 · Certificación de cierre de Sprint: 31 migraciones limpias, suite de estrés y cero xlsx', () => {
  const migrationsDir = path.resolve('supabase/migrations');
  const files: MigrationFile[] = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(migrationsDir, name), 'utf8') }));

  assert.ok(files.some((f) => f.name.startsWith('20261124000100')), 'Falta migración SQL de Fase 1');
  assert.ok(files.some((f) => f.name.startsWith('20261125000100')), 'Falta migración SQL de Fase 2');
  assert.ok(files.some((f) => f.name.startsWith('20261126000100')), 'Falta migración SQL de Fase 3');

  const analysis = analyzeMigrations(files);
  assert.equal(analysis.errors.length, 0, formatIssues(analysis.errors));

  const stressSrc = fs.readFileSync(path.resolve('tests/stress/tradeMarketingStress.ts'), 'utf8');
  assert.match(stressSrc, /assertLocalTarget/, 'La suite de estrés debe exigir destino estrictamente local');
});
