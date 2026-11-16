import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  classifyTastingByCaracasWeek,
  extractCaracasWallClockParts,
  getCaracasWeekCycleBounds,
  getPastCaracasWeeksRange,
  isTastingInPastCaracasWeek,
  partitionTastingsByCaracasWeek,
  resolveTastingEventCaracasYmd,
} from '../src/utils/caracasWeekCycle';
import {
  assertCanMutateTastingByWeekCycle,
  DEFAULT_HISTORIAL_PAGE_SIZE,
  escapeIlikePattern,
  HistoricalTastingLockError,
  HistorialPaginationFilterInputSchema,
  MAX_HISTORIAL_PAGE_SIZE,
  paginateSanitizedHistorialCollection,
  queryServerPaginatedHistorialSurveys,
  validateAndResolveHistorialQueryWindow,
} from '../src/services/degustacionesWeeklyCycleService';

async function runCicloSemanalVerification(): Promise<void> {
  console.log('======================================================================');
  console.log('VERIFICACIÓN UNITARIA E INTEGRAL: CICLO SEMANAL ISO (America/Caracas)');
  console.log('======================================================================');

  // --------------------------------------------------------------------------
  // 1. CASO BORDE CRÍTICO A: Domingo 23:59:59 y 23:59:59.999 en America/Caracas
  //    En UTC puro ya es Lunes 2026-11-16T03:59:59.999Z, pero en Caracas (UTC-4)
  //    sigue siendo Domingo 2026-11-15 23:59:59.999 -> DEBE seguir en Semana en Curso.
  // --------------------------------------------------------------------------
  const sundayLastSecondUtc = '2026-11-16T03:59:59.000Z';
  const sundayLastMillisecondUtc = '2026-11-16T03:59:59.999Z';

  const partsSundayEnd = extractCaracasWallClockParts(sundayLastSecondUtc);
  assert.equal(partsSundayEnd.ymd, '2026-11-15');
  assert.equal(partsSundayEnd.hour, 23);
  assert.equal(partsSundayEnd.minute, 59);
  assert.equal(partsSundayEnd.second, 59);

  const boundsSundayEnd = getCaracasWeekCycleBounds(sundayLastMillisecondUtc);
  assert.equal(boundsSundayEnd.todayCaracasYmd, '2026-11-15');
  assert.equal(boundsSundayEnd.isoWeekday, 7, 'Domingo debe ser día ISO 7');
  assert.equal(boundsSundayEnd.inicioSemanaActualYmd, '2026-11-09');
  assert.equal(boundsSundayEnd.finSemanaActualYmd, '2026-11-15');
  assert.equal(boundsSundayEnd.msUntilNextRollover, 1, 'Falta exactamente 1 ms para Lunes 00:00 Caracas');

  const sundayRecordAtSunday2359 = classifyTastingByCaracasWeek(
    '2026-11-15',
    sundayLastSecondUtc
  );
  assert.equal(
    sundayRecordAtSunday2359.bucket,
    'BANDEJA_ENTRADA',
    'A las 23:59:59 del domingo en Caracas, la degustación del domingo pertenece a Semana en Curso'
  );

  const sundayTimestampRecordAtSunday2359 = classifyTastingByCaracasWeek(
    '2026-11-16T03:59:59Z', // 23:59:59 del domingo en Caracas expresado en UTC
    sundayLastMillisecondUtc
  );
  assert.equal(sundayTimestampRecordAtSunday2359.eventDateYmd, '2026-11-15');
  assert.equal(sundayTimestampRecordAtSunday2359.bucket, 'BANDEJA_ENTRADA');

  const mondayOpeningRecordEvaluatedSunday = classifyTastingByCaracasWeek(
    '2026-11-09',
    sundayLastSecondUtc
  );
  assert.equal(
    mondayOpeningRecordEvaluatedSunday.bucket,
    'BANDEJA_ENTRADA',
    'El lunes 2026-11-09 sigue en Semana en Curso hasta las 23:59:59.999 del domingo 2026-11-15'
  );
  console.log('✓ [1/6] Caso borde Domingo 23:59:59.999 America/Caracas (Lunes 03:59:59.999Z UTC) verificado.');

  // --------------------------------------------------------------------------
  // 2. CASO BORDE CRÍTICO B: Lunes 00:00:00.000 en America/Caracas
  //    Exactamente en `2026-11-16T04:00:00.000Z`, en Caracas inicia el Lunes
  //    2026-11-16 00:00:00.000 -> el registro del domingo anterior pasa de inmediato a Historial.
  // --------------------------------------------------------------------------
  const mondayZeroHourCaracasUtc = '2026-11-16T04:00:00.000Z';
  const boundsMondayStart = getCaracasWeekCycleBounds(mondayZeroHourCaracasUtc);

  assert.equal(boundsMondayStart.todayCaracasYmd, '2026-11-16');
  assert.equal(boundsMondayStart.isoWeekday, 1, 'Lunes debe ser día ISO 1');
  assert.equal(boundsMondayStart.inicioSemanaActualYmd, '2026-11-16');
  assert.equal(boundsMondayStart.finSemanaActualYmd, '2026-11-22');

  const prevSundayAtMonday0000 = classifyTastingByCaracasWeek(
    '2026-11-15',
    mondayZeroHourCaracasUtc
  );
  assert.equal(
    prevSundayAtMonday0000.bucket,
    'HISTORIAL',
    'A las 00:00:00 del lunes en Caracas, la degustación del domingo anterior pasa inmediatamente a Historial'
  );

  const prevSundayUtcTsAtMonday0000 = classifyTastingByCaracasWeek(
    '2026-11-16T03:59:59Z',
    mondayZeroHourCaracasUtc
  );
  assert.equal(prevSundayUtcTsAtMonday0000.eventDateYmd, '2026-11-15');
  assert.equal(prevSundayUtcTsAtMonday0000.bucket, 'HISTORIAL');

  const newMondayRecordAtMonday0000 = classifyTastingByCaracasWeek(
    '2026-11-16',
    mondayZeroHourCaracasUtc
  );
  assert.equal(
    newMondayRecordAtMonday0000.bucket,
    'BANDEJA_ENTRADA',
    'La degustación del nuevo lunes 2026-11-16 permanece limpia en Bandeja de Entrada'
  );
  assert.equal(isTastingInPastCaracasWeek('15/11/2026', mondayZeroHourCaracasUtc), true);
  assert.equal(resolveTastingEventCaracasYmd('2026-11-16T00:00:00Z'), '2026-11-16');
  console.log('✓ [2/6] Caso borde Lunes 00:00:00.000 America/Caracas -> transición inmediata a Historial verificada.');

  // --------------------------------------------------------------------------
  // 3. PARTICIÓN DISJUNTA SIN DUPLICADOS NI PÉRDIDAS + ORDENAMIENTO (ASC / DESC)
  // --------------------------------------------------------------------------
  const sampleDataset = [
    { id: 'deg-old-1', date: '2026-11-02', shift: 'MAÑANA', createdAt: '2026-11-02T12:00:00Z' },
    { id: 'deg-old-2', date: '2026-11-15', shift: 'TARDE', createdAt: '2026-11-15T18:00:00Z' },
    { id: 'deg-old-3', date: '2026-11-15', shift: 'MAÑANA', createdAt: '2026-11-15T20:00:00Z' },
    { id: 'deg-cur-1', date: '2026-11-18', shift: 'TARDE', createdAt: '2026-11-16T10:00:00Z' },
    { id: 'deg-cur-2', date: '2026-11-16', shift: 'MAÑANA', createdAt: '2026-11-16T08:00:00Z' },
    { id: 'deg-cur-3', date: '2026-11-22', shift: 'MAÑANA', createdAt: '2026-11-16T09:00:00Z' },
  ];

  const partitioned = partitionTastingsByCaracasWeek(sampleDataset, mondayZeroHourCaracasUtc);
  assert.equal(partitioned.bandejaEntrada.length, 3);
  assert.equal(partitioned.historial.length, 3);
  assert.equal(
    partitioned.bandejaEntrada.length + partitioned.historial.length,
    sampleDataset.length,
    'Cero pérdida de registros'
  );

  const inboxIds = new Set(partitioned.bandejaEntrada.map((i) => i.id));
  for (const h of partitioned.historial) {
    assert.equal(inboxIds.has(h.id), false, 'Prohibido duplicar registros entre Bandeja e Historial');
  }

  // Bandeja de Entrada: orden cronológico ASC (2026-11-16 -> 2026-11-18 -> 2026-11-22)
  assert.deepEqual(
    partitioned.bandejaEntrada.map((i) => i.id),
    ['deg-cur-2', 'deg-cur-1', 'deg-cur-3']
  );

  // Historial: orden DESC por fecha y desempate DESC por createdAt
  assert.deepEqual(
    partitioned.historial.map((i) => i.id),
    ['deg-old-3', 'deg-old-2', 'deg-old-1']
  );

  const prevWeekRange = getPastCaracasWeeksRange(1, mondayZeroHourCaracasUtc);
  assert.equal(prevWeekRange.dateFromYmd, '2026-11-09');
  assert.equal(prevWeekRange.dateToYmd, '2026-11-15');
  console.log('✓ [3/6] Partición disjunta (0 duplicados, 0 pérdidas) y orden ASC/DESC verificados.');

  // --------------------------------------------------------------------------
  // 4. VALIDACIÓN ZOD, SANITIZACIÓN DE FILTROS Y PAGINACIÓN SERVIDOR (25 / PÁGINA)
  // --------------------------------------------------------------------------
  assert.equal(DEFAULT_HISTORIAL_PAGE_SIZE, 25);
  assert.equal(MAX_HISTORIAL_PAGE_SIZE, 100);

  // Rechazo de fecha calendario inexistente (2026-02-30) y de inyección SQL en parámetro de fecha
  assert.throws(() =>
    HistorialPaginationFilterInputSchema.parse({ dateFrom: '2026-02-30' })
  );
  assert.throws(() =>
    HistorialPaginationFilterInputSchema.parse({ singleDate: "2026-11-10'; DROP TABLE surveys;--" })
  );
  assert.throws(() =>
    HistorialPaginationFilterInputSchema.parse({ pageSize: 500 })
  );

  // Escape seguro de comodines LIKE
  assert.equal(escapeIlikePattern('100%_Real\\Test'), '100\\%\\_Real\\\\Test');

  // Recorte automático del límite superior a `< inicioSemanaActualYmd`
  const clampedWindow = validateAndResolveHistorialQueryWindow(
    { dateFrom: '2026-11-01', dateTo: '2026-11-20' },
    mondayZeroHourCaracasUtc
  );
  assert.equal(clampedWindow.window.effectiveGteYmd, '2026-11-01');
  assert.equal(
    clampedWindow.window.effectiveLteYmd,
    '2026-11-15',
    'El filtro Hasta en Historial nunca puede invadir la Semana en Curso'
  );

  // Paginación de 60 elementos históricos en páginas de 25
  const sixtyOldItems = Array.from({ length: 60 }, (_, idx) => ({
    id: `hist-${idx + 1}`,
    date: `2026-10-${String((idx % 28) + 1).padStart(2, '0')}`,
    createdAt: `2026-10-28T10:${String(idx % 60).padStart(2, '0')}:00Z`,
  }));
  const page1 = paginateSanitizedHistorialCollection(sixtyOldItems, { page: 1 }, mondayZeroHourCaracasUtc);
  assert.equal(page1.pageSize, 25);
  assert.equal(page1.items.length, 25);
  assert.equal(page1.totalPages, 3);
  assert.equal(page1.startIndex, 1);
  assert.equal(page1.endIndex, 25);

  const page3 = paginateSanitizedHistorialCollection(sixtyOldItems, { page: 3 }, mondayZeroHourCaracasUtc);
  assert.equal(page3.items.length, 10);
  assert.equal(page3.startIndex, 51);
  assert.equal(page3.endIndex, 60);

  // Verificación de llamada parametrizada al SDK de Supabase (`.lt`, `.order`, `.range`)
  const recordedCalls: Array<{ method: string; args: unknown[] }> = [];
  const mockQueryBuilder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['select', 'eq', 'lt', 'gte', 'lte', 'ilike', 'order']) {
    mockQueryBuilder[method] = (...args: unknown[]) => {
      recordedCalls.push({ method, args });
      return mockQueryBuilder;
    };
  }
  mockQueryBuilder.range = (...args: unknown[]) => {
    recordedCalls.push({ method: 'range', args });
    return Promise.resolve({
      data: [
        {
          id: 'srv-row-1',
          type: 'Degustacion',
          date: '2026-11-14',
          fecha_evento: '2026-11-14',
          store: 'SUPERMERCADO ZULIA',
        },
      ],
      count: 42,
      error: null,
    });
  };
  const mockClient = {
    from: (table: string) => {
      recordedCalls.push({ method: 'from', args: [table] });
      return mockQueryBuilder;
    },
  } as unknown as SupabaseClient;

  const serverPage = await queryServerPaginatedHistorialSurveys(
    { page: 1, sellerFilter: 'CARLOS PEREZ' },
    { clientOverride: mockClient, referenceNow: mondayZeroHourCaracasUtc }
  );
  assert.equal(serverPage.totalCount, 42);
  assert.equal(serverPage.pageSize, 25);
  assert.equal(serverPage.totalPages, 2);
  assert.equal(serverPage.usedIndexedFechaEventoColumn, true);
  assert.ok(
    recordedCalls.some(
      (c) => c.method === 'lt' && c.args[0] === 'fecha_evento' && c.args[1] === '2026-11-16'
    ),
    'Debe aplicar filtro parametrizado .lt("fecha_evento", inicioSemanaActualYmd)'
  );
  assert.ok(
    recordedCalls.some((c) => c.method === 'range' && c.args[0] === 0 && c.args[1] === 24),
    'Debe solicitar exactamente el rango paginado 0..24 (25 registros)'
  );
  console.log('✓ [4/6] Validación Zod, escape LIKE y paginación en servidor (25/pág) verificados.');

  // --------------------------------------------------------------------------
  // 5. PROTECCIÓN DE INTEGRIDAD HISTÓRICA (RBAC)
  // --------------------------------------------------------------------------
  assert.throws(
    () =>
      assertCanMutateTastingByWeekCycle({
        eventDate: '2026-11-15',
        isStrictAdmin: false,
        referenceNow: mondayZeroHourCaracasUtc,
      }),
    (err: unknown) =>
      err instanceof HistoricalTastingLockError && err.statusCode === 403,
    'Usuario estándar NO puede modificar degustaciones de semanas anteriores'
  );

  // Administrador estricto sí está autorizado en contingencia auditada
  assert.doesNotThrow(() =>
    assertCanMutateTastingByWeekCycle({
      eventDate: '2026-11-15',
      isStrictAdmin: true,
      referenceNow: mondayZeroHourCaracasUtc,
    })
  );

  // Usuario estándar sí puede operar degustaciones de la Semana en Curso
  assert.doesNotThrow(() =>
    assertCanMutateTastingByWeekCycle({
      eventDate: '2026-11-16',
      isStrictAdmin: false,
      referenceNow: mondayZeroHourCaracasUtc,
    })
  );
  console.log('✓ [5/6] Guardia RBAC de integridad histórica (403 para no-admin) verificada.');

  // --------------------------------------------------------------------------
  // 6. AUDITORÍA ESTÁTICA DE SEGURIDAD (SQL NO DESTRUCTIVO, RLS RESTRICTIVE, CERO XSS)
  // --------------------------------------------------------------------------
  const rootDir = process.cwd();
  const sqlMigration = fs.readFileSync(
    path.join(
      rootDir,
      'supabase',
      'migrations',
      '20261113_ciclo_semanal_automatico_degustaciones.sql'
    ),
    'utf8'
  );
  assert.equal(
    /\b(?:DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE)\s+(?:public\.)?(?:surveys|cronograma_degustaciones|rutas_promotoras)\b/i.test(
      sqlMigration
    ),
    false,
    'Prohibido DELETE/TRUNCATE/DROP sobre tablas de degustaciones'
  );
  assert.ok(sqlMigration.includes("timezone('America/Caracas'"), 'SQL debe usar America/Caracas');
  assert.ok(sqlMigration.includes('AS RESTRICTIVE'), 'RLS histórica debe ser AS RESTRICTIVE');
  assert.ok(
    sqlMigration.includes('idx_surveys_degustacion_fecha_evento_desc'),
    'Debe crear índice B-tree compuesto para Historial DESC'
  );

  const viewSource = fs.readFileSync(
    path.join(rootDir, 'src', 'components', 'field', 'FieldPromotoraView.tsx'),
    'utf8'
  );
  assert.equal(
    /dangerouslySetInnerHTML|\.innerHTML\s*=|v-html/.test(viewSource),
    false,
    'Prohibido uso de dangerouslySetInnerHTML / innerHTML / v-html'
  );
  assert.ok(
    viewSource.includes('🔒 Registro Histórico (Cerrado)'),
    'UI debe mostrar distintivo visual de Registro Histórico (Cerrado)'
  );
  console.log('✓ [6/6] Auditoría estática de seguridad SQL, índices, RLS y anti-XSS verificada.');
  console.log('======================================================================');
  console.log('CICLO SEMANAL AUTOMÁTICO VERIFICADO CON ÉXITO (100% PASS)');
  console.log('======================================================================');
}

void runCicloSemanalVerification();
