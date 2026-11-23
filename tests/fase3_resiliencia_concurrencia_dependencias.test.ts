import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Request, Response } from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AttendanceConcurrencyConflictError,
  createAttendanceEvidencesHandlers,
  type AttendancePersistenceGateway,
} from '../src/server/attendanceEvidencesHandler';
import {
  assertSafeAttendanceStoragePath,
  AttendanceFileSecurityError,
  buildDeterministicAttendanceStoragePath,
} from '../src/server/imageMagicBytesValidator';
import {
  createVisibilityAwarePollingController,
  NOTIFICATIONS_POLL_INTERVAL_MS,
  type VisibilityDocumentAdapter,
} from '../src/hooks/useDegustacionesNotifications';
import {
  AttendanceEvidenceSubTab,
  filterAttendanceViewModels,
  normalizeSearchText,
} from '../src/components/field/AttendanceEvidenceSubTab';
import {
  executeOptimisticAppendWithRollback,
  executeOptimisticUpdateWithRollback,
  fetchAuditLogsPage,
  fetchDiscrepancyAlertsPage,
  persistAuditLogEntry,
  persistDiscrepancyAlert,
  resolveActiveRegionContext,
  resolveDiscrepancyAlertInSupabase,
} from '../src/services/auditAndAlertsService';
import {
  getCaracasTodayYmd,
  type AsistenciaEvidenciaDbRow,
  type AsistenciaJornadaDbRow,
  type DailyPromotoraAttendanceViewModel,
} from '../src/types/attendanceEvidences';
import type { AuditLogEntry, DiscrepancyAlert } from '../src/types';

// PNG 1x1 válido base para pruebas binarias (magic bytes 89 50 4E 47 0D 0A 1A 0A)
const VALID_PNG_BASE = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex'
);

function makeDistinctPng(seed: number): Buffer {
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(seed, 0);
  return Buffer.concat([VALID_PNG_BASE, trailer]);
}

function encodeMetaHeader(meta: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(meta), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createMockExpressRes() {
  let statusCode = 200;
  let jsonBody: Record<string, unknown> | null = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader() {
      return res;
    },
    json(payload: unknown) {
      jsonBody = payload as Record<string, unknown>;
      return res;
    },
  } as unknown as Response;

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => jsonBody,
  };
}

/**
 * Gateway transaccional en memoria que emula el bloqueo optimista (CAS) real de PostgreSQL
 * + latencias asíncronas superpuestas en lectura/Storage para estresar la ventana TOCTOU.
 */
function createCasAttendanceGateway(options?: {
  initialEvidence?: AsistenciaEvidenciaDbRow;
  initialJornada?: AsistenciaJornadaDbRow;
  failDeletePaths?: Set<string>;
  readDelayMs?: number;
  uploadDelayMs?: number;
}) {
  const jornadas = new Map<string, AsistenciaJornadaDbRow>();
  const evidences = new Map<string, AsistenciaEvidenciaDbRow>();
  const storageObjects = new Map<string, { mimeType: string; size: number }>();
  const deletedPathsHistory: string[] = [];
  let uploadCount = 0;

  if (options?.initialJornada) {
    jornadas.set(
      `${options.initialJornada.fecha_jornada}:${options.initialJornada.promotora_id}`,
      { ...options.initialJornada }
    );
  }
  if (options?.initialEvidence) {
    const ev = { ...options.initialEvidence };
    evidences.set(`${ev.asistencia_id}:${ev.slot_foto}`, ev);
    storageObjects.set(ev.storage_path, {
      mimeType: ev.mime_type,
      size: ev.tamano_bytes,
    });
  }

  const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  const gateway: AttendancePersistenceGateway = {
    async lookupStaffProfile(promotoraId) {
      return {
        id: promotoraId,
        name: 'María José Piña',
        email: 'maria.pina@promotoras.codizulca.local',
        assignedStore: 'AUTOMERCADO FIORELLA NORTE',
        address: 'MARACAIBO NORTE',
        sucursal: 'ZULIA',
        active: true,
        isMerchandising: false,
        masterProfile: 'FIJA',
      };
    },
    async findJornadaByDateAndPromotora(fecha, promotoraId) {
      return jornadas.get(`${fecha}:${promotoraId}`) ?? null;
    },
    async createJornadaIfAbsent(params) {
      const key = `${params.fechaJornada}:${params.promotoraId}`;
      const existing = jornadas.get(key);
      if (existing) return existing;
      const created: AsistenciaJornadaDbRow = {
        id: crypto.randomUUID(),
        fecha_jornada: params.fechaJornada,
        promotora_id: params.promotoraId,
        promotora_nombre: params.promotoraNombre,
        perfil_aplicado: params.perfilAplicado,
        pdv_nombre: params.pdvNombre,
        zona: params.zona,
        sucursal: params.sucursal ?? 'ZULIA',
        opened_at_server: params.openedAtServerIso,
        updated_at_server: params.openedAtServerIso,
        opened_by_uid: params.openedByUid,
      };
      jornadas.set(key, created);
      return created;
    },
    async listEvidencesByJornadaId(asistenciaId) {
      await sleep(options?.readDelayMs ?? 15);
      return Array.from(evidences.values())
        .filter((e) => e.asistencia_id === asistenciaId)
        .map((e) => ({ ...e }));
    },
    async uploadPrivateObject(params) {
      uploadCount += 1;
      await sleep(options?.uploadDelayMs ?? 10);
      if (storageObjects.has(params.path)) {
        throw new Error(`STORAGE_UPLOAD_ERROR: Object already exists at ${params.path}`);
      }
      storageObjects.set(params.path, {
        mimeType: params.mimeType,
        size: params.buffer.byteLength,
      });
    },
    async upsertSlotEvidence(params) {
      const slotKey = `${params.asistenciaId}:${params.slotFoto}`;
      const current = evidences.get(slotKey);

      // Verificación atómica CAS (idéntica a rpc_upsert_asistencia_evidencia_cas / UPDATE ... WHERE version = $expected)
      if (params.expectedEvidenceId == null) {
        if (current) {
          throw new AttendanceConcurrencyConflictError(
            'Alta concurrente rechazada: la ranura ya fue creada por otra solicitud.',
            { currentVersion: current.version ?? 1, currentId: current.id }
          );
        }
        const inserted: AsistenciaEvidenciaDbRow = {
          id: crypto.randomUUID(),
          asistencia_id: params.asistenciaId,
          slot_foto: params.slotFoto,
          storage_bucket: params.storageBucket,
          storage_path: params.storagePath,
          mime_type: params.mimeType,
          tamano_bytes: params.sizeBytes,
          sha256_hex: params.sha256Hex,
          ancho_px: params.anchoPx,
          alto_px: params.altoPx,
          pdv_nombre: params.pdvNombre,
          lat: params.lat,
          lng: params.lng,
          gps_accuracy: params.gpsAccuracy,
          sucursal: params.sucursal ?? 'ZULIA',
          capturado_en_servidor: params.capturadoEnServidorIso,
          cargado_por_uid: params.cargadoPorUid,
          cargado_por_rol: params.cargadoPorRol,
          version: 1,
          updated_at: params.capturadoEnServidorIso,
        };
        evidences.set(slotKey, inserted);
        return { ...inserted };
      }

      const currentVersion = current?.version ?? 1;
      if (
        !current ||
        current.id !== params.expectedEvidenceId ||
        currentVersion !== (params.expectedVersion ?? 1)
      ) {
        throw new AttendanceConcurrencyConflictError(
          'Conflicto de concurrencia: la evidencia fue reemplazada por otra solicitud.',
          { currentVersion: current?.version ?? null, currentId: current?.id ?? null }
        );
      }

      const updated: AsistenciaEvidenciaDbRow = {
        ...current,
        storage_bucket: params.storageBucket,
        storage_path: params.storagePath,
        mime_type: params.mimeType,
        tamano_bytes: params.sizeBytes,
        sha256_hex: params.sha256Hex,
        ancho_px: params.anchoPx,
        alto_px: params.altoPx,
        pdv_nombre: params.pdvNombre,
        lat: params.lat,
        lng: params.lng,
        gps_accuracy: params.gpsAccuracy,
        capturado_en_servidor: params.capturadoEnServidorIso,
        cargado_por_uid: params.cargadoPorUid,
        cargado_por_rol: params.cargadoPorRol,
        version: currentVersion + 1,
        updated_at: params.capturadoEnServidorIso,
      };
      evidences.set(slotKey, updated);
      return { ...updated };
    },
    async deletePrivateObjects(_bucket, paths) {
      for (const p of paths) {
        if (options?.failDeletePaths?.has(p)) {
          throw new Error(`STORAGE_DELETE_ERROR: simulated failure deleting ${p}`);
        }
        deletedPathsHistory.push(p);
        storageObjects.delete(p);
      }
    },
    async createSignedUrls(_bucket, paths) {
      return Object.fromEntries(paths.map((p) => [p, `http://127.0.0.1/signed/${encodeURIComponent(p)}`]));
    },
    async findEvidencesWithOwnerByIds() {
      return [];
    },
  };

  return {
    gateway,
    jornadas,
    evidences,
    storageObjects,
    deletedPathsHistory,
    getUploadCount: () => uploadCount,
  };
}

// =============================================================================
// 1. PRUEBAS DE CONCURRENCIA TOCTOU (`attendanceEvidencesHandler.ts` + SQL CAS)
// =============================================================================
test('Fase 3 · TOCTOU: 12 reemplazos concurrentes (Promise.all) mantienen consistencia 100% BD <-> Storage', async () => {
  const PROMOTORA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const JORNADA_ID = '55551111-1111-4111-8111-111111111111';
  const INITIAL_EV_ID = '99991111-1111-4111-8111-111111111111';
  const INITIAL_PATH = buildDeterministicAttendanceStoragePath({
    fechaJornada: '2026-11-22',
    promotoraId: PROMOTORA_ID,
    slotFoto: 'JORNADA_INGRESO',
    extension: 'png',
    timestampMs: 1795300000000,
  });

  const store = createCasAttendanceGateway({
    initialJornada: {
      id: JORNADA_ID,
      fecha_jornada: '2026-11-22',
      promotora_id: PROMOTORA_ID,
      promotora_nombre: 'María José Piña',
      perfil_aplicado: 'FIJA',
      pdv_nombre: 'FIORELLA NORTE',
      zona: 'MARACAIBO NORTE',
      sucursal: 'ZULIA',
      opened_at_server: '2026-11-22T12:00:00.000Z',
      updated_at_server: '2026-11-22T12:00:00.000Z',
      opened_by_uid: '11111111-1111-4111-8111-111111111111',
    },
    initialEvidence: {
      id: INITIAL_EV_ID,
      asistencia_id: JORNADA_ID,
      slot_foto: 'JORNADA_INGRESO',
      storage_bucket: 'asistencia-evidencias',
      storage_path: INITIAL_PATH,
      mime_type: 'image/png',
      tamano_bytes: VALID_PNG_BASE.byteLength,
      sha256_hex: crypto.createHash('sha256').update(VALID_PNG_BASE).digest('hex'),
      ancho_px: 1,
      alto_px: 1,
      pdv_nombre: 'FIORELLA NORTE',
      lat: 10.65,
      lng: -71.62,
      gps_accuracy: 10,
      sucursal: 'ZULIA',
      capturado_en_servidor: '2026-11-22T12:00:00.000Z',
      cargado_por_uid: '11111111-1111-4111-8111-111111111111',
      cargado_por_rol: 'coordinadora',
      version: 1,
      updated_at: '2026-11-22T12:00:00.000Z',
    },
    readDelayMs: 20,
    uploadDelayMs: 12,
  });

  const BASE_NOW_MS = Date.parse('2026-11-22T15:00:00.000Z'); // 11:00 a. m. America/Caracas (2026-11-22)
  let tick = 0;
  const handlers = createAttendanceEvidencesHandlers({
    resolveGateway: () => store.gateway,
    now: () => new Date(BASE_NOW_MS + tick++ * 10),
  });

  const CONCURRENT_CALLS = 12;
  const responses = await Promise.all(
    Array.from({ length: CONCURRENT_CALLS }, (_, idx) => {
      const mockRes = createMockExpressRes();
      const req = {
        authUser: {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'coordinadora@codizulca.local',
          appRole: 'coordinadora',
          sucursal: 'ZULIA',
          isCoordinatorOrAdmin: true,
        },
        headers: {
          'x-asistencia-meta': encodeMetaHeader({
            promotoraId: PROMOTORA_ID,
            fechaJornada: '2026-11-22',
            slotFoto: 'JORNADA_INGRESO',
            pdvNombre: `PDV CONCURRENTE #${idx + 1}`,
          }),
        },
        body: makeDistinctPng(idx + 1),
      } as unknown as Request;

      return handlers.handleUploadEvidence(req, mockRes.res).then(() => ({
        idx,
        status: mockRes.getStatus(),
        body: mockRes.getBody(),
      }));
    })
  );

  const winners = responses.filter((r) => r.status === 200);
  const conflicts = responses.filter((r) => r.status === 409);

  assert.equal(winners.length, 1, 'Exactamente 1 petición debe ganar el reemplazo concurrente (HTTP 200)');
  assert.equal(
    conflicts.length,
    CONCURRENT_CALLS - 1,
    'Las 11 peticiones perdedoras deben recibir HTTP 409 Conflict controlado'
  );

  for (const c of conflicts) {
    assert.equal(c.body?.code, 'EVIDENCE_CONCURRENCY_CONFLICT');
    assert.equal(c.body?.retryable, true);
  }

  const winnerEv = winners[0]!.body?.evidencia as { storagePath: string; version: number };
  assert.equal(winnerEv.version, 2, 'La versión optimista debe incrementarse atómicamente a 2');
  assert.notEqual(
    winnerEv.storagePath,
    INITIAL_PATH,
    'Jamás debe sobrescribirse en sitio el path anterior'
  );

  // Consistencia estricta DB <-> Storage
  assert.equal(store.evidences.size, 1, 'Debe existir exactamente 1 fila activa en BD');
  const [dbRow] = Array.from(store.evidences.values());
  assert.equal(dbRow!.storage_path, winnerEv.storagePath);
  assert.equal(dbRow!.version, 2);

  assert.equal(
    store.storageObjects.size,
    1,
    'Debe quedar exactamente 1 objeto en Storage (0 huérfanos de los 11 perdedores y 0 restos del archivo viejo)'
  );
  assert.equal(
    store.storageObjects.has(winnerEv.storagePath),
    true,
    'El archivo ganador referenciado en BD NUNCA puede haberse borrado'
  );
  assert.equal(
    store.storageObjects.has(INITIAL_PATH),
    false,
    'El archivo anterior debe haberse eliminado únicamente tras confirmar el commit ganador'
  );
  assert.equal(
    store.deletedPathsHistory.includes(winnerEv.storagePath),
    false,
    'El path ganador jamás debe aparecer en el historial de borrados'
  );
});

test('Fase 3 · TOCTOU: 10 altas iniciales concurrentes, fallo en limpieza post-commit, expectedVersion obsoleto y seguridad de rutas/SQL', async (t) => {
  const PROMOTORA_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  await t.test('10 altas iniciales concurrentes (ranura vacía): 1 x 201, 9 x 409, 0 huérfanos', async () => {
    const store = createCasAttendanceGateway({ readDelayMs: 15, uploadDelayMs: 10 });
    const BASE_NOW_MS = Date.parse('2026-11-22T15:30:00.000Z'); // 11:30 a. m. America/Caracas (2026-11-22)
    let tick = 0;
    const handlers = createAttendanceEvidencesHandlers({
      resolveGateway: () => store.gateway,
      now: () => new Date(BASE_NOW_MS + tick++ * 10),
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, idx) => {
        const mockRes = createMockExpressRes();
        const req = {
          authUser: {
            id: '22222222-2222-4222-8222-222222222222',
            email: 'coordinadora@codizulca.local',
            appRole: 'coordinadora',
            sucursal: 'ZULIA',
            isCoordinatorOrAdmin: true,
          },
          headers: {
            'x-asistencia-meta': encodeMetaHeader({
              promotoraId: PROMOTORA_ID,
              fechaJornada: '2026-11-22',
              slotFoto: 'JORNADA_SALIDA',
              pdvNombre: 'DE CANDIDO',
            }),
          },
          body: makeDistinctPng(100 + idx),
        } as unknown as Request;
        return handlers.handleUploadEvidence(req, mockRes.res).then(() => mockRes.getStatus());
      })
    );

    assert.equal(results.filter((s) => s === 201).length, 1);
    assert.equal(results.filter((s) => s === 409).length, 9);
    assert.equal(store.evidences.size, 1);
    assert.equal(store.storageObjects.size, 1);
    const [row] = Array.from(store.evidences.values());
    assert.equal(store.storageObjects.has(row!.storage_path), true);
  });

  await t.test('fallo al eliminar archivo anterior post-commit registra advertencia y NO falla reemplazo confirmado', async () => {
    const JORNADA_ID = '66661111-1111-4111-8111-111111111111';
    const OLD_PATH = buildDeterministicAttendanceStoragePath({
      fechaJornada: '2026-11-22',
      promotoraId: PROMOTORA_ID,
      slotFoto: 'JORNADA_INGRESO',
      extension: 'png',
      timestampMs: 1795300000100,
    });
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const store = createCasAttendanceGateway({
      initialJornada: {
        id: JORNADA_ID,
        fecha_jornada: '2026-11-22',
        promotora_id: PROMOTORA_ID,
        promotora_nombre: 'María José Piña',
        perfil_aplicado: 'FIJA',
        pdv_nombre: 'ENNE',
        zona: 'NORTE',
        sucursal: 'ZULIA',
        opened_at_server: '2026-11-22T12:00:00.000Z',
        updated_at_server: '2026-11-22T12:00:00.000Z',
        opened_by_uid: '11111111-1111-4111-8111-111111111111',
      },
      initialEvidence: {
        id: '88881111-1111-4111-8111-111111111111',
        asistencia_id: JORNADA_ID,
        slot_foto: 'JORNADA_INGRESO',
        storage_bucket: 'asistencia-evidencias',
        storage_path: OLD_PATH,
        mime_type: 'image/png',
        tamano_bytes: VALID_PNG_BASE.byteLength,
        sha256_hex: crypto.createHash('sha256').update(VALID_PNG_BASE).digest('hex'),
        ancho_px: 1,
        alto_px: 1,
        pdv_nombre: 'ENNE',
        lat: null,
        lng: null,
        gps_accuracy: null,
        sucursal: 'ZULIA',
        capturado_en_servidor: '2026-11-22T12:00:00.000Z',
        cargado_por_uid: '11111111-1111-4111-8111-111111111111',
        cargado_por_rol: 'coordinadora',
        version: 1,
      },
      failDeletePaths: new Set([OLD_PATH]),
      readDelayMs: 0,
      uploadDelayMs: 0,
    });

    const handlers = createAttendanceEvidencesHandlers({
      resolveGateway: () => store.gateway,
      now: () => new Date('2026-11-22T15:00:00.000Z'),
      logger: {
        warn(msg, fields) {
          warnings.push({ msg, fields });
        },
        error() {},
      },
    });

    const mockRes = createMockExpressRes();
    await handlers.handleUploadEvidence(
      {
        authUser: {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'coordinadora@codizulca.local',
          appRole: 'coordinadora',
          sucursal: 'ZULIA',
          isCoordinatorOrAdmin: true,
        },
        headers: {
          'x-asistencia-meta': encodeMetaHeader({
            promotoraId: PROMOTORA_ID,
            fechaJornada: '2026-11-22',
            slotFoto: 'JORNADA_INGRESO',
            pdvNombre: 'ENNE',
            expectedVersion: 1,
          }),
        },
        body: makeDistinctPng(77),
      } as unknown as Request,
      mockRes.res
    );

    assert.equal(mockRes.getStatus(), 200, 'El reemplazo confirmado en BD debe responder 200 aunque falle la limpieza del viejo');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.msg, 'attendance_previous_storage_cleanup_failed');
    assert.equal(warnings[0]!.fields?.previousStoragePath, OLD_PATH);

    // Petición con expectedVersion=1 (obsoleto porque ahora está en versión 2) -> 409 SIN tocar Storage
    const uploadsBefore = store.getUploadCount();
    const staleRes = createMockExpressRes();
    await handlers.handleUploadEvidence(
      {
        authUser: {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'coordinadora@codizulca.local',
          appRole: 'coordinadora',
          sucursal: 'ZULIA',
          isCoordinatorOrAdmin: true,
        },
        headers: {
          'x-asistencia-meta': encodeMetaHeader({
            promotoraId: PROMOTORA_ID,
            fechaJornada: '2026-11-22',
            slotFoto: 'JORNADA_INGRESO',
            pdvNombre: 'ENNE',
            expectedVersion: 1,
          }),
        },
        body: makeDistinctPng(78),
      } as unknown as Request,
      staleRes.res
    );
    assert.equal(staleRes.getStatus(), 409);
    assert.equal(staleRes.getBody()?.currentVersion, 2);
    assert.equal(store.getUploadCount(), uploadsBefore, 'Versión obsoleta debe rechazarse antes de subir bytes a Storage');
  });

  await t.test('anti-path-traversal y auditoría estática de migración SQL 20261126000100', () => {
    for (const badPath of [
      '../etc/passwd',
      'asistencia/2026-11-22/../../evil.png',
      'asistencia\\2026-11-22\\evil.png',
      'asistencia/2026-11-22/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/JORNADA_INGRESO_bad\0.png',
      '/asistencia/2026-11-22/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/JORNADA_INGRESO_11111111-1111-4111-8111-111111111111.png',
    ]) {
      assert.throws(() => assertSafeAttendanceStoragePath(badPath), AttendanceFileSecurityError);
    }

    const sqlPath = path.resolve(
      'supabase/migrations/20261126000100_fase3_asistencia_evidencias_optimistic_lock.sql'
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const sqlNoComments = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(sqlNoComments, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1/i);
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_upsert_asistencia_evidencia_cas/i);
    assert.match(sql, /SECURITY INVOKER/i);
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.rpc_upsert_asistencia_evidencia_cas[\s\S]*FROM PUBLIC, anon/i);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.rpc_upsert_asistencia_evidencia_cas[\s\S]*TO authenticated, service_role/i);
  });
});

// =============================================================================
// 2. POLLING INTELIGENTE CON PAGE VISIBILITY API (`useDegustacionesNotifications.ts`)
// =============================================================================
test('Fase 3 · Polling con Page Visibility API: pausa en hidden, aborta en vuelo y reanuda limpio en visible', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 });

  let visibility: 'visible' | 'hidden' = 'visible';
  const listeners = new Set<() => void>();
  const mockDoc: VisibilityDocumentAdapter = {
    get visibilityState() {
      return visibility;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };

  const emitVisibility = (next: 'visible' | 'hidden') => {
    visibility = next;
    for (const fn of Array.from(listeners)) {
      fn();
    }
  };

  let callCount = 0;
  const signals: AbortSignal[] = [];
  const pendingResolvers: Array<() => void> = [];
  let holdNextSync = false;

  const controller = createVisibilityAwarePollingController({
    pollIntervalMs: NOTIFICATIONS_POLL_INTERVAL_MS,
    cooldownMs: 2_500,
    documentAdapter: mockDoc,
    isOnline: () => true,
    now: () => Date.now(),
    onSync: async (signal) => {
      callCount += 1;
      signals.push(signal);
      if (holdNextSync) {
        holdNextSync = false;
        await new Promise<void>((resolve) => {
          pendingResolvers.push(resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    },
  });

  // 1. Arranque en 'visible': disparo inicial + cada 15s exactos
  controller.start({ runImmediateIfVisible: true });
  await Promise.resolve();
  assert.equal(callCount, 1, 'Debe realizar carga inicial al montar en visible');
  assert.equal(controller.getState().isIntervalActive, true);

  t.mock.timers.tick(NOTIFICATIONS_POLL_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(callCount, 2, 'Debe disparar polling exactamente a los 15 s en visible');

  t.mock.timers.tick(NOTIFICATIONS_POLL_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(callCount, 3, 'Debe disparar segundo ciclo a los 30 s en visible');

  // 2. Iniciar una petición lenta y cambiar a 'hidden': debe abortar en vuelo y detener intervalo
  holdNextSync = true;
  t.mock.timers.tick(NOTIFICATIONS_POLL_INTERVAL_MS);
  assert.equal(callCount, 4);
  const inFlightSignal = signals[signals.length - 1]!;
  assert.equal(inFlightSignal.aborted, false);
  assert.equal(controller.getState().isRequestInFlight, true);

  emitVisibility('hidden');
  assert.equal(inFlightSignal.aborted, true, 'Al pasar a hidden debe abortar de inmediato el request en curso');
  assert.equal(controller.getState().isIntervalActive, false, 'En hidden el intervalo debe detenerse por completo');

  // 3. Avanzar 90 s (6 intervalos de 15 s) mientras sigue hidden -> 0 llamadas
  const callsWhenHidden = callCount;
  t.mock.timers.tick(NOTIFICATIONS_POLL_INTERVAL_MS * 6);
  await Promise.resolve();
  assert.equal(callCount, callsWhenHidden, '0 llamadas de polling mientras document.visibilityState === hidden');

  // 4. Volver a 'visible' tras superar el cooldown -> 1 refresco controlado + reinicio de 15 s
  emitVisibility('visible');
  await Promise.resolve();
  assert.equal(callCount, callsWhenHidden + 1, 'Al volver a visible debe refrescar de forma controlada');
  assert.equal(controller.getState().isIntervalActive, true);

  // 5. Cambios rápidos hidden <-> visible dentro del cooldown (500 ms) NO disparan tormenta de requests
  t.mock.timers.tick(500);
  emitVisibility('hidden');
  emitVisibility('visible');
  await Promise.resolve();
  assert.equal(
    callCount,
    callsWhenHidden + 1,
    'El cooldown anti-tormenta debe impedir solicitudes duplicadas en cambios rápidos de pestaña'
  );

  // 6. Anti-solapamiento: si un request sigue en curso cuando vence el intervalo de 15 s, no lanza uno paralelo
  t.mock.timers.tick(3_000);
  holdNextSync = true;
  const manualPromise = controller.triggerSync({ forceImmediate: true, isBackgroundDelta: true });
  assert.equal(callCount, callsWhenHidden + 2);
  t.mock.timers.tick(NOTIFICATIONS_POLL_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(
    callCount,
    callsWhenHidden + 2,
    'Guardia anti-solapamiento: no debe lanzar polling superpuesto mientras hay uno en curso'
  );
  pendingResolvers.splice(0).forEach((fn) => fn());
  await manualPromise;

  // 7. Reanuda normalmente en el siguiente ciclo de 15 s ya libre
  t.mock.timers.tick(NOTIFICATIONS_POLL_INTERVAL_MS);
  await Promise.resolve();
  assert.equal(callCount, callsWhenHidden + 3);

  // 8. Cleanup total en dispose(): remueve listeners, para timers y aborta en vuelo
  holdNextSync = true;
  void controller.triggerSync({ forceImmediate: true, isBackgroundDelta: true });
  const lastSignalBeforeDispose = signals[signals.length - 1]!;
  controller.dispose();
  assert.equal(lastSignalBeforeDispose.aborted, true, 'dispose() debe abortar requests activos');
  assert.equal(listeners.size, 0, 'dispose() debe limpiar todos los listeners visibilitychange');
  const callsAtDispose = callCount;
  t.mock.timers.tick(NOTIFICATIONS_POLL_INTERVAL_MS * 4);
  await Promise.resolve();
  assert.equal(callCount, callsAtDispose, '0 llamadas después de dispose()');
});

// =============================================================================
// 3. BÚSQUEDA INSENSIBLE A TILDES Y DIACRÍTICOS (`AttendanceEvidenceSubTab.tsx`)
// =============================================================================
test('Fase 3 · Búsqueda insensible a tildes y diacríticos en AttendanceEvidenceSubTab.tsx', () => {
  assert.equal(normalizeSearchText('Degustación'), 'degustacion');
  assert.equal(normalizeSearchText('  MARÍA JOSÉ PIÑA  '), 'maria jose pina');
  assert.equal(normalizeSearchText(null), '');
  assert.equal(normalizeSearchText(undefined), '');

  const makeVm = (overrides: Partial<DailyPromotoraAttendanceViewModel>): DailyPromotoraAttendanceViewModel => ({
    key: '2026-11-22__1',
    asistenciaId: '11111111-1111-4111-8111-111111111111',
    fechaJornada: '2026-11-22',
    fechaSlash: '22/11/2026',
    fechaLongEs: 'DOMINGO, 22 DE NOVIEMBRE DE 2026',
    promotoraId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    promotoraNombre: 'María José Pérez',
    promotoraInitials: 'MJ',
    promotoraEmail: 'maria@test.local',
    pdvNombre: 'Centro de Degustación Delicias',
    zona: 'Maracaibo Norte · Región Occidente',
    perfilAplicado: 'FIJA',
    perfilFuente: 'SNAPSHOT_HISTORICO',
    compliance: {
      perfilAplicado: 'FIJA',
      uploadedCount: 2,
      requiredCount: 2,
      fractionLabel: '2/2',
      status: 'COMPLETA',
      statusLabel: 'Completa',
    },
    evidencesBySlot: {},
    ...overrides,
  });

  const universe: DailyPromotoraAttendanceViewModel[] = [
    makeVm({
      key: '1',
      promotoraNombre: 'María José Pérez',
      pdvNombre: 'Centro de Degustación Delicias',
      zona: 'Maracaibo Norte',
      perfilAplicado: 'FIJA',
    }),
    makeVm({
      key: '2',
      promotoraNombre: 'José Ángel Núñez',
      pdvNombre: 'Hipermercado Valencia',
      zona: 'Carabobo Centro',
      perfilAplicado: 'EVENTUAL',
    }),
    // Registro con campos null/undefined simulados (defensa runtime)
    makeVm({
      key: '3',
      promotoraNombre: undefined as unknown as string,
      pdvNombre: null as unknown as string,
      zona: undefined as unknown as string,
      perfilAplicado: 'FIJA',
    }),
  ];

  // Coincidencias cruzadas exigidas
  assert.deepEqual(
    filterAttendanceViewModels(universe, { searchQuery: 'degustacion' }).map((i) => i.key),
    ['1'],
    '"degustacion" debe encontrar "Degustación"'
  );
  assert.deepEqual(
    filterAttendanceViewModels(universe, { searchQuery: 'Degustación' }).map((i) => i.key),
    ['1']
  );
  assert.deepEqual(
    filterAttendanceViewModels(universe, { searchQuery: 'jose' }).map((i) => i.key),
    ['1', '2'],
    '"jose" debe encontrar "María José" y "José Ángel"'
  );
  assert.deepEqual(
    filterAttendanceViewModels(universe, { searchQuery: 'José' }).map((i) => i.key),
    ['1', '2']
  );
  assert.deepEqual(
    filterAttendanceViewModels(universe, { searchQuery: 'MARÍA' }).map((i) => i.key),
    ['1'],
    '"MARÍA" debe encontrar "María"'
  );
  assert.deepEqual(
    filterAttendanceViewModels(universe, { searchQuery: 'maria' }).map((i) => i.key),
    ['1'],
    '"maria" debe encontrar "María"'
  );
  assert.deepEqual(
    filterAttendanceViewModels(universe, { searchQuery: 'nunez', profileFilter: 'EVENTUAL' }).map((i) => i.key),
    ['2']
  );
  assert.equal(filterAttendanceViewModels(universe, { searchQuery: null }).length, 3);
  assert.equal(filterAttendanceViewModels(universe, { searchQuery: undefined }).length, 3);

  // Verificar renderizado SSR del componente real con búsqueda sin tildes
  const markup = renderToStaticMarkup(
    React.createElement(AttendanceEvidenceSubTab, {
      staffMembers: [],
      asistenciaJornadas: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          fecha_jornada: getCaracasTodayYmd(),
          promotora_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          promotora_nombre: 'María José Pérez',
          perfil_aplicado: 'FIJA',
          pdv_nombre: 'Centro de Degustación Delicias',
          zona: 'Maracaibo Norte',
          opened_at_server: new Date().toISOString(),
          updated_at_server: new Date().toISOString(),
          opened_by_uid: null,
        },
      ],
      asistenciaEvidencias: [],
      legacyAttendanceRecords: [],
      searchQuery: 'degustacion',
      onSearchQueryChange: () => {},
      onRefreshData: async () => {},
      onNotifyToast: () => {},
    })
  );
  assert.match(markup, /María José Pérez/, 'El componente debe mostrar la tarjeta al buscar "degustacion" sin tilde');
});

// =============================================================================
// 4. PERSISTENCIA Y ROLLBACK DE AUDITORÍA Y ALERTAS (`auditAndAlertsService.ts` / `AppContext.tsx`)
// =============================================================================
test('Fase 3 · Persistencia real, paginación regional y rollback de auditLogs y discrepancyAlerts', async (t) => {
  const OCCIDENTE_UUID = '10101010-1010-4010-8010-101010101010';
  const CENTRO_UUID = '20202020-2020-4020-8020-202020202020';
  const ANDES_UUID = '30303030-3030-4030-8030-303030303030';

  const dbTables: {
    Regiones: Array<Record<string, unknown>>;
    audit_logs: Array<Record<string, unknown>>;
    discrepancy_alerts: Array<Record<string, unknown>>;
  } = {
    Regiones: [
      { id_regi: OCCIDENTE_UUID, regi_desd: 'OCCIDENTE', regi_saba: true, created_at: '2026-01-01T00:00:00Z' },
      { id_regi: CENTRO_UUID, regi_desd: 'CENTRO', regi_saba: false, created_at: '2026-01-01T00:00:00Z' },
      { id_regi: ANDES_UUID, regi_desd: 'ANDES', regi_saba: false, created_at: '2026-01-01T00:00:00Z' },
    ],
    audit_logs: [
      {
        id: 'a0000000-0000-4000-8000-000000000001',
        created_at: '2026-11-22T10:00:00.000Z',
        actor_id: '11111111-1111-4111-8111-111111111111',
        actor_role: 'coordinacion',
        action: 'EVENTO_OCCIDENTE_1',
        entity_type: 'REQUISITION',
        entity_id: 'REQ-001',
        region_id: OCCIDENTE_UUID,
        metadata: { userName: 'Ana Zulia', integrityHash: 'sha256:abc' },
        ip_address: null,
      },
      {
        id: 'a0000000-0000-4000-8000-000000000002',
        created_at: '2026-11-22T11:00:00.000Z',
        actor_id: '11111111-1111-4111-8111-111111111111',
        actor_role: 'coordinacion',
        action: 'EVENTO_OCCIDENTE_2',
        entity_type: 'EXPENSE',
        entity_id: 'FAC-002',
        region_id: OCCIDENTE_UUID,
        metadata: { userName: 'Ana Zulia', integrityHash: 'sha256:def' },
        ip_address: null,
      },
      {
        id: 'a0000000-0000-4000-8000-000000000003',
        created_at: '2026-11-22T12:00:00.000Z',
        actor_id: '22222222-2222-4222-8222-222222222222',
        actor_role: 'coordinacion',
        action: 'EVENTO_CENTRO_1',
        entity_type: 'REQUISITION',
        entity_id: 'REQ-999',
        region_id: CENTRO_UUID,
        metadata: { userName: 'Luis Valencia' },
        ip_address: null,
      },
    ],
    discrepancy_alerts: [
      {
        id: 'd0000000-0000-4000-8000-000000000001',
        created_at: '2026-11-22T10:30:00.000Z',
        updated_at: '2026-11-22T10:30:00.000Z',
        severity: 'CRITICA',
        status: 'OPEN',
        category: 'RULE_ANTIFRAUD_DUPLICATE_INVOICE',
        title: 'Factura duplicada Occidente',
        description: 'Comprobante repetido',
        entity_type: 'EXPENSE',
        entity_id: 'FAC-001',
        region_id: OCCIDENTE_UUID,
        resolved_by: null,
        resolved_at: null,
        metadata: { detectedByRule: 'RULE_ANTIFRAUD_DUPLICATE_INVOICE' },
      },
    ],
  };

  let failNextInsertOnTable: string | null = null;
  let failNextUpdateOnTable: string | null = null;

  const mockSupabaseClient = {
    from(table: keyof typeof dbTables) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let mode: 'select' | 'insert' | 'update' = 'select';
      let pendingPayload: Record<string, unknown> | null = null;

      const execQuery = (rangeBounds?: [number, number], singleMode = false) => {
        if (mode === 'insert' && pendingPayload) {
          if (failNextInsertOnTable === table) {
            failNextInsertOnTable = null;
            return Promise.resolve({
              data: null,
              error: { code: '42501', message: `RLS denied insert on ${table}` },
            });
          }
          const created: Record<string, unknown> = {
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...pendingPayload,
          };
          dbTables[table].push(created);
          return Promise.resolve({ data: singleMode ? created : [created], error: null });
        }

        if (mode === 'update' && pendingPayload) {
          if (failNextUpdateOnTable === table) {
            failNextUpdateOnTable = null;
            return Promise.resolve({
              data: null,
              error: { code: '42501', message: `RLS denied update on ${table}` },
            });
          }
          const matched = dbTables[table].filter((r) => filters.every((f) => f(r)));
          for (const row of matched) {
            Object.assign(row, pendingPayload, { updated_at: new Date().toISOString() });
          }
          return Promise.resolve({
            data: singleMode ? (matched[0] ?? null) : matched,
            error: matched.length === 0 ? { message: 'Row not found' } : null,
          });
        }

        let rows = dbTables[table].filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          const col = orderCol;
          rows = [...rows].sort((a, b) => {
            const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
            return orderAsc ? cmp : -cmp;
          });
        }
        const total = rows.length;
        if (rangeBounds) {
          rows = rows.slice(rangeBounds[0], rangeBounds[1] + 1);
        }
        return Promise.resolve({
          data: singleMode ? (rows[0] ?? null) : rows,
          error: null,
          count: total,
        });
      };

      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        insert(payload: Record<string, unknown>) {
          mode = 'insert';
          pendingPayload = payload;
          return builder;
        },
        update(payload: Record<string, unknown>) {
          mode = 'update';
          pendingPayload = payload;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((row) => row[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          filters.push((row) => vals.includes(row[col]));
          return builder;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        range(from: number, to: number) {
          return execQuery([from, to], false);
        },
        single() {
          return execQuery(undefined, true);
        },
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
          return execQuery(undefined, false).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;

  await t.test('resolución dinámica de region_id desde "Regiones" (ZULIA -> OCCIDENTE, VALENCIA -> CENTRO)', async () => {
    const zuliaRegion = await resolveActiveRegionContext({ activeSucursal: 'ZULIA' }, mockSupabaseClient);
    assert.equal(zuliaRegion.regionCode, 'OCCIDENTE');
    assert.equal(zuliaRegion.regionId, OCCIDENTE_UUID);

    const valenciaRegion = await resolveActiveRegionContext({ activeSucursal: 'VALENCIA' }, mockSupabaseClient);
    assert.equal(valenciaRegion.regionCode, 'CENTRO');
    assert.equal(valenciaRegion.regionId, CENTRO_UUID);
  });

  await t.test('carga inicial paginada aislada por región (OCCIDENTE no mezcla CENTRO)', async () => {
    const page1 = await fetchAuditLogsPage(
      { regionId: OCCIDENTE_UUID, limit: 1, offset: 0 },
      mockSupabaseClient
    );
    assert.equal(page1.items.length, 1);
    assert.equal(page1.totalCount, 2);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.items[0]!.action, 'EVENTO_OCCIDENTE_2');

    const page2 = await fetchAuditLogsPage(
      { regionId: OCCIDENTE_UUID, limit: 1, offset: page1.nextOffset },
      mockSupabaseClient
    );
    assert.equal(page2.items.length, 1);
    assert.equal(page2.hasMore, false);
    assert.equal(page2.items[0]!.action, 'EVENTO_OCCIDENTE_1');

    const alertsPage = await fetchDiscrepancyAlertsPage(
      { regionId: OCCIDENTE_UUID, limit: 10, offset: 0 },
      mockSupabaseClient
    );
    assert.equal(alertsPage.items.length, 1);
    assert.equal(alertsPage.items[0]!.resolved, false);
  });

  await t.test('escritura persistente y rollback exacto ante error BD/RLS en auditLogs y discrepancyAlerts', async () => {
    let logsState: AuditLogEntry[] = [];
    const errorsLogged: string[] = [];

    // 1) Éxito persistente en audit_logs
    const okLog = await executeOptimisticAppendWithRollback<AuditLogEntry>({
      tempItem: {
        id: 'temp-log-1',
        timestamp: new Date().toISOString(),
        entityType: 'REQUISITION',
        entityId: 'REQ-777',
        action: 'APROBACION_PERSISTENTE',
        userId: '11111111-1111-4111-8111-111111111111',
        userName: 'Ana Zulia',
        userRole: 'jefe_trade',
        ipAddress: '',
        integrityHash: '',
      },
      updateState: (updater) => {
        logsState = updater(logsState);
      },
      persist: () =>
        persistAuditLogEntry(
          {
            entityType: 'REQUISITION',
            entityId: 'REQ-777',
            action: 'APROBACION_PERSISTENTE',
            actorId: '11111111-1111-4111-8111-111111111111',
            actorName: 'Ana Zulia',
            actorRole: 'jefe_trade',
            regionId: OCCIDENTE_UUID,
            regionCode: 'OCCIDENTE',
          },
          mockSupabaseClient
        ),
    });
    assert.equal(okLog.ok, true);
    assert.equal(logsState.length, 1);
    assert.notEqual(logsState[0]!.id, 'temp-log-1', 'Debe reemplazar tempId por el UUID real de BD');
    assert.match(logsState[0]!.integrityHash, /^sha256:[0-9a-f]{64}$/);

    // 2) Rollback seguro si falla INSERT en audit_logs (RLS 42501)
    failNextInsertOnTable = 'audit_logs';
    const failLog = await executeOptimisticAppendWithRollback<AuditLogEntry>({
      tempItem: {
        id: 'temp-log-fail',
        timestamp: new Date().toISOString(),
        entityType: 'EXPENSE',
        entityId: 'FAC-BAD',
        action: 'FALLO_RLS',
        userId: '11111111-1111-4111-8111-111111111111',
        userName: 'Ana Zulia',
        userRole: 'jefe_trade',
        ipAddress: '',
        integrityHash: '',
      },
      updateState: (updater) => {
        logsState = updater(logsState);
      },
      persist: () =>
        persistAuditLogEntry(
          {
            entityType: 'EXPENSE',
            entityId: 'FAC-BAD',
            action: 'FALLO_RLS',
            actorRole: 'jefe_trade',
            regionId: OCCIDENTE_UUID,
          },
          mockSupabaseClient
        ),
      onError: (msg) => errorsLogged.push(msg),
    });
    assert.equal(failLog.ok, false);
    assert.equal(logsState.length, 1, 'El rollback debe remover la entrada temporal fallida sin tocar las válidas');
    assert.equal(logsState.some((l) => l.id === 'temp-log-fail'), false);
    assert.equal(errorsLogged.length, 1);
    assert.match(errorsLogged[0]!, /RLS denied insert/i);

    // 3) Creación + resolución persistente + rollback en discrepancy_alerts
    let alertsState: DiscrepancyAlert[] = [];
    const createdAlertRes = await executeOptimisticAppendWithRollback<DiscrepancyAlert>({
      tempItem: {
        id: 'temp-alert-1',
        severity: 'CRITICA',
        title: 'Duplicado Test',
        description: 'Factura duplicada',
        entityCode: 'FAC-555',
        timestamp: new Date().toISOString(),
        detectedByRule: 'RULE_ANTIFRAUD_DUPLICATE_INVOICE',
        resolved: false,
      },
      updateState: (updater) => {
        alertsState = updater(alertsState);
      },
      persist: () =>
        persistDiscrepancyAlert(
          {
            severity: 'CRITICA',
            title: 'Duplicado Test',
            description: 'Factura duplicada',
            entityCode: 'FAC-555',
            detectedByRule: 'RULE_ANTIFRAUD_DUPLICATE_INVOICE',
            regionId: OCCIDENTE_UUID,
            regionCode: 'OCCIDENTE',
          },
          mockSupabaseClient
        ),
    });
    assert.equal(createdAlertRes.ok, true);
    assert.equal(alertsState.length, 1);
    const persistedAlertId = alertsState[0]!.id;

    // Rollback en resolución si falla UPDATE (RLS)
    failNextUpdateOnTable = 'discrepancy_alerts';
    const failResolve = await executeOptimisticUpdateWithRollback<DiscrepancyAlert>({
      targetId: persistedAlertId,
      optimisticUpdate: (curr) => ({ ...curr, resolved: true, resolutionNotes: 'Intento fallido' }),
      updateState: (updater) => {
        alertsState = updater(alertsState);
      },
      persist: () =>
        resolveDiscrepancyAlertInSupabase(
          {
            alertId: persistedAlertId,
            resolutionNotes: 'Intento fallido',
            resolvedBy: '11111111-1111-4111-8111-111111111111',
          },
          mockSupabaseClient
        ),
    });
    assert.equal(failResolve.ok, false);
    assert.equal(alertsState[0]!.resolved, false, 'Rollback debe restaurar resolved=false al fallar UPDATE');

    // Resolución exitosa
    const okResolve = await executeOptimisticUpdateWithRollback<DiscrepancyAlert>({
      targetId: persistedAlertId,
      optimisticUpdate: (curr) => ({ ...curr, resolved: true, resolutionNotes: 'Validado en auditoría' }),
      updateState: (updater) => {
        alertsState = updater(alertsState);
      },
      persist: () =>
        resolveDiscrepancyAlertInSupabase(
          {
            alertId: persistedAlertId,
            resolutionNotes: 'Validado en auditoría',
            resolvedBy: '11111111-1111-4111-8111-111111111111',
          },
          mockSupabaseClient
        ),
    });
    assert.equal(okResolve.ok, true);
    assert.equal(alertsState[0]!.resolved, true);
    assert.equal(alertsState[0]!.resolutionNotes, 'Validado en auditoría');
  });
});

// =============================================================================
// 5. RETIRO COMPLETO DE `xlsx@0.18.5` (SEGURIDAD DE DEPENDENCIAS)
// =============================================================================
test('Fase 3 · Retiro seguro de xlsx@0.18.5 en package.json, package-lock.json, src/ y scripts/', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.xlsx, undefined, 'xlsx no debe existir en dependencies');
  assert.equal(pkg.devDependencies?.xlsx, undefined, 'xlsx no debe existir en devDependencies');

  const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8')) as {
    packages?: Record<string, unknown>;
  };
  assert.equal(
    lock.packages?.['node_modules/xlsx'],
    undefined,
    'package-lock.json no debe contener node_modules/xlsx'
  );

  const dirsToScan = ['src', 'scripts'];
  const importRegex = /from\s+['"]xlsx['"]|import\s*\(\s*['"]xlsx['"]\s*\)|require\s*\(\s*['"]xlsx['"]\s*\)/;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        assert.equal(
          importRegex.test(content),
          false,
          `${full} aún contiene una importación directa del paquete inseguro "xlsx"`
        );
      }
    }
  };
  for (const d of dirsToScan) {
    walk(path.resolve(d));
  }
});
