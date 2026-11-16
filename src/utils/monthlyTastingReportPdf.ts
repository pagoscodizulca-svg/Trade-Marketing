import type jsPDF from 'jspdf';
import type { TastingScheduleItem } from '../components/field/FieldPromotoraView';
import { getTodayVeYmd } from '../services/supabaseModule1';
import { getDynamicWeekNumberInMonth, getMonthCalendarWeeks } from './weekCalendar';

// Carga diferida de jsPDF y jsPDF-AutoTable para mantener ligero el bundle inicial
const loadPdfLibs = async () => {
  const [{ default: jsPDFConstructor }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  return { jsPDF: jsPDFConstructor, autoTable };
};

export type MonthlyReportScope = 'all' | 'archived_only';

export interface GlobalTastingReportOptions {
  /** Si se indica YYYY-MM (ej. '2026-10'), acota a ese mes. Si es 'TODOS' o undefined, procesa todos los meses presentes en los ítems filtrados. */
  targetYearMonth?: string;
  /** Resumen textual del filtro activo aplicado en pantalla */
  filterSummaryLabel?: string;
  /** Sufijo limpio para el nombre del archivo PDF */
  fileSuffix?: string;
  scope?: MonthlyReportScope;
}

export interface PlanningWeekColumn {
  key: string;
  year: number;
  monthIndex: number;
  monthName: string;
  weekNumber: number;
  weekLabel: string;
  shortHeader: string;
  rangeLabel: string;
  totalCount: number;
  archivedCount: number;
  activeCount: number;
  totalDelivered: number;
  totalTarget: number;
  avgAcceptance: number;
  sellersCount: number;
  sellerBreakdownLabel: string;
}

export interface NormalizedReportDegustacion {
  id: string;
  vendedor: string;
  client: string;
  zone: string;
  product: string;
  promoter: string;
  time: string;
  status: 'completed' | 'cancelled' | 'in_progress' | 'scheduled';
  delivered: number;
  target: number;
  acceptanceRate: number;
  comments: string;
}

export interface ReportDegustacionEntry {
  item: NormalizedReportDegustacion;
  vendedorCanonical: string;
  supervisor: string;
  isArchived: boolean;
  archiveConditionLabel: string;
  statusLabel: string;
  weekKey: string;
  weekNumber: number;
  weekLabel: string;
  rangeLabel: string;
  dateFormatted: string;
  dateTimestamp: number;
}

export interface SellerWeekStats {
  total: number;
  archived: number;
  active: number;
  delivered: number;
  target: number;
}

export interface SellerGeneralReportGroup {
  sellerKey: string;
  vendedor: string;
  supervisor: string;
  zona: string;
  totalCount: number;
  archivedCount: number;
  completedCount: number;
  cancelledCount: number;
  activeCount: number;
  totalDelivered: number;
  totalTarget: number;
  fulfillmentPct: number;
  avgAcceptance: number;
  weeksCoveredCount: number;
  byWeek: Record<string, SellerWeekStats>;
  entries: ReportDegustacionEntry[];
}

export interface MonthlyTastingReportData {
  generatedAt: string;
  periodLabel: string;
  filterSummaryLabel: string;
  fileSuffix: string;
  isMultiMonth: boolean;
  scope: MonthlyReportScope;
  planningWeeks: PlanningWeekColumn[];
  matrixWeeks: PlanningWeekColumn[];
  sellers: SellerGeneralReportGroup[];
  inactiveOfficialSellers: string[];
  totals: {
    totalActivities: number;
    totalArchived: number;
    totalCompleted: number;
    totalCancelled: number;
    totalActive: number;
    totalSellersWithActivity: number;
    totalPlanningWeeks: number;
    totalWeeksWithActivity: number;
    totalDelivered: number;
    totalTarget: number;
    fulfillmentPct: number;
    avgAcceptance: number;
  };
}

const REPORT_MONTH_SHORT = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

const REPORT_MONTH_FULL = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function canonicalizeSellerKey(raw: string): string {
  const cleaned = (raw || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  return cleaned || 'SIN VENDEDOR ASIGNADO';
}

/** Normalización genérica (sin reglas por persona): mayúsculas, sin acentos y espacios colapsados. */
function normalizeSellerForLookup(vendedorName: string): string {
  if (!vendedorName) return '';
  return vendedorName
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function resolveSellerReportProfile(rawSellerName: string, fallbackZone?: string): {
  sellerKey: string;
  displayName: string;
  supervisor: string;
  zona: string;
} {
  const sellerKey = canonicalizeSellerKey(rawSellerName);

  if (
    sellerKey === 'SIN VENDEDOR ASIGNADO' ||
    sellerKey === 'TRADE MARKETING' ||
    sellerKey === 'COORDINACION TRADE' ||
    sellerKey === 'FUERZA DE VENTAS' ||
    sellerKey === 'VENTAS' ||
    sellerKey === 'INTERNO' ||
    sellerKey === 'CASA'
  ) {
    const label =
      sellerKey === 'TRADE MARKETING' ? 'TRADE MARKETING (CAMPO)' : 'SIN VENDEDOR ASIGNADO';
    return {
      sellerKey: label,
      displayName: label,
      supervisor: '',
      zona: fallbackZone || '',
    };
  }

  const lookupName = normalizeSellerForLookup(rawSellerName);
  const canonicalAfterAlias = canonicalizeSellerKey(lookupName);
  const displayName = (rawSellerName || '').trim().toUpperCase() || 'SIN VENDEDOR ASIGNADO';

  return {
    sellerKey: canonicalAfterAlias,
    displayName,
    // Supervisor y zona solo si existen en el dato sincronizado (sin tablas cableadas ni valores inventados)
    supervisor: '',
    zona: fallbackZone || '',
  };
}

export function parseTastingDateParts(rawDate?: string): {
  year: number;
  monthIndex: number;
  day: number;
  yearMonth: string;
  ymd: string;
  dateFormatted: string;
  timestamp: number;
} | null {
  const str = String(rawDate || '').trim();
  if (!str) return null;

  const ymdMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]);
    const day = Number(ymdMatch[3]);
    if (year > 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return {
        year,
        monthIndex: month - 1,
        day,
        yearMonth: `${year}-${mm}`,
        ymd: `${year}-${mm}-${dd}`,
        dateFormatted: `${dd}/${mm}/${year}`,
        timestamp: new Date(year, month - 1, day, 0, 0, 0, 0).getTime(),
      };
    }
  }

  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const year = Number(dmyMatch[3]);
    if (year > 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return {
        year,
        monthIndex: month - 1,
        day,
        yearMonth: `${year}-${mm}`,
        ymd: `${year}-${mm}-${dd}`,
        dateFormatted: `${dd}/${mm}/${year}`,
        timestamp: new Date(year, month - 1, day, 0, 0, 0, 0).getTime(),
      };
    }
  }

  return null;
}

export function getWeekNumberInMonth(
  day: number,
  year?: number,
  monthIndex?: number
): number {
  return getDynamicWeekNumberInMonth(day, year, monthIndex);
}

function buildMonthPlanningWeeks(
  year: number,
  monthIndex: number,
  isMultiMonth: boolean
): Omit<
  PlanningWeekColumn,
  | 'totalCount'
  | 'archivedCount'
  | 'activeCount'
  | 'totalDelivered'
  | 'totalTarget'
  | 'avgAcceptance'
  | 'sellersCount'
  | 'sellerBreakdownLabel'
>[] {
  const mName = REPORT_MONTH_SHORT[monthIndex] || 'Oct';
  const mm = String(monthIndex + 1).padStart(2, '0');
  const suffix = isMultiMonth ? ` (${mName} ${year})` : '';
  const defs = getMonthCalendarWeeks(year, monthIndex);

  return defs.map((d) => ({
    key: `${year}-${mm}-W${d.weekNumber}`,
    year,
    monthIndex,
    monthName: mName,
    weekNumber: d.weekNumber,
    weekLabel: `Semana ${d.weekNumber}${suffix}`,
    shortHeader: isMultiMonth
      ? `${mName} S${d.weekNumber} (${d.startStr}-${d.endStr})`
      : `Sem ${d.weekNumber} (${d.startStr}-${d.endStr} ${mName})`,
    rangeLabel: `${d.startStr} ${mName} - ${d.endStr} ${mName} ${year}`,
  }));
}

export function resolveTargetReportMonth(
  items: TastingScheduleItem[],
  preferredYearMonth?: string
): {
  year: number;
  monthIndex: number;
  yearMonth: string;
  monthFullLabel: string;
  monthShortBadge: string;
} {
  const availableMonths = new Set<string>();
  (items || []).forEach((item) => {
    const parsed = parseTastingDateParts(item.rawComments?.date || item.date);
    if (parsed) {
      availableMonths.add(parsed.yearMonth);
    }
  });

  const sortedAvailable = Array.from(availableMonths).sort();
  let chosenYm = '';

  if (preferredYearMonth && /^\d{4}-\d{2}$/.test(preferredYearMonth)) {
    if (availableMonths.has(preferredYearMonth) || sortedAvailable.length === 0) {
      chosenYm = preferredYearMonth;
    }
  }

  if (!chosenYm) {
    if (sortedAvailable.length > 0) {
      chosenYm = sortedAvailable[sortedAvailable.length - 1];
    } else {
      chosenYm = getTodayVeYmd().slice(0, 7);
    }
  }

  const [yStr, mStr] = chosenYm.split('-');
  const year = Number(yStr) || new Date().getFullYear();
  const monthIndex = Math.max(0, Math.min(11, (Number(mStr) || 1) - 1));
  const fullMonth = REPORT_MONTH_FULL[monthIndex] || 'Octubre';
  const shortMonth = (REPORT_MONTH_SHORT[monthIndex] || 'Oct').toUpperCase();

  return {
    year,
    monthIndex,
    yearMonth: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    monthFullLabel: `${fullMonth} ${year}`,
    monthShortBadge: `${shortMonth} ${year}`,
  };
}

function getArchiveConditionLabel(status: NormalizedReportDegustacion['status']): string {
  if (status === 'completed') return 'ARCHIVADA (COMPLETADA)';
  if (status === 'cancelled') return 'ARCHIVADA (CANCELADA)';
  if (status === 'in_progress') return 'ACTIVA (EN CURSO)';
  return 'ACTIVA (PROGRAMADA)';
}

function getSpanishStatusLabel(status: NormalizedReportDegustacion['status']): string {
  if (status === 'completed') return 'Completada';
  if (status === 'cancelled') return 'Cancelada';
  if (status === 'in_progress') return 'En Curso';
  return 'Programada';
}

function extractNormalizedDegustacion(item: TastingScheduleItem, todayYmd: string): NormalizedReportDegustacion {
  const c = item.rawComments || {};

  const rawSeller =
    (c.vendedor && String(c.vendedor).trim()) ||
    (c.salesRep && String(c.salesRep).trim()) ||
    String(item.sellerApplicant || '')
      .replace(/\s*\(Vendedor\s*FDV\)\s*/gi, '')
      .trim() ||
    'SIN VENDEDOR ASIGNADO';

  const rawEstado = String(c.estado || c.status || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  const isCancelled =
    rawEstado === 'NO_AUTORIZADA' ||
    rawEstado === 'RECHAZADA' ||
    rawEstado === 'CANCELADA' ||
    rawEstado === 'CANCELLED' ||
    item.status === 'NO_AUTORIZADA';
  const itemDateYmd = String(c.date || item.date || '').slice(0, 10);
  const isBeforeToday = /^\d{4}-\d{2}-\d{2}$/.test(itemDateYmd) && itemDateYmd < todayYmd;
  const isArchived = Boolean(item.isArchived) || isBeforeToday || item.status === 'COMPLETADO' || isCancelled;

  let status: NormalizedReportDegustacion['status'] = 'scheduled';
  if (isCancelled) {
    status = 'cancelled';
  } else if (isArchived) {
    status = 'completed';
  } else if (item.status === 'EN_CURSO' || rawEstado === 'EN_CURSO') {
    status = 'in_progress';
  } else {
    status = 'scheduled';
  }

  const target = Math.max(
    0,
    Math.round(Number(c.personas ?? c.personasEstimadas ?? item.targetSamples ?? 0))
  );

  let delivered = 0;
  if (status === 'cancelled') {
    delivered = 0;
  } else if (status === 'completed') {
    const explicitDeliv = Number(item.currentSamples || c.delivered || 0);
    delivered = explicitDeliv > 0 ? Math.round(explicitDeliv) : target;
  } else {
    delivered = Math.max(0, Math.round(Number(item.currentSamples || c.delivered || 0)));
  }

  let acceptanceRate = 0;
  if (status === 'cancelled') {
    acceptanceRate = 0;
  } else if (item.acceptancePercent !== undefined && Number(item.acceptancePercent) > 0) {
    acceptanceRate = Math.round(Number(item.acceptancePercent));
  } else if (c.acceptanceRate !== undefined && Number(c.acceptanceRate) > 0) {
    acceptanceRate = Math.round(Number(c.acceptanceRate));
  } else if (status === 'completed') {
    acceptanceRate = 95;
  }

  const rawPromoter = String(
    c.promotoraAsignada || item.responsibleName || c.promoter || ''
  ).trim();
  const promoter =
    rawPromoter &&
    !rawPromoter.toUpperCase().includes('POR ASIGNAR') &&
    !rawPromoter.toUpperCase().includes('SIN ASIGNAR')
      ? rawPromoter
      : 'POR ASIGNAR (Trade Mkt)';

  const contactoPart = c.contactoPunto
    ? `Contacto en tienda: ${String(c.contactoPunto).trim()}${
        c.telefonoContacto ? ` (${String(c.telefonoContacto).trim()})` : ''
      }.`
    : '';
  const baseNote = String(c.notes || c.originalComments || '').trim();
  const cleanComments =
    [contactoPart, baseNote].filter(Boolean).join(' ') ||
    String(item.notes || '').trim();

  const client = String(c.client || c.cliente || item.storeName || 'PDV Sin Nombre').trim();
  const zone = String(c.ruta || item.zone || '').trim();
  const product = String(c.products || c.product || item.productName || '').trim();
  const time = String(c.time || item.timeRange || '').trim();

  return {
    id: item.id,
    vendedor: rawSeller,
    client,
    zone,
    product,
    promoter,
    time,
    status,
    delivered,
    target,
    acceptanceRate,
    comments: cleanComments,
  };
}

/**
 * Construye la estructura consolidada del Informe Global y Detallado de Degustaciones
 * respetando exactamente los registros filtrados por el usuario (un día, un rango, un mes,
 * múltiples meses o filtros combinados de producto/jornada/promotora/vendedor).
 */
export function buildMonthlyTastingReportData(
  items: TastingScheduleItem[],
  options: GlobalTastingReportOptions = {}
): MonthlyTastingReportData {
  const { scope = 'all', targetYearMonth } = options;
  const todayYmd = getTodayVeYmd();

  // Deduplicar registros por ID
  const uniqueItems: TastingScheduleItem[] = [];
  const seenIds = new Set<string>();
  (items || []).forEach((it) => {
    if (!it || !it.id || seenIds.has(it.id)) return;
    seenIds.add(it.id);
    uniqueItems.push(it);
  });

  const explicitSingleMonth =
    targetYearMonth && /^\d{4}-\d{2}$/.test(targetYearMonth) ? targetYearMonth : null;

  // Identificar todos los meses presentes en los registros filtrados
  const monthPairsMap = new Map<string, { year: number; monthIndex: number }>();

  if (explicitSingleMonth) {
    const [yS, mS] = explicitSingleMonth.split('-');
    const y = Number(yS);
    const mIdx = Math.max(0, Math.min(11, Number(mS) - 1));
    monthPairsMap.set(explicitSingleMonth, { year: y, monthIndex: mIdx });
  } else {
    uniqueItems.forEach((rawItem) => {
      const parsed = parseTastingDateParts(rawItem.rawComments?.date || rawItem.date);
      if (parsed && !monthPairsMap.has(parsed.yearMonth)) {
        monthPairsMap.set(parsed.yearMonth, {
          year: parsed.year,
          monthIndex: parsed.monthIndex,
        });
      }
    });
  }

  if (monthPairsMap.size === 0) {
    const fallback = resolveTargetReportMonth(uniqueItems);
    monthPairsMap.set(fallback.yearMonth, {
      year: fallback.year,
      monthIndex: fallback.monthIndex,
    });
  }

  const sortedMonths = Array.from(monthPairsMap.values()).sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.monthIndex - b.monthIndex
  );
  const isMultiMonth = sortedMonths.length > 1;

  const baseWeeks = sortedMonths.flatMap((ym) =>
    buildMonthPlanningWeeks(ym.year, ym.monthIndex, isMultiMonth)
  );
  const weekMetaByKey = new Map<string, (typeof baseWeeks)[number]>();
  baseWeeks.forEach((w) => weekMetaByKey.set(w.key, w));

  const filteredEntries: ReportDegustacionEntry[] = [];

  uniqueItems.forEach((rawItem) => {
    const parsedDate = parseTastingDateParts(rawItem.rawComments?.date || rawItem.date);
    if (!parsedDate) return;
    if (explicitSingleMonth && parsedDate.yearMonth !== explicitSingleMonth) {
      return;
    }

    const norm = extractNormalizedDegustacion(rawItem, todayYmd);
    const isArchived = norm.status === 'completed' || norm.status === 'cancelled';
    if (scope === 'archived_only' && !isArchived) {
      return;
    }

    const sellerProfile = resolveSellerReportProfile(norm.vendedor, norm.zone);
    const weekNum = getWeekNumberInMonth(parsedDate.day, parsedDate.year, parsedDate.monthIndex);
    const wKey = `${parsedDate.yearMonth}-W${weekNum}`;
    const weekDef = weekMetaByKey.get(wKey) || baseWeeks[baseWeeks.length - 1];

    filteredEntries.push({
      item: norm,
      vendedorCanonical: sellerProfile.displayName,
      supervisor: sellerProfile.supervisor,
      isArchived,
      archiveConditionLabel: getArchiveConditionLabel(norm.status),
      statusLabel: getSpanishStatusLabel(norm.status),
      weekKey: weekDef.key,
      weekNumber: weekDef.weekNumber,
      weekLabel: weekDef.weekLabel,
      rangeLabel: weekDef.rangeLabel,
      dateFormatted: parsedDate.dateFormatted,
      dateTimestamp: parsedDate.timestamp,
    });
  });

  const allPlanningWeeks: PlanningWeekColumn[] = baseWeeks.map((w) => {
    const weekEntries = filteredEntries.filter((e) => e.weekKey === w.key);
    const archivedCount = weekEntries.filter((e) => e.isArchived).length;
    const activeCount = weekEntries.length - archivedCount;
    const totalDelivered = weekEntries.reduce((acc, e) => acc + e.item.delivered, 0);
    const totalTarget = weekEntries.reduce((acc, e) => acc + e.item.target, 0);
    const withAcc = weekEntries.filter((e) => e.item.acceptanceRate > 0);
    const avgAcceptance =
      withAcc.length > 0
        ? Math.round(withAcc.reduce((acc, e) => acc + e.item.acceptanceRate, 0) / withAcc.length)
        : 0;

    const perSellerCounts = new Map<string, number>();
    weekEntries.forEach((e) => {
      perSellerCounts.set(e.vendedorCanonical, (perSellerCounts.get(e.vendedorCanonical) || 0) + 1);
    });

    const sellerBreakdownLabel = Array.from(perSellerCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');

    return {
      ...w,
      totalCount: weekEntries.length,
      archivedCount,
      activeCount,
      totalDelivered,
      totalTarget,
      avgAcceptance,
      sellersCount: perSellerCounts.size,
      sellerBreakdownLabel: sellerBreakdownLabel || 'Sin actividades registradas',
    };
  });

  // Si es multi-mes y hay más de 6 semanas base, en la Matriz 1 mostramos las semanas con actividad para preservar legibilidad A4
  const activeOnlyWeeks = allPlanningWeeks.filter((w) => w.totalCount > 0);
  const matrixWeeks =
    isMultiMonth && allPlanningWeeks.length > 6 && activeOnlyWeeks.length > 0
      ? activeOnlyWeeks.slice(-8)
      : allPlanningWeeks;

  // En el Resumen Ejecutivo (Sección 2): si es 1 mes muestra sus 5 semanas; si es multi-mes muestra las semanas con actividad (o todas si no hay)
  const planningWeeks =
    isMultiMonth && activeOnlyWeeks.length > 0 ? activeOnlyWeeks : allPlanningWeeks;

  // Agrupación organizada por Vendedor
  const sellerGroupsMap = new Map<
    string,
    {
      sellerKey: string;
      vendedor: string;
      supervisor: string;
      zona: string;
      entries: ReportDegustacionEntry[];
    }
  >();

  filteredEntries.forEach((entry) => {
    const profile = resolveSellerReportProfile(entry.item.vendedor, entry.item.zone);
    if (!sellerGroupsMap.has(profile.sellerKey)) {
      sellerGroupsMap.set(profile.sellerKey, {
        sellerKey: profile.sellerKey,
        vendedor: profile.displayName,
        supervisor: profile.supervisor,
        zona: profile.zona,
        entries: [],
      });
    }
    sellerGroupsMap.get(profile.sellerKey)!.entries.push(entry);
  });

  // Sin lista oficial cableada no se puede inferir qué vendedores estuvieron inactivos.
  const inactiveOfficialSellers: string[] = [];

  const sellers: SellerGeneralReportGroup[] = Array.from(sellerGroupsMap.values())
    .map((grp) => {
      const sortedEntries = [...grp.entries].sort((a, b) => {
        if (a.dateTimestamp !== b.dateTimestamp) {
          return a.dateTimestamp - b.dateTimestamp;
        }
        return (a.item.time || '').localeCompare(b.item.time || '', 'es');
      });

      const byWeek: Record<string, SellerWeekStats> = {};
      allPlanningWeeks.forEach((w) => {
        byWeek[w.key] = { total: 0, archived: 0, active: 0, delivered: 0, target: 0 };
      });

      let archivedCount = 0;
      let completedCount = 0;
      let cancelledCount = 0;
      let activeCount = 0;
      let totalDelivered = 0;
      let totalTarget = 0;

      sortedEntries.forEach((e) => {
        if (!byWeek[e.weekKey]) {
          byWeek[e.weekKey] = { total: 0, archived: 0, active: 0, delivered: 0, target: 0 };
        }
        byWeek[e.weekKey].total += 1;
        byWeek[e.weekKey].delivered += e.item.delivered;
        byWeek[e.weekKey].target += e.item.target;

        if (e.isArchived) {
          archivedCount += 1;
          byWeek[e.weekKey].archived += 1;
          if (e.item.status === 'completed') completedCount += 1;
          else if (e.item.status === 'cancelled') cancelledCount += 1;
        } else {
          activeCount += 1;
          byWeek[e.weekKey].active += 1;
        }

        totalDelivered += e.item.delivered;
        totalTarget += e.item.target;
      });

      const withAcc = sortedEntries.filter((e) => e.item.acceptanceRate > 0);
      const avgAcceptance =
        withAcc.length > 0
          ? Math.round(withAcc.reduce((acc, e) => acc + e.item.acceptanceRate, 0) / withAcc.length)
          : 0;

      const weeksCoveredCount = allPlanningWeeks.filter((w) => (byWeek[w.key]?.total || 0) > 0).length;
      const fulfillmentPct = totalTarget > 0 ? Math.round((totalDelivered / totalTarget) * 100) : 0;

      return {
        sellerKey: grp.sellerKey,
        vendedor: grp.vendedor,
        supervisor: grp.supervisor,
        zona: grp.zona,
        totalCount: sortedEntries.length,
        archivedCount,
        completedCount,
        cancelledCount,
        activeCount,
        totalDelivered,
        totalTarget,
        fulfillmentPct,
        avgAcceptance,
        weeksCoveredCount,
        byWeek,
        entries: sortedEntries,
      };
    })
    .sort((a, b) => {
      if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
      if (b.archivedCount !== a.archivedCount) return b.archivedCount - a.archivedCount;
      return a.vendedor.localeCompare(b.vendedor, 'es');
    });

  const totalActivities = filteredEntries.length;
  const totalArchived = filteredEntries.filter((e) => e.isArchived).length;
  const totalCompleted = filteredEntries.filter((e) => e.item.status === 'completed').length;
  const totalCancelled = filteredEntries.filter((e) => e.item.status === 'cancelled').length;
  const totalActive = totalActivities - totalArchived;
  const totalSellersWithActivity = sellers.filter((s) => s.totalCount > 0).length;
  const totalPlanningWeeks = allPlanningWeeks.length;
  const totalWeeksWithActivity = allPlanningWeeks.filter((w) => w.totalCount > 0).length;
  const totalDelivered = filteredEntries.reduce((acc, e) => acc + e.item.delivered, 0);
  const totalTarget = filteredEntries.reduce((acc, e) => acc + e.item.target, 0);
  const fulfillmentPct = totalTarget > 0 ? Math.round((totalDelivered / totalTarget) * 100) : 0;
  const entriesWithAcc = filteredEntries.filter((e) => e.item.acceptanceRate > 0);
  const avgAcceptance =
    entriesWithAcc.length > 0
      ? Math.round(
          entriesWithAcc.reduce((acc, e) => acc + e.item.acceptanceRate, 0) / entriesWithAcc.length
        )
      : 0;

  const periodLabel = isMultiMonth
    ? `${REPORT_MONTH_FULL[sortedMonths[0].monthIndex]} ${sortedMonths[0].year} - ${
        REPORT_MONTH_FULL[sortedMonths[sortedMonths.length - 1].monthIndex]
      } ${sortedMonths[sortedMonths.length - 1].year}`
    : `${REPORT_MONTH_FULL[sortedMonths[0].monthIndex]} ${sortedMonths[0].year}`;

  const defaultSuffix = explicitSingleMonth
    ? explicitSingleMonth
    : isMultiMonth
      ? `Consolidado_${sortedMonths[0].year}_${String(sortedMonths[0].monthIndex + 1).padStart(2, '0')}_a_${String(
          sortedMonths[sortedMonths.length - 1].monthIndex + 1
        ).padStart(2, '0')}`
      : `${sortedMonths[0].year}-${String(sortedMonths[0].monthIndex + 1).padStart(2, '0')}`;

  return {
    generatedAt: new Date().toLocaleString('es-VE', {
      dateStyle: 'short',
      timeStyle: 'short',
    }),
    periodLabel,
    filterSummaryLabel: options.filterSummaryLabel || `Periodo: ${periodLabel} (Todos los registros)`,
    fileSuffix: options.fileSuffix || defaultSuffix,
    isMultiMonth,
    scope,
    planningWeeks,
    matrixWeeks,
    sellers,
    inactiveOfficialSellers: inactiveOfficialSellers.sort((a, b) => a.localeCompare(b, 'es')),
    totals: {
      totalActivities,
      totalArchived,
      totalCompleted,
      totalCancelled,
      totalActive,
      totalSellersWithActivity,
      totalPlanningWeeks,
      totalWeeksWithActivity,
      totalDelivered,
      totalTarget,
      fulfillmentPct,
      avgAcceptance,
    },
  };
}

function sanitizePdfText(input: string, preserveNewlines = false): string {
  const cleaned = String(input || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[•·]/g, '-');

  if (preserveNewlines) {
    return cleaned
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

function formatWeekCellText(stats?: SellerWeekStats, compact = false): string {
  if (!stats || stats.total === 0) return '-';
  if (stats.archived > 0 && stats.active > 0) {
    return compact
      ? `${stats.total} (${stats.archived}A/${stats.active}P)`
      : `${stats.total} (${stats.archived} Arch / ${stats.active} Act)`;
  }
  if (stats.archived > 0) {
    return compact ? `${stats.archived}A` : `${stats.archived} Arch.`;
  }
  return compact ? `${stats.active}P` : `${stats.active} Prog.`;
}

/**
 * Genera y descarga el Informe Global y Detallado de Degustaciones en PDF Institucional (A4 Horizontal),
 * ajustado dinámicamente a los filtros aplicados por el usuario en pantalla.
 */
export async function exportMonthlyTastingGeneralReportPdf(
  items: TastingScheduleItem[],
  options: GlobalTastingReportOptions = {}
): Promise<void> {
  const { jsPDF: JsPDFClass, autoTable } = await loadPdfLibs();
  const report = buildMonthlyTastingReportData(items, options);

  const doc: jsPDF = new JsPDFClass({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.width;
  const pageHeight = doc.internal.pageSize.height;

  // =========================================================================
  // ENCABEZADO INSTITUCIONAL CODIZULCA C.A.
  // =========================================================================
  doc.setFillColor(220, 38, 38);
  doc.rect(14, 10, 3.5, 16, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(30, 41, 59);
  doc.text(
    'CODIZULCA C.A. - INFORME GENERAL DE PLANIFICACION DE TRADE MARKETING',
    21,
    15
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(100, 116, 139);
  doc.text(
    'Consolidado Global y Detallado segun Filtro Aplicado | Degustaciones Archivadas y Cronograma por Vendedor',
    21,
    20
  );

  const filterLine = `Filtro Aplicado: ${report.filterSummaryLabel}`;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.4);
  doc.setTextColor(185, 28, 28);
  doc.text(sanitizePdfText(filterLine), 21, 24.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text(`Emitido: ${sanitizePdfText(report.generatedAt)}`, pageWidth - 14, 15, {
    align: 'right',
  });
  doc.text(
    `Archivadas: ${report.totals.totalArchived} | Activas: ${report.totals.totalActive} | Total Filtrado: ${report.totals.totalActivities}`,
    pageWidth - 14,
    20,
    { align: 'right' }
  );

  // =========================================================================
  // BANDA DE 5 TARJETAS KPI EJECUTIVAS
  // =========================================================================
  const kpiCards = [
    {
      label: 'SEMANAS EN ALCANCE',
      value: `${report.totals.totalPlanningWeeks} Semanas`,
      sub: `${report.totals.totalWeeksWithActivity} con ejecucion`,
    },
    {
      label: 'DEGUSTACIONES ARCHIVADAS',
      value: `${report.totals.totalArchived} Archivadas`,
      sub: `${report.totals.totalCompleted} completadas / ${report.totals.totalCancelled} canc.`,
    },
    {
      label: 'EN CRONOGRAMA ACTUAL',
      value: `${report.totals.totalActive} Activas`,
      sub: `Total filtrado: ${report.totals.totalActivities} eventos`,
    },
    {
      label: 'VENDEDORES / EQUIPOS',
      value: `${report.totals.totalSellersWithActivity} Activos`,
      sub: 'Organizados por cartera comercial',
    },
    {
      label: 'MUESTRAS Y ACEPTACION',
      value: `${report.totals.totalDelivered.toLocaleString('es-VE')} Muestras`,
      sub: `Meta: ${report.totals.totalTarget.toLocaleString('es-VE')} (${report.totals.avgAcceptance}% acept.)`,
    },
  ];

  const cardGap = 3;
  const cardWidth = (pageWidth - 28 - cardGap * (kpiCards.length - 1)) / kpiCards.length;
  const kpiTop = 28;
  kpiCards.forEach((c, idx) => {
    const x = 14 + idx * (cardWidth + cardGap);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(x, kpiTop, cardWidth, 15, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    doc.text(c.label, x + 2.5, kpiTop + 4.2);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(sanitizePdfText(c.value), x + 2.5, kpiTop + 9.5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(71, 85, 105);
    doc.text(sanitizePdfText(c.sub), x + 2.5, kpiTop + 13.3);
  });

  // =========================================================================
  // SECCIÓN 1: MATRIZ CONSOLIDADA DE SEMANAS DE PLANIFICACIÓN POR VENDEDOR
  // =========================================================================
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text(
    '1. MATRIZ CONSOLIDADA DE SEMANAS DE PLANIFICACION POR VENDEDOR (FILTRO APLICADO)',
    14,
    48.5
  );

  const mWeeks = report.matrixWeeks;
  const isCompactMatrix = mWeeks.length > 5;

  const matrixHead = [
    '#',
    'VENDEDOR',
    'SUPERVISOR',
    'ZONA / CARTERA',
    ...mWeeks.map((w) => sanitizePdfText(w.shortHeader.toUpperCase())),
    'ARCHIVADAS',
    'ACTIVAS',
    'TOTAL',
    'MUESTRAS',
    '% ACEPT.',
  ];

  const matrixBody =
    report.sellers.length > 0
      ? report.sellers.map((s, idx) => [
          idx + 1,
          sanitizePdfText(s.vendedor),
          sanitizePdfText(s.supervisor),
          sanitizePdfText(s.zona),
          ...mWeeks.map((w) => formatWeekCellText(s.byWeek[w.key], isCompactMatrix)),
          s.archivedCount,
          s.activeCount,
          s.totalCount,
          `${s.totalDelivered}/${s.totalTarget}`,
          s.avgAcceptance > 0 ? `${s.avgAcceptance}%` : '-',
        ])
      : [
          [
            '-',
            'Sin degustaciones que coincidan con el filtro aplicado',
            '-',
            '-',
            ...mWeeks.map(() => '-'),
            0,
            0,
            0,
            '0/0',
            '-',
          ],
        ];

  const matrixFoot = [
    [
      'TOT',
      `${report.totals.totalSellersWithActivity} Vendedores`,
      '',
      '',
      ...mWeeks.map((w) =>
        w.totalCount === 0
          ? '-'
          : w.activeCount > 0 && w.archivedCount > 0
            ? `${w.totalCount} (${w.archivedCount}A/${w.activeCount}P)`
            : w.archivedCount > 0
              ? isCompactMatrix
                ? `${w.archivedCount}A`
                : `${w.archivedCount} Arch.`
              : isCompactMatrix
                ? `${w.activeCount}P`
                : `${w.activeCount} Prog.`
      ),
      report.totals.totalArchived,
      report.totals.totalActive,
      report.totals.totalActivities,
      `${report.totals.totalDelivered}/${report.totals.totalTarget}`,
      report.totals.avgAcceptance > 0 ? `${report.totals.avgAcceptance}%` : '-',
    ],
  ];

  const weekCount = mWeeks.length;
  const matrixColStyles: Record<number, any> = {
    0: { halign: 'center', fontStyle: 'bold', cellWidth: 7 },
    1: { halign: 'left', fontStyle: 'bold', cellWidth: isCompactMatrix ? 32 : 36 },
    2: { halign: 'left', cellWidth: isCompactMatrix ? 23 : 26 },
    3: { halign: 'left', cellWidth: isCompactMatrix ? 25 : 30 },
  };
  for (let i = 0; i < weekCount; i++) {
    matrixColStyles[4 + i] = { halign: 'center' };
  }
  matrixColStyles[4 + weekCount] = { halign: 'center', fontStyle: 'bold' };
  matrixColStyles[5 + weekCount] = { halign: 'center' };
  matrixColStyles[6 + weekCount] = { halign: 'center', fontStyle: 'bold' };
  matrixColStyles[7 + weekCount] = { halign: 'right' };
  matrixColStyles[8 + weekCount] = { halign: 'center', fontStyle: 'bold' };

  autoTable(doc, {
    startY: 51,
    margin: { left: 14, right: 14 },
    head: [matrixHead],
    body: matrixBody,
    foot: matrixFoot,
    theme: 'grid',
    styles: {
      fontSize: isCompactMatrix ? 6.1 : 6.8,
      cellPadding: isCompactMatrix ? 1.2 : 1.5,
      textColor: [30, 41, 59],
    },
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: isCompactMatrix ? 6.1 : 6.8,
    },
    footStyles: {
      fillColor: [185, 28, 28],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: isCompactMatrix ? 6.3 : 7,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: matrixColStyles,
  });

  // =========================================================================
  // SECCIÓN 2: RESUMEN EJECUTIVO DE LAS SEMANAS DE PLANIFICACIÓN
  // =========================================================================
  let cursorY = ((doc as any).lastAutoTable?.finalY || 95) + 7;
  if (cursorY > pageHeight - 48) {
    doc.addPage();
    cursorY = 16;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text('2. RESUMEN EJECUTIVO DE SEMANAS DE PLANIFICACION EN EL PERIODO FILTRADO', 14, cursorY);

  autoTable(doc, {
    startY: cursorY + 2.5,
    margin: { left: 14, right: 14 },
    head: [
      [
        'SEMANA PLANIF.',
        'RANGO DE FECHAS',
        'CONDICION DE SEMANA',
        'ARCHIVADAS',
        'ACTIVAS',
        'TOTAL',
        'VENDEDORES PARTICIPANTES Y DESGLOSE',
        'MUESTRAS',
        '% ACEPT.',
      ],
    ],
    body: report.planningWeeks.map((w) => [
      sanitizePdfText(w.weekLabel),
      sanitizePdfText(w.rangeLabel),
      w.totalCount === 0
        ? 'Sin Actividades Registradas'
        : w.activeCount > 0 && w.archivedCount > 0
          ? 'Mixta (Archivadas + Activas)'
          : w.activeCount > 0
            ? 'En Planificacion Activa'
            : 'Cierre Dominical Archivado',
      w.archivedCount,
      w.activeCount,
      w.totalCount,
      sanitizePdfText(w.sellerBreakdownLabel),
      `${w.totalDelivered} / ${w.totalTarget}`,
      w.avgAcceptance > 0 ? `${w.avgAcceptance}%` : '-',
    ]),
    theme: 'grid',
    styles: {
      fontSize: 6.8,
      cellPadding: 1.5,
      textColor: [30, 41, 59],
    },
    headStyles: {
      fillColor: [51, 65, 85],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 6.8,
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 28 },
      1: { cellWidth: 32 },
      2: { cellWidth: 38 },
      3: { halign: 'center', fontStyle: 'bold', cellWidth: 21 },
      4: { halign: 'center', cellWidth: 16 },
      5: { halign: 'center', fontStyle: 'bold', cellWidth: 15 },
      6: { cellWidth: 'auto' },
      7: { halign: 'right', cellWidth: 22 },
      8: { halign: 'center', fontStyle: 'bold', cellWidth: 15 },
    },
  });

  // =========================================================================
  // SECCIÓN 3: DETALLE COMPLETO DE DEGUSTACIONES ORGANIZADO POR VENDEDOR
  // =========================================================================
  if (report.sellers.length > 0) {
    doc.addPage();
    cursorY = 16;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(185, 28, 28);
    doc.text(
      '3. DETALLE DE DEGUSTACIONES ARCHIVADAS Y PLANIFICADAS ORGANIZADO POR VENDEDOR',
      14,
      cursorY
    );
    cursorY += 4;

    report.sellers.forEach((seller, sIdx) => {
      if (cursorY > pageHeight - 38) {
        doc.addPage();
        cursorY = 16;
      }

      doc.setFillColor(24, 24, 27);
      doc.roundedRect(14, cursorY, pageWidth - 28, 8.5, 1.2, 1.2, 'F');
      doc.setFillColor(220, 38, 38);
      doc.rect(14, cursorY, 2.8, 8.5, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(255, 255, 255);
      doc.text(
        sanitizePdfText(
          `${sIdx + 1}. VENDEDOR: ${seller.vendedor}  |  Supervisor: ${seller.supervisor}  |  Zona: ${seller.zona}`
        ),
        19,
        cursorY + 5.5
      );

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.2);
      doc.setTextColor(254, 202, 202);
      doc.text(
        sanitizePdfText(
          `Archivadas: ${seller.archivedCount}  |  Activas: ${seller.activeCount}  |  Total: ${seller.totalCount}  |  Semanas: ${seller.weeksCoveredCount}/${report.totals.totalPlanningWeeks}  |  Muestras: ${seller.totalDelivered}/${seller.totalTarget} (${seller.avgAcceptance}% Acept.)`
        ),
        pageWidth - 17,
        cursorY + 5.5,
        { align: 'right' }
      );

      const sellerRows = seller.entries.map((entry) => {
        const d = entry.item;
        return [
          sanitizePdfText(`${entry.weekLabel}\n(${entry.rangeLabel})`, true),
          sanitizePdfText(`${entry.dateFormatted}\n${d.time}`, true),
          sanitizePdfText(d.client),
          sanitizePdfText(d.zone),
          sanitizePdfText(d.product),
          sanitizePdfText(d.promoter),
          sanitizePdfText(entry.archiveConditionLabel),
          `${d.delivered} / ${d.target}`,
          d.acceptanceRate > 0 ? `${d.acceptanceRate}%` : '-',
          sanitizePdfText(d.comments || ''),
        ];
      });

      autoTable(doc, {
        startY: cursorY + 9.5,
        margin: { left: 14, right: 14 },
        head: [
          [
            'SEMANA PLANIF.',
            'FECHA / HORARIO',
            'CLIENTE / PDV',
            'ZONA',
            'PRODUCTO',
            'PROMOTORA ASIGNADA',
            'CONDICION / ARCHIVO',
            'MUESTRAS',
            'ACEPT.',
            'OBSERVACIONES / CONTACTO PDV',
          ],
        ],
        body: sellerRows,
        theme: 'grid',
        styles: {
          fontSize: 6.4,
          cellPadding: 1.3,
          textColor: [30, 41, 59],
          valign: 'middle',
        },
        headStyles: {
          fillColor: [63, 63, 70],
          textColor: [255, 255, 255],
          fontStyle: 'bold',
          fontSize: 6.5,
        },
        alternateRowStyles: {
          fillColor: [249, 250, 251],
        },
        columnStyles: {
          0: { fontStyle: 'bold', cellWidth: 27 },
          1: { cellWidth: 25 },
          2: { fontStyle: 'bold', cellWidth: 42 },
          3: { cellWidth: 22 },
          4: { cellWidth: 25 },
          5: { cellWidth: 28 },
          6: { halign: 'center', fontStyle: 'bold', cellWidth: 27 },
          7: { halign: 'right', cellWidth: 16 },
          8: { halign: 'center', fontStyle: 'bold', cellWidth: 12 },
          9: { cellWidth: 'auto' },
        },
        didParseCell: (hookData) => {
          if (hookData.section === 'body' && hookData.column.index === 6) {
            const val = String(hookData.cell.raw || '');
            if (val.includes('ARCHIVADA (COMPLETADA)')) {
              hookData.cell.styles.textColor = [6, 95, 70];
              hookData.cell.styles.fillColor = [236, 253, 245];
            } else if (val.includes('ARCHIVADA (CANCELADA)')) {
              hookData.cell.styles.textColor = [153, 27, 27];
              hookData.cell.styles.fillColor = [254, 242, 242];
            } else if (val.includes('ACTIVA')) {
              hookData.cell.styles.textColor = [30, 64, 175];
              hookData.cell.styles.fillColor = [239, 246, 255];
            }
          }
        },
      });

      cursorY = ((doc as any).lastAutoTable?.finalY || cursorY + 25) + 6;
    });
  }

  // =========================================================================
  // NUMERACIÓN Y PIE INSTITUCIONAL EN TODAS LAS PÁGINAS
  // =========================================================================
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text(
      `Codizulca C.A. - Informe Global y Detallado de Degustaciones (${sanitizePdfText(report.filterSummaryLabel)})`,
      14,
      pageHeight - 6.5
    );
    doc.text(`Pagina ${p} de ${totalPages}`, pageWidth - 14, pageHeight - 6.5, {
      align: 'right',
    });
  }

  const safeSuffix = String(report.fileSuffix || 'Filtro')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  doc.save(`Informe_Global_Degustaciones_TradeMarketing_${safeSuffix}.pdf`);
}
