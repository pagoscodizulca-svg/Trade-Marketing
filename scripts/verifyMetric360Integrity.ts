import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildLiveVenezuelaClock } from '../src/utils/weekCalendar';
import {
  buildMetric360CsvContent,
  canonicalStoreKey,
  canonicalZoneKey,
  computeMetric360Snapshot,
  escapeSafeCsvCell,
  getVenezuelaPeriodBounds,
  matchesVenezuelaTimeLens,
  resolveVenezuelaDateYmd,
  type Metric360SwitcherItem,
} from '../src/utils/metric360AnalyticsEngine';
import type { ScheduledVisit } from '../src/types';
import type { Module1SupabaseBundle } from '../src/services/supabaseModule1';

function parseCsvRowsSimple(csvWithBom: string): string[][] {
  assert.equal(csvWithBom.startsWith('\uFEFF'), true, 'CSV debe iniciar con BOM UTF-8 (\\uFEFF)');
  const clean = csvWithBom.slice(1);
  const lines = clean.split('\r\n').filter((l) => l.length > 0);
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  });
}

function runSuite(): void {
  // Reloj fijo en Jueves 12 de Noviembre de 2026 (Semana 46: Lunes 09/11 - Domingo 15/11)
  const liveClock = buildLiveVenezuelaClock('2026-11-12');
  assert.equal(liveClock.currentWeek.mondayYmd, '2026-11-09');
  assert.equal(liveClock.currentWeek.sundayYmd, '2026-11-15');

  // 1. Pruebas de bordes horarios exactos America/Caracas (UTC-4)
  const currentWeekBounds = getVenezuelaPeriodBounds(liveClock, 'SEMANA_ACTUAL');
  const prevWeekBounds = getVenezuelaPeriodBounds(liveClock, 'SEMANA_ANTERIOR');

  // Domingo 08/11 23:59:59.999 VET = Lunes 09/11 03:59:59.999Z -> pertenece a SEMANA_ANTERIOR, NO a SEMANA_ACTUAL
  assert.equal(
    matchesVenezuelaTimeLens('2026-11-09T03:59:59.999Z', prevWeekBounds),
    true,
    'Domingo 23:59:59.999 VET debe entrar en Semana Anterior'
  );
  assert.equal(
    matchesVenezuelaTimeLens('2026-11-09T03:59:59.999Z', currentWeekBounds),
    false,
    'Domingo 23:59:59.999 VET NO debe filtrarse en Semana Actual'
  );

  // Lunes 09/11 00:00:00.000 VET = 2026-11-09T04:00:00.000Z -> inicio inclusivo de SEMANA_ACTUAL
  assert.equal(
    matchesVenezuelaTimeLens('2026-11-09T04:00:00.000Z', currentWeekBounds),
    true,
    'Lunes 00:00:00.000 VET debe entrar en Semana Actual'
  );

  // Domingo 15/11 21:30:00 VET = 2026-11-16T01:30:00Z -> cierre nocturno dentro de SEMANA_ACTUAL
  assert.equal(resolveVenezuelaDateYmd('2026-11-16T01:30:00Z'), '2026-11-15');
  assert.equal(
    matchesVenezuelaTimeLens('2026-11-16T01:30:00Z', currentWeekBounds),
    true,
    'Timestamp UTC de madrugada lunes que equivale a domingo noche en Venezuela debe quedar en Semana Actual'
  );

  // Fechas calendario puras NO deben restar 1 día
  assert.equal(resolveVenezuelaDateYmd('2026-11-09'), '2026-11-09');
  assert.equal(resolveVenezuelaDateYmd('15/11/2026'), '2026-11-15');

  // 2. Deduplicación canónica Set y exclusión de placeholders
  assert.equal(
    canonicalStoreKey('Fiesta   Delicías'),
    canonicalStoreKey('FIESTA DELICIAS '),
    'Variantes con tildes y espacios múltiples deben producir la misma clave canónica'
  );
  assert.equal(canonicalStoreKey('PDV Sin Nombre'), null);
  assert.equal(canonicalZoneKey('Sin Zona'), null);

  // 3. Seguridad contra división por cero / nulos / NaN
  const switcherTemplate: Metric360SwitcherItem[] = [
    { id: 'degustaciones_bd', label: 'Degustaciones BD', badgeValue: '0' },
    { id: 'mortadela', label: 'Mortadela / Jamón', badgeValue: '0 un' },
    { id: 'espalda', label: 'Espalda Ahumada', badgeValue: '0 un' },
    { id: 'vencampo', label: 'Línea Vencampo', badgeValue: '0 un' },
    { id: 'encuestas_pdv', label: 'Encuestas PDV', badgeValue: '0' },
    { id: 'personal_activo', label: 'Personal Activo', badgeValue: '0' },
  ];

  const emptySnap = computeMetric360Snapshot({
    metricId: 'encuestas_pdv',
    timeLens: 'SEMANA_ACTUAL',
    switcherItems: switcherTemplate,
    visits: [],
    tastingItems: [],
    module1Bundle: null,
    liveClock,
    btlUnitCostUsd: 0,
  });
  assert.equal(emptySnap.surveyMetrics.totalSurveys, 0);
  assert.equal(emptySnap.surveyMetrics.avgRating, 0);
  assert.equal(emptySnap.surveyMetrics.highAcceptancePercent, 0);
  assert.equal(emptySnap.completionPct, 0);
  assert.equal(emptySnap.uniqueStoresCount, 0);
  assert.equal(Number.isNaN(emptySnap.avgOwnPrice), false);

  // 4. Cuadre matemático 1:1 entre Píldoras, KPIs y CSV en Mortadela y Encuestas PDV
  const mockVisits: ScheduledVisit[] = [
    {
      id: 'vis-1',
      solicitudId: 'sol-fdv-1',
      date: '2026-11-10',
      dayLabel: 'Martes 10',
      shift: 'MAÑANA',
      storeId: 'st-1',
      storeName: 'Fiesta Delicias',
      zone: 'Maracaibo Norte',
      productFocus: 'MORTADELA',
      promotoraId: 'pr-1',
      promotoraName: 'MARIA PEREZ',
      sellerName: 'CARLOS RUIZ',
      plannedUnits: 15,
      espaldaQty: 0,
      mortadelaQty: 15,
      arrozQty: 0,
      azucarGrams: 0,
      lecheGrams: 0,
      status: 'COMPLETADA',
    },
    {
      id: 'vis-2',
      date: '2026-11-11',
      dayLabel: 'Miércoles 11',
      shift: 'TARDE',
      storeId: 'st-1-dup',
      storeName: 'FIESTA   DELICÍAS ', // Mismo PDV con tilde y espacios -> Set debe contar 1 tienda!
      zone: 'MARACAIBO  NORTE',
      productFocus: 'MORTADELA',
      promotoraId: 'pr-1',
      promotoraName: 'MARIA PEREZ',
      sellerName: 'CARLOS RUIZ',
      plannedUnits: 8,
      espaldaQty: 0,
      mortadelaQty: 8,
      arrozQty: 0,
      azucarGrams: 0,
      lecheGrams: 0,
      status: 'PENDIENTE',
    },
    {
      id: 'vis-prev-week',
      date: '2026-11-04',
      dayLabel: 'Miércoles 04',
      shift: 'MAÑANA',
      storeId: 'st-2',
      storeName: 'Enne Fuerzas Armadas',
      zone: 'Maracaibo Norte',
      productFocus: 'MORTADELA',
      promotoraId: 'pr-2',
      promotoraName: 'LUISA GOMEZ',
      sellerName: 'PEDRO SOTO',
      plannedUnits: 5,
      espaldaQty: 0,
      mortadelaQty: 5,
      arrozQty: 0,
      azucarGrams: 0,
      lecheGrams: 0,
      status: 'COMPLETADA',
    },
  ];

  const mockBundle: Module1SupabaseBundle = {
    tastingItems: [
      {
        id: 'sol-fdv-1',
        date: '2026-11-10',
        timeRange: '08:00 - 12:00',
        activityTitle: 'Degustación Mortadela',
        productName: 'Mortadela Asturias',
        responsibleName: 'MARIA PEREZ',
        storeName: 'Fiesta Delicias',
        zone: 'Maracaibo Norte',
        status: 'COMPLETADO',
        currentSamples: 40,
        targetSamples: 50,
        sellerApplicant: 'CARLOS RUIZ',
        isArchived: false,
      },
    ],
    visitsForSchedule: [],
    visitsHistory: [],
    priceComparisons: [
      {
        id: 'pc-1',
        date: '2026-11-10',
        dateSlash: '10/11/2026',
        storeName: 'Fiesta Delicias',
        zone: 'Maracaibo Norte',
        promotora: 'MARIA PEREZ',
        origin: 'MARIA PEREZ',
        category: 'MORTADELAS',
        ownProduct: 'Mortadela Asturias 1kg',
        codizulcaSku: '',
        ownPriceUsd: 4.5,
        ownPriceBs: 200,
        competitorBrand: 'Plumrose',
        competitorProduct: 'Mortadela',
        competitorPriceUsd: 5.0,
        competitorPriceBs: 222,
        gapPercent: -10,
        observations: '',
        competitor1: { brand: 'Plumrose', product: 'Mortadela', priceUsd: 5.0, priceBs: 222, diffPercent: -10 },
        competitor2: { brand: '—', product: '—', priceUsd: 0, priceBs: 0, diffPercent: 0 },
        competitor3: { brand: '—', product: '—', priceUsd: 0, priceBs: 0, diffPercent: 0 },
        averageCompetitorPriceUsd: 5.0,
        averageCompetitorPriceBs: 222,
        overallDiffPercent: -10,
        status: 'SINCRONIZADO',
      },
    ],
    inventorySampling: [
      {
        id: 'inv-1',
        date: '2026-11-10',
        dateSlash: '10/11/2026',
        isoDate: '2026-11-10',
        storeName: 'Fiesta Delicias',
        zone: 'Maracaibo Norte',
        promotora: 'MARIA PEREZ',
        creatorEmail: '',
        productName: 'Mortadela Asturias',
        sku: '',
        unit: 'un',
        lotNumber: 'L1',
        initialStock: 30,
        openedUnits: 2,
        portionsPrepared: 60,
        portionsSampled: 55,
        assistedSales: 12,
        salesGenerated: 12,
        rotationPercent: 40,
        conversionRate: 21,
        finalStock: 18,
        observations: '',
        status: 'OK',
      },
    ],
    attendanceRecords: [],
    merchandisingRecords: [],
    staffMembers: [],
    consumerSurveys: [
      {
        id: 'srv-1',
        surveyType: 'Breve',
        date: '2026-11-10',
        dayLabel: 'Martes 10',
        shift: 'MAÑANA',
        storeName: 'Fiesta Delicias',
        zone: 'Maracaibo Norte',
        promotora: 'MARIA PEREZ',
        productName: 'Mortadela Asturias',
        rating: 5,
        highAcceptance: true,
        acceptanceLabel: 'ALTA',
        purchaseIntent: 'Sí compró',
      },
      {
        id: 'srv-2',
        surveyType: 'Profunda',
        date: '2026-11-15',
        dayLabel: 'Domingo 15',
        shift: 'TARDE',
        storeName: 'FIESTA   DELICÍAS',
        zone: 'Maracaibo Norte',
        promotora: 'MARIA PEREZ',
        productName: 'Mortadela Asturias',
        rating: 4,
        highAcceptance: true,
        acceptanceLabel: 'ALTA',
        purchaseIntent: 'Alta',
        createdAt: '2026-11-16T01:20:00Z', // Domingo 21:20 VET!
      },
      {
        id: 'srv-prev',
        surveyType: 'Breve',
        date: '2026-11-05',
        dayLabel: 'Jueves 05',
        shift: 'MAÑANA',
        storeName: 'Enne Fuerzas Armadas',
        zone: 'Maracaibo Sur',
        promotora: 'LUISA GOMEZ',
        productName: 'Espalda Ahumada',
        rating: 2,
        highAcceptance: false,
        acceptanceLabel: 'BAJA',
        purchaseIntent: 'No',
      },
    ],
    surveySummary: {
      totalSurveys: 3,
      breveCount: 2,
      profundaCount: 1,
      avgRating: 3.67,
      highAcceptancePercent: 67,
    },
    fetchedAt: '2026-11-12T16:00:00Z',
  };

  // Validar Mortadela en SEMANA_ACTUAL (15 + 8 = 23 un, 1 tienda única deduplicada, 1 zona única, 55 muestras reconciliadas)
  const mortWeekSnap = computeMetric360Snapshot({
    metricId: 'mortadela',
    timeLens: 'SEMANA_ACTUAL',
    switcherItems: switcherTemplate,
    visits: mockVisits,
    tastingItems: mockBundle.tastingItems,
    module1Bundle: mockBundle,
    liveClock,
    btlUnitCostUsd: 12,
  });

  const mortBadge = mortWeekSnap.resolvedSwitcherItems.find((s) => s.id === 'mortadela')?.badgeValue;
  assert.equal(mortBadge, '23 un', 'Píldora Mortadela en Semana Actual debe cuadrar en 23 un');
  assert.equal(mortWeekSnap.totalPrimaryQty, 23, 'KPI Volumen Mortadela debe ser 23');
  assert.equal(mortWeekSnap.uniqueStoresCount, 1, 'PDV duplicado con tilde/espacios debe contar como 1 en Set');
  assert.equal(mortWeekSnap.uniqueZonesCount, 1, 'Zona con espacios extra debe contar como 1 en Set');
  assert.equal(mortWeekSnap.totalSamples, 55, 'Muestras deben reconciliar sol-fdv-1 (40) vs inv-1 (55) sin duplicar');
  assert.equal(mortWeekSnap.shelfMovedUnits, 12, 'Rotación debe ser 12 un');

  const mortCsvParsed = parseCsvRowsSimple(buildMetric360CsvContent(mortWeekSnap.csvExportRows));
  const mortCsvDataRows = mortCsvParsed.slice(1);
  const mortCsvSumQty = mortCsvDataRows.reduce((s, r) => s + Number(r[6]), 0);
  const mortCsvSumSamples = mortCsvDataRows.reduce((s, r) => s + Number(r[10]), 0);
  const mortCsvSumMoved = mortCsvDataRows.reduce((s, r) => s + Number(r[11]), 0);
  assert.equal(mortCsvSumQty, mortWeekSnap.totalPrimaryQty, 'Suma CSV CANTIDAD_METRICA === KPI Volumen');
  assert.equal(mortCsvSumSamples, mortWeekSnap.totalSamples, 'Suma CSV MUESTRAS === KPI Muestras');
  assert.equal(mortCsvSumMoved, mortWeekSnap.shelfMovedUnits, 'Suma CSV ROTACION_UN === KPI Rotación');

  // Validar Encuestas PDV en SEMANA_ACTUAL (2 encuestas: rating 5 y 4 -> prom 4.50, 100% aceptación, 55 muestras, 12 rotación)
  const encWeekSnap = computeMetric360Snapshot({
    metricId: 'encuestas_pdv',
    timeLens: 'SEMANA_ACTUAL',
    switcherItems: switcherTemplate,
    visits: mockVisits,
    tastingItems: mockBundle.tastingItems,
    module1Bundle: mockBundle,
    liveClock,
    btlUnitCostUsd: 0,
  });

  const encBadge = encWeekSnap.resolvedSwitcherItems.find((s) => s.id === 'encuestas_pdv')?.badgeValue;
  assert.equal(encBadge, '2', 'Píldora Encuestas PDV en Semana Actual debe ser 2');
  assert.equal(encWeekSnap.surveyMetrics.totalSurveys, 2);
  assert.equal(encWeekSnap.surveyMetrics.breveCount, 1);
  assert.equal(encWeekSnap.surveyMetrics.profundaCount, 1);
  assert.equal(encWeekSnap.surveyMetrics.avgRating, 4.5);
  assert.equal(encWeekSnap.surveyMetrics.highAcceptancePercent, 100);
  assert.equal(encWeekSnap.uniqueStoresCount, 1);
  assert.equal(encWeekSnap.totalSamples, 55);
  assert.equal(encWeekSnap.shelfMovedUnits, 12);

  const encCsvParsed = parseCsvRowsSimple(buildMetric360CsvContent(encWeekSnap.csvExportRows));
  const encCsvData = encCsvParsed.slice(1);
  const encCsvSumSurveys = encCsvData.reduce((s, r) => s + Number(r[6]), 0);
  const encCsvSumSamples = encCsvData.reduce((s, r) => s + Number(r[10]), 0);
  const encCsvRatings = encCsvData.map((r) => r[12]).filter((v) => v !== '').map(Number);
  const encCsvAvgRating =
    +(encCsvRatings.reduce((a, b) => a + b, 0) / encCsvRatings.length).toFixed(2);

  assert.equal(encCsvSumSurveys, encWeekSnap.surveyMetrics.totalSurveys, 'CSV Encuestas === KPI Encuestas');
  assert.equal(encCsvSumSamples, encWeekSnap.totalSamples, 'CSV Muestras === KPI Muestras');
  assert.equal(encCsvAvgRating, encWeekSnap.surveyMetrics.avgRating, 'CSV Promedio Calificación === KPI Rating');

  // 5. Seguridad CSV Formula Injection (=, +, -, @, \t, \r, \n y espacios iniciales)
  const dangerousPayloads = [
    "=CMD|'/C calc'!A0",
    '+SUM(A1:A2)',
    '-10+20',
    '@IMPORTXML("https://evil.example","//a")',
    '\t=1+1',
    '\r=1+1',
    '\n=1+1',
    '   =HYPERLINK("https://evil.example")',
  ];
  for (const payload of dangerousPayloads) {
    const escaped = escapeSafeCsvCell(payload);
    assert.equal(
      escaped.startsWith(`"'`),
      true,
      `Payload peligroso debe neutralizarse con comilla simple inicial: ${JSON.stringify(payload)} -> ${escaped}`
    );
  }
  assert.equal(escapeSafeCsvCell('Mortadela "Especial" 1kg'), '"Mortadela ""Especial"" 1kg"');

  // 6. Auditoría estática de capas UI/UX y seguridad DOM
  const rootDir = process.cwd();
  const modalSrc = fs.readFileSync(
    path.join(rootDir, 'src', 'components', 'common', 'Metric360DashboardModal.tsx'),
    'utf8'
  );
  const appSrc = fs.readFileSync(path.join(rootDir, 'src', 'App.tsx'), 'utf8');
  const headerSrc = fs.readFileSync(
    path.join(rootDir, 'src', 'components', 'common', 'Header.tsx'),
    'utf8'
  );

  assert.equal(modalSrc.includes('createPortal(modalNode, document.body)'), true, 'Modal debe usar createPortal a document.body');
  assert.equal(modalSrc.includes('z-[90]'), true, 'Modal debe ubicarse en capa z-[90] superior al Sidebar');
  assert.equal(modalSrc.includes('dangerouslySetInnerHTML'), false, 'Prohibido dangerouslySetInnerHTML');
  assert.equal(modalSrc.includes('console.log'), false, 'Prohibido console.log en Metric360DashboardModal');
  assert.equal(appSrc.includes('overflow-x-hidden'), true, 'App.tsx debe prevenir overflow horizontal');
  assert.equal(appSrc.includes('relative z-10'), false, 'App.tsx NO debe encerrar <main> en stacking context z-10');
  assert.equal(headerSrc.includes('line-clamp-2'), true, 'Sidebar debe permitir hasta 2 líneas legibles');

  process.stdout.write(
    'OK verifyMetric360Integrity: UTC-4, Set PDV/Zonas, Cuadre 1:1 Píldoras-KPIs-CSV, Anti-Formula-Injection y Capas Portal z-[90] verificados.\n'
  );
}

runSuite();
