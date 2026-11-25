import type jsPDF from 'jspdf';
import type {
  ScheduledVisit,
  ControllerRequest,
  InventoryReconciliation,
  SolicitudProductoContraloria,
} from '../types';
import type { TastingScheduleItem } from '../components/field/FieldPromotoraView';

// jsPDF y jsPDF-AutoTable se cargan bajo demanda (solo al exportar) para reducir el bundle inicial
const loadPdfLibs = async () => {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  return { jsPDF, autoTable };
};

// Helper to format date and time in Venezuelan local standard
export const getFormattedTimestamp = () => {
  const now = new Date();
  return now.toLocaleString('es-VE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

export interface PdfExportRegionOptions {
  regionLabel?: string;
}

export function formatPdfSubtitleWithRegion(
  subtitle: string,
  regionLabel?: string | null
): string {
  const cleanRegion = String(regionLabel ?? '').trim();
  if (!cleanRegion) return subtitle;
  const stamp = `Región / Sucursal Activa: ${cleanRegion}`;
  if (subtitle.includes(stamp)) return subtitle;
  return `${subtitle} • ${stamp}`;
}

// Generic Document Header for Codizulca
const addCodizulcaHeader = (
  doc: jsPDF,
  title: string,
  subtitle: string,
  docCode: string,
  regionLabel?: string
) => {
  const pageWidth = doc.internal.pageSize.getWidth();
  const cleanRegion = String(regionLabel ?? '').trim();

  // Top Accent Bar (Red Codizulca)
  doc.setFillColor(220, 38, 38); // #dc2626
  doc.rect(0, 0, pageWidth, 5, 'F');

  // Secondary Black accent bar
  doc.setFillColor(20, 20, 20);
  doc.rect(0, 5, pageWidth, 1.5, 'F');

  // Corporate Badge
  doc.setFillColor(220, 38, 38);
  doc.roundedRect(14, 11, 14, 14, 2, 2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('CZ', 17.5, 20.5);

  // Corporate Text
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('CODIZULCA C.A.', 32, 17);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text('Comercializadora y Distribuidora del Zulia C.A. • RIF: J-07011928-0', 32, 22);

  // Document metadata right aligned
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(220, 38, 38);
  doc.text(docCode, pageWidth - 14, 15, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(`Emisión: ${getFormattedTimestamp()}`, pageWidth - 14, 20, { align: 'right' });
  doc.text(
    cleanRegion
      ? `Región / Sucursal Activa: ${cleanRegion}`
      : 'Soporte de Auditoría & Trazabilidad',
    pageWidth - 14,
    24,
    { align: 'right' }
  );

  // Divider line
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(14, 28, pageWidth - 14, 28);

  // Title & Subtitle
  doc.setTextColor(15, 15, 15);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(title, 14, 36);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(80, 80, 80);
  doc.text(formatPdfSubtitleWithRegion(subtitle, cleanRegion), 14, 41);
};

// Generic Footer with Signatures & Page Numbers
const addCodizulcaFooter = (doc: jsPDF, totalPages: number) => {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // Signature Block only on the bottom
  const sigY = pageHeight - 26;

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.4);

  // Signature 1: Elaborado
  doc.line(14, sigY, 65, sigY);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(40, 40, 40);
  doc.text('ELABORADO POR:', 14, sigY + 4);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text('Supervisor de Trade Marketing / Campo', 14, sigY + 7);

  // Signature 2: Revisado Contraloría
  const midX = pageWidth / 2 - 25;
  doc.line(midX, sigY, midX + 50, sigY);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(40, 40, 40);
  doc.text('REVISADO Y AUDITADO:', midX, sigY + 4);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text('Dpto. de Contraloría Interna', midX, sigY + 7);

  // Signature 3: Conforme / Recibido
  const rightX = pageWidth - 65;
  doc.line(rightX, sigY, rightX + 51, sigY);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(40, 40, 40);
  doc.text('CONFORME / RECIBIDO:', rightX, sigY + 4);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text('Promotora Líder / PDV Autorizado', rightX, sigY + 7);

  // Bottom Notice
  doc.setFontSize(6.5);
  doc.setTextColor(130, 130, 130);
  doc.text(
    'Documento oficial generado por el Sistema de Gestión Comercial Codizulca C.A. • Validez legal interna bajo principio de cero papel.',
    14,
    pageHeight - 6
  );

  doc.text(
    `Pág. ${doc.getCurrentPageInfo().pageNumber} de ${totalPages}`,
    pageWidth - 14,
    pageHeight - 6,
    { align: 'right' }
  );
};

// ---------------------------------------------------------------------------------
// 1. EXPORT MÓDULO 1: CRONOGRAMA DE DEGUSTACIONES & CAMPO (Promotoras y FDV)
// ---------------------------------------------------------------------------------
export const exportTastingSchedulePdf = async (
  items: TastingScheduleItem[],
  viewMode: 'actual' | 'historial' = 'actual',
  options?: PdfExportRegionOptions
): Promise<void> => {
  const { jsPDF, autoTable } = await loadPdfLibs();
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  const isHistory = viewMode === 'historial';
  const title = isHistory
    ? 'HISTORIAL DE DEGUSTACIONES Y ACTIVACIONES EN PDV (CIERRE SEMANAL)'
    : 'CRONOGRAMA OPERATIVO DE DEGUSTACIONES & IMPULSO EN PDV';
  const subtitle = isHistory
    ? 'Registro histórico consolidado de actividades cerradas automáticamente el domingo a las 23:59.'
    : 'Planificación de degustaciones en tiendas, solicitudes aprobadas de vendedores y avance en tiempo real.';
  const docCode = `CZ-DEG-${isHistory ? 'HIST' : 'ACT'}-${new Date().getFullYear()}-${String(items.length).padStart(3, '0')}`;

  addCodizulcaHeader(doc, title, subtitle, docCode, options?.regionLabel);

  // Metric summary blocks
  const totalTarget = items.reduce((acc, i) => acc + (i.targetSamples || 0), 0);
  const totalCurrent = items.reduce((acc, i) => acc + (i.currentSamples || 0), 0);
  const totalSales = items.reduce((acc, i) => acc + (i.salesAssistedCount || 0), 0);
  const completedCount = items.filter((i) => i.status === 'COMPLETADO').length;

  const summaryY = 46;
  doc.setFillColor(245, 245, 245);
  doc.setDrawColor(220, 220, 220);
  doc.roundedRect(14, summaryY, doc.internal.pageSize.getWidth() - 28, 11, 1.5, 1.5, 'FD');

  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20, 20, 20);
  doc.text(`Total Actividades: ${items.length}`, 18, summaryY + 7);
  doc.text(`Completadas: ${completedCount}`, 70, summaryY + 7);
  doc.text(`Muestras Degustadas: ${totalCurrent} / ${totalTarget} un`, 125, summaryY + 7);
  doc.text(`Ventas Asistidas Directas: ${totalSales} un`, 205, summaryY + 7);

  // Table Data
  const tableHead = [
    [
      'FECHA / HORARIO',
      'ACTIVIDAD & PRODUCTO',
      'RESPONSABLE',
      'CLIENTE PDV & ZONA',
      'ESTADO',
      'ACEPTACIÓN',
      'SOLICITANTE FDV',
    ],
  ];

  const tableBody = items.map((item) => [
    `${item.date}\n${item.timeRange}`,
    `${item.activityTitle}\n• ${item.productName}`,
    item.responsibleName,
    `${item.storeName}\n${item.zone}`,
    item.status === 'NO_AUTORIZADA'
      ? 'NO AUTORIZADA'
      : item.status === 'PROGRAMADO'
        ? 'AUTORIZADA'
        : item.status,
    item.acceptancePercent !== undefined ? `${item.acceptancePercent}%` : '-',
    item.sellerApplicant || 'Coordinación Trade',
  ]);

  autoTable(doc, {
    startY: 61,
    head: tableHead,
    body: tableBody,
    theme: 'grid',
    styles: {
      fontSize: 7.5,
      cellPadding: 2.5,
      textColor: [30, 30, 30],
      lineColor: [220, 220, 220],
      lineWidth: 0.2,
      font: 'helvetica',
    },
    headStyles: {
      fillColor: [20, 20, 20],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
    },
    alternateRowStyles: {
      fillColor: [250, 250, 250],
    },
    columnStyles: {
      0: { cellWidth: 26 },
      1: { cellWidth: 55 },
      2: { cellWidth: 32 },
      3: { cellWidth: 55 },
      4: { cellWidth: 24, fontStyle: 'bold' },
      5: { cellWidth: 25 },
      6: { cellWidth: 22 },
    },
    margin: { left: 14, right: 14, bottom: 32 },
  });

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addCodizulcaFooter(doc, totalPages);
  }

  doc.save(`codizulca_degustaciones_${viewMode}_${new Date().toISOString().slice(0, 10)}.pdf`);
};

// ---------------------------------------------------------------------------------
// 2. EXPORT MÓDULO 2: TABLA GENERAL & CRONOGRAMA DE PDVs (Llenado por productos)
// ---------------------------------------------------------------------------------
export const exportScheduleMatrixPdf = async (
  visits: ScheduledVisit[],
  dayFilter: string = 'TODOS',
  totals?: {
    mortadela: number;
    vencampo: number;
    azucar: number;
    leche: number;
    espalda: number;
  },
  options?: PdfExportRegionOptions
): Promise<void> => {
  const { jsPDF, autoTable } = await loadPdfLibs();
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  const title = 'MATRIZ OFICIAL CONSOLIDADA DE DEGUSTACIONES & DESPACHO EN PDV';
  const subtitle = `Planificación y Llenado por Lote (${visits.length} Puntos de Venta) • Filtro Activo: ${dayFilter}`;
  const docCode = `CZ-MTZ-PDV-${new Date().getFullYear()}-${String(visits.length).padStart(3, '0')}`;

  addCodizulcaHeader(doc, title, subtitle, docCode, options?.regionLabel);

  // Metric Summary Bar
  if (totals) {
    const summaryY = 46;
    doc.setFillColor(245, 245, 245);
    doc.setDrawColor(220, 220, 220);
    doc.roundedRect(14, summaryY, doc.internal.pageSize.getWidth() - 28, 11, 1.5, 1.5, 'FD');

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20, 20, 20);
    doc.text(`Mortadela Asturias: ${totals.mortadela} un`, 18, summaryY + 7);
    doc.text(`Stands Vencampo: ${totals.vencampo}`, 75, summaryY + 7);
    doc.text(`Azúcar: ${(totals.azucar / 1000).toFixed(2)} kg`, 125, summaryY + 7);
    doc.text(`Leche: ${(totals.leche / 1000).toFixed(2)} kg`, 175, summaryY + 7);
    doc.text(`Espalda Ahumada: ${totals.espalda} un`, 225, summaryY + 7);
  }

  const tableHead = [
    [
      'FECHA / DÍA',
      'TURNO',
      'CLIENTE / PUNTO DE VENTA',
      'PRODUCTO ASIGNADO',
      'MORT.',
      'ESP.',
      'ARR.',
      'AZÚCAR',
      'LECHE',
      'VENDEDOR FDV',
      'PROMOTORA',
      'ESTADO',
    ],
  ];

  const tableBody = visits.map((v) => [
    v.dayLabel || v.date,
    v.shift,
    `${v.storeName}\n${v.zone}`,
    v.fillProductSelection || v.productFocus,
    v.mortadelaQty ? `${v.mortadelaQty} un` : '-',
    v.espaldaQty ? `${v.espaldaQty} un` : '-',
    v.arrozQty ? `${v.arrozQty} un` : '-',
    v.azucarGrams ? `${v.azucarGrams}g` : '-',
    v.lecheGrams ? `${v.lecheGrams}g` : '-',
    v.sellerName,
    v.promotoraName,
    v.status,
  ]);

  autoTable(doc, {
    startY: totals ? 61 : 48,
    head: tableHead,
    body: tableBody,
    theme: 'grid',
    styles: {
      fontSize: 7,
      cellPadding: 2,
      textColor: [30, 30, 30],
      lineColor: [220, 220, 220],
      lineWidth: 0.2,
      font: 'helvetica',
    },
    headStyles: {
      fillColor: [220, 38, 38], // Codizulca Red header
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.5,
    },
    alternateRowStyles: {
      fillColor: [252, 252, 252],
    },
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 16 },
      2: { cellWidth: 55 },
      3: { cellWidth: 45 },
      4: { cellWidth: 14, halign: 'center' },
      5: { cellWidth: 14, halign: 'center' },
      6: { cellWidth: 14, halign: 'center' },
      7: { cellWidth: 16, halign: 'center' },
      8: { cellWidth: 16, halign: 'center' },
      9: { cellWidth: 26 },
      10: { cellWidth: 22 },
      11: { cellWidth: 20, fontStyle: 'bold' },
    },
    margin: { left: 14, right: 14, bottom: 32 },
  });

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addCodizulcaFooter(doc, totalPages);
  }

  doc.save(`codizulca_matriz_general_pdvs_${new Date().toISOString().slice(0, 10)}.pdf`);
};

// ---------------------------------------------------------------------------------
// 3. EXPORT MÓDULO 3: ACTA DE CONTRALORÍA, RENDICIÓN Y PAZ Y SALVO
// ---------------------------------------------------------------------------------
export const exportContraloriaPdf = async (
  activeReq: ControllerRequest,
  reconciliation: InventoryReconciliation,
  _allRequests: ControllerRequest[],
  options?: PdfExportRegionOptions
): Promise<void> => {
  const { jsPDF, autoTable } = await loadPdfLibs();
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const title = 'ACTA DE AUDITORÍA, CONCILIACIÓN Y PAZ Y SALVO';
  const subtitle = `Departamento de Contraloría Interna • Requisición N° ${activeReq.requestCode}`;
  const docCode = `CZ-AUD-${activeReq.requestCode}-${new Date().getFullYear()}`;

  addCodizulcaHeader(doc, title, subtitle, docCode, options?.regionLabel);

  const startY = 48;
  const pageWidth = doc.internal.pageSize.getWidth();

  // Box 1: Requisition Overview
  doc.setFillColor(248, 248, 248);
  doc.setDrawColor(210, 210, 210);
  doc.roundedRect(14, startY, pageWidth - 28, 24, 2, 2, 'FD');

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20, 20, 20);
  doc.text('INFORMACIÓN DE LA SOLICITUD & ESTADO', 18, startY + 6);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60, 60, 60);
  doc.text(`Código: ${activeReq.requestCode}`, 18, startY + 12);
  doc.text(`Estado Workflow: ${activeReq.status}`, 18, startY + 17);
  doc.text(`Fecha Solicitud: ${activeReq.requestDate}`, 18, startY + 22);

  doc.text(`Solicitante: ${activeReq.applicantName} (${activeReq.applicantDepartment})`, 95, startY + 12);
  doc.text(`Presupuesto Aprobado: $${activeReq.approvedBudgetCapUsd.toFixed(2)} USD`, 95, startY + 17);
  doc.text(`Costo Ejecutado: $${activeReq.estimatedCostUsd.toFixed(2)} USD`, 95, startY + 22);

  // Box 2: Inventory Reconciliation Matrix
  const recY = startY + 28;
  doc.setFillColor(240, 253, 244); // light emerald
  doc.setDrawColor(187, 247, 208);
  doc.roundedRect(14, recY, pageWidth - 28, 24, 2, 2, 'FD');

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(22, 101, 52);
  doc.text('CONCILIACIÓN INVENTARIO TRÍPODE [ENTREGADO vs DEGUSTADO vs REMANENTE]', 18, recY + 6);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(40, 40, 40);
  doc.text(`• Entregado Almacén: ${reconciliation.deliveredUnits} un`, 18, recY + 12);
  doc.text(`• Degustado en PDVs: ${reconciliation.degustatedUnitsReported} un`, 18, recY + 17);
  doc.text(`• Remanente Devuelto: ${reconciliation.returnedRemanentUnits} un`, 18, recY + 22);

  doc.setFont('helvetica', 'bold');
  doc.text(`Desviación Faltante: ${reconciliation.discrepancyUnits} un (0.00%)`, 105, recY + 12);
  doc.text(`Estado Conciliación: ${reconciliation.discrepancyStatus}`, 105, recY + 17);
  doc.setTextColor(220, 38, 38);
  doc.text(`Dictamen: ${reconciliation.discrepancyUnits === 0 ? 'CONCILIADO EXACTO - PAZ Y SALVO' : 'AUDITORÍA REQUERIDA'}`, 105, recY + 22);

  // Table of Items in this Requisition
  const tableHead = [['#', 'DESCRIPCIÓN DEL ÍTEM / PRODUCTO', 'CANTIDAD', 'UNIDAD', 'COSTO UNIT.', 'TOTAL', 'LOTE']];
  const tableBody = activeReq.items.map((item) => [
    `#${item.itemNumber}`,
    item.productName,
    `${item.quantityRequested}`,
    item.unitOfMeasure,
    `$${(item.unitCostUsd || 0).toFixed(2)}`,
    `$${(item.totalCostUsd || 0).toFixed(2)}`,
    item.lotNumber || 'N/A',
  ]);

  autoTable(doc, {
    startY: recY + 28,
    head: tableHead,
    body: tableBody,
    theme: 'grid',
    styles: {
      fontSize: 8,
      cellPadding: 3,
      textColor: [30, 30, 30],
      lineColor: [220, 220, 220],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [20, 20, 20],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
    },
    margin: { left: 14, right: 14, bottom: 35 },
  });

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addCodizulcaFooter(doc, totalPages);
  }

  doc.save(`codizulca_acta_contraloria_${activeReq.requestCode}.pdf`);
};

// ---------------------------------------------------------------------------------
// 4. EXPORT MÓDULO 4: INFORME EJECUTIVO, KPIs, COMPARATIVA MoM & COSTOS SEMANALES
// ---------------------------------------------------------------------------------
export interface ExecutiveProductMoMPdfRow {
  productLine: string;
  brand: string;
  prevVol: number;
  currVol: number;
  deltaUnits: number;
  deltaPct: number | null;
  statusLabel: string;
  currPdvCount: number;
  currSamples: number;
  avgPriceUsd: number;
}

export interface ExecutiveWeeklyCostPdfRow {
  weekLabel: string;
  rangeLabel: string;
  requisitionCodes: string;
  requestsCount: number;
  totalUnits: number;
  formalCostUsd: number;
  fieldRequestCostUsd: number;
  consolidatedCostUsd: number;
  wowDeltaPct: number | null;
  governanceStatus: string;
}

export interface ExecutiveFeasibilityPdfRow {
  productLine: string;
  brand: string;
  tastedUnits: number;
  samplesDelivered: number;
  tastedProductCostUsd: number;
  breakEvenUnits: number;
  soldUnits: number;
  generatedRevenueUsd: number;
  netBalanceUsd: number;
  returnMultiplier: number;
  roiPercent: number;
  verdictLabel: string;
}

export const exportExecutiveKpisPdf = async (metrics: {
  routeCompliancePct: number;
  gpsValidationPct?: number;
  gpsTotalRecords?: number;
  totalVisits: number;
  completedVisits: number;
  totalContacts: number;
  totalAssistedSales: number;
  conversionRate: string;
  samplingCostUsd: number;
  avgCpc: string;
  approvedBudget: number;
  executedBudget: number;
  budgetPct: number;
  evalMonthLabel?: string;
  baseMonthLabel?: string;
  productComparisonRows?: ExecutiveProductMoMPdfRow[];
  weeklyCostRows?: ExecutiveWeeklyCostPdfRow[];
  feasibilityPeriodLabel?: string;
  feasibilityVerdictLabel?: string;
  feasibilityRows?: ExecutiveFeasibilityPdfRow[];
  regionLabel?: string;
}): Promise<void> => {
  const { jsPDF, autoTable } = await loadPdfLibs();
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  const periodText =
    metrics.evalMonthLabel && metrics.baseMonthLabel
      ? `Comparativa de Mercado: ${metrics.evalMonthLabel} vs ${metrics.baseMonthLabel} • Costos Semanales Contraloría`
      : 'Torre de Control Integral • KPIs, Comparativa de Mercado y Costos Semanales';

  const title = 'INFORME EJECUTIVO DE KPIs, COMPARATIVA MENSUAL Y COSTOS SEMANALES';
  const subtitle = periodText;
  const docCode = `CZ-KPI-EXEC-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  addCodizulcaHeader(doc, title, subtitle, docCode, metrics.regionLabel);

  let currentY = 46;

  // SECCIÓN 1: TABLERO GENERAL DE KPIs
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(20, 20, 20);
  doc.text('1. RESUMEN EJECUTIVO DE INDICADORES CLAVE (OPERACIONES, IMPULSO Y GOBERNANZA)', 14, currentY);

  const tableHead = [['ÁREA / DIMENSIÓN', 'INDICADOR CLAVE (KPI)', 'VALOR ALCANZADO', 'ESTADO / META DE AUDITORÍA']];
  const gpsValText =
    metrics.gpsTotalRecords && metrics.gpsTotalRecords > 0
      ? `${metrics.gpsValidationPct ?? 0}%`
      : 'Sin marcajes en período';
  const gpsStatusText =
    metrics.gpsTotalRecords && metrics.gpsTotalRecords > 0
      ? `${metrics.gpsTotalRecords} registros de asistencia auditados en PDV`
      : 'Pendiente de sincronización de marcajes GPS';
  const tableBody = [
    ['Operativo (Trade)', 'Cumplimiento de Ruta Programada', `${metrics.routeCompliancePct}%`, `${metrics.completedVisits} de ${metrics.totalVisits} activaciones cubiertas`],
    ['Operativo (Trade)', 'Validación Geocercada GPS & Asistencia', gpsValText, gpsStatusText],
    ['Comercial (Impulso)', 'Impactos Directos (Muestras / Contactos)', `${metrics.totalContacts.toLocaleString('es-VE')} impactos`, 'Consumidores abordados en punto de venta'],
    ['Comercial (Impulso)', 'Desplazamiento / Ventas Auditadas', `${metrics.totalAssistedSales.toLocaleString('es-VE')} unid.`, 'Rotación efectiva medida en anaquel y degustación'],
    ['Comercial (Impulso)', 'Tasa de Conversión & Costo por Contacto', `${metrics.conversionRate}%  |  CPC: $${metrics.avgCpc}`, 'Eficiencia comercial sobre inversión BTL'],
    ['Gobernanza Contraloría', 'Inversión Solicitudes vs Tope Presupuestario', `${metrics.budgetPct}%`, `$${metrics.executedBudget.toFixed(2)} ejecutados de $${metrics.approvedBudget.toFixed(2)} USD`],
  ];

  autoTable(doc, {
    startY: currentY + 2.5,
    head: tableHead,
    body: tableBody,
    theme: 'grid',
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [30, 30, 30],
      lineColor: [220, 220, 220],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [20, 20, 23],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
    },
    alternateRowStyles: {
      fillColor: [250, 250, 250],
    },
    columnStyles: {
      0: { cellWidth: 48, fontStyle: 'bold' },
      1: { cellWidth: 82 },
      2: { cellWidth: 55, fontStyle: 'bold' },
      3: { cellWidth: 84 },
    },
    margin: { left: 14, right: 14, bottom: 24 },
  });

  currentY = ((doc as any).lastAutoTable?.finalY || currentY + 45) + 7;

  // SECCIÓN 2: COMPARATIVA MES A MES DE PRODUCTOS EN EL MERCADO
  if (metrics.productComparisonRows && metrics.productComparisonRows.length > 0) {
    if (currentY > 155) {
      doc.addPage();
      addCodizulcaHeader(doc, title, subtitle, docCode, metrics.regionLabel);
      currentY = 46;
    }

    const baseLbl = metrics.baseMonthLabel || 'Mes Base';
    const evalLbl = metrics.evalMonthLabel || 'Mes Evaluado';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(185, 28, 28);
    doc.text(
      `2. COMPARATIVA MES A MES DE PRODUCTOS EN EL MERCADO (${evalLbl.toUpperCase()} VS ${baseLbl.toUpperCase()})`,
      14,
      currentY
    );

    const momHead = [[
      'LÍNEA DE PRODUCTO CODIZULCA',
      'MARCA',
      `VOL. ${baseLbl.toUpperCase()}`,
      `VOL. ${evalLbl.toUpperCase()}`,
      'VAR. NETA',
      '% CREC. / BAJADA',
      'TENDENCIA MERCADO',
      'PDVs',
      'MUESTRAS BTL',
      'PRECIO PROM.',
    ]];

    const momBody = metrics.productComparisonRows.map((row) => [
      row.productLine,
      row.brand,
      `${row.prevVol.toLocaleString('es-VE')} un`,
      `${row.currVol.toLocaleString('es-VE')} un`,
      `${row.deltaUnits >= 0 ? '+' : ''}${row.deltaUnits.toLocaleString('es-VE')} un`,
      row.deltaPct === null
        ? row.currVol > 0
          ? 'NUEVO (+100%)'
          : '0.0%'
        : `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`,
      row.statusLabel,
      String(row.currPdvCount),
      row.currSamples.toLocaleString('es-VE'),
      row.avgPriceUsd > 0 ? `$${row.avgPriceUsd.toFixed(2)}` : 'S/D',
    ]);

    const totalPrev = metrics.productComparisonRows.reduce((s, r) => s + r.prevVol, 0);
    const totalCurr = metrics.productComparisonRows.reduce((s, r) => s + r.currVol, 0);
    const totalDelta = totalCurr - totalPrev;
    const totalPct = totalPrev > 0 ? ((totalDelta / totalPrev) * 100) : null;
    const totalSamples = metrics.productComparisonRows.reduce((s, r) => s + r.currSamples, 0);

    autoTable(doc, {
      startY: currentY + 2.5,
      head: momHead,
      body: momBody,
      foot: [[
        'TOTAL PORTAFOLIO AUDITADO',
        'CODIZULCA',
        `${totalPrev.toLocaleString('es-VE')} un`,
        `${totalCurr.toLocaleString('es-VE')} un`,
        `${totalDelta >= 0 ? '+' : ''}${totalDelta.toLocaleString('es-VE')} un`,
        totalPct === null ? 'N/A' : `${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%`,
        totalDelta >= 0 ? 'CRECIMIENTO GLOBAL' : 'CONTRACCIÓN GLOBAL',
        '-',
        totalSamples.toLocaleString('es-VE'),
        '-',
      ]],
      theme: 'grid',
      styles: {
        fontSize: 7.5,
        cellPadding: 2.2,
        textColor: [25, 25, 25],
        lineColor: [220, 220, 220],
        lineWidth: 0.2,
      },
      headStyles: {
        fillColor: [220, 38, 38],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      footStyles: {
        fillColor: [24, 24, 27],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      columnStyles: {
        0: { cellWidth: 58, fontStyle: 'bold' },
        1: { cellWidth: 22, halign: 'center' },
        2: { cellWidth: 25, halign: 'right' },
        3: { cellWidth: 25, halign: 'right', fontStyle: 'bold' },
        4: { cellWidth: 23, halign: 'right', fontStyle: 'bold' },
        5: { cellWidth: 26, halign: 'right', fontStyle: 'bold' },
        6: { cellWidth: 34, halign: 'center', fontStyle: 'bold' },
        7: { cellWidth: 15, halign: 'center' },
        8: { cellWidth: 22, halign: 'right' },
        9: { cellWidth: 19, halign: 'right' },
      },
      didParseCell: (data: any) => {
        if (data.section === 'body' && (data.column.index === 4 || data.column.index === 5 || data.column.index === 6)) {
          const rawRow = metrics.productComparisonRows?.[data.row.index];
          if (rawRow) {
            if (rawRow.deltaUnits > 0) {
              data.cell.styles.textColor = [5, 122, 85];
            } else if (rawRow.deltaUnits < 0) {
              data.cell.styles.textColor = [185, 28, 28];
            }
          }
        }
      },
      margin: { left: 14, right: 14, bottom: 24 },
    });

    currentY = ((doc as any).lastAutoTable?.finalY || currentY + 55) + 7;
  }

  // SECCIÓN 3: COSTOS POR SEMANA DE SOLICITUDES DE TRADE MARKETING A CONTRALORÍA
  if (metrics.weeklyCostRows && metrics.weeklyCostRows.length > 0) {
    if (currentY > 145) {
      doc.addPage();
      addCodizulcaHeader(doc, title, subtitle, docCode, metrics.regionLabel);
      currentY = 46;
    }

    const evalLbl = metrics.evalMonthLabel || 'Mes Evaluado';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(20, 20, 20);
    doc.text(
      `3. COSTOS POR SEMANA DE SOLICITUDES DE TRADE MARKETING A CONTRALORÍA (${evalLbl.toUpperCase()})`,
      14,
      currentY
    );

    const weekHead = [[
      'SEMANA',
      'RANGO CALENDARIO',
      'ACTAS / CÓDIGOS MP',
      'SOLIC.',
      'INSUMOS / UNID.',
      'ACTAS CONTRALORÍA (USD)',
      'SOLIC. CAMPO BTL (USD)',
      'COSTO SEMANAL TOTAL',
      'VAR. VS SEM. ANT.',
      'ESTATUS CONTRALORÍA',
    ]];

    const weekBody = metrics.weeklyCostRows.map((w) => [
      w.weekLabel,
      w.rangeLabel,
      w.requisitionCodes || 'Sin acta MP formal',
      String(w.requestsCount),
      `${w.totalUnits.toLocaleString('es-VE')} un`,
      `$${w.formalCostUsd.toFixed(2)}`,
      `$${w.fieldRequestCostUsd.toFixed(2)}`,
      `$${w.consolidatedCostUsd.toFixed(2)} USD`,
      w.wowDeltaPct === null ? 'Base inicial' : `${w.wowDeltaPct >= 0 ? '+' : ''}${w.wowDeltaPct.toFixed(1)}%`,
      w.governanceStatus,
    ]);

    const sumRequests = metrics.weeklyCostRows.reduce((s, w) => s + w.requestsCount, 0);
    const sumUnits = metrics.weeklyCostRows.reduce((s, w) => s + w.totalUnits, 0);
    const sumFormal = metrics.weeklyCostRows.reduce((s, w) => s + w.formalCostUsd, 0);
    const sumField = metrics.weeklyCostRows.reduce((s, w) => s + w.fieldRequestCostUsd, 0);
    const sumConsolidated = metrics.weeklyCostRows.reduce((s, w) => s + w.consolidatedCostUsd, 0);

    autoTable(doc, {
      startY: currentY + 2.5,
      head: weekHead,
      body: weekBody,
      foot: [[
        'TOTAL MENSUAL',
        evalLbl,
        'CONSOLIDADO BTL',
        String(sumRequests),
        `${sumUnits.toLocaleString('es-VE')} un`,
        `$${sumFormal.toFixed(2)}`,
        `$${sumField.toFixed(2)}`,
        `$${sumConsolidated.toFixed(2)} USD`,
        '-',
        'AUDITADO',
      ]],
      theme: 'grid',
      styles: {
        fontSize: 7.5,
        cellPadding: 2.2,
        textColor: [25, 25, 25],
        lineColor: [220, 220, 220],
        lineWidth: 0.2,
      },
      headStyles: {
        fillColor: [24, 24, 27],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      footStyles: {
        fillColor: [220, 38, 38],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      columnStyles: {
        0: { cellWidth: 22, fontStyle: 'bold' },
        1: { cellWidth: 32 },
        2: { cellWidth: 38, fontStyle: 'bold' },
        3: { cellWidth: 14, halign: 'center' },
        4: { cellWidth: 23, halign: 'right' },
        5: { cellWidth: 30, halign: 'right' },
        6: { cellWidth: 30, halign: 'right' },
        7: { cellWidth: 32, halign: 'right', fontStyle: 'bold' },
        8: { cellWidth: 22, halign: 'right' },
        9: { cellWidth: 26, halign: 'center', fontStyle: 'bold' },
      },
      margin: { left: 14, right: 14, bottom: 24 },
    });

    currentY = ((doc as any).lastAutoTable?.finalY || currentY + 55) + 7;
  }

  // SECCIÓN 4: FACTIBILIDAD DE DEGUSTACIÓN VS. COSTO DE LOS PRODUCTOS DEGUSTADOS
  if (metrics.feasibilityRows && metrics.feasibilityRows.length > 0) {
    if (currentY > 145) {
      doc.addPage();
      addCodizulcaHeader(doc, title, subtitle, docCode, metrics.regionLabel);
      currentY = 46;
    }

    const feasPeriod = metrics.feasibilityPeriodLabel || metrics.evalMonthLabel || 'Período Evaluado';
    const feasVerdict = metrics.feasibilityVerdictLabel ? ` • DICTAMEN: ${metrics.feasibilityVerdictLabel}` : '';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(185, 28, 28);
    doc.text(
      `4. FACTIBILIDAD DE DEGUSTACIÓN VS. COSTO DE PRODUCTOS DEGUSTADOS (${feasPeriod.toUpperCase()}${feasVerdict})`,
      14,
      currentY
    );

    const feasHead = [[
      'PRODUCTO DEGUSTADO',
      'MARCA',
      'PROD. DEGUSTADO',
      'COSTO DEGUST. (USD)',
      'PTO. EQUILIBRIO',
      'VENTAS GENERADAS',
      'RETORNO (USD)',
      'BALANCE NETO',
      'RATIO / ROI',
      'DICTAMEN FACTIBILIDAD',
    ]];

    const feasBody = metrics.feasibilityRows.map((r) => [
      r.productLine,
      r.brand,
      `${r.tastedUnits} un (${r.samplesDelivered} m.)`,
      `$${r.tastedProductCostUsd.toFixed(2)}`,
      `${r.breakEvenUnits} un`,
      `${r.soldUnits.toLocaleString('es-VE')} un`,
      `$${r.generatedRevenueUsd.toFixed(2)}`,
      `${r.netBalanceUsd >= 0 ? '+' : ''}$${r.netBalanceUsd.toFixed(2)}`,
      `${r.returnMultiplier.toFixed(2)}x (${r.roiPercent >= 0 ? '+' : ''}${r.roiPercent.toFixed(0)}%)`,
      r.verdictLabel,
    ]);

    const totTastedUnits = Number(metrics.feasibilityRows.reduce((s, r) => s + r.tastedUnits, 0).toFixed(1));
    const totSamples = metrics.feasibilityRows.reduce((s, r) => s + r.samplesDelivered, 0);
    const totCost = metrics.feasibilityRows.reduce((s, r) => s + r.tastedProductCostUsd, 0);
    const totBE = metrics.feasibilityRows.reduce((s, r) => s + r.breakEvenUnits, 0);
    const totSold = metrics.feasibilityRows.reduce((s, r) => s + r.soldUnits, 0);
    const totRev = metrics.feasibilityRows.reduce((s, r) => s + r.generatedRevenueUsd, 0);
    const totNet = totRev - totCost;
    const totMult = totCost > 0 ? totRev / totCost : 0;
    const totRoi = totCost > 0 ? ((totRev - totCost) / totCost) * 100 : 0;

    autoTable(doc, {
      startY: currentY + 2.5,
      head: feasHead,
      body: feasBody,
      foot: [[
        'CONSOLIDADO PERÍODO',
        'TOTAL',
        `${totTastedUnits} un (${totSamples} m.)`,
        `$${totCost.toFixed(2)}`,
        `${totBE} un`,
        `${totSold.toLocaleString('es-VE')} un`,
        `$${totRev.toFixed(2)}`,
        `${totNet >= 0 ? '+' : ''}$${totNet.toFixed(2)}`,
        `${totMult.toFixed(2)}x (${totRoi >= 0 ? '+' : ''}${totRoi.toFixed(0)}%)`,
        metrics.feasibilityVerdictLabel || (totMult >= 1.5 ? 'FACTIBLE' : totMult >= 1.0 ? 'AJUSTADA' : 'NO FACTIBLE'),
      ]],
      theme: 'grid',
      styles: {
        fontSize: 7.3,
        cellPadding: 2.1,
        textColor: [25, 25, 25],
        lineColor: [220, 220, 220],
        lineWidth: 0.2,
      },
      headStyles: {
        fillColor: [220, 38, 38],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      footStyles: {
        fillColor: [24, 24, 27],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      columnStyles: {
        0: { cellWidth: 46, fontStyle: 'bold' },
        1: { cellWidth: 18, halign: 'center' },
        2: { cellWidth: 28, halign: 'right' },
        3: { cellWidth: 25, halign: 'right', fontStyle: 'bold' },
        4: { cellWidth: 22, halign: 'right' },
        5: { cellWidth: 23, halign: 'right' },
        6: { cellWidth: 25, halign: 'right', fontStyle: 'bold' },
        7: { cellWidth: 24, halign: 'right', fontStyle: 'bold' },
        8: { cellWidth: 26, halign: 'right', fontStyle: 'bold' },
        9: { cellWidth: 32, halign: 'center', fontStyle: 'bold' },
      },
      didParseCell: (data: any) => {
        if (data.section === 'body' && (data.column.index === 7 || data.column.index === 8 || data.column.index === 9)) {
          const row = metrics.feasibilityRows?.[data.row.index];
          if (row) {
            if (row.returnMultiplier >= 1.5) {
              data.cell.styles.textColor = [5, 122, 85];
            } else if (row.returnMultiplier < 1.0) {
              data.cell.styles.textColor = [185, 28, 28];
            }
          }
        }
      },
      margin: { left: 14, right: 14, bottom: 24 },
    });
  }

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addCodizulcaFooter(doc, totalPages);
  }

  const safePeriod = (metrics.evalMonthLabel || new Date().toISOString().slice(0, 7))
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '');
  doc.save(`codizulca_kpis_comparativa_costos_${safePeriod}.pdf`);
};

// ---------------------------------------------------------------------------------
// 5. EXPORT PROMOTORA MOBILE REPORTS PDF (HISTORIAL, PRECIOS, INVENTARIO, ASISTENCIA)
// ---------------------------------------------------------------------------------
export const exportPromotoraReportsPdf = async (
  reportType: 'visitas' | 'precios' | 'inventario' | 'asistencia' | 'encuestas',
  reportTitle: string,
  tableHead: string[][],
  tableBody: (string | number)[][],
  metrics: {
    totalVisits: number;
    geoverifiedPercent: number;
    totalSamples: number;
    totalPhotos: number;
  },
  options?: PdfExportRegionOptions
): Promise<void> => {
  const { jsPDF, autoTable } = await loadPdfLibs();
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  addCodizulcaHeader(
    doc,
    `REPORTE DE CAMPO: ${reportTitle.toUpperCase()}`,
    'INFORMACIÓN SINCRONIZADA DESDE LA APP MÓVIL DE PROMOTORAS',
    'CONFIDENCIAL • TRADE MARKETING & CONTRALORÍA',
    options?.regionLabel
  );

  // Metrics Bar
  const summaryY = 46;
  doc.setFillColor(245, 245, 245);
  doc.setDrawColor(220, 220, 220);
  doc.roundedRect(14, summaryY, doc.internal.pageSize.getWidth() - 28, 12, 1.5, 1.5, 'FD');

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20, 20, 20);
  doc.text(`Visitas Registradas: ${metrics.totalVisits} auditorías`, 18, summaryY + 7.5);
  doc.text(`GPS Geoverificado: ${metrics.geoverifiedPercent}% en tienda`, 80, summaryY + 7.5);
  doc.text(`Muestras Entregadas: ${metrics.totalSamples} degustaciones`, 145, summaryY + 7.5);
  doc.text(`Fotos de Góndola: ${metrics.totalPhotos} evidencias`, 220, summaryY + 7.5);

  autoTable(doc, {
    startY: 62,
    head: tableHead,
    body: tableBody,
    theme: 'grid',
    styles: {
      fontSize: 7.5,
      cellPadding: 2.5,
      textColor: [30, 30, 30],
      lineColor: [220, 220, 220],
      lineWidth: 0.2,
      font: 'helvetica',
    },
    headStyles: {
      fillColor: [220, 38, 38], // Codizulca Red
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
    },
    alternateRowStyles: {
      fillColor: [250, 250, 250],
    },
    margin: { left: 14, right: 14, bottom: 35 },
  });

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    addCodizulcaFooter(doc, totalPages);
  }

  doc.save(`codizulca_informe_${reportType}_${new Date().toISOString().slice(0, 10)}.pdf`);
};

// ---------------------------------------------------------------------------------
// 6. NATIVE BROWSER PRINT TRIGGER WITH CLEAN DOCUMENT TITLE
// ---------------------------------------------------------------------------------
export const triggerBrowserPrint = (documentTitle?: string) => {
  const originalTitle = document.title;
  if (documentTitle) {
    document.title = documentTitle;
  }

  // Brief timeout to ensure DOM styles apply cleanly before print dialog opens
  setTimeout(() => {
    window.print();
    if (documentTitle) {
      setTimeout(() => {
        document.title = originalTitle;
      }, 1000);
    }
  }, 100);
};

// ---------------------------------------------------------------------------------
// 7. INFORME GENERAL MENSUAL DE DEGUSTACIONES (GLOBAL + DETALLADO POR VENDEDOR)
// ---------------------------------------------------------------------------------
export {
  exportMonthlyTastingGeneralReportPdf,
  resolveTargetReportMonth,
  buildMonthlyTastingReportData,
} from './monthlyTastingReportPdf';

export {
  exportPendingTastingAuthorizationPdf,
  buildPendingAuthorizationReportModel,
  renderPendingAuthorizationPdfDocument,
} from './pendingAuthorizationPdf';

// ---------------------------------------------------------------------------------
// 8. FORMATO CORPORATIVO OFICIAL: "SOLICITUD DE PRODUCTOS" (MP-07-XXXX)
// ---------------------------------------------------------------------------------
export const exportSolicitudProductosPdf = async (
  solicitud: SolicitudProductoContraloria,
  options?: PdfExportRegionOptions
): Promise<void> => {
  const { jsPDF, autoTable } = await loadPdfLibs();
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const leftX = 16;
  const rightX = pageWidth - 16;
  const contentWidth = rightX - leftX;
  const cleanRegion = String(options?.regionLabel ?? '').trim();

  // Identificador institucional superior izquierdo
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(220, 38, 38);
  doc.text('CODIZULCA C.A.', leftX, 20);
  doc.setFontSize(7.5);
  doc.setTextColor(60, 60, 60);
  doc.text('RIF: J-07011928-0 • MERCADEO Y PUBLICIDAD', leftX, 24.5);
  if (cleanRegion) {
    doc.setFontSize(7.5);
    doc.setTextColor(185, 28, 28);
    doc.text(`Región / Sucursal Activa: ${cleanRegion}`, leftX, 29);
  }

  // Recuadro superior derecho con bordes negros: SOLICITUD DE PRODUCTOS / MP-07-XXXX
  const boxW = 68;
  const boxX = rightX - boxW;
  const boxY = 14;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.6);
  doc.rect(boxX, boxY, boxW, 15);
  doc.line(boxX, boxY + 7.5, boxX + boxW, boxY + 7.5);

  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text('SOLICITUD DE PRODUCTOS', boxX + boxW / 2, boxY + 5.2, { align: 'center' });
  doc.setFontSize(11);
  doc.text(solicitud.codigoCorrelativo, boxX + boxW / 2, boxY + 12.8, { align: 'center' });

  // FECHA debajo del recuadro
  doc.setFontSize(9.5);
  doc.text(`FECHA: ${solicitud.fechaSolicitud}`, boxX + boxW / 2, boxY + 21.5, {
    align: 'center',
  });

  // Encabezado superior izquierdo: DIRIGIDO AL DEPARTAMENTO / PARA SER UTILIZADO
  let cursorY = 43;
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(0, 0, 0);
  doc.text(`DIRIGIDO AL DEPARTAMENTO: ${solicitud.dirigidoA || 'CONTRALORÍA'}`, leftX, cursorY);

  cursorY += 6;
  const purposeLines = doc.splitTextToSize(
    `PARA SER UTILIZADO: ${solicitud.paraSerUtilizado}`,
    contentWidth
  );
  doc.text(purposeLines, leftX, cursorY);
  cursorY += purposeLines.length * 4.8 + 2;

  // Barra de título roja (#DC2626): SOLICITUD
  doc.setFillColor(220, 38, 38);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.rect(leftX, cursorY, contentWidth, 7, 'FD');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('SOLICITUD', leftX + contentWidth / 2, cursorY + 4.9, { align: 'center' });

  const totalRows = Math.max(10, solicitud.items.length);
  const bodyRows: (string | number)[][] = Array.from({ length: totalRows }, (_, idx) => {
    const it = solicitud.items[idx];
    return [
      idx + 1,
      it ? it.producto.toUpperCase() : '',
      it && it.cantidad > 0 ? it.cantidad : '',
    ];
  });

  autoTable(doc, {
    startY: cursorY + 7,
    margin: { left: leftX, right: 16 },
    tableWidth: contentWidth,
    head: [['ITEM', 'PRODUCTO', 'CANTIDAD']],
    body: bodyRows,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 8.8,
      textColor: [0, 0, 0],
      lineColor: [0, 0, 0],
      lineWidth: 0.4,
      cellPadding: 2,
      minCellHeight: 6.8,
    },
    headStyles: {
      fillColor: [252, 165, 165], // #FCA5A5
      textColor: [0, 0, 0],
      fontStyle: 'bold',
      halign: 'center',
      lineColor: [0, 0, 0],
      lineWidth: 0.5,
    },
    columnStyles: {
      0: { cellWidth: 18, halign: 'center', fontStyle: 'bold' },
      1: { cellWidth: contentWidth - 50, halign: 'left', fontStyle: 'bold' },
      2: { cellWidth: 32, halign: 'center', fontStyle: 'bold' },
    },
  });

  const afterTableY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
    ?.finalY
    ? ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY)
    : cursorY + 90;

  // Barra de título roja (#DC2626): OBSERVACIÓN
  let obsY = afterTableY;
  doc.setFillColor(220, 38, 38);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.rect(leftX, obsY, contentWidth, 7, 'FD');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('OBSERVACIÓN', leftX + contentWidth / 2, obsY + 4.9, { align: 'center' });

  obsY += 7;
  const obsText = (solicitud.observacion || 'SIN OBSERVACIONES ADICIONALES').toUpperCase();
  const obsLines = doc.splitTextToSize(obsText, contentWidth - 10);
  const obsBoxHeight = Math.max(20, obsLines.length * 5 + 8);
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.6);
  doc.rect(leftX, obsY, contentWidth, obsBoxHeight, 'FD');

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(8.8);
  doc.setFont('helvetica', 'bold');
  const textStartY = obsY + (obsBoxHeight - obsLines.length * 4.6) / 2 + 3.4;
  doc.text(obsLines, leftX + contentWidth / 2, textStartY, { align: 'center' });

  // Pie de Firma: SOLICITADO + línea divisoria + MERCADEO Y PUBLICIDAD
  const sigY = Math.min(obsY + obsBoxHeight + 26, 265);
  const lineStartX = pageWidth / 2 - 4;
  const lineEndX = rightX - 10;
  const lineCenterX = (lineStartX + lineEndX) / 2;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(0, 0, 0);
  doc.text('SOLICITADO', lineStartX - 3, sigY, { align: 'right' });

  if (solicitud.firmaDigitalImagen && solicitud.firmaDigitalImagen.startsWith('data:image')) {
    try {
      doc.addImage(solicitud.firmaDigitalImagen, 'PNG', lineCenterX - 20, sigY - 14, 40, 12);
    } catch {
      // fallback a texto si la imagen no pudo renderizarse
    }
  } else {
    doc.setFont('times', 'italic');
    doc.setFontSize(12);
    doc.text(solicitud.firmaDigitalTexto || solicitud.solicitadoPor, lineCenterX, sigY - 5, {
      align: 'center',
    });
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text(solicitud.solicitadoPor.toUpperCase(), lineCenterX, sigY - 1.2, { align: 'center' });

  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.line(lineStartX, sigY + 0.5, lineEndX, sigY + 0.5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text(
    (solicitud.departamentoSolicitante || 'MERCADEO Y PUBLICIDAD').toUpperCase(),
    lineCenterX,
    sigY + 5,
    { align: 'center' }
  );

  // Sello de estado de Contraloría si ya fue aprobada o rechazada
  if (solicitud.estado !== 'PENDIENTE_APROBACION') {
    const stampY = sigY + 13;
    const isApproved = solicitud.estado === 'APROBADA';
    doc.setDrawColor(isApproved ? 5 : 220, isApproved ? 150 : 38, isApproved ? 105 : 38);
    doc.setLineWidth(0.5);
    doc.rect(leftX, stampY, contentWidth, 12);
    doc.setTextColor(isApproved ? 5 : 220, isApproved ? 120 : 38, isApproved ? 85 : 38);
    doc.setFontSize(8.5);
    doc.text(
      `ESTADO CONTRALORÍA: ${solicitud.estado}${
        solicitud.resueltoPor ? ` • POR: ${solicitud.resueltoPor.toUpperCase()}` : ''
      }`,
      leftX + 3,
      stampY + 5
    );
    if (solicitud.notaContraloria) {
      doc.setFontSize(7.5);
      doc.text(`NOTA: ${solicitud.notaContraloria.toUpperCase()}`, leftX + 3, stampY + 9.5);
    }
  }

  doc.save(`SOLICITUD_PRODUCTOS_${solicitud.codigoCorrelativo}.pdf`);
};

