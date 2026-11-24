import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import {
  FileText,
  Printer,
  X,
  Calendar,
  Smartphone,
  Scale,
  BarChart3,
  CheckCircle2,
  Building2,
  Download,
} from 'lucide-react';
import type { InventoryReconciliation } from '../../types';
import type { MainNavTab } from './Header';
import {
  SUCURSAL_LABELS,
  type OperativeSucursal,
} from '../../services/userManagementService';
import {
  formatCanonicalSucursalBadge,
  inferCanonicalSucursalFromText,
} from '../../utils/regionalSyncClassifier';
import type { TastingScheduleItem } from '../field/FieldPromotoraView';

interface GlobalExportPdfModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: MainNavTab;
}

function useOptionalApp() {
  try {
    return useApp();
  } catch {
    return null;
  }
}

export const GlobalExportPdfModal: React.FC<GlobalExportPdfModalProps> = ({
  isOpen,
  onClose,
  activeTab,
}) => {
  const app = useOptionalApp();
  const [downloadedModule, setDownloadedModule] = useState<string | null>(null);

  if (!isOpen) return null;

  const visits = app?.visits ?? [];
  const requests = app?.requests ?? [];
  const reconciliation: InventoryReconciliation = app?.reconciliation ?? {
    requestId: '',
    requestCode: '',
    productName: '',
    deliveredUnits: 0,
    degustatedUnitsReported: 0,
    returnedRemanentUnits: 0,
    discrepancyUnits: 0,
    discrepancyStatus: 'CUADRADO',
    receipts: [],
    totalExpensesReportedUsd: 0,
    approvedPettyCashUsd: 0,
    balanceDueCompanyOrPromotorUsd: 0,
    auditNotes: '',
    pazYSalvoIssued: false,
  };
  const tastingReports = app?.tastingReports ?? [];
  const module1Bundle = app?.module1Bundle ?? null;
  const currentUserName = app?.currentUser?.name || 'Torre de Control CODIZULCA';

  const activeCanonicalSucursal = app?.activeCanonicalSucursal ?? null;
  const effectiveSucursal =
    (app as unknown as { activeSucursal?: OperativeSucursal | null } | null)?.activeSucursal ??
    app?.verifiedSucursal ??
    'GLOBAL';
  const regionLabel =
    formatCanonicalSucursalBadge(activeCanonicalSucursal) ??
    SUCURSAL_LABELS[effectiveSucursal] ??
    String(effectiveSucursal);
  const todayIso = new Date().toISOString().slice(0, 10);
  const sucursalSlug = String(activeCanonicalSucursal ?? effectiveSucursal).toLowerCase();

  const buildModule1TastingItems = (): TastingScheduleItem[] => {
    const rawItems: TastingScheduleItem[] =
      module1Bundle?.tastingItems && module1Bundle.tastingItems.length > 0
        ? module1Bundle.tastingItems.map((t) => ({
            id: t.id,
            date: t.date,
            timeRange: t.timeRange,
            activityTitle: t.activityTitle,
            productName: t.productName,
            responsibleName: t.responsibleName,
            storeName: t.storeName,
            zone: t.zone,
            status: t.status,
            currentSamples: t.currentSamples,
            targetSamples: t.targetSamples,
            acceptancePercent: t.acceptancePercent,
            sellerApplicant: t.sellerApplicant,
            isArchived: t.isArchived,
          }))
        : visits.map((v) => ({
            id: v.id,
            date: v.date,
            timeRange: v.shift === 'MAÑANA' ? '08:00 - 13:00' : '13:00 - 18:00',
            activityTitle: `Activación en ${v.storeName}`,
            productName: v.fillProductSelection || v.productFocus || 'Degustación',
            responsibleName: v.promotoraName,
            storeName: v.storeName,
            zone: v.zone || regionLabel,
            status: (v.status === 'COMPLETADA'
              ? 'COMPLETADO'
              : v.status === 'EN_CURSO'
                ? 'EN_CURSO'
                : 'PROGRAMADO') as 'PENDIENTE' | 'PROGRAMADO' | 'EN_CURSO' | 'COMPLETADO',
            currentSamples: 0,
            targetSamples: 0,
            acceptancePercent: undefined,
            sellerApplicant: v.sellerName || 'SIN VENDEDOR',
            isArchived: false,
          }));

    if (!activeCanonicalSucursal) return rawItems;
    return rawItems.filter((item) => {
      const inferred = inferCanonicalSucursalFromText(`${item.storeName ?? ''} ${item.zone ?? ''}`);
      return !inferred || inferred === activeCanonicalSucursal;
    });
  };

  // Module 1: Promotoras y FDV
  const handleDownloadModule1 = async () => {
    const tastingItems = buildModule1TastingItems();
    try {
      const { exportTastingSchedulePdf } = await import('../../utils/pdfExport');
      await exportTastingSchedulePdf(tastingItems, 'actual', { regionLabel });
    } catch {
      return;
    }
    setDownloadedModule('field');
    setTimeout(() => setDownloadedModule(null), 3000);
  };

  const handleXlsxModule1 = async () => {
    const tastingItems = buildModule1TastingItems();
    const { downloadExecutiveWorkbookXlsx } = await import('../../utils/excelWordExport');
    await downloadExecutiveWorkbookXlsx(
      {
        title: 'Módulo 1 · Cronograma Operativo de Promotoras y FDV',
        generatedBy: currentUserName,
        regionLabel,
        sheets: [
          {
            name: 'Promotoras y FDV',
            headers: [
              'Fecha',
              'Horario',
              'Actividad',
              'Producto',
              'Promotora Responsable',
              'Punto de Venta',
              'Zona',
              'Estado',
              'Muestras Ejecutadas',
              'Meta Muestras',
              'Solicitante FDV',
            ],
            rows: tastingItems.map((item) => [
              item.date,
              item.timeRange,
              item.activityTitle,
              item.productName,
              item.responsibleName,
              item.storeName,
              item.zone,
              item.status,
              item.currentSamples ?? 0,
              item.targetSamples ?? 0,
              item.sellerApplicant || 'Coordinación Trade',
            ]),
          },
        ],
      },
      `codizulca-modulo1-promotoras-fdv-${sucursalSlug}-${todayIso}`
    );
  };

  const handleDocxModule1 = async () => {
    const tastingItems = buildModule1TastingItems();
    const completedCount = tastingItems.filter((i) => i.status === 'COMPLETADO').length;
    const { downloadDocxReport } = await import('../../utils/excelWordExport');
    await downloadDocxReport(
      {
        title: 'Informe Operativo · Módulo 1: Promotoras y FDV',
        subtitle: 'Cronograma de degustaciones en PDV, solicitudes de vendedores y rutas activas',
        regionLabel,
        metadata: [
          ['Fecha de emisión', new Date().toLocaleDateString('es-VE')],
          ['Emitido por', currentUserName],
          ['Total actividades programadas', String(tastingItems.length)],
          ['Actividades completadas', String(completedCount)],
        ],
        sections: [
          {
            heading: 'Activaciones y Rutas en Punto de Venta',
            table: {
              headers: ['Fecha', 'PDV', 'Producto', 'Promotora', 'FDV', 'Estado'],
              rows: tastingItems.map((item) => [
                `${item.date} (${item.timeRange})`,
                `${item.storeName} · ${item.zone}`,
                item.productName,
                item.responsibleName,
                item.sellerApplicant || 'Coordinación Trade',
                item.status,
              ]),
            },
          },
        ],
      },
      `codizulca-modulo1-promotoras-fdv-${sucursalSlug}-${todayIso}`
    );
  };

  const handlePrintModule1 = async () => {
    onClose();
    const { triggerBrowserPrint } = await import('../../utils/pdfExport');
    triggerBrowserPrint(`CODIZULCA - Módulo 1: Promotoras y FDV (${regionLabel})`);
  };

  // Module 2: Llenado por Productos (Cronograma)
  const computeModule2Totals = () => {
    const mortadela = visits.reduce((acc, v) => acc + (v.mortadelaQty || 0), 0);
    const espalda = visits.reduce((acc, v) => acc + (v.espaldaQty || 0), 0);
    const azucar = visits.reduce((acc, v) => acc + (v.azucarGrams || 0), 0);
    const leche = visits.reduce((acc, v) => acc + (v.lecheGrams || 0), 0);
    const vencampo = visits.filter(
      (v) =>
        (v.fillProductSelection && v.fillProductSelection.includes('VENCAMPO')) ||
        (v.productFocus && v.productFocus.includes('VENCAMPO'))
    ).length;
    return { mortadela, vencampo, azucar, leche, espalda };
  };

  const handleDownloadModule2 = async () => {
    const totals = computeModule2Totals();
    try {
      const { exportScheduleMatrixPdf } = await import('../../utils/pdfExport');
      await exportScheduleMatrixPdf(visits, 'TODOS', totals, { regionLabel });
    } catch {
      return;
    }
    setDownloadedModule('cronograma');
    setTimeout(() => setDownloadedModule(null), 3000);
  };

  const handleXlsxModule2 = async () => {
    const totals = computeModule2Totals();
    const { downloadExecutiveWorkbookXlsx } = await import('../../utils/excelWordExport');
    await downloadExecutiveWorkbookXlsx(
      {
        title: 'Módulo 2 · Matriz Consolidada de Llenado por Productos',
        generatedBy: currentUserName,
        regionLabel,
        sheets: [
          {
            name: 'Matriz PDVs',
            headers: [
              'Fecha / Día',
              'Turno',
              'Punto de Venta',
              'Zona',
              'Producto Asignado',
              'Mortadela (un)',
              'Espalda (un)',
              'Arroz (un)',
              'Azúcar (g)',
              'Leche (g)',
              'Vendedor FDV',
              'Promotora',
              'Estado',
            ],
            rows: visits.map((v) => [
              v.dayLabel || v.date,
              v.shift,
              v.storeName,
              v.zone,
              v.fillProductSelection || v.productFocus,
              v.mortadelaQty || 0,
              v.espaldaQty || 0,
              v.arrozQty || 0,
              v.azucarGrams || 0,
              v.lecheGrams || 0,
              v.sellerName,
              v.promotoraName,
              v.status,
            ]),
          },
          {
            name: 'Consolidado Insumos',
            headers: ['Insumo / Rubro', 'Cantidad Total'],
            rows: [
              ['Mortadela Asturias (un)', totals.mortadela],
              ['Espalda Ahumada (un)', totals.espalda],
              ['Stands Vencampo', totals.vencampo],
              ['Azúcar (kg)', Number((totals.azucar / 1000).toFixed(2))],
              ['Leche (kg)', Number((totals.leche / 1000).toFixed(2))],
            ],
          },
        ],
      },
      `codizulca-modulo2-cronograma-pdvs-${sucursalSlug}-${todayIso}`
    );
  };

  const handleDocxModule2 = async () => {
    const totals = computeModule2Totals();
    const { downloadDocxReport } = await import('../../utils/excelWordExport');
    await downloadDocxReport(
      {
        title: 'Matriz Oficial Consolidada de Degustaciones y Despacho en PDV',
        subtitle: 'Módulo 2 · Llenado por Productos e Insumos Operativos',
        regionLabel,
        metadata: [
          ['Fecha de emisión', new Date().toLocaleDateString('es-VE')],
          ['Emitido por', currentUserName],
          ['Puntos de Venta programados', String(visits.length)],
          ['Mortadela Asturias (un)', String(totals.mortadela)],
          ['Espalda Ahumada (un)', String(totals.espalda)],
          ['Stands Vencampo', String(totals.vencampo)],
          ['Azúcar / Leche (kg)', `${(totals.azucar / 1000).toFixed(2)} kg / ${(totals.leche / 1000).toFixed(2)} kg`],
        ],
        sections: [
          {
            heading: 'Cronograma de Visitas y Llenado en PDV',
            table: {
              headers: ['Fecha / Turno', 'Cliente PDV', 'Producto', 'FDV', 'Promotora', 'Estado'],
              rows: visits.map((v) => [
                `${v.dayLabel || v.date} · ${v.shift}`,
                `${v.storeName} (${v.zone})`,
                v.fillProductSelection || v.productFocus,
                v.sellerName,
                v.promotoraName,
                v.status,
              ]),
            },
          },
        ],
      },
      `codizulca-modulo2-cronograma-pdvs-${sucursalSlug}-${todayIso}`
    );
  };

  const handlePrintModule2 = async () => {
    onClose();
    const { triggerBrowserPrint } = await import('../../utils/pdfExport');
    triggerBrowserPrint(`CODIZULCA - Módulo 2: Llenado de Productos (${regionLabel})`);
  };

  // Module 3: Contraloría
  const handleDownloadModule3 = async () => {
    if (requests.length > 0) {
      try {
        const { exportContraloriaPdf } = await import('../../utils/pdfExport');
        await exportContraloriaPdf(requests[0]!, reconciliation, requests, { regionLabel });
      } catch {
        return;
      }
    }
    setDownloadedModule('contraloria');
    setTimeout(() => setDownloadedModule(null), 3000);
  };

  const buildContraloriaSheets = () => [
    {
      name: 'Solicitudes',
      headers: ['Código / ID', 'Propósito', 'Estado', 'Tope aprobado (USD)', 'Costo estimado (USD)'],
      rows: requests.map((r) => [
        r.requestCode || r.id,
        r.campaignOrPurpose,
        r.status,
        r.approvedBudgetCapUsd,
        r.estimatedCostUsd,
      ]),
      currencyColumns: [3, 4],
    },
    {
      name: 'Conciliación',
      headers: ['Entregadas', 'Degustadas', 'Devueltas', 'Diferencia'],
      rows: [
        [
          reconciliation.deliveredUnits,
          reconciliation.degustatedUnitsReported,
          reconciliation.returnedRemanentUnits,
          reconciliation.deliveredUnits -
            (reconciliation.degustatedUnitsReported + reconciliation.returnedRemanentUnits),
        ],
      ],
    },
  ];

  const handleXlsxModule3 = async () => {
    const { downloadExecutiveWorkbookXlsx } = await import('../../utils/excelWordExport');
    await downloadExecutiveWorkbookXlsx(
      {
        title: 'Contraloría Interna · Conciliación',
        generatedBy: currentUserName,
        regionLabel,
        sheets: buildContraloriaSheets(),
      },
      `contraloria-${sucursalSlug}-${todayIso}`
    );
  };

  const handleDocxModule3 = async () => {
    const { downloadDocxReport } = await import('../../utils/excelWordExport');
    await downloadDocxReport(
      {
        title: 'Acta de Conciliación · Contraloría Interna',
        regionLabel,
        metadata: [
          ['Fecha de emisión', new Date().toLocaleDateString('es-VE')],
          ['Emitido por', currentUserName],
          ['Unidades entregadas', String(reconciliation.deliveredUnits)],
          ['Unidades degustadas', String(reconciliation.degustatedUnitsReported)],
          ['Unidades devueltas', String(reconciliation.returnedRemanentUnits)],
        ],
        sections: [
          {
            heading: 'Solicitudes',
            table: {
              headers: ['Código / ID', 'Tope aprobado (USD)', 'Costo estimado (USD)'],
              rows: requests.map((r) => [
                String(r.requestCode || r.id),
                r.approvedBudgetCapUsd.toFixed(2),
                r.estimatedCostUsd.toFixed(2),
              ]),
            },
          },
        ],
      },
      `acta-contraloria-${sucursalSlug}-${todayIso}`
    );
  };

  const handlePrintModule3 = async () => {
    onClose();
    const { triggerBrowserPrint } = await import('../../utils/pdfExport');
    triggerBrowserPrint(`CODIZULCA - Módulo 3: Contraloría y Conciliación (${regionLabel})`);
  };

  // Module 4: KPI y Trazabilidad
  const computeModule4Metrics = () => {
    const totalVisits = visits.length;
    const completed = visits.filter(
      (v) => v.status === 'EN_CURSO' || v.status === 'COMPLETADA'
    ).length;
    const compliance = totalVisits > 0 ? Math.round((completed / totalVisits) * 100) : 0;

    const invSamples =
      module1Bundle?.inventorySampling?.reduce((s, r) => s + (r.portionsSampled || 0), 0) || 0;
    const invSales =
      module1Bundle?.inventorySampling?.reduce((s, r) => s + (r.salesGenerated || 0), 0) || 0;

    const totalContacts =
      invSamples > 0
        ? invSamples
        : tastingReports.reduce((acc, r) => acc + r.directContactsImpacts, 0);
    const totalAssistedSales =
      invSales > 0
        ? invSales
        : tastingReports.reduce((acc, r) => acc + r.assistedSalesUnits, 0);
    const convRate =
      totalContacts > 0 ? ((totalAssistedSales / totalContacts) * 100).toFixed(1) : '0.0';
    const approvedBudget = requests.reduce((acc, r) => acc + (r.approvedBudgetCapUsd || 0), 0);
    const executedBudget = requests.reduce((acc, r) => acc + (r.estimatedCostUsd || 0), 0);
    const avgCpc = totalContacts > 0 ? (executedBudget / totalContacts).toFixed(3) : '0.000';
    const budgetPct = approvedBudget > 0 ? Math.round((executedBudget / approvedBudget) * 100) : 0;

    return {
      totalVisits,
      completed,
      compliance,
      totalContacts,
      totalAssistedSales,
      convRate,
      approvedBudget,
      executedBudget,
      avgCpc,
      budgetPct,
    };
  };

  const handleDownloadModule4 = async () => {
    const m = computeModule4Metrics();
    try {
      const { exportExecutiveKpisPdf } = await import('../../utils/pdfExport');
      await exportExecutiveKpisPdf({
        routeCompliancePct: m.compliance,
        totalVisits: m.totalVisits,
        completedVisits: m.completed,
        totalContacts: m.totalContacts,
        totalAssistedSales: m.totalAssistedSales,
        conversionRate: m.convRate,
        samplingCostUsd: m.executedBudget,
        avgCpc: m.avgCpc,
        approvedBudget: m.approvedBudget,
        executedBudget: m.executedBudget,
        budgetPct: m.budgetPct,
        regionLabel,
      });
    } catch {
      return;
    }
    setDownloadedModule('kpis');
    setTimeout(() => setDownloadedModule(null), 3000);
  };

  const handleXlsxModule4 = async () => {
    const m = computeModule4Metrics();
    const { downloadExecutiveWorkbookXlsx } = await import('../../utils/excelWordExport');
    await downloadExecutiveWorkbookXlsx(
      {
        title: 'Módulo 4 · Informe Ejecutivo de KPIs y Trazabilidad',
        generatedBy: currentUserName,
        regionLabel,
        sheets: [
          {
            name: 'KPIs Ejecutivos',
            headers: ['Indicador Clave (KPI)', 'Valor', 'Detalle'],
            rows: [
              [
                'Cumplimiento de Ruta (%)',
                `${m.compliance}%`,
                `${m.completed} de ${m.totalVisits} activaciones`,
              ],
              ['Impactos Directos (Muestras)', m.totalContacts, 'Contactos en PDV'],
              ['Ventas Asistidas (Unidades)', m.totalAssistedSales, 'Desplazamiento auditado'],
              ['Conversión (%)', `${m.convRate}%`, `CPC promedio: $${m.avgCpc}`],
              [
                'Ejecución Presupuestaria (%)',
                `${m.budgetPct}%`,
                `$${m.executedBudget.toFixed(2)} de $${m.approvedBudget.toFixed(2)} USD`,
              ],
            ],
          },
        ],
      },
      `codizulca-modulo4-kpis-${sucursalSlug}-${todayIso}`
    );
  };

  const handleDocxModule4 = async () => {
    const m = computeModule4Metrics();
    const { downloadDocxReport } = await import('../../utils/excelWordExport');
    await downloadDocxReport(
      {
        title: 'Informe Ejecutivo de KPIs y Trazabilidad',
        subtitle: 'Módulo 4 · Torre de Control Comercial y Contraloría',
        regionLabel,
        metadata: [
          ['Fecha de emisión', new Date().toLocaleDateString('es-VE')],
          ['Emitido por', currentUserName],
          ['Cumplimiento de ruta', `${m.compliance}% (${m.completed}/${m.totalVisits})`],
          ['Ejecución presupuestaria', `${m.budgetPct}% ($${m.executedBudget.toFixed(2)} USD)`],
        ],
        sections: [
          {
            heading: 'Indicadores Clave Auditados',
            table: {
              headers: ['KPI', 'Resultado', 'Observación'],
              rows: [
                ['Impactos Directos', String(m.totalContacts), 'Muestras entregadas en PDV'],
                ['Ventas Asistidas', String(m.totalAssistedSales), 'Unidades desplazadas'],
                ['Conversión / CPC', `${m.convRate}% | $${m.avgCpc}`, 'Eficiencia comercial BTL'],
              ],
            },
          },
        ],
      },
      `codizulca-modulo4-kpis-${sucursalSlug}-${todayIso}`
    );
  };

  const handlePrintModule4 = async () => {
    onClose();
    const { triggerBrowserPrint } = await import('../../utils/pdfExport');
    triggerBrowserPrint(`CODIZULCA - Módulo 4: KPIs y Auditoría (${regionLabel})`);
  };

  const modulesList = [
    {
      id: 'promotoras',
      number: 'Módulo 1',
      title: 'Promotoras y FDV',
      description: 'Cronograma de degustaciones en PDV, solicitudes de vendedores y rutas.',
      icon: Smartphone,
      onDownload: handleDownloadModule1,
      onPrint: handlePrintModule1,
      onXlsx: handleXlsxModule1,
      onDocx: handleDocxModule1,
      isDownloaded: downloadedModule === 'field',
    },
    {
      id: 'llenado_cronograma',
      number: 'Módulo 2',
      title: 'Llenado por productos (Cronograma)',
      description: 'Matriz consolidada de puntos de venta con cálculo de insumos por jornada.',
      icon: Calendar,
      onDownload: handleDownloadModule2,
      onPrint: handlePrintModule2,
      onXlsx: handleXlsxModule2,
      onDocx: handleDocxModule2,
      isDownloaded: downloadedModule === 'cronograma',
    },
    {
      id: 'contraloria',
      number: 'Módulo 3',
      title: 'Contraloría',
      description: 'Acta de rendición, conciliación trípode y Paz y Salvo con firmas.',
      icon: Scale,
      onDownload: handleDownloadModule3,
      onPrint: handlePrintModule3,
      onXlsx: handleXlsxModule3,
      onDocx: handleDocxModule3,
      isDownloaded: downloadedModule === 'contraloria',
    },
    {
      id: 'kpis_trazabilidad',
      number: 'Módulo 4',
      title: 'KPI y Trazabilidad',
      description: 'Tablero ejecutivo de efectividad, costos por contacto y bitácora.',
      icon: BarChart3,
      onDownload: handleDownloadModule4,
      onPrint: handlePrintModule4,
      onXlsx: handleXlsxModule4,
      onDocx: handleDocxModule4,
      isDownloaded: downloadedModule === 'kpis',
    },
  ];

  return (
    <div
      data-testid="global-export-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fadeIn"
    >
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />

        <div className="flex items-center justify-between pb-4 border-b border-zinc-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center font-black text-white text-base shadow-lg shadow-red-950/70 border border-red-500">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-black text-white tracking-tight">
                  Exportar Reportes Ejecutivos (PDF · Excel · Word)
                </h3>
                <span
                  data-testid="global-export-region-badge"
                  className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-red-600/15 text-red-300 border border-red-500/30"
                >
                  {regionLabel}
                </span>
              </div>
              <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-red-500 inline" />
                <span>CODIZULCA C.A. • RIF J-07011928-0 • {regionLabel}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          <span className="text-[10px] font-black uppercase tracking-wider text-red-500 block">
            Elige el módulo a imprimir o descargar ({regionLabel}):
          </span>

          {modulesList.map((m) => {
            const isCurrent = activeTab === m.id;
            return (
              <div
                key={m.id}
                className={`p-4 rounded-xl border transition flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                  isCurrent
                    ? 'bg-zinc-900/90 border-red-600/80 shadow-md shadow-red-950/30'
                    : 'bg-black border-zinc-900 hover:border-zinc-800'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                      isCurrent
                        ? 'bg-red-600 text-white border-red-500'
                        : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                    }`}
                  >
                    <m.icon className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-black text-red-500 uppercase">
                        {m.number}
                      </span>
                      {isCurrent && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-600 text-white font-bold">
                          MÓDULO ACTIVO
                        </span>
                      )}
                    </div>
                    <h4 className="text-xs font-black text-white">{m.title}</h4>
                    <p className="text-[11px] text-zinc-400">{m.description}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {m.onXlsx && (
                    <button
                      type="button"
                      data-testid={`export-xlsx-${m.id}`}
                      onClick={() => void m.onXlsx()}
                      className="px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold cursor-pointer"
                    >
                      Excel
                    </button>
                  )}
                  {m.onDocx && (
                    <button
                      type="button"
                      data-testid={`export-docx-${m.id}`}
                      onClick={() => void m.onDocx()}
                      className="px-3 py-2 rounded-xl bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold cursor-pointer"
                    >
                      Word
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void m.onPrint()}
                    title={`Imprimir soporte de ${m.title}`}
                    className="px-3 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-zinc-200 hover:text-white text-xs font-bold border border-zinc-800 hover:border-zinc-600 transition flex items-center gap-1.5 cursor-pointer"
                  >
                    <Printer className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Imprimir</span>
                  </button>

                  <button
                    type="button"
                    data-testid={`export-pdf-${m.id}`}
                    onClick={() => void m.onDownload()}
                    title={`Descargar archivo PDF de ${m.title}`}
                    className="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-black border border-red-500 transition flex items-center gap-1.5 shadow-sm shadow-red-950/60 cursor-pointer"
                  >
                    {m.isDownloaded ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                        <span>¡Descargado!</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5 text-white" />
                        <span>Descargar PDF</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
