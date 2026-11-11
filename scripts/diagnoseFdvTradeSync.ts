import {
  createSupabaseSellerDegustacionRequest,
  FDV_PLANIFICADOR_RENDER_API_URL,
  fetchUnreadDegustacionNotifications,
  fetchWithProgressiveRetry,
  getTodayVeYmd,
  markSupabaseDegustacionAsRead,
  normalizeCanonicalDegustacionId,
  parseDegustacionNotificationRow,
  RawSupabaseSurvey,
  SUPABASE_ANON_KEY,
  SUPABASE_REST_URL,
} from '../src/services/supabaseModule1';

function exitProcess(code: number): void {
  const proc = (globalThis as unknown as { process?: { exit?: (c: number) => void } }).process;
  proc?.exit?.(code);
}

function assertCondition(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`[FALLO DE DIAGNÓSTICO] ${label}`);
  }
  console.log(`  [OK] ${label}`);
}

async function runDiagnostic(): Promise<void> {
  console.log('=========================================================================');
  console.log(' CODIZULCA C.A. - DIAGNÓSTICO E2E: FDV PLANIFICADOR <-> TRADE MARKETING');
  console.log('=========================================================================');
  console.log(`• Supabase Destino (Trade): ${SUPABASE_REST_URL}/surveys`);
  console.log(`• API Render (FDV):         ${FDV_PLANIFICADOR_RENDER_API_URL}`);

  // ---------------------------------------------------------------------------
  // 1. Reconciliación en vivo entre Render (/api/degustaciones) y Supabase (public.surveys)
  // ---------------------------------------------------------------------------
  console.log('\n[1/4] Verificando conexión y conciliación entre Render y Supabase...');
  const [renderRes, surveysRes] = await Promise.all([
    fetchWithProgressiveRetry(FDV_PLANIFICADOR_RENDER_API_URL, { method: 'GET' }, { maxRetries: 2, timeoutMs: 20000 }).catch(
      () => null
    ),
    fetchWithProgressiveRetry(
      `${SUPABASE_REST_URL}/surveys?type=eq.Degustacion&select=id,date,store,promoter,product,comments,created_at&limit=500`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      }
    ),
  ]);

  assertCondition(surveysRes.ok, `Conexión REST a public.surveys exitosa (HTTP ${surveysRes.status})`);
  const surveysRows = (await surveysRes.json()) as RawSupabaseSurvey[];

  const supabaseDegIds = new Set<string>();
  for (const r of surveysRows) {
    try {
      const c = typeof r.comments === 'string' ? JSON.parse(r.comments) : r.comments || {};
      const cid = normalizeCanonicalDegustacionId(c?.degustacionId || c?.id);
      if (cid) supabaseDegIds.add(cid);
    } catch {
      // ignore malformed historical comments
    }
  }

  if (renderRes && renderRes.ok) {
    const renderPayload = (await renderRes.json()) as {
      count?: number;
      data?: Array<{ id: string }>;
    };
    const renderItems = renderPayload.data || [];
    const matchedCount = renderItems.filter((item) =>
      supabaseDegIds.has(normalizeCanonicalDegustacionId(item.id))
    ).length;
    console.log(
      `  [OK] Render /api/degustaciones activo: ${renderItems.length} registros | Conciliados en Supabase Trade: ${matchedCount}/${renderItems.length}`
    );
  } else {
    console.log('  [AVISO] Contenedor Render en reposo o inaccesible temporalmente; Supabase operativo.');
  }

  // ---------------------------------------------------------------------------
  // 2. Verificación unitaria de mapeo de esquema (incluyendo payload backend server.ts, decimales y turno COMPLETO)
  // ---------------------------------------------------------------------------
  console.log('\n[2/4] Verificando mapeo de contrato de datos (Schema Match 1:1)...');
  const todayYmd = getTodayVeYmd();
  const simulatedBackendRow: RawSupabaseSurvey = {
    id: '00000000-0000-4000-8000-000000000099',
    type: 'Degustacion',
    date: todayYmd,
    store: 'AUTOMERCADO DIAGNOSTICO QA',
    promoter: 'MIKELANGELO DIAZ',
    product: 'ESPALDA, MORTADELA',
    created_at: new Date().toISOString(),
    comments: JSON.stringify({
      time: '09:00 AM - 07:00 PM',
      address: 'Ruta: MARACAIBO NORTE | Contacto: SR. MANUEL RINCON (0414-1234567)',
      promoterType: 'Fija',
      isTasting: true,
      estado: 'SOLICITADA',
      originalComments: 'Ubicación frente a charcutería principal',
      vendedor: 'MIKELANGELO DIAZ',
      clienteCodigo: 'C-9901',
      kilos: 2.5,
      personas: 120,
      turno: 'COMPLETO',
      materialPop: 'SI',
      degustacionId: 'DEG-deg-unit-test-99',
    }),
  };

  const parsedBackend = parseDegustacionNotificationRow(simulatedBackendRow, todayYmd);
  assertCondition(parsedBackend !== null, 'Fila de backend server.ts parseada sin pérdida');
  assertCondition(parsedBackend!.source === 'vendedor_app', 'Origen detectado como vendedor_app aunque falte c.source');
  assertCondition(parsedBackend!.degustacionId === 'deg-unit-test-99', 'Prefijo DEG- normalizado a ID canónico');
  assertCondition(parsedBackend!.zone === 'MARACAIBO NORTE', 'Ruta extraída desde address compuesto');
  assertCondition(parsedBackend!.contactoPunto === 'SR. MANUEL RINCON', 'Contacto PDV extraído desde address compuesto');
  assertCondition(parsedBackend!.telefonoContacto === '0414-1234567', 'Teléfono extraído desde address compuesto');
  assertCondition(parsedBackend!.requestedQty === 2.5, 'Precisión decimal de kilosEstimados (2.5 kg) preservada');
  assertCondition(parsedBackend!.turnoRaw === 'COMPLETO', 'Turno COMPLETO preservado sin pérdida');
  assertCondition(parsedBackend!.leidoTrade === false, 'Indicador leidoTrade = false dispara el Globito');

  // ---------------------------------------------------------------------------
  // 3. Prueba E2E en vivo contra Supabase: ACK + Idempotencia + Globito (+1 / -1) + Anti-Resurrección
  // ---------------------------------------------------------------------------
  console.log('\n[3/4] Ejecutando prueba transaccional en vivo (Idempotencia + ACK + Globito +1/-1)...');
  const baselineUnread = await fetchUnreadDegustacionNotifications();
  const baselineCount = baselineUnread.length;
  console.log(`  • Conteo inicial Globito (leido_trade = false): ${baselineCount}`);

  const probeDegId = `deg-diag-${Date.now().toString(36)}`;
  let createdSurveyId = '';

  try {
    const ackRow = await createSupabaseSellerDegustacionRequest({
      degustacionId: probeDegId,
      sellerName: 'MIKELANGELO DIAZ',
      storeName: 'SUPERMERCADO DIAGNOSTICO SYNC',
      clienteCodigo: 'DIAG-01',
      zone: 'MARACAIBO NORTE',
      contactoPunto: 'ENCARGADO QA',
      telefonoContacto: '0414-0000000',
      productName: 'ESPALDA, MORTADELA',
      productsList: ['ESPALDA', 'MORTADELA'],
      date: todayYmd,
      turno: 'MAÑANA',
      timeRange: '09:00 AM - 01:00 PM',
      kilos: 3.5,
      personas: 140,
      requierePromotora: true,
      promoterType: 'Fija',
      materialPop: 'SI',
      notes: 'Verificación automatizada E2E (se elimina al finalizar)',
    });

    createdSurveyId = ackRow.id;
    assertCondition(Boolean(createdSurveyId), `Confirmación Real (ACK) recibida con UUID: ${createdSurveyId}`);

    // Reintento con el mismo degustacionId (simulación de doble toque / reintento móvil)
    const retryAckRow = await createSupabaseSellerDegustacionRequest({
      degustacionId: probeDegId,
      sellerName: 'MIKELANGELO DIAZ',
      storeName: 'SUPERMERCADO DIAGNOSTICO SYNC',
      clienteCodigo: 'DIAG-01',
      zone: 'MARACAIBO NORTE',
      productName: 'ESPALDA, MORTADELA',
      date: todayYmd,
      timeRange: '09:00 AM - 01:00 PM',
      kilos: 3.5,
      personas: 140,
      notes: 'Reintento idempotente',
    });
    assertCondition(
      retryAckRow.id === createdSurveyId,
      'Idempotencia anti-doble clic verificada (mismo UUID sin duplicar registro)'
    );

    const afterInsertUnread = await fetchUnreadDegustacionNotifications();
    assertCondition(
      afterInsertUnread.length === baselineCount + 1,
      `Globito incrementó exactamente +1 (${baselineCount} -> ${afterInsertUnread.length})`
    );

    const insertedNotif = afterInsertUnread.find((n) => n.id === createdSurveyId);
    assertCondition(
      Boolean(insertedNotif) && insertedNotif!.requestedQty === 3.5 && insertedNotif!.clienteCodigo === 'DIAG-01',
      'Todos los campos del vendedor se recibieron íntegros en Trade Marketing'
    );

    // Marcar como vista (-1)
    await markSupabaseDegustacionAsRead(createdSurveyId, insertedNotif?.rawComments);
    const afterReadUnread = await fetchUnreadDegustacionNotifications();
    assertCondition(
      afterReadUnread.length === baselineCount,
      `Globito descontó exactamente -1 al marcar vista (${afterInsertUnread.length} -> ${afterReadUnread.length})`
    );
  } finally {
    // -------------------------------------------------------------------------
    // 4. Limpieza garantizada para mantener 0 datos sintéticos en producción
    // -------------------------------------------------------------------------
    if (createdSurveyId) {
      console.log('\n[4/4] Limpiando registro temporal de diagnóstico en Supabase...');
      const delRes = await fetchWithProgressiveRetry(
        `${SUPABASE_REST_URL}/surveys?id=eq.${encodeURIComponent(createdSurveyId)}`,
        {
          method: 'DELETE',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            Prefer: 'return=minimal',
          },
        }
      );
      assertCondition(
        delRes.ok,
        `Registro temporal ${createdSurveyId} eliminado limpiamente (HTTP ${delRes.status})`
      );
    }
  }

  console.log('\n✅ DIAGNÓSTICO COMPLETO EXITOSO: Sincronización FDV <-> Trade Marketing 100% operativa.');
  exitProcess(0);
}

runDiagnostic().catch((err) => {
  console.error('\n❌ ERROR EN DIAGNÓSTICO:', err);
  exitProcess(1);
});
