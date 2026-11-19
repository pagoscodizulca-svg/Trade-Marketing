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
import {
  exportScheduleMatrixPdf,
  exportContraloriaPdf,
  exportExecutiveKpisPdf,
  exportTastingSchedulePdf,
  triggerBrowserPrint,
} from '../../utils/pdfExport';
import { MainNavTab } from './Header';

interface GlobalExportPdfModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: MainNavTab;
}

export const GlobalExportPdfModal: React.FC<GlobalExportPdfModalProps> = ({
  isOpen,
  onClose,
  activeTab,
}) => {
  const { visits, requests, reconciliation, tastingReports, module1Bundle } = useApp();
  const [downloadedModule, setDownloadedModule] = useState<string | null>(null);

  if (!isOpen) return null;

  // Module 1: Promotoras y FDV (datos reales sincronizados desde Supabase)
  const handleDownloadModule1 = async () => {
    const tastingItems =
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
            zone: v.zone || 'Zulia',
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

    try {
      await exportTastingSchedulePdf(tastingItems, 'actual');
    } catch {
      return;
    }
    setDownloadedModule('field');
    setTimeout(() => setDownloadedModule(null), 3000);
  };

  const handlePrintModule1 = () => {
    onClose();
    triggerBrowserPrint('CODIZULCA - Módulo 1: Promotoras y FDV');
  };

  // Module 2: Llenado por Productos (Cronograma)
  const handleDownloadModule2 = async () => {
    const totalMortadela = visits.reduce((acc, v) => acc + (v.mortadelaQty || 0), 0);
    const totalEspalda = visits.reduce((acc, v) => acc + (v.espaldaQty || 0), 0);
    const totalAzucarGrams = visits.reduce((acc, v) => acc + (v.azucarGrams || 0), 0);
    const totalLecheGrams = visits.reduce((acc, v) => acc + (v.lecheGrams || 0), 0);
    const totalVencampoStands = visits.filter(
      (v) =>
        (v.fillProductSelection && v.fillProductSelection.includes('VENCAMPO')) ||
        (v.productFocus && v.productFocus.includes('VENCAMPO'))
    ).length;

    try {
      await exportScheduleMatrixPdf(visits, 'TODOS', {
        mortadela: totalMortadela,
        vencampo: totalVencampoStands,
        azucar: totalAzucarGrams,
        leche: totalLecheGrams,
        espalda: totalEspalda,
      });
    } catch {
      return;
    }
    setDownloadedModule('cronograma');
    setTimeout(() => setDownloadedModule(null), 3000);
  };

  const handlePrintModule2 = () => {
    onClose();
    triggerBrowserPrint('CODIZULCA - Módulo 2: Llenado de Productos');
  };

  // Module 3: Contraloría
  const handleDownloadModule3 = async () => {
    if (requests.length > 0) {
      try {
        await exportContraloriaPdf(requests[0], reconciliation, requests);
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
      headers: ['ID', 'Tope aprobado (USD)', 'Costo estimado (USD)'],
      rows: requests.map((r) => [r.id, r.approvedBudgetCapUsd, r.estimatedCostUsd]),
      currencyColumns: [1, 2],
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
        generatedBy: 'Torre de Control',
        sheets: buildContraloriaSheets(),
      },
      `contraloria-${new Date().toISOString().slice(0, 10)}`
    );
  };

  const handleDocxModule3 = async () => {
    const { downloadDocxReport } = await import('../../utils/excelWordExport');
    await downloadDocxReport(
      {
        title: 'Acta de Conciliación · Contraloría Interna',
        metadata: [
          ['Fecha de emisión', new Date().toLocaleDateString('es-VE')],
          ['Unidades entregadas', String(reconciliation.deliveredUnits)],
          ['Unidades degustadas', String(reconciliation.degustatedUnitsReported)],
          ['Unidades devueltas', String(reconciliation.returnedRemanentUnits)],
        ],
        sections: [
          {
            heading: 'Solicitudes',
            table: {
              headers: ['ID', 'Tope aprobado (USD)', 'Costo estimado (USD)'],
              rows: requests.map((r) => [
                String(r.id),
                r.approvedBudgetCapUsd.toFixed(2),
                r.estimatedCostUsd.toFixed(2),
              ]),
            },
          },
        ],
      },
      `acta-contraloria-${new Date().toISOString().slice(0, 10)}`
    );
  };

  const handlePrintModule3 = () => {
    onClose();
    triggerBrowserPrint('CODIZULCA - Módulo 3: Contraloría y Conciliación');
  };

  // Module 4: KPI y Trazabilidad
  const handleDownloadModule4 = async () => {
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

    try {
      await exportExecutiveKpisPdf({
        routeCompliancePct: compliance,
        totalVisits,
        completedVisits: completed,
        totalContacts,
        totalAssistedSales,
        conversionRate: convRate,
        samplingCostUsd: executedBudget,
        avgCpc,
        approvedBudget,
        executedBudget,
        budgetPct,
      });
    } catch {
      return;
    }
    setDownloadedModule('kpis');
    setTimeout(() => setDownloadedModule(null), 3000);
  };

  const handlePrintModule4 = () => {
    onClose();
    triggerBrowserPrint('CODIZULCA - Módulo 4: KPIs y Auditoría');
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
      isDownloaded: downloadedModule === 'kpis',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fadeIn">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />

        <div className="flex items-center justify-between pb-4 border-b border-zinc-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center font-black text-white text-base shadow-lg shadow-red-950/70 border border-red-500">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-white tracking-tight">
                Exportar Soporte en PDF
              </h3>
              <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-red-500 inline" />
                <span>CODIZULCA C.A. • RIF J-07011928-0</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-4 space-y-3 max-h-[60.h] overflow-y-auto pr-1">
          <span className="text-[10px] font-black uppercase tracking-wider text-red-500 block">
            Elige el módulo a imprimir o descargar:
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
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-red-600 text-white font-bold">
                          MÓDULO ACTIVO
                        </span>
                      )}
                    </div>
                    <h4 className="text-xs font-black text-white">{m.title}</h4>
                    <p className="text-[11px] text-zinc-400">{m.description}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {'onXlsx' in m && m.onXlsx && (
                    <button
                      type="button"
                      onClick={() => void m.onXlsx()}
                      className="px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold cursor-pointer"
                    >
                      Excel
                    </button>
                  )}
                  {'onDocx' in m && m.onDocx && (
                    <button
                      type="button"
                      onClick={() => void m.onDocx()}
                      className="px-3 py-2 rounded-xl bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold cursor-pointer"
                    >
                      Word
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={m.onPrint}
                    title={`Imprimir soporte de ${m.title}`}
                    className="px-3 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-zinc-200 hover:text-white text-xs font-bold border border-zinc-800 hover:border-zinc-600 transition flex items-center gap-1.5"
                  >
                    <Printer className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Imprimir</span>
                  </button>

                  <button
                    type="button"
                    onClick={m.onDownload}
                    title={`Descargar archivo PDF de ${m.title}`}
                    className="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-black border border-red-500 transition flex items-center gap-1.5 shadow-sm shadow-red-950/60"
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
