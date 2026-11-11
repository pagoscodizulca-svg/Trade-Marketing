import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  DEFAULT_FDV_RENDER_API_URL,
  adaptRenderDegustacionToSurveyRow,
  fetchDegustacionSurveysViaSdk,
  fetchFdvPlanificadorRenderDegustaciones,
  isVirtualFdvRenderSurveyId,
  mergeSupabaseAndRenderDegustacionRows,
  normalizeCanonicalFdvId,
  normalizeFdvCalendarDateYmd,
  resolveFdvRequestLifecycle,
  safeJsonParseObject,
  sanitizeExternalHttpsUrl,
  sanitizeFdvText,
  syncDecisionToFdvPlanificadorRender,
  validateFdvRenderEndpoint,
} from '../src/services/fdvDegustacionesAdapter';
import {
  getTodayVeYmd,
  parseDegustacionNotificationRow,
  type RawSupabaseSurvey,
} from '../src/services/supabaseModule1';

// Forzar huso horario America/Caracas (UTC-4) para comprobar cero desfase de -1 día
process.env.TZ = 'America/Caracas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.resolve(PROJECT_ROOT, '.env.local') });
dotenv.config({ path: path.resolve(PROJECT_ROOT, '.env') });

function logStepOk(label: string): void {
  console.log(`  [OK] ${label}`);
}

async function runVerification(): Promise<void> {
  console.log('=========================================================================');
  console.log(' CODIZULCA C.A. - VERIFICACIÓN INTEGRAL RESTAURACIÓN DEGUSTACIONES FDV');
  console.log('=========================================================================');

  // ---------------------------------------------------------------------------
  // BLOQUE 1: Seguridad, Anti-Prototype-Pollution, Sanitización y HTTPS Estricto
  // ---------------------------------------------------------------------------
  console.log('\n[1/4] Verificando controles de seguridad, origen HTTPS y anti-Prototype-Pollution...');

  assert.equal(
    validateFdvRenderEndpoint('https://dashboard-fdv-planificador.onrender.com/api/degustaciones'),
    'https://dashboard-fdv-planificador.onrender.com/api/degustaciones'
  );
  assert.equal(
    validateFdvRenderEndpoint('http://dashboard-fdv-planificador.onrender.com/api/degustaciones'),
    null
  );
  assert.equal(
    validateFdvRenderEndpoint('https://evil-attacker.example.com/api/degustaciones'),
    null
  );
  assert.equal(
    validateFdvRenderEndpoint('https://user:secret@dashboard-fdv-planificador.onrender.com/api/degustaciones'),
    null
  );
  assert.equal(validateFdvRenderEndpoint('javascript:alert(1)'), null);
  logStepOk('Validación estricta de protocolo HTTPS y origen autorizado de Render FDV');

  const maliciousJson =
    '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"cliente":"CHARCUTERIA ZULIA","estado":"SOLICITADA"}';
  const parsedSafe = safeJsonParseObject<Record<string, unknown>>(maliciousJson);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(parsedSafe, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsedSafe, 'constructor'), false);
  assert.equal(parsedSafe.cliente, 'CHARCUTERIA ZULIA');
  logStepOk('JSON parsing blindado contra Prototype Pollution (__proto__, constructor, prototype)');

  assert.equal(sanitizeFdvText('  Abasto\u0000\u0007   El   Sol  ', 60), 'Abasto El Sol');
  assert.equal(sanitizeExternalHttpsUrl('javascript:alert(1)'), undefined);
  assert.equal(sanitizeExternalHttpsUrl('data:text/html,<script>alert(1)</script>'), undefined);
  assert.equal(
    sanitizeExternalHttpsUrl('https://maps.google.com/?q=10.65,-71.63'),
    'https://maps.google.com/?q=10.65,-71.63'
  );
  logStepOk('Sanitización de texto y bloqueo de esquemas peligrosos en URLs externas');

  let capturedPutUrl = '';
  let capturedPutBody = '';
  const syncOk = await syncDecisionToFdvPlanificadorRender(
    'fdv-render:deg-mmk-test01',
    {
      estado: 'APROBADA',
      promotoraAsignada: 'María Alejandra',
      notasTradeMarketing: 'Sincronizada en verificación unitaria',
    },
    {
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedPutUrl = String(input);
        capturedPutBody = String(init?.body || '');
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as typeof fetch,
    }
  );
  assert.equal(syncOk, true);
  assert.equal(
    capturedPutUrl,
    `${DEFAULT_FDV_RENDER_API_URL}/deg-mmk-test01`
  );
  const parsedPutBody = JSON.parse(capturedPutBody) as Record<string, unknown>;
  assert.equal(parsedPutBody.estado, 'APROBADA');
  assert.equal(parsedPutBody.promotoraAsignada, 'María Alejandra');

  const syncRejectedTraversal = await syncDecisionToFdvPlanificadorRender(
    'deg-../../admin',
    { estado: 'APROBADA' },
    {
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    }
  );
  assert.equal(syncRejectedTraversal, false);
  logStepOk('Sincronización PUT parametrizada hacia Render con bloqueo de path traversal');

  // ---------------------------------------------------------------------------
  // BLOQUE 2: Exactitud de Fechas Calendario en UTC-4 y Máquina de Estados
  // ---------------------------------------------------------------------------
  console.log('\n[2/4] Verificando integridad de fechas UTC-4 y máquina de estados de degustaciones...');

  assert.equal(normalizeFdvCalendarDateYmd('2026-11-06'), '2026-11-06');
  assert.equal(normalizeFdvCalendarDateYmd('2026-11-06T00:00:00.000Z'), '2026-11-06');
  assert.equal(normalizeFdvCalendarDateYmd('2026-10-08T00:00:00Z'), '2026-10-08');
  assert.equal(normalizeFdvCalendarDateYmd('06/11/2026'), '2026-11-06');
  logStepOk('Fechas calendario ISO y medianoche UTC preservadas sin desfase de -1 día en America/Caracas (UTC-4)');

  const pastSolicitada = resolveFdvRequestLifecycle({
    rawEstado: 'SOLICITADA',
    isFromSellerApp: true,
    ymd: '2026-11-06',
    todayYmd: '2026-11-11',
  });
  assert.equal(pastSolicitada.uiStatus, 'PENDIENTE');
  assert.equal(pastSolicitada.isArchived, false);
  assert.equal(pastSolicitada.isEligibleForModule2, false);
  assert.equal(pastSolicitada.isOverduePending, true);

  const todaySolicitada = resolveFdvRequestLifecycle({
    rawEstado: 'SOLICITADA',
    isFromSellerApp: true,
    ymd: '2026-11-11',
    todayYmd: '2026-11-11',
  });
  assert.equal(todaySolicitada.uiStatus, 'PENDIENTE');
  assert.equal(todaySolicitada.isArchived, false);
  assert.equal(todaySolicitada.isOverduePending, false);

  const futureSolicitada = resolveFdvRequestLifecycle({
    rawEstado: 'SOLICITADA',
    isFromSellerApp: true,
    ymd: '2026-11-20',
    todayYmd: '2026-11-11',
  });
  assert.equal(futureSolicitada.uiStatus, 'PENDIENTE');
  assert.equal(futureSolicitada.isArchived, false);

  const approvedFuture = resolveFdvRequestLifecycle({
    rawEstado: 'APROBADA',
    isFromSellerApp: true,
    ymd: '2026-11-20',
    todayYmd: '2026-11-11',
  });
  assert.equal(approvedFuture.uiStatus, 'PROGRAMADO');
  assert.equal(approvedFuture.isEligibleForModule2, true);
  assert.equal(approvedFuture.isArchived, false);

  const realizedTodayLifecycle = resolveFdvRequestLifecycle({
    rawEstado: 'REALIZADA',
    isFromSellerApp: true,
    ymd: '2026-11-11',
    todayYmd: '2026-11-11',
  });
  assert.equal(realizedTodayLifecycle.uiStatus, 'COMPLETADO');
  assert.equal(realizedTodayLifecycle.isArchived, false);

  const realizedPastLifecycle = resolveFdvRequestLifecycle({
    rawEstado: 'REALIZADA',
    isFromSellerApp: true,
    ymd: '2026-11-05',
    todayYmd: '2026-11-11',
  });
  assert.equal(realizedPastLifecycle.uiStatus, 'COMPLETADO');
  assert.equal(realizedPastLifecycle.isArchived, true);

  const rejectedLifecycle = resolveFdvRequestLifecycle({
    rawEstado: 'RECHAZADA',
    isFromSellerApp: true,
    ymd: '2026-11-20',
    todayYmd: '2026-11-11',
  });
  assert.equal(rejectedLifecycle.isRejectedOrCancelled, true);
  assert.equal(rejectedLifecycle.isEligibleForModule2, false);
  logStepOk('Solicitudes SOLICITADA FDV permanecen PENDIENTE y visibles (pasadas, hoy y futuras) hasta decisión explícita');

  // ---------------------------------------------------------------------------
  // BLOQUE 3: Simulación Controlada de Llegada FDV + Reconciliación Idempotente
  // ---------------------------------------------------------------------------
  console.log('\n[3/4] Verificando adaptador de payload FDV (22 campos) y reconciliación Supabase <-> Render...');

  const simulatedRenderPayload = {
    id: 'deg-sim-20261115-01',
    vendedor: 'Sairú Valles',
    vendedorId: 'vnd-sairu-01',
    ruta: 'Zona Norte Maracaibo',
    cliente: 'SUPERMERCADO FIORELLA NORTE',
    clienteCodigo: 'CLI-8842',
    fecha: '2026-11-15',
    hora: '09:30 AM',
    turno: 'MAÑANA',
    productos: ['Mortadela Especial 1kg', 'Jamón Ahumado 500g'],
    kilos: 4.5,
    personasEstimadas: 180,
    requierePromotora: true,
    materialPop: 'SI',
    contactoPunto: 'Sr. Roberto Pirela',
    telefonoContacto: '0414-6001122',
    observaciones: 'Alto tráfico fin de semana',
    estado: 'SOLICITADA',
    promotoraAsignada: '',
    notasTradeMarketing: '',
    resultado: null,
    createdAt: '2026-11-11T14:20:00.000Z',
  };

  const adaptedVirtualRow = adaptRenderDegustacionToSurveyRow(simulatedRenderPayload);
  assert.ok(adaptedVirtualRow, 'El adaptador debe transformar el payload válido de Render');
  assert.equal(isVirtualFdvRenderSurveyId(adaptedVirtualRow.id), true);
  assert.equal(
    normalizeCanonicalFdvId(adaptedVirtualRow.id),
    'deg-sim-20261115-01'
  );
  assert.equal(adaptedVirtualRow.date, '2026-11-15');
  assert.equal(adaptedVirtualRow.store, 'SUPERMERCADO FIORELLA NORTE');

  const parsedNotif = parseDegustacionNotificationRow(adaptedVirtualRow);
  assert.ok(parsedNotif, 'La fila virtual adaptada debe ser reconocida como solicitud FDV válida');
  assert.equal(parsedNotif.sellerName, 'Sairú Valles');
  assert.equal(parsedNotif.clienteCodigo, 'CLI-8842');
  assert.equal(parsedNotif.zone, 'Zona Norte Maracaibo');
  assert.equal(parsedNotif.contactoPunto, 'Sr. Roberto Pirela');
  assert.equal(parsedNotif.telefonoContacto, '0414-6001122');
  assert.equal(parsedNotif.requestedQty, 4.5);
  assert.equal(parsedNotif.targetSamples, 180);
  assert.equal(parsedNotif.estado, 'SOLICITADA');

  // Caso A: Fila en Supabase ya APROBADA por Trade Marketing NO debe ser pisada por Render SOLICITADA
  const approvedSupabaseTwin: RawSupabaseSurvey = {
    ...adaptedVirtualRow,
    id: 'uuid-supabase-real-001',
    promoter: 'Genesis Lopez',
    comments: JSON.stringify({
      ...safeJsonParseObject<Record<string, unknown>>(adaptedVirtualRow.comments),
      estado: 'APROBADA',
      status: 'aprobada',
      promotoraAsignada: 'Genesis Lopez',
      aprobadoEnTradeAt: '2026-11-11T15:00:00.000Z',
    }),
  };

  // Caso B: Segunda solicitud presente únicamente en Render (fallo transitorio de escritura FDV -> Supabase)
  const renderOnlyAdapted = adaptRenderDegustacionToSurveyRow({
    ...simulatedRenderPayload,
    id: 'deg-sim-render-only-02',
    vendedor: 'Mariana Chacín',
    cliente: 'HIPERMERCADO NASA SUR',
  });
  assert.ok(renderOnlyAdapted);

  const reconciliation = mergeSupabaseAndRenderDegustacionRows(
    [approvedSupabaseTwin],
    [adaptedVirtualRow, renderOnlyAdapted]
  );
  assert.equal(reconciliation.mergedRows.length, 2, 'Cero duplicados al reconciliar gemelos + fila exclusiva Render');
  assert.equal(reconciliation.renderOnlyRows.length, 1);
  assert.equal(reconciliation.renderOnlyRows[0].id, 'fdv-render:deg-sim-render-only-02');

  const reconciledTwin = reconciliation.mergedRows.find((r) => r.id === 'uuid-supabase-real-001');
  assert.ok(reconciledTwin);
  const reconciledComments = safeJsonParseObject<Record<string, unknown>>(reconciledTwin.comments);
  assert.equal(reconciledComments.estado, 'APROBADA');
  assert.equal(reconciledComments.promotoraAsignada, 'Genesis Lopez');
  logStepOk('Reconciliación idempotente preserva aprobaciones de Trade Marketing y rescata solicitudes exclusivas de Render');

  // ---------------------------------------------------------------------------
  // BLOQUE 4: Verificación en Vivo (Solo Lectura) contra Supabase y Render FDV
  // ---------------------------------------------------------------------------
  console.log('\n[4/4] Verificando lectura real en producción (Supabase SDK + API Render FDV, 0 escrituras)...');

  const supabaseProjectUrl = (process.env.VITE_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1\/?$/, '');
  const supabaseAnonKey = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
  assert.ok(
    supabaseProjectUrl.startsWith('https://') && supabaseAnonKey.length > 20,
    'Credenciales VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY cargadas desde entorno local'
  );

  const readOnlyClient = createClient(supabaseProjectUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [supabaseDegRows, renderAdaptedRows] = await Promise.all([
    fetchDegustacionSurveysViaSdk(readOnlyClient),
    fetchFdvPlanificadorRenderDegustaciones({ timeoutMs: 25_000, forceRefresh: true }),
  ]);

  assert.ok(
    supabaseDegRows.length >= 180,
    `SDK paginado recuperó todas las filas type='Degustacion' sin truncamiento (${supabaseDegRows.length} filas)`
  );
  assert.ok(
    renderAdaptedRows.length >= 50,
    `Endpoint oficial Render FDV respondió 200 OK intacto (${renderAdaptedRows.length} solicitudes)`
  );

  const liveMerged = mergeSupabaseAndRenderDegustacionRows(supabaseDegRows, renderAdaptedRows);
  const todayVe = getTodayVeYmd();

  const fdvSellerRequests = liveMerged.mergedRows.filter((row) => {
    const c = safeJsonParseObject<Record<string, unknown>>(row.comments);
    const key = normalizeCanonicalFdvId(c.degustacionId || c.id, row.id);
    return c.source === 'vendedor_app' || /^deg-/i.test(key);
  });

  const uniqueDegKeys = new Set(
    fdvSellerRequests.map((row) => {
      const c = safeJsonParseObject<Record<string, unknown>>(row.comments);
      return normalizeCanonicalFdvId(c.degustacionId || c.id, row.id);
    })
  );

  assert.equal(
    fdvSellerRequests.length,
    uniqueDegKeys.size,
    'Cero solicitudes FDV duplicadas tras reconciliación en vivo'
  );
  assert.ok(
    fdvSellerRequests.length >= 50,
    `Las ${fdvSellerRequests.length} solicitudes reales de vendedores FDV están presentes e íntegras`
  );

  const activePendingCount = fdvSellerRequests.filter((row) => {
    const c = safeJsonParseObject<Record<string, unknown>>(row.comments);
    const lc = resolveFdvRequestLifecycle({
      rawEstado: String(c.estado || c.status || ''),
      isFromSellerApp: true,
      ymd: normalizeFdvCalendarDateYmd(row.date || c.date),
      todayYmd: todayVe,
    });
    return lc.uiStatus === 'PENDIENTE' && !lc.isArchived;
  }).length;

  assert.ok(
    activePendingCount > 0,
    `Solicitudes SOLICITADA FDV visibles en Cronograma Actual como PENDIENTE (${activePendingCount} activas)`
  );

  const detectedSellers = Array.from(
    new Set(
      fdvSellerRequests
        .map((row) => parseDegustacionNotificationRow(row)?.sellerName || '')
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, 'es'));

  logStepOk(
    `Supabase SDK: ${supabaseDegRows.length} filas Degustacion | Render FDV: ${renderAdaptedRows.length} solicitudes | Reconciliadas FDV únicas: ${fdvSellerRequests.length} (${activePendingCount} PENDIENTE activas)`
  );
  logStepOk(`Vendedores FDV detectados (${detectedSellers.length}): ${detectedSellers.join(', ')}`);

  console.log('\n=========================================================================');
  console.log(' RESULTADO FINAL: 100% VERIFICADO SIN ERRORES NI ESCRITURAS DESTRUCTIVAS');
  console.log('=========================================================================');
}

runVerification().catch((err) => {
  console.error('\n[ERROR EN VERIFICACIÓN FDV -> TRADE]:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
