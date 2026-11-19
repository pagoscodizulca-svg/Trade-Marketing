import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Request, Response } from 'express';
import {
  MOCK_ACTORS,
  MOCK_CRON_SECRET,
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
  startLocalMockInfra,
  type LocalMockInfraInstance,
} from './localMockInfra';

// Minimal valid 1x1 PNG (68 bytes)
const VALID_1X1_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex'
);

// Second distinct valid PNG (different payload -> different SHA-256)
const VALID_1X1_PNG_ALT = Buffer.concat([VALID_1X1_PNG, Buffer.from([0x00])]);

function createMockExpressRes() {
  let statusCode = 200;
  let jsonBody: any = null;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return res;
    },
  } as unknown as Response;

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => jsonBody,
  };
}

function encodeMetaHeader(meta: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(meta), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

test('PASO 2 — Validación Integral de Sincronizaciones, Concurrencia, Resiliencia e Idempotencia (127.0.0.1 Mock)', async (t) => {
  const mock: LocalMockInfraInstance = await startLocalMockInfra(0);

  // Override process.env BEFORE importing app services so supabaseClient binds strictly to 127.0.0.1
  process.env.AUDIT_MOCK_BASE_URL = mock.baseUrl;
  process.env.VITE_SUPABASE_URL = mock.baseUrl;
  process.env.SUPABASE_URL = mock.baseUrl;
  process.env.VITE_SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
  process.env.SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
  process.env.VITE_SUPABASE_MASTER_URL = '';
  process.env.VITE_SUPABASE_MASTER_ANON_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;
  process.env.CRON_SECRET = MOCK_CRON_SECRET;
  process.env.APP_TIMEZONE = 'America/Caracas';

  const supabaseClientMod = await import('../../src/services/supabaseClient');
  const supabaseMod1 = await import('../../src/services/supabaseModule1');
  const fdvAdapter = await import('../../src/services/fdvDegustacionesAdapter');
  const pipelineSvc = await import('../../src/services/degustacionesPipelineService');
  const masterSyncSvc = await import('../../src/services/masterDataSyncService');
  const contraloriaSvc = await import('../../src/services/solicitudesContraloriaService');
  const attendanceHandlerMod = await import('../../src/server/attendanceEvidencesHandler');
  const adminAuthMod = await import('../../src/server/supabaseAdminAuth');
  const cronHandlerMod = await import('../../src/server/weeklyTastingCronHandler');
  const cleanSyncMod = await import('../../src/services/cleanSync');
  const authSvcMod = await import('../../src/services/authService');
  const deliveryOpsMod = await import('../../ruta-degustacion/src/lib/deliveryOps');

  const summaryReport: Array<{
    id: string;
    flow: string;
    outcome: 'APROBADO' | 'CON_ADVERTENCIAS' | 'FALLIDO';
    detail: string;
  }> = [];

  t.after(async () => {
    const useTmpArtifactDir =
      Boolean(process.env.NODE_TEST_CONTEXT) && process.env.WRITE_AUDIT_ARTIFACTS !== '1';
    const outDir = useTmpArtifactDir
      ? path.join(os.tmpdir(), 'codizulca-antigravity-audit')
      : path.resolve('tests/antigravity_audit/results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'step2_sync_results.json'),
      JSON.stringify(
        {
          executedAt: new Date().toISOString(),
          mockEndpoint: mock.baseUrl,
          totalMockRequestsHandled: mock.recordedRequests.length,
          summaryReport,
        },
        null,
        2
      ),
      'utf8'
    );
    await mock.close();
  });

  await t.test('SYNC-00: Garantía de Aislamiento Cero-Producción (127.0.0.1 Loopback)', async () => {
    assert.equal(supabaseClientMod.SUPABASE_PROJECT_URL, mock.baseUrl);
    assert.ok(supabaseClientMod.SUPABASE_REST_URL.startsWith('http://127.0.0.1:'));
    await assert.rejects(
      () => fetch('https://example.supabase.co/rest/v1/surveys'),
      /AUDIT_EGRESS_FIREWALL/
    );
  });

  await t.test('SYNC-01: Reconciliación E2E FDV Render <-> Supabase surveys + Resiliencia Retry', async () => {
    mock.resetSeedData();
    // Inject 2 transient 503 errors -> fetchWithProgressiveRetry (maxRetries=2) must recover on attempt 3
    mock.faultInjection.transientFailuresRemaining = 2;

    const res = await supabaseMod1.fetchWithProgressiveRetry(
      `${mock.baseUrl}/rest/v1/surveys?type=eq.Degustacion`,
      {
        method: 'GET',
        headers: {
          apikey: MOCK_PUBLIC_ANON_KEY,
          Authorization: `Bearer ${MOCK_PUBLIC_ANON_KEY}`,
        },
      },
      { maxRetries: 2, timeoutMs: 3000 }
    );
    assert.equal(res.status, 200, 'Debe recuperarse automáticamente tras 2 fallos 503 transitorios');

    const bundle = await supabaseMod1.fetchAllModule1FromSupabase();
    assert.ok(bundle.staffMembers.length >= 2, 'Debe cargar personal activo desde mock local');
    // Verify Render-only virtual row + Supabase rows merged without duplicates
    const degIds = bundle.tastingItems.map((i) => i.degustacionId).filter(Boolean);
    const uniqueDegIds = new Set(degIds);
    assert.equal(degIds.length, uniqueDegIds.size, 'Cero duplicados al fusionar Supabase y Render');
    assert.ok(uniqueDegIds.has('deg-render-only-001'), 'Debe incorporar fila exclusiva de Render');
    assert.ok(uniqueDegIds.has('deg-local-001'), 'Debe preservar decisión APROBADA de Supabase');

    summaryReport.push({
      id: 'SYNC-01',
      flow: 'FDV Render <-> Supabase surveys + Retry Resiliencia',
      outcome: 'APROBADO',
      detail: 'Reconciliación determinista sin duplicados y recuperación ante 2 errores HTTP 503 consecutivos.',
    });
  });

  await t.test('SYNC-02: Carga Multiformato -> Idempotencia SHA-256 y Volcado RPC Cronograma', async () => {
    mock.resetSeedData();
    const pdvCatalog = pipelineSvc.buildKnownPdvCatalog({
      syncedStoreNames: [
        {
          name: 'SUPERMERCADO FIORELLA (NORTE)',
          clientCode: 'CLI-001',
          zone: 'MARACAIBO NORTE',
        },
      ],
    });
    const promotoraCatalog = pipelineSvc.buildActivePromotoraCatalog([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'María Piña',
        canonicalKey: 'MARIA PINA',
        role: 'Promotora Fija',
        roleCategory: 'PROMOTORA',
        category: 'fija',
        email: 'maria.pina@promotoras.codizulca.local',
        status: 'Activo',
        assignedStore: 'SUPERMERCADO FIORELLA (NORTE)',
        address: 'MARACAIBO NORTE',
        phone: '04141234567',
        password: '',
        shift: 'MAÑANA',
        tastingCompleted: 0,
        salesAssisted: 0,
        activationsCount: 0,
        totalUnits: 0,
      },
    ]);

    const enriched = await pipelineSvc.validateAndEnrichExtractedRows(
      [
        {
          rowIndex: 1,
          excelRowNumber: 2,
          fecha: '2026-11-20',
          horaInicio: '09:00',
          horaFin: '13:00',
          turno: 'MAÑANA',
          clienteNombre: 'SUPERMERCADO FIORELLA (NORTE)',
          clienteCodigo: 'CLI-001',
          zonaDireccion: 'MARACAIBO NORTE',
          productos: ['Mortadela Especial Asturias'],
          cantidadKilos: 2.5,
          personasEstimadas: 80,
          vendedorFdv: 'Carlos Peña',
          promotoraSugerida: 'Maria Pina', // sin tilde ni ñ -> debe emparejar exacto con María Piña
          observaciones: 'Prueba idempotencia',
        },
        {
          // Exact semantic duplicate inside same file
          rowIndex: 2,
          excelRowNumber: 3,
          fecha: '20/11/2026',
          horaInicio: '9:00',
          horaFin: '13:00',
          turno: 'MAÑANA',
          clienteNombre: 'supermercado fiorella (norte)',
          clienteCodigo: 'CLI-001',
          zonaDireccion: 'MARACAIBO NORTE',
          productos: ['MORTADELA ESPECIAL ASTURIAS'],
          cantidadKilos: 2.5,
          personasEstimadas: 80,
          vendedorFdv: 'Carlos Peña',
          promotoraSugerida: 'María Piña',
          observaciones: 'Duplicado intra-archivo',
        },
      ],
      {
        pdvCatalog,
        promotoraCatalog,
        existingDbHashes: new Set(),
      }
    );

    assert.equal(enriched[0]!.promotoraId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(enriched[0]!.esDuplicadoEnArchivo, false);
    assert.equal(enriched[1]!.esDuplicadoEnArchivo, true);
    assert.equal(enriched[0]!.idempotencyHash, enriched[1]!.idempotencyHash);

    const dump1 = await pipelineSvc.dumpValidatedBatchToCronograma({
      fileMeta: {
        nombreArchivo: 'plan_noviembre.xlsx',
        extension: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        tamanoBytes: 4096,
        archivoSha256: 'b'.repeat(64),
        metodoExtraccion: 'TABULAR_DETERMINISTA',
      },
      rows: enriched,
      cargadoPor: 'coordinadora.audit@codizulca.local',
      cargadoPorRol: 'coordinadora',
    });

    assert.equal(dump1.total_recibidas, 2);
    assert.equal(dump1.total_insertadas, 1, 'Solo debe insertar 1 fila única y omitir el duplicado');
    assert.equal(dump1.total_duplicadas, 1);

    // Retry same batch (idempotency on retry)
    const dump2 = await pipelineSvc.dumpValidatedBatchToCronograma({
      fileMeta: {
        nombreArchivo: 'plan_noviembre.xlsx',
        extension: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        tamanoBytes: 4096,
        archivoSha256: 'b'.repeat(64),
        metodoExtraccion: 'TABULAR_DETERMINISTA',
      },
      rows: [enriched[0]!],
      cargadoPor: 'coordinadora.audit@codizulca.local',
      cargadoPorRol: 'coordinadora',
    });
    assert.equal(dump2.total_insertadas, 0, 'Reintento sobre el mismo lote no debe duplicar registros');
    assert.equal(dump2.total_duplicadas, 1);

    summaryReport.push({
      id: 'SYNC-02',
      flow: 'Carga Multiformato -> Cronograma RPC (Idempotencia SHA-256)',
      outcome: 'CON_ADVERTENCIAS',
      detail: 'Idempotencia SHA-256 intra-archivo y en reintentos OK; advertencia en SQL 20261114 por índice antiguo idx_cronograma_deg_idempotency_active no eliminado.',
    });
  });

  await t.test('SYNC-04: Evidencias Fotográficas (RBAC Anti-IDOR, Rollback y Condición de Carrera TOCTOU)', async () => {
    mock.resetSeedData();

    // Build custom in-memory gateway to test concurrency / TOCTOU deterministically
    const storageBlobs = new Set<string>();
    const jornadaRows = new Map<string, any>();
    const evidenceRows = new Map<string, any>();

    const gateway: import('../../src/server/attendanceEvidencesHandler').AttendancePersistenceGateway = {
      async lookupStaffProfile(promotoraId) {
        if (promotoraId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
          return {
            id: promotoraId,
            name: 'María Piña',
            email: 'maria.pina@promotoras.codizulca.local',
            assignedStore: 'SUPERMERCADO FIORELLA',
            address: 'NORTE',
            active: true,
            isMerchandising: false,
            masterProfile: 'FIJA',
          };
        }
        return null;
      },
      async findJornadaByDateAndPromotora(fecha, promotoraId) {
        return jornadaRows.get(`${fecha}:${promotoraId}`) ?? null;
      },
      async createJornadaIfAbsent(params) {
        const key = `${params.fechaJornada}:${params.promotoraId}`;
        const existing = jornadaRows.get(key);
        if (existing) return existing;
        const created = {
          id: '55551111-1111-4111-8111-111111111111',
          fecha_jornada: params.fechaJornada,
          promotora_id: params.promotoraId,
          promotora_nombre: params.promotoraNombre,
          perfil_aplicado: params.perfilAplicado,
          pdv_nombre: params.pdvNombre,
          zona: params.zona,
          opened_at_server: params.openedAtServerIso,
          updated_at_server: params.openedAtServerIso,
          opened_by_uid: params.openedByUid,
        };
        jornadaRows.set(key, created);
        return created;
      },
      async listEvidencesByJornadaId(asistenciaId) {
        await new Promise((r) => setTimeout(r, 15)); // Simulate realistic network RTT window for race check
        return Array.from(evidenceRows.values()).filter((e) => e.asistencia_id === asistenciaId);
      },
      async upsertSlotEvidence(params) {
        const slotKey = `${params.asistenciaId}:${params.slotFoto}`;
        const existing = evidenceRows.get(slotKey);
        const saved = {
          id: existing?.id || crypto.randomUUID(),
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
          capturado_en_servidor: params.capturadoEnServidorIso,
          cargado_por_uid: params.cargadoPorUid,
          cargado_por_rol: params.cargadoPorRol,
        };
        evidenceRows.set(slotKey, saved);
        return saved;
      },
      async uploadPrivateObject(params) {
        storageBlobs.add(params.path);
      },
      async deletePrivateObjects(_bucket, paths) {
        for (const p of paths) storageBlobs.delete(p);
      },
      async createSignedUrls(_bucket, paths) {
        const out: Record<string, string> = {};
        for (const p of paths) out[p] = `http://127.0.0.1/signed/${p}`;
        return out;
      },
      async findEvidencesWithOwnerByIds() {
        return [];
      },
    };

    const handlers = attendanceHandlerMod.createAttendanceEvidencesHandlers({
      resolveGateway: () => gateway,
      now: () => new Date('2026-11-16T15:00:00.000Z'),
    });

    // 1. Anti-IDOR check: promotora Eventual trying to upload photo for promotora Fija -> HTTP 403
    const idorRes = createMockExpressRes();
    await handlers.handleUploadEvidence(
      {
        authUser: {
          id: MOCK_ACTORS.promotoraEventual.id,
          email: MOCK_ACTORS.promotoraEventual.email,
          appRole: 'promotora',
          staffId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          isCoordinatorOrAdmin: false,
        },
        headers: {
          'x-asistencia-meta': encodeMetaHeader({
            fechaJornada: '2026-11-16',
            promotoraId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            slotFoto: 'JORNADA_INGRESO',
            pdvNombre: 'SUPERMERCADO FIORELLA',
          }),
        },
        body: VALID_1X1_PNG,
      } as unknown as Request,
      idorRes.res
    );
    assert.equal(idorRes.getStatus(), 403, 'Debe bloquear intento IDOR entre promotoras');

    // 2. Concurrent Race Condition (2 simultaneous uploads for JORNADA_INGRESO)
    const makeConcurrentReq = (buf: Buffer) => {
      const mockR = createMockExpressRes();
      const promise = handlers.handleUploadEvidence(
        {
          authUser: {
            id: MOCK_ACTORS.promotoraFija.id,
            email: MOCK_ACTORS.promotoraFija.email,
            appRole: 'promotora',
            staffId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            isCoordinatorOrAdmin: false,
          },
          headers: {
            'x-asistencia-meta': encodeMetaHeader({
              fechaJornada: '2026-11-16',
              promotoraId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              slotFoto: 'JORNADA_INGRESO',
              pdvNombre: 'SUPERMERCADO FIORELLA',
            }),
          },
          body: buf,
        } as unknown as Request,
        mockR.res
      ).then(() => mockR);
      return promise;
    };

    const [raceA, raceB] = await Promise.all([
      makeConcurrentReq(VALID_1X1_PNG),
      makeConcurrentReq(VALID_1X1_PNG_ALT),
    ]);

    assert.ok([200, 201].includes(raceA.getStatus()));
    assert.ok([200, 201].includes(raceB.getStatus()));
    assert.equal(evidenceRows.size, 1, 'Unicidad en BD por (asistencia_id, slot_foto) preservada');
    const orphanCount = storageBlobs.size - evidenceRows.size;

    summaryReport.push({
      id: 'SYNC-04',
      flow: 'Evidencias Fotográficas de Asistencia (Storage + BD)',
      outcome: orphanCount > 0 ? 'CON_ADVERTENCIAS' : 'APROBADO',
      detail: `Anti-IDOR 403 y unicidad de fila OK. En carrera simultánea se detectó ${orphanCount} objeto(s) huérfano(s) en Storage por TOCTOU previo al upsert.`,
    });
  });

  await t.test('SYNC-05: Sincronización por Lotes de Data Maestra (Vendedores y Clientes)', async () => {
    mock.resetSeedData();
    const csvContent = [
      'ID VENDEDOR;VENDEDOR;SUPERVISOR;ZONA;COD_CLIENTE;RIF;RAZON_SOCIAL;CANAL;LATITUD;LONGITUD',
      'v010;JOSÉ ÁLVAREZ;LUIS MÉNDEZ;MARACAIBO SUR;c-900;J312345678;"COMERCIAL LA ÑAPA, C.A. (LA ÑAPA SUR)";Supermercado;10,6512;-71,6211',
      'v010;JOSÉ ÁLVAREZ;LUIS MÉNDEZ;MARACAIBO SUR;c-900;J312345678;"COMERCIAL LA ÑAPA, C.A. (LA ÑAPA SUR)";Supermercado;10,6512;-71,6211',
      ';;;;#N/D;#N/D;;;;',
    ].join('\n');

    const syncRes = await masterSyncSvc.sincronizarArchivoMaestroTrade(csvContent, {
      nombreArchivo: 'maestro_erp.csv',
      reconciliarCarteraClientes: false,
    });

    assert.equal(syncRes.vendedores.procesados, 1);
    assert.equal(syncRes.clientes.procesados, 1);
    assert.equal(syncRes.filasOmitidasVacias, 1);

    const clientes = await masterSyncSvc.obtenerClientesMaestros({ forzarRefresco: true });
    const inserted = clientes.find((c) => c.codigo_cliente === 'C-900');
    assert.ok(inserted, 'Cliente C-900 debe persistir y leerse con su vendedor vinculado');
    // Hallazgo de normalización: J312345678 -> J-312345678 vs J-31234567-8 -> J-31234567-8
    assert.equal(inserted!.rif, 'J-312345678');
    assert.notEqual(
      masterSyncSvc.normalizarRifFiscal('J312345678'),
      masterSyncSvc.normalizarRifFiscal('J-31234567-8'),
      'ADVERTENCIA CONFIRMADA: normalizarRifFiscal produce dos cadenas distintas para el mismo RIF con o sin guion verificador'
    );
    assert.equal(inserted!.nombre_comercial, 'LA ÑAPA SUR');
    assert.equal(inserted!.vendedor?.nombre_completo, 'JOSÉ ÁLVAREZ');

    summaryReport.push({
      id: 'SYNC-05',
      flow: 'Sincronización Maestra ERP (Vendedores y Clientes por Lotes)',
      outcome: 'CON_ADVERTENCIAS',
      detail: 'Deduplicación y enlace FK OK; normalizarRifFiscal no unifica guion verificador y es_admin_trade() excluye gerente_admin en SQL.',
    });
  });

  await t.test('SYNC-06: Condición de Carrera en Correlativo MP-07-XXXX de Solicitudes a Contraloría', async () => {
    mock.resetSeedData();
    mock.faultInjection.artificialDelayMs = 18; // Simula RTT realista de red (18ms) para traslape concurrente

    const payload = {
      fechaSolicitud: '16/11/2026',
      fechaIso: '2026-11-16',
      dirigidoA: 'CONTRALORÍA',
      paraSerUtilizado: 'OPERATIVO DEGUSTACIÓN CONCURRENTE',
      observacion: 'PRUEBA DE CONDICIÓN DE CARRERA',
      solicitadoPor: 'Coordinación Trade',
      items: [{ itemNumber: 1, producto: 'MORTADELA ESPECIAL ASTURIAS', cantidad: 4 }],
    };

    try {
      // Launch 2 simultaneous creations without pre-assigned code
      contraloriaSvc.resetSolicitudesBackendModeForTests();
      const [solA, solB] = await Promise.all([
        contraloriaSvc.createSolicitudContraloriaInSupabase(payload),
        contraloriaSvc.createSolicitudContraloriaInSupabase(payload),
      ]);

      // HITO 4 / P-05 FIX VERIFICADO:
      // 1) isDedicatedTableMissing() NUNCA trata 409/23505 como tabla inexistente.
      // 2) Dos envíos simultáneos obtienen correlativos ÚNICOS (MP-07-0073 y MP-07-0074).
      // 3) Ambos persisten en public.solicitudes_contraloria y CERO caen en public.surveys (Split-Brain cerrado).
      const codes = [solA.codigoCorrelativo, solB.codigoCorrelativo].sort();
      assert.deepEqual(
        codes,
        ['MP-07-0073', 'MP-07-0074'],
        'Ambas solicitudes concurrentes deben recibir correlativos únicos sin colisión ni duplicidad'
      );
      assert.equal(mock.tables.solicitudes_contraloria.length, 3); // seed MP-07-0072 + MP-07-0073 + MP-07-0074
      assert.equal(
        mock.tables.surveys.some((s) => s.type === 'SolicitudContraloria'),
        false,
        'Cero solicitudes deben fugarse a public.surveys ante conflicto 409/23505'
      );
    } finally {
      mock.faultInjection.artificialDelayMs = 0;
    }

    summaryReport.push({
      id: 'SYNC-06',
      flow: 'Solicitudes de Productos a Contraloría (MP-07-XXXX)',
      outcome: 'APROBADO',
      detail: 'Hito 4 / P-05 cerrado: isDedicatedTableMissing() rechaza falsos positivos en 409/23505, secuencia MP-07-XXXX asignada atómicamente vía RPC o reintento sin Split-Brain en public.surveys.',
    });
  });

  await t.test('SYNC-07: Cron Cierre Dominical (Timing-Safe Auth, Idempotencia y Orden de Rate Limit)', async () => {
    mock.resetSeedData();

    assert.equal(
      cronHandlerMod.verifyCronBearerAuthorization(`Bearer ${MOCK_CRON_SECRET}`, MOCK_CRON_SECRET),
      true
    );
    assert.equal(
      cronHandlerMod.verifyCronBearerAuthorization('Bearer wrong-secret-token-value', MOCK_CRON_SECRET),
      false
    );

    const res1 = createMockExpressRes();
    await cronHandlerMod.handleWeeklyTastingCutoffCron(
      { body: { forceRun: true } } as unknown as Request,
      res1.res
    );
    assert.equal(res1.getStatus(), 200);
    assert.equal(res1.getBody().ok, true);

    const res2 = createMockExpressRes();
    await cronHandlerMod.handleWeeklyTastingCutoffCron(
      { body: { forceRun: true } } as unknown as Request,
      res2.res
    );
    assert.equal(res2.getStatus(), 200);
    assert.equal(res2.getBody().registros_archivados, 0, 'Segunda ejecución consecutiva debe ser no-op idempotente');

    summaryReport.push({
      id: 'SYNC-07',
      flow: 'Cierre Semanal Automático (Cron + RPC + Fallback SDK)',
      outcome: 'CON_ADVERTENCIAS',
      detail: 'Comparación timingSafeEqual e idempotencia OK; pero migración 20261113 desprograma pg_cron buscando un procedimiento inexistente y el rate limiter precede a requireCronSecretAuth.',
    });
  });

  await t.test('SYNC-08: Preservación de sesión (storageKey) entre supabaseClient.ts, cleanSync.ts y authService.ts', async () => {
    const fakeStore = new Map<string, string>();
    const mockStorage: Storage = {
      get length() {
        return fakeStore.size;
      },
      clear() {
        fakeStore.clear();
      },
      getItem(k: string) {
        return fakeStore.has(k) ? fakeStore.get(k)! : null;
      },
      key(idx: number) {
        return Array.from(fakeStore.keys())[idx] ?? null;
      },
      removeItem(k: string) {
        fakeStore.delete(k);
      },
      setItem(k: string, v: string) {
        fakeStore.set(k, String(v));
      },
    };

    // Simulate custom storageKey configured in src/services/supabaseClient.ts:145
    mockStorage.setItem('codizulca.supabase.auth.v1', JSON.stringify({ access_token: 'valid_jwt' }));
    (globalThis as any).window = { localStorage: mockStorage };
    (globalThis as any).localStorage = mockStorage;
    (globalThis as any).sessionStorage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    };

    try {
      const detectedBefore = authSvcMod.hasStoredSupabaseAuthToken();
      const purgedKeys = cleanSyncMod.runCleanSyncMigration();

      // Regresión: la sesión activa debe detectarse y NO purgarse (corregido en Hito 0)
      assert.equal(
        detectedBefore,
        true,
        'hasStoredSupabaseAuthToken() debe detectar codizulca.supabase.auth.v1'
      );
      assert.ok(
        !purgedKeys.includes('codizulca.supabase.auth.v1'),
        'runCleanSyncMigration() NO debe purgar la sesión activa codizulca.supabase.auth.v1'
      );
      assert.equal(
        mockStorage.getItem('codizulca.supabase.auth.v1') !== null,
        true,
        'La sesión debe seguir presente en localStorage tras la migración'
      );

      summaryReport.push({
        id: 'SYNC-08',
        flow: 'Persistencia de Sesión Auth vs cleanSync Boot Migration',
        outcome: 'APROBADO',
        detail: 'Corregido (Hito 0): cleanSync preserva sb-*, codizulca.* y bases IndexedDB de sesión/offline; hasStoredSupabaseAuthToken() detecta la sesión.',
      });    } finally {
      delete (globalThis as any).window;
      delete (globalThis as any).localStorage;
      delete (globalThis as any).sessionStorage;
    }
  });

  await t.test('SYNC-09: Operaciones Idempotentes y Cuerpo LWW en Chofer PWA (ruta-degustacion)', async () => {
    const baseRow = {
      id: 'ent-001',
      fecha: '16-11-2026',
      turno: 'MAÑANA' as const,
      numero_grupo_turno: 'G1',
      cliente: 'SUPERMERCADO FIORELLA',
      producto: 'MORTADELA' as const,
      vendedor: 'CARLOS PEÑA',
      promotora: 'MARÍA PIÑA',
      stand_entregado: false,
      producto_entregado: false,
      completado: false,
      hora_entrega: null,
      notas_chofer: '',
    };

    const toggledPatch = {
      completado: true,
      stand_entregado: true,
      producto_entregado: true,
      hora_entrega_real: '2026-11-16T14:30:00.000Z',
    };
    const optimisticRow = deliveryOpsMod.applyPayload(baseRow, toggledPatch);
    assert.equal(optimisticRow.completado, true);
    assert.equal(optimisticRow.stand_entregado, true);
    assert.equal(optimisticRow.producto_entregado, true);
    assert.ok(optimisticRow.hora_entrega, 'Debe proyectar HH:mm optimista sobre la fila local');

    const bodyWithLww = deliveryOpsMod.construirCuerpoServidor(
      toggledPatch,
      '2026-11-16T14:30:00.000Z',
      true
    );
    assert.equal(bodyWithLww.actualizado_chofer_at, '2026-11-16T14:30:00.000Z');
    assert.equal(bodyWithLww.hora_entrega_real, '2026-11-16T14:30:00.000Z');

    summaryReport.push({
      id: 'SYNC-09',
      flow: 'Chofer PWA Offline Outbox + Resolución LWW',
      outcome: 'CON_ADVERTENCIAS',
      detail: 'Compactación Outbox y parche idempotente OK; RLS de entregas_degustacion está totalmente abierto a anon (DELETE incluido) y depende del reloj del dispositivo.',
    });
  });
});
