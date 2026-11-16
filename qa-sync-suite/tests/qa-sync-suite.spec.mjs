import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import {
  loadPublicQaEnv,
  redactSensitive,
  REPORTS_DIR_PATH,
  TMP_DIR_PATH,
} from '../scripts/lib/env.mjs';
import { recordLedgerEntry } from '../scripts/lib/ledger.mjs';
import {
  checkRenderHealthWithBackoff,
  createRequestPacer,
  sleepMs,
} from '../scripts/lib/rateLimiter.mjs';
import { seedQaEnvironment } from '../scripts/seed-qa-environment.mjs';
import { teardownQaEnvironment } from '../scripts/teardown-qa-environment.mjs';
import { verifyZeroResidue } from '../scripts/verify-zero-residue.mjs';

/**
 * Crea un cliente Supabase aislado en memoria usando EXCLUSIVAMENTE `SUPABASE_ANON_KEY`.
 */
function createIsolatedAnonClient(publicEnv) {
  return createClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
}

async function signInActorWithPassword(publicEnv, actor) {
  const client = createIsolatedAnonClient(publicEnv);
  const { data, error } = await client.auth.signInWithPassword({
    email: actor.email.trim().toLowerCase(),
    password: actor.password,
  });
  if (error || !data?.session?.access_token) {
    throw new Error(
      `Fallo iniciando sesión real (${actor.email}): ${redactSensitive(
        error?.message || 'sin token'
      )}`
    );
  }
  client.realtime.setAuth(data.session.access_token);
  return { client, user: data.user };
}

/**
 * Replica con exactitud el contrato `syncToGerenciaDashboard` de la App de Vendedores
 * (`dashboard-fdv---planificador/src/services/degustacionesService.ts:312-497`),
 * autenticado con el cliente `SUPABASE_ANON_KEY` del vendedor (`qa_vendedor`)
 * y SIN disparar webhooks externos a Google Sheets ni escrituras a Firestore productivo.
 */
async function submitVendorDegustacionToInbox({
  vendedorClient,
  runId,
  degustacionId,
  clienteCodigo,
  clienteNombre,
  vendedorId,
  vendedorNombre,
  ruta,
  fecha,
  turno = 'MAÑANA',
  hora = '09:00 AM - 01:00 PM',
  productos,
  kilosEstimados = 3.5,
  personasEstimadas = 80,
  observaciones,
  checkExistingFirst = true,
}) {
  const cleanId = String(degustacionId).trim().replace(/^DEG-/i, '');
  const isoCreatedAt = new Date().toISOString();
  const productCsv = productos.join(', ');

  let existingRow = null;
  if (checkExistingFirst && cleanId) {
    const { data: found } = await vendedorClient
      .from('surveys')
      .select('id, leido_trade, visto_en_trade_at, comments')
      .eq('type', 'Degustacion')
      .ilike('comments', `%${cleanId}%`)
      .limit(1);

    if (Array.isArray(found) && found[0]?.id) {
      existingRow = found[0];
    }
  }

  const commentsPayload = {
    isTasting: true,
    source: 'vendedor_app',
    degustacionId: cleanId,
    id: cleanId,
    client: clienteNombre,
    cliente: clienteNombre,
    clienteCodigo,
    store: clienteNombre,
    vendedor: vendedorNombre,
    salesRep: vendedorNombre,
    vendedorId,
    promoter: 'POR ASIGNAR (Trade Marketing)',
    promotoraAsignada: '',
    ruta,
    date: fecha,
    turno,
    shift: `${turno} (${hora})`,
    time: hora,
    products: productos,
    product: productCsv,
    kilos: kilosEstimados,
    kg: kilosEstimados,
    personas: personasEstimadas,
    personasEstimadas,
    estado: 'SOLICITADA',
    status: 'pendiente',
    leido_trade: false,
    visto_en_trade_at: null,
    created_at: isoCreatedAt,
    requierePromotora: true,
    promoterType: 'Fija',
    materialPop: 'SI',
    contactoPunto: `[QA-SYNC-TEST:${runId}] CONTACTO PDV`,
    telefonoContacto: '+584140001111',
    address: `Ruta: ${ruta} | Contacto: [QA-SYNC-TEST:${runId}] CONTACTO PDV`,
    notes: observaciones,
    originalComments: observaciones,
    observaciones,
    notasTradeMarketing: '',
    resultado: null,
  };

  const basePayload = {
    type: 'Degustacion',
    date: fecha,
    store: clienteNombre,
    promoter: vendedorNombre,
    product: productCsv,
    comments: JSON.stringify(commentsPayload),
    creatorId: vendedorNombre,
    ...(existingRow ? {} : { created_at: isoCreatedAt }),
  };

  const fullPayload = {
    ...basePayload,
    leido_trade: false,
    visto_en_trade_at: null,
  };

  let opResult;
  if (existingRow?.id) {
    opResult = await vendedorClient
      .from('surveys')
      .update(fullPayload)
      .eq('id', existingRow.id)
      .select('id, store, date, product, comments, leido_trade')
      .single();

    if (opResult.error && /leido_trade|visto_en_trade_at|PGRST204|42703/i.test(opResult.error.message)) {
      opResult = await vendedorClient
        .from('surveys')
        .update(basePayload)
        .eq('id', existingRow.id)
        .select('id, store, date, product, comments')
        .single();
    }
  } else {
    opResult = await vendedorClient
      .from('surveys')
      .insert(fullPayload)
      .select('id, store, date, product, comments, leido_trade')
      .single();

    if (opResult.error && /leido_trade|visto_en_trade_at|PGRST204|42703/i.test(opResult.error.message)) {
      opResult = await vendedorClient
        .from('surveys')
        .insert(basePayload)
        .select('id, store, date, product, comments')
        .single();
    }
  }

  if (opResult.error || !opResult.data?.id) {
    throw new Error(
      `Error enviando solicitud a Bandeja (public.surveys): ${redactSensitive(
        opResult.error?.message || 'sin ID retornado'
      )}`
    );
  }

  // Registro inmediato en bitácora ANTES del siguiente paso
  recordLedgerEntry({
    resource_type: 'db_row',
    schema: 'public',
    table_or_bucket: 'surveys',
    pk_column: 'id',
    id: opResult.data.id,
    run_id: runId,
    meta: { degustacionId: cleanId },
  });

  return {
    row: opResult.data,
    wasUpdate: Boolean(existingRow?.id),
  };
}

/**
 * Suscribe temporalmente un canal Realtime y resuelve con la latencia en ms al recibir el evento esperado.
 */
async function createRealtimeWaiter(client, channelName, pgFilter, predicate, timeoutMs = 6000) {
  let eventTriggerStartMs = Date.now();
  let resolved = false;
  let resolvePromise;
  const eventPromise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      resolvePromise({ received: false, latencyMs: null, payload: null });
    }
  }, timeoutMs);

  let subscribedResolve;
  const subscribedPromise = new Promise((resolve) => {
    subscribedResolve = resolve;
  });
  const subTimeout = setTimeout(() => subscribedResolve(false), 3500);

  const channel = client
    .channel(channelName)
    .on('postgres_changes', pgFilter, (payload) => {
      try {
        if (!resolved && predicate(payload)) {
          resolved = true;
          clearTimeout(timer);
          resolvePromise({
            received: true,
            latencyMs: Math.max(1, Date.now() - eventTriggerStartMs),
            payload,
          });
        }
      } catch {
        // Ignorar errores de predicado
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(subTimeout);
        subscribedResolve(true);
      }
    });

  const isSubscribed = await subscribedPromise;

  return {
    isSubscribed,
    markActionStart() {
      eventTriggerStartMs = Date.now();
    },
    async waitAndCleanup() {
      const res = await eventPromise;
      clearTimeout(timer);
      await client.removeChannel(channel).catch(() => {});
      return res;
    },
  };
}

// PNG válido mínimo de 1x1 píxel transparente (68 bytes) para probar Storage `asistencia-evidencias`
const TINY_VALID_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex'
);

test('Suite E2E Sincronización Multi-App y Seguridad RLS con Protocolo Cero-Residuos (TC-01 a TC-06)', async (t) => {
  const publicEnv = loadPublicQaEnv();
  const pacer = createRequestPacer(publicEnv.rateLimitRps);

  let seeded = null;
  const activeSessions = [];
  const resultsMatrix = [];
  const findings = [];
  let renderHealthReport = null;

  // Variables compartidas entre casos secuenciales
  let tc01SurveyId = null;
  let tc03CronogramaId = null;
  let tc03RutaId = null;

  try {
    // 0. Respeto a Render: Health-check HTTP único con backoff exponencial (hasta 60s)
    renderHealthReport = await checkRenderHealthWithBackoff(publicEnv.renderPlanificadorUrl, {
      maxTotalMs: 60_000,
    });

    // 1. Seed programático de usuarios efímeros y Cliente Prueba
    seeded = await seedQaEnvironment();

    // 2. Autenticación real con SUPABASE_ANON_KEY y usuario/contraseña en sesiones aisladas
    await pacer.pace();
    const { client: vendedorClient } = await signInActorWithPassword(
      publicEnv,
      seeded.users.qa_vendedor
    );
    activeSessions.push(vendedorClient);

    await pacer.pace();
    const { client: planificadorClient } = await signInActorWithPassword(
      publicEnv,
      seeded.users.qa_planificador
    );
    activeSessions.push(planificadorClient);

    await pacer.pace();
    const { client: promotoraAClient } = await signInActorWithPassword(
      publicEnv,
      seeded.users.qa_promotora_a
    );
    activeSessions.push(promotoraAClient);

    await pacer.pace();
    const { client: promotoraBClient } = await signInActorWithPassword(
      publicEnv,
      seeded.users.qa_promotora_b
    );
    activeSessions.push(promotoraBClient);

    const unauthAnonClient = createIsolatedAnonClient(publicEnv);

    // =========================================================================
    // TC-01: Recepción en Bandeja de Entrada (`App Vendedores -> public.surveys`)
    // =========================================================================
    await t.test('TC-01: Recepción íntegra en Bandeja de Entrada desde flujo Vendedor', async () => {
      await pacer.pace();
      const degId = `deg-qasync-${seeded.hexLower}-01`;
      const expectedProducts = [
        'MORTADELA ESP D/POLLO ASTURIAS 10UNDX900GR',
        'CHULETA AHUMADA ALIMEX X KG',
      ];
      const expectedObs = `${seeded.tagPrefix} OBSERVACION VENDEDOR TC-01`;

      const rtWaiter = await createRealtimeWaiter(
        planificadorClient,
        `qa-inbox-${seeded.hexLower}`,
        { event: 'INSERT', schema: 'public', table: 'surveys', filter: 'type=eq.Degustacion' },
        (payload) => String(payload?.new?.store || '').includes(seeded.runId)
      );

      const t0 = performance.now();
      rtWaiter.markActionStart();

      const submitRes = await submitVendorDegustacionToInbox({
        vendedorClient,
        runId: seeded.runId,
        degustacionId: degId,
        clienteCodigo: seeded.clientePrueba.codigoCliente,
        clienteNombre: seeded.clientePrueba.razonSocial,
        vendedorId: seeded.vendedorCatalogo.codigoVendedor,
        vendedorNombre: seeded.vendedorCatalogo.nombreCompleto,
        ruta: seeded.clientePrueba.ruta,
        fecha: seeded.tastingDateYmd,
        turno: 'MAÑANA',
        productos: expectedProducts,
        kilosEstimados: 3.5,
        personasEstimadas: 80,
        observaciones: expectedObs,
      });
      tc01SurveyId = submitRes.row.id;

      // Consulta de verificación como `qa_planificador`
      const { data: inboxRow, error: inboxErr } = await planificadorClient
        .from('surveys')
        .select('*')
        .eq('id', tc01SurveyId)
        .single();
      const restSyncMs = Math.round(performance.now() - t0);
      const rtResult = await rtWaiter.waitAndCleanup();

      assert.equal(inboxErr, null, `Error leyendo Bandeja como planificador: ${inboxErr?.message}`);
      assert.ok(inboxRow, 'La solicitud no apareció en public.surveys');
      assert.equal(inboxRow.type, 'Degustacion');
      assert.equal(inboxRow.store, seeded.clientePrueba.razonSocial);
      assert.equal(inboxRow.date, seeded.tastingDateYmd);

      const parsedComments =
        typeof inboxRow.comments === 'string'
          ? JSON.parse(inboxRow.comments)
          : inboxRow.comments;

      assert.equal(parsedComments.cliente, seeded.clientePrueba.razonSocial);
      assert.equal(parsedComments.clienteCodigo, seeded.clientePrueba.codigoCliente);
      assert.equal(parsedComments.vendedor, seeded.vendedorCatalogo.nombreCompleto);
      assert.deepEqual(parsedComments.products, expectedProducts);
      assert.equal(parsedComments.observaciones, expectedObs);
      assert.equal(parsedComments.estado, 'SOLICITADA');

      resultsMatrix.push({
        testCase: 'TC-01',
        title: 'Recepción en Bandeja de Entrada (Vendedor -> Planificador)',
        status: 'PASS',
        restLatencyMs: restSyncMs,
        realtimeLatencyMs: rtResult.latencyMs,
        realtimeDelivered: rtResult.received,
        notes: `Survey ID=${tc01SurveyId} recibido íntegro con estado SOLICITADA.`,
      });
    });

    // =========================================================================
    // TC-02: Idempotencia ante Doble Envío (Secuencial y Concurrente)
    // =========================================================================
    await t.test('TC-02: Idempotencia ante reintento consecutivo y doble envío concurrente', async () => {
      await pacer.pace();
      const degIdSeq = `deg-qasync-${seeded.hexLower}-02seq`;
      const obsSeq = `${seeded.tagPrefix} REINTENTO SECUENCIAL TC-02`;

      const t0 = performance.now();
      const seq1 = await submitVendorDegustacionToInbox({
        vendedorClient,
        runId: seeded.runId,
        degustacionId: degIdSeq,
        clienteCodigo: seeded.clientePrueba.codigoCliente,
        clienteNombre: seeded.clientePrueba.razonSocial,
        vendedorId: seeded.vendedorCatalogo.codigoVendedor,
        vendedorNombre: seeded.vendedorCatalogo.nombreCompleto,
        ruta: seeded.clientePrueba.ruta,
        fecha: seeded.tastingDateYmd,
        turno: 'MAÑANA',
        productos: ['MORTADELA ESP D/POLLO SALPICAO 10UNDX900GR'],
        observaciones: obsSeq,
        checkExistingFirst: true,
      });

      const seq2 = await submitVendorDegustacionToInbox({
        vendedorClient,
        runId: seeded.runId,
        degustacionId: degIdSeq,
        clienteCodigo: seeded.clientePrueba.codigoCliente,
        clienteNombre: seeded.clientePrueba.razonSocial,
        vendedorId: seeded.vendedorCatalogo.codigoVendedor,
        vendedorNombre: seeded.vendedorCatalogo.nombreCompleto,
        ruta: seeded.clientePrueba.ruta,
        fecha: seeded.tastingDateYmd,
        turno: 'MAÑANA',
        productos: ['MORTADELA ESP D/POLLO SALPICAO 10UNDX900GR'],
        observaciones: obsSeq,
        checkExistingFirst: true,
      });

      const { data: seqRows } = await planificadorClient
        .from('surveys')
        .select('id')
        .eq('type', 'Degustacion')
        .ilike('comments', `%${degIdSeq}%`);

      assert.equal(
        seqRows?.length,
        1,
        'El reintento secuencial creó duplicados inesperados'
      );
      assert.equal(seq1.row.id, seq2.row.id);

      // Ahora probar doble clic verdaderamente simultáneo (Promise.all)
      await pacer.pace();
      const degIdRace = `deg-qasync-${seeded.hexLower}-02race`;
      const obsRace = `${seeded.tagPrefix} DOBLE ENVIO PARALELO TC-02`;

      const [raceA, raceB] = await Promise.all([
        submitVendorDegustacionToInbox({
          vendedorClient,
          runId: seeded.runId,
          degustacionId: degIdRace,
          clienteCodigo: seeded.clientePrueba.codigoCliente,
          clienteNombre: seeded.clientePrueba.razonSocial,
          vendedorId: seeded.vendedorCatalogo.codigoVendedor,
          vendedorNombre: seeded.vendedorCatalogo.nombreCompleto,
          ruta: seeded.clientePrueba.ruta,
          fecha: seeded.tastingDateYmd,
          turno: 'MAÑANA',
          productos: ['MORTADELA ESP D/POLLO CORRAL 1X12UNI'],
          observaciones: obsRace,
          checkExistingFirst: true,
        }),
        submitVendorDegustacionToInbox({
          vendedorClient,
          runId: seeded.runId,
          degustacionId: degIdRace,
          clienteCodigo: seeded.clientePrueba.codigoCliente,
          clienteNombre: seeded.clientePrueba.razonSocial,
          vendedorId: seeded.vendedorCatalogo.codigoVendedor,
          vendedorNombre: seeded.vendedorCatalogo.nombreCompleto,
          ruta: seeded.clientePrueba.ruta,
          fecha: seeded.tastingDateYmd,
          turno: 'MAÑANA',
          productos: ['MORTADELA ESP D/POLLO CORRAL 1X12UNI'],
          observaciones: obsRace,
          checkExistingFirst: true,
        }),
      ]);

      // Asegurar que cualquier fila extra esté anotada en qa-ledger.json
      const { data: raceRows } = await planificadorClient
        .from('surveys')
        .select('id')
        .eq('type', 'Degustacion')
        .ilike('comments', `%${degIdRace}%`);

      for (const r of raceRows || []) {
        recordLedgerEntry({
          resource_type: 'db_row',
          schema: 'public',
          table_or_bucket: 'surveys',
          pk_column: 'id',
          id: r.id,
          run_id: seeded.runId,
          meta: { degustacionId: degIdRace, note: 'TC-02 race capture' },
        });
      }

      const elapsedMs = Math.round(performance.now() - t0);
      const parallelDuplicates = (raceRows?.length || 0) > 1;

      if (parallelDuplicates) {
        findings.push({
          id: 'FINDING-IDEMPOTENCY-SURVEYS-01',
          severity: 'MEDIUM',
          location:
            'App para los bot/dashboard-fdv---planificador/src/services/degustacionesService.ts:341-361 & public.surveys',
          summary:
            'El reintento secuencial es idempotente (1 fila), pero el doble clic paralelo (Promise.all) inserta 2 filas en public.surveys porque la verificación GET previa no es atómica y falta un índice UNIQUE parcial sobre (comments::jsonb->>\'degustacionId\'). En cambio, cronograma_degustaciones sí bloquea duplicados por constraint UNIQUE.',
        });
      }

      resultsMatrix.push({
        testCase: 'TC-02',
        title: 'Idempotencia ante Doble Envío (Secuencial vs Paralelo)',
        status: parallelDuplicates ? 'PASS_WITH_FINDING' : 'PASS',
        restLatencyMs: elapsedMs,
        realtimeLatencyMs: null,
        realtimeDelivered: null,
        notes: `Secuencial=1 fila (update=${seq2.wasUpdate}); Paralelo Promise.all=${raceRows?.length || 0} fila(s) [${raceA.row.id}, ${raceB.row.id}] registradas en qa-ledger.json.`,
      });
    });

    // =========================================================================
    // TC-03: Sincronización Ida (`Módulo de Degustaciones -> App Promotoras`)
    // =========================================================================
    await t.test('TC-03: Aprobación en Módulo de Degustaciones y recepción inmediata en App Promotoras', async () => {
      await pacer.pace();
      assert.ok(tc01SurveyId, 'Se requiere tc01SurveyId de TC-01');

      const promAStaffId = seeded.users.qa_promotora_a.staffId;
      const rtWaiter = await createRealtimeWaiter(
        promotoraAClient,
        `portal-ruta:${seeded.users.qa_promotora_a.id}:${promAStaffId}`,
        {
          event: '*',
          schema: 'public',
          table: 'rutas_promotoras',
          filter: `promotora_id=eq.${promAStaffId}`,
        },
        (payload) => String(payload?.new?.cliente_nombre || '').includes(seeded.runId)
      );

      const t0 = performance.now();
      rtWaiter.markActionStart();

      let rpcRes = await planificadorClient.rpc('rpc_autorizar_degustacion_trade', {
        p_promotora_id: promAStaffId,
        p_survey_id: tc01SurveyId,
        p_cronograma_id: null,
        p_aprobado_por: seeded.users.qa_planificador.email,
      });

      if (rpcRes.error && /rpc_autorizar_degustacion_trade|PGRST202|42883/i.test(rpcRes.error.message)) {
        rpcRes = await planificadorClient.rpc('asignar_degustacion_aceptada_a_ruta', {
          p_survey_id: tc01SurveyId,
          p_promotora_id: promAStaffId,
          p_aprobado_por: seeded.users.qa_planificador.email,
        });
      }

      assert.equal(
        rpcRes.error,
        null,
        `Error en RPC de aprobación/asignación: ${redactSensitive(rpcRes.error?.message)}`
      );

      const rpcRow = Array.isArray(rpcRes.data) ? rpcRes.data[0] : rpcRes.data;
      assert.ok(rpcRow?.cronograma_id, 'La RPC no retornó cronograma_id');
      assert.ok(rpcRow?.ruta_id, 'La RPC no retornó ruta_id');

      tc03CronogramaId = rpcRow.cronograma_id;
      tc03RutaId = rpcRow.ruta_id;

      // Registrar en qa-ledger.json ANTES del siguiente paso
      recordLedgerEntry({
        resource_type: 'db_row',
        schema: 'public',
        table_or_bucket: 'cronograma_degustaciones',
        pk_column: 'id',
        id: tc03CronogramaId,
        run_id: seeded.runId,
      });
      recordLedgerEntry({
        resource_type: 'db_row',
        schema: 'public',
        table_or_bucket: 'rutas_promotoras',
        pk_column: 'id',
        id: tc03RutaId,
        run_id: seeded.runId,
      });

      // Consulta exacta desde la sesión de `qa_promotora_a` replicando `/portal`
      const { data: promRoutes, error: promErr } = await promotoraAClient
        .from('rutas_promotoras')
        .select('*')
        .in('estado_ruta', ['ASIGNADA', 'EN_CURSO', 'COMPLETADA'])
        .gte('fecha', seeded.caracasTodayYmd)
        .eq('id', tc03RutaId);

      const restLatencyMs = Math.round(performance.now() - t0);
      const rtResult = await rtWaiter.waitAndCleanup();

      assert.equal(promErr, null, `Error leyendo ruta como qa_promotora_a: ${promErr?.message}`);
      assert.equal(promRoutes?.length, 1, 'qa_promotora_a no recibió exactamente 1 ruta asignada');

      const routeRow = promRoutes[0];
      assert.equal(routeRow.cliente_nombre, seeded.clientePrueba.razonSocial);
      assert.equal(routeRow.cliente_codigo, seeded.clientePrueba.codigoCliente);
      assert.equal(routeRow.fecha, seeded.tastingDateYmd);
      assert.equal(routeRow.turno, 'MAÑANA');
      assert.equal(Number(routeRow.cantidad_kilos), 3.5);
      assert.equal(routeRow.estado_ruta, 'ASIGNADA');
      assert.equal(routeRow.promotora_id, promAStaffId);

      resultsMatrix.push({
        testCase: 'TC-03',
        title: 'Sincronización Ida (Módulo Degustaciones -> App Promotoras)',
        status: 'PASS',
        restLatencyMs,
        realtimeLatencyMs: rtResult.latencyMs,
        realtimeDelivered: rtResult.received,
        notes: `cronograma_id=${tc03CronogramaId} proyectado a ruta_id=${tc03RutaId} con estado ASIGNADA.`,
      });
    });

    // =========================================================================
    // TC-04: Sincronización Vuelta (`App Promotoras -> Módulo de Degustaciones`)
    // =========================================================================
    await t.test('TC-04: Ejecución completa por qa_promotora_a (Check-in, Evidencia y Check-out) reflejada en Módulo de Degustaciones', async () => {
      await pacer.pace();
      assert.ok(tc03RutaId && tc03CronogramaId, 'Se requieren IDs creados en TC-03');

      const rtCronogramaWaiter = await createRealtimeWaiter(
        planificadorClient,
        `qa-cronograma-return-${seeded.hexLower}`,
        { event: 'UPDATE', schema: 'public', table: 'cronograma_degustaciones' },
        (payload) =>
          payload?.new?.id === tc03CronogramaId &&
          payload?.new?.estado === 'COMPLETADA'
      );

      const t0 = performance.now();
      rtCronogramaWaiter.markActionStart();

      // 1. Check-in (EN_CURSO)
      const checkinRes = await promotoraAClient.rpc('registrar_avance_ruta_promotora', {
        p_ruta_id: tc03RutaId,
        p_accion: 'CHECKIN',
      });
      assert.equal(
        checkinRes.error,
        null,
        `Error en CHECKIN de promotora: ${redactSensitive(checkinRes.error?.message)}`
      );
      assert.equal(checkinRes.data?.estado_ruta, 'EN_CURSO');
      assert.ok(checkinRes.data?.checkin_at, 'checkin_at no fue sellado por el servidor');

      // Verificar propagación intermedia a cronograma_degustaciones
      const { data: cronMid } = await planificadorClient
        .from('cronograma_degustaciones')
        .select('id, estado, cantidad_kilos, personas_estimadas, observaciones')
        .eq('id', tc03CronogramaId)
        .single();
      assert.equal(cronMid?.estado, 'EN_CURSO');

      // 2. Evidencia fotográfica + Jornada (si existen las tablas y bucket `asistencia-evidencias`)
      let evidenceUploaded = false;
      const promAStaffId = seeded.users.qa_promotora_a.staffId;
      const jornadaInsert = await promotoraAClient
        .from('asistencias_jornada')
        .insert({
          promotora_id: promAStaffId,
          fecha_jornada: seeded.tastingDateYmd,
          perfil_aplicado: 'FIJA',
          pdv_nombre: seeded.clientePrueba.razonSocial,
        })
        .select('id, perfil_aplicado')
        .single();

      if (!jornadaInsert.error && jornadaInsert.data?.id) {
        const jornadaId = jornadaInsert.data.id;
        recordLedgerEntry({
          resource_type: 'db_row',
          schema: 'public',
          table_or_bucket: 'asistencias_jornada',
          pk_column: 'id',
          id: jornadaId,
          run_id: seeded.runId,
        });

        const fileUuid = crypto.randomUUID();
        const storagePath = `asistencia/${seeded.tastingDateYmd}/${promAStaffId}/JORNADA_INGRESO_${fileUuid}.png`;
        const sha256Hex = crypto
          .createHash('sha256')
          .update(TINY_VALID_PNG_BUFFER)
          .digest('hex');

        // Anotar path en ledger ANTES de subir al bucket para asegurar limpieza incluso ante timeout
        recordLedgerEntry({
          resource_type: 'storage_object',
          schema: 'storage',
          table_or_bucket: 'asistencia-evidencias',
          pk_column: 'name',
          id: storagePath,
          run_id: seeded.runId,
        });

        const uploadRes = await promotoraAClient.storage
          .from('asistencia-evidencias')
          .upload(storagePath, TINY_VALID_PNG_BUFFER, {
            contentType: 'image/png',
            upsert: false,
          });

        if (!uploadRes.error) {
          const evInsert = await promotoraAClient
            .from('asistencia_evidencias')
            .insert({
              asistencia_id: jornadaId,
              slot_foto: 'JORNADA_INGRESO',
              storage_bucket: 'asistencia-evidencias',
              storage_path: storagePath,
              mime_type: 'image/png',
              tamano_bytes: TINY_VALID_PNG_BUFFER.length,
              sha256_hex: sha256Hex,
              ancho_px: 1,
              alto_px: 1,
              pdv_nombre: seeded.clientePrueba.razonSocial,
              lat: 10.6541,
              lng: -71.6342,
              gps_accuracy: 12.5,
              cargado_por_rol: 'promotora',
            })
            .select('id')
            .single();

          if (!evInsert.error && evInsert.data?.id) {
            evidenceUploaded = true;
            recordLedgerEntry({
              resource_type: 'db_row',
              schema: 'public',
              table_or_bucket: 'asistencia_evidencias',
              pk_column: 'id',
              id: evInsert.data.id,
              run_id: seeded.runId,
            });
          }
        }
      }

      // 3. Check-out (COMPLETADA)
      await pacer.pace();
      const checkoutRes = await promotoraAClient.rpc('registrar_avance_ruta_promotora', {
        p_ruta_id: tc03RutaId,
        p_accion: 'CHECKOUT',
      });
      assert.equal(
        checkoutRes.error,
        null,
        `Error en CHECKOUT de promotora: ${redactSensitive(checkoutRes.error?.message)}`
      );
      assert.equal(checkoutRes.data?.estado_ruta, 'COMPLETADA');
      assert.ok(checkoutRes.data?.checkout_at, 'checkout_at no fue sellado');

      // 4. Verificación íntegra en Módulo de Degustaciones como `qa_planificador`
      const { data: cronFinal, error: cronErr } = await planificadorClient
        .from('cronograma_degustaciones')
        .select('*')
        .eq('id', tc03CronogramaId)
        .single();

      const restLatencyMs = Math.round(performance.now() - t0);
      const rtResult = await rtCronogramaWaiter.waitAndCleanup();

      assert.equal(cronErr, null);
      assert.equal(cronFinal.estado, 'COMPLETADA');
      assert.equal(cronFinal.cliente_nombre, seeded.clientePrueba.razonSocial);
      assert.equal(Number(cronFinal.cantidad_kilos), 3.5);
      assert.equal(Number(cronFinal.personas_estimadas), 80);
      assert.ok(
        String(cronFinal.observaciones || '').includes(seeded.runId),
        'Se perdieron las observaciones originales al sincronizar vuelta'
      );

      // Inspeccionar si `public.surveys` también refleja COMPLETADA o queda en APROBADA
      const { data: originSurveyAfter } = await planificadorClient
        .from('surveys')
        .select('id, comments')
        .eq('id', tc01SurveyId)
        .single();
      const surveyCommentsAfter = originSurveyAfter?.comments
        ? typeof originSurveyAfter.comments === 'string'
          ? JSON.parse(originSurveyAfter.comments)
          : originSurveyAfter.comments
        : {};

      if (surveyCommentsAfter?.estado !== 'COMPLETADA') {
        findings.push({
          id: 'FINDING-RETURN-SYNC-SURVEYS-02',
          severity: 'LOW',
          location:
            'Trade Marketing/supabase/migrations/20261112_zero_trust_fdv_promotoras_portal_ruta.sql:942-967 (fn_sync_ruta_progress_to_cronograma)',
          summary: `El trigger propaga instantáneamente EN_CURSO y COMPLETADA hacia public.cronograma_degustaciones, pero no retro-actualiza public.surveys.comments->>'estado' (permanece en '${surveyCommentsAfter?.estado || 'APROBADA'}'; la UI de Trade Marketing lo reconcilia en memoria en supabaseModule1.ts:1622-1668).`,
        });
      }

      resultsMatrix.push({
        testCase: 'TC-04',
        title: 'Sincronización Vuelta (App Promotoras -> Módulo Degustaciones)',
        status: 'PASS',
        restLatencyMs,
        realtimeLatencyMs: rtResult.latencyMs,
        realtimeDelivered: rtResult.received,
        notes: `Transición ASIGNADA -> EN_CURSO -> COMPLETADA verificada sin pérdida de datos (evidencia Storage=${evidenceUploaded ? 'OK' : 'N/A'}).`,
      });
    });

    // =========================================================================
    // TC-05: Concurrencia Planificador vs. Promotora (Cero pisado con `null`)
    // =========================================================================
    await t.test('TC-05: Concurrencia simultánea Planificador (metadatos) vs Promotora (CHECKIN)', async () => {
      await pacer.pace();
      const degId05 = `deg-qasync-${seeded.hexLower}-05`;
      const initialObs05 = `${seeded.tagPrefix} PAUTA INICIAL TC-05`;

      // Crear segunda degustación en turno TARDE para no colisionar con el turno MAÑANA de TC-03
      const sub05 = await submitVendorDegustacionToInbox({
        vendedorClient,
        runId: seeded.runId,
        degustacionId: degId05,
        clienteCodigo: seeded.clientePrueba.codigoCliente,
        clienteNombre: seeded.clientePrueba.razonSocial,
        vendedorId: seeded.vendedorCatalogo.codigoVendedor,
        vendedorNombre: seeded.vendedorCatalogo.nombreCompleto,
        ruta: seeded.clientePrueba.ruta,
        fecha: seeded.tastingDateYmd,
        turno: 'TARDE',
        hora: '02:00 PM - 06:00 PM',
        productos: ['JAMON COC. SUPERIOR ALIMEX 1X5.9KG'],
        kilosEstimados: 4.0,
        personasEstimadas: 100,
        observaciones: initialObs05,
      });

      const promAStaffId = seeded.users.qa_promotora_a.staffId;
      const auth05 = await planificadorClient.rpc('rpc_autorizar_degustacion_trade', {
        p_promotora_id: promAStaffId,
        p_survey_id: sub05.row.id,
        p_cronograma_id: null,
        p_aprobado_por: seeded.users.qa_planificador.email,
      });
      assert.equal(auth05.error, null, `Error preparando TC-05: ${auth05.error?.message}`);
      const row05 = Array.isArray(auth05.data) ? auth05.data[0] : auth05.data;

      recordLedgerEntry({
        resource_type: 'db_row',
        schema: 'public',
        table_or_bucket: 'cronograma_degustaciones',
        pk_column: 'id',
        id: row05.cronograma_id,
        run_id: seeded.runId,
      });
      recordLedgerEntry({
        resource_type: 'db_row',
        schema: 'public',
        table_or_bucket: 'rutas_promotoras',
        pk_column: 'id',
        id: row05.ruta_id,
        run_id: seeded.runId,
      });

      await pacer.pace();
      const updatedAdminNote = `${seeded.tagPrefix} NOTA COORDINACION CONCURRENTE TC-05`;
      const updatedZona = `${seeded.tagPrefix} ZONA CONCURRENTE TC-05`;

      const t0 = performance.now();
      const [plannerUpdateRes, promotoraCheckinRes] = await Promise.all([
        planificadorClient
          .from('cronograma_degustaciones')
          .update({
            observaciones: updatedAdminNote,
            zona_direccion: updatedZona,
          })
          .eq('id', row05.cronograma_id)
          .select('*')
          .single(),
        promotoraAClient.rpc('registrar_avance_ruta_promotora', {
          p_ruta_id: row05.ruta_id,
          p_accion: 'CHECKIN',
        }),
      ]);
      const raceMs = Math.round(performance.now() - t0);

      assert.equal(
        plannerUpdateRes.error,
        null,
        `Error en update concurrente del planificador: ${plannerUpdateRes.error?.message}`
      );
      assert.equal(
        promotoraCheckinRes.error,
        null,
        `Error en checkin concurrente de promotora: ${promotoraCheckinRes.error?.message}`
      );

      // Releer estado consolidado en ambas tablas
      const [{ data: finalCron }, { data: finalRuta }] = await Promise.all([
        planificadorClient
          .from('cronograma_degustaciones')
          .select('*')
          .eq('id', row05.cronograma_id)
          .single(),
        promotoraAClient
          .from('rutas_promotoras')
          .select('*')
          .eq('id', row05.ruta_id)
          .single(),
      ]);

      assert.equal(finalCron.observaciones, updatedAdminNote, 'observaciones fue pisado');
      assert.equal(finalCron.zona_direccion, updatedZona, 'zona_direccion fue pisado');
      assert.equal(finalCron.estado, 'EN_CURSO', 'El avance EN_CURSO de promotora se perdió');
      assert.equal(finalCron.cliente_nombre, seeded.clientePrueba.razonSocial);
      assert.equal(Number(finalCron.cantidad_kilos), 4.0);

      assert.equal(finalRuta.observaciones, updatedAdminNote, 'observaciones no llegó a rutas_promotoras');
      assert.equal(finalRuta.estado_ruta, 'EN_CURSO', 'estado_ruta fue revertido a ASIGNADA');
      assert.ok(finalRuta.checkin_at !== null, 'checkin_at fue pisado con null');

      resultsMatrix.push({
        testCase: 'TC-05',
        title: 'Concurrencia Planificador vs Promotora (Promise.all)',
        status: 'PASS',
        restLatencyMs: raceMs,
        realtimeLatencyMs: null,
        realtimeDelivered: null,
        notes:
          'Cero pérdida ni pisado con null: observaciones administrativas y estado EN_CURSO + checkin_at convergieron íntegramente.',
      });
    });

    // =========================================================================
    // TC-06: Seguridad de Acceso, Aislamiento Horizontal RLS y No Auto-Aprobación
    // =========================================================================
    await t.test('TC-06: Auditoría empírica de Seguridad y Políticas RLS (Anon, Promotora B, Vendedor)', async () => {
      await pacer.pace();
      const t0 = performance.now();

      // 6.A: Peticiones SIN autenticar (`unauthAnonClient`)
      const [unauthCronSel, unauthRutaSel, unauthApproveRpc, unauthAvanceRpc] =
        await Promise.all([
          unauthAnonClient
            .from('cronograma_degustaciones')
            .select('id')
            .eq('id', tc03CronogramaId),
          unauthAnonClient.from('rutas_promotoras').select('id').eq('id', tc03RutaId),
          unauthAnonClient.rpc('rpc_autorizar_degustacion_trade', {
            p_promotora_id: seeded.users.qa_promotora_a.staffId,
            p_survey_id: tc01SurveyId,
            p_cronograma_id: null,
            p_aprobado_por: 'anon_attacker',
          }),
          unauthAnonClient.rpc('registrar_avance_ruta_promotora', {
            p_ruta_id: tc03RutaId,
            p_accion: 'CHECKOUT',
          }),
        ]);

      const unauthCronVisible = Array.isArray(unauthCronSel.data)
        ? unauthCronSel.data.length
        : 0;
      const unauthRutaVisible = Array.isArray(unauthRutaSel.data)
        ? unauthRutaSel.data.length
        : 0;

      assert.equal(
        unauthCronVisible,
        0,
        'VULNERABILIDAD: rol anon pudo leer cronograma_degustaciones'
      );
      assert.equal(
        unauthRutaVisible,
        0,
        'VULNERABILIDAD: rol anon pudo leer rutas_promotoras'
      );
      assert.ok(
        unauthApproveRpc.error,
        'VULNERABILIDAD: rol anon pudo ejecutar rpc_autorizar_degustacion_trade'
      );
      assert.ok(
        unauthAvanceRpc.error,
        'VULNERABILIDAD: rol anon pudo ejecutar registrar_avance_ruta_promotora'
      );

      // Comprobar también superficie RLS de `public.surveys` ante `anon` (lectura sin sesión)
      const unauthSurveyProbe = await unauthAnonClient
        .from('surveys')
        .select('id')
        .eq('id', tc01SurveyId);
      if (!unauthSurveyProbe.error && (unauthSurveyProbe.data?.length || 0) > 0) {
        findings.push({
          id: 'FINDING-RLS-SURVEYS-ANON-03',
          severity: 'HIGH',
          location:
            'App para los bot/dashboard-fdv---planificador/src/services/degustacionesService.ts:238-246 & public.surveys RLS',
          summary:
            'Debido a que dashboard-fdv---planificador transmite con ANON_KEY sin sesión Supabase Auth, public.surveys mantiene lectura/escritura abierta al rol anon. En contraste, cronograma_degustaciones y rutas_promotoras sí bloquean al 100% a anon.',
        });
      }

      // 6.B: Aislamiento cruzado `qa_promotora_b` contra degustaciones de `qa_promotora_a`
      await pacer.pace();
      const { data: promBReadOther } = await promotoraBClient
        .from('rutas_promotoras')
        .select('*')
        .eq('id', tc03RutaId);
      assert.equal(
        promBReadOther?.length || 0,
        0,
        'VULNERABILIDAD RLS: qa_promotora_b pudo ver la degustación asignada a qa_promotora_a'
      );

      const promBTamperRpc = await promotoraBClient.rpc(
        'registrar_avance_ruta_promotora',
        {
          p_ruta_id: tc03RutaId,
          p_accion: 'CHECKOUT',
        }
      );
      assert.ok(
        promBTamperRpc.error,
        'VULNERABILIDAD RLS: qa_promotora_b pudo alterar por RPC la ruta de qa_promotora_a'
      );

      const { data: promBDirectUpd } = await promotoraBClient
        .from('rutas_promotoras')
        .update({ estado_ruta: 'CANCELADA' })
        .eq('id', tc03RutaId)
        .select('id');
      assert.equal(
        promBDirectUpd?.length || 0,
        0,
        'VULNERABILIDAD RLS: qa_promotora_b pudo hacer UPDATE directo a la ruta de qa_promotora_a'
      );

      // Verificar además inmutabilidad de pauta comercial incluso para la propia `qa_promotora_a`
      const promASelfTamperKilos = await promotoraAClient
        .from('rutas_promotoras')
        .update({ cantidad_kilos: 999 })
        .eq('id', tc03RutaId)
        .select('id');
      assert.ok(
        promASelfTamperKilos.error || (promASelfTamperKilos.data?.length || 0) === 0,
        'VULNERABILIDAD: qa_promotora_a pudo alterar cantidad_kilos planificados'
      );

      // 6.C: Prohibición de auto-aprobación por `qa_vendedor`
      await pacer.pace();
      const vendorSelfApproveRpc = await vendedorClient.rpc(
        'rpc_autorizar_degustacion_trade',
        {
          p_promotora_id: seeded.users.qa_promotora_a.staffId,
          p_survey_id: tc01SurveyId,
          p_cronograma_id: null,
          p_aprobado_por: seeded.users.qa_vendedor.email,
        }
      );
      assert.ok(
        vendorSelfApproveRpc.error,
        'VULNERABILIDAD RBAC: qa_vendedor pudo auto-aprobar degustación vía RPC'
      );

      const vendorDirectInsertCron = await vendedorClient
        .from('cronograma_degustaciones')
        .insert({
          fecha: seeded.tastingDateYmd,
          turno: 'MAÑANA',
          hora_inicio: '09:00',
          hora_fin: '13:00',
          cliente_nombre: seeded.clientePrueba.razonSocial,
          producto_resumen: 'INTENTO BYPASS VENDEDOR',
          estado: 'APROBADA',
          origen_registro: 'MANUAL_ADMIN',
          idempotency_hash: crypto.randomBytes(32).toString('hex'),
        })
        .select('id');

      if (!vendorDirectInsertCron.error && vendorDirectInsertCron.data?.[0]?.id) {
        recordLedgerEntry({
          resource_type: 'db_row',
          schema: 'public',
          table_or_bucket: 'cronograma_degustaciones',
          pk_column: 'id',
          id: vendorDirectInsertCron.data[0].id,
          run_id: seeded.runId,
        });
      }
      assert.ok(
        vendorDirectInsertCron.error || (vendorDirectInsertCron.data?.length || 0) === 0,
        'VULNERABILIDAD RBAC: qa_vendedor pudo insertar directamente en cronograma_degustaciones'
      );

      const securityCheckMs = Math.round(performance.now() - t0);
      resultsMatrix.push({
        testCase: 'TC-06',
        title: 'Seguridad de Acceso, Aislamiento RLS Promotoras y Bloqueo Auto-Aprobación Vendedor',
        status: 'PASS',
        restLatencyMs: securityCheckMs,
        realtimeLatencyMs: null,
        realtimeDelivered: null,
        notes:
          'Anon bloqueado en Módulo 2/Portal; qa_promotora_b vio 0 filas y fue rechazada al mutar qa_promotora_a; qa_vendedor bloqueado en auto-aprobación.',
      });
    });

    // =========================================================================
    // VENTANA OPCIONAL CONTROLADA PARA EVIDENCIA VISUAL HITO 4 (/browser)
    // =========================================================================
    if (process.env.QA_HOLD_FOR_BROWSER === 'true') {
      const holdInfoPath = path.join(TMP_DIR_PATH, 'browser-hold-ready.json');
      const releaseSignalPath = path.join(TMP_DIR_PATH, 'release-browser-hold.signal');
      if (fs.existsSync(releaseSignalPath)) {
        fs.unlinkSync(releaseSignalPath);
      }

      // Solo metadatos públicos NO sensibles (cero llaves, cero contraseñas, cero tokens)
      fs.writeFileSync(
        holdInfoPath,
        `${JSON.stringify(
          {
            readyAt: new Date().toISOString(),
            runId: seeded.runId,
            clientePruebaCodigo: seeded.clientePrueba.codigoCliente,
            clientePruebaNombre: seeded.clientePrueba.razonSocial,
            tastingDateYmd: seeded.tastingDateYmd,
            tc01SurveyId,
            tc03CronogramaId,
            tc03RutaId,
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      console.log(
        `[HITO 4 HOLD] Datos sintéticos listos para captura visual (RUN_ID=${seeded.runId}). Esperando señal de liberación (máx 240s)...`
      );
      const holdStart = Date.now();
      while (Date.now() - holdStart < 240_000) {
        if (fs.existsSync(releaseSignalPath)) {
          fs.unlinkSync(releaseSignalPath);
          break;
        }
        await sleepMs(1000);
      }
      if (fs.existsSync(holdInfoPath)) {
        fs.unlinkSync(holdInfoPath);
      }
    }
  } finally {
    // Cerrar todas las sesiones cliente en memoria antes del borrado administrativo
    for (const sessionClient of activeSessions) {
      await sessionClient.auth.signOut().catch(() => {});
    }

    // PURGA TOTAL OBLIGATORIA CERO-RESIDUOS (incluso si falló alguna aserción o hubo timeout)
    const teardownReport = await teardownQaEnvironment({
      runId: seeded?.runId || null,
    });
    const zeroResidueReport = await verifyZeroResidue({
      runId: seeded?.runId || null,
    });

    if (!fs.existsSync(REPORTS_DIR_PATH)) {
      fs.mkdirSync(REPORTS_DIR_PATH, { recursive: true });
    }
    const executionSummary = {
      executedAt: new Date().toISOString(),
      runId: seeded?.runId || null,
      renderHealth: renderHealthReport,
      resultsMatrix,
      findings,
      teardownReport,
      zeroResidueReport,
    };
    fs.writeFileSync(
      path.join(REPORTS_DIR_PATH, 'qa-execution-report.json'),
      `${JSON.stringify(executionSummary, null, 2)}\n`,
      'utf8'
    );

    assert.equal(
      zeroResidueReport.clean,
      true,
      `FALLO PROTOCOLO CERO-RESIDUOS: Quedaron residuos sin limpiar (${JSON.stringify(
        zeroResidueReport
      )})`
    );
  }
});
