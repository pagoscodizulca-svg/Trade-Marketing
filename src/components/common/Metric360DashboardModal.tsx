import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Store as StoreIcon,
  Calendar,
  TrendingUp,
  Users,
  ShoppingBag,
  MapPin,
  Sun,
  Moon,
  Search,
  Download,
  Filter,
  BarChart3,
  Scale,
  ClipboardCheck,
  CheckCircle2,
  ExternalLink,
  Layers,
  DollarSign,
  Box,
  Star,
} from 'lucide-react';
import type { ScheduledVisit } from '../../types';
import type { Module1SupabaseBundle } from '../../services/supabaseModule1';
import type { TastingScheduleItem } from '../field/FieldPromotoraView';
import {
  type LiveVenezuelaClock,
  getRollingWeekWindow,
  MONTH_NAMES_FULL_ES,
} from '../../utils/weekCalendar';
import {
  type Metric360Id,
  type Metric360SwitcherItem,
  type Metric360TimeLens,
  buildMetric360CsvContent,
  computeMetric360Snapshot,
} from '../../utils/metric360AnalyticsEngine';

export type { Metric360Id, Metric360SwitcherItem, Metric360TimeLens };

interface Metric360DashboardModalProps {
  isOpen: boolean;
  metricId: Metric360Id | null;
  onSelectMetric: (id: Metric360Id) => void;
  onClose: () => void;
  switcherItems: Metric360SwitcherItem[];
  visits: ScheduledVisit[];
  tastingItems?: TastingScheduleItem[];
  module1Bundle: Module1SupabaseBundle | null;
  liveClock: LiveVenezuelaClock;
  onApplyTableFilter?: (payload: {
    metricId: Metric360Id;
    productFilter?: string;
    timeLens: Metric360TimeLens;
    weekStartYmd?: string;
    weekEndYmd?: string;
    yearMonth?: string;
  }) => void;
}

const METRIC_META: Record<
  Metric360Id,
  {
    title: string;
    subtitle: string;
    brandBadge: string;
    unitLabel: string;
    btlUnitCostUsd: number;
    productFilterCode?: string;
  }
> = {
  mortadela: {
    title: 'Mortadela Asturias · Dashboard 360°',
    subtitle:
      'Radiografía integral de unidades programadas, cobertura PDV, fuerza de campo, evolución semanal, inventario y precios frente a la competencia.',
    brandBadge: 'LÍNEA ASTURIAS',
    unitLabel: 'unidades',
    btlUnitCostUsd: 12.0,
    productFilterCode: 'MORTADELA',
  },
  vencampo: {
    title: 'Stands & Línea Vencampo · Dashboard 360°',
    subtitle:
      'Visión 360° de activaciones de Arroz + Stand, insumos asociados, cobertura por zona, rotación en anaquel y competitividad de precios.',
    brandBadge: 'ARROZ + STAND VENCAMPO',
    unitLabel: 'stands / unid',
    btlUnitCostUsd: 12.5,
    productFilterCode: 'VENCAMPO',
  },
  azucar: {
    title: 'Azúcar Insumo & Góndola · Dashboard 360°',
    subtitle:
      'Control de gramos/kg despachados como insumo de degustación y desempeño de Azúcar Refinada Vencampo en inventario y precios de mercado.',
    brandBadge: 'INSUMO BTL · VENCAMPO',
    unitLabel: 'gramos',
    btlUnitCostUsd: 1.6,
    productFilterCode: 'VENCAMPO',
  },
  leche: {
    title: 'Leche en Polvo Insumo & Góndola · Dashboard 360°',
    subtitle:
      'Trazabilidad de gramos/kg asignados a stands de degustación y posicionamiento comercial de Leche en Polvo Vencampo en puntos de venta.',
    brandBadge: 'INSUMO LÁCTEO · VENCAMPO',
    unitLabel: 'gramos',
    btlUnitCostUsd: 9.4,
    productFilterCode: 'VENCAMPO',
  },
  espalda: {
    title: 'Espalda Ahumada · Dashboard 360°',
    subtitle:
      'Desempeño 360° de Línea Cocida Asturias: barras/unidades asignadas, clientes impactados, ejecución por jornada, precios e inventario.',
    brandBadge: 'LÍNEA COCIDA ASTURIAS',
    unitLabel: 'unidades',
    btlUnitCostUsd: 12.5,
    productFilterCode: 'ESPALDA',
  },
  matriz_pdv: {
    title: 'Total PDVs Matriz General · Dashboard 360°',
    subtitle:
      'Consolidado ejecutivo de toda la Tabla General: mezcla de portafolio, cobertura geográfica, carga operativa por promotora, FDV y ritmo semanal.',
    brandBadge: 'COBERTURA GLOBAL CODIZULCA',
    unitLabel: 'activaciones',
    btlUnitCostUsd: 12.0,
    productFilterCode: 'TODOS',
  },
  degustaciones_bd: {
    title: 'Degustaciones & Solicitudes FDV · Dashboard 360°',
    subtitle:
      'Trazabilidad completa de degustaciones sincronizadas con Supabase: solicitudes pendientes, ejecución por semana, vendedores y promotoras.',
    brandBadge: 'SUPABASE EN TIEMPO REAL',
    unitLabel: 'registros',
    btlUnitCostUsd: 12.0,
    productFilterCode: 'TODOS',
  },
  encuestas_pdv: {
    title: 'Encuestas Consumidor & Muestras PDV · Dashboard 360°',
    subtitle:
      'Evaluación 360° de percepción del consumidor, calificación promedio, nivel de aceptación, muestras entregadas y rotación generada en tienda.',
    brandBadge: 'INTELIGENCIA CONSUMIDOR',
    unitLabel: 'encuestas',
    btlUnitCostUsd: 0,
  },
  personal_activo: {
    title: 'Personal Activo (Promotoras & FDV) · Dashboard 360°',
    subtitle:
      'Productividad 360° de promotoras en campo (asistencia GPS, degustaciones, merchandising) y tracción de solicitudes por vendedor FDV.',
    brandBadge: 'TALENTO DE CAMPO & FDV',
    unitLabel: 'integrantes',
    btlUnitCostUsd: 0,
  },
};

export const Metric360DashboardModal: React.FC<Metric360DashboardModalProps> = ({
  isOpen,
  metricId,
  onSelectMetric,
  onClose,
  switcherItems,
  visits,
  tastingItems,
  module1Bundle,
  liveClock,
  onApplyTableFilter,
}) => {
  const [timeLens, setTimeLens] = useState<Metric360TimeLens>('GLOBAL');
  const [activeSection, setActiveSection] = useState<'resumen' | 'registros'>('resumen');
  const [drillSearch, setDrillSearch] = useState<string>('');

  // Bloqueo limpio del scroll de fondo y cierre con tecla Escape
  useEffect(() => {
    if (!isOpen || !metricId) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, metricId, onClose]);

  const prevWeek = useMemo(
    () => getRollingWeekWindow(liveClock.todayYmd, -1),
    [liveClock.todayYmd]
  );

  // Fuente Única de Verdad (Single Source of Truth) para Píldoras, KPIs, Gráficos y CSV
  const snapshot = useMemo(() => {
    const activeId = metricId ?? 'matriz_pdv';
    const meta = METRIC_META[activeId];
    return computeMetric360Snapshot({
      metricId: activeId,
      timeLens,
      switcherItems,
      visits,
      tastingItems,
      module1Bundle,
      liveClock,
      btlUnitCostUsd: meta.btlUnitCostUsd,
    });
  }, [
    metricId,
    timeLens,
    switcherItems,
    visits,
    tastingItems,
    module1Bundle,
    liveClock,
  ]);

  const searchedDrillRows = useMemo(() => {
    const q = drillSearch.trim().toLowerCase();
    if (!q) return snapshot.csvExportRows;
    return snapshot.csvExportRows.filter(
      (r) =>
        r.storeName.toLowerCase().includes(q) ||
        r.zone.toLowerCase().includes(q) ||
        r.promotora.toLowerCase().includes(q) ||
        r.seller.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q) ||
        (r.dayLabel || '').toLowerCase().includes(q) ||
        (r.ymd || '').toLowerCase().includes(q)
    );
  }, [snapshot.csvExportRows, drillSearch]);

  if (!isOpen || !metricId || typeof document === 'undefined') return null;

  const meta = METRIC_META[metricId];
  const currentMonthLabel = `${MONTH_NAMES_FULL_ES[liveClock.monthIndex]} ${liveClock.year}`;

  const handleExport360Csv = () => {
    const csvContent = buildMetric360CsvContent(searchedDrillRows);
    const blob = new Blob([csvContent], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `codizulca_dashboard_360_${metricId}_${timeLens.toLowerCase()}_${liveClock.todayYmd}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const maxWeekVal = Math.max(
    1,
    ...snapshot.rollingWeeks.map((w) =>
      metricId === 'matriz_pdv' || metricId === 'degustaciones_bd'
        ? w.activationsCount
        : metricId === 'encuestas_pdv'
          ? Math.max(w.qty, w.samples)
          : w.qty
    )
  );
  const maxStoreVal = Math.max(
    1,
    ...snapshot.topStores.map((s) => Math.max(s.qty, s.samples, s.count))
  );

  const primaryHeroDisplay = (() => {
    if (metricId === 'personal_activo') {
      const activeMembers = (module1Bundle?.staffMembers || []).filter((s) => s.status === 'Activo');
      const fijaCount = activeMembers.filter((s) => s.category === 'fija').length;
      const eventualCount = activeMembers.filter((s) => s.category === 'eventual').length;
      const merchCount = activeMembers.filter((s) => s.category === 'merchandising').length;
      return {
        value: String(activeMembers.length),
        unit: 'integrantes activos',
        sub: `${fijaCount} Fija · ${eventualCount} Eventuales · ${merchCount} Merch`,
      };
    }
    if (metricId === 'azucar' || metricId === 'leche') {
      return {
        value: snapshot.totalPrimaryQty.toLocaleString('es-VE'),
        unit: 'gramos',
        sub: `${(snapshot.totalPrimaryQty / 1000).toFixed(2)} kg en ${snapshot.totalActivations} activaciones`,
      };
    }
    if (metricId === 'matriz_pdv' || metricId === 'degustaciones_bd') {
      return {
        value: snapshot.totalActivations.toLocaleString('es-VE'),
        unit: meta.unitLabel,
        sub: `${snapshot.completionPct}% ejec. (${snapshot.completedCount}/${snapshot.totalActivations})`,
      };
    }
    if (metricId === 'vencampo') {
      return {
        value: snapshot.totalPrimaryQty.toLocaleString('es-VE'),
        unit: snapshot.lensFilteredRows[0]?.unitLabel === 'stands' ? 'stands' : 'unidades',
        sub: `${snapshot.portfolioMix.vencampoStands} stands · ${snapshot.portfolioMix.vencampoUnits} unid`,
      };
    }
    return {
      value: snapshot.totalPrimaryQty.toLocaleString('es-VE'),
      unit: meta.unitLabel,
      sub: `${snapshot.completionPct}% ejec. (${snapshot.completedCount}/${snapshot.totalActivations})`,
    };
  })();

  const modalNode = (
    <div
      className="fixed inset-0 z-[90] bg-black/85 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 lg:p-8 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={meta.title}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-7xl mx-auto bg-[#09090b] border border-white/15 rounded-3xl shadow-[0_25px_80px_rgba(0,0,0,0.95)] overflow-hidden my-auto max-h-[92vh] flex flex-col min-w-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Franja corporativa superior Roja / Blanca */}
        <div className="h-1 w-full bg-gradient-to-r from-red-700 via-red-500 to-zinc-700 shrink-0" />

        {/* CABECERA FIJA DEL DASHBOARD 360° */}
        <div className="p-4 sm:p-6 bg-zinc-950/95 border-b border-white/10 shrink-0 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-widest shadow-sm shrink-0">
                  VISIÓN 360° CODIZULCA
                </span>
                <span className="px-2.5 py-0.5 rounded-md bg-white/[0.06] text-red-300 border border-red-500/30 text-[10px] font-mono font-bold uppercase shrink-0">
                  {meta.brandBadge}
                </span>
                <span className="px-2.5 py-0.5 rounded-md bg-zinc-900 text-zinc-300 border border-white/10 text-[10px] font-mono flex items-center gap-1.5 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Sem. {liveClock.isoWeekNumber} Auto ({liveClock.currentWeek.rangeLabel})
                </span>
              </div>
              <h2 className="text-lg sm:text-2xl font-black text-white tracking-tight break-words">
                {meta.title}
              </h2>
              <p className="text-xs text-zinc-400 max-w-3xl leading-relaxed">
                {meta.subtitle}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 self-start lg:self-start shrink-0">
              <button
                type="button"
                onClick={handleExport360Csv}
                className="px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 hover:text-white text-xs font-bold border border-white/10 transition flex items-center gap-1.5 cursor-pointer shrink-0 whitespace-nowrap"
                title="Descargar registros exactos de esta vista 360° en formato CSV (UTF-8 BOM)"
              >
                <Download className="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span>Exportar 360° (CSV)</span>
              </button>

              {onApplyTableFilter && meta.productFilterCode && (
                <button
                  type="button"
                  onClick={() => {
                    onApplyTableFilter({
                      metricId,
                      productFilter: meta.productFilterCode,
                      timeLens,
                      weekStartYmd:
                        timeLens === 'SEMANA_ACTUAL'
                          ? liveClock.currentWeek.mondayYmd
                          : timeLens === 'SEMANA_ANTERIOR'
                            ? prevWeek.mondayYmd
                            : undefined,
                      weekEndYmd:
                        timeLens === 'SEMANA_ACTUAL'
                          ? liveClock.currentWeek.sundayYmd
                          : timeLens === 'SEMANA_ANTERIOR'
                            ? prevWeek.sundayYmd
                            : undefined,
                      yearMonth: timeLens === 'MES_ACTUAL' ? liveClock.yearMonth : undefined,
                    });
                    onClose();
                  }}
                  className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-black tracking-wide border border-red-400/50 shadow-lg shadow-red-950/60 transition flex items-center gap-1.5 cursor-pointer shrink-0 whitespace-nowrap"
                >
                  <Filter className="w-3.5 h-3.5 shrink-0" />
                  <span>Enfocar en Tabla</span>
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar Dashboard 360°"
                className="p-2 rounded-xl bg-zinc-900 hover:bg-red-600 text-zinc-400 hover:text-white border border-white/10 transition cursor-pointer shrink-0"
                title="Cerrar Dashboard 360° (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Barra Superior Interactiva con flex-wrap real: Cero recortes horizontales en Píldoras y Lentes */}
          <div className="flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-3 pt-3 border-t border-white/[0.07]">
            {/* Selector rápido entre tarjetas de métricas con badges sincronizados al período activo */}
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {snapshot.resolvedSwitcherItems.map((sw) => {
                const isSelected = sw.id === metricId;
                return (
                  <button
                    key={sw.id}
                    type="button"
                    onClick={() => onSelectMetric(sw.id)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap shrink-0 border transition-all flex items-center gap-2 cursor-pointer ${
                      isSelected
                        ? 'bg-red-600 text-white border-red-500 shadow-[0_2px_12px_rgba(220,38,38,0.45)]'
                        : 'bg-zinc-900/90 text-zinc-300 border-white/[0.08] hover:border-red-500/40 hover:text-white'
                    }`}
                  >
                    <span>{sw.label}</span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md shrink-0 ${
                        isSelected
                          ? 'bg-black/35 text-white font-black'
                          : 'bg-zinc-950 text-zinc-400'
                      }`}
                    >
                      {sw.badgeValue}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Lente Temporal Conectada al Motor de Semanas Automáticas (America/Caracas UTC-4) */}
            <div className="inline-flex flex-wrap items-center gap-1.5 bg-zinc-900/90 p-1.5 rounded-xl border border-white/[0.08] self-start 2xl:self-auto">
              {[
                { id: 'GLOBAL' as const, label: 'Consolidado Total' },
                {
                  id: 'SEMANA_ACTUAL' as const,
                  label: `Sem. Actual (${liveClock.currentWeek.shortRangeLabel})`,
                },
                {
                  id: 'SEMANA_ANTERIOR' as const,
                  label: `Sem. Anterior (${prevWeek.shortRangeLabel})`,
                },
                {
                  id: 'MES_ACTUAL' as const,
                  label: `Mes (${currentMonthLabel})`,
                },
              ].map((lens) => {
                const active = timeLens === lens.id;
                return (
                  <button
                    key={lens.id}
                    type="button"
                    onClick={() => setTimeLens(lens.id)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap shrink-0 transition cursor-pointer ${
                      active
                        ? 'bg-white text-black shadow-sm'
                        : 'text-zinc-400 hover:text-white hover:bg-white/[0.05]'
                    }`}
                  >
                    {lens.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* CUERPO DESPLAZABLE DEL DASHBOARD 360° */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-6 flex-1 min-w-0">
          {/* 1. GRILLA RESPONSIVA DE 4 KPIs EJECUTIVOS AMPLIOS (Cero recortes en títulos, cifras e íconos) */}
          {metricId === 'encuestas_pdv' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {/* KPI 1: Encuestas & Tareas de Campo */}
              <div className="p-4 rounded-2xl bg-gradient-to-b from-red-950/35 via-zinc-900/95 to-zinc-950 border border-red-500/35 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-red-300">
                  <span>Encuestas & Tareas PDV</span>
                  <ClipboardCheck className="w-4 h-4 text-red-400 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-2xl font-black text-white font-mono">
                    {snapshot.surveyMetrics.totalSurveys.toLocaleString('es-VE')}
                  </span>
                  <span className="text-xs text-zinc-400">encuestas reales</span>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-300">
                  <span>
                    {snapshot.surveyMetrics.breveCount} Breves · {snapshot.surveyMetrics.profundaCount} Prof.
                  </span>
                  <span className="text-zinc-400">
                    {snapshot.morningCount} Mañ / {snapshot.afternoonCount} Tar
                  </span>
                </div>
              </div>

              {/* KPI 2: Cobertura de Clientes y Zonas */}
              <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-zinc-300">
                  <span>Cobertura Clientes & Zonas</span>
                  <StoreIcon className="w-4 h-4 text-red-400 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-2xl font-black text-white font-mono">
                    {snapshot.uniqueStoresCount.toLocaleString('es-VE')}
                  </span>
                  <span className="text-xs text-zinc-400">clientes PDV únicos</span>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                  <span>Zonas cubiertas:</span>
                  <span className="font-mono font-bold text-white">
                    {snapshot.uniqueZonesCount} sectores
                  </span>
                </div>
              </div>

              {/* KPI 3: Calificación Promedio y Nivel de Aceptación */}
              <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-zinc-300">
                  <span>Calificación & Aceptación</span>
                  <Star className="w-4 h-4 text-amber-400 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline gap-2 flex-wrap">
                  <span className="text-2xl font-black text-white font-mono">
                    ★ {snapshot.surveyMetrics.avgRating.toFixed(2)}
                  </span>
                  <span className="text-xs text-zinc-400">/ 5.0 prom.</span>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                  <span>Nivel de aceptación:</span>
                  <span className="font-mono font-bold text-emerald-400">
                    {snapshot.surveyMetrics.highAcceptancePercent}% positiva
                  </span>
                </div>
              </div>

              {/* KPI 4: Muestras Entregadas, Rotación y Precio $ */}
              <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-zinc-300">
                  <span>Muestras, Rotación & $</span>
                  <ShoppingBag className="w-4 h-4 text-emerald-400 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-2xl font-black text-white font-mono">
                    {snapshot.totalSamples.toLocaleString('es-VE')}
                  </span>
                  <span className="text-xs text-zinc-400">muestras entregadas</span>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-400">
                  <span>
                    Rotación:{' '}
                    <strong className="text-emerald-400">
                      {snapshot.shelfMovedUnits.toLocaleString('es-VE')} un
                    </strong>
                  </span>
                  <span className="text-zinc-200">
                    {snapshot.avgOwnPrice > 0
                      ? `$${snapshot.avgOwnPrice.toFixed(2)} PDV`
                      : `${snapshot.matchingPrices.length} aud. $`}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {/* KPI 1: Volumen Seleccionado & Ejecución de Tareas/Jornadas */}
              <div className="p-4 rounded-2xl bg-gradient-to-b from-red-950/35 via-zinc-900/95 to-zinc-950 border border-red-500/35 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-red-300">
                  <span>Volumen & Tareas</span>
                  <Box className="w-4 h-4 text-red-400 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-2xl font-black text-white font-mono">
                    {primaryHeroDisplay.value}
                  </span>
                  <span className="text-xs text-zinc-400">{primaryHeroDisplay.unit}</span>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-300">
                  <span className="truncate">{primaryHeroDisplay.sub}</span>
                  <span className="inline-flex items-center gap-1.5 text-zinc-400 shrink-0">
                    <Sun className="w-3 h-3 text-amber-400" />
                    {snapshot.morningCount}
                    <Moon className="w-3 h-3 text-red-400 ml-0.5" />
                    {snapshot.afternoonCount}
                  </span>
                </div>
              </div>

              {/* KPI 2: Cobertura de Clientes PDV & Zonas */}
              <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-zinc-300">
                  <span>Cobertura Clientes & Zonas</span>
                  <StoreIcon className="w-4 h-4 text-red-400 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-2xl font-black text-white font-mono">
                    {snapshot.uniqueStoresCount.toLocaleString('es-VE')}
                  </span>
                  <span className="text-xs text-zinc-400">clientes PDV únicos</span>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                  <span>
                    Zonas: <strong className="text-white font-mono">{snapshot.uniqueZonesCount}</strong>
                  </span>
                  <span className="font-mono text-zinc-300">{snapshot.matrixSharePct}% matriz</span>
                </div>
              </div>

              {/* KPI 3: Muestras Entregadas, Rotación y Aceptación */}
              <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-zinc-300">
                  <span>Muestras & Rotación PDV</span>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-2xl font-black text-white font-mono">
                    {snapshot.totalSamples.toLocaleString('es-VE')}
                  </span>
                  <span className="text-xs text-zinc-400">muestras entregadas</span>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-400">
                  <span>
                    Rotación:{' '}
                    <strong className="text-emerald-400">
                      {snapshot.shelfMovedUnits.toLocaleString('es-VE')} un
                    </strong>
                  </span>
                  <span>
                    {snapshot.surveyMetrics.totalSurveys > 0
                      ? `★ ${snapshot.surveyMetrics.avgRating.toFixed(1)} (${snapshot.surveyMetrics.highAcceptancePercent}%)`
                      : `${snapshot.pendingCount} pend.`}
                  </span>
                </div>
              </div>

              {/* KPI 4: Competitividad de Precio e Inversión BTL */}
              <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-bold text-zinc-300">
                  <span>Precio Anaquel & BTL ($)</span>
                  <DollarSign className="w-4 h-4 text-red-400 shrink-0" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-2xl font-black text-white font-mono">
                    {snapshot.avgOwnPrice > 0
                      ? `$${snapshot.avgOwnPrice.toFixed(2)}`
                      : `$${snapshot.estimatedBtlCostUsd.toFixed(0)}`}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {snapshot.avgOwnPrice > 0 ? 'prom. PDV' : 'inversión BTL'}
                  </span>
                </div>
                <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                  {snapshot.priceGapPct !== null ? (
                    <>
                      <span>Vs. Comp (${snapshot.avgCompPrice.toFixed(2)}):</span>
                      <span
                        className={`font-mono font-bold ${
                          snapshot.priceGapPct <= 0 ? 'text-emerald-400' : 'text-amber-300'
                        }`}
                      >
                        {snapshot.priceGapPct > 0 ? '+' : ''}
                        {snapshot.priceGapPct.toFixed(1)}%
                      </span>
                    </>
                  ) : (
                    <>
                      <span>Auditorías precio:</span>
                      <span className="font-mono text-zinc-300">{snapshot.matchingPrices.length} reg.</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Conmutador interno: Vista Gráfica 360° vs Tabla de Registros Detallados */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div className="inline-flex flex-wrap items-center bg-zinc-950 p-1 rounded-xl border border-white/10 gap-1">
              <button
                type="button"
                onClick={() => setActiveSection('resumen')}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition cursor-pointer ${
                  activeSection === 'resumen'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5 shrink-0" />
                <span>Inteligencia y Gráficos 360°</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveSection('registros')}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition cursor-pointer ${
                  activeSection === 'registros'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Layers className="w-3.5 h-3.5 shrink-0" />
                <span>Trazabilidad Fila por Fila ({snapshot.csvExportRows.length})</span>
              </button>
            </div>

            <span className="text-[11px] font-mono text-zinc-400">
              Fecha operativa Venezuela (UTC-4):{' '}
              <strong className="text-white">{liveClock.todayLongLabel}</strong>
            </span>
          </div>

          {activeSection === 'resumen' ? (
            <div className="space-y-5">
              {/* Mix de portafolio cuando es Matriz General o Degustaciones BD */}
              {(metricId === 'matriz_pdv' || metricId === 'degustaciones_bd') && (
                <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <span className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                      <Layers className="w-4 h-4 text-red-500 shrink-0" />
                      Composición del Portafolio en el Período Seleccionado
                    </span>
                    <span className="text-[11px] text-zinc-400 font-mono">
                      Clic en cualquier rubro para abrir su vista 360° individual
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
                    {[
                      {
                        id: 'mortadela' as Metric360Id,
                        label: 'Mortadela Asturias',
                        val: `${snapshot.portfolioMix.mortadela} un`,
                      },
                      {
                        id: 'vencampo' as Metric360Id,
                        label: 'Stands Vencampo',
                        val: `${snapshot.portfolioMix.vencampoStands} stands (${snapshot.portfolioMix.vencampoUnits} un)`,
                      },
                      {
                        id: 'espalda' as Metric360Id,
                        label: 'Espalda Ahumada',
                        val: `${snapshot.portfolioMix.espalda} un`,
                      },
                      {
                        id: 'azucar' as Metric360Id,
                        label: 'Azúcar Insumo',
                        val: `${snapshot.portfolioMix.azucarKg} kg`,
                      },
                      {
                        id: 'leche' as Metric360Id,
                        label: 'Leche en Polvo',
                        val: `${snapshot.portfolioMix.lecheKg} kg`,
                      },
                    ].map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onSelectMetric(p.id)}
                        className="p-3 rounded-xl bg-zinc-900/80 hover:bg-red-950/30 border border-white/[0.07] hover:border-red-500/40 text-left transition cursor-pointer min-w-0"
                      >
                        <div className="text-[10px] text-zinc-400 font-semibold">{p.label}</div>
                        <div className="text-sm sm:text-base font-black text-white font-mono mt-1">
                          {p.val}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* FILA 1 DE PANELES 360°: EVOLUCIÓN SEMANAL AUTOMÁTICA + RANKING TOP PDVs */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Panel A: Evolución Semanal Automática */}
                <div className="lg:col-span-6 p-5 rounded-2xl bg-zinc-950 border border-white/10 flex flex-col justify-between min-w-0">
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <h3 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-red-500 shrink-0" />
                        Evolución Semanal Automática (Lunes – Domingo)
                      </h3>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-600/20 text-red-300 border border-red-500/30 shrink-0">
                        UTC-4 Auto-Rollover
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mb-4">
                      Ventana móvil en zona horaria America/Caracas con corte inclusivo Lunes a Domingo.
                    </p>

                    <div className="space-y-2.5">
                      {snapshot.rollingWeeks.map((wk) => {
                        const metricVal =
                          metricId === 'matriz_pdv' || metricId === 'degustaciones_bd'
                            ? wk.activationsCount
                            : wk.qty;
                        const barBasis =
                          metricId === 'encuestas_pdv'
                            ? Math.max(wk.qty, wk.samples)
                            : metricVal;
                        const barPct =
                          barBasis === 0 ? 0 : Math.max(5, Math.round((barBasis / maxWeekVal) * 100));

                        return (
                          <div
                            key={`${wk.isoWeekNumber}-${wk.offset}`}
                            className={`p-2.5 rounded-xl border transition ${
                              wk.isCurrentWeek
                                ? 'bg-red-950/25 border-red-500/50'
                                : 'bg-zinc-900/50 border-white/[0.06]'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono font-bold text-white">
                                  Sem {wk.isoWeekNumber}
                                </span>
                                <span className="text-[11px] text-zinc-400 font-mono">
                                  ({wk.rangeLabel})
                                </span>
                                {wk.isCurrentWeek && (
                                  <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-red-600 text-white uppercase">
                                    Semana Actual
                                  </span>
                                )}
                                {wk.isFutureWeek && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 uppercase">
                                    Próxima
                                  </span>
                                )}
                              </div>
                              <div className="text-right font-mono">
                                <span className="font-black text-white">{metricVal}</span>{' '}
                                <span className="text-[10px] text-zinc-400">
                                  {meta.unitLabel}
                                  {metricId === 'encuestas_pdv' && wk.samples > 0
                                    ? ` · ${wk.samples} muestras`
                                    : ''}{' '}
                                  · {wk.pdvs} PDVs
                                </span>
                              </div>
                            </div>
                            <div className="h-2 w-full bg-black rounded-full overflow-hidden border border-white/[0.05]">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${
                                  wk.isCurrentWeek ? 'bg-red-500' : 'bg-zinc-400'
                                }`}
                                style={{ width: `${barPct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Panel B: Top Puntos de Venta (Clientes) & Zonas */}
                <div className="lg:col-span-6 p-5 rounded-2xl bg-zinc-950 border border-white/10 space-y-4 min-w-0">
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                      <h3 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                        <StoreIcon className="w-4 h-4 text-red-500 shrink-0" />
                        Top Clientes / Puntos de Venta Impactados
                      </h3>
                      <span className="text-[11px] font-mono text-zinc-400">
                        {snapshot.uniqueStoresCount} tiendas únicas
                      </span>
                    </div>

                    {snapshot.topStores.length === 0 ? (
                      <div className="p-6 rounded-xl bg-zinc-900/40 border border-white/[0.05] text-center text-xs text-zinc-400">
                        Sin registros en este período para esta métrica.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {snapshot.topStores.map((st, idx) => {
                          const val = Math.max(st.qty, st.samples, st.count);
                          const pct = Math.max(6, Math.round((val / maxStoreVal) * 100));
                          return (
                            <div
                              key={`${st.name}-${idx}`}
                              className="p-2.5 rounded-xl bg-zinc-900/60 border border-white/[0.06]"
                            >
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="w-5 h-5 rounded-md bg-red-600/20 text-red-400 font-mono font-black text-[10px] flex items-center justify-center shrink-0">
                                    {idx + 1}
                                  </span>
                                  <span className="font-bold text-white truncate" title={st.name}>
                                    {st.name}
                                  </span>
                                  {st.mapsUrl && (
                                    <a
                                      href={st.mapsUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-red-400 hover:text-red-300 shrink-0"
                                      title="Ver ubicación en Google Maps"
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  )}
                                </div>
                                <span className="font-mono font-bold text-white shrink-0">
                                  {st.qty > 0
                                    ? `${st.qty} ${meta.unitLabel}`
                                    : st.samples > 0
                                      ? `${st.samples} muestras`
                                      : `${st.count} act.`}
                                </span>
                              </div>
                              <div className="mt-1.5 flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-black rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-red-600 rounded-full"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <span
                                  className="text-[10px] text-zinc-400 font-mono truncate max-w-[160px]"
                                  title={st.zone}
                                >
                                  {st.zone}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Distribución por Zonas */}
                  {snapshot.topZones.length > 0 && (
                    <div className="pt-3 border-t border-white/10">
                      <span className="text-[10px] font-black text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                        <MapPin className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        Concentración por Zona / Municipio
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {snapshot.topZones.map((z) => (
                          <span
                            key={z.zone}
                            className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-white/10 text-[11px] text-zinc-200 font-mono"
                          >
                            {z.zone}: <strong className="text-white">{z.count}</strong> PDVs
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* FILA 2 DE PANELES 360°: FUERZA DE CAMPO + INTELIGENCIA DE GÓNDOLA SUPABASE */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Panel C: Fuerza Operativa (Promotoras y Vendedores FDV / Origen) */}
                <div className="lg:col-span-6 p-5 rounded-2xl bg-zinc-950 border border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
                  {/* Top Promotoras */}
                  <div className="min-w-0">
                    <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5 mb-3">
                      <Users className="w-3.5 h-3.5 text-red-500 shrink-0" />
                      Promotoras Ejecutoras
                    </h4>
                    {snapshot.topPromotoras.length === 0 ? (
                      <p className="text-xs text-zinc-500">Sin promotoras en este período.</p>
                    ) : (
                      <div className="space-y-2">
                        {snapshot.topPromotoras.map((p) => (
                          <div
                            key={p.name}
                            className="p-2 rounded-xl bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="font-semibold text-zinc-200 truncate" title={p.name}>
                              {p.name}
                            </span>
                            <span className="font-mono text-[11px] text-red-300 font-bold shrink-0">
                              {metricId === 'encuestas_pdv'
                                ? `${p.qty} enc · ${p.samples} mues.`
                                : `${p.count} act · ${p.qty}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Top Vendedores FDV / Intención de Compra */}
                  <div className="min-w-0">
                    <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5 mb-3">
                      <TrendingUp className="w-3.5 h-3.5 text-red-500 shrink-0" />
                      {metricId === 'encuestas_pdv'
                        ? 'Intención / Origen PDV'
                        : 'Vendedores Solicitantes (FDV)'}
                    </h4>
                    {snapshot.topSellers.length === 0 ? (
                      <p className="text-xs text-zinc-500">Sin registros en este período.</p>
                    ) : (
                      <div className="space-y-2">
                        {snapshot.topSellers.map((s) => (
                          <div
                            key={s.name}
                            className="p-2 rounded-xl bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="font-semibold text-zinc-200 truncate" title={s.name}>
                              {s.name}
                            </span>
                            <span className="font-mono text-[11px] text-white font-bold shrink-0">
                              {metricId === 'encuestas_pdv'
                                ? `${s.count} reg`
                                : `${s.count} sol · ${s.qty}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Panel D: Inteligencia de Góndola en Supabase (Precios, Inventario o Personal/Encuestas) */}
                <div className="lg:col-span-6 p-5 rounded-2xl bg-zinc-950 border border-white/10 space-y-4 min-w-0">
                  {metricId === 'personal_activo' ? (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                          <ClipboardCheck className="w-4 h-4 text-red-500 shrink-0" />
                          Asistencia GPS y Desempeño de Personal (Supabase)
                        </h4>
                        <span className="text-[11px] font-mono text-zinc-400">
                          {module1Bundle?.attendanceRecords.length ?? 0} jornadas GPS
                        </span>
                      </div>
                      <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                        {(module1Bundle?.staffMembers || [])
                          .filter((st) => st.status === 'Activo')
                          .map((st) => (
                            <div
                              key={st.id}
                              className="p-2.5 rounded-xl bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <span className="font-bold text-white block truncate">{st.name}</span>
                                <span className="text-[10px] text-zinc-400 font-mono block truncate">
                                  {st.category === 'merchandising'
                                    ? 'MERCHANDISING'
                                    : st.category === 'eventual'
                                      ? 'PLANTILLA EVENTUAL'
                                      : 'PLANTILLA FIJA'}{' '}
                                  · {st.assignedStore}
                                </span>
                              </div>
                              <div className="text-right font-mono shrink-0">
                                <span className="text-red-400 font-bold block">
                                  {st.activationsCount} registros BD
                                </span>
                                <span className="text-[10px] text-emerald-400">{st.status}</span>
                              </div>
                            </div>
                          ))}
                      </div>
                    </>
                  ) : metricId === 'encuestas_pdv' ? (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                          <ClipboardCheck className="w-4 h-4 text-red-500 shrink-0" />
                          Desglose Validado de Encuestas y Muestreo en PDV
                        </h4>
                        <span className="text-[11px] font-mono text-amber-300 font-bold">
                          ★ {snapshot.surveyMetrics.avgRating.toFixed(2)} / 5.0
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="p-3 rounded-xl bg-zinc-900 border border-white/10">
                          <span className="text-[10px] text-zinc-400 block">Encuestas Breves</span>
                          <span className="text-xl font-black text-white font-mono">
                            {snapshot.surveyMetrics.breveCount}
                          </span>
                        </div>
                        <div className="p-3 rounded-xl bg-zinc-900 border border-white/10">
                          <span className="text-[10px] text-zinc-400 block">Encuestas Profundas</span>
                          <span className="text-xl font-black text-white font-mono">
                            {snapshot.surveyMetrics.profundaCount}
                          </span>
                        </div>
                        <div className="p-3 rounded-xl bg-zinc-900 border border-white/10">
                          <span className="text-[10px] text-zinc-400 block">Alta Aceptación</span>
                          <span className="text-xl font-black text-emerald-400 font-mono">
                            {snapshot.surveyMetrics.highAcceptancePercent}%
                          </span>
                        </div>
                      </div>
                      <div className="p-3 rounded-xl bg-zinc-900/60 border border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-zinc-300">
                        <span>
                          Muestras período:{' '}
                          <strong className="text-white">
                            {snapshot.totalSamples.toLocaleString('es-VE')}
                          </strong>
                        </span>
                        <span>
                          Rotación generada:{' '}
                          <strong className="text-emerald-400">
                            {snapshot.shelfMovedUnits.toLocaleString('es-VE')} un
                          </strong>
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                          <Scale className="w-4 h-4 text-red-500 shrink-0" />
                          Cruce en Góndola: Precios vs. Competencia e Inventario
                        </h4>
                        <span className="text-[11px] font-mono text-zinc-400">
                          {snapshot.matchingPrices.length} precios · {snapshot.matchingInventory.length} inv.
                        </span>
                      </div>

                      {snapshot.matchingPrices.length === 0 &&
                      snapshot.matchingInventory.length === 0 ? (
                        <div className="p-5 rounded-xl bg-zinc-900/40 border border-white/[0.05] text-xs text-zinc-400 text-center">
                          No hay tomas de precio o auditorías de inventario adicionales para este filtro temporal.
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                          {snapshot.matchingInventory.slice(0, 4).map((inv) => (
                            <div
                              key={inv.id}
                              className="p-2.5 rounded-xl bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <span className="font-bold text-white block truncate">
                                  📦 {inv.storeName}
                                </span>
                                <span className="text-[10px] text-zinc-400 font-mono block truncate">
                                  {inv.productName} · {inv.date}
                                </span>
                              </div>
                              <div className="text-right font-mono shrink-0">
                                <span className="text-emerald-400 font-bold block">
                                  Inic: {inv.initialStock} → Fin: {inv.finalStock}
                                </span>
                                <span className="text-[10px] text-zinc-400">
                                  Muestras: {inv.portionsSampled}
                                </span>
                              </div>
                            </div>
                          ))}

                          {snapshot.matchingPrices
                            .filter((p) => p.ownPriceUsd > 0 && p.ownPriceUsd <= 35)
                            .slice(0, 5)
                            .map((pc) => (
                              <div
                                key={pc.id}
                                className="p-2.5 rounded-xl bg-zinc-900/50 border border-white/[0.05] flex items-center justify-between gap-2 text-xs"
                              >
                                <div className="min-w-0">
                                  <span className="font-semibold text-zinc-200 block truncate">
                                    💲 {pc.storeName}
                                  </span>
                                  <span className="text-[10px] text-zinc-400 font-mono block truncate">
                                    {pc.ownProduct} ({pc.date})
                                  </span>
                                </div>
                                <div className="text-right font-mono shrink-0">
                                  <span className="text-white font-bold">
                                    ${pc.ownPriceUsd.toFixed(2)}
                                  </span>{' '}
                                  <span className="text-[10px] text-zinc-400">
                                    vs ${pc.averageCompetitorPriceUsd.toFixed(2)}
                                  </span>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* SECCIÓN 2: TABLA DE TRAZABILIDAD DETALLADA FILA POR FILA */
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="relative w-full sm:w-96">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={drillSearch}
                    onChange={(e) => setDrillSearch(e.target.value)}
                    placeholder="Filtrar por cliente, promotora, vendedor, zona o día..."
                    className="w-full pl-9 pr-3 py-2 rounded-xl bg-zinc-950 border border-white/10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500"
                  />
                </div>
                <span className="text-xs font-mono text-zinc-400">
                  Mostrando <strong className="text-white">{searchedDrillRows.length}</strong> registros reconciliados
                </span>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-white/10 bg-zinc-950">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-black border-b border-white/10 text-[10px] font-black uppercase text-zinc-400 tracking-wider">
                      <th className="p-3">Fecha / Día</th>
                      <th className="p-3">Jornada</th>
                      <th className="p-3">Cliente / PDV</th>
                      <th className="p-3">Zona</th>
                      <th className="p-3">Producto</th>
                      <th className="p-3 text-right">Cantidad</th>
                      <th className="p-3 text-right">Muestras</th>
                      <th className="p-3 text-right">Rotación</th>
                      <th className="p-3">Promotora</th>
                      <th className="p-3">
                        {metricId === 'encuestas_pdv' ? 'Calif. / Acept.' : 'Vendedor FDV'}
                      </th>
                      <th className="p-3 text-center">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-zinc-200">
                    {searchedDrillRows.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="p-8 text-center text-zinc-500">
                          No se encontraron registros para el filtro aplicado.
                        </td>
                      </tr>
                    ) : (
                      searchedDrillRows.slice(0, 150).map((row) => (
                        <tr key={row.id} className="hover:bg-white/[0.03] transition">
                          <td className="p-3 font-mono whitespace-nowrap text-white">
                            {row.dayLabel}
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-white/10">
                              {row.shift}
                            </span>
                          </td>
                          <td className="p-3 font-bold text-white">{row.storeName}</td>
                          <td className="p-3 text-zinc-400">{row.zone}</td>
                          <td className="p-3 text-red-300 font-semibold">{row.productName}</td>
                          <td className="p-3 text-right font-mono font-black text-white whitespace-nowrap">
                            {row.primaryQty} {row.unitLabel}
                          </td>
                          <td className="p-3 text-right font-mono text-zinc-200 whitespace-nowrap">
                            {row.samplesDelivered}
                          </td>
                          <td className="p-3 text-right font-mono text-emerald-400 whitespace-nowrap">
                            {row.shelfMovedUnits} un
                          </td>
                          <td className="p-3 text-zinc-200">{row.promotora}</td>
                          <td className="p-3 font-mono text-zinc-300 whitespace-nowrap">
                            {metricId === 'encuestas_pdv'
                              ? row.rating !== null
                                ? `★ ${row.rating.toFixed(1)} · ${row.acceptanceLabel}`
                                : row.acceptanceLabel || '—'
                              : row.seller}
                          </td>
                          <td className="p-3 text-center whitespace-nowrap">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-zinc-900 border border-white/10 text-zinc-200">
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalNode, document.body);
};
