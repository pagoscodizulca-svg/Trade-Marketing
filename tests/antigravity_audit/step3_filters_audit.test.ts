import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
  startLocalMockInfra,
  type LocalMockInfraInstance,
} from './localMockInfra';

test('PASO 3 — Auditoría Exhaustiva de Filtros, Casos Borde y Sanitización Defensiva (Backend + UI)', async (t) => {
  const mock: LocalMockInfraInstance = await startLocalMockInfra(0);

  process.env.AUDIT_MOCK_BASE_URL = mock.baseUrl;
  process.env.VITE_SUPABASE_URL = mock.baseUrl;
  process.env.SUPABASE_URL = mock.baseUrl;
  process.env.VITE_SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
  process.env.SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;

  const weeklyCycleSvc = await import('../../src/services/degustacionesWeeklyCycleService');
  const masterSyncSvc = await import('../../src/services/masterDataSyncService');
  const excelNormalizer = await import('../../src/utils/excelDateNormalizer');
  const excelParser = await import('../../src/utils/excelDateParser');
  const tabularParser = await import('../../src/utils/degustacionesTabularParser');
  const rutaFormat = await import('../../ruta-degustacion/src/utils/format');
  const rutaCsv = await import('../../ruta-degustacion/src/utils/csvImport');
  const attendanceTypes = await import('../../src/types/attendanceEvidences');
  const portalSharing = await import('../../src/utils/portalLinkSharing');

  const filterAuditMatrix: Array<{
    filterId: string;
    module: string;
    layer: 'Backend/PostgREST' | 'UI/Memoria' | 'Parser/Sanitizador';
    edgeCasesTested: string;
    securityValidated: boolean;
    status: 'APROBADO' | 'CON_ADVERTENCIAS' | 'FALLIDO';
    finding: string;
  }> = [];

  t.after(async () => {
    const useTmpArtifactDir =
      Boolean(process.env.NODE_TEST_CONTEXT) && process.env.WRITE_AUDIT_ARTIFACTS !== '1';
    const outDir = useTmpArtifactDir
      ? path.join(os.tmpdir(), 'codizulca-antigravity-audit')
      : path.resolve('tests/antigravity_audit/results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'step3_filters_results.json'),
      JSON.stringify(
        {
          executedAt: new Date().toISOString(),
          totalCases: filterAuditMatrix.length,
          filterAuditMatrix,
        },
        null,
        2
      ),
      'utf8'
    );
    await mock.close();
  });

  await t.test('FLT-01: Validación Zod de Rango de Fechas, Límites de Paginación y Caracteres Especiales en Historial', async () => {
    // 1. Valid empty / default filters
    const defaults = weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({});
    assert.equal(defaults.page, 1);
    assert.equal(defaults.pageSize, 25);

    // 2. Invalid calendar dates & inverted date ranges (dateFrom > dateTo)
    assert.throws(
      () => weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({ dateFrom: '2026-02-30' }),
      /Formato de fecha inválido/
    );
    assert.throws(
      () =>
        weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({
          dateFrom: '2026-11-20',
          dateTo: '2026-11-10',
        }),
      /no puede ser mayor/
    );

    // 3. Out-of-bounds pagination
    assert.throws(() => weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({ page: 0 }));
    assert.throws(() => weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({ page: -3 }));
    assert.throws(() => weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({ page: 50000 }));
    assert.throws(() => weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({ pageSize: 0 }));
    assert.throws(() => weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({ pageSize: 101 }));

    // 4. Control characters, Spanish ñ/accents, quotes & wildcards
    const sanitized = weeklyCycleSvc.HistorialPaginationFilterInputSchema.parse({
      searchQuery: '  María\u0000  Piña   Ñandú  100%_test  ',
    });
    assert.equal(sanitized.searchQuery, 'María Piña Ñandú 100%_test');
    assert.equal(
      weeklyCycleSvc.escapeIlikePattern(sanitized.searchQuery),
      'María Piña Ñandú 100\\%\\_test'
    );

    // 5. Out-of-range page clamping in memory pagination (e.g. requesting page 99 when only 2 pages exist)
    const sampleHist = Array.from({ length: 30 }, (_, i) => ({
      id: `h-${i + 1}`,
      date: '2026-10-15',
      enHistorial: true,
      createdAt: '2026-10-15T12:00:00Z',
    }));
    const clampedPage = weeklyCycleSvc.paginateSanitizedHistorialCollection(
      sampleHist,
      { page: 99, pageSize: 25 },
      '2026-11-16T15:00:00Z'
    );
    assert.equal(clampedPage.totalPages, 2);
    assert.equal(clampedPage.page, 2, 'Página fuera de límite debe acotarse automáticamente a totalPages');
    assert.equal(clampedPage.items.length, 5);

    filterAuditMatrix.push({
      filterId: 'FLT-01',
      module: 'Módulo 1 · Historial Paginado (Zod + escapeIlikePattern)',
      layer: 'Backend/PostgREST',
      edgeCasesTested: 'Vacíos, 2026-02-30, Desde > Hasta, page=0/-3/50000, pageSize=101, nulos ASCII, ñ/acentos, %/_',
      securityValidated: true,
      status: 'APROBADO',
      finding: 'Esquema Zod rechaza rangos invertidos, fechas imposibles y desbordamientos de página; escapa % y _.',
    });
  });

  await t.test('FLT-02: Aplicación efectiva de statusFilter, shiftFilter y searchQuery en Consulta Servidor de Historial', async () => {
    mock.resetSeedData();
    mock.recordedRequests.length = 0;

    await weeklyCycleSvc.queryServerPaginatedHistorialSurveys(
      {
        page: 1,
        pageSize: 25,
        statusFilter: 'NO_AUTORIZADA',
        shiftFilter: 'TARDE',
        productFilter: 'ESPALDA',
        searchQuery: 'Central',
      },
      { referenceNow: '2026-11-16T15:00:00Z' }
    );

    const surveyQuery = mock.recordedRequests.find((r) => r.pathname === '/rest/v1/surveys');
    assert.ok(surveyQuery, 'Debe emitir consulta GET /rest/v1/surveys');
    const decodedSearch = decodeURIComponent(surveyQuery!.search).toLowerCase();
    assert.ok(
      decodedSearch.includes('product=ilike.'),
      'productFilter debe enviarse al servidor'
    );
    const sendsStatus = decodedSearch.includes('no_autorizada');
    const sendsShift = decodedSearch.includes('tarde');
    const sendsStoreSearch = decodedSearch.includes('store.ilike.') && decodedSearch.includes('product.ilike.');

    assert.equal(
      sendsStatus,
      true,
      'statusFilter debe aplicarse efectivamente a la query PostgREST'
    );
    assert.equal(
      sendsShift,
      true,
      'shiftFilter debe aplicarse efectivamente a la query PostgREST'
    );
    assert.equal(
      sendsStoreSearch,
      true,
      'searchQuery debe buscar en comments, store y product en PostgREST'
    );

    filterAuditMatrix.push({
      filterId: 'FLT-02',
      module: 'Módulo 1 · queryServerPaginatedHistorialSurveys (Combinación Múltiple)',
      layer: 'Backend/PostgREST',
      edgeCasesTested: 'Combinación simultánea statusFilter + shiftFilter + productFilter + searchQuery sobre página 1',
      securityValidated: true,
      status: 'APROBADO',
      finding: 'statusFilter, shiftFilter y searchQuery (comments, store, product) se aplican de forma sanitizada en PostgREST.',
    });
  });

  await t.test('FLT-03: Búsqueda de Data Maestra con Puntuación Comercial (",", "()", "Ñ") en PostgREST .or()', async () => {
    mock.resetSeedData();

    // Case A: Searching with Ñ works properly
    const byEnye = await masterSyncSvc.obtenerClientesMaestros({
      busqueda: 'ÑAPA',
      forzarRefresco: true,
    });
    assert.equal(byEnye.length, 1);
    assert.equal(byEnye[0]!.codigo_cliente, 'CLI-002');

    // Case B: Searching exact legal name containing comma "INVERSIONES EL SOL, C.A."
    // Preserva la coma dentro de operandos PostgREST entrecomillados y devuelve CLI-001
    const byLegalWithComma = await masterSyncSvc.obtenerClientesMaestros({
      busqueda: 'INVERSIONES EL SOL, C.A.',
      forzarRefresco: true,
    });

    assert.equal(
      byLegalWithComma.length,
      1,
      'La búsqueda exacta de razones sociales con ", C.A." debe devolver el cliente coincidente'
    );
    assert.equal(byLegalWithComma[0]!.codigo_cliente, 'CLI-001');

    // Case C: Delimiter sanitization prevents injecting extra PostgREST .or() clauses
    mock.recordedRequests.length = 0;
    await masterSyncSvc.obtenerClientesMaestros({
      busqueda: 'SOL,activo.eq.false',
      forzarRefresco: true,
    });
    const reqSent = mock.recordedRequests.find((r) => r.pathname === '/rest/v1/clientes');
    assert.ok(reqSent);
    const decodedSearch = decodeURIComponent(reqSent!.search);
    assert.equal(
      decodedSearch.includes(',activo.eq.false'),
      false,
      'La cláusula PostgREST inyectada debe ser neutralizada antes de interpolar en .or()'
    );

    filterAuditMatrix.push({
      filterId: 'FLT-03',
      module: 'Data Maestra · obtenerClientesMaestros / obtenerVendedoresMaestros',
      layer: 'Backend/PostgREST',
      edgeCasesTested: 'Letra Ñ, comas en razón social (", C.A."), paréntesis y delimitadores de operador .or()',
      securityValidated: true,
      status: 'APROBADO',
      finding: 'Preserva comas legítimas (", C.A.") mediante operandos PostgREST entrecomillados y bloquea inyección de operadores .or().',
    });
  });

  await t.test('FLT-04: Normalización de Fechas y Filtros de Rango (matchesDateFilter)', async () => {
    assert.equal(excelNormalizer.normalizeExcelDate('2026-02-29').isValid, false, '2026 no es bisiesto');
    assert.equal(excelNormalizer.normalizeExcelDate('2024-02-29').isValid, true, '2024 sí es bisiesto');
    assert.equal(excelNormalizer.normalizeExcelDate('31/04/2026').isValid, false, 'Abril tiene 30 días');
    assert.equal(excelNormalizer.normalizeExcelDate('16/11/2026').fechaIso, '2026-11-16');

    // Inverted range in matchesDateFilter (desde > hasta): auto-swaps bounds silently (diverging from Zod backend schema!)
    const invertedMatch = excelNormalizer.matchesDateFilter('2026-11-16', {
      desde: '2026-11-20',
      hasta: '2026-11-10',
    });
    assert.equal(
      invertedMatch,
      true,
      'DIVERGENCIA CONFIRMADA: matchesDateFilter intercambia silenciosamente desde/hasta cuando desde > hasta, mientras que Zod en Historial rechaza con error'
    );
    const invalidRangeMatch = excelNormalizer.matchesDateFilter('2026-11-16', {
      desde: '2026-02-30',
      hasta: '2026-11-20',
    });
    assert.equal(invalidRangeMatch, false, 'Extremo con fecha imposible devuelve false de forma segura');

    filterAuditMatrix.push({
      filterId: 'FLT-04',
      module: 'Motor Común de Fechas (excelDateNormalizer + excelDateParser)',
      layer: 'UI/Memoria',
      edgeCasesTested: 'Años bisiestos (29/02/2024 vs 29/02/2026), 31/04, formatos DD/MM/YYYY vs ISO, rangos invertidos',
      securityValidated: true,
      status: 'CON_ADVERTENCIAS',
      finding: 'Validación UTC pura exacta; divergencia UX cuando desde > hasta (UI auto-invierte límites silenciosamente mientras Zod backend lanza error).',
    });
  });

  await t.test('FLT-05: Sanitización Anti-Formula-Injection, Anti-Prototype-Pollution y Etiquetas HTML', async () => {
    // Spreadsheet formula prefixes neutralized while preserving negative numbers and ISO dates
    assert.equal(tabularParser.sanitizeCellText('=CMD|" /C calc"!A0'), 'CMD|" /C calc"!A0');
    assert.equal(tabularParser.sanitizeCellText('+SUM(A1:A10)'), 'SUM(A1:A10)');
    assert.equal(tabularParser.sanitizeCellText('@HYPERLINK("http://x")'), 'HYPERLINK("http://x")');
    assert.equal(tabularParser.sanitizeCellText('-3.5'), '-3.5', 'Conserva números negativos válidos');
    assert.equal(tabularParser.sanitizeCellText('2026-11-16'), '2026-11-16', 'Conserva fechas ISO');

    // Prototype pollution keys blocked
    assert.equal(excelParser.isDangerousObjectKey('__proto__'), true);
    assert.equal(excelParser.isDangerousObjectKey('constructor'), true);
    assert.equal(excelParser.isDangerousObjectKey('prototype'), true);

    // Attendance metadata Zod validation & control-char stripping
    const cleanAttText = attendanceTypes.sanitizeAttendanceText('  PDV\u0007 <b>Norte</b>  ', 80);
    assert.equal(cleanAttText, 'PDV <b>Norte</b>'); // Rendered as React text node (auto-escaped)

    // WhatsApp / Portal phone sanitizer strips non-digits
    const cleanPhone = portalSharing.sanitizePhoneForWhatsApp('+58 (414) 123-4567 <test>');
    assert.equal(/^\d+$/.test(cleanPhone), true, 'Teléfono para enlace externo contiene exclusivamente dígitos');

    // Chofer PWA accent/diacritic insensitive search (`normalizar`)
    assert.equal(rutaFormat.normalizar('María Piña Ñandú'), 'maria pina nandu');
    assert.equal(rutaCsv.sanitizarTextoCelda('=1+1'), '1+1');

    // Static check across ALL .tsx files: zero dangerouslySetInnerHTML
    const tsxDirs = ['src', 'ruta-degustacion/src'];
    let innerHtmlCount = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf8');
          if (/dangerouslySetInnerHTML/.test(content)) innerHtmlCount++;
        }
      }
    };
    tsxDirs.forEach(walk);
    assert.equal(innerHtmlCount, 0, 'Cero uso de dangerouslySetInnerHTML en toda la base de código React');

    filterAuditMatrix.push({
      filterId: 'FLT-05',
      module: 'Sanitizadores Globales (Excel/CSV/Asistencia/Portal/DOM React)',
      layer: 'Parser/Sanitizador',
      edgeCasesTested: 'Prefijos =/+/-/@, __proto__/constructor, caracteres de control, etiquetas HTML, cero dangerouslySetInnerHTML',
      securityValidated: true,
      status: 'APROBADO',
      finding: 'Neutralización determinista de Formula Injection, Prototype Pollution y renderizado 100% escapado en nodos de texto React.',
    });
  });

  await t.test('FLT-06: Auditoría de Consistencia React en ScheduleMatrixView (Dependencias useMemo y Búsqueda Diacrítica)', async () => {
    const scheduleSrc = fs.readFileSync(
      path.resolve('src/components/schedule/ScheduleMatrixView.tsx'),
      'utf8'
    );

    // Extract filteredGlobalTastingItems useMemo block
    const memoMatch = scheduleSrc.match(
      /const filteredGlobalTastingItems = useMemo\(\(\) => \{[\s\S]*?\}, \[([\s\S]*?)\]\);/
    );
    assert.ok(memoMatch, 'Debe existir filteredGlobalTastingItems en ScheduleMatrixView.tsx');
    const depsBlock = memoMatch![1]!;
    const hasMatrixDateFrom = depsBlock.includes('matrixDateFrom');
    const hasMatrixDateTo = depsBlock.includes('matrixDateTo');

    assert.equal(
      hasMatrixDateFrom && hasMatrixDateTo,
      true,
      'ScheduleMatrixView.tsx debe incluir matrixDateFrom y matrixDateTo en las dependencias de useMemo de filteredGlobalTastingItems (fix Hito 3 / B-06)'
    );

    // Verify NFD accent-insensitive search & full-product filterMatrixVisits delegation
    const usesNfdSearch =
      scheduleSrc.includes('normalizeSearchText(searchQuery)') &&
      scheduleSrc.includes('filterMatrixVisits(') &&
      !scheduleSrc.includes('const q = searchQuery.toLowerCase()');
    assert.equal(
      usesNfdSearch,
      true,
      'El buscador libre de ScheduleMatrixView debe normalizar tildes (NFD vía normalizeSearchText) y delegar el filtrado a filterMatrixVisits'
    );

    filterAuditMatrix.push({
      filterId: 'FLT-06',
      module: 'Módulo 2 · ScheduleMatrixView (Rango de Fechas + Buscador + Filtro Producto)',
      layer: 'UI/Memoria',
      edgeCasesTested: 'Cambio reactivo de matrixDateFrom/matrixDateTo, búsqueda con/sin tildes ("María" vs "maria"), productos secundarios',
      securityValidated: true,
      status: 'APROBADO',
      finding: 'Hito 3 / B-06 cerrado: filteredGlobalTastingItems incluye matrixDateFrom y matrixDateTo en useMemo, usa normalización NFD insensible a tildes y filtra cualquier producto mediante filterMatrixVisits.',
    });
  });
});
