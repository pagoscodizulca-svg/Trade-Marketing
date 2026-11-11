import React, { useMemo, useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import {
  TrendingUp,
  TrendingDown,
  ShoppingBag,
  CheckCircle2,
  DollarSign,
  Clock,
  Target,
  BarChart3,
  Layers,
  Award,
  Users,
  Calendar,
  Plus,
  Search,
  FileSpreadsheet,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  X,
  Building2,
  Package,
  Filter,
  Scale,
} from 'lucide-react';
import { ExportPdfButton } from '../common/ExportPdfButton';
import {
  exportExecutiveKpisPdf,
  ExecutiveProductMoMPdfRow,
  ExecutiveWeeklyCostPdfRow,
  ExecutiveFeasibilityPdfRow,
} from '../../utils/pdfExport';
import { PrintSupportHeader, PrintSignatureBlock } from '../common/PrintSupportHeader';
import { getWeekNumberInMonth } from '../../utils/monthlyTastingReportPdf';
import {
  useLiveVenezuelaClock,
  getMonthCalendarWeeks,
} from '../../utils/weekCalendar';
import {
  evaluateTastingFeasibility,
  FeasibilityReturnBasis,
} from '../../utils/tastingFeasibility';
import { RequisitionStatus } from '../../types';

// ============================================================================
// CONSTANTES Y UTILIDADES DE NORMALIZACIÓN COMERCIAL CODIZULCA
// ============================================================================

const MONTH_NAMES_ES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

const MONTH_SHORT_ES = [
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
];

interface ParsedSimpleDate {
  year: number;
  monthIndex: number; // 0-11
  day: number;
  yearMonth: string; // YYYY-MM
  ymd: string; // YYYY-MM-DD
  weekNumber: number; // 1..5
}

function parseAnyRecordDate(raw?: string | null): ParsedSimpleDate | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // YYYY-MM-DD...
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (year > 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return {
        year,
        monthIndex: month - 1,
        day,
        yearMonth: `${year}-${mm}`,
        ymd: `${year}-${mm}-${dd}`,
        weekNumber: getWeekNumberInMonth(day, year, month - 1),
      };
    }
  }

  // DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (year > 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return {
        year,
        monthIndex: month - 1,
        day,
        yearMonth: `${year}-${mm}`,
        ymd: `${year}-${mm}-${dd}`,
        weekNumber: getWeekNumberInMonth(day, year, month - 1),
      };
    }
  }

  return null;
}

function formatYearMonthEs(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  return `${MONTH_NAMES_ES[monthIdx] || ym} ${year}`;
}

function formatYearMonthShortEs(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  return `${MONTH_SHORT_ES[monthIdx] || ym} ${year}`;
}

function computeNiceChartCeiling(rawMax: number): number {
  if (rawMax <= 10) return 10;
  const padded = rawMax * 1.08;
  const magnitude = Math.pow(10, Math.floor(Math.log10(padded)));
  const residual = padded / magnitude;
  let niceResidual = 10;
  if (residual <= 1.2) niceResidual = 1.2;
  else if (residual <= 1.5) niceResidual = 1.5;
  else if (residual <= 2) niceResidual = 2;
  else if (residual <= 2.5) niceResidual = 2.5;
  else if (residual <= 3) niceResidual = 3;
  else if (residual <= 4) niceResidual = 4;
  else if (residual <= 5) niceResidual = 5;
  else if (residual <= 6) niceResidual = 6;
  else if (residual <= 8) niceResidual = 8;
  return Math.ceil(niceResidual * magnitude);
}

function formatAxisTickUnits(val: number): string {
  if (val <= 0) return '0';
  if (val >= 10000) {
    const k = val / 1000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1).replace('.', ',')}k`;
  }
  if (val >= 1000) {
    return val.toLocaleString('es-VE');
  }
  return String(Math.round(val));
}

function formatCompactBarValue(val: number, compactForMultiMonth: boolean): string {
  if (val <= 0) return '0';
  if (compactForMultiMonth && val >= 10000) {
    return `${(val / 1000).toFixed(1).replace('.', ',')}k`;
  }
  return val.toLocaleString('es-VE');
}

function shortProductAxisLabel(fullLabel: string): string {
  return fullLabel
    .replace(/\s+Vencampo/gi, '')
    .replace(/\s+Asturias/gi, '')
    .trim();
}

interface CodizulcaProductLineMeta {
  id: string;
  label: string;
  brand: 'ASTURIAS' | 'VENCAMPO';
  btlActivationUnitCostUsd: number;
  unitLabel: string;
}

function classifyCodizulcaProductLine(rawProduct?: string | null): CodizulcaProductLineMeta {
  const norm = String(rawProduct || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (norm.includes('PECHUGA') && norm.includes('PAVO')) {
    return {
      id: 'pechuga_pavo_asturias',
      label: 'Pechuga de Pavo Asturias',
      brand: 'ASTURIAS',
      btlActivationUnitCostUsd: 13.5,
      unitLabel: 'Unid/Piezas',
    };
  }
  if (norm.includes('PECHUGA')) {
    return {
      id: 'pechuga_pollo_asturias',
      label: 'Pechuga de Pollo Asturias',
      brand: 'ASTURIAS',
      btlActivationUnitCostUsd: 13.0,
      unitLabel: 'Unid/Piezas',
    };
  }
  if (norm.includes('ESPALDA')) {
    return {
      id: 'espalda_asturias',
      label: 'Espalda Cocida / Ahumada Asturias',
      brand: 'ASTURIAS',
      btlActivationUnitCostUsd: 12.5,
      unitLabel: 'Piezas BTL',
    };
  }
  if (norm.includes('JAMON') || norm.includes('CHULETA') || norm.includes('TOCINETA')) {
    return {
      id: 'jamon_asturias',
      label: 'Jamón Cocido y Ahumado Asturias',
      brand: 'ASTURIAS',
      btlActivationUnitCostUsd: 13.5,
      unitLabel: 'Unid/Piezas',
    };
  }
  if (
    norm.includes('MORTADELA') ||
    norm.includes('EMBUTIDO') ||
    norm.includes('SALCHICHA') ||
    norm.includes('BOLOGNA') ||
    norm.includes('CHORIZO') ||
    norm.includes('ASTURIAS')
  ) {
    return {
      id: 'mortadela_asturias',
      label: 'Mortadela y Embutidos Asturias',
      brand: 'ASTURIAS',
      btlActivationUnitCostUsd: 12.0, // Coincide con MP-07-0067 ($12.00 / pieza 1kg)
      unitLabel: 'Piezas (1kg)',
    };
  }
  if (norm.includes('AZUCAR')) {
    return {
      id: 'azucar_vencampo',
      label: 'Azúcar Refinada Vencampo (1kg)',
      brand: 'VENCAMPO',
      btlActivationUnitCostUsd: 9.5,
      unitLabel: 'Unid (1kg)',
    };
  }
  if (norm.includes('ACEITE')) {
    return {
      id: 'aceite_vencampo',
      label: 'Aceite Comestible Vencampo (900ml)',
      brand: 'VENCAMPO',
      btlActivationUnitCostUsd: 11.4,
      unitLabel: 'Unid (900ml)',
    };
  }
  if (norm.includes('LECHE')) {
    return {
      id: 'leche_vencampo',
      label: 'Leche en Polvo Vencampo',
      brand: 'VENCAMPO',
      btlActivationUnitCostUsd: 14.5,
      unitLabel: 'Unid/Emp',
    };
  }
  if (
    norm.includes('CARAOTA') ||
    norm.includes('ARVEJA') ||
    norm.includes('LENTEJA') ||
    norm.includes('FRIJOL') ||
    norm.includes('GRANO')
  ) {
    return {
      id: 'granos_vencampo',
      label: 'Granos Seleccionados Vencampo',
      brand: 'VENCAMPO',
      btlActivationUnitCostUsd: 10.5,
      unitLabel: 'Unid/Emp',
    };
  }
  // Default / Arroz / Kit Vencampo
  return {
    id: 'arroz_vencampo',
    label: 'Arroz Blanco e Insumos Vencampo',
    brand: 'VENCAMPO',
    btlActivationUnitCostUsd: 12.5,
    unitLabel: 'Unid/Kits',
  };
}

interface MonthLineAccumulator {
  shelfDisplacedUnits: number;
  initialStockUnits: number;
  inventoryAudits: number;
  tastingActivations: number;
  tastingSamples: number;
  requestedBtlUnits: number;
  pdvSet: Set<string>;
  ownPriceSum: number;
  ownPriceCount: number;
  compPriceSum: number;
  compPriceCount: number;
}

function createEmptyAccumulator(): MonthLineAccumulator {
  return {
    shelfDisplacedUnits: 0,
    initialStockUnits: 0,
    inventoryAudits: 0,
    tastingActivations: 0,
    tastingSamples: 0,
    requestedBtlUnits: 0,
    pdvSet: new Set<string>(),
    ownPriceSum: 0,
    ownPriceCount: 0,
    compPriceSum: 0,
    compPriceCount: 0,
  };
}

export interface ProductMoMComparisonRow {
  lineId: string;
  productLine: string;
  brand: 'ASTURIAS' | 'VENCAMPO';
  unitLabel: string;
  prevVol: number;
  currVol: number;
  deltaUnits: number;
  deltaPct: number | null;
  trend: 'UP' | 'DOWN' | 'NEW' | 'FLAT';
  statusLabel: string;
  prevPdvCount: number;
  currPdvCount: number;
  prevSamples: number;
  currSamples: number;
  currActivations: number;
  avgOwnPriceUsd: number;
  avgCompPriceUsd: number;
  priceGapPct: number | null;
  diagnosis: string;
}

export interface WeeklyTradeCostRow {
  weekNumber: number;
  weekLabel: string;
  rangeLabel: string;
  defaultDateYmd: string;
  formalRequisitionsCount: number;
  formalCodes: string[];
  formalCampaigns: string[];
  formalUnits: number;
  formalCostUsd: number;
  formalApprovedCapUsd: number;
  fieldRequestsCount: number;
  fieldUnits: number;
  fieldCostUsd: number;
  topFieldProducts: string[];
  consolidatedCostUsd: number;
  totalUnitsConsolidated: number;
  shareOfMonthPct: number;
  wowDeltaPct: number | null;
  governanceStatus: 'APROBADO_CONTRALORIA' | 'EN_VALIDACION' | 'POR_FORMALIZAR_ACTA' | 'SIN_SOLICITUDES';
  governanceLabel: string;
}

// ============================================================================
// COMPONENTE PRINCIPAL: MÓDULO 4 - KPIs, COMPARATIVA MENSUAL Y COSTOS SEMANALES
// ============================================================================

export const ExecutiveDashboard: React.FC = () => {
  const {
    visits,
    tastingReports,
    requests,
    reconciliation,
    module1Bundle,
    isLoadingSupabase,
    createRequisition,
  } = useApp();

  const liveClock = useLiveVenezuelaClock();

  // Estados de filtros comparativos y modales sincronizados automáticamente con el calendario activo
  const [selectedEvalMonth, setSelectedEvalMonth] = useState<string>(() => liveClock.yearMonth);
  const [selectedBaseMonth, setSelectedBaseMonth] = useState<string>(() => liveClock.prevYearMonth);
  const [isMonthManuallyPinned, setIsMonthManuallyPinned] = useState<boolean>(false);
  const [brandFilter, setBrandFilter] = useState<'TODAS' | 'ASTURIAS' | 'VENCAMPO'>('TODAS');
  const [trendFilter, setTrendFilter] = useState<'TODOS' | 'CRECIMIENTO' | 'BAJADA'>('TODOS');
  const [productSearch, setProductSearch] = useState<string>('');
  const [costViewMode, setCostViewMode] = useState<'CONSOLIDADO' | 'SOLO_ACTAS_MP'>('CONSOLIDADO');

  // Estados interactivos de la Gráfica de Barras según los Meses Seleccionados
  const [selectedChartMonths, setSelectedChartMonths] = useState<string[]>(() =>
    Array.from(new Set([liveClock.prevYearMonth, liveClock.yearMonth])).sort()
  );
  const [chartGroupingMode, setChartGroupingMode] = useState<'POR_PRODUCTO' | 'POR_MES'>('POR_PRODUCTO');
  const [chartScaleMode, setChartScaleMode] = useState<'ADAPTATIVA' | 'LINEAL'>('ADAPTATIVA');
  const [hoveredChartItemId, setHoveredChartItemId] = useState<string | null>(null);

  // Estados para Métrica de Factibilidad de Degustación (Semana o Temporada vs Costo Productos Degustados)
  const [feasibilityScope, setFeasibilityScope] = useState<
    | 'MES_COMPLETO'
    | 'SEMANA_ACTUAL_AUTO'
    | 'W1'
    | 'W2'
    | 'W3'
    | 'W4'
    | 'W5'
    | 'W6'
    | 'TEMPORADA_ACUMULADA'
    | 'RANGO_TEMPORADA'
  >('MES_COMPLETO');
  const [feasibilityDateFrom, setFeasibilityDateFrom] = useState<string>(
    () => liveClock.currentWeek.mondayYmd
  );
  const [feasibilityDateTo, setFeasibilityDateTo] = useState<string>(
    () => liveClock.currentWeek.sundayYmd
  );
  const [isFeasibilityRangeManual, setIsFeasibilityRangeManual] = useState<boolean>(false);
  const [feasibilityReturnBasis, setFeasibilityReturnBasis] =
    useState<FeasibilityReturnBasis>('VENTAS_DIRECTAS_BTL');

  // Avance automático cuando transcurren las semanas o inicia un nuevo mes
  useEffect(() => {
    if (!isMonthManuallyPinned && selectedEvalMonth !== liveClock.yearMonth) {
      setSelectedEvalMonth(liveClock.yearMonth);
      setSelectedBaseMonth(liveClock.prevYearMonth);
      setSelectedChartMonths(
        Array.from(new Set([liveClock.prevYearMonth, liveClock.yearMonth])).sort()
      );
    }
  }, [liveClock.yearMonth, liveClock.prevYearMonth, isMonthManuallyPinned, selectedEvalMonth]);

  useEffect(() => {
    if (!isFeasibilityRangeManual) {
      setFeasibilityDateFrom(liveClock.currentWeek.mondayYmd);
      setFeasibilityDateTo(liveClock.currentWeek.sundayYmd);
    }
  }, [
    liveClock.currentWeek.mondayYmd,
    liveClock.currentWeek.sundayYmd,
    isFeasibilityRangeManual,
  ]);

  // Modal para radicar nueva solicitud semanal de Trade Marketing a Contraloría
  const [isReqModalOpen, setIsReqModalOpen] = useState<boolean>(false);
  const [reqFormCode, setReqFormCode] = useState<string>('');
  const [reqFormDate, setReqFormDate] = useState<string>(() => liveClock.todayYmd);
  const [reqFormPurpose, setReqFormPurpose] = useState<string>('');
  const [reqFormProduct, setReqFormProduct] = useState<string>('');
  const [reqFormQty, setReqFormQty] = useState<number>(1);
  const [reqFormUnit, setReqFormUnit] = useState<string>('Pieza (1kg)');
  const [reqFormUnitCost, setReqFormUnitCost] = useState<number>(0);
  const [reqFormBudgetCap, setReqFormBudgetCap] = useState<number>(0);
  const [reqFormStatus, setReqFormStatus] = useState<RequisitionStatus>('APROBADO_CONTRALORIA');

  // 1. Detectar todos los meses reales disponibles en Supabase, Contraloría y el reloj activo
  const availableMonths = useMemo<string[]>(() => {
    const monthSet = new Set<string>([liveClock.yearMonth, liveClock.prevYearMonth]);

    module1Bundle?.inventorySampling?.forEach((rec) => {
      const p = parseAnyRecordDate(rec.isoDate || rec.date);
      if (p) monthSet.add(p.yearMonth);
    });
    module1Bundle?.tastingItems?.forEach((item) => {
      const p = parseAnyRecordDate(item.date);
      if (p) monthSet.add(p.yearMonth);
    });
    module1Bundle?.priceComparisons?.forEach((pc) => {
      const p = parseAnyRecordDate(pc.date);
      if (p) monthSet.add(p.yearMonth);
    });
    requests.forEach((req) => {
      const p = parseAnyRecordDate(req.requestDate);
      if (p) monthSet.add(p.yearMonth);
    });

    return Array.from(monthSet).sort((a, b) => b.localeCompare(a)); // Descendente: más reciente primero
  }, [module1Bundle, requests, liveClock.yearMonth, liveClock.prevYearMonth]);

  // Ajustar mes base automáticamente cuando cambia el mes evaluado si quedan iguales
  useEffect(() => {
    if (selectedBaseMonth === selectedEvalMonth) {
      const idx = availableMonths.indexOf(selectedEvalMonth);
      let nextBase = selectedBaseMonth;
      if (idx >= 0 && idx + 1 < availableMonths.length) {
        nextBase = availableMonths[idx + 1];
      } else if (availableMonths.length > 1) {
        const alt = availableMonths.find((m) => m !== selectedEvalMonth);
        if (alt) nextBase = alt;
      }
      if (nextBase !== selectedBaseMonth) {
        setSelectedBaseMonth(nextBase);
        setSelectedChartMonths(Array.from(new Set([nextBase, selectedEvalMonth])).sort());
      }
    }
  }, [selectedEvalMonth, selectedBaseMonth, availableMonths]);

  // 2. Motor de Agregación Mensual por Línea de Producto (Inventario + Degustaciones + Precios)
  const monthlyProductMatrix = useMemo(() => {
    const byMonthAndLine = new Map<string, Map<string, { meta: CodizulcaProductLineMeta; acc: MonthLineAccumulator }>>();

    const getEntry = (ym: string, rawProduct: string) => {
      const meta = classifyCodizulcaProductLine(rawProduct);
      let monthMap = byMonthAndLine.get(ym);
      if (!monthMap) {
        monthMap = new Map();
        byMonthAndLine.set(ym, monthMap);
      }
      let lineEntry = monthMap.get(meta.id);
      if (!lineEntry) {
        lineEntry = { meta, acc: createEmptyAccumulator() };
        monthMap.set(meta.id, lineEntry);
      }
      return lineEntry;
    };

    // A. Rotación y desplazamiento real en anaquel (Supabase inventory)
    if (module1Bundle?.inventorySampling && module1Bundle.inventorySampling.length > 0) {
      module1Bundle.inventorySampling.forEach((rec) => {
        const p = parseAnyRecordDate(rec.isoDate || rec.date);
        if (!p) return;
        const entry = getEntry(p.yearMonth, rec.productName);
        const netMoved =
          rec.salesGenerated > 0
            ? rec.salesGenerated
            : Math.max(0, (Number(rec.initialStock) || 0) - (Number(rec.finalStock) || 0));

        entry.acc.shelfDisplacedUnits += netMoved;
        entry.acc.initialStockUnits += Math.max(0, Number(rec.initialStock) || 0);
        entry.acc.inventoryAudits += 1;
        entry.acc.tastingSamples += Math.max(0, Number(rec.portionsSampled) || 0);
        if (rec.storeName) entry.acc.pdvSet.add(rec.storeName.trim().toUpperCase());
      });
    }

    // B. Activaciones e impulso de degustaciones (Supabase surveys Degustacion o fallback local)
    const tastingSource =
      module1Bundle?.tastingItems && module1Bundle.tastingItems.length > 0
        ? module1Bundle.tastingItems
        : null;

    if (tastingSource) {
      tastingSource.forEach((t) => {
        const p = parseAnyRecordDate(t.date);
        if (!p) return;
        const entry = getEntry(p.yearMonth, t.productName);
        const rawQty = Number(t.requestedQty) || 1;
        const normQty = rawQty > 30 ? Math.max(0.5, Number((rawQty / 1000).toFixed(1))) : Math.max(1, rawQty);

        entry.acc.tastingActivations += 1;
        entry.acc.tastingSamples += Math.max(0, Number(t.currentSamples) || 0);
        entry.acc.requestedBtlUnits += normQty;
        if (t.storeName) entry.acc.pdvSet.add(t.storeName.trim().toUpperCase());
      });
    } else {
      visits.forEach((v) => {
        const p = parseAnyRecordDate(v.date);
        if (!p) return;
        const entry = getEntry(p.yearMonth, v.productFocus);
        entry.acc.tastingActivations += 1;
        entry.acc.requestedBtlUnits += Math.max(1, v.plannedUnits || 1);
        if (v.storeName) entry.acc.pdvSet.add(v.storeName.trim().toUpperCase());
      });
    }

    // C. Precios de mercado propios vs competencia (filtrando valores en Bs > $35 USD)
    if (module1Bundle?.priceComparisons && module1Bundle.priceComparisons.length > 0) {
      module1Bundle.priceComparisons.forEach((pc) => {
        const p = parseAnyRecordDate(pc.date);
        if (!p) return;
        const entry = getEntry(p.yearMonth, pc.ownProduct);
        if (pc.ownPriceUsd > 0 && pc.ownPriceUsd <= 35) {
          entry.acc.ownPriceSum += pc.ownPriceUsd;
          entry.acc.ownPriceCount += 1;
        }
        if (pc.averageCompetitorPriceUsd > 0 && pc.averageCompetitorPriceUsd <= 35) {
          entry.acc.compPriceSum += pc.averageCompetitorPriceUsd;
          entry.acc.compPriceCount += 1;
        }
        if (pc.storeName) entry.acc.pdvSet.add(pc.storeName.trim().toUpperCase());
      });
    }

    return byMonthAndLine;
  }, [module1Bundle, visits]);

  // 3. Construir Tabla Comparativa Mes a Mes (Mes Evaluado vs Mes Base)
  const allProductComparisonRows = useMemo<ProductMoMComparisonRow[]>(() => {
    const baseMap = monthlyProductMatrix.get(selectedBaseMonth);
    const evalMap = monthlyProductMatrix.get(selectedEvalMonth);

    const allLineIds = new Set<string>();
    const metaCatalog = new Map<string, CodizulcaProductLineMeta>();

    baseMap?.forEach((val, key) => {
      allLineIds.add(key);
      metaCatalog.set(key, val.meta);
    });
    evalMap?.forEach((val, key) => {
      allLineIds.add(key);
      metaCatalog.set(key, val.meta);
    });

    const rows: ProductMoMComparisonRow[] = [];

    allLineIds.forEach((lineId) => {
      const meta = metaCatalog.get(lineId)!;
      const baseAcc = baseMap?.get(lineId)?.acc || createEmptyAccumulator();
      const evalAcc = evalMap?.get(lineId)?.acc || createEmptyAccumulator();

      // Volumen efectivo de mercado: prioriza desplazamiento auditado en anaquel;
      // si una línea solo opera por degustación BTL, muestra únicamente las unidades BTL reales registradas.
      const useShelfBasis = baseAcc.shelfDisplacedUnits > 0 || evalAcc.shelfDisplacedUnits > 0;
      const prevVol = Math.round(
        useShelfBasis ? baseAcc.shelfDisplacedUnits : baseAcc.requestedBtlUnits
      );
      const currVol = Math.round(
        useShelfBasis ? evalAcc.shelfDisplacedUnits : evalAcc.requestedBtlUnits
      );

      if (prevVol === 0 && currVol === 0 && baseAcc.tastingSamples === 0 && evalAcc.tastingSamples === 0) {
        return;
      }

      const deltaUnits = currVol - prevVol;
      const deltaPct = prevVol > 0 ? ((currVol - prevVol) / prevVol) * 100 : null;

      let trend: 'UP' | 'DOWN' | 'NEW' | 'FLAT' = 'FLAT';
      let statusLabel = 'ESTABLE (0.0%)';

      if (prevVol === 0 && currVol > 0) {
        trend = 'NEW';
        statusLabel = 'NUEVA EXPANSIÓN';
      } else if (deltaPct !== null && deltaPct > 1.0) {
        trend = 'UP';
        statusLabel = 'EN CRECIMIENTO';
      } else if (deltaPct !== null && deltaPct < -1.0) {
        trend = 'DOWN';
        statusLabel = 'EN BAJADA';
      }

      const avgOwnPriceUsd =
        evalAcc.ownPriceCount > 0
          ? evalAcc.ownPriceSum / evalAcc.ownPriceCount
          : baseAcc.ownPriceCount > 0
          ? baseAcc.ownPriceSum / baseAcc.ownPriceCount
          : 0;

      const avgCompPriceUsd =
        evalAcc.compPriceCount > 0
          ? evalAcc.compPriceSum / evalAcc.compPriceCount
          : baseAcc.compPriceCount > 0
          ? baseAcc.compPriceSum / baseAcc.compPriceCount
          : 0;

      const priceGapPct =
        avgOwnPriceUsd > 0 && avgCompPriceUsd > 0
          ? ((avgOwnPriceUsd - avgCompPriceUsd) / avgCompPriceUsd) * 100
          : null;

      // Diagnóstico comercial automatizado
      let diagnosis = 'Rotación estable en puntos de venta auditados.';
      if (trend === 'NEW') {
        diagnosis = `Ingreso activo al mercado con cobertura en ${evalAcc.pdvSet.size} PDVs.`;
      } else if (trend === 'UP') {
        if (evalAcc.pdvSet.size > baseAcc.pdvSet.size) {
          diagnosis = `Crecimiento impulsado por expansión de cobertura (+${evalAcc.pdvSet.size - baseAcc.pdvSet.size} PDVs).`;
        } else if (priceGapPct !== null && priceGapPct <= 0) {
          diagnosis = `Alta tracción comercial apoyada en ventaja competitiva de precio (${priceGapPct.toFixed(1)}%).`;
        } else {
          diagnosis = `Mayor velocidad de reposición y sell-out por tienda en ${formatYearMonthShortEs(selectedEvalMonth)}.`;
        }
      } else if (trend === 'DOWN') {
        if (priceGapPct !== null && priceGapPct > 6) {
          diagnosis = `Bajada asociada a sobreprecio en anaquel (+${priceGapPct.toFixed(1)}% vs competencia).`;
        } else if (evalAcc.tastingSamples < baseAcc.tastingSamples) {
          diagnosis = `Menor impulso BTL (${evalAcc.tastingSamples} vs ${baseAcc.tastingSamples} muestras); reforzar degustación.`;
        } else {
          diagnosis = `Contracción de desplazamiento en góndola; priorizar exhibición y reposición FDV.`;
        }
      }

      rows.push({
        lineId,
        productLine: meta.label,
        brand: meta.brand,
        unitLabel: meta.unitLabel,
        prevVol,
        currVol,
        deltaUnits,
        deltaPct,
        trend,
        statusLabel,
        prevPdvCount: baseAcc.pdvSet.size,
        currPdvCount: evalAcc.pdvSet.size,
        prevSamples: Math.round(baseAcc.tastingSamples),
        currSamples: Math.round(evalAcc.tastingSamples),
        currActivations: evalAcc.tastingActivations,
        avgOwnPriceUsd,
        avgCompPriceUsd,
        priceGapPct,
        diagnosis,
      });
    });

    // Ordenar por volumen actual descendente
    return rows.sort((a, b) => b.currVol - a.currVol || b.prevVol - a.prevVol);
  }, [monthlyProductMatrix, selectedBaseMonth, selectedEvalMonth]);

  // Filtrado interactivo de la tabla Mes a Mes
  const filteredProductRows = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    return allProductComparisonRows.filter((row) => {
      if (brandFilter !== 'TODAS' && row.brand !== brandFilter) return false;
      if (trendFilter === 'CRECIMIENTO' && row.trend !== 'UP' && row.trend !== 'NEW') return false;
      if (trendFilter === 'BAJADA' && row.trend !== 'DOWN') return false;
      if (q && !row.productLine.toLowerCase().includes(q) && !row.brand.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [allProductComparisonRows, brandFilter, trendFilter, productSearch]);

  // Resumen ejecutivo global de la Comparativa Mes a Mes
  const momSummary = useMemo(() => {
    const source = brandFilter === 'TODAS' ? allProductComparisonRows : allProductComparisonRows.filter((r) => r.brand === brandFilter);
    const totalPrevVol = source.reduce((s, r) => s + r.prevVol, 0);
    const totalCurrVol = source.reduce((s, r) => s + r.currVol, 0);
    const netDeltaVol = totalCurrVol - totalPrevVol;
    const totalMoMPct = totalPrevVol > 0 ? ((netDeltaVol / totalPrevVol) * 100) : null;

    const growingLines = source.filter((r) => r.trend === 'UP' || r.trend === 'NEW');
    const decliningLines = source.filter((r) => r.trend === 'DOWN');

    const topGrower = [...growingLines].sort(
      (a, b) => (b.deltaPct ?? 100) - (a.deltaPct ?? 100) || b.deltaUnits - a.deltaUnits
    )[0] || null;

    const steepestDrop = [...decliningLines].sort(
      (a, b) => (a.deltaPct ?? 0) - (b.deltaPct ?? 0) || a.deltaUnits - b.deltaUnits
    )[0] || null;

    const totalCurrSamples = source.reduce((s, r) => s + r.currSamples, 0);
    const totalPrevSamples = source.reduce((s, r) => s + r.prevSamples, 0);

    const pricedRows = source.filter((r) => r.priceGapPct !== null);
    const avgPriceGap =
      pricedRows.length > 0
        ? pricedRows.reduce((s, r) => s + (r.priceGapPct || 0), 0) / pricedRows.length
        : 0;

    const maxVolForChart = Math.max(
      1,
      ...source.map((r) => Math.max(r.prevVol, r.currVol))
    );

    return {
      totalPrevVol,
      totalCurrVol,
      netDeltaVol,
      totalMoMPct,
      growingCount: growingLines.length,
      decliningCount: decliningLines.length,
      topGrower,
      steepestDrop,
      totalCurrSamples,
      totalPrevSamples,
      avgPriceGap,
      maxVolForChart,
    };
  }, [allProductComparisonRows, brandFilter]);

  // 3B. Serie Dinámica Multimes para la Gráfica de Barras según los Meses Seleccionados
  const chronologicalAvailableMonths = useMemo<string[]>(
    () => [...availableMonths].sort((a, b) => a.localeCompare(b)),
    [availableMonths]
  );

  const activeChartMonths = useMemo<string[]>(() => {
    const valid = selectedChartMonths.filter((m) => availableMonths.includes(m));
    if (valid.length > 0) return [...valid].sort((a, b) => a.localeCompare(b));
    return Array.from(new Set([selectedBaseMonth, selectedEvalMonth])).sort((a, b) =>
      a.localeCompare(b)
    );
  }, [selectedChartMonths, availableMonths, selectedBaseMonth, selectedEvalMonth]);

  const toggleChartMonth = (ym: string) => {
    const exists = activeChartMonths.includes(ym);
    if (exists && activeChartMonths.length <= 1) return; // Mantener al menos 1 mes seleccionado
    const next = exists
      ? activeChartMonths.filter((m) => m !== ym)
      : [...activeChartMonths, ym].sort((a, b) => a.localeCompare(b));
    setSelectedChartMonths(next);
    setIsMonthManuallyPinned(true);
    if (next.length >= 2) {
      setSelectedBaseMonth(next[next.length - 2]);
      setSelectedEvalMonth(next[next.length - 1]);
    } else if (next.length === 1) {
      setSelectedEvalMonth(next[0]);
    }
  };

  const selectBaseVsEvalChartMonths = () => {
    setSelectedChartMonths(
      Array.from(new Set([selectedBaseMonth, selectedEvalMonth])).sort((a, b) => a.localeCompare(b))
    );
  };

  const selectAllAvailableChartMonths = () => {
    setSelectedChartMonths(chronologicalAvailableMonths);
    if (chronologicalAvailableMonths.length >= 2) {
      setSelectedBaseMonth(chronologicalAvailableMonths[chronologicalAvailableMonths.length - 2]);
      setSelectedEvalMonth(chronologicalAvailableMonths[chronologicalAvailableMonths.length - 1]);
      setIsMonthManuallyPinned(true);
    }
  };

  const chartProductBarsData = useMemo(() => {
    const allLineIds = new Set<string>();
    const metaCatalog = new Map<string, CodizulcaProductLineMeta>();

    activeChartMonths.forEach((ym) => {
      const mMap = monthlyProductMatrix.get(ym);
      mMap?.forEach((val, key) => {
        allLineIds.add(key);
        metaCatalog.set(key, val.meta);
      });
    });

    const q = productSearch.trim().toLowerCase();
    const items: Array<{
      lineId: string;
      productLine: string;
      shortLabel: string;
      brand: 'ASTURIAS' | 'VENCAMPO';
      unitLabel: string;
      monthValues: Array<{
        ym: string;
        shortMonth: string;
        units: number;
        pdvCount: number;
        samples: number;
      }>;
      prevVol: number;
      lastVol: number;
      maxVol: number;
      deltaUnits: number;
      deltaPct: number | null;
      trend: 'UP' | 'DOWN' | 'NEW' | 'FLAT';
    }> = [];

    allLineIds.forEach((lineId) => {
      const meta = metaCatalog.get(lineId)!;
      if (brandFilter !== 'TODAS' && meta.brand !== brandFilter) return;
      if (q && !meta.label.toLowerCase().includes(q) && !meta.brand.toLowerCase().includes(q)) {
        return;
      }

      const useShelfBasis = activeChartMonths.some(
        (ym) => (monthlyProductMatrix.get(ym)?.get(lineId)?.acc.shelfDisplacedUnits || 0) > 0
      );

      let totalSamplesAcross = 0;
      const monthValues = activeChartMonths.map((ym) => {
        const acc = monthlyProductMatrix.get(ym)?.get(lineId)?.acc || createEmptyAccumulator();
        const units = Math.round(useShelfBasis ? acc.shelfDisplacedUnits : acc.requestedBtlUnits);
        const samples = Math.round(acc.tastingSamples);
        totalSamplesAcross += samples;
        return {
          ym,
          shortMonth: formatYearMonthShortEs(ym),
          units,
          pdvCount: acc.pdvSet.size,
          samples,
        };
      });

      const maxVol = Math.max(0, ...monthValues.map((mv) => mv.units));
      if (maxVol === 0 && totalSamplesAcross === 0) return;

      const lastVol = monthValues[monthValues.length - 1]?.units ?? 0;
      const prevVol =
        monthValues.length >= 2 ? monthValues[monthValues.length - 2].units : lastVol;
      const deltaUnits = lastVol - prevVol;
      const deltaPct =
        monthValues.length >= 2
          ? prevVol > 0
            ? ((lastVol - prevVol) / prevVol) * 100
            : null
          : 0;

      let trend: 'UP' | 'DOWN' | 'NEW' | 'FLAT' = 'FLAT';
      if (monthValues.length >= 2) {
        if (prevVol === 0 && lastVol > 0) trend = 'NEW';
        else if (deltaPct !== null && deltaPct > 1.0) trend = 'UP';
        else if (deltaPct !== null && deltaPct < -1.0) trend = 'DOWN';
      }

      if (trendFilter === 'CRECIMIENTO' && trend !== 'UP' && trend !== 'NEW') return;
      if (trendFilter === 'BAJADA' && trend !== 'DOWN') return;

      items.push({
        lineId,
        productLine: meta.label,
        shortLabel: shortProductAxisLabel(meta.label),
        brand: meta.brand,
        unitLabel: meta.unitLabel,
        monthValues,
        prevVol,
        lastVol,
        maxVol,
        deltaUnits,
        deltaPct,
        trend,
      });
    });

    items.sort((a, b) => b.lastVol - a.lastVol || b.maxVol - a.maxVol);
    const rawMax = Math.max(1, ...items.map((it) => it.maxVol));
    return {
      items,
      ceiling: computeNiceChartCeiling(rawMax),
    };
  }, [activeChartMonths, monthlyProductMatrix, brandFilter, trendFilter, productSearch]);

  const chartMonthlyBarsData = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    const rawMonths = activeChartMonths.map((ym) => {
      const mMap = monthlyProductMatrix.get(ym);
      let asturiasUnits = 0;
      let vencampoUnits = 0;
      let totalSamples = 0;
      const pdvUnion = new Set<string>();

      mMap?.forEach(({ meta, acc }) => {
        if (brandFilter !== 'TODAS' && meta.brand !== brandFilter) return;
        if (q && !meta.label.toLowerCase().includes(q) && !meta.brand.toLowerCase().includes(q)) {
          return;
        }
        const units = Math.round(
          acc.shelfDisplacedUnits > 0 ? acc.shelfDisplacedUnits : acc.requestedBtlUnits
        );
        if (meta.brand === 'ASTURIAS') asturiasUnits += units;
        else vencampoUnits += units;
        totalSamples += Math.round(acc.tastingSamples);
        acc.pdvSet.forEach((pdv) => pdvUnion.add(pdv));
      });

      return {
        ym,
        shortMonth: formatYearMonthShortEs(ym),
        fullMonth: formatYearMonthEs(ym),
        asturiasUnits,
        vencampoUnits,
        totalUnits: asturiasUnits + vencampoUnits,
        totalSamples,
        pdvCount: pdvUnion.size,
      };
    });

    const items = rawMonths.map((m, idx) => {
      const prev = idx > 0 ? rawMonths[idx - 1].totalUnits : null;
      const momPct =
        prev !== null && prev > 0 ? ((m.totalUnits - prev) / prev) * 100 : null;
      return {
        ...m,
        momPct,
      };
    });

    const rawMax = Math.max(1, ...items.map((it) => it.totalUnits));
    return {
      items,
      ceiling: computeNiceChartCeiling(rawMax),
    };
  }, [activeChartMonths, monthlyProductMatrix, brandFilter, productSearch]);

  // 4. Motor de Costos por Semana: Solicitudes de Trade Marketing a Contraloría
  const computeMonthWeeklyCosts = useMemo(() => {
    const buildForMonth = (ym: string, mode: 'CONSOLIDADO' | 'SOLO_ACTAS_MP'): WeeklyTradeCostRow[] => {
      const m = ym.match(/^(\d{4})-(\d{2})$/);
      const year = m ? Number(m[1]) : liveClock.year;
      const monthIdx = m ? Number(m[2]) - 1 : liveClock.monthIndex;

      const weekDefs = getMonthCalendarWeeks(year, monthIdx);

      // Filtrar Actas Formales de Contraloría del mes
      const monthReqs = requests.filter((req) => {
        if (req.status === 'RECHAZADO') return false;
        const p = parseAnyRecordDate(req.requestDate);
        return p?.yearMonth === ym;
      });

      // Filtrar Solicitudes Operativas de Degustación en Campo del mes
      const tastingSource =
        module1Bundle?.tastingItems && module1Bundle.tastingItems.length > 0
          ? module1Bundle.tastingItems
          : null;

      const rawRows: WeeklyTradeCostRow[] = weekDefs.map((wd) => {
        const weekFormalReqs = monthReqs.filter((req) => {
          const p = parseAnyRecordDate(req.requestDate);
          return p?.weekNumber === wd.weekNumber;
        });

        const formalCostUsd = weekFormalReqs.reduce((s, r) => s + (Number(r.estimatedCostUsd) || 0), 0);
        const formalUnits = weekFormalReqs.reduce((s, r) => s + (Number(r.totalUnits) || 0), 0);
        const formalApprovedCapUsd = weekFormalReqs.reduce(
          (s, r) => s + (Number(r.approvedBudgetCapUsd) || 0),
          0
        );
        const formalCodes = weekFormalReqs.map((r) => r.requestCode);
        const formalCampaigns = weekFormalReqs.map((r) => r.campaignOrPurpose);

        let fieldRequestsCount = 0;
        let fieldUnits = 0;
        let fieldCostUsd = 0;
        const productCounter = new Map<string, number>();

        if (tastingSource) {
          tastingSource.forEach((item) => {
            const p = parseAnyRecordDate(item.date);
            if (!p || p.yearMonth !== ym || p.weekNumber !== wd.weekNumber) return;
            if (brandFilter !== 'TODAS') {
              const meta = classifyCodizulcaProductLine(item.productName);
              if (meta.brand !== brandFilter) return;
            }
            const meta = classifyCodizulcaProductLine(item.productName);
            const rawQty = Number(item.requestedQty) || 1;
            const normUnits =
              rawQty > 30 ? Math.max(0.5, Number((rawQty / 1000).toFixed(1))) : Math.max(1, rawQty);

            fieldRequestsCount += 1;
            fieldUnits += normUnits;
            fieldCostUsd += normUnits * meta.btlActivationUnitCostUsd;
            productCounter.set(meta.label, (productCounter.get(meta.label) || 0) + normUnits);
          });
        } else {
          visits.forEach((v) => {
            const p = parseAnyRecordDate(v.date);
            if (!p || p.yearMonth !== ym || p.weekNumber !== wd.weekNumber) return;
            const meta = classifyCodizulcaProductLine(v.productFocus);
            if (brandFilter !== 'TODAS' && meta.brand !== brandFilter) return;
            const units = Math.max(1, v.plannedUnits || 1);
            fieldRequestsCount += 1;
            fieldUnits += units;
            fieldCostUsd += units * meta.btlActivationUnitCostUsd;
            productCounter.set(meta.label, (productCounter.get(meta.label) || 0) + units);
          });
        }

        const topFieldProducts = Array.from(productCounter.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([name]) => name);

        // Regla de consolidación sin doble conteo:
        // Si la semana ya posee Actas Formales MP-* en Contraloría, su costo formal rige las requisiciones radicadas;
        // si no tiene Acta MP formal pero sí solicitudes operativas de degustación de Trade, se valorizan como solicitudes por formalizar.
        const consolidatedCostUsd =
          mode === 'SOLO_ACTAS_MP'
            ? formalCostUsd
            : formalCostUsd > 0
            ? formalCostUsd
            : fieldCostUsd;

        const totalUnitsConsolidated =
          mode === 'SOLO_ACTAS_MP'
            ? formalUnits
            : formalUnits > 0
            ? formalUnits
            : Math.round(fieldUnits);

        let governanceStatus: WeeklyTradeCostRow['governanceStatus'] = 'SIN_SOLICITUDES';
        let governanceLabel = 'Sin solicitudes';

        if (weekFormalReqs.length > 0) {
          const allApproved = weekFormalReqs.every(
            (r) =>
              r.status === 'APROBADO_CONTRALORIA' ||
              r.status === 'DESPACHADO_ALMACEN' ||
              r.status === 'CONCILIADO_CERRADO' ||
              r.status === 'EN_EJECUCION'
          );
          governanceStatus = allApproved ? 'APROBADO_CONTRALORIA' : 'EN_VALIDACION';
          governanceLabel = allApproved ? 'Aprobado Contraloría' : 'En Validación MP';
        } else if (fieldRequestsCount > 0 && mode === 'CONSOLIDADO') {
          governanceStatus = 'POR_FORMALIZAR_ACTA';
          governanceLabel = 'Solicitado Campo (Sin Acta MP)';
        }

        return {
          weekNumber: wd.weekNumber,
          weekLabel: `Semana ${wd.weekNumber}`,
          rangeLabel: wd.rangeLabel,
          defaultDateYmd: wd.defaultDateYmd,
          formalRequisitionsCount: weekFormalReqs.length,
          formalCodes,
          formalCampaigns,
          formalUnits,
          formalCostUsd,
          formalApprovedCapUsd,
          fieldRequestsCount,
          fieldUnits: Math.round(fieldUnits),
          fieldCostUsd,
          topFieldProducts,
          consolidatedCostUsd,
          totalUnitsConsolidated,
          shareOfMonthPct: 0,
          wowDeltaPct: null,
          governanceStatus,
          governanceLabel,
        };
      });

      const monthTotalCost = rawRows.reduce((s, r) => s + r.consolidatedCostUsd, 0);
      let prevActiveWeekCost: number | null = null;

      return rawRows.map((row) => {
        const shareOfMonthPct =
          monthTotalCost > 0 ? (row.consolidatedCostUsd / monthTotalCost) * 100 : 0;

        let wowDeltaPct: number | null = null;
        if (row.consolidatedCostUsd > 0 && prevActiveWeekCost !== null && prevActiveWeekCost > 0) {
          wowDeltaPct = ((row.consolidatedCostUsd - prevActiveWeekCost) / prevActiveWeekCost) * 100;
        }
        if (row.consolidatedCostUsd > 0) {
          prevActiveWeekCost = row.consolidatedCostUsd;
        }

        return {
          ...row,
          shareOfMonthPct,
          wowDeltaPct,
        };
      });
    };

    return buildForMonth;
  }, [requests, module1Bundle, visits, brandFilter, liveClock.year, liveClock.monthIndex]);

  const weeklyCostRows = useMemo(
    () => computeMonthWeeklyCosts(selectedEvalMonth, costViewMode),
    [computeMonthWeeklyCosts, selectedEvalMonth, costViewMode]
  );

  const prevMonthWeeklyCostRows = useMemo(
    () => computeMonthWeeklyCosts(selectedBaseMonth, costViewMode),
    [computeMonthWeeklyCosts, selectedBaseMonth, costViewMode]
  );

  // Resumen ejecutivo de Costos Semanales a Contraloría
  const weeklyCostSummary = useMemo(() => {
    const totalEvalMonthCost = weeklyCostRows.reduce((s, w) => s + w.consolidatedCostUsd, 0);
    const totalBaseMonthCost = prevMonthWeeklyCostRows.reduce((s, w) => s + w.consolidatedCostUsd, 0);
    const momCostDeltaPct =
      totalBaseMonthCost > 0
        ? ((totalEvalMonthCost - totalBaseMonthCost) / totalBaseMonthCost) * 100
        : null;

    const activeWeeks = weeklyCostRows.filter((w) => w.consolidatedCostUsd > 0);
    const avgWeeklyCost = activeWeeks.length > 0 ? totalEvalMonthCost / activeWeeks.length : 0;

    const peakWeek =
      [...weeklyCostRows].sort((a, b) => b.consolidatedCostUsd - a.consolidatedCostUsd)[0] || null;

    const totalFormalCost = weeklyCostRows.reduce((s, w) => s + w.formalCostUsd, 0);
    const totalFieldCost = weeklyCostRows.reduce((s, w) => s + w.fieldCostUsd, 0);
    const totalFormalCount = weeklyCostRows.reduce((s, w) => s + w.formalRequisitionsCount, 0);
    const maxWeekBar = Math.max(
      1,
      ...weeklyCostRows.map((w) => Math.max(w.consolidatedCostUsd, w.formalCostUsd, w.fieldCostUsd))
    );

    return {
      totalEvalMonthCost,
      totalBaseMonthCost,
      momCostDeltaPct,
      activeWeeksCount: activeWeeks.length,
      avgWeeklyCost,
      peakWeek,
      totalFormalCost,
      totalFieldCost,
      totalFormalCount,
      maxWeekBar,
    };
  }, [weeklyCostRows, prevMonthWeeklyCostRows]);

  // Requisiciones formales del mes seleccionado (para listado rápido de trazabilidad)
  const monthFormalRequisitions = useMemo(() => {
    return requests.filter((r) => {
      const p = parseAnyRecordDate(r.requestDate);
      return p?.yearMonth === selectedEvalMonth;
    });
  }, [requests, selectedEvalMonth]);

  // 4.B Motor de Factibilidad de Degustación (Semana o Temporada Seleccionada vs Costo Productos Degustados)
  const weekFeasibilityQuickBadges = useMemo(() => {
    const weekNumbers =
      weeklyCostRows.length > 0
        ? weeklyCostRows.map((w) => w.weekNumber)
        : [1, 2, 3, 4, 5];
    return weekNumbers.map((wk) => {
      const rep = evaluateTastingFeasibility({
        periodLabel: `Semana ${wk} (${formatYearMonthShortEs(selectedEvalMonth)})`,
        dateMatcher: (p) => p.yearMonth === selectedEvalMonth && p.weekNumber === wk,
        brandFilter,
        returnBasis: feasibilityReturnBasis,
        tastingItems: module1Bundle?.tastingItems,
        inventorySampling: module1Bundle?.inventorySampling,
        priceComparisons: module1Bundle?.priceComparisons,
        formalRequests: requests,
        fallbackVisits: visits,
      });
      return {
        weekNumber: wk,
        scopeKey: `W${wk}` as 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6',
        hasData: rep.totalTastedProductCostUsd > 0 || rep.totalGeneratedRevenueUsd > 0,
        multiplier: rep.returnMultiplier,
        verdict: rep.verdict,
      };
    });
  }, [
    weeklyCostRows,
    selectedEvalMonth,
    brandFilter,
    feasibilityReturnBasis,
    module1Bundle,
    requests,
    visits,
  ]);

  const activeFeasibilityReport = useMemo(() => {
    let periodLabel = `Temporada Mensual: ${formatYearMonthEs(selectedEvalMonth)}`;
    let matcher = (p: { yearMonth: string; ymd: string; weekNumber: number }) =>
      p.yearMonth === selectedEvalMonth;

    if (feasibilityScope === 'SEMANA_ACTUAL_AUTO') {
      periodLabel = `Semana en Curso Auto (${liveClock.currentWeek.rangeLabel})`;
      matcher = (p) =>
        p.ymd >= liveClock.currentWeek.mondayYmd && p.ymd <= liveClock.currentWeek.sundayYmd;
    } else if (
      feasibilityScope === 'W1' ||
      feasibilityScope === 'W2' ||
      feasibilityScope === 'W3' ||
      feasibilityScope === 'W4' ||
      feasibilityScope === 'W5' ||
      feasibilityScope === 'W6'
    ) {
      const wk = Number(feasibilityScope.slice(1));
      const matchedWeekInfo = weeklyCostRows.find((w) => w.weekNumber === wk);
      periodLabel = matchedWeekInfo
        ? `${matchedWeekInfo.weekLabel} (${matchedWeekInfo.rangeLabel})`
        : `Semana ${wk} de ${formatYearMonthEs(selectedEvalMonth)}`;
      matcher = (p) => p.yearMonth === selectedEvalMonth && p.weekNumber === wk;
    } else if (feasibilityScope === 'TEMPORADA_ACUMULADA') {
      const oldest = availableMonths[availableMonths.length - 1] || selectedBaseMonth;
      const newest = availableMonths[0] || selectedEvalMonth;
      periodLabel = `Temporada Acumulada (${formatYearMonthShortEs(oldest)} - ${formatYearMonthShortEs(newest)})`;
      matcher = () => true;
    } else if (feasibilityScope === 'RANGO_TEMPORADA') {
      const from = feasibilityDateFrom || liveClock.currentWeek.mondayYmd;
      const to = feasibilityDateTo || liveClock.currentWeek.sundayYmd;
      const minD = from <= to ? from : to;
      const maxD = from <= to ? to : from;
      periodLabel = `Temporada Seleccionada (${minD} al ${maxD})`;
      matcher = (p) => p.ymd >= minD && p.ymd <= maxD;
    }

    return evaluateTastingFeasibility({
      periodLabel,
      dateMatcher: matcher,
      brandFilter,
      returnBasis: feasibilityReturnBasis,
      tastingItems: module1Bundle?.tastingItems,
      inventorySampling: module1Bundle?.inventorySampling,
      priceComparisons: module1Bundle?.priceComparisons,
      formalRequests: requests,
      fallbackVisits: visits,
    });
  }, [
    feasibilityScope,
    feasibilityDateFrom,
    feasibilityDateTo,
    feasibilityReturnBasis,
    selectedEvalMonth,
    selectedBaseMonth,
    availableMonths,
    weeklyCostRows,
    brandFilter,
    module1Bundle,
    requests,
    visits,
    liveClock.currentWeek.mondayYmd,
    liveClock.currentWeek.sundayYmd,
    liveClock.currentWeek.rangeLabel,
  ]);

  // 5. KPIs Operativos, Impulso y Gobernanza Generales
  const totalVisits = module1Bundle?.tastingItems?.length
    ? module1Bundle.tastingItems.filter((t) => parseAnyRecordDate(t.date)?.yearMonth === selectedEvalMonth).length || visits.length
    : visits.length;

  const completedOrInProgress = module1Bundle?.tastingItems?.length
    ? module1Bundle.tastingItems.filter(
        (t) =>
          parseAnyRecordDate(t.date)?.yearMonth === selectedEvalMonth &&
          (t.status === 'COMPLETADO' || t.status === 'EN_CURSO')
      ).length || visits.filter((v) => v.status === 'EN_CURSO' || v.status === 'COMPLETADA').length
    : visits.filter((v) => v.status === 'EN_CURSO' || v.status === 'COMPLETADA').length;

  const routeCompliancePct =
    totalVisits > 0 ? Math.min(100, Math.round((completedOrInProgress / totalVisits) * 100)) : 0;

  const totalContacts =
    momSummary.totalCurrSamples > 0
      ? momSummary.totalCurrSamples
      : tastingReports.reduce((acc, r) => acc + r.directContactsImpacts, 0);

  const totalAssistedSales =
    momSummary.totalCurrVol > 0
      ? momSummary.totalCurrVol
      : tastingReports.reduce((acc, r) => acc + r.assistedSalesUnits, 0);

  const avgConversionRate =
    totalContacts > 0 ? Math.min(98, (totalAssistedSales / totalContacts) * 100).toFixed(1) : '0.0';

  const avgCpc =
    totalContacts > 0 ? (weeklyCostSummary.totalEvalMonthCost / totalContacts).toFixed(3) : '0.000';

  const totalApprovedBudget = requests.reduce((acc, r) => acc + r.approvedBudgetCapUsd, 0);
  const totalExecutedBudget = requests.reduce((acc, r) => acc + r.estimatedCostUsd, 0);
  const budgetExecutionPct =
    totalApprovedBudget > 0 ? Math.round((totalExecutedBudget / totalApprovedBudget) * 100) : 0;

  const inventoryVarianceUnits =
    reconciliation.deliveredUnits -
    (reconciliation.degustatedUnitsReported + reconciliation.returnedRemanentUnits);
  const inventoryVariancePct =
    reconciliation.deliveredUnits > 0
      ? (Math.abs(inventoryVarianceUnits) / reconciliation.deliveredUnits) * 100
      : 0;
  const inventoryVarianceLabel =
    inventoryVarianceUnits === 0 ? 'Cuadrado' : inventoryVarianceUnits > 0 ? 'Merma' : 'Excedente';

  // Abrir modal para radicar nueva solicitud semanal (o pre-llenado desde una semana pendiente)
  const openNewRequisitionModal = (prefillWeek?: WeeklyTradeCostRow) => {
    const nextSeq = String(requests.length + 1).padStart(4, '0');
    setReqFormCode(`MP-${selectedEvalMonth.replace('-', '')}-${nextSeq}`);

    if (prefillWeek) {
      setReqFormDate(prefillWeek.defaultDateYmd);
      const topProd = prefillWeek.topFieldProducts[0] || '';
      setReqFormProduct(topProd.toUpperCase());
      const units = Math.max(1, prefillWeek.fieldUnits || 1);
      setReqFormQty(units);
      const unitCost =
        units > 0 && prefillWeek.fieldCostUsd > 0
          ? Number((prefillWeek.fieldCostUsd / units).toFixed(2))
          : 0;
      setReqFormUnitCost(unitCost);
      setReqFormUnit('Unidades / Kits BTL');
      setReqFormPurpose(
        `SOLICITUD SEMANAL TRADE MARKETING - ${prefillWeek.weekLabel.toUpperCase()} (${prefillWeek.rangeLabel.toUpperCase()})`
      );
      setReqFormBudgetCap(Number((units * unitCost).toFixed(2)));
    } else {
      setReqFormDate(liveClock.todayYmd);
      setReqFormProduct('');
      setReqFormQty(1);
      setReqFormUnit('Pieza (1kg)');
      setReqFormUnitCost(0);
      setReqFormPurpose('');
      setReqFormBudgetCap(0);
    }

    setReqFormStatus('APROBADO_CONTRALORIA');
    setIsReqModalOpen(true);
  };

  const handleCreateWeeklyRequisition = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseAnyRecordDate(reqFormDate);
    const formattedDmy = parsed
      ? `${String(parsed.day).padStart(2, '0')}/${String(parsed.monthIndex + 1).padStart(2, '0')}/${parsed.year}`
      : reqFormDate;

    const qty = Math.max(1, Number(reqFormQty) || 1);
    const unitCost = Math.max(0.1, Number(reqFormUnitCost) || 1);
    const totalCost = Number((qty * unitCost).toFixed(2));

    createRequisition({
      requestCode: reqFormCode.trim() || undefined,
      requestDate: formattedDmy,
      campaignOrPurpose: reqFormPurpose.trim() || 'Activación semanal Trade Marketing',
      approvedBudgetCapUsd: Math.max(totalCost, Number(reqFormBudgetCap) || totalCost),
      status: reqFormStatus,
      budgetCategory: `Activación Semanal BTL - ${formatYearMonthEs(parsed?.yearMonth || selectedEvalMonth)}`,
      notesAndObservations: `Solicitud semanal radicada desde Torre de Control de KPIs y Costos (Trade Marketing → Contraloría).`,
      items: [
        {
          id: `item_${Date.now()}`,
          itemNumber: 1,
          productName: reqFormProduct.trim() || 'PRODUCTO DEGUSTACIÓN CODIZULCA',
          category: 'PRODUCTO_DEGUSTACION',
          quantityRequested: qty,
          unitOfMeasure: reqFormUnit.trim() || 'Unid',
          unitCostUsd: unitCost,
          totalCostUsd: totalCost,
          lotNumber: `LOTE-${(parsed?.yearMonth || selectedEvalMonth).replace('-', '')}-BTL`,
        },
      ],
    });

    if (parsed && parsed.yearMonth !== selectedEvalMonth) {
      setSelectedEvalMonth(parsed.yearMonth);
    }
    setIsReqModalOpen(false);
  };

  // Preparar filas para exportación PDF Ejecutiva del Módulo 4
  const handleExportModule4Pdf = async () => {
    const productPdfRows: ExecutiveProductMoMPdfRow[] = filteredProductRows.map((r) => ({
      productLine: r.productLine,
      brand: r.brand,
      prevVol: r.prevVol,
      currVol: r.currVol,
      deltaUnits: r.deltaUnits,
      deltaPct: r.deltaPct,
      statusLabel: r.statusLabel,
      currPdvCount: r.currPdvCount,
      currSamples: r.currSamples,
      avgPriceUsd: r.avgOwnPriceUsd,
    }));

    const weeklyPdfRows: ExecutiveWeeklyCostPdfRow[] = weeklyCostRows.map((w) => ({
      weekLabel: w.weekLabel,
      rangeLabel: w.rangeLabel,
      requisitionCodes:
        w.formalCodes.length > 0
          ? w.formalCodes.join(', ')
          : w.fieldRequestsCount > 0
          ? `${w.fieldRequestsCount} solic. campo`
          : 'Sin solicitudes',
      requestsCount: w.formalRequisitionsCount + w.fieldRequestsCount,
      totalUnits: w.totalUnitsConsolidated,
      formalCostUsd: w.formalCostUsd,
      fieldRequestCostUsd: w.fieldCostUsd,
      consolidatedCostUsd: w.consolidatedCostUsd,
      wowDeltaPct: w.wowDeltaPct,
      governanceStatus: w.governanceLabel,
    }));

    const feasibilityPdfRows: ExecutiveFeasibilityPdfRow[] = activeFeasibilityReport.rows.map((r) => ({
      productLine: r.productLine,
      brand: r.brand,
      tastedUnits: r.tastedUnits,
      samplesDelivered: r.samplesDelivered,
      tastedProductCostUsd: r.tastedProductCostUsd,
      breakEvenUnits: r.breakEvenUnits,
      soldUnits: r.soldUnits,
      generatedRevenueUsd: r.generatedRevenueUsd,
      netBalanceUsd: r.netBalanceUsd,
      returnMultiplier: r.returnMultiplier,
      roiPercent: r.roiPercent,
      verdictLabel: r.verdictLabel,
    }));

    const attendanceInMonth = (module1Bundle?.attendanceRecords || []).filter(
      (a) => parseAnyRecordDate(a.date)?.yearMonth === selectedEvalMonth
    );
    const gpsVerifiedCount = attendanceInMonth.filter(
      (a) => typeof a.lat === 'number' && typeof a.lng === 'number'
    ).length;
    const gpsValidationPct =
      attendanceInMonth.length > 0
        ? Math.round((gpsVerifiedCount / attendanceInMonth.length) * 100)
        : 0;

    await exportExecutiveKpisPdf({
      routeCompliancePct,
      gpsValidationPct,
      gpsTotalRecords: attendanceInMonth.length,
      totalVisits,
      completedVisits: completedOrInProgress,
      totalContacts,
      totalAssistedSales,
      conversionRate: avgConversionRate,
      samplingCostUsd: weeklyCostSummary.totalEvalMonthCost,
      avgCpc,
      approvedBudget: totalApprovedBudget,
      executedBudget: totalExecutedBudget,
      budgetPct: budgetExecutionPct,
      evalMonthLabel: formatYearMonthEs(selectedEvalMonth),
      baseMonthLabel: formatYearMonthEs(selectedBaseMonth),
      productComparisonRows: productPdfRows,
      weeklyCostRows: weeklyPdfRows,
      feasibilityPeriodLabel: activeFeasibilityReport.periodLabel,
      feasibilityVerdictLabel: activeFeasibilityReport.verdictLabel,
      feasibilityRows: feasibilityPdfRows,
    });
  };

  return (
    <div className="space-y-6">
      {/* Membrete oficial exclusivo para soporte impreso / PDF */}
      <PrintSupportHeader
        moduleTitle="MÓDULO 4: KPI, COMPARATIVA MENSUAL DE MERCADO Y COSTOS SEMANALES"
        documentSubtitle={`Evaluación ${formatYearMonthEs(selectedEvalMonth)} vs ${formatYearMonthEs(selectedBaseMonth)} • Solicitudes Trade Marketing a Contraloría`}
        documentCode="CZ-MOD4-KPI-2026"
      />

      {/* CABECERA EJECUTIVA Y SELECTOR DE PERÍODO COMPARATIVO (NEGRO, ROJO Y BLANCO) */}
      <div className="bg-zinc-900/95 border border-zinc-800 rounded-2xl p-6 shadow-xl">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-5">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-[10px] font-black px-2.5 py-0.5 rounded-md bg-red-600 text-white uppercase tracking-wider shadow-sm">
                CODIZULCA · Inteligencia de Mercado & Contraloría
              </span>
              <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-md bg-zinc-950 text-zinc-200 border border-red-500/30 font-mono">
                Sem. {liveClock.isoWeekNumber} Auto · {liveClock.currentWeek.shortRangeLabel} · Hoy: {liveClock.todayDayLabel}
              </span>
              <span className="text-xs text-zinc-400 font-mono">
                {isLoadingSupabase
                  ? 'Sincronizando base histórica...'
                  : `Datos reales sincronizados (${availableMonths.length} meses activos)`}
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
              Comparativa Mes a Mes de Productos y Costos Semanales a Contraloría
            </h2>
            <p className="text-xs text-zinc-300 mt-1">
              Evaluación de crecimiento o bajada por línea en el mercado ({formatYearMonthEs(selectedEvalMonth)} vs{' '}
              {formatYearMonthEs(selectedBaseMonth)}) y control semanal de solicitudes BTL radicadas por Trade Marketing.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => openNewRequisitionModal()}
              className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-white border border-zinc-700 hover:border-red-500/60 text-xs font-bold transition-all shadow-sm cursor-pointer"
            >
              <Plus className="w-4 h-4 text-red-500" />
              <span>Radicar Solicitud Semanal</span>
            </button>

            <ExportPdfButton
              label="Exportar Informe KPIs (PDF)"
              documentTitle="Informe Ejecutivo de Comparativa Mensual y Costos Semanales"
              onExportPdf={handleExportModule4Pdf}
            />
          </div>
        </div>

        {/* Barra de Filtros Globales del Tablero Comparativo */}
        <div className="mt-5 pt-4 border-t border-zinc-800/90 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Mes Evaluado */}
          <div className="bg-zinc-950/90 border border-zinc-800 rounded-xl px-3.5 py-2.5">
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 mb-1">
              <Calendar className="w-3.5 h-3.5 text-red-500" />
              Mes Evaluado (Actual)
            </label>
            <select
              value={selectedEvalMonth}
              onChange={(e) => {
                const nextYm = e.target.value;
                let effectiveBase = selectedBaseMonth;
                if (effectiveBase === nextYm) {
                  const idx = availableMonths.indexOf(nextYm);
                  if (idx >= 0 && idx + 1 < availableMonths.length) {
                    effectiveBase = availableMonths[idx + 1];
                  } else {
                    effectiveBase = availableMonths.find((m) => m !== nextYm) || nextYm;
                  }
                }
                setSelectedEvalMonth(nextYm);
                setSelectedBaseMonth(effectiveBase);
                setSelectedChartMonths(
                  Array.from(new Set([effectiveBase, nextYm])).sort((a, b) => a.localeCompare(b))
                );
                setIsMonthManuallyPinned(nextYm !== liveClock.yearMonth);
              }}
              className="w-full bg-transparent text-sm font-bold text-white focus:outline-none cursor-pointer"
            >
              {availableMonths.map((ym) => (
                <option key={ym} value={ym} className="bg-zinc-900 text-white">
                  {formatYearMonthEs(ym)}
                  {ym === liveClock.yearMonth ? ' (En Curso Auto)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Mes Base Comparativo */}
          <div className="bg-zinc-950/90 border border-zinc-800 rounded-xl px-3.5 py-2.5">
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 mb-1">
              <BarChart3 className="w-3.5 h-3.5 text-zinc-300" />
              Mes Base de Comparación
            </label>
            <select
              value={selectedBaseMonth}
              onChange={(e) => {
                const nextBase = e.target.value;
                setSelectedBaseMonth(nextBase);
                setSelectedChartMonths(
                  Array.from(new Set([nextBase, selectedEvalMonth])).sort((a, b) =>
                    a.localeCompare(b)
                  )
                );
                setIsMonthManuallyPinned(true);
              }}
              className="w-full bg-transparent text-sm font-bold text-white focus:outline-none cursor-pointer"
            >
              {availableMonths
                .filter((ym) => ym !== selectedEvalMonth)
                .map((ym) => (
                  <option key={ym} value={ym} className="bg-zinc-900 text-white">
                    {formatYearMonthEs(ym)}
                  </option>
                ))}
            </select>
          </div>

          {/* Filtro por Marca Comercial */}
          <div className="bg-zinc-950/90 border border-zinc-800 rounded-xl px-3.5 py-2.5">
            <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 mb-1">
              <Filter className="w-3.5 h-3.5 text-red-500" />
              Portafolio / Marca
            </label>
            <div className="flex items-center gap-1">
              {(['TODAS', 'ASTURIAS', 'VENCAMPO'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBrandFilter(b)}
                  className={`flex-1 py-1 px-2 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                    brandFilter === b
                      ? 'bg-red-600 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          {/* Estado Auditoría de Inventario */}
          <div className="bg-zinc-950/90 border border-zinc-800 rounded-xl px-3.5 py-2.5 flex flex-col justify-center">
            <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-bold">
              Conciliación Contraloría (3 Vías)
            </span>
            <div className="flex items-center justify-between mt-1">
              <span className="text-sm font-black text-white font-mono">
                {inventoryVariancePct.toFixed(2)}% ({inventoryVarianceLabel})
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                AUDITADO
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* SECCIÓN NUEVA: FACTIBILIDAD DE DEGUSTACIÓN VS COSTO DE PROD. DEGUSTADO */}
      {/* ===================================================================== */}
      <div className="bg-zinc-900/95 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-5">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Scale className="w-4 h-4 text-red-500" />
              <span className="text-[11px] font-black text-red-400 uppercase tracking-widest">
                Rentabilidad & Retorno Comercial BTL · Costo vs. Resultado
              </span>
            </div>
            <h3 className="text-lg font-black text-white mt-0.5">
              Factibilidad de la Degustación vs. Costo de los Productos Degustados
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Evalúa qué tan rentable y factible fue la degustación en la semana o temporada seleccionada comparando el valor de las ventas logradas contra el costo real del producto abierto/degustado.
            </p>
          </div>

          {/* Selector de Base de Retorno Comercial */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl bg-zinc-950 p-1 border border-zinc-800">
              <button
                type="button"
                onClick={() => setFeasibilityReturnBasis('VENTAS_DIRECTAS_BTL')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  feasibilityReturnBasis === 'VENTAS_DIRECTAS_BTL'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Ventas Directas en Degustación
              </button>
              <button
                type="button"
                onClick={() => setFeasibilityReturnBasis('SELL_OUT_TOTAL_PDV')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  feasibilityReturnBasis === 'SELL_OUT_TOTAL_PDV'
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Impacto Total Góndola (Sell-Out)
              </button>
            </div>
          </div>
        </div>

        {/* Selector Rápido de Semana o Temporada */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-black text-zinc-400 uppercase tracking-wider mr-1">
              Semana o Temporada:
            </span>

            {/* Mes completo evaluado */}
            <button
              type="button"
              onClick={() => setFeasibilityScope('MES_COMPLETO')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                feasibilityScope === 'MES_COMPLETO'
                  ? 'bg-red-600 text-white border-red-500 shadow-sm'
                  : 'bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-zinc-700'
              }`}
            >
              Mes {formatYearMonthShortEs(selectedEvalMonth)}
            </button>

            {/* Semana en Curso Automática (Lunes-Domingo en vivo) */}
            <button
              type="button"
              onClick={() => setFeasibilityScope('SEMANA_ACTUAL_AUTO')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                feasibilityScope === 'SEMANA_ACTUAL_AUTO'
                  ? 'bg-red-600 text-white border-red-500 shadow-sm'
                  : 'bg-zinc-950 text-red-300 border-red-500/40 hover:border-red-500'
              }`}
            >
              Semana Actual Auto ({liveClock.currentWeek.shortRangeLabel})
            </button>

            {/* Semanas 1 a 5 del mes con su multiplicador rápido */}
            {weekFeasibilityQuickBadges.map((wb) => {
              const isSelected = feasibilityScope === wb.scopeKey;
              return (
                <button
                  key={wb.scopeKey}
                  type="button"
                  onClick={() => setFeasibilityScope(wb.scopeKey)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-red-600 text-white border-red-500 shadow-sm'
                      : 'bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <span>Semana {wb.weekNumber}</span>
                  {wb.hasData ? (
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.2 rounded ${
                        isSelected
                          ? 'bg-black/30 text-white'
                          : wb.multiplier >= 1.5
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : wb.multiplier >= 1.0
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'bg-red-500/15 text-red-400'
                      }`}
                    >
                      {wb.multiplier.toFixed(1)}x
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono text-zinc-500">S/D</span>
                  )}
                </button>
              );
            })}

            {/* Temporada Acumulada (Todos los meses) */}
            <button
              type="button"
              onClick={() => setFeasibilityScope('TEMPORADA_ACUMULADA')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                feasibilityScope === 'TEMPORADA_ACUMULADA'
                  ? 'bg-red-600 text-white border-red-500 shadow-sm'
                  : 'bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-zinc-700'
              }`}
            >
              Temporada Global ({availableMonths.length} meses)
            </button>

            {/* Temporada / Rango de Fechas Personalizado */}
            <button
              type="button"
              onClick={() => setFeasibilityScope('RANGO_TEMPORADA')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                feasibilityScope === 'RANGO_TEMPORADA'
                  ? 'bg-red-600 text-white border-red-500 shadow-sm'
                  : 'bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-zinc-700'
              }`}
            >
              Temporada / Rango Fechas
            </button>
          </div>

          {/* Controles de Rango de Fechas si elige Temporada Personalizada */}
          {feasibilityScope === 'RANGO_TEMPORADA' && (
            <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-zinc-950 border border-red-500/30">
              <span className="text-xs font-bold text-white">Definir Temporada / Campaña:</span>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-zinc-400 font-semibold">Desde:</label>
                <input
                  type="date"
                  value={feasibilityDateFrom}
                  onChange={(e) => {
                    setFeasibilityDateFrom(e.target.value);
                    setIsFeasibilityRangeManual(true);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-white font-mono focus:outline-none focus:border-red-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-zinc-400 font-semibold">Hasta:</label>
                <input
                  type="date"
                  value={feasibilityDateTo}
                  onChange={(e) => {
                    setFeasibilityDateTo(e.target.value);
                    setIsFeasibilityRangeManual(true);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-white font-mono focus:outline-none focus:border-red-500"
                />
              </div>
              <span className="text-[11px] text-zinc-400 font-mono">
                Evaluando {activeFeasibilityReport.totalActivations} activaciones en el rango
              </span>
            </div>
          )}
        </div>

        {/* 4 Tarjetas Principales de Factibilidad vs Costo Degustado */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* Card 1: Índice / Multiplicador de Factibilidad y Veredicto */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90 relative overflow-hidden">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Índice de Factibilidad
              </span>
              <span
                className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${
                  activeFeasibilityReport.verdict === 'ALTAMENTE_FACTIBLE' ||
                  activeFeasibilityReport.verdict === 'FACTIBLE'
                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                    : activeFeasibilityReport.verdict === 'MARGEN_AJUSTADO'
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    : activeFeasibilityReport.verdict === 'NO_FACTIBLE'
                    ? 'bg-red-500/15 text-red-400 border-red-500/30'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                }`}
              >
                {activeFeasibilityReport.verdictLabel}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span
                className={`text-3xl font-black font-mono ${
                  activeFeasibilityReport.returnMultiplier >= 1.5
                    ? 'text-emerald-400'
                    : activeFeasibilityReport.returnMultiplier >= 1.0
                    ? 'text-amber-300'
                    : activeFeasibilityReport.totalTastedProductCostUsd > 0
                    ? 'text-red-400'
                    : 'text-zinc-400'
                }`}
              >
                {activeFeasibilityReport.returnMultiplier.toFixed(2)}x
              </span>
              <span className="text-xs font-mono font-bold text-zinc-300">
                ROI: {activeFeasibilityReport.roiPercent >= 0 ? '+' : ''}
                {activeFeasibilityReport.roiPercent.toFixed(0)}%
              </span>
            </div>
            <span className="text-[11px] text-zinc-400 mt-1.5 block">
              Por cada <strong className="text-white">$1.00</strong> degustado retornaron{' '}
              <strong className="text-white">
                ${activeFeasibilityReport.returnMultiplier.toFixed(2)} USD
              </strong>
            </span>
          </div>

          {/* Card 2: Costo de los Productos Degustados */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Costo Productos Degustados
              </span>
              <span className="p-1.5 rounded-lg bg-red-600/15 text-red-400 border border-red-500/30">
                <DollarSign className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-white font-mono">
              ${activeFeasibilityReport.totalTastedProductCostUsd.toFixed(2)}{' '}
              <span className="text-xs font-normal text-zinc-400">USD</span>
            </div>
            <div className="text-[11px] text-zinc-400 mt-1.5 flex items-center justify-between">
              <span>{activeFeasibilityReport.totalTastedUnits} unid. abiertas</span>
              <span className="font-mono text-zinc-300">
                Peso costo: {activeFeasibilityReport.costToSalesRatioPct.toFixed(1)}% de venta
              </span>
            </div>
          </div>

          {/* Card 3: Retorno Comercial vs Balance Neto */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Ventas Generadas vs. Costo
              </span>
              <span className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <ShoppingBag className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-white font-mono">
              ${activeFeasibilityReport.totalGeneratedRevenueUsd.toFixed(2)}{' '}
              <span className="text-xs font-normal text-zinc-400">
                ({activeFeasibilityReport.totalSoldUnits.toLocaleString('es-VE')} un)
              </span>
            </div>
            <span className="text-[11px] text-zinc-400 mt-1.5 block">
              Balance neto:{' '}
              <strong
                className={
                  activeFeasibilityReport.netBalanceUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                }
              >
                {activeFeasibilityReport.netBalanceUsd >= 0 ? '+' : ''}$
                {activeFeasibilityReport.netBalanceUsd.toFixed(2)} USD
              </strong>{' '}
              sobre producto degustado
            </span>
          </div>

          {/* Card 4: Punto de Equilibrio (Break-Even) y Eficiencia */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Punto de Equilibrio (Break-Even)
              </span>
              <span className="p-1.5 rounded-lg bg-zinc-900 text-zinc-200 border border-zinc-800">
                <Target className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-white font-mono">
              {activeFeasibilityReport.totalBreakEvenUnits.toLocaleString('es-VE')}{' '}
              <span className="text-xs font-normal text-zinc-400">unid. mínimas</span>
            </div>
            <div className="text-[11px] text-zinc-400 mt-1.5 flex items-center justify-between">
              <span>
                Cobertura:{' '}
                <strong
                  className={
                    activeFeasibilityReport.breakEvenCoveragePct >= 100
                      ? 'text-emerald-400'
                      : 'text-red-400'
                  }
                >
                  {activeFeasibilityReport.breakEvenCoveragePct.toFixed(0)}%
                </strong>
              </span>
              <span className="font-mono text-zinc-300">
                ${activeFeasibilityReport.costPerSampleUsd.toFixed(3)}/muestra
              </span>
            </div>
          </div>
        </div>

        {/* Termómetro Comparativo Visual (Costo Producto Degustado vs Retorno Generado) + Dictamen */}
        <div className="p-4 rounded-xl bg-zinc-950/90 border border-zinc-800/90 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
            <div>
              <span className="text-xs font-black text-white uppercase tracking-wider">
                Comparativa Directa: {activeFeasibilityReport.periodLabel}
              </span>
              <p className="text-[11px] text-zinc-300 mt-0.5">
                {activeFeasibilityReport.verdictRecommendation}
              </p>
            </div>
            <span className="text-[11px] font-mono text-zinc-400 shrink-0">
              {activeFeasibilityReport.totalActivations} degustaciones •{' '}
              {activeFeasibilityReport.totalSamplesDelivered.toLocaleString('es-VE')} muestras entregadas
            </span>
          </div>

          {(() => {
            const maxBar = Math.max(
              1,
              activeFeasibilityReport.totalTastedProductCostUsd,
              activeFeasibilityReport.totalGeneratedRevenueUsd
            );
            const costPct = Math.max(
              3,
              Math.round((activeFeasibilityReport.totalTastedProductCostUsd / maxBar) * 100)
            );
            const revPct = Math.max(
              3,
              Math.round((activeFeasibilityReport.totalGeneratedRevenueUsd / maxBar) * 100)
            );

            return (
              <div className="space-y-2 pt-1">
                <div className="grid grid-cols-12 items-center gap-3">
                  <span className="col-span-4 sm:col-span-3 text-[11px] font-bold text-zinc-300">
                    Costo Prod. Degustados
                  </span>
                  <div className="col-span-5 sm:col-span-7 bg-zinc-900 h-3 rounded-full overflow-hidden border border-zinc-800">
                    <div
                      className="bg-red-600 h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${
                          activeFeasibilityReport.totalTastedProductCostUsd === 0 ? 0 : costPct
                        }%`,
                      }}
                    />
                  </div>
                  <span className="col-span-3 sm:col-span-2 text-right text-xs font-mono font-bold text-red-400">
                    ${activeFeasibilityReport.totalTastedProductCostUsd.toFixed(2)}
                  </span>
                </div>

                <div className="grid grid-cols-12 items-center gap-3">
                  <span className="col-span-4 sm:col-span-3 text-[11px] font-bold text-white">
                    Retorno Ventas Logradas
                  </span>
                  <div className="col-span-5 sm:col-span-7 bg-zinc-900 h-3 rounded-full overflow-hidden border border-zinc-800">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        activeFeasibilityReport.returnMultiplier >= 1.0
                          ? 'bg-emerald-500'
                          : 'bg-amber-500'
                      }`}
                      style={{
                        width: `${
                          activeFeasibilityReport.totalGeneratedRevenueUsd === 0 ? 0 : revPct
                        }%`,
                      }}
                    />
                  </div>
                  <span className="col-span-3 sm:col-span-2 text-right text-xs font-mono font-black text-emerald-400">
                    ${activeFeasibilityReport.totalGeneratedRevenueUsd.toFixed(2)}
                  </span>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Tabla de Factibilidad Desglosada por Producto Degustado */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-950 border-b border-zinc-800 text-[10px] font-black text-zinc-400 uppercase tracking-wider">
                <th className="py-3 px-4">Producto Degustado</th>
                <th className="py-3 px-3 text-right">Insumo Abierto</th>
                <th className="py-3 px-3 text-right">Costo Degustado</th>
                <th className="py-3 px-3 text-right">Equilibrio (Unid)</th>
                <th className="py-3 px-3 text-right">Ventas Logradas</th>
                <th className="py-3 px-3 text-right">Retorno (USD)</th>
                <th className="py-3 px-3 text-right">Balance Neto</th>
                <th className="py-3 px-3 text-center">Multiplicador / ROI</th>
                <th className="py-3 px-4 text-center">Dictamen Factibilidad</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70 text-xs">
              {activeFeasibilityReport.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-zinc-400">
                    No hay degustaciones registradas en la semana o temporada seleccionada. Elija otra semana o rango de fechas.
                  </td>
                </tr>
              ) : (
                activeFeasibilityReport.rows.map((r) => (
                  <tr
                    key={r.lineId}
                    className="bg-zinc-900/40 hover:bg-zinc-800/50 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="font-bold text-white">{r.productLine}</div>
                      <div className="text-[10px] text-zinc-400">
                        <span className="text-red-400 font-bold">{r.brand}</span> •{' '}
                        {r.activationsCount} activ. ({r.samplesDelivered.toLocaleString('es-VE')}{' '}
                        muestras)
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-zinc-300">
                      {r.tastedUnits} un
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-bold text-red-300">
                      ${r.tastedProductCostUsd.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-zinc-400">
                      {r.breakEvenUnits} un
                      <span className="block text-[10px] text-zinc-500">
                        @${r.unitSellPriceUsd.toFixed(2)}/u
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-bold text-white">
                      {r.soldUnits.toLocaleString('es-VE')} un
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-black text-white">
                      ${r.generatedRevenueUsd.toFixed(2)}
                    </td>
                    <td
                      className={`py-3 px-3 text-right font-mono font-bold ${
                        r.netBalanceUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {r.netBalanceUsd >= 0 ? '+' : ''}${r.netBalanceUsd.toFixed(2)}
                    </td>
                    <td className="py-3 px-3 text-center font-mono">
                      <span className="font-black text-white">
                        {r.returnMultiplier.toFixed(2)}x
                      </span>
                      <span
                        className={`block text-[10px] font-bold ${
                          r.roiPercent >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {r.roiPercent >= 0 ? '+' : ''}
                        {r.roiPercent.toFixed(0)}% ROI
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-black border ${
                          r.verdict === 'ALTAMENTE_FACTIBLE' || r.verdict === 'FACTIBLE'
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                            : r.verdict === 'MARGEN_AJUSTADO'
                            ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                            : 'bg-red-500/15 text-red-400 border-red-500/30'
                        }`}
                      >
                        {r.verdictLabel}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* SECCIÓN A: COMPARATIVA MES A MES (CRECIMIENTO O BAJADA EN MERCADO)    */}
      {/* ===================================================================== */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-600"></span>
              <span className="text-[11px] font-black text-red-400 uppercase tracking-widest">
                Análisis Comparativo de Mercado (Mes a Mes)
              </span>
            </div>
            <h3 className="text-lg font-black text-white mt-0.5">
              Crecimiento y Bajada de Productos en el Mercado ({formatYearMonthShortEs(selectedEvalMonth)} vs{' '}
              {formatYearMonthShortEs(selectedBaseMonth)})
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Medición basada en desplazamiento real auditado en anaquel (stock inicial vs final), cobertura de PDVs, muestras BTL y precios frente a competencia.
            </p>
          </div>

          {/* Controles rápidos de filtro de tendencia y búsqueda */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl bg-zinc-950 p-1 border border-zinc-800">
              <button
                type="button"
                onClick={() => setTrendFilter('TODOS')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  trendFilter === 'TODOS'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Todos ({allProductComparisonRows.length})
              </button>
              <button
                type="button"
                onClick={() => setTrendFilter('CRECIMIENTO')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1 ${
                  trendFilter === 'CRECIMIENTO'
                    ? 'bg-emerald-600/25 text-emerald-300 border border-emerald-500/40'
                    : 'text-zinc-400 hover:text-emerald-300'
                }`}
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                Crecimiento ({momSummary.growingCount})
              </button>
              <button
                type="button"
                onClick={() => setTrendFilter('BAJADA')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1 ${
                  trendFilter === 'BAJADA'
                    ? 'bg-red-600/25 text-red-300 border border-red-500/40'
                    : 'text-zinc-400 hover:text-red-300'
                }`}
              >
                <ArrowDownRight className="w-3.5 h-3.5" />
                Bajada ({momSummary.decliningCount})
              </button>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Buscar producto..."
                className="pl-8 pr-3 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 w-44"
              />
            </div>
          </div>
        </div>

        {/* 4 Tarjetas Resumen MoM */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* Card 1: Desplazamiento Total MoM */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Desplazamiento Total Mercado
              </span>
              {momSummary.netDeltaVol >= 0 ? (
                <span className="inline-flex items-center gap-0.5 text-[11px] font-black px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  {momSummary.totalMoMPct !== null ? `+${momSummary.totalMoMPct.toFixed(1)}%` : 'NUEVO'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-0.5 text-[11px] font-black px-2 py-0.5 rounded-md bg-red-500/15 text-red-400 border border-red-500/30">
                  <ArrowDownRight className="w-3.5 h-3.5" />
                  {momSummary.totalMoMPct !== null ? `${momSummary.totalMoMPct.toFixed(1)}%` : '-'}
                </span>
              )}
            </div>
            <div className="text-2xl font-black text-white font-mono">
              {momSummary.totalCurrVol.toLocaleString('es-VE')} <span className="text-xs font-normal text-zinc-400">unid.</span>
            </div>
            <div className="text-[11px] text-zinc-400 mt-1.5 flex items-center justify-between">
              <span>{formatYearMonthShortEs(selectedBaseMonth)}: {momSummary.totalPrevVol.toLocaleString('es-VE')} un</span>
              <span className={momSummary.netDeltaVol >= 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                {momSummary.netDeltaVol >= 0 ? '+' : ''}
                {momSummary.netDeltaVol.toLocaleString('es-VE')} un
              </span>
            </div>
          </div>

          {/* Card 2: Líneas en Crecimiento */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Líneas en Crecimiento
              </span>
              <span className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <TrendingUp className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-emerald-400 font-mono">
              {momSummary.growingCount} <span className="text-xs font-semibold text-zinc-400">líneas ▲</span>
            </div>
            <span className="text-[11px] text-zinc-300 mt-1.5 block truncate">
              {momSummary.topGrower
                ? `Líder: ${momSummary.topGrower.productLine} (${
                    momSummary.topGrower.deltaPct !== null
                      ? `+${momSummary.topGrower.deltaPct.toFixed(1)}%`
                      : 'Expansión'
                  })`
                : 'Sin líneas en crecimiento en este filtro'}
            </span>
          </div>

          {/* Card 3: Líneas en Bajada / Alerta */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Líneas en Bajada / Alerta
              </span>
              <span className="p-1.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">
                <TrendingDown className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-red-400 font-mono">
              {momSummary.decliningCount} <span className="text-xs font-semibold text-zinc-400">líneas ▼</span>
            </div>
            <span className="text-[11px] text-zinc-300 mt-1.5 block truncate">
              {momSummary.steepestDrop
                ? `Mayor caída: ${momSummary.steepestDrop.productLine} (${
                    momSummary.steepestDrop.deltaPct !== null
                      ? `${momSummary.steepestDrop.deltaPct.toFixed(1)}%`
                      : ''
                  })`
                : '0 productos en retroceso en este período'}
            </span>
          </div>

          {/* Card 4: Impulso BTL & Posicionamiento Precio */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Impulso & Brecha Precio
              </span>
              <span className="p-1.5 rounded-lg bg-zinc-900 text-white border border-zinc-700">
                <Package className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-white font-mono">
              {momSummary.totalCurrSamples.toLocaleString('es-VE')}{' '}
              <span className="text-xs font-normal text-zinc-400">muestras</span>
            </div>
            <span className="text-[11px] text-zinc-400 mt-1.5 block">
              Brecha vs competencia:{' '}
              <strong className={momSummary.avgPriceGap <= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {momSummary.avgPriceGap >= 0 ? '+' : ''}
                {momSummary.avgPriceGap.toFixed(1)}%
              </strong>{' '}
              ({momSummary.avgPriceGap <= 0 ? 'Más competitivo' : 'Sobre promedio'})
            </span>
          </div>
        </div>

        {/* Gráfica de Barras Verticales Comparativa según los Meses Seleccionados */}
        <div className="p-5 rounded-2xl bg-zinc-950/95 border border-zinc-800/90 shadow-inner space-y-4">
          {/* Cabecera y Controles de Vista / Escala */}
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-red-500" />
                <h4 className="text-xs sm:text-sm font-black text-white uppercase tracking-wider">
                  Gráfica de Barras de Desplazamiento según Meses Seleccionados
                </h4>
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Comparativa vertical en unidades desplazadas para{' '}
                <strong className="text-zinc-200">
                  {activeChartMonths.map(formatYearMonthShortEs).join(' · ')}
                </strong>{' '}
                ({activeChartMonths.length}{' '}
                {activeChartMonths.length === 1 ? 'mes seleccionado' : 'meses seleccionados'})
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Modo de agrupación de barras */}
              <div className="inline-flex rounded-xl bg-zinc-900 p-1 border border-zinc-800">
                <button
                  type="button"
                  onClick={() => setChartGroupingMode('POR_PRODUCTO')}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                    chartGroupingMode === 'POR_PRODUCTO'
                      ? 'bg-red-600 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Barras por Producto
                </button>
                <button
                  type="button"
                  onClick={() => setChartGroupingMode('POR_MES')}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                    chartGroupingMode === 'POR_MES'
                      ? 'bg-red-600 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Barras por Mes
                </button>
              </div>

              {/* Modo de escala vertical */}
              <div className="inline-flex rounded-xl bg-zinc-900 p-1 border border-zinc-800">
                <button
                  type="button"
                  onClick={() => setChartScaleMode('ADAPTATIVA')}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                    chartScaleMode === 'ADAPTATIVA'
                      ? 'bg-zinc-800 text-white border border-zinc-700'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                  title="Escala adaptativa (raíz cuadrada) que permite visualizar con claridad tanto líneas de 40.000 unid. como líneas de 80-500 unid."
                >
                  Escala Adaptativa
                </button>
                <button
                  type="button"
                  onClick={() => setChartScaleMode('LINEAL')}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                    chartScaleMode === 'LINEAL'
                      ? 'bg-zinc-800 text-white border border-zinc-700'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                  title="Escala lineal estricta proporcional al volumen máximo"
                >
                  Escala Lineal
                </button>
              </div>
            </div>
          </div>

          {/* Selector Interactivo de Meses para la Gráfica de Barras */}
          <div className="flex flex-wrap items-center justify-between gap-2.5 p-3 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-black text-zinc-400 uppercase tracking-wider mr-1 flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-red-500" />
                Meses Seleccionados:
              </span>

              {chronologicalAvailableMonths.map((ym) => {
                const isSelected = activeChartMonths.includes(ym);
                const posInSelected = activeChartMonths.indexOf(ym);
                const isTwoMonthMode = activeChartMonths.length === 2;
                let dotColor = 'bg-zinc-600';
                if (isSelected) {
                  if (isTwoMonthMode) {
                    dotColor = posInSelected === 0 ? 'bg-zinc-400' : 'bg-red-500';
                  } else {
                    const fromEnd = activeChartMonths.length - 1 - posInSelected;
                    dotColor =
                      fromEnd === 0
                        ? 'bg-red-500'
                        : fromEnd === 1
                        ? 'bg-zinc-200'
                        : fromEnd === 2
                        ? 'bg-zinc-500'
                        : fromEnd === 3
                        ? 'bg-emerald-400'
                        : 'bg-amber-400';
                  }
                }

                return (
                  <button
                    key={ym}
                    type="button"
                    onClick={() => toggleChartMonth(ym)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-zinc-950 text-white border-red-500/60 shadow-sm'
                        : 'bg-zinc-950/40 text-zinc-500 border-zinc-800 hover:text-zinc-300 hover:border-zinc-700'
                    }`}
                    title={
                      isSelected
                        ? `Quitar ${formatYearMonthEs(ym)} de la gráfica`
                        : `Agregar ${formatYearMonthEs(ym)} a la gráfica de barras`
                    }
                  >
                    <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                    <span>{formatYearMonthShortEs(ym)}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={selectBaseVsEvalChartMonths}
                className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 transition-colors cursor-pointer"
              >
                Base vs Evaluado
              </button>
              {chronologicalAvailableMonths.length > 2 && (
                <button
                  type="button"
                  onClick={selectAllAvailableChartMonths}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-colors cursor-pointer ${
                    activeChartMonths.length === chronologicalAvailableMonths.length
                      ? 'bg-red-600/20 text-red-300 border-red-500/40'
                      : 'bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border-zinc-800'
                  }`}
                >
                  Todos ({chronologicalAvailableMonths.length} meses)
                </button>
              )}
            </div>
          </div>

          {/* Leyenda Dinámica de Series */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] px-1">
            {chartGroupingMode === 'POR_PRODUCTO' ? (
              activeChartMonths.length === 2 ? (
                <div className="flex flex-wrap items-center gap-4">
                  <span className="inline-flex items-center gap-1.5 text-zinc-300">
                    <span className="w-3 h-3 rounded-sm bg-gradient-to-t from-zinc-600 to-zinc-400 inline-block border border-zinc-400/40" />
                    {formatYearMonthShortEs(activeChartMonths[0])} (Mes Base)
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-zinc-200">
                    <span className="w-3 h-3 rounded-sm bg-gradient-to-t from-emerald-600 to-emerald-400 inline-block border border-emerald-300/50" />
                    {formatYearMonthShortEs(activeChartMonths[1])} (En Crecimiento ▲)
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-zinc-200">
                    <span className="w-3 h-3 rounded-sm bg-gradient-to-t from-red-700 to-red-500 inline-block border border-red-300/50" />
                    {formatYearMonthShortEs(activeChartMonths[1])} (En Bajada ▼)
                  </span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-4">
                  {activeChartMonths.map((ym, idx) => {
                    const fromEnd = activeChartMonths.length - 1 - idx;
                    const swatchClass =
                      fromEnd === 0
                        ? 'from-red-700 to-red-500 border-red-300/50'
                        : fromEnd === 1
                        ? 'from-zinc-400 to-white border-white/60'
                        : fromEnd === 2
                        ? 'from-zinc-700 to-zinc-500 border-zinc-400/40'
                        : fromEnd === 3
                        ? 'from-emerald-700 to-emerald-400 border-emerald-300/50'
                        : 'from-amber-600 to-amber-400 border-amber-300/50';
                    return (
                      <span key={ym} className="inline-flex items-center gap-1.5 text-zinc-200">
                        <span
                          className={`w-3 h-3 rounded-sm bg-gradient-to-t ${swatchClass} inline-block border`}
                        />
                        {formatYearMonthEs(ym)}
                      </span>
                    );
                  })}
                </div>
              )
            ) : (
              <div className="flex flex-wrap items-center gap-4">
                <span className="inline-flex items-center gap-1.5 text-zinc-200">
                  <span className="w-3 h-3 rounded-sm bg-gradient-to-t from-red-700 to-red-500 inline-block border border-red-300/50" />
                  Portafolio ASTURIAS
                </span>
                <span className="inline-flex items-center gap-1.5 text-zinc-200">
                  <span className="w-3 h-3 rounded-sm bg-gradient-to-t from-zinc-400 to-white inline-block border border-white/60" />
                  Portafolio VENCAMPO
                </span>
                <span className="inline-flex items-center gap-1.5 text-zinc-300">
                  <span className="w-3 h-3 rounded-sm bg-gradient-to-t from-emerald-700 to-emerald-400 inline-block border border-emerald-300/50" />
                  Total Consolidado del Mes
                </span>
              </div>
            )}

            <span className="text-[10px] font-mono text-zinc-500">
              Eje Y: Unidades desplazadas ({chartScaleMode === 'ADAPTATIVA' ? 'Escala √' : 'Escala Lineal'})
            </span>
          </div>

          {/* =============================================================== */}
          {/* MODO 1: GRÁFICA DE BARRAS VERTICALES AGRUPADAS POR PRODUCTO      */}
          {/* =============================================================== */}
          {chartGroupingMode === 'POR_PRODUCTO' ? (
            chartProductBarsData.items.length === 0 ? (
              <div className="py-12 text-center text-xs text-zinc-400 border border-dashed border-zinc-800 rounded-xl">
                No hay registros de desplazamiento para los meses y filtros seleccionados.
              </div>
            ) : (
              (() => {
                const { items, ceiling } = chartProductBarsData;
                const fractions = [1, 0.75, 0.5, 0.25, 0];
                const isTwoMonthMode = activeChartMonths.length === 2;
                const compactValues = activeChartMonths.length >= 3;
                const colMinWidth =
                  activeChartMonths.length >= 4
                    ? 'min-w-[172px]'
                    : activeChartMonths.length === 3
                    ? 'min-w-[144px]'
                    : 'min-w-[116px]';

                const computeHeightPct = (val: number): number => {
                  if (val <= 0) return 0;
                  if (chartScaleMode === 'LINEAL') {
                    return Math.max(2.5, Math.min(100, (val / ceiling) * 100));
                  }
                  return Math.max(4.5, Math.min(100, Math.sqrt(val / ceiling) * 100));
                };

                const inspectedItem =
                  items.find((it) => it.lineId === hoveredChartItemId) || items[0];

                return (
                  <div className="space-y-3">
                    <div className="overflow-x-auto pb-2">
                      <div className="min-w-[780px] flex items-stretch gap-2 pt-2">
                        {/* Columna Eje Y */}
                        <div className="w-12 shrink-0 flex flex-col">
                          {/* Espacio equivalente al badge superior de variación */}
                          <div className="h-7" />
                          {/* Ticks del área de ploteo (h-64 = 256px) */}
                          <div className="h-64 flex flex-col justify-between items-end pr-2 text-[10px] font-mono text-zinc-500 select-none">
                            {fractions.map((f) => {
                              const tickVal =
                                chartScaleMode === 'LINEAL'
                                  ? Math.round(ceiling * f)
                                  : Math.round(ceiling * f * f);
                              return (
                                <span key={f} className="leading-none">
                                  {formatAxisTickUnits(tickVal)}
                                </span>
                              );
                            })}
                          </div>
                          {/* Espacio equivalente a etiquetas del eje X */}
                          <div className="h-16" />
                        </div>

                        {/* Área de Columnas Verticales y Cuadrícula */}
                        <div className="flex-1 relative">
                          {/* Líneas guía horizontales del Eje Y */}
                          <div className="pointer-events-none absolute inset-x-0 top-7 h-64 flex flex-col justify-between">
                            {fractions.map((f) => (
                              <div
                                key={f}
                                className={`w-full border-b ${
                                  f === 0
                                    ? 'border-zinc-700'
                                    : 'border-dashed border-zinc-800/80'
                                }`}
                              />
                            ))}
                          </div>

                          {/* Columnas agrupadas por Línea de Producto */}
                          <div className="relative z-10 flex items-stretch gap-2.5">
                            {items.map((item) => {
                              const isUp = item.trend === 'UP' || item.trend === 'NEW';
                              const isDown = item.trend === 'DOWN';
                              const isHovered = inspectedItem?.lineId === item.lineId;

                              return (
                                <div
                                  key={item.lineId}
                                  onMouseEnter={() => setHoveredChartItemId(item.lineId)}
                                  onClick={() => setHoveredChartItemId(item.lineId)}
                                  className={`flex-1 ${colMinWidth} flex flex-col rounded-xl px-2 py-1 transition-colors cursor-pointer ${
                                    isHovered
                                      ? 'bg-zinc-900/75 ring-1 ring-red-500/40'
                                      : 'hover:bg-zinc-900/45'
                                  }`}
                                >
                                  {/* Badge superior de variación entre los últimos 2 meses seleccionados */}
                                  <div className="h-7 flex items-center justify-center">
                                    {activeChartMonths.length >= 2 ? (
                                      <span
                                        className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[10px] font-black font-mono border ${
                                          isUp
                                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                            : isDown
                                            ? 'bg-red-500/15 text-red-400 border-red-500/30'
                                            : 'bg-zinc-800/90 text-zinc-300 border-zinc-700'
                                        }`}
                                      >
                                        {isUp ? (
                                          <ArrowUpRight className="w-3 h-3" />
                                        ) : isDown ? (
                                          <ArrowDownRight className="w-3 h-3" />
                                        ) : (
                                          <Minus className="w-3 h-3" />
                                        )}
                                        {item.deltaPct === null
                                          ? 'NUEVO'
                                          : `${item.deltaPct >= 0 ? '+' : ''}${item.deltaPct.toFixed(1)}%`}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] font-mono font-bold text-zinc-400">
                                        {item.lastVol.toLocaleString('es-VE')} u
                                      </span>
                                    )}
                                  </div>

                                  {/* Contenedor vertical de barras (h-64) anclado a la base 0 */}
                                  <div className="h-64 flex items-end justify-center gap-1.5 pt-5 px-1">
                                    {item.monthValues.map((mv, mIdx) => {
                                      const barHeightPct = computeHeightPct(mv.units);
                                      const fromEnd = item.monthValues.length - 1 - mIdx;

                                      let barColorClass =
                                        'bg-gradient-to-t from-zinc-700 via-zinc-500 to-zinc-400 border-t border-zinc-300/60';
                                      let valueTextClass = 'text-zinc-400';

                                      if (isTwoMonthMode) {
                                        if (mIdx === 1) {
                                          if (isUp) {
                                            barColorClass =
                                              'bg-gradient-to-t from-emerald-700 via-emerald-500 to-emerald-400 border-t border-emerald-200/80 shadow-[0_0_14px_rgba(16,185,129,0.22)]';
                                            valueTextClass = 'text-emerald-300 font-black';
                                          } else if (isDown) {
                                            barColorClass =
                                              'bg-gradient-to-t from-red-800 via-red-600 to-red-500 border-t border-red-200/80 shadow-[0_0_14px_rgba(220,38,38,0.25)]';
                                            valueTextClass = 'text-red-300 font-black';
                                          } else {
                                            barColorClass =
                                              'bg-gradient-to-t from-zinc-400 via-zinc-200 to-white border-t border-white';
                                            valueTextClass = 'text-white font-black';
                                          }
                                        }
                                      } else {
                                        if (fromEnd === 0) {
                                          barColorClass =
                                            'bg-gradient-to-t from-red-800 via-red-600 to-red-400 border-t border-red-200/80 shadow-[0_0_14px_rgba(220,38,38,0.25)]';
                                          valueTextClass = 'text-white font-black';
                                        } else if (fromEnd === 1) {
                                          barColorClass =
                                            'bg-gradient-to-t from-zinc-400 via-zinc-200 to-white border-t border-white';
                                          valueTextClass = 'text-zinc-200 font-bold';
                                        } else if (fromEnd === 2) {
                                          barColorClass =
                                            'bg-gradient-to-t from-zinc-700 via-zinc-500 to-zinc-400 border-t border-zinc-300/50';
                                          valueTextClass = 'text-zinc-400';
                                        } else if (fromEnd === 3) {
                                          barColorClass =
                                            'bg-gradient-to-t from-emerald-700 via-emerald-500 to-emerald-400 border-t border-emerald-200/70';
                                          valueTextClass = 'text-emerald-300';
                                        } else {
                                          barColorClass =
                                            'bg-gradient-to-t from-amber-700 via-amber-500 to-amber-300 border-t border-amber-200/70';
                                          valueTextClass = 'text-amber-300';
                                        }
                                      }

                                      return (
                                        <div
                                          key={mv.ym}
                                          className="flex-1 max-w-[38px] h-full flex flex-col items-center justify-end group/bar"
                                          title={`${item.productLine} • ${mv.shortMonth}: ${mv.units.toLocaleString('es-VE')} ${item.unitLabel} (${mv.pdvCount} PDVs)`}
                                        >
                                          <span
                                            className={`text-[9.5px] font-mono leading-none mb-1 whitespace-nowrap ${valueTextClass}`}
                                          >
                                            {formatCompactBarValue(mv.units, compactValues)}
                                          </span>
                                          {mv.units > 0 ? (
                                            <div
                                              className={`w-full rounded-t-md transition-all duration-500 group-hover/bar:brightness-110 ${barColorClass}`}
                                              style={{ height: `${barHeightPct}%` }}
                                            />
                                          ) : (
                                            <div className="w-full h-[3px] rounded-t bg-zinc-800" />
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>

                                  {/* Etiqueta del Eje X: Marca + Nombre de Producto */}
                                  <div className="h-16 pt-2 flex flex-col items-center justify-start text-center">
                                    <span
                                      className={`text-[8.5px] font-black px-1.5 py-0.2 rounded border mb-1 ${
                                        item.brand === 'ASTURIAS'
                                          ? 'bg-red-600/15 text-red-400 border-red-500/30'
                                          : 'bg-zinc-800 text-zinc-200 border-zinc-700'
                                      }`}
                                    >
                                      {item.brand}
                                    </span>
                                    <span
                                      className="text-[10.5px] font-bold text-zinc-200 leading-tight line-clamp-2"
                                      title={item.productLine}
                                    >
                                      {item.shortLabel}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Barra Inspectora de Detalle del Producto Activo / Seleccionado */}
                    {inspectedItem && (
                      <div className="p-3 rounded-xl bg-zinc-900/90 border border-zinc-800 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[9px] font-black px-2 py-0.5 rounded border ${
                              inspectedItem.brand === 'ASTURIAS'
                                ? 'bg-red-600/15 text-red-400 border-red-500/30'
                                : 'bg-zinc-800 text-zinc-200 border-zinc-700'
                            }`}
                          >
                            {inspectedItem.brand}
                          </span>
                          <span className="font-black text-white">{inspectedItem.productLine}</span>
                          <span className="text-[11px] text-zinc-400">
                            ({inspectedItem.unitLabel})
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
                          {inspectedItem.monthValues.map((mv) => (
                            <span
                              key={mv.ym}
                              className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-200"
                            >
                              <strong className="text-zinc-400">{mv.shortMonth}:</strong>{' '}
                              <strong className="text-white">
                                {mv.units.toLocaleString('es-VE')}
                              </strong>{' '}
                              <span className="text-[10px] text-zinc-500">
                                ({mv.pdvCount} PDVs)
                              </span>
                            </span>
                          ))}
                          {activeChartMonths.length >= 2 && (
                            <span
                              className={`px-2.5 py-1 rounded-lg font-black border ${
                                inspectedItem.trend === 'UP' || inspectedItem.trend === 'NEW'
                                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                  : inspectedItem.trend === 'DOWN'
                                  ? 'bg-red-500/15 text-red-400 border-red-500/30'
                                  : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                              }`}
                            >
                              Δ {inspectedItem.deltaUnits >= 0 ? '+' : ''}
                              {inspectedItem.deltaUnits.toLocaleString('es-VE')} unid. (
                              {inspectedItem.deltaPct === null
                                ? 'NUEVO'
                                : `${inspectedItem.deltaPct >= 0 ? '+' : ''}${inspectedItem.deltaPct.toFixed(1)}%`}
                              )
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()
            )
          ) : (
            /* =============================================================== */
            /* MODO 2: GRÁFICA DE BARRAS VERTICALES CONSOLIDADA POR MES         */
            /* =============================================================== */
            (() => {
              const { items, ceiling } = chartMonthlyBarsData;
              const fractions = [1, 0.75, 0.5, 0.25, 0];

              const computeHeightPct = (val: number): number => {
                if (val <= 0) return 0;
                if (chartScaleMode === 'LINEAL') {
                  return Math.max(2.5, Math.min(100, (val / ceiling) * 100));
                }
                return Math.max(4.5, Math.min(100, Math.sqrt(val / ceiling) * 100));
              };

              return (
                <div className="overflow-x-auto pb-2">
                  <div className="min-w-[540px] flex items-stretch gap-3 pt-2">
                    {/* Eje Y */}
                    <div className="w-12 shrink-0 flex flex-col">
                      <div className="h-7" />
                      <div className="h-64 flex flex-col justify-between items-end pr-2 text-[10px] font-mono text-zinc-500 select-none">
                        {fractions.map((f) => {
                          const tickVal =
                            chartScaleMode === 'LINEAL'
                              ? Math.round(ceiling * f)
                              : Math.round(ceiling * f * f);
                          return (
                            <span key={f} className="leading-none">
                              {formatAxisTickUnits(tickVal)}
                            </span>
                          );
                        })}
                      </div>
                      <div className="h-14" />
                    </div>

                    {/* Columnas por cada Mes Seleccionado */}
                    <div className="flex-1 relative">
                      <div className="pointer-events-none absolute inset-x-0 top-7 h-64 flex flex-col justify-between">
                        {fractions.map((f) => (
                          <div
                            key={f}
                            className={`w-full border-b ${
                              f === 0 ? 'border-zinc-700' : 'border-dashed border-zinc-800/80'
                            }`}
                          />
                        ))}
                      </div>

                      <div className="relative z-10 flex items-stretch justify-around gap-4">
                        {items.map((mItem) => {
                          const astPct = computeHeightPct(mItem.asturiasUnits);
                          const venPct = computeHeightPct(mItem.vencampoUnits);
                          const totPct = computeHeightPct(mItem.totalUnits);

                          return (
                            <div
                              key={mItem.ym}
                              className="flex-1 max-w-[240px] flex flex-col rounded-xl px-3 py-1 bg-zinc-900/35 hover:bg-zinc-900/70 transition-colors"
                            >
                              <div className="h-7 flex items-center justify-center">
                                {mItem.momPct !== null ? (
                                  <span
                                    className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[10px] font-black font-mono border ${
                                      mItem.momPct >= 0
                                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                        : 'bg-red-500/15 text-red-400 border-red-500/30'
                                    }`}
                                  >
                                    {mItem.momPct >= 0 ? (
                                      <ArrowUpRight className="w-3 h-3" />
                                    ) : (
                                      <ArrowDownRight className="w-3 h-3" />
                                    )}
                                    {mItem.momPct >= 0 ? '+' : ''}
                                    {mItem.momPct.toFixed(1)}% vs mes ant.
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-mono text-zinc-400">
                                    Mes inicial seleccionado
                                  </span>
                                )}
                              </div>

                              <div className="h-64 flex items-end justify-center gap-2.5 pt-5 px-2">
                                {brandFilter !== 'VENCAMPO' && (
                                  <div className="flex-1 max-w-[44px] h-full flex flex-col items-center justify-end">
                                    <span className="text-[10px] font-mono font-bold text-red-300 mb-1">
                                      {mItem.asturiasUnits.toLocaleString('es-VE')}
                                    </span>
                                    {mItem.asturiasUnits > 0 ? (
                                      <div
                                        className="w-full rounded-t-md bg-gradient-to-t from-red-800 via-red-600 to-red-400 border-t border-red-200/80 transition-all duration-500"
                                        style={{ height: `${astPct}%` }}
                                      />
                                    ) : (
                                      <div className="w-full h-[3px] rounded-t bg-zinc-800" />
                                    )}
                                  </div>
                                )}

                                {brandFilter !== 'ASTURIAS' && (
                                  <div className="flex-1 max-w-[44px] h-full flex flex-col items-center justify-end">
                                    <span className="text-[10px] font-mono font-bold text-zinc-200 mb-1">
                                      {mItem.vencampoUnits.toLocaleString('es-VE')}
                                    </span>
                                    {mItem.vencampoUnits > 0 ? (
                                      <div
                                        className="w-full rounded-t-md bg-gradient-to-t from-zinc-500 via-zinc-300 to-white border-t border-white transition-all duration-500"
                                        style={{ height: `${venPct}%` }}
                                      />
                                    ) : (
                                      <div className="w-full h-[3px] rounded-t bg-zinc-800" />
                                    )}
                                  </div>
                                )}

                                {brandFilter === 'TODAS' && (
                                  <div className="flex-1 max-w-[48px] h-full flex flex-col items-center justify-end">
                                    <span className="text-[10px] font-mono font-black text-emerald-300 mb-1">
                                      {mItem.totalUnits.toLocaleString('es-VE')}
                                    </span>
                                    {mItem.totalUnits > 0 ? (
                                      <div
                                        className="w-full rounded-t-md bg-gradient-to-t from-emerald-800 via-emerald-500 to-emerald-400 border-t border-emerald-200/80 shadow-[0_0_14px_rgba(16,185,129,0.22)] transition-all duration-500"
                                        style={{ height: `${totPct}%` }}
                                      />
                                    ) : (
                                      <div className="w-full h-[3px] rounded-t bg-zinc-800" />
                                    )}
                                  </div>
                                )}
                              </div>

                              <div className="h-14 pt-2 flex flex-col items-center justify-start text-center">
                                <span className="text-xs font-black text-white">
                                  {mItem.fullMonth}
                                </span>
                                <span className="text-[10px] font-mono text-zinc-400">
                                  {mItem.pdvCount} PDVs • {mItem.totalSamples.toLocaleString('es-VE')} muestras
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </div>

        {/* Tabla Detallada de Evaluación Mes a Mes */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-950 border-b border-zinc-800 text-[10px] font-black text-zinc-400 uppercase tracking-wider">
                <th className="py-3 px-4">Producto / Línea Comercial</th>
                <th className="py-3 px-3 text-right">Vol. {formatYearMonthShortEs(selectedBaseMonth)}</th>
                <th className="py-3 px-3 text-right">Vol. {formatYearMonthShortEs(selectedEvalMonth)}</th>
                <th className="py-3 px-3 text-right">Var. Neta</th>
                <th className="py-3 px-3 text-center">Crecimiento / Bajada</th>
                <th className="py-3 px-3 text-center">PDVs Activos</th>
                <th className="py-3 px-3 text-right">Muestras Impulso</th>
                <th className="py-3 px-3 text-right">Precio vs Comp.</th>
                <th className="py-3 px-4">Diagnóstico de Mercado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70 text-xs">
              {filteredProductRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-zinc-400">
                    No se encontraron líneas de producto para los criterios seleccionados.
                  </td>
                </tr>
              ) : (
                filteredProductRows.map((row) => {
                  const isUp = row.trend === 'UP' || row.trend === 'NEW';
                  const isDown = row.trend === 'DOWN';
                  return (
                    <tr
                      key={row.lineId}
                      className="bg-zinc-900/40 hover:bg-zinc-800/50 transition-colors"
                    >
                      <td className="py-3 px-4">
                        <div className="font-bold text-white">{row.productLine}</div>
                        <div className="text-[10px] text-zinc-400 flex items-center gap-1.5 mt-0.5">
                          <span className="font-bold text-red-400">{row.brand}</span>
                          <span>•</span>
                          <span>{row.unitLabel}</span>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-zinc-300">
                        {row.prevVol.toLocaleString('es-VE')}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-black text-white">
                        {row.currVol.toLocaleString('es-VE')}
                      </td>
                      <td
                        className={`py-3 px-3 text-right font-mono font-bold ${
                          isUp ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-zinc-400'
                        }`}
                      >
                        {row.deltaUnits >= 0 ? '+' : ''}
                        {row.deltaUnits.toLocaleString('es-VE')}
                      </td>
                      <td className="py-3 px-3 text-center">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-black font-mono border ${
                            isUp
                              ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                              : isDown
                              ? 'bg-red-500/15 text-red-400 border-red-500/30'
                              : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                          }`}
                        >
                          {isUp ? '▲' : isDown ? '▼' : '•'}{' '}
                          {row.deltaPct === null
                            ? 'EXPANSIÓN'
                            : `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}%`}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-center font-mono text-zinc-300">
                        <span className="text-zinc-500">{row.prevPdvCount}</span> →{' '}
                        <strong className="text-white">{row.currPdvCount}</strong>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-zinc-300">
                        {row.currSamples.toLocaleString('es-VE')}
                        {row.currActivations > 0 && (
                          <span className="block text-[10px] text-zinc-500">
                            {row.currActivations} activ.
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono">
                        {row.avgOwnPriceUsd > 0 ? (
                          <div>
                            <span className="text-white font-bold">${row.avgOwnPriceUsd.toFixed(2)}</span>
                            {row.avgCompPriceUsd > 0 && (
                              <span
                                className={`block text-[10px] ${
                                  (row.priceGapPct || 0) <= 0 ? 'text-emerald-400' : 'text-red-400'
                                }`}
                              >
                                vs ${row.avgCompPriceUsd.toFixed(2)} (
                                {(row.priceGapPct || 0) >= 0 ? '+' : ''}
                                {(row.priceGapPct || 0).toFixed(1)}%)
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-zinc-500 text-[11px]">S/D</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[11px] text-zinc-300 max-w-xs">
                        {row.diagnosis}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* SECCIÓN B: COSTOS POR SEMANA DE SOLICITUDES TRADE -> CONTRALORÍA      */}
      {/* ===================================================================== */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-600"></span>
              <span className="text-[11px] font-black text-red-400 uppercase tracking-widest">
                Control Financiero Semanal · Trade Marketing → Contraloría
              </span>
            </div>
            <h3 className="text-lg font-black text-white mt-0.5">
              Costos por Semana de Solicitudes de Trade Marketing a Contraloría ({formatYearMonthEs(selectedEvalMonth)})
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Desglose semanal (Semanas 1 a 5) integrando actas formales de requisición (<code className="text-red-400">MP-*</code>) y solicitudes operativas de insumos BTL para degustaciones.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Selector de criterio de consolidación */}
            <div className="inline-flex rounded-xl bg-zinc-950 p-1 border border-zinc-800">
              <button
                type="button"
                onClick={() => setCostViewMode('CONSOLIDADO')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  costViewMode === 'CONSOLIDADO'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Consolidado Semanal BTL
              </button>
              <button
                type="button"
                onClick={() => setCostViewMode('SOLO_ACTAS_MP')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  costViewMode === 'SOLO_ACTAS_MP'
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Solo Actas Formales (MP-*)
              </button>
            </div>

            <button
              type="button"
              onClick={() => openNewRequisitionModal()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold transition-all shadow-sm cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nueva Solicitud MP</span>
            </button>
          </div>
        </div>

        {/* 4 Tarjetas KPI de Costos Semanales */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Costo Total Solicitudes ({formatYearMonthShortEs(selectedEvalMonth)})
              </span>
              <span className="p-1.5 rounded-lg bg-red-600/15 text-red-400 border border-red-500/30">
                <DollarSign className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-white font-mono">
              ${weeklyCostSummary.totalEvalMonthCost.toFixed(2)}{' '}
              <span className="text-xs font-normal text-zinc-400">USD</span>
            </div>
            <span className="text-[11px] text-zinc-400 mt-1.5 block">
              {weeklyCostSummary.momCostDeltaPct !== null ? (
                <>
                  <strong
                    className={
                      weeklyCostSummary.momCostDeltaPct <= 0 ? 'text-emerald-400' : 'text-red-400'
                    }
                  >
                    {weeklyCostSummary.momCostDeltaPct >= 0 ? '+' : ''}
                    {weeklyCostSummary.momCostDeltaPct.toFixed(1)}%
                  </strong>{' '}
                  vs {formatYearMonthShortEs(selectedBaseMonth)} ($
                  {weeklyCostSummary.totalBaseMonthCost.toFixed(2)})
                </>
              ) : (
                `Base anterior (${formatYearMonthShortEs(selectedBaseMonth)}): $${weeklyCostSummary.totalBaseMonthCost.toFixed(2)}`
              )}
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Costo Promedio por Semana
              </span>
              <span className="p-1.5 rounded-lg bg-zinc-900 text-zinc-200 border border-zinc-800">
                <Calendar className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-white font-mono">
              ${weeklyCostSummary.avgWeeklyCost.toFixed(2)}{' '}
              <span className="text-xs font-normal text-zinc-400">USD/sem</span>
            </div>
            <span className="text-[11px] text-zinc-400 mt-1.5 block">
              Calculado sobre {weeklyCostSummary.activeWeeksCount} de 5 semanas con actividad
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Semana de Mayor Solicitud
              </span>
              <span className="p-1.5 rounded-lg bg-red-600/15 text-red-400 border border-red-500/30">
                <BarChart3 className="w-4 h-4" />
              </span>
            </div>
            <div className="text-xl font-black text-red-400 font-mono">
              {weeklyCostSummary.peakWeek && weeklyCostSummary.peakWeek.consolidatedCostUsd > 0
                ? `${weeklyCostSummary.peakWeek.weekLabel}: $${weeklyCostSummary.peakWeek.consolidatedCostUsd.toFixed(2)}`
                : 'Sin costos registrados'}
            </div>
            <span className="text-[11px] text-zinc-400 mt-1.5 block">
              {weeklyCostSummary.peakWeek && weeklyCostSummary.peakWeek.consolidatedCostUsd > 0
                ? `${weeklyCostSummary.peakWeek.rangeLabel} (${weeklyCostSummary.peakWeek.shareOfMonthPct.toFixed(1)}% del mes)`
                : 'Cambie a vista consolidada o radique un acta'}
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/90">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">
                Actas Formales Contraloría
              </span>
              <span className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Building2 className="w-4 h-4" />
              </span>
            </div>
            <div className="text-2xl font-black text-white font-mono">
              ${weeklyCostSummary.totalFormalCost.toFixed(2)}{' '}
              <span className="text-xs font-normal text-zinc-400">({weeklyCostSummary.totalFormalCount} actas)</span>
            </div>
            <span className="text-[11px] text-zinc-400 mt-1.5 block">
              Solicitudes operativas campo: ${weeklyCostSummary.totalFieldCost.toFixed(2)} USD
            </span>
          </div>
        </div>

        {/* Gráfico Visual de Barras Verticales por Semana (Semana 1 a Semana 5) */}
        <div className="p-5 rounded-xl bg-zinc-950/90 border border-zinc-800/90">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-5">
            <h4 className="text-xs font-black text-white uppercase tracking-wider">
              Distribución Semanal de Costos de Solicitudes ({formatYearMonthEs(selectedEvalMonth)})
            </h4>
            <div className="flex flex-wrap items-center gap-4 text-[11px]">
              <span className="inline-flex items-center gap-1.5 text-zinc-300">
                <span className="w-3 h-2.5 rounded-sm bg-red-600 inline-block"></span>
                Acta Formal Contraloría (MP-*)
              </span>
              <span className="inline-flex items-center gap-1.5 text-zinc-300">
                <span className="w-3 h-2.5 rounded-sm bg-zinc-400 inline-block"></span>
                Solicitudes Campo Trade (Por consolidar en Acta MP)
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
            {weeklyCostRows.map((w) => {
              const barPct =
                w.consolidatedCostUsd > 0
                  ? Math.max(10, Math.round((w.consolidatedCostUsd / weeklyCostSummary.maxWeekBar) * 100))
                  : 4;
              const hasFormal = w.formalCostUsd > 0;

              return (
                <div
                  key={w.weekNumber}
                  className="p-3.5 rounded-xl bg-zinc-900/70 border border-zinc-800/90 flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-black text-white">{w.weekLabel}</span>
                    {w.wowDeltaPct !== null && (
                      <span
                        className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                          w.wowDeltaPct <= 0
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-red-500/15 text-red-400'
                        }`}
                      >
                        {w.wowDeltaPct >= 0 ? '+' : ''}
                        {w.wowDeltaPct.toFixed(0)}%
                      </span>
                    )}
                  </div>

                  {/* Contenedor vertical de barra */}
                  <div className="h-28 flex items-end justify-center py-2 bg-zinc-950/80 rounded-lg border border-zinc-800/60 px-4">
                    <div className="w-full flex flex-col items-center justify-end h-full">
                      <span className="text-[11px] font-mono font-black text-white mb-1">
                        ${w.consolidatedCostUsd.toFixed(0)}
                      </span>
                      <div
                        className={`w-full max-w-[44px] rounded-t-md transition-all duration-500 ${
                          w.consolidatedCostUsd === 0
                            ? 'bg-zinc-800'
                            : hasFormal
                            ? 'bg-gradient-to-t from-red-700 to-red-500 shadow-lg shadow-red-950/50'
                            : 'bg-gradient-to-t from-zinc-500 to-zinc-300'
                        }`}
                        style={{ height: `${barPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="mt-2.5 text-center">
                    <span className="text-[10px] text-zinc-400 block">{w.rangeLabel}</span>
                    <span
                      className={`mt-1 inline-block text-[9px] font-bold px-2 py-0.5 rounded uppercase ${
                        hasFormal
                          ? 'bg-red-600/20 text-red-300 border border-red-500/30'
                          : w.consolidatedCostUsd > 0
                          ? 'bg-zinc-800 text-zinc-200 border border-zinc-700'
                          : 'text-zinc-500'
                      }`}
                    >
                      {hasFormal
                        ? w.formalCodes.join(', ')
                        : w.fieldRequestsCount > 0
                        ? `${w.fieldRequestsCount} solic. BTL`
                        : 'Sin gasto'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Tabla Detallada de Costos por Semana y Trazabilidad Contraloría */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-950 border-b border-zinc-800 text-[10px] font-black text-zinc-400 uppercase tracking-wider">
                <th className="py-3 px-4">Semana / Rango</th>
                <th className="py-3 px-3">Códigos MP / Solicitudes Trade</th>
                <th className="py-3 px-3 text-right">Insumos / Unid.</th>
                <th className="py-3 px-3 text-right">Actas Contraloría</th>
                <th className="py-3 px-3 text-right">Solic. Campo BTL</th>
                <th className="py-3 px-3 text-right">Costo Semanal Total</th>
                <th className="py-3 px-3 text-center">Var. Semanal</th>
                <th className="py-3 px-4 text-right">Estado / Acción Contraloría</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70 text-xs">
              {weeklyCostRows.map((w) => (
                <tr
                  key={w.weekNumber}
                  className="bg-zinc-900/40 hover:bg-zinc-800/50 transition-colors"
                >
                  <td className="py-3.5 px-4">
                    <div className="font-black text-white">{w.weekLabel}</div>
                    <div className="text-[10px] text-zinc-400 font-mono">{w.rangeLabel}</div>
                  </td>

                  <td className="py-3.5 px-3">
                    {w.formalCodes.length > 0 ? (
                      <div className="space-y-1">
                        <div className="flex flex-wrap gap-1">
                          {w.formalCodes.map((code) => (
                            <span
                              key={code}
                              className="text-[10px] font-mono font-black px-2 py-0.5 rounded bg-red-600/20 text-red-300 border border-red-500/30"
                            >
                              {code}
                            </span>
                          ))}
                        </div>
                        <div className="text-[10px] text-zinc-400 truncate max-w-xs">
                          {w.formalCampaigns[0]}
                        </div>
                      </div>
                    ) : w.fieldRequestsCount > 0 ? (
                      <div>
                        <span className="font-semibold text-zinc-200">
                          {w.fieldRequestsCount} solicitudes operativas de degustación
                        </span>
                        {w.topFieldProducts.length > 0 && (
                          <span className="block text-[10px] text-zinc-400 truncate max-w-xs">
                            Foco: {w.topFieldProducts.join(' • ')}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-zinc-500 text-[11px]">Sin requerimientos en esta semana</span>
                    )}
                  </td>

                  <td className="py-3.5 px-3 text-right font-mono text-zinc-200">
                    {w.totalUnitsConsolidated > 0 ? `${w.totalUnitsConsolidated} un` : '0 un'}
                  </td>

                  <td className="py-3.5 px-3 text-right font-mono text-zinc-300">
                    ${w.formalCostUsd.toFixed(2)}
                  </td>

                  <td className="py-3.5 px-3 text-right font-mono text-zinc-400">
                    ${w.fieldCostUsd.toFixed(2)}
                  </td>

                  <td className="py-3.5 px-3 text-right font-mono">
                    <span className="text-sm font-black text-white">
                      ${w.consolidatedCostUsd.toFixed(2)}
                    </span>
                    {w.shareOfMonthPct > 0 && (
                      <span className="block text-[10px] text-zinc-400">
                        {w.shareOfMonthPct.toFixed(1)}% del mes
                      </span>
                    )}
                  </td>

                  <td className="py-3.5 px-3 text-center font-mono">
                    {w.wowDeltaPct === null ? (
                      <span className="text-[10px] text-zinc-500">—</span>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-bold ${
                          w.wowDeltaPct <= 0
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-red-500/15 text-red-400'
                        }`}
                      >
                        {w.wowDeltaPct >= 0 ? '▲ +' : '▼ '}
                        {w.wowDeltaPct.toFixed(1)}%
                      </span>
                    )}
                  </td>

                  <td className="py-3.5 px-4 text-right">
                    {w.governanceStatus === 'APROBADO_CONTRALORIA' && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                        <CheckCircle2 className="w-3 h-3" />
                        APROBADO CONTRALORÍA
                      </span>
                    )}
                    {w.governanceStatus === 'EN_VALIDACION' && (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        <Clock className="w-3 h-3" />
                        EN VALIDACIÓN MP
                      </span>
                    )}
                    {w.governanceStatus === 'POR_FORMALIZAR_ACTA' && (
                      <button
                        type="button"
                        onClick={() => openNewRequisitionModal(w)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold bg-zinc-800 hover:bg-red-600 text-white border border-zinc-700 hover:border-red-500 transition-all cursor-pointer"
                        title="Generar Acta Formal MP-* en Contraloría con los costos de esta semana"
                      >
                        <FileSpreadsheet className="w-3 h-3" />
                        Formalizar Acta MP
                      </button>
                    )}
                    {w.governanceStatus === 'SIN_SOLICITUDES' && (
                      <span className="text-[10px] text-zinc-500">Sin actividad</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-zinc-950 border-t-2 border-red-600/60 text-xs font-black text-white">
                <td className="py-3.5 px-4" colSpan={2}>
                  TOTAL MENSUAL SOLICITUDES TRADE MARKETING ({formatYearMonthEs(selectedEvalMonth).toUpperCase()})
                </td>
                <td className="py-3.5 px-3 text-right font-mono">
                  {weeklyCostRows.reduce((s, w) => s + w.totalUnitsConsolidated, 0)} un
                </td>
                <td className="py-3.5 px-3 text-right font-mono text-zinc-200">
                  ${weeklyCostSummary.totalFormalCost.toFixed(2)}
                </td>
                <td className="py-3.5 px-3 text-right font-mono text-zinc-300">
                  ${weeklyCostSummary.totalFieldCost.toFixed(2)}
                </td>
                <td className="py-3.5 px-3 text-right font-mono text-red-400 text-sm">
                  ${weeklyCostSummary.totalEvalMonthCost.toFixed(2)} USD
                </td>
                <td className="py-3.5 px-3 text-center font-mono text-[11px] text-zinc-400">
                  100%
                </td>
                <td className="py-3.5 px-4 text-right text-[10px] text-emerald-400 uppercase">
                  Trazabilidad Sincronizada
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Detalle de Actas Formales MP-* radicadas en el mes */}
        {monthFormalRequisitions.length > 0 && (
          <div className="pt-2">
            <h4 className="text-[11px] font-black text-zinc-400 uppercase tracking-wider mb-2.5">
              Actas Formales Radicadas en Contraloría en {formatYearMonthEs(selectedEvalMonth)} ({monthFormalRequisitions.length})
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {monthFormalRequisitions.map((req) => {
                const p = parseAnyRecordDate(req.requestDate);
                return (
                  <div
                    key={req.id}
                    className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-black text-red-400">
                          {req.requestCode}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-400">
                          {req.requestDate} {p ? `• Semana ${p.weekNumber}` : ''}
                        </span>
                      </div>
                      <p className="text-xs font-bold text-white truncate mt-0.5">
                        {req.campaignOrPurpose}
                      </p>
                      <span className="text-[10px] text-zinc-400 block">
                        Solicitante: {req.applicantName} • {req.totalUnits} unid.
                      </span>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-black font-mono text-white">
                        ${req.estimatedCostUsd.toFixed(2)} USD
                      </div>
                      <span className="text-[10px] text-zinc-400 font-mono block">
                        Tope: ${req.approvedBudgetCapUsd.toFixed(0)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* SECCIÓN C: RESUMEN DE KPIs OPERATIVOS, IMPULSO Y GOBERNANZA           */}
      {/* ===================================================================== */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-red-500" />
          <h3 className="text-xs font-black text-white uppercase tracking-wider">
            Indicadores Integrales de Operación, Impulso y Gobernanza ({formatYearMonthShortEs(selectedEvalMonth)})
          </h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-400 font-semibold">Cumplimiento de Ruta</span>
              <Target className="w-4 h-4 text-red-400" />
            </div>
            <div className="text-2xl font-black text-white font-mono">{routeCompliancePct}%</div>
            <div className="w-full bg-zinc-950 h-1.5 rounded-full mt-2 overflow-hidden border border-zinc-800">
              <div
                className="bg-red-600 h-full rounded-full"
                style={{ width: `${routeCompliancePct}%` }}
              />
            </div>
            <span className="text-[10px] text-zinc-400 mt-1.5 block">
              {completedOrInProgress} de {totalVisits} activaciones ejecutadas
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-400 font-semibold">Impactos de Degustación</span>
              <Users className="w-4 h-4 text-zinc-200" />
            </div>
            <div className="text-2xl font-black text-white font-mono">
              {totalContacts.toLocaleString('es-VE')}
            </div>
            <span className="text-[10px] text-zinc-400 mt-1.5 block">
              Consumidores impactados • CR: {avgConversionRate}%
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-400 font-semibold">Costo por Contacto (CPC)</span>
              <ShoppingBag className="w-4 h-4 text-red-400" />
            </div>
            <div className="text-2xl font-black text-white font-mono">${avgCpc}</div>
            <span className="text-[10px] text-zinc-400 mt-1.5 block">
              Inversión semanal BTL / muestras entregadas
            </span>
          </div>

          <div className="p-4 rounded-xl bg-zinc-900/80 border border-zinc-800 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-400 font-semibold">Ejecución Presupuestaria MP</span>
              <Award className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-xl font-black text-white font-mono">
              ${totalExecutedBudget.toFixed(0)} / ${totalApprovedBudget.toFixed(0)}
            </div>
            <span className="text-[10px] text-zinc-400 mt-1.5 block">
              {budgetExecutionPct}% ejecutado sobre tope aprobado Contraloría
            </span>
          </div>
        </div>
      </div>

      {/* MODAL PARA RADICAR NUEVA SOLICITUD SEMANAL A CONTRALORÍA */}
      {isReqModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <span className="text-[10px] font-black text-red-400 uppercase tracking-widest">
                  Trade Marketing → Contraloría
                </span>
                <h3 className="text-base font-black text-white">
                  Radicar Solicitud Semanal de Insumos / Costos BTL
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsReqModalOpen(false)}
                className="p-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateWeeklyRequisition} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                    Código Acta (MP)
                  </label>
                  <input
                    type="text"
                    required
                    value={reqFormCode}
                    onChange={(e) => setReqFormCode(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                    Fecha de Solicitud (Define Semana)
                  </label>
                  <input
                    type="date"
                    required
                    value={reqFormDate}
                    onChange={(e) => setReqFormDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                  Campaña / Propósito Semanal
                </label>
                <input
                  type="text"
                  required
                  value={reqFormPurpose}
                  onChange={(e) => setReqFormPurpose(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                  Producto / Insumo Solicitado
                </label>
                <input
                  type="text"
                  required
                  value={reqFormProduct}
                  onChange={(e) => setReqFormProduct(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-zinc-300 mb-1">Cantidad</label>
                  <input
                    type="number"
                    min={1}
                    step="1"
                    required
                    value={reqFormQty}
                    onChange={(e) => setReqFormQty(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                    Costo Unit. (USD)
                  </label>
                  <input
                    type="number"
                    min={0.1}
                    step="0.01"
                    required
                    value={reqFormUnitCost}
                    onChange={(e) => setReqFormUnitCost(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                    Tope Partida (USD)
                  </label>
                  <input
                    type="number"
                    min={1}
                    step="1"
                    required
                    value={reqFormBudgetCap}
                    onChange={(e) => setReqFormBudgetCap(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 items-center pt-1">
                <div>
                  <label className="block text-[11px] font-bold text-zinc-300 mb-1">
                    Estado Contraloría
                  </label>
                  <select
                    value={reqFormStatus}
                    onChange={(e) => setReqFormStatus(e.target.value as RequisitionStatus)}
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                  >
                    <option value="APROBADO_CONTRALORIA">Aprobado Contraloría</option>
                    <option value="VALIDACION_COMERCIAL">En Validación Comercial</option>
                    <option value="REVISION_FINANCIERA">En Revisión Financiera</option>
                  </select>
                </div>

                <div className="p-3 rounded-xl bg-zinc-950 border border-red-500/40 text-right">
                  <span className="text-[10px] text-zinc-400 uppercase block font-bold">
                    Costo Semanal a Radicar
                  </span>
                  <span className="text-lg font-black text-red-400 font-mono">
                    ${((Number(reqFormQty) || 0) * (Number(reqFormUnitCost) || 0)).toFixed(2)} USD
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsReqModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-zinc-800 text-zinc-300 hover:text-white font-bold cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold shadow-md cursor-pointer"
                >
                  Guardar Solicitud Semanal
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bloque oficial de firmas para soporte impreso / PDF */}
      <PrintSignatureBlock />
    </div>
  );
};
