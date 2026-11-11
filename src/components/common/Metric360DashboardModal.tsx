import React, { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { ScheduledVisit, PriceComparisonThreeBrands } from '../../types';
import {
  Module1SupabaseBundle,
  InventorySamplingRecord,
} from '../../services/supabaseModule1';
import type { TastingScheduleItem } from '../field/FieldPromotoraView';
import {
  LiveVenezuelaClock,
  getRollingWeekWindow,
  normalizeAnyDateToYmd,
  MONTH_NAMES_FULL_ES,
} from '../../utils/weekCalendar';

export type Metric360Id =
  | 'mortadela'
  | 'vencampo'
  | 'azucar'
  | 'leche'
  | 'espalda'
  | 'matriz_pdv'
  | 'degustaciones_bd'
  | 'encuestas_pdv'
  | 'personal_activo';

export type Metric360TimeLens =
  | 'GLOBAL'
  | 'SEMANA_ACTUAL'
  | 'SEMANA_ANTERIOR'
  | 'MES_ACTUAL';

export interface Metric360SwitcherItem {
  id: Metric360Id;
  label: string;
  badgeValue: string;
}

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

interface Unified360Row {
  id: string;
  ymd: string | null;
  dayLabel: string;
  shift: string;
  storeName: string;
  zone: string;
  productName: string;
  promotora: string;
  seller: string;
  primaryQty: number;
  unitLabel: string;
  mortadelaQty: number;
  espaldaQty: number;
  arrozQty: number;
  azucarGrams: number;
  lecheGrams: number;
  samplesDelivered: number;
  status: string;
  mapsUrl?: string;
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
      ' Productividad 360° de promotoras en campo (asistencia GPS, degustaciones, merchandising) y tracción de solicitudes por vendedor FDV.',
    brandBadge: 'TALENTO DE CAMPO & FDV',
    unitLabel: 'integrantes',
    btlUnitCostUsd: 0,
  },
};

function matchesProductLineForSupabase(metricId: Metric360Id, text: string): boolean {
  const u = (text || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  switch (metricId) {
    case 'mortadela':
      return u.includes('MORTADELA') || u.includes('JAMON') || u.includes('SALCHICHA') || u.includes('PECHUGA');
    case 'vencampo':
      return u.includes('VENCAMPO') || u.includes('ARROZ') || u.includes('CARAOTA') || u.includes('ARVEJA') || u.includes('ACEITE');
    case 'azucar':
      return u.includes('AZUCAR');
    case 'leche':
      return u.includes('LECHE');
    case 'espalda':
      return u.includes('ESPALDA');
    default:
      return true;
  }
}

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

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const prevWeek = useMemo(
    () => getRollingWeekWindow(liveClock.todayYmd, -1),
    [liveClock.todayYmd]
  );

  // Mapa rápido de muestras entregadas en Supabase por ID de visita/degustación
  const supabaseTastingById = useMemo(() => {
    const map = new Map<string, TastingScheduleItem>();
    (tastingItems || module1Bundle?.tastingItems || []).forEach((it) => {
      map.set(it.id, it);
    });
    return map;
  }, [tastingItems, module1Bundle]);

  // Filtro temporal según la lente activa (Global / Semana en Curso Auto / Semana Anterior / Mes Actual Auto)
  const matchesTimeLens = useMemo(() => {
    return (rawDate?: string | null): boolean => {
      if (timeLens === 'GLOBAL') return true;
      const ymd = normalizeAnyDateToYmd(rawDate);
      if (!ymd) return false;

      if (timeLens === 'SEMANA_ACTUAL') {
        return ymd >= liveClock.currentWeek.mondayYmd && ymd <= liveClock.currentWeek.sundayYmd;
      }
      if (timeLens === 'SEMANA_ANTERIOR') {
        return ymd >= prevWeek.mondayYmd && ymd <= prevWeek.sundayYmd;
      }
      if (timeLens === 'MES_ACTUAL') {
        return ymd.slice(0, 7) === liveClock.yearMonth;
      }
      return true;
    };
  }, [timeLens, liveClock.currentWeek, liveClock.yearMonth, prevWeek]);

  // Construcción de filas unificadas para la métrica seleccionada
  const allRowsForMetric = useMemo<Unified360Row[]>(() => {
    if (!metricId) return [];

    // Construimos filas combinando visits + tastingItems adicionales no presentes en visits
    const baseRows: Unified360Row[] = visits.map((v) => {
      const sup = supabaseTastingById.get(v.id);
      const ymd = normalizeAnyDateToYmd(v.date || sup?.date);
      const prodUpper = `${v.fillProductSelection || ''} ${v.productFocus || ''} ${sup?.productName || ''}`.toUpperCase();

      const mortQty = v.mortadelaQty || (prodUpper.includes('MORTADELA') || prodUpper.includes('JAMON') || prodUpper.includes('JAMÓN') ? v.plannedUnits || 1 : 0);
      const espQty = v.espaldaQty || (prodUpper.includes('ESPALDA') ? v.plannedUnits || 1 : 0);
      const arrQty = v.arrozQty || (prodUpper.includes('VENCAMPO') || prodUpper.includes('ARROZ') ? Math.max(1, v.plannedUnits || 1) : 0);
      const azuG = v.azucarGrams || 0;
      const lecG = v.lecheGrams || 0;

      let primaryQty = v.plannedUnits || mortQty + espQty + arrQty || 1;
      let unitLabel = 'unid';

      if (metricId === 'mortadela') {
        primaryQty = mortQty;
        unitLabel = 'unid';
      } else if (metricId === 'vencampo') {
        primaryQty = v.arrozQty > 0 || prodUpper.includes('VENCAMPO') || prodUpper.includes('ARROZ') ? Math.max(1, arrQty) : 0;
        unitLabel = 'stands';
      } else if (metricId === 'azucar') {
        primaryQty = azuG;
        unitLabel = 'g';
      } else if (metricId === 'leche') {
        primaryQty = lecG;
        unitLabel = 'g';
      } else if (metricId === 'espalda') {
        primaryQty = espQty;
        unitLabel = 'unid';
      } else {
        primaryQty = v.plannedUnits || mortQty + espQty + arrQty || 1;
        unitLabel = 'filas';
      }

      return {
        id: v.id,
        ymd,
        dayLabel: v.dayLabel || ymd || 'Sin fecha',
        shift: v.shift || 'MAÑANA',
        storeName: v.storeName || 'PDV Sin Nombre',
        zone: v.zone || 'Zulia',
        productName: sup?.productName || v.productFocus || 'Portafolio Codizulca',
        promotora: (v.promotoraName || sup?.responsibleName || 'SIN ASIGNAR').trim(),
        seller: (v.sellerName || sup?.sellerApplicant || 'SIN VENDEDOR')
          .replace(/\s*\(Vendedor\s*FDV\)\s*/gi, '')
          .trim(),
        primaryQty,
        unitLabel,
        mortadelaQty: mortQty,
        espaldaQty: espQty,
        arrozQty: arrQty,
        azucarGrams: azuG,
        lecheGrams: lecG,
        samplesDelivered: sup?.currentSamples ?? 0,
        status: sup?.status || v.status || 'PROGRAMADO',
        mapsUrl: v.mapsUrl || sup?.mapsUrl,
      };
    });

    // Filtrar según la métrica seleccionada
    return baseRows.filter((row) => {
      const pUpper = row.productName
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

      switch (metricId) {
        case 'mortadela':
          return row.mortadelaQty > 0 || pUpper.includes('MORTADELA') || pUpper.includes('JAMON');
        case 'vencampo':
          return row.arrozQty > 0 || pUpper.includes('VENCAMPO') || pUpper.includes('ARROZ');
        case 'azucar':
          return row.azucarGrams > 0 || pUpper.includes('AZUCAR');
        case 'leche':
          return row.lecheGrams > 0 || pUpper.includes('LECHE');
        case 'espalda':
          return row.espaldaQty > 0 || pUpper.includes('ESPALDA');
        case 'matriz_pdv':
        case 'degustaciones_bd':
        case 'encuestas_pdv':
        case 'personal_activo':
          return true;
        default:
          return true;
      }
    });
  }, [metricId, visits, supabaseTastingById]);

  // Filas filtradas por la lente de tiempo seleccionada
  const lensFilteredRows = useMemo(
    () => allRowsForMetric.filter((r) => matchesTimeLens(r.ymd)),
    [allRowsForMetric, matchesTimeLens]
  );

  // Registros de Precios e Inventario en Supabase asociados a esta métrica y lente de tiempo
  const matchingPrices = useMemo<PriceComparisonThreeBrands[]>(() => {
    if (!metricId || !module1Bundle?.priceComparisons) return [];
    return module1Bundle.priceComparisons.filter(
      (pc) =>
        matchesProductLineForSupabase(metricId, `${pc.ownProduct} ${pc.category}`) &&
        matchesTimeLens(pc.date)
    );
  }, [metricId, module1Bundle, matchesTimeLens]);

  const matchingInventory = useMemo<InventorySamplingRecord[]>(() => {
    if (!metricId || !module1Bundle?.inventorySampling) return [];
    return module1Bundle.inventorySampling.filter(
      (inv) =>
        matchesProductLineForSupabase(metricId, inv.productName) &&
        matchesTimeLens(inv.isoDate || inv.date)
    );
  }, [metricId, module1Bundle, matchesTimeLens]);

  // Agregaciones 360° en Tiempo Real
  const analytics360 = useMemo(() => {
    const totalMatrixRows = visits.filter((v) => matchesTimeLens(v.date)).length;
    const totalPrimaryQty = lensFilteredRows.reduce((acc, r) => acc + r.primaryQty, 0);
    const totalActivations = lensFilteredRows.length;
    const matrixSharePct =
      totalMatrixRows > 0 ? Math.round((totalActivations / totalMatrixRows) * 100) : 0;

    const uniqueStores = new Set(lensFilteredRows.map((r) => r.storeName.toUpperCase().trim()));
    const uniqueZones = new Set(lensFilteredRows.map((r) => r.zone.toUpperCase().trim()));

    const morningCount = lensFilteredRows.filter((r) => r.shift === 'MAÑANA').length;
    const afternoonCount = lensFilteredRows.filter((r) => r.shift === 'TARDE').length;

    const completedCount = lensFilteredRows.filter(
      (r) => r.status === 'COMPLETADA' || r.status === 'COMPLETADO' || (r.ymd && r.ymd < liveClock.todayYmd)
    ).length;
    const pendingCount = lensFilteredRows.filter((r) => r.status === 'PENDIENTE').length;
    const completionPct =
      totalActivations > 0 ? Math.round((completedCount / totalActivations) * 100) : 0;

    const samplesFromSchedule = lensFilteredRows.reduce((acc, r) => acc + r.samplesDelivered, 0);
    const samplesFromInventory = Math.round(
      matchingInventory.reduce((acc, i) => acc + (i.portionsSampled || 0), 0)
    );
    const totalSamples = Math.max(samplesFromSchedule, samplesFromInventory);

    const shelfMovedUnits = Math.round(
      matchingInventory.reduce(
        (acc, i) =>
          acc +
          (i.salesGenerated > 0
            ? i.salesGenerated
            : Math.max(0, (i.initialStock || 0) - (i.finalStock || 0))),
        0
      )
    );

    // Precios propios vs competencia (filtrando montos > $35 que puedan estar en Bs)
    const validPrices = matchingPrices.filter(
      (p) => p.ownPriceUsd > 0 && p.ownPriceUsd <= 35 && p.averageCompetitorPriceUsd > 0 && p.averageCompetitorPriceUsd <= 35
    );
    const avgOwnPrice =
      validPrices.length > 0
        ? validPrices.reduce((s, p) => s + p.ownPriceUsd, 0) / validPrices.length
        : 0;
    const avgCompPrice =
      validPrices.length > 0
        ? validPrices.reduce((s, p) => s + p.averageCompetitorPriceUsd, 0) / validPrices.length
        : 0;
    const priceGapPct =
      avgOwnPrice > 0 && avgCompPrice > 0
        ? ((avgOwnPrice - avgCompPrice) / avgCompPrice) * 100
        : null;

    // Inversión estimada BTL
    const meta = metricId ? METRIC_META[metricId] : METRIC_META.matriz_pdv;
    const btlUnitsForCost =
      metricId === 'azucar' || metricId === 'leche'
        ? totalPrimaryQty / 1000
        : totalPrimaryQty;
    const estimatedBtlCostUsd = +(btlUnitsForCost * meta.btlUnitCostUsd).toFixed(2);

    // Top PDVs (Clientes)
    const storeMap = new Map<
      string,
      { name: string; zone: string; qty: number; count: number; mapsUrl?: string }
    >();
    lensFilteredRows.forEach((r) => {
      const key = r.storeName.toUpperCase().trim();
      const cur = storeMap.get(key) || {
        name: r.storeName,
        zone: r.zone,
        qty: 0,
        count: 0,
        mapsUrl: r.mapsUrl,
      };
      cur.qty += r.primaryQty;
      cur.count += 1;
      if (!cur.mapsUrl && r.mapsUrl) cur.mapsUrl = r.mapsUrl;
      storeMap.set(key, cur);
    });
    const topStores = Array.from(storeMap.values())
      .sort((a, b) => b.qty - a.qty || b.count - a.count)
      .slice(0, 7);

    // Top Zonas
    const zoneMap = new Map<string, { zone: string; qty: number; count: number }>();
    lensFilteredRows.forEach((r) => {
      const key = (r.zone || 'SIN ZONA').toUpperCase().trim();
      const cur = zoneMap.get(key) || { zone: r.zone || 'Sin Zona', qty: 0, count: 0 };
      cur.qty += r.primaryQty;
      cur.count += 1;
      zoneMap.set(key, cur);
    });
    const topZones = Array.from(zoneMap.values())
      .sort((a, b) => b.count - a.count || b.qty - a.qty)
      .slice(0, 6);

    // Top Promotoras
    const promMap = new Map<string, { name: string; qty: number; count: number; samples: number }>();
    lensFilteredRows.forEach((r) => {
      const clean = r.promotora.toUpperCase().trim() || 'SIN ASIGNAR';
      const cur = promMap.get(clean) || { name: clean, qty: 0, count: 0, samples: 0 };
      cur.qty += r.primaryQty;
      cur.count += 1;
      cur.samples += r.samplesDelivered;
      promMap.set(clean, cur);
    });
    const topPromotoras = Array.from(promMap.values())
      .sort((a, b) => b.count - a.count || b.qty - a.qty)
      .slice(0, 7);

    // Top Vendedores FDV
    const sellerMap = new Map<string, { name: string; qty: number; count: number }>();
    lensFilteredRows.forEach((r) => {
      const clean = r.seller.toUpperCase().trim() || 'SIN VENDEDOR';
      const cur = sellerMap.get(clean) || { name: clean, qty: 0, count: 0 };
      cur.qty += r.primaryQty;
      cur.count += 1;
      sellerMap.set(clean, cur);
    });
    const topSellers = Array.from(sellerMap.values())
      .sort((a, b) => b.count - a.count || b.qty - a.qty)
      .slice(0, 7);

    // Evolución Semanal Automática (Últimas 5 semanas móviles + Semana en Curso + Próxima Semana)
    const rollingWeeks = [-4, -3, -2, -1, 0, 1].map((offset) => {
      const win = getRollingWeekWindow(liveClock.todayYmd, offset);
      const weekRows = allRowsForMetric.filter(
        (r) => r.ymd && r.ymd >= win.mondayYmd && r.ymd <= win.sundayYmd
      );
      const qty = weekRows.reduce((s, r) => s + r.primaryQty, 0);
      const pdvs = new Set(weekRows.map((r) => r.storeName.toUpperCase().trim())).size;
      return {
        offset,
        isoWeekNumber: win.isoWeekNumber,
        shortRangeLabel: win.shortRangeLabel,
        rangeLabel: win.rangeLabel,
        isCurrentWeek: win.isCurrentWeek,
        isFutureWeek: offset > 0,
        activationsCount: weekRows.length,
        qty,
        pdvs,
      };
    });

    // Mix de portafolio cuando se selecciona Total PDVs Matriz o Degustaciones BD
    const portfolioMix = {
      mortadela: lensFilteredRows.reduce((s, r) => s + r.mortadelaQty, 0),
      vencampo: lensFilteredRows.filter((r) => r.arrozQty > 0 || r.productName.toUpperCase().includes('VENCAMPO')).length,
      espalda: lensFilteredRows.reduce((s, r) => s + r.espaldaQty, 0),
      azucarKg: +(lensFilteredRows.reduce((s, r) => s + r.azucarGrams, 0) / 1000).toFixed(2),
      lecheKg: +(lensFilteredRows.reduce((s, r) => s + r.lecheGrams, 0) / 1000).toFixed(2),
    };

    return {
      totalPrimaryQty,
      totalActivations,
      matrixSharePct,
      uniqueStoresCount: uniqueStores.size,
      uniqueZonesCount: uniqueZones.size,
      morningCount,
      afternoonCount,
      completedCount,
      pendingCount,
      completionPct,
      totalSamples,
      shelfMovedUnits,
      avgOwnPrice,
      avgCompPrice,
      priceGapPct,
      estimatedBtlCostUsd,
      topStores,
      topZones,
      topPromotoras,
      topSellers,
      rollingWeeks,
      portfolioMix,
    };
  }, [
    visits,
    lensFilteredRows,
    allRowsForMetric,
    matchingInventory,
    matchingPrices,
    matchesTimeLens,
    liveClock.todayYmd,
    metricId,
  ]);

  const searchedDrillRows = useMemo(() => {
    const q = drillSearch.trim().toLowerCase();
    if (!q) return lensFilteredRows;
    return lensFilteredRows.filter(
      (r) =>
        r.storeName.toLowerCase().includes(q) ||
        r.zone.toLowerCase().includes(q) ||
        r.promotora.toLowerCase().includes(q) ||
        r.seller.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        (r.dayLabel || '').toLowerCase().includes(q)
    );
  }, [lensFilteredRows, drillSearch]);

  if (!isOpen || !metricId) return null;

  const meta = METRIC_META[metricId];
  const currentMonthLabel = `${MONTH_NAMES_FULL_ES[liveClock.monthIndex]} ${liveClock.year}`;

  const handleExport360Csv = () => {
    const esc = (val: string | number | null | undefined) => {
      let s = String(val ?? '');
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header =
      'FECHA,DIA,JORNADA,CLIENTE_PDV,ZONA,PRODUCTO,CANTIDAD_METRICA,UNIDAD,PROMOTORA,VENDEDOR_FDV,MUESTRAS,ESTADO\r\n';
    const body = searchedDrillRows
      .map((r) =>
        [
          esc(r.ymd || r.dayLabel),
          esc(r.dayLabel),
          esc(r.shift),
          esc(r.storeName),
          esc(r.zone),
          esc(r.productName),
          r.primaryQty,
          esc(r.unitLabel),
          esc(r.promotora),
          esc(r.seller),
          r.samplesDelivered,
          esc(r.status),
        ].join(',')
      )
      .join('\r\n');

    const blob = new Blob(['\uFEFF' + header + body], {
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
    ...analytics360.rollingWeeks.map((w) =>
      metricId === 'matriz_pdv' || metricId === 'degustaciones_bd' ? w.activationsCount : w.qty
    )
  );
  const maxStoreVal = Math.max(1, ...analytics360.topStores.map((s) => Math.max(s.qty, s.count)));

  // Valores primarios mostrados para tarjetas especiales de Módulo 1 (Encuestas / Personal)
  const primaryHeroDisplay = (() => {
    if (metricId === 'encuestas_pdv') {
      return {
        value: (module1Bundle?.surveySummary.totalSurveys ?? 0).toLocaleString('es-VE'),
        unit: 'encuestas reales',
        sub: `★ ${module1Bundle?.surveySummary.avgRating ?? 0}/5 · ${module1Bundle?.surveySummary.highAcceptancePercent ?? 0}% alta acept.`,
      };
    }
    if (metricId === 'personal_activo') {
      const activeMembers = (module1Bundle?.staffMembers || []).filter((s) => s.status === 'Activo');
      const fijaCount = activeMembers.filter((s) => s.category === 'fija').length;
      const eventualCount = activeMembers.filter((s) => s.category === 'eventual').length;
      const merchCount = activeMembers.filter((s) => s.category === 'merchandising').length;
      return {
        value: String(activeMembers.length),
        unit: 'integrantes activos',
        sub: `${fijaCount} Plantilla Fija · ${eventualCount} Eventuales · ${merchCount} Merchandising`,
      };
    }
    if (metricId === 'azucar' || metricId === 'leche') {
      return {
        value: analytics360.totalPrimaryQty.toLocaleString('es-VE'),
        unit: 'gramos',
        sub: `Equivalente: ${(analytics360.totalPrimaryQty / 1000).toFixed(2)} kg en ${analytics360.totalActivations} activaciones`,
      };
    }
    if (metricId === 'matriz_pdv' || metricId === 'degustaciones_bd') {
      return {
        value: analytics360.totalActivations.toLocaleString('es-VE'),
        unit: meta.unitLabel,
        sub: `${analytics360.uniqueStoresCount} PDVs únicos en ${analytics360.uniqueZonesCount} zonas`,
      };
    }
    return {
      value: analytics360.totalPrimaryQty.toLocaleString('es-VE'),
      unit: meta.unitLabel,
      sub: `${analytics360.totalActivations} activaciones (${analytics360.matrixSharePct}% de la matriz)`,
    };
  })();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={meta.title}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-6xl bg-[#09090b] border border-white/15 rounded-3xl shadow-[0_25px_80px_rgba(0,0,0,0.95)] overflow-hidden my-auto max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Franja corporativa superior Roja / Blanca */}
        <div className="h-1 w-full bg-gradient-to-r from-red-700 via-red-500 to-zinc-700 shrink-0" />

        {/* CABECERA FIJA DEL DASHBOARD 360° */}
        <div className="p-5 sm:p-6 bg-zinc-950/95 border-b border-white/10 shrink-0 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-widest shadow-sm">
                  VISIÓN 360° CODIZULCA
                </span>
                <span className="px-2.5 py-0.5 rounded-md bg-white/[0.06] text-red-300 border border-red-500/30 text-[10px] font-mono font-bold uppercase">
                  {meta.brandBadge}
                </span>
                <span className="px-2.5 py-0.5 rounded-md bg-zinc-900 text-zinc-300 border border-white/10 text-[10px] font-mono flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Sem. {liveClock.isoWeekNumber} Auto ({liveClock.currentWeek.rangeLabel})
                </span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
                {meta.title}
              </h2>
              <p className="text-xs text-zinc-400 max-w-3xl leading-relaxed">
                {meta.subtitle}
              </p>
            </div>

            <div className="flex items-center gap-2 self-end lg:self-start shrink-0">
              <button
                type="button"
                onClick={handleExport360Csv}
                className="px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 hover:text-white text-xs font-bold border border-white/10 transition flex items-center gap-1.5 cursor-pointer"
                title="Descargar registros de esta vista 360° en formato Excel CSV"
              >
                <Download className="w-3.5 h-3.5 text-red-400" />
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
                  className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-black tracking-wide border border-red-400/50 shadow-lg shadow-red-950/60 transition flex items-center gap-1.5 cursor-pointer"
                >
                  <Filter className="w-3.5 h-3.5" />
                  <span>Enfocar en Tabla</span>
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                className="p-2 rounded-xl bg-zinc-900 hover:bg-red-600 text-zinc-400 hover:text-white border border-white/10 transition cursor-pointer"
                title="Cerrar Dashboard 360° (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Barra Superior Interactiva: Cambio Rápido entre las 6 Métricas + Filtro de Semana Automática */}
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 pt-2 border-t border-white/[0.07]">
            {/* Selector rápido entre tarjetas de métricas */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 xl:pb-0">
              {switcherItems.map((sw) => {
                const isSelected = sw.id === metricId;
                return (
                  <button
                    key={sw.id}
                    type="button"
                    onClick={() => onSelectMetric(sw.id)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap border transition-all flex items-center gap-2 cursor-pointer ${
                      isSelected
                        ? 'bg-red-600 text-white border-red-500 shadow-[0_2px_12px_rgba(220,38,38,0.45)]'
                        : 'bg-zinc-900/90 text-zinc-300 border-white/[0.08] hover:border-red-500/40 hover:text-white'
                    }`}
                  >
                    <span>{sw.label}</span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.2 rounded-md ${
                        isSelected ? 'bg-black/35 text-white font-black' : 'bg-zinc-950 text-zinc-400'
                      }`}
                    >
                      {sw.badgeValue}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Lente Temporal Conectada al Motor de Semanas Automáticas */}
            <div className="inline-flex flex-wrap items-center gap-1 bg-zinc-900/90 p-1 rounded-xl border border-white/[0.08]">
              {[
                { id: 'GLOBAL' as const, label: 'Consolidado Total' },
                {
                  id: 'SEMANA_ACTUAL' as const,
                  label: `Semana Actual (${liveClock.currentWeek.shortRangeLabel})`,
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
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
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
        <div className="p-5 sm:p-6 overflow-y-auto space-y-6 flex-1">
          {/* 1. FRANJA DE 5 KPIs EJECUTIVOS 360° */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
            {/* KPI 1: Volumen / Total Métrica */}
            <div className="p-4 rounded-2xl bg-gradient-to-b from-red-950/35 via-zinc-900/95 to-zinc-950 border border-red-500/35">
              <div className="flex items-center justify-between text-[11px] font-bold text-red-300">
                <span>Volumen Seleccionado</span>
                <Box className="w-4 h-4 text-red-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-white font-mono">
                  {primaryHeroDisplay.value}
                </span>
                <span className="text-[11px] text-zinc-400">{primaryHeroDisplay.unit}</span>
              </div>
              <div className="mt-2 text-[10px] text-zinc-300 font-medium">
                {primaryHeroDisplay.sub}
              </div>
            </div>

            {/* KPI 2: Cobertura de Clientes PDV & Zonas */}
            <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10">
              <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400">
                <span>Cobertura Geográfica</span>
                <StoreIcon className="w-4 h-4 text-red-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-white font-mono">
                  {analytics360.uniqueStoresCount}
                </span>
                <span className="text-[11px] text-zinc-400">clientes PDV</span>
              </div>
              <div className="mt-2 text-[10px] text-zinc-400 flex items-center justify-between">
                <span>Zonas cubiertas:</span>
                <span className="font-mono font-bold text-white">
                  {analytics360.uniqueZonesCount} sectores
                </span>
              </div>
            </div>

            {/* KPI 3: Ejecución y Balance de Jornada */}
            <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10">
              <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400">
                <span>Jornadas & Avance</span>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-black text-white font-mono">
                  {analytics360.completionPct}%
                </span>
                <span className="text-[11px] text-zinc-400">
                  ({analytics360.completedCount}/{analytics360.totalActivations})
                </span>
              </div>
              <div className="mt-2 text-[10px] text-zinc-400 flex items-center justify-between font-mono">
                <span className="inline-flex items-center gap-1 text-zinc-200">
                  <Sun className="w-3 h-3 text-amber-400" /> {analytics360.morningCount} Mañ.
                </span>
                <span className="inline-flex items-center gap-1 text-red-300">
                  <Moon className="w-3 h-3 text-red-400" /> {analytics360.afternoonCount} Tar.
                </span>
              </div>
            </div>

            {/* KPI 4: Impacto en Góndola y Muestras (Supabase) */}
            <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10">
              <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400">
                <span>Muestras & Rotación</span>
                <ShoppingBag className="w-4 h-4 text-red-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-white font-mono">
                  {analytics360.totalSamples.toLocaleString('es-VE')}
                </span>
                <span className="text-[11px] text-zinc-400">muestras</span>
              </div>
              <div className="mt-2 text-[10px] text-zinc-400 flex items-center justify-between">
                <span>Desplazamiento anaquel:</span>
                <span className="font-mono font-bold text-emerald-400">
                  {analytics360.shelfMovedUnits.toLocaleString('es-VE')} un
                </span>
              </div>
            </div>

            {/* KPI 5: Competitividad de Precio e Inversión BTL */}
            <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10">
              <div className="flex items-center justify-between text-[11px] font-bold text-zinc-400">
                <span>Precio Anaquel & BTL</span>
                <DollarSign className="w-4 h-4 text-red-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-2xl font-black text-white font-mono">
                  {analytics360.avgOwnPrice > 0
                    ? `$${analytics360.avgOwnPrice.toFixed(2)}`
                    : `$${analytics360.estimatedBtlCostUsd.toFixed(0)}`}
                </span>
                <span className="text-[11px] text-zinc-400">
                  {analytics360.avgOwnPrice > 0 ? 'prom. PDV' : 'costo BTL'}
                </span>
              </div>
              <div className="mt-2 text-[10px] text-zinc-400 flex items-center justify-between">
                {analytics360.priceGapPct !== null ? (
                  <>
                    <span>Vs. Comp (${analytics360.avgCompPrice.toFixed(2)}):</span>
                    <span
                      className={`font-mono font-bold ${
                        analytics360.priceGapPct <= 0 ? 'text-emerald-400' : 'text-amber-300'
                      }`}
                    >
                      {analytics360.priceGapPct > 0 ? '+' : ''}
                      {analytics360.priceGapPct.toFixed(1)}%
                    </span>
                  </>
                ) : (
                  <>
                    <span>Auditorías precio:</span>
                    <span className="font-mono text-zinc-300">{matchingPrices.length} reg.</span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Conmutador interno: Vista Gráfica 360° vs Tabla de Registros Detallados */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div className="inline-flex items-center bg-zinc-950 p-1 rounded-xl border border-white/10 gap-1">
              <button
                type="button"
                onClick={() => setActiveSection('resumen')}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition cursor-pointer ${
                  activeSection === 'resumen'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" />
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
                <Layers className="w-3.5 h-3.5" />
                <span>Trazabilidad Fila por Fila ({lensFilteredRows.length})</span>
              </button>
            </div>

            <span className="text-[11px] font-mono text-zinc-400">
              Fecha operativa activa: <strong className="text-white">{liveClock.todayLongLabel}</strong>
            </span>
          </div>

          {activeSection === 'resumen' ? (
            <div className="space-y-5">
              {/* Mix de portafolio cuando es Matriz General o Degustaciones BD */}
              {(metricId === 'matriz_pdv' || metricId === 'degustaciones_bd') && (
                <div className="p-4 rounded-2xl bg-zinc-950 border border-white/10">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                      <Layers className="w-4 h-4 text-red-500" />
                      Composición del Portafolio en el Período Seleccionado
                    </span>
                    <span className="text-[11px] text-zinc-400 font-mono">
                      Clic en cualquier rubro para abrir su vista 360° individual
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                    {[
                      { id: 'mortadela' as Metric360Id, label: 'Mortadela Asturias', val: `${analytics360.portfolioMix.mortadela} un` },
                      { id: 'vencampo' as Metric360Id, label: 'Stands Vencampo', val: `${analytics360.portfolioMix.vencampo} stands` },
                      { id: 'espalda' as Metric360Id, label: 'Espalda Ahumada', val: `${analytics360.portfolioMix.espalda} un` },
                      { id: 'azucar' as Metric360Id, label: 'Azúcar Insumo', val: `${analytics360.portfolioMix.azucarKg} kg` },
                      { id: 'leche' as Metric360Id, label: 'Leche en Polvo', val: `${analytics360.portfolioMix.lecheKg} kg` },
                    ].map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onSelectMetric(p.id)}
                        className="p-3 rounded-xl bg-zinc-900/80 hover:bg-red-950/30 border border-white/[0.07] hover:border-red-500/40 text-left transition cursor-pointer"
                      >
                        <div className="text-[10px] text-zinc-400 font-semibold truncate">{p.label}</div>
                        <div className="text-base font-black text-white font-mono mt-1">{p.val}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* FILA 1 DE PANELES 360°: EVOLUCIÓN SEMANAL AUTOMÁTICA + RANKING TOP PDVs */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Panel A: Evolución Semanal Automática */}
                <div className="lg:col-span-6 p-5 rounded-2xl bg-zinc-950 border border-white/10 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <h3 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-red-500" />
                        Evolución Semanal Automática (Lunes – Domingo)
                      </h3>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-600/20 text-red-300 border border-red-500/30">
                        Auto-Rollover Activo
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mb-4">
                      Ventana móvil que avanza automáticamente con cada nueva semana calendario.
                    </p>

                    <div className="space-y-2.5">
                      {analytics360.rollingWeeks.map((wk) => {
                        const metricVal =
                          metricId === 'matriz_pdv' || metricId === 'degustaciones_bd'
                            ? wk.activationsCount
                            : wk.qty;
                        const barPct =
                          metricVal === 0 ? 0 : Math.max(5, Math.round((metricVal / maxWeekVal) * 100));

                        return (
                          <div
                            key={`${wk.isoWeekNumber}-${wk.offset}`}
                            className={`p-2.5 rounded-xl border transition ${
                              wk.isCurrentWeek
                                ? 'bg-red-950/25 border-red-500/50'
                                : 'bg-zinc-900/50 border-white/[0.06]'
                            }`}
                          >
                            <div className="flex items-center justify-between text-xs mb-1.5">
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-bold text-white">
                                  Sem {wk.isoWeekNumber}
                                </span>
                                <span className="text-[11px] text-zinc-400 font-mono">
                                  ({wk.rangeLabel})
                                </span>
                                {wk.isCurrentWeek && (
                                  <span className="text-[9px] font-black px-1.5 py-0.2 rounded bg-red-600 text-white uppercase">
                                    Semana Actual
                                  </span>
                                )}
                                {wk.isFutureWeek && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300 uppercase">
                                    Próxima
                                  </span>
                                )}
                              </div>
                              <div className="text-right font-mono">
                                <span className="font-black text-white">{metricVal}</span>{' '}
                                <span className="text-[10px] text-zinc-400">
                                  {meta.unitLabel} · {wk.pdvs} PDVs
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
                <div className="lg:col-span-6 p-5 rounded-2xl bg-zinc-950 border border-white/10 space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2">
                        <StoreIcon className="w-4 h-4 text-red-500" />
                        Top Clientes / Puntos de Venta Impactados
                      </h3>
                      <span className="text-[11px] font-mono text-zinc-400">
                        {analytics360.uniqueStoresCount} tiendas únicas
                      </span>
                    </div>

                    {analytics360.topStores.length === 0 ? (
                      <div className="p-6 rounded-xl bg-zinc-900/40 border border-white/[0.05] text-center text-xs text-zinc-400">
                        Sin activaciones registradas en este período para esta métrica.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {analytics360.topStores.map((st, idx) => {
                          const val = Math.max(st.qty, st.count);
                          const pct = Math.max(6, Math.round((val / maxStoreVal) * 100));
                          return (
                            <div
                              key={st.name}
                              className="p-2.5 rounded-xl bg-zinc-900/60 border border-white/[0.06]"
                            >
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="w-5 h-5 rounded-md bg-red-600/20 text-red-400 font-mono font-black text-[10px] flex items-center justify-center shrink-0">
                                    {idx + 1}
                                  </span>
                                  <span className="font-bold text-white truncate">{st.name}</span>
                                  {st.mapsUrl && (
                                    <a
                                      href={st.mapsUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-red-400 hover:text-red-300 shrink-0"
                                      title="Ver ubicación en Google Maps"
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  )}
                                </div>
                                <span className="font-mono font-bold text-white shrink-0">
                                  {st.qty > 0 ? `${st.qty} ${meta.unitLabel}` : `${st.count} act.`}
                                </span>
                              </div>
                              <div className="mt-1.5 flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-black rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-red-600 rounded-full"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <span className="text-[10px] text-zinc-400 font-mono truncate max-w-[140px]">
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
                  {analytics360.topZones.length > 0 && (
                    <div className="pt-3 border-t border-white/10">
                      <span className="text-[10px] font-black text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                        <MapPin className="w-3.5 h-3.5 text-red-400" />
                        Concentración por Zona / Municipio
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {analytics360.topZones.map((z) => (
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

              {/* FILA 2 DE PANELES 360°: FUERZA DE CAMPO (PROMOTORAS & FDV) + INTELIGENCIA DE GÓNDOLA SUPABASE */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Panel C: Fuerza Operativa (Promotoras y Vendedores FDV) */}
                <div className="lg:col-span-6 p-5 rounded-2xl bg-zinc-950 border border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Top Promotoras */}
                  <div>
                    <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5 mb-3">
                      <Users className="w-3.5 h-3.5 text-red-500" />
                      Promotoras Ejecutoras
                    </h4>
                    {analytics360.topPromotoras.length === 0 ? (
                      <p className="text-xs text-zinc-500">Sin promotoras en este filtro.</p>
                    ) : (
                      <div className="space-y-2">
                        {analytics360.topPromotoras.map((p) => (
                          <div
                            key={p.name}
                            className="p-2 rounded-xl bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="font-semibold text-zinc-200 truncate">{p.name}</span>
                            <span className="font-mono text-[11px] text-red-300 font-bold shrink-0">
                              {p.count} act · {p.qty}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Top Vendedores FDV */}
                  <div>
                    <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5 mb-3">
                      <TrendingUp className="w-3.5 h-3.5 text-red-500" />
                      Vendedores Solicitantes (FDV)
                    </h4>
                    {analytics360.topSellers.length === 0 ? (
                      <p className="text-xs text-zinc-500">Sin solicitudes FDV en este filtro.</p>
                    ) : (
                      <div className="space-y-2">
                        {analytics360.topSellers.map((s) => (
                          <div
                            key={s.name}
                            className="p-2 rounded-xl bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="font-semibold text-zinc-200 truncate">{s.name}</span>
                            <span className="font-mono text-[11px] text-white font-bold shrink-0">
                              {s.count} sol · {s.qty}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Panel D: Inteligencia de Góndola en Supabase (Precios, Inventario o Personal/Encuestas) */}
                <div className="lg:col-span-6 p-5 rounded-2xl bg-zinc-950 border border-white/10 space-y-4">
                  {metricId === 'personal_activo' ? (
                    <>
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                          <ClipboardCheck className="w-4 h-4 text-red-500" />
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
                              className="p-2.5 rounded-xl bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between text-xs"
                            >
                              <div>
                                <span className="font-bold text-white block">{st.name}</span>
                                <span className="text-[10px] text-zinc-400 font-mono">
                                  {st.category === 'merchandising'
                                    ? 'MERCHANDISING'
                                    : st.category === 'eventual'
                                      ? 'PLANTILLA EVENTUAL'
                                      : 'PLANTILLA FIJA'}{' '}
                                  · {st.assignedStore}
                                </span>
                              </div>
                              <div className="text-right font-mono">
                                <span className="text-red-400 font-bold block">
                                  {st.activationsCount} registros BD
                                </span>
                                <span className="text-[10px] text-emerald-400">
                                  {st.status}
                                </span>
                              </div>
                            </div>
                          ))}
                      </div>
                    </>
                  ) : metricId === 'encuestas_pdv' ? (
                    <>
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                          <ClipboardCheck className="w-4 h-4 text-red-500" />
                          Desglose de Encuestas de Consumidor en PDV
                        </h4>
                        <span className="text-[11px] font-mono text-red-400 font-bold">
                          ★ {module1Bundle?.surveySummary.avgRating ?? 0} / 5.0
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="p-3 rounded-xl bg-zinc-900 border border-white/10">
                          <span className="text-[10px] text-zinc-400 block">Encuestas Breves</span>
                          <span className="text-xl font-black text-white font-mono">
                            {module1Bundle?.surveySummary.breveCount ?? 0}
                          </span>
                        </div>
                        <div className="p-3 rounded-xl bg-zinc-900 border border-white/10">
                          <span className="text-[10px] text-zinc-400 block">Encuestas Profundas</span>
                          <span className="text-xl font-black text-white font-mono">
                            {module1Bundle?.surveySummary.profundaCount ?? 0}
                          </span>
                        </div>
                        <div className="p-3 rounded-xl bg-zinc-900 border border-white/10">
                          <span className="text-[10px] text-zinc-400 block">Alta Aceptación</span>
                          <span className="text-xl font-black text-emerald-400 font-mono">
                            {module1Bundle?.surveySummary.highAcceptancePercent ?? 0}%
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                          <Scale className="w-4 h-4 text-red-500" />
                          Cruce en Góndola: Precios vs. Competencia e Inventario
                        </h4>
                        <span className="text-[11px] font-mono text-zinc-400">
                          {matchingPrices.length} precios · {matchingInventory.length} inv.
                        </span>
                      </div>

                      {matchingPrices.length === 0 && matchingInventory.length === 0 ? (
                        <div className="p-5 rounded-xl bg-zinc-900/40 border border-white/[0.05] text-xs text-zinc-400 text-center">
                          No hay tomas de precio o auditorías de inventario adicionales para este filtro temporal.
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                          {matchingInventory.slice(0, 4).map((inv) => (
                            <div
                              key={inv.id}
                              className="p-2.5 rounded-xl bg-zinc-900/70 border border-white/[0.06] flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <span className="font-bold text-white block truncate">
                                  📦 {inv.storeName}
                                </span>
                                <span className="text-[10px] text-zinc-400 font-mono">
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

                          {matchingPrices
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
                                  <span className="text-[10px] text-zinc-400 font-mono">
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
                  Mostrando <strong className="text-white">{searchedDrillRows.length}</strong> registros reales
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
                      <th className="p-3">Promotora</th>
                      <th className="p-3">Vendedor FDV</th>
                      <th className="p-3 text-center">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-zinc-200">
                    {searchedDrillRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="p-8 text-center text-zinc-500">
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
                          <td className="p-3 text-right font-mono font-black text-white">
                            {row.primaryQty} {row.unitLabel}
                          </td>
                          <td className="p-3 text-zinc-200">{row.promotora}</td>
                          <td className="p-3 font-mono text-zinc-300">{row.seller}</td>
                          <td className="p-3 text-center">
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
};
