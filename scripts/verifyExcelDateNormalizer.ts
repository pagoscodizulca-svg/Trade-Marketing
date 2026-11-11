import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as XLSX from 'xlsx';
import {
  EMPTY_NORMALIZED_DATE,
  MAX_DATE_INPUT_LENGTH,
  formatToDdMmYyyy,
  matchesDateFilter,
  normalizeDateRangeBounds,
  normalizeExcelDate,
  sanitizeDateInput,
} from '../src/utils/excelDateNormalizer';
import { extractTabularDegustacionFile } from '../src/utils/degustacionesTabularParser';
import { normalizeAnyDateToYmd } from '../src/utils/weekCalendar';
import { formatDateSlash } from '../src/services/supabaseModule1';
import { matrizAEntregas } from '../ruta-degustacion/src/utils/csvImport';

async function runExcelDateVerification() {
  console.log('=========================================================================');
  console.log('🧪 SUITE DE VERIFICACIÓN: NORMALIZACIÓN SILENCIOSA DE FECHAS EXCEL Y FILTRO');
  console.log('=========================================================================\n');

  // ---------------------------------------------------------------------------
  // 1. Catálogo universal de 25+ formatos de entrada -> dd-mm-aaaa y aaaa-mm-dd
  // ---------------------------------------------------------------------------
  const validCases: Array<{
    label: string;
    input: unknown;
    expectedDdMmYyyy: string;
    expectedIso: string;
  }> = [
    // Fechas escritas en letras en español e inglés (completas)
    {
      label: 'Español completo minúsculas con "de"',
      input: '5 de marzo de 2026',
      expectedDdMmYyyy: '05-03-2026',
      expectedIso: '2026-03-05',
    },
    {
      label: 'Español completo con mayúsculas y "del"',
      input: '15 de Noviembre del 2026',
      expectedDdMmYyyy: '15-11-2026',
      expectedIso: '2026-11-15',
    },
    {
      label: 'Español estilo anglosajón con coma ("Marzo 5, 2026")',
      input: 'Marzo 5, 2026',
      expectedDdMmYyyy: '05-03-2026',
      expectedIso: '2026-03-05',
    },
    {
      label: 'Español con día de semana al inicio y coma',
      input: 'lunes, 02 de octubre de 2026',
      expectedDdMmYyyy: '02-10-2026',
      expectedIso: '2026-10-02',
    },
    {
      label: 'Español en mayúsculas con tilde en día de semana',
      input: 'MIÉRCOLES 18 DE FEBRERO DEL 2026',
      expectedDdMmYyyy: '18-02-2026',
      expectedIso: '2026-02-18',
    },
    // Fechas abreviadas (con/sin punto, mayúsculas/minúsculas, 2 o 4 dígitos de año, ES/EN)
    {
      label: 'Abreviada con guiones ("5-mar-2026")',
      input: '5-mar-2026',
      expectedDdMmYyyy: '05-03-2026',
      expectedIso: '2026-03-05',
    },
    {
      label: 'Abreviada con barras, punto y año de 2 dígitos ("05/sep./26")',
      input: '05/sep./26',
      expectedDdMmYyyy: '05-09-2026',
      expectedIso: '2026-09-05',
    },
    {
      label: 'Abreviada con espacios ("12 ene 2026")',
      input: '12 ene 2026',
      expectedDdMmYyyy: '12-01-2026',
      expectedIso: '2026-01-12',
    },
    {
      label: 'Abreviada español diciembre 2 dígitos ("20-dic-26")',
      input: '20-dic-26',
      expectedDdMmYyyy: '20-12-2026',
      expectedIso: '2026-12-20',
    },
    {
      label: 'Abreviada en inglés ("14 aug 2026")',
      input: '14 aug 2026',
      expectedDdMmYyyy: '14-08-2026',
      expectedIso: '2026-08-14',
    },
    {
      label: 'Inglés completo con ordinal ("November 3rd, 2026")',
      input: 'November 3rd, 2026',
      expectedDdMmYyyy: '03-11-2026',
      expectedIso: '2026-11-03',
    },
    {
      label: 'Abreviada sept con mayúsculas y NBSP ("07\u00A0SEPT.\u00A02026")',
      input: '07\u00A0SEPT.\u00A02026',
      expectedDdMmYyyy: '07-09-2026',
      expectedIso: '2026-09-07',
    },
    // Números seriales nativos de Excel (enteros, flotantes con fracción horaria y en cadena)
    {
      label: 'Serial nativo Excel entero (46337 -> 11-11-2026)',
      input: 46337,
      expectedDdMmYyyy: '11-11-2026',
      expectedIso: '2026-11-11',
    },
    {
      label: 'Serial nativo Excel flotante con hora (46337.54 -> 11-11-2026 sin desfase UTC-4)',
      input: 46337.54,
      expectedDdMmYyyy: '11-11-2026',
      expectedIso: '2026-11-11',
    },
    {
      label: 'Serial Excel como cadena decimal con coma ("46337,89")',
      input: '46337,89',
      expectedDdMmYyyy: '11-11-2026',
      expectedIso: '2026-11-11',
    },
    {
      label: 'Serial Excel correspondiente a 05-03-2026 (46086)',
      input: 46086,
      expectedDdMmYyyy: '05-03-2026',
      expectedIso: '2026-03-05',
    },
    // Cadenas numéricas con separadores mixtos
    {
      label: 'ISO con guiones ("2026-11-15")',
      input: '2026-11-15',
      expectedDdMmYyyy: '15-11-2026',
      expectedIso: '2026-11-15',
    },
    {
      label: 'ISO con barras ("2026/11/15")',
      input: '2026/11/15',
      expectedDdMmYyyy: '15-11-2026',
      expectedIso: '2026-11-15',
    },
    {
      label: 'Formato local con barras ("15/11/2026")',
      input: '15/11/2026',
      expectedDdMmYyyy: '15-11-2026',
      expectedIso: '2026-11-15',
    },
    {
      label: 'Formato con puntos ("15.11.2026")',
      input: '15.11.2026',
      expectedDdMmYyyy: '15-11-2026',
      expectedIso: '2026-11-15',
    },
    {
      label: 'Formato ambiguo corto con prioridad local dd-mm-aa ("5-11-26")',
      input: '5-11-26',
      expectedDdMmYyyy: '05-11-2026',
      expectedIso: '2026-11-05',
    },
    {
      label: 'Detección automática mm-dd-aaaa cuando segundo bloque > 12 ("11/25/2026")',
      input: '11/25/2026',
      expectedDdMmYyyy: '25-11-2026',
      expectedIso: '2026-11-25',
    },
    // Objetos Date nativos e ISO con timestamp UTC medianoche
    {
      label: 'Cadena ISO UTC medianoche sin restar 1 día ("2026-11-15T00:00:00.000Z")',
      input: '2026-11-15T00:00:00.000Z',
      expectedDdMmYyyy: '15-11-2026',
      expectedIso: '2026-11-15',
    },
    {
      label: 'Objeto Date nativo en medianoche UTC (Date.UTC(2026, 10, 15))',
      input: new Date(Date.UTC(2026, 10, 15, 0, 0, 0)),
      expectedDdMmYyyy: '15-11-2026',
      expectedIso: '2026-11-15',
    },
    {
      label: 'Año bisiesto válido ("29/02/2024")',
      input: '29/02/2024',
      expectedDdMmYyyy: '29-02-2024',
      expectedIso: '2024-02-29',
    },
  ];

  for (const tc of validCases) {
    const out = normalizeExcelDate(tc.input);
    assert.equal(out.isValid, true, `[${tc.label}] debe ser válida`);
    assert.equal(out.fechaFormateada, tc.expectedDdMmYyyy, `[${tc.label}] formato dd-mm-aaaa`);
    assert.equal(out.fechaIso, tc.expectedIso, `[${tc.label}] clave canónica ISO`);
    assert.ok(
      typeof out.fechaTimestamp === 'number' && Number.isFinite(out.fechaTimestamp),
      `[${tc.label}] timestamp UTC numérico`
    );
    assert.equal(Object.isFrozen(out), true, `[${tc.label}] resultado inmutable (frozen)`);
    assert.match(out.fechaFormateada, /^\d{2}-\d{2}-\d{4}$/);
  }
  console.log(`✅ [1/6] ${validCases.length} formatos universales transformados silenciosamente a dd-mm-aaaa.`);

  // ---------------------------------------------------------------------------
  // 2. Celdas vacías, nulas, corruptas y fechas de calendario inexistentes
  // ---------------------------------------------------------------------------
  const invalidOrEmptyInputs: unknown[] = [
    '',
    '   ',
    '\u00A0\u200B',
    null,
    undefined,
    false,
    true,
    NaN,
    Infinity,
    -45,
    'N/A',
    'n/a',
    'SIN FECHA',
    'POR DEFINIR',
    'PENDIENTE',
    '---',
    'TEXTO BASURA SIN NUMEROS',
    '29/02/2026', // 2026 no es bisiesto
    '31/11/2026', // Noviembre tiene 30 días
    '32/01/2026',
    '15/15/2026',
    new Date('invalid'),
  ];

  for (const raw of invalidOrEmptyInputs) {
    const out = normalizeExcelDate(raw);
    assert.equal(out.isValid, false, `Entrada inválida debe marcar isValid=false: ${String(raw)}`);
    assert.equal(out.fechaFormateada, '', 'Entrada inválida no debe emitir basura visual');
    assert.equal(out.fechaIso, null);
    assert.equal(out.fechaTimestamp, null);
    assert.equal(formatToDdMmYyyy(raw), '');
  }
  assert.equal(Object.isFrozen(EMPTY_NORMALIZED_DATE), true);
  console.log(`✅ [2/6] ${invalidOrEmptyInputs.length} celdas vacías/corruptas/inexistentes manejadas silenciosamente sin excepciones.`);

  // ---------------------------------------------------------------------------
  // 3. Seguridad: Anti-ReDoS, sanitización de longitud (<= 100) y Anti-Prototype Pollution
  // ---------------------------------------------------------------------------
  const hugeMaliciousInput = `${'5 de marzo de '.repeat(5000)}2026`;
  const sanitizedHuge = sanitizeDateInput(hugeMaliciousInput);
  assert.ok(
    sanitizedHuge.length <= MAX_DATE_INPUT_LENGTH,
    `La entrada sanitizada debe truncarse a máximo ${MAX_DATE_INPUT_LENGTH} caracteres`
  );

  const t0 = performance.now();
  for (let i = 0; i < 200; i++) {
    normalizeExcelDate(hugeMaliciousInput);
    normalizeExcelDate('1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1/1');
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(
    elapsedMs < 150,
    `Evaluación Anti-ReDoS (400 llamadas hostiles) debe ser lineal O(n), tardó ${elapsedMs.toFixed(2)}ms`
  );

  const protoPayloads: unknown[] = [
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    '12 __proto__ 2026',
    JSON.parse('{"__proto__":{"polluted":"yes"}}'),
    () => 'evil',
    Symbol('sym'),
  ];
  for (const payload of protoPayloads) {
    const res = normalizeExcelDate(payload);
    assert.equal(res.isValid, false);
  }
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    'Object.prototype jamás debe contaminarse'
  );
  console.log(`✅ [3/6] Blindaje Anti-ReDoS (${elapsedMs.toFixed(1)}ms / 400 pruebas) y Anti-Prototype Pollution verificado.`);

  // ---------------------------------------------------------------------------
  // 4. Reparación definitiva del Filtro de Fechas (mismo día desde===hasta, rangos y mixtos)
  // ---------------------------------------------------------------------------
  const dataset = [
    { id: 1, raw: '5 de marzo de 2026' },       // 05-03-2026
    { id: 2, raw: 46337.75 },                   // 11-11-2026
    { id: 3, raw: '15 de Noviembre del 2026' }, // 15-11-2026
    { id: 4, raw: '2026-11-15T00:00:00.000Z' }, // 15-11-2026
    { id: 5, raw: '20-dic-26' },                // 20-12-2026
    { id: 6, raw: 'N/A' },                      // Inválida -> ignorada sin romper filtro
    { id: 7, raw: null },                       // Vacía -> ignorada sin romper filtro
  ].map((row) => ({
    ...row,
    normalized: normalizeExcelDate(row.raw),
  }));

  // Caso crítico: Rango de un mismo día (desde === hasta === 15-11-2026) escrito en distintos formatos
  const sameDayBounds = normalizeDateRangeBounds({
    desde: '15/11/2026',
    hasta: '2026-11-15',
  });
  assert.equal(sameDayBounds.hasActiveFilter, true);
  assert.equal(sameDayBounds.isFilterInvalid, false);
  assert.ok(
    sameDayBounds.desdeMs !== null &&
      sameDayBounds.hastaMs !== null &&
      sameDayBounds.hastaMs - sameDayBounds.desdeMs === 86_399_999,
    'El rango de un mismo día debe cubrir [00:00:00.000, 23:59:59.999] UTC'
  );

  const sameDayMatches = dataset.filter((r) =>
    matchesDateFilter(
      r.raw,
      { desde: '15-11-2026', hasta: '15 de noviembre de 2026' },
      r.normalized.fechaTimestamp
    )
  );
  assert.deepEqual(
    sameDayMatches.map((r) => r.id),
    [3, 4],
    'Filtro mismo día (desde === hasta) debe incluir todos los registros del 15-11-2026'
  );

  // Rango amplio entre noviembre y diciembre
  const novDecMatches = dataset.filter((r) =>
    matchesDateFilter(
      r.raw,
      { desde: '01-11-2026', hasta: '31-12-2026' },
      r.normalized.fechaTimestamp
    )
  );
  assert.deepEqual(novDecMatches.map((r) => r.id), [2, 3, 4, 5]);

  // Rango invertido accidentalmente por el usuario (desde > hasta) -> auto-ordenado sin fallar
  const invertedRangeMatches = dataset.filter((r) =>
    matchesDateFilter(
      r.raw,
      { desde: '15-11-2026', hasta: '05-03-2026' },
      r.normalized.fechaTimestamp
    )
  );
  assert.deepEqual(invertedRangeMatches.map((r) => r.id), [1, 2, 3, 4]);

  // Sin filtro activo -> devuelve todas las filas (incluidas las sin fecha para edición en bandeja)
  const unfilteredMatches = dataset.filter((r) =>
    matchesDateFilter(r.raw, { desde: '', hasta: '' }, r.normalized.fechaTimestamp)
  );
  assert.equal(unfilteredMatches.length, dataset.length);
  console.log('✅ [4/6] Filtro matemático de fechas (mismo día inclusivo, rangos mixtos y celdas N/A seguras) verificado.');

  // ---------------------------------------------------------------------------
  // 5. Consistencia transversal en utilidades del proyecto (weekCalendar, supabaseModule1, ruta-degustacion)
  // ---------------------------------------------------------------------------
  assert.equal(normalizeAnyDateToYmd('15 de Noviembre del 2026'), '2026-11-15');
  assert.equal(normalizeAnyDateToYmd('05-03-2026'), '2026-03-05');
  assert.equal(formatDateSlash('2026-11-15T00:00:00.000Z'), '15-11-2026');
  assert.equal(formatDateSlash('5 de marzo de 2026'), '05-03-2026');

  const choferImport = matrizAEntregas([
    ['FECHA', 'TURNO', 'CLIENTE', 'PRODUCTO', 'VENDEDOR', 'PROMOTORA'],
    ['5 de marzo de 2026', 'MAÑANA', 'FIORELLA NORTE', 'MORTADELA', 'CARLOS', 'JULIANNYS'],
    [46337, 'TARDE', 'ENNE FUERZAS ARMADAS', 'ESPALDA', 'LUIS', 'SCARLETH'],
  ]);
  assert.equal(choferImport.errors.length, 0);
  assert.equal(choferImport.rows[0]?.fecha, '05-03-2026');
  assert.equal(choferImport.rows[1]?.fecha, '11-11-2026');
  console.log('✅ [5/6] Integración con weekCalendar, supabaseModule1 y ruta-degustacion verificada.');

  // ---------------------------------------------------------------------------
  // 6. Prueba de extremo a extremo con archivo binario Excel (.xlsx) heterogéneo
  // ---------------------------------------------------------------------------
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['FECHA', 'TURNO', 'CLIENTE', 'PRODUCTO', 'KILOS', 'VENDEDOR', 'PROMOTORA'],
    ['5 de marzo de 2026', 'MAÑANA', 'FIORELLA NORTE', 'MORTADELA', 3, 'CARLOS', ''],
    [46337.54, 'TARDE', 'ENNE FUERZAS ARMADAS', 'ESPALDA', 2.5, 'LUIS', ''],
    ['05/sep./26', 'MAÑANA', 'DE CANDIDO EXPRESS', 'CHORIZO', 2, 'ANA', ''],
    ['25/11/2026', 'TARDE', 'HIPER LIDER', 'MORTADELA', 4, 'PEDRO', ''],
    ['2026-11-15T00:00:00.000Z', 'MAÑANA', 'FAMILIA CENTER', 'ARROZ VENCAMPO', 5, 'JOSE', ''],
    ['SIN FECHA', 'TARDE', 'TIENDA PENDIENTE', 'MORTADELA', 2, 'MARCOS', ''],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Planificacion');
  const xlsxBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const parsedXlsx = await extractTabularDegustacionFile(xlsxBuf, 'xlsx', {
    fileName: 'Lote_Mixto_2026.xlsx',
  });
  assert.equal(parsedXlsx.rows.length, 6);
  assert.equal(parsedXlsx.rows[0]!.fechaFormateada, '05-03-2026');
  assert.equal(parsedXlsx.rows[1]!.fechaFormateada, '11-11-2026');
  assert.equal(parsedXlsx.rows[2]!.fechaFormateada, '05-09-2026');
  assert.equal(parsedXlsx.rows[3]!.fechaFormateada, '25-11-2026');
  assert.equal(parsedXlsx.rows[4]!.fechaFormateada, '15-11-2026');
  assert.equal(parsedXlsx.rows[5]!.fechaFormateada, '');
  assert.equal(parsedXlsx.rows[5]!.fecha, '');
  assert.equal(parsedXlsx.rows[5]!.fechaTimestamp, null);
  console.log('✅ [6/6] Extracción extremo a extremo de libro .xlsx heterogéneo verificada.\n');

  console.log('=========================================================================');
  console.log('🎉 TODAS LAS PRUEBAS DE FECHAS EXCEL Y FILTRADO PASARON CON 0 ERRORES.');
  console.log('=========================================================================');
}

runExcelDateVerification().catch((err) => {
  console.error('❌ Falló la suite de fechas Excel:', err);
  process.exit(1);
});
