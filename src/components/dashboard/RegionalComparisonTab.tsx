import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Building2,
  Calendar,
  CheckCircle2,
  DollarSign,
  FileSpreadsheet,
  FileText,
  Lock,
  PackageSearch,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Users,
} from 'lucide-react';
import { useOptionalApp } from '../../context/AppContext';
import {
  fetchComparativoRegionesResumen,
  type RegionalComparisonRow,
} from '../../services/regionesService';
import { isSupabaseConfigured } from '../../services/supabaseClient';
import {
  SUCURSAL_LABELS,
  isOperativeSucursal,
  type OperativeSucursal,
} from '../../services/userManagementService';

export interface RegionalComparisonTabProps {
  initialRows?: RegionalComparisonRow[];
  initialPeriodoInicio?: string;
  initialPeriodoFin?: string;
  isAuthorized?: boolean;
  generatedBy?: string;
  onSelectSucursalToInspect?: (sucursal: OperativeSucursal) => void;
}

function formatUsd(amount: number): string {
  return `$${(Number.isFinite(amount) ? amount : 0).toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(pct: number): string {
  return `${(Number.isFinite(pct) ? pct : 0).toFixed(1)}%`;
}

function resolveHubTitle(row: RegionalComparisonRow): string {
  if (isOperativeSucursal(row.region_codigo)) {
    return SUCURSAL_LABELS[row.region_codigo];
  }
  return /^sucursal\b/i.test(row.region_nombre)
    ? row.region_nombre
    : `Sucursal ${row.region_nombre}`;
}

export const RegionalComparisonTab: React.FC<RegionalComparisonTabProps> = ({
  initialRows,
  initialPeriodoInicio = '',
  initialPeriodoFin = '',
  isAuthorized,
  generatedBy,
  onSelectSucursalToInspect,
}) => {
  const appCtx = useOptionalApp();

  const effectiveAuthorized =
    isAuthorized !== undefined
      ? isAuthorized
      : appCtx
        ? appCtx.isContraloriaOrAdmin
        : true;

  const effectiveGeneratedBy =
    generatedBy ||
    appCtx?.currentUser?.name ||
    appCtx?.currentUser?.email ||
    'Dirección Nacional / Contraloría CODIZULCA';

  const [periodoInicio, setPeriodoInicio] = useState<string>(initialPeriodoInicio);
  const [periodoFin, setPeriodoFin] = useState<string>(initialPeriodoFin);
  const [rows, setRows] = useState<RegionalComparisonRow[]>(() => initialRows ?? []);
  const [loading, setLoading] = useState<boolean>(
    () => !initialRows && effectiveAuthorized && isSupabaseConfigured
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<'xlsx' | 'pdf' | null>(null);

  useEffect(() => {
    if (initialRows) {
      setRows(initialRows);
    }
  }, [initialRows]);

  const loadComparativo = useCallback(
    async (customRange?: { inicio: string; fin: string }) => {
      if (!effectiveAuthorized) return;
      const inicio = (customRange ? customRange.inicio : periodoInicio).trim() || null;
      const fin = (customRange ? customRange.fin : periodoFin).trim() || null;

      if (inicio && fin && fin < inicio) {
        setErrorMsg('La fecha "Hasta" no puede ser anterior a la fecha "Desde".');
        return;
      }

      if (!isSupabaseConfigured) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMsg(null);
      try {
        const result = await fetchComparativoRegionesResumen({
          periodoInicio: inicio,
          periodoFin: fin,
        });
        setRows(result);
      } catch (err) {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'No se pudo consultar el comparativo consolidado por región.'
        );
      } finally {
        setLoading(false);
      }
    },
    [effectiveAuthorized, periodoInicio, periodoFin]
  );

  useEffect(() => {
    if (!initialRows && effectiveAuthorized && isSupabaseConfigured) {
      void loadComparativo({ inicio: initialPeriodoInicio, fin: initialPeriodoFin });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAuthorized]);

  const totals = useMemo(() => {
    const acc = rows.reduce(
      (sum, r) => ({
        clientes: sum.clientes + r.clientes_activos,
        promotoras: sum.promotoras + r.promotoras_activas,
        vendedores: sum.vendedores + r.vendedores_activos,
        rutasProg: sum.rutasProg + r.rutas_programadas,
        rutasComp: sum.rutasComp + r.rutas_completadas,
        degProg: sum.degProg + r.degustaciones_programadas,
        degEjec: sum.degEjec + r.degustaciones_ejecutadas,
        muestras: sum.muestras + r.muestras_entregadas,
        ventas: sum.ventas + r.ventas_asistidas,
        presAsig: sum.presAsig + r.presupuesto_asignado_usd,
        presEjec: sum.presEjec + r.presupuesto_ejecutado_usd,
        mp07Total: sum.mp07Total + r.requisiciones_mp07_total,
        mp07Conc: sum.mp07Conc + r.requisiciones_conciliadas,
        popActivos: sum.popActivos + r.pop_items_activos,
        popCriticos: sum.popCriticos + r.pop_stock_critico_count,
        incTotales: sum.incTotales + r.incidencias_totales,
        incAbiertas: sum.incAbiertas + r.incidencias_abiertas,
        incEnSla: sum.incEnSla + r.incidencias_en_sla_count,
      }),
      {
        clientes: 0,
        promotoras: 0,
        vendedores: 0,
        rutasProg: 0,
        rutasComp: 0,
        degProg: 0,
        degEjec: 0,
        muestras: 0,
        ventas: 0,
        presAsig: 0,
        presEjec: 0,
        mp07Total: 0,
        mp07Conc: 0,
        popActivos: 0,
        popCriticos: 0,
        incTotales: 0,
        incAbiertas: 0,
        incEnSla: 0,
      }
    );

    const rutasPct = acc.rutasProg > 0 ? Math.min(100, (acc.rutasComp * 100) / acc.rutasProg) : 0;
    const presPct = acc.presAsig > 0 ? (acc.presEjec * 100) / acc.presAsig : 0;
    const slaPct = acc.incTotales > 0 ? Math.min(100, (acc.incEnSla * 100) / acc.incTotales) : 0;

    return {
      ...acc,
      rutasPct,
      presPct,
      slaPct,
    };
  }, [rows]);

  const periodSubtitle = useMemo(() => {
    if (periodoInicio && periodoFin) return `Período ${periodoInicio} al ${periodoFin}`;
    if (periodoInicio) return `Desde ${periodoInicio}`;
    if (periodoFin) return `Hasta ${periodoFin}`;
    return 'Acumulado Histórico Consolidado';
  }, [periodoInicio, periodoFin]);

  const handleExportXlsx = async () => {
    if (exportingFormat) return;
    setExportingFormat('xlsx');
    try {
      const { downloadExecutiveWorkbookXlsx } = await import('../../utils/excelWordExport');
      const stamp = new Date().toISOString().slice(0, 10);

      await downloadExecutiveWorkbookXlsx(
        {
          title: `CODIZULCA C.A. · Comparativo Consolidado por Región (${periodSubtitle})`,
          generatedBy: effectiveGeneratedBy,
          generatedAtIso: new Date().toISOString(),
          sheets: [
            {
              name: 'Comparativo 5 Regiones',
              headers: [
                'Código Región',
                'Sucursal',
                'Clientes Activos',
                'Promotoras Activas',
                'Vendedores FDV',
                'Rutas Prog.',
                'Rutas Comp.',
                'Cumpl. Rutas (%)',
                'Degust. Prog.',
                'Degust. Ejec.',
                'Muestras Entregadas',
                'Ventas Asistidas',
                'Presupuesto Asignado (USD)',
                'Presupuesto Ejecutado (USD)',
                'Ejecución Presup. (%)',
                'MP-07 Total',
                'MP-07 Conciliadas',
                'POP Activos',
                'POP Stock Crítico',
                'Incidencias Totales',
                'Incidencias Abiertas',
                'Incidencias en SLA',
                'Cumpl. SLA (%)',
              ],
              rows: [
                ...rows.map((r) => [
                  r.region_codigo,
                  resolveHubTitle(r),
                  r.clientes_activos,
                  r.promotoras_activas,
                  r.vendedores_activos,
                  r.rutas_programadas,
                  r.rutas_completadas,
                  r.cumplimiento_rutas_pct,
                  r.degustaciones_programadas,
                  r.degustaciones_ejecutadas,
                  r.muestras_entregadas,
                  r.ventas_asistidas,
                  r.presupuesto_asignado_usd,
                  r.presupuesto_ejecutado_usd,
                  r.ejecucion_presupuestaria_pct,
                  r.requisiciones_mp07_total,
                  r.requisiciones_conciliadas,
                  r.pop_items_activos,
                  r.pop_stock_critico_count,
                  r.incidencias_totales,
                  r.incidencias_abiertas,
                  r.incidencias_en_sla_count,
                  r.cumplimiento_sla_pct,
                ]),
                [
                  'NACIONAL',
                  'Consolidado 5 Regiones (Sin Mezcla de Carteras)',
                  totals.clientes,
                  totals.promotoras,
                  totals.vendedores,
                  totals.rutasProg,
                  totals.rutasComp,
                  Number(totals.rutasPct.toFixed(2)),
                  totals.degProg,
                  totals.degEjec,
                  totals.muestras,
                  totals.ventas,
                  Number(totals.presAsig.toFixed(2)),
                  Number(totals.presEjec.toFixed(2)),
                  Number(totals.presPct.toFixed(2)),
                  totals.mp07Total,
                  totals.mp07Conc,
                  totals.popActivos,
                  totals.popCriticos,
                  totals.incTotales,
                  totals.incAbiertas,
                  totals.incEnSla,
                  Number(totals.slaPct.toFixed(2)),
                ],
              ],
              currencyColumns: [12, 13],
              percentColumns: [7, 14, 22],
            },
          ],
        },
        `Codizulca_Comparativo_Regiones_${stamp}.xlsx`
      );
    } finally {
      setExportingFormat(null);
    }
  };

  const handleExportPdf = async () => {
    if (exportingFormat) return;
    setExportingFormat('pdf');
    try {
      const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);

      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();

      // Franja corporativa Codizulca
      doc.setFillColor(220, 38, 38);
      doc.rect(0, 0, pageWidth, 5, 'F');
      doc.setFillColor(18, 18, 20);
      doc.rect(0, 5, pageWidth, 1.5, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(20, 20, 20);
      doc.text(
        'CODIZULCA C.A. (RIF: J-07011928-0) — COMPARATIVO EJECUTIVO POR REGIÓN',
        12,
        14
      );

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(80, 80, 80);
      doc.text(
        `${periodSubtitle} · Emitido por: ${effectiveGeneratedBy} · Gobernanza Zero-Mixing (sin mezcla de carteras individuales)`,
        12,
        19.5
      );

      autoTable(doc, {
        startY: 24,
        head: [
          [
            'Región',
            'PDVs / Prom / FDV',
            'Cumpl. Rutas',
            'Degustaciones',
            'Muestras / Ventas',
            'Presupuesto USD (Ejec / Asig)',
            'MP-07 (Conc / Tot)',
            'POP Crítico',
            'SLA Incidencias',
          ],
        ],
        body: rows.map((r) => [
          `${r.region_codigo} · ${resolveHubTitle(r)}`,
          `${r.clientes_activos} / ${r.promotoras_activas} / ${r.vendedores_activos}`,
          `${formatPct(r.cumplimiento_rutas_pct)} (${r.rutas_completadas}/${r.rutas_programadas})`,
          `${r.degustaciones_ejecutadas}/${r.degustaciones_programadas}`,
          `${r.muestras_entregadas.toLocaleString('es-VE')} / ${r.ventas_asistidas.toLocaleString('es-VE')}`,
          `${formatUsd(r.presupuesto_ejecutado_usd)} / ${formatUsd(r.presupuesto_asignado_usd)} (${formatPct(r.ejecucion_presupuestaria_pct)})`,
          `${r.requisiciones_conciliadas}/${r.requisiciones_mp07_total}`,
          `${r.pop_stock_critico_count} crít. (${r.pop_items_activos} act.)`,
          `${formatPct(r.cumplimiento_sla_pct)} (${r.incidencias_abiertas} ab. / ${r.incidencias_totales})`,
        ]),
        foot: [
          [
            'TOTAL NACIONAL',
            `${totals.clientes} / ${totals.promotoras} / ${totals.vendedores}`,
            `${formatPct(totals.rutasPct)} (${totals.rutasComp}/${totals.rutasProg})`,
            `${totals.degEjec}/${totals.degProg}`,
            `${totals.muestras.toLocaleString('es-VE')} / ${totals.ventas.toLocaleString('es-VE')}`,
            `${formatUsd(totals.presEjec)} / ${formatUsd(totals.presAsig)} (${formatPct(totals.presPct)})`,
            `${totals.mp07Conc}/${totals.mp07Total}`,
            `${totals.popCriticos} crít. (${totals.popActivos} act.)`,
            `${formatPct(totals.slaPct)} (${totals.incAbiertas} ab. / ${totals.incTotales})`,
          ],
        ],
        styles: { fontSize: 8, cellPadding: 2.2 },
        headStyles: { fillColor: [220, 38, 38], textColor: [255, 255, 255], fontStyle: 'bold' },
        footStyles: { fillColor: [24, 24, 27], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 248, 250] },
      });

      const stamp = new Date().toISOString().slice(0, 10);
      doc.save(`Codizulca_Comparativo_Regiones_${stamp}.pdf`);
    } finally {
      setExportingFormat(null);
    }
  };

  if (!effectiveAuthorized) {
    return (
      <div
        data-testid="regional-comparison-denied"
        className="rounded-2xl bg-zinc-900/95 border border-red-500/30 p-8 text-center space-y-3"
      >
        <Lock className="w-10 h-10 text-red-500 mx-auto" />
        <h3 className="text-lg font-extrabold text-white">
          Comparativo Consolidado Reservado a Dirección Nacional y Contraloría
        </h3>
        <p className="text-xs text-zinc-400 max-w-xl mx-auto">
          Por segregación de funciones y aislamiento territorial, el comparativo multi-región solo
          está habilitado para los roles <code>super_admin</code> y <code>contraloria</code>.
        </p>
      </div>
    );
  }

  const handleInspectBranch = (code: OperativeSucursal) => {
    if (onSelectSucursalToInspect) {
      onSelectSucursalToInspect(code);
      return;
    }
    if (appCtx?.canSwitchSucursal && isOperativeSucursal(code)) {
      appCtx.setActiveSucursal(code);
    }
  };

  return (
    <div data-testid="regional-comparison-tab" className="space-y-6">
      {/* Cabecera Ejecutiva, Filtros de Período y Exportadores Dedicados */}
      <div className="bg-zinc-900/95 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-5">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-wider">
                <ShieldCheck className="w-3.5 h-3.5" />
                Consolidado Ejecutivo · 5 Hubs Nacionales
              </span>
              <span className="px-2.5 py-0.5 rounded-md bg-zinc-950 border border-white/10 text-[11px] font-mono text-zinc-300">
                Solo Lectura · Sin Mezcla de Carteras Individuales
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
              Comparativo Ejecutivo Consolidado por Región (Zulia · Valencia · Centro · Oriente · Capital)
            </h2>
            <p className="text-xs text-zinc-300">
              {periodSubtitle} — contraste directo de cumplimiento de rutas, degustaciones,
              ejecución presupuestaria <code>MP-07-XXXX</code>, stock crítico POP y SLA de incidencias.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              data-testid="comparativo-export-xlsx"
              disabled={exportingFormat !== null || rows.length === 0}
              onClick={() => void handleExportXlsx()}
              className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-bold transition cursor-pointer"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>
                {exportingFormat === 'xlsx' ? 'Generando Excel...' : 'Exportar Excel (.xlsx)'}
              </span>
            </button>

            <button
              type="button"
              data-testid="comparativo-export-pdf"
              disabled={exportingFormat !== null || rows.length === 0}
              onClick={() => void handleExportPdf()}
              className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-bold transition cursor-pointer"
            >
              <FileText className="w-4 h-4" />
              <span>
                {exportingFormat === 'pdf' ? 'Generando PDF...' : 'Exportar PDF (.pdf)'}
              </span>
            </button>
          </div>
        </div>

        {/* Barra de rango de fechas + Actualizar */}
        <div className="pt-4 border-t border-zinc-800 flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="comp-periodo-inicio"
              className="block text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1"
            >
              <Calendar className="w-3 h-3 inline mr-1 text-red-400" />
              Desde
            </label>
            <input
              id="comp-periodo-inicio"
              data-testid="comparativo-date-inicio"
              type="date"
              value={periodoInicio}
              onChange={(e) => setPeriodoInicio(e.target.value)}
              className="px-3 py-1.5 rounded-xl bg-zinc-950 border border-zinc-700 text-xs text-white font-mono focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label
              htmlFor="comp-periodo-fin"
              className="block text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1"
            >
              <Calendar className="w-3 h-3 inline mr-1 text-red-400" />
              Hasta
            </label>
            <input
              id="comp-periodo-fin"
              data-testid="comparativo-date-fin"
              type="date"
              value={periodoFin}
              onChange={(e) => setPeriodoFin(e.target.value)}
              className="px-3 py-1.5 rounded-xl bg-zinc-950 border border-zinc-700 text-xs text-white font-mono focus:outline-none focus:border-red-500"
            />
          </div>

          <button
            type="button"
            data-testid="comparativo-refresh-btn"
            disabled={loading}
            onClick={() => void loadComparativo()}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 h-[34px] rounded-xl bg-zinc-950 hover:bg-zinc-800 border border-red-500/45 text-xs font-bold text-white transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-red-400 ${loading ? 'animate-spin' : ''}`} />
            <span>Actualizar</span>
          </button>

          {(periodoInicio || periodoFin) && (
            <button
              type="button"
              onClick={() => {
                setPeriodoInicio('');
                setPeriodoFin('');
                void loadComparativo({ inicio: '', fin: '' });
              }}
              className="px-3 py-1.5 h-[34px] rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-semibold text-zinc-300 transition cursor-pointer"
            >
              Limpiar rango
            </button>
          )}
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="p-3 rounded-xl bg-red-950/50 border border-red-500/40 text-xs text-red-200 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {/* Franja Resumen Nacional (Agregado de Lectura Ejecutiva) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800">
          <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400 uppercase">
            <span>Cobertura Activa (5 Hubs)</span>
            <Users className="w-4 h-4 text-red-400" />
          </div>
          <div className="text-2xl font-black text-white font-mono mt-1.5">
            {totals.clientes.toLocaleString('es-VE')}{' '}
            <span className="text-xs font-normal text-zinc-400">PDVs</span>
          </div>
          <p className="text-[11px] text-zinc-400 mt-1">
            {totals.promotoras} promotoras · {totals.vendedores} FDV activos
          </p>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800">
          <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400 uppercase">
            <span>Cumplimiento de Rutas</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-black text-emerald-400 font-mono mt-1.5">
            {formatPct(totals.rutasPct)}
          </div>
          <p className="text-[11px] text-zinc-400 mt-1">
            {totals.rutasComp.toLocaleString('es-VE')} de{' '}
            {totals.rutasProg.toLocaleString('es-VE')} rutas completadas
          </p>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800">
          <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400 uppercase">
            <span>Degustaciones & Ventas</span>
            <ShoppingBag className="w-4 h-4 text-red-400" />
          </div>
          <div className="text-2xl font-black text-white font-mono mt-1.5">
            {totals.degEjec.toLocaleString('es-VE')}
            <span className="text-xs font-normal text-zinc-400">
              /{totals.degProg.toLocaleString('es-VE')} ejec.
            </span>
          </div>
          <p className="text-[11px] text-zinc-400 mt-1">
            {totals.muestras.toLocaleString('es-VE')} muestras ·{' '}
            {totals.ventas.toLocaleString('es-VE')} ventas asist.
          </p>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800">
          <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400 uppercase">
            <span>Ejecución Presupuesto & MP-07</span>
            <DollarSign className="w-4 h-4 text-amber-300" />
          </div>
          <div className="text-2xl font-black text-white font-mono mt-1.5">
            {formatPct(totals.presPct)}
          </div>
          <p className="text-[11px] text-zinc-400 mt-1">
            {formatUsd(totals.presEjec)} / {formatUsd(totals.presAsig)} · {totals.mp07Conc}/
            {totals.mp07Total} MP-07 concil.
          </p>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800">
          <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400 uppercase">
            <span>POP Crítico & SLA Incidencias</span>
            <PackageSearch className="w-4 h-4 text-red-400" />
          </div>
          <div className="text-2xl font-black text-white font-mono mt-1.5">
            {formatPct(totals.slaPct)}{' '}
            <span className="text-xs font-normal text-zinc-400">SLA</span>
          </div>
          <p className="text-[11px] text-zinc-400 mt-1">
            {totals.popCriticos} POP críticos · {totals.incAbiertas} incidencias abiertas
          </p>
        </div>
      </div>

      {/* Tarjetas Comparativas Lado a Lado para las 5 Sedes */}
      {rows.length > 0 && (
        <div
          data-testid="regional-comparison-cards"
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4"
        >
          {rows.map((row) => {
            const hubTitle = resolveHubTitle(row);
            const canInspect =
              Boolean(onSelectSucursalToInspect) ||
              Boolean(appCtx?.canSwitchSucursal && isOperativeSucursal(row.region_codigo));
            const routeBarWidth = Math.max(0, Math.min(100, Math.round(row.cumplimiento_rutas_pct)));

            return (
              <article
                key={row.region_id || row.region_codigo}
                data-testid={`regional-card-${row.region_codigo}`}
                className="rounded-2xl bg-zinc-900/95 border border-zinc-800 p-4 flex flex-col justify-between gap-4 shadow-lg"
              >
                <div className="space-y-3.5">
                  {/* Encabezado de Sede */}
                  <div className="flex items-start justify-between gap-2 border-b border-zinc-800 pb-3">
                    <div>
                      <span className="inline-block px-2 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30 text-[10px] font-mono font-bold">
                        {row.region_codigo}
                      </span>
                      <h3 className="text-base font-extrabold text-white mt-1">{hubTitle}</h3>
                      <p className="text-[11px] text-zinc-400 font-mono">
                        {row.clientes_activos} PDVs · {row.promotoras_activas} Prom ·{' '}
                        {row.vendedores_activos} FDV
                      </p>
                    </div>
                    <div className="w-8 h-8 rounded-xl bg-zinc-950 border border-white/10 flex items-center justify-center text-red-400 shrink-0">
                      <Building2 className="w-4 h-4" />
                    </div>
                  </div>

                  {/* Cumplimiento de Rutas */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-400 font-semibold">Cumplimiento Rutas</span>
                      <span className="font-mono font-black text-emerald-400">
                        {formatPct(row.cumplimiento_rutas_pct)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-zinc-950 border border-zinc-800 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full"
                        style={{ width: `${routeBarWidth}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-zinc-500 font-mono text-right">
                      {row.rutas_completadas}/{row.rutas_programadas} completadas
                    </div>
                  </div>

                  {/* Degustaciones, Muestras y Ventas Asistidas */}
                  <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800/90 space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-400">Degustaciones ejec.</span>
                      <span className="font-mono font-bold text-white">
                        {row.degustaciones_ejecutadas}/{row.degustaciones_programadas}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-400">Muestras entregadas</span>
                      <span className="font-mono font-bold text-zinc-200">
                        {row.muestras_entregadas.toLocaleString('es-VE')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-400">Ventas asistidas</span>
                      <span className="font-mono font-bold text-emerald-300">
                        {row.ventas_asistidas.toLocaleString('es-VE')} un
                      </span>
                    </div>
                  </div>

                  {/* Presupuesto y MP-07 */}
                  <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800/90 space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-400">Ejecución Presup.</span>
                      <span className="font-mono font-bold text-amber-300">
                        {formatPct(row.ejecucion_presupuestaria_pct)}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-zinc-300">
                      {formatUsd(row.presupuesto_ejecutado_usd)}{' '}
                      <span className="text-zinc-500">
                        / {formatUsd(row.presupuesto_asignado_usd)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] pt-0.5 border-t border-zinc-900">
                      <span className="text-zinc-400">MP-07 conciliadas</span>
                      <span className="font-mono font-bold text-white">
                        {row.requisiciones_conciliadas}/{row.requisiciones_mp07_total}
                      </span>
                    </div>
                  </div>

                  {/* POP Crítico y SLA de Incidencias */}
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="p-2 rounded-xl bg-zinc-950 border border-zinc-800/90">
                      <span className="text-zinc-400 block">POP Crítico</span>
                      <span
                        className={`font-mono font-black text-sm ${
                          row.pop_stock_critico_count > 0 ? 'text-red-400' : 'text-emerald-400'
                        }`}
                      >
                        {row.pop_stock_critico_count}
                      </span>
                      <span className="text-zinc-500 font-mono text-[10px] ml-1">
                        /{row.pop_items_activos}
                      </span>
                    </div>

                    <div className="p-2 rounded-xl bg-zinc-950 border border-zinc-800/90">
                      <span className="text-zinc-400 block">Cumpl. SLA</span>
                      <span
                        className={`font-mono font-black text-sm ${
                          row.cumplimiento_sla_pct >= 85 || row.incidencias_totales === 0
                            ? 'text-emerald-400'
                            : 'text-amber-300'
                        }`}
                      >
                        {formatPct(row.cumplimiento_sla_pct)}
                      </span>
                      <span className="text-zinc-500 font-mono text-[10px] block">
                        {row.incidencias_abiertas} ab. / {row.incidencias_totales}
                      </span>
                    </div>
                  </div>
                </div>

                {canInspect && (
                  <button
                    type="button"
                    data-testid={`inspect-hub-btn-${row.region_codigo}`}
                    onClick={() => handleInspectBranch(row.region_codigo)}
                    className="w-full py-2 px-3 rounded-xl bg-zinc-950 hover:bg-red-600 text-zinc-200 hover:text-white border border-zinc-800 hover:border-red-500 text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    <span>Inspeccionar {row.region_nombre}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Tabla Comparativa Estructurada de las 5 Regiones */}
      <div className="bg-zinc-900/95 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-red-500" />
            <h3 className="text-base font-black text-white">
              Matriz Comparativa Auditada por Sucursal
            </h3>
          </div>
          <span className="text-[11px] font-mono text-zinc-400">
            {rows.length} región(es) activa(s)
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table
            data-testid="regional-comparison-table"
            className="w-full text-left border-collapse"
          >
            <thead>
              <tr className="bg-zinc-950 border-b border-zinc-800 text-[10px] font-black text-zinc-400 uppercase tracking-wider">
                <th className="py-3 px-4">Región / Hub</th>
                <th className="py-3 px-3 text-right">PDVs / Prom / FDV</th>
                <th className="py-3 px-3 text-right">Cumpl. Rutas</th>
                <th className="py-3 px-3 text-right">Degustaciones</th>
                <th className="py-3 px-3 text-right">Muestras / Ventas</th>
                <th className="py-3 px-3 text-right">Presupuesto (Ejec / Asig)</th>
                <th className="py-3 px-3 text-center">MP-07 Concil.</th>
                <th className="py-3 px-3 text-center">POP Crítico</th>
                <th className="py-3 px-4 text-right">SLA Incidencias</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70 text-xs">
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-zinc-400 font-mono">
                    Consultando rpc_comparativo_regiones_resumen en Supabase...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-zinc-400">
                    No hay métricas comparativas disponibles para el rango seleccionado.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.region_id || r.region_codigo}
                    className="bg-zinc-900/40 hover:bg-zinc-800/50 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="font-bold text-white">{resolveHubTitle(r)}</div>
                      <div className="text-[10px] font-mono text-red-400">{r.region_codigo}</div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-zinc-300">
                      {r.clientes_activos} / {r.promotoras_activas} / {r.vendedores_activos}
                    </td>
                    <td className="py-3 px-3 text-right font-mono">
                      <span className="font-bold text-emerald-400">
                        {formatPct(r.cumplimiento_rutas_pct)}
                      </span>
                      <span className="block text-[10px] text-zinc-500">
                        {r.rutas_completadas}/{r.rutas_programadas} rutas
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-white">
                      {r.degustaciones_ejecutadas}/{r.degustaciones_programadas}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-zinc-200">
                      {r.muestras_entregadas.toLocaleString('es-VE')} m.
                      <span className="block text-[10px] text-emerald-300">
                        {r.ventas_asistidas.toLocaleString('es-VE')} ventas
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-mono">
                      <span className="font-bold text-white">
                        {formatUsd(r.presupuesto_ejecutado_usd)}
                      </span>
                      <span className="block text-[10px] text-zinc-400">
                        de {formatUsd(r.presupuesto_asignado_usd)} (
                        {formatPct(r.ejecucion_presupuestaria_pct)})
                      </span>
                    </td>
                    <td className="py-3 px-3 text-center font-mono text-zinc-200">
                      {r.requisiciones_conciliadas}/{r.requisiciones_mp07_total}
                    </td>
                    <td className="py-3 px-3 text-center font-mono">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          r.pop_stock_critico_count > 0
                            ? 'bg-red-500/15 text-red-300 border-red-500/35'
                            : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                        }`}
                      >
                        {r.pop_stock_critico_count} / {r.pop_items_activos}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono">
                      <span className="font-bold text-white">
                        {formatPct(r.cumplimiento_sla_pct)}
                      </span>
                      <span className="block text-[10px] text-zinc-400">
                        {r.incidencias_abiertas} ab. / {r.incidencias_totales} tot.
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="bg-zinc-950 border-t-2 border-red-600/50 text-xs font-bold text-white">
                  <td className="py-3 px-4 uppercase tracking-wider text-red-300">
                    Consolidado Nacional
                  </td>
                  <td className="py-3 px-3 text-right font-mono">
                    {totals.clientes} / {totals.promotoras} / {totals.vendedores}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-emerald-400">
                    {formatPct(totals.rutasPct)} ({totals.rutasComp}/{totals.rutasProg})
                  </td>
                  <td className="py-3 px-3 text-right font-mono">
                    {totals.degEjec}/{totals.degProg}
                  </td>
                  <td className="py-3 px-3 text-right font-mono">
                    {totals.muestras.toLocaleString('es-VE')} /{' '}
                    {totals.ventas.toLocaleString('es-VE')}
                  </td>
                  <td className="py-3 px-3 text-right font-mono">
                    {formatUsd(totals.presEjec)} / {formatUsd(totals.presAsig)} (
                    {formatPct(totals.presPct)})
                  </td>
                  <td className="py-3 px-3 text-center font-mono">
                    {totals.mp07Conc}/{totals.mp07Total}
                  </td>
                  <td className="py-3 px-3 text-center font-mono text-red-300">
                    {totals.popCriticos} / {totals.popActivos}
                  </td>
                  <td className="py-3 px-4 text-right font-mono">
                    {formatPct(totals.slaPct)} ({totals.incAbiertas}/{totals.incTotales})
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
};
