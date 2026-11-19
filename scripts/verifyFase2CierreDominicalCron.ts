import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import {
  handleWeeklyTastingCutoffCron,
  requireCronSecretAuth,
  verifyCronBearerAuthorization,
} from '../src/server/weeklyTastingCronHandler';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  executeDeterministicWeeklyCutoff,
  MOTIVO_CIERRE_DOMINGO_9PM,
  PG_CRON_SUNDAY_9PM_CARACAS_UTC,
  resolveSundayCutoffContext,
  selectActiveDegustacionesTabItems,
  selectHistorialTabItems,
  type ArchivableTastingItem,
} from '../src/utils/weeklyTastingCutoffEngine';

interface TestRecord extends ArchivableTastingItem {
  storeLabelForTestOnly?: string;
}

async function testHttpCronEndpointSecurity(): Promise<void> {
  const testSecret = 'cron-test-secret-codizulca-9pm-sunday-2026';
  const prevSecret = process.env.CRON_SECRET;
  const prevTz = process.env.APP_TIMEZONE;

  process.env.CRON_SECRET = testSecret;
  process.env.APP_TIMEZONE = DEFAULT_BUSINESS_TIMEZONE;

  // Pruebas unitarias directas del validador en tiempo constante
  assert.equal(verifyCronBearerAuthorization(undefined, testSecret), false);
  assert.equal(verifyCronBearerAuthorization('', testSecret), false);
  assert.equal(verifyCronBearerAuthorization(`Basic ${testSecret}`, testSecret), false);
  assert.equal(
    verifyCronBearerAuthorization(
      'Bearer cron-test-secret-codizulca-9pm-sunday-XXXX',
      testSecret
    ),
    false,
    'Debe rechazar secreto incorrecto de igual longitud'
  );
  assert.equal(
    verifyCronBearerAuthorization('Bearer token-corto-invalido', testSecret),
    false,
    'Debe rechazar secreto incorrecto de distinta longitud'
  );
  assert.equal(
    verifyCronBearerAuthorization('Bearer shortsecret', 'shortsecret'),
    false,
    'Debe rechazar secretos configurados menores a 16 caracteres'
  );
  assert.equal(
    verifyCronBearerAuthorization(`Bearer ${testSecret}`, testSecret),
    true,
    'Debe autorizar exactamente Bearer <CRON_SECRET>'
  );

  // Servidor efímero local para probar middleware HTTP 401 vs 200
  const app = express();
  app.use(express.json());
  app.post(
    '/api/cron/degustaciones-cierre-semanal',
    requireCronSecretAuth,
    handleWeeklyTastingCutoffCron
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}/api/cron/degustaciones-cierre-semanal`;

    const unauthMissing = await fetch(baseUrl, { method: 'POST' });
    assert.equal(unauthMissing.status, 401, 'Petición sin Authorization debe responder 401');

    const unauthWrong = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-incorrecto-intento-no-autorizado-9999',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(unauthWrong.status, 401, 'Petición con Bearer inválido debe responder 401');

    // Con credencial válida y forceRun: false fuera de domingo >= 21:00 responde 200 seguro sin mutar BD
    const ctxNow = resolveSundayCutoffContext(new Date(), DEFAULT_BUSINESS_TIMEZONE, false);
    if (!ctxNow.isWithinScheduledWindow) {
      const validOutsideWindow = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ forceRun: false }),
      });
      assert.equal(validOutsideWindow.status, 200);
      const payload = (await validOutsideWindow.json()) as {
        ok?: boolean;
        skipped_outside_window?: boolean;
      };
      assert.equal(payload.ok, true);
      assert.equal(payload.skipped_outside_window, true);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
    if (prevTz === undefined) delete process.env.APP_TIMEZONE;
    else process.env.APP_TIMEZONE = prevTz;
  }
}

async function runFase2Verification(): Promise<void> {
  console.log('======================================================================');
  console.log('VERIFICACIÓN AUTOMATIZADA FASE 2 • CIERRE DOMINICAL 9:00 PM (MOCKED CLOCK)');
  console.log('======================================================================');

  // Datos iniciales de la semana Lun 09/11/2026 - Dom 15/11/2026 + pre-agendada semana siguiente
  const initialRecords: TestRecord[] = [
    {
      id: 'deg-miercoles-sem-actual',
      date: '2026-11-11', // Miércoles de la semana que cierra
      shift: 'MAÑANA',
      createdAt: '2026-11-10T13:00:00.000Z',
      status: 'PENDIENTE',
      enHistorial: false,
      isArchived: false,
      sourceTable: 'surveys',
    },
    {
      id: 'deg-sabado-sem-actual',
      date: '2026-11-14', // Sábado de la semana que cierra
      shift: 'TARDE',
      createdAt: '2026-11-12T15:00:00.000Z',
      status: 'PROGRAMADO',
      enHistorial: false,
      isArchived: false,
      sourceTable: 'surveys',
    },
    {
      id: 'deg-martes-proxima-semana',
      date: '2026-11-17', // Creada el viernes 13/11 pero programada para el martes 17/11 (> domingo 15/11)
      shift: 'TARDE',
      createdAt: '2026-11-13T18:30:00.000Z',
      status: 'PROGRAMADO',
      enHistorial: false,
      isArchived: false,
      sourceTable: 'surveys',
    },
  ];

  // Guardia previa: Domingo 20:59:59 America/Caracas (00:59:59 UTC del lunes) -> AÚN NO DEBE ARCHIVAR
  const sunday859PmCaracas = new Date('2026-11-16T00:59:59.000Z');
  const preWindowRun = executeDeterministicWeeklyCutoff({
    records: initialRecords,
    now: sunday859PmCaracas,
    timeZone: DEFAULT_BUSINESS_TIMEZONE,
  });
  assert.equal(preWindowRun.skippedOutsideWindow, true);
  assert.equal(preWindowRun.archivedCount, 0);

  // =========================================================================
  // CASO 1 & CASO 2: DOMINGO 9:00 PM EN PUNTO (`America/Caracas` = Lunes 01:00 UTC)
  // =========================================================================
  const sunday900PmCaracas = new Date('2026-11-16T01:00:00.000Z'); // 2026-11-15 21:00:00 -04:00
  const ctxSunday9Pm = resolveSundayCutoffContext(sunday900PmCaracas, DEFAULT_BUSINESS_TIMEZONE);
  assert.equal(ctxSunday9Pm.fechaCorteDomingo, '2026-11-15');
  assert.equal(ctxSunday9Pm.isoDayOfWeek, 7);
  assert.equal(ctxSunday9Pm.localHour, 21);
  assert.equal(ctxSunday9Pm.isWithinScheduledWindow, true);

  const firstSundayRun = executeDeterministicWeeklyCutoff({
    records: initialRecords,
    existingLogs: [],
    now: sunday900PmCaracas,
    timeZone: DEFAULT_BUSINESS_TIMEZONE,
    idGenerator: () => 'log-2026-11-15-001',
  });

  assert.equal(firstSundayRun.ok, true);
  assert.equal(firstSundayRun.skippedOutsideWindow, false);
  assert.equal(firstSundayRun.idempotentNoop, false);
  assert.equal(firstSundayRun.fechaCorteDomingo, '2026-11-15');
  assert.equal(firstSundayRun.archivedCount, 2);

  // Caso 1: Miércoles y sábado de la semana que cierra pasaron a Historial con estado preservado
  const wedAfter = firstSundayRun.updatedRecords.find((r) => r.id === 'deg-miercoles-sem-actual')!;
  const satAfter = firstSundayRun.updatedRecords.find((r) => r.id === 'deg-sabado-sem-actual')!;
  assert.equal(wedAfter.enHistorial, true);
  assert.equal(wedAfter.motivoArchivo, MOTIVO_CIERRE_DOMINGO_9PM);
  assert.equal(wedAfter.status, 'PENDIENTE', 'Debe preservar estado PENDIENTE en Historial');
  assert.equal(satAfter.enHistorial, true);
  assert.equal(satAfter.motivoArchivo, MOTIVO_CIERRE_DOMINGO_9PM);
  assert.equal(satAfter.status, 'PROGRAMADO', 'Debe preservar estado PROGRAMADO en Historial');
  console.log('✓ [CASO 1] Degustaciones de miércoles y sábado pasaron a Historial el domingo 9:00 PM.');

  // Caso 2: Degustación agendada el viernes para el martes siguiente permanece en Degustaciones
  const nextTueAfter = firstSundayRun.updatedRecords.find(
    (r) => r.id === 'deg-martes-proxima-semana'
  )!;
  assert.equal(nextTueAfter.enHistorial, false);
  assert.equal(nextTueAfter.isArchived, false);
  assert.equal(nextTueAfter.motivoArchivo ?? null, null);
  console.log(
    '✓ [CASO 2] Degustación pre-agendada para el martes siguiente (> domingo) permaneció intacta en Degustaciones.'
  );

  // =========================================================================
  // CASO 4: DOBLE EJECUCIÓN CONSECUTIVA EL MISMO DOMINGO 9:00 PM (IDEMPOTENCIA)
  // =========================================================================
  const sunday900PmRetry = new Date('2026-11-16T01:00:05.000Z'); // 5 segundos después
  const secondSundayRun = executeDeterministicWeeklyCutoff({
    records: firstSundayRun.updatedRecords,
    existingLogs: firstSundayRun.auditLogs,
    now: sunday900PmRetry,
    timeZone: DEFAULT_BUSINESS_TIMEZONE,
    idGenerator: () => 'log-duplicado-prohibido',
  });

  assert.equal(secondSundayRun.ok, true);
  assert.equal(secondSundayRun.idempotentNoop, true);
  assert.equal(secondSundayRun.archivedCount, 0, 'Segunda corrida debe afectar 0 registros');
  assert.equal(
    secondSundayRun.auditLogs.length,
    1,
    'No debe duplicar entradas en cierres_semanales_log'
  );
  assert.equal(secondSundayRun.auditLogs[0]!.id, 'log-2026-11-15-001');
  assert.equal(secondSundayRun.auditLogs[0]!.registros_archivados, 2);
  console.log(
    '✓ [CASO 4] Doble ejecución consecutiva el domingo 9:00 PM es 100% idempotente (0 filas, 0 duplicados en log).'
  );

  // =========================================================================
  // CASO 3: LUNES 8:00 AM • NUEVA DEGUSTACIÓN CREADA PARA LA SEMANA EN CURSO
  // =========================================================================
  const monday800AmCaracas = '2026-11-16T12:00:00.000Z'; // Lunes 16/11/2026 08:00 AM America/Caracas
  const mondayDataset: TestRecord[] = [
    ...secondSundayRun.updatedRecords,
    {
      id: 'deg-jueves-nueva-lunes-8am',
      date: '2026-11-19', // Jueves de la nueva semana en curso
      shift: 'MAÑANA',
      createdAt: monday800AmCaracas,
      status: 'PENDIENTE',
      enHistorial: false,
      isArchived: false,
      sourceTable: 'surveys',
    },
    {
      id: 'deg-martes-manana-nueva-lunes-8am',
      date: '2026-11-17', // Martes mañana de la nueva semana en curso
      shift: 'MAÑANA',
      createdAt: monday800AmCaracas,
      status: 'PENDIENTE',
      enHistorial: false,
      isArchived: false,
      sourceTable: 'surveys',
    },
  ];

  const mondayActiveTab = selectActiveDegustacionesTabItems(mondayDataset);
  const mondayHistorialTab = selectHistorialTabItems(mondayDataset);

  assert.deepEqual(
    mondayActiveTab.map((r) => r.id),
    [
      'deg-martes-manana-nueva-lunes-8am', // 2026-11-17 MAÑANA
      'deg-martes-proxima-semana', // 2026-11-17 TARDE
      'deg-jueves-nueva-lunes-8am', // 2026-11-19 MAÑANA
    ],
    'El lunes a las 8:00 AM solo deben verse en Degustaciones las actividades de la semana en curso en orden cronológico'
  );
  assert.deepEqual(
    mondayHistorialTab.map((r) => r.id),
    ['deg-sabado-sem-actual', 'deg-miercoles-sem-actual'],
    'Las degustaciones de la semana cerrada permanecen en Historial ordenadas DESC'
  );
  console.log(
    '✓ [CASO 3] Lunes 8:00 AM ingresa y muestra únicamente las degustaciones de la semana en curso en orden cronológico.'
  );

  // =========================================================================
  // SEGURIDAD HTTP CRON (`crypto.timingSafeEqual` + `401 Unauthorized`)
  // =========================================================================
  await testHttpCronEndpointSecurity();
  console.log(
    '✓ [SEGURIDAD HTTP] Endpoint /api/cron/degustaciones-cierre-semanal validado con crypto.timingSafeEqual y rechazo 401.'
  );

  // =========================================================================
  // AUDITORÍA ESTÁTICA DE MIGRACIÓN SQL FASE 2 Y `.env.example`
  // =========================================================================
  const rootDir = process.cwd();
  const sqlFase2 = fs.readFileSync(
    path.join(rootDir, 'supabase', 'migrations', '20261112000300_fase2_cierre_dominical_cron.sql'),
    'utf8'
  );
  assert.ok(sqlFase2.includes('SET search_path = public'), 'Función SQL debe fijar search_path');
  assert.ok(
    /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.ejecutar_cierre_dominical_degustaciones\(TIMESTAMPTZ,\s*TEXT,\s*BOOLEAN\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i.test(
      sqlFase2
    ),
    'Función SQL debe revocar permisos a PUBLIC, anon y authenticated'
  );
  assert.ok(
    sqlFase2.includes(`'${PG_CRON_SUNDAY_9PM_CARACAS_UTC}'`),
    'pg_cron debe programar 0 1 * * 1 (Domingo 21:00 America/Caracas)'
  );
  assert.ok(
    sqlFase2.includes('cierres_semanales_log'),
    'Debe crear y alimentar la bitácora cierres_semanales_log'
  );
  assert.equal(
    /\bDELETE\s+FROM\s+(?:public\.)?(?:surveys|cronograma_degustaciones)\b/i.test(sqlFase2),
    false,
    'Prohibido DELETE sobre registros de degustaciones'
  );

  const envExample = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');
  assert.ok(envExample.includes('CRON_SECRET='), '.env.example debe documentar CRON_SECRET=');
  assert.ok(
    envExample.includes('APP_TIMEZONE=America/Caracas'),
    '.env.example debe documentar APP_TIMEZONE=America/Caracas'
  );
  assert.equal(
    envExample.includes('VITE_CRON_SECRET'),
    false,
    'CRON_SECRET jamás debe exponerse con prefijo VITE_'
  );
  console.log('✓ [SEGURIDAD SQL & ENV] Migración pg_cron, privilegios y .env.example verificados.');
  console.log('======================================================================');
  console.log('FASE 2 VERIFICADA CON ÉXITO (100% PASS)');
  console.log('======================================================================');
}

runFase2Verification().catch((err) => {
  console.error('[FALLO EN VERIFICACIÓN FASE 2]:', err);
  process.exit(1);
});
