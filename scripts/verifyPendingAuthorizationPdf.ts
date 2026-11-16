import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TastingScheduleItem } from '../src/components/field/FieldPromotoraView';
import {
  buildPendingAuthorizationReportModel,
  formatCaracasEmissionTimestamp,
  MAX_AUTHORIZATION_PDF_ROWS,
  MAX_OBSERVATIONS_CELL_LENGTH,
  renderPendingAuthorizationPdfDocument,
  sanitizeAuthorizationFilename,
  sanitizeAuthorizationText,
} from '../src/utils/pendingAuthorizationPdf';

function makeFixtureItem(
  overrides: Partial<TastingScheduleItem> & { id: string }
): TastingScheduleItem {
  const { id, ...restOverrides } = overrides;
  const base: TastingScheduleItem = {
    id,
    date: '2026-11-13',
    dayLabel: 'Vie 13/11/2026',
    shift: 'MAÑANA',
    timeRange: '08:30 AM - 12:30 PM',
    activityTitle: 'Degustación Mortadela Especial',
    productName: 'Mortadela Especial Asturias 0.900kg',
    responsibleName: 'POR ASIGNAR (Trade Marketing)',
    storeName: 'Supermercado Fiorella Hipermercado',
    clienteCodigo: '7499',
    zone: 'MARACAIBO NORTE',
    status: 'PENDIENTE',
    currentSamples: 0,
    targetSamples: 120,
    requestedQty: 4.5,
    sellerApplicant: 'Carlos Urdaneta (Vendedor FDV)',
    isArchived: false,
    enHistorial: false,
    notes: 'Sincronizado con Base de Datos Supabase y Trade Marketing (MAÑANA - 2026-11-13).',
    rawComments: {
      estado: 'SOLICITADA',
      observaciones: 'Cliente solicita activación en pasillo charcutería principal.',
    },
    ...restOverrides,
  };
  return base;
}

async function main() {
  console.log('========================================================================');
  console.log('VERIFICACIÓN UNITARIA E INTEGRAL: PDF SOLICITUD DE AUTORIZACIÓN (PRE-APROBACIÓN)');
  console.log('========================================================================');

  // Instante fijo de referencia: Viernes 13/11/2026 11:08:05 America/Caracas (15:08:05Z UTC)
  // Semana ISO actual en Caracas: Lun 2026-11-09 al Dom 2026-11-15
  const fixedNow = new Date('2026-11-13T15:08:05.000Z');

  // -------------------------------------------------------------------------
  // 1. FILTRADO EXCLUSIVO DE PENDIENTES + INMUTABILIDAD + ORDEN Y KPIs
  // -------------------------------------------------------------------------
  const pending1 = Object.freeze(
    makeFixtureItem({
      id: 'req-pend-1',
      degustacionId: 'DEG-101',
      date: '2026-11-14',
      shift: 'TARDE',
      timeRange: '02:00 PM - 06:00 PM',
      sellerApplicant: 'Zulma Perozo (Vendedor FDV)',
      storeName: 'Enne Fuerzas Armadas',
      clienteCodigo: '2201',
      productName: 'Jamón Ahumado Asturias',
      requestedQty: 6,
      targetSamples: 150,
    })
  );

  const pending2 = Object.freeze(
    makeFixtureItem({
      id: 'req-pend-2',
      degustacionId: 'DEG-102',
      date: '2026-11-13',
      shift: 'MAÑANA',
      timeRange: '09:00 AM - 01:00 PM',
      sellerApplicant: 'Andrés Rincón (Vendedor FDV)',
      storeName: 'De Candido Express Delicias',
      clienteCodigo: '3105',
      productsList: ['Mortadela Especial Asturias 0.900kg', 'Pechuga de Pavo Asturias'],
      requestedQty: 3.25,
      targetSamples: 100,
    })
  );

  const pending3SameTimeAlpha = Object.freeze(
    makeFixtureItem({
      id: 'req-pend-3',
      degustacionId: 'DEG-103',
      date: '2026-11-13',
      shift: 'MAÑANA',
      timeRange: '09:00 AM - 01:00 PM',
      sellerApplicant: 'Andrés Rincón (Vendedor FDV)', // Mismo vendedor para probar conteo único
      storeName: 'Enne Fuerzas Armadas', // Mismo código cliente 2201 para probar cliente único
      clienteCodigo: '2201',
      productName: 'Arroz Vencampo 1kg',
      requestedQty: 10,
      targetSamples: 200,
    })
  );

  const duplicateOfPending2 = Object.freeze(
    makeFixtureItem({
      id: 'req-pend-2-dup',
      degustacionId: 'DEG-102', // Duplicado por degustacionId
      status: 'PENDIENTE',
    })
  );

  const alreadyApproved = Object.freeze(
    makeFixtureItem({
      id: 'req-approved',
      degustacionId: 'DEG-200',
      status: 'PROGRAMADO',
    })
  );

  const inProgress = Object.freeze(
    makeFixtureItem({
      id: 'req-in-progress',
      status: 'EN_CURSO',
    })
  );

  const completed = Object.freeze(
    makeFixtureItem({
      id: 'req-completed',
      status: 'COMPLETADO',
    })
  );

  const rejectedInOrigin = Object.freeze(
    makeFixtureItem({
      id: 'req-rejected',
      status: 'PENDIENTE',
      rawComments: { estado: 'RECHAZADA', observaciones: 'Sin stock.' },
    })
  );

  const cancelledInOrigin = Object.freeze(
    makeFixtureItem({
      id: 'req-cancelled',
      status: 'PENDIENTE',
      rawComments: { estado: 'CANCELADA' },
    })
  );

  const pastWeekPending = Object.freeze(
    makeFixtureItem({
      id: 'req-past-week',
      date: '2026-11-06', // Semana anterior (< 2026-11-09)
      status: 'PENDIENTE',
      isArchived: false,
      enHistorial: false,
    })
  );

  const modelGeneral = buildPendingAuthorizationReportModel({
    items: [
      pending1,
      pending2,
      pending3SameTimeAlpha,
      duplicateOfPending2,
      alreadyApproved,
      inProgress,
      completed,
      rejectedInOrigin,
      cancelledInOrigin,
      pastWeekPending,
    ],
    hasActiveFilters: false,
    issuerName: 'Javier Castellanos',
    issuerRole: 'jefe_trade',
    now: fixedNow,
  });

  assert.equal(
    modelGeneral.rows.length,
    3,
    'Solo deben incluirse las 3 degustaciones válidas en estado PENDIENTE de la semana actual'
  );
  assert.deepEqual(
    modelGeneral.rows.map((r) => r.requestId),
    ['DEG-102', 'DEG-103', 'DEG-101'],
    'Ordenamiento debe ser cronológico por fecha/hora y luego alfabético por vendedor/cliente'
  );
  assert.equal(modelGeneral.scopeType, 'GENERAL');
  assert.match(modelGeneral.scopeDetailLabel, /General de Pendientes/);
  assert.equal(modelGeneral.kpis.totalSolicitadas, 3);
  assert.equal(modelGeneral.kpis.uniqueSellersCount, 2, 'Andrés Rincón y Zulma Perozo = 2 únicos');
  assert.equal(modelGeneral.kpis.uniqueClientsCount, 2, 'Códigos #3105 y #2201 = 2 PDV únicos');
  assert.equal(modelGeneral.kpis.totalEstimatedQty, 19.25, 'Suma exacta 3.25 + 10 + 6 = 19.25');
  assert.equal(modelGeneral.kpis.totalEstimatedSamples, 450);

  console.log('✓ [1/5] Filtrado exclusivo de pendientes, deduplicación, orden y 4 KPIs verificados.');

  // -------------------------------------------------------------------------
  // 2. SANITIZACIÓN ANTI-XSS, CARACTERES ESPECIALES, NULOS Y TEXTOS LARGOS
  // -------------------------------------------------------------------------
  assert.equal(sanitizeAuthorizationText(null, 100, { fallback: 'N/A' }), 'N/A');
  assert.equal(sanitizeAuthorizationText(undefined, 100, { fallback: 'Vacío' }), 'Vacío');
  assert.equal(sanitizeAuthorizationText({ hack: 1 }, 100, { fallback: 'Seguro' }), 'Seguro');

  const dirtyXssInput =
    '\u0000\u0007\u202E<script>alert("xss")</script>Favor ubicarse en <img src=x onerror=alert(1)> entrada principal javascript:evil() 🚀\n\n  con degustadora   uniformada.';
  const sanitizedXss = sanitizeAuthorizationText(dirtyXssInput, 200);
  assert.ok(!sanitizedXss.includes('<script>'), 'No debe conservar etiquetas <script>');
  assert.ok(!sanitizedXss.includes('<img'), 'No debe conservar etiquetas HTML crudas');
  assert.ok(!sanitizedXss.toLowerCase().includes('javascript:'), 'Debe neutralizar esquema javascript:');
  assert.ok(!/[\u0000-\u001F\u202E]/.test(sanitizedXss), 'No debe conservar controles ni bidi');
  assert.match(sanitizedXss, /Favor ubicarse en entrada principal/);

  const veryLongObs = 'Solicitud prioritaria de cierre comercial fin de semana '.repeat(20);
  const itemWithEdgeCases = makeFixtureItem({
    id: 'req-edge-sanitize',
    sellerApplicant: '  <b>María\u0008 José   Ñáñez</b> (Vendedor FDV) ',
    storeName: undefined as unknown as string,
    productName: null as unknown as string,
    rawComments: {
      estado: 'PENDIENTE',
      observaciones: veryLongObs,
    },
  });
  const itemWithoutRealObs = makeFixtureItem({
    id: 'req-no-obs',
    date: '2026-11-14',
    notes: 'Sincronizado con Base de Datos Supabase y Trade Marketing (MAÑANA - 2026-11-14).',
    rawComments: {
      estado: 'SOLICITADA',
      observaciones: '   ',
    },
  });

  const modelSanitized = buildPendingAuthorizationReportModel({
    items: [itemWithEdgeCases, itemWithoutRealObs],
    hasActiveFilters: true,
    filterSummaryLabel: '<script>x</script> Vendedor: María Ñáñez | Rango: 13/11/2026 al 15/11/2026',
    now: fixedNow,
  });

  assert.equal(modelSanitized.scopeType, 'FILTRADO');
  assert.ok(!modelSanitized.scopeDetailLabel.includes('<script>'));
  assert.equal(modelSanitized.rows[0].sellerDisplay, 'María José Ñáñez');
  assert.equal(modelSanitized.rows[0].clientNameDisplay, 'Cliente / PDV por confirmar');
  assert.equal(modelSanitized.rows[0].productsCellText, 'Producto por confirmar');
  assert.ok(
    modelSanitized.rows[0].sellerObservationsText.length <= MAX_OBSERVATIONS_CELL_LENGTH,
    'Observaciones largas deben truncarse limpiamente al límite máximo'
  );
  assert.ok(modelSanitized.rows[0].sellerObservationsText.endsWith('...'));
  assert.equal(
    modelSanitized.rows[1].sellerObservationsText,
    'Sin observaciones',
    'Notas sintéticas del sistema no deben filtrarse como observaciones del vendedor'
  );

  // Sanitización de nombre de archivo contra path traversal / inyección
  assert.equal(
    sanitizeAuthorizationFilename('../../../etc/passwd;rm -rf'),
    'Solicitud_Autorizacion_Degustaciones_0000-00-00_0000.pdf'
  );
  assert.equal(
    sanitizeAuthorizationFilename('2026-11-13_1435'),
    'Solicitud_Autorizacion_Degustaciones_2026-11-13_1435.pdf'
  );

  console.log('✓ [2/5] Sanitización estricta (nulos, controles, HTML/XSS, textos largos y filename) verificada.');

  // -------------------------------------------------------------------------
  // 3. FORMATEO EXACTO EN ZONA HORARIA `America/Caracas` (UTC-4)
  // -------------------------------------------------------------------------
  const tsMorning = formatCaracasEmissionTimestamp(fixedNow); // 2026-11-13T15:08:05Z -> 11:08:05 VET
  assert.equal(tsMorning.displayTimestamp, '13/11/2026 11:08:05 (America/Caracas, UTC-4)');
  assert.equal(tsMorning.fileName, 'Solicitud_Autorizacion_Degustaciones_2026-11-13_1108.pdf');

  // Caso borde nocturno: Sábado 2026-11-14 02:35:49 UTC === Viernes 2026-11-13 22:35:49 America/Caracas
  const utcCrossMidnight = new Date('2026-11-14T02:35:49.000Z');
  const tsNightCaracas = formatCaracasEmissionTimestamp(utcCrossMidnight);
  assert.equal(tsNightCaracas.caracasYmd, '2026-11-13');
  assert.equal(tsNightCaracas.displayTimestamp, '13/11/2026 22:35:49 (America/Caracas, UTC-4)');
  assert.equal(tsNightCaracas.fileName, 'Solicitud_Autorizacion_Degustaciones_2026-11-13_2235.pdf');

  console.log('✓ [3/5] Precisión temporal y nombre de archivo en America/Caracas (UTC-4) verificados.');

  // -------------------------------------------------------------------------
  // 4. LÍMITE DE SEGURIDAD ANTI-DoS, BLOQUEO DE PDF VACÍO Y GENERACIÓN REAL LETTER LANDSCAPE
  // -------------------------------------------------------------------------
  const emptyModel = buildPendingAuthorizationReportModel({
    items: [alreadyApproved, completed],
    now: fixedNow,
  });
  assert.equal(emptyModel.rows.length, 0);
  await assert.rejects(
    () => renderPendingAuthorizationPdfDocument(emptyModel),
    /NO_PENDING_TASTINGS/,
    'No debe permitirse generar un PDF vacío cuando existen 0 pendientes'
  );

  // Prueba de tope MAX_AUTHORIZATION_PDF_ROWS (500)
  const massiveItems = Array.from({ length: 530 }, (_, idx) =>
    makeFixtureItem({
      id: `req-mass-${idx + 1}`,
      degustacionId: `DEG-MASS-${idx + 1}`,
      date: '2026-11-13',
      requestedQty: 1,
    })
  );
  const cappedModel = buildPendingAuthorizationReportModel({
    items: massiveItems,
    now: fixedNow,
  });
  assert.equal(cappedModel.rows.length, MAX_AUTHORIZATION_PDF_ROWS);
  assert.equal(cappedModel.totalMatchedBeforeCap, 530);
  assert.equal(cappedModel.wasTruncatedBySafetyCap, true);

  // Generación real multi-página (36 solicitudes -> múltiples hojas Carta Horizontal + firmas indivisibles)
  const multiPageItems = Array.from({ length: 36 }, (_, idx) =>
    makeFixtureItem({
      id: `req-pdf-${idx + 1}`,
      degustacionId: `DEG-PDF-${idx + 1}`,
      date: idx % 2 === 0 ? '2026-11-13' : '2026-11-14',
      sellerApplicant: `Vendedor ${String((idx % 6) + 1).padStart(2, '0')} (Vendedor FDV)`,
      storeName: `Automercado Regional Sucursal ${idx + 1}`,
      clienteCodigo: String(5000 + idx),
      requestedQty: 2.5,
      rawComments: {
        estado: 'SOLICITADA',
        observaciones:
          'Coordinar ingreso con gerencia de piso a las 8:30 AM y validar exhibición cruzada.',
      },
    })
  );

  const multiPageModel = buildPendingAuthorizationReportModel({
    items: multiPageItems,
    hasActiveFilters: false,
    issuerName: 'Coordinador Zulia',
    issuerRole: 'coordinador_trade',
    now: fixedNow,
  });

  const { doc, fileName, pageCount } = await renderPendingAuthorizationPdfDocument(multiPageModel, {
    logoDataUrl: null,
  });

  const pageWidthMm = doc.internal.pageSize.getWidth();
  const pageHeightMm = doc.internal.pageSize.getHeight();
  assert.ok(
    Math.abs(pageWidthMm - 279.4) < 0.5 && Math.abs(pageHeightMm - 215.9) < 0.5,
    `Formato debe ser Letter Landscape (279.4 x 215.9 mm), obtenido: ${pageWidthMm} x ${pageHeightMm}`
  );
  assert.ok(pageCount >= 2, 'Con 36 solicitudes detalladas debe auto-paginar en >= 2 páginas');
  assert.equal(fileName, 'Solicitud_Autorizacion_Degustaciones_2026-11-13_1108.pdf');

  const pdfBytes = Buffer.from(doc.output('arraybuffer'));
  assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdfBytes.byteLength > 4000, 'El binario PDF debe contener flujo vectorial completo');

  console.log(
    `✓ [4/5] Renderizado vectorial Letter Landscape (${pageCount} págs, ${pdfBytes.byteLength} bytes) y bloqueo de PDF vacío verificados.`
  );

  // -------------------------------------------------------------------------
  // 5. AUDITORÍA ESTÁTICA DE SEGURIDAD (SOLO LECTURA, CERO XSS, CERO SECRETOS)
  // -------------------------------------------------------------------------
  const pdfModuleSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/utils/pendingAuthorizationPdf.ts'),
    'utf8'
  );
  assert.ok(
    !/innerHTML|dangerouslySetInnerHTML|\.html\s*\(/.test(pdfModuleSource),
    'Prohibido usar innerHTML, dangerouslySetInnerHTML o doc.html() en el generador PDF'
  );
  assert.ok(
    !/process\.env|import\.meta\.env|SUPABASE_SERVICE_ROLE|Bearer\s+/i.test(pdfModuleSource),
    'Prohibido leer o incrustar variables .env o tokens en el generador PDF'
  );
  assert.ok(
    !/\.update\s*\(|\.delete\s*\(|\.insert\s*\(|\.upsert\s*\(/.test(pdfModuleSource),
    'El módulo de PDF de autorización debe ser 100% de solo lectura'
  );

  console.log('✓ [5/5] Auditoría estática de solo lectura, higiene de secretos y anti-XSS verificada.');
  console.log('========================================================================');
  console.log('TODAS LAS PRUEBAS DEL INFORME PDF DE AUTORIZACIÓN PASARON CON ÉXITO (0 ERRORES)');
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('Fallo en verifyPendingAuthorizationPdf:', err);
  process.exit(1);
});
