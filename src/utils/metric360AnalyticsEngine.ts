import type { PriceComparisonThreeBrands, ScheduledVisit } from '../types';
import type {
  ConsumerSurveyRecord,
  InventorySamplingRecord,
  Module1SupabaseBundle,
} from '../services/supabaseModule1';
import type { TastingScheduleItem } from '../components/field/FieldPromotoraView';
import {
  type LiveVenezuelaClock,
  getRollingWeekWindow,
  normalizeAnyDateToYmd,
} from './weekCalendar';
import { safeDiv, safePct, toFiniteNumber } from './safeMath';

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

export interface Unified360Row {
  id: string;
  ymd: string | null;
  dayLabel: string;
  shift: string;
  storeName: string;
  clienteCodigo?: string;
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
  shelfMovedUnits: number;
  rating: number | null;
  acceptanceLabel: string;
  ownPriceUsd: number | null;
  status: string;
  mapsUrl?: string;
  isAuditSupplementRow?: boolean;
}

export interface VenezuelaPeriodBounds {
  lens: Metric360TimeLens;
  startYmd: string | null;
  endYmd: string | null;
  /** Epoch ms de YYYY-MM-DDT00:00:00.000-04:00 (America/Caracas) */
  startEpochMs: number | null;
  /** Epoch ms de YYYY-MM-DDT23:59:59.999-04:00 (America/Caracas) */
  endEpochMs: number | null;
}

export interface ConsumerSurveyPeriodMetrics {
  totalSurveys: number;
  breveCount: number;
  profundaCount: number;
  ratedCount: number;
  avgRating: number;
  highAcceptanceCount: number;
  highAcceptancePercent: number;
}

export interface RollingWeek360Point {
  offset: number;
  isoWeekNumber: number;
  shortRangeLabel: string;
  rangeLabel: string;
  isCurrentWeek: boolean;
  isFutureWeek: boolean;
  activationsCount: number;
  qty: number;
  pdvs: number;
  samples: number;
}

export interface Metric360Snapshot {
  periodBounds: VenezuelaPeriodBounds;
  lensFilteredRows: Unified360Row[];
  csvExportRows: Unified360Row[];
  matchingPrices: PriceComparisonThreeBrands[];
  matchingInventory: InventorySamplingRecord[];
  surveyMetrics: ConsumerSurveyPeriodMetrics;
  resolvedSwitcherItems: Metric360SwitcherItem[];
  totalPrimaryQty: number;
  totalActivations: number;
  matrixSharePct: number;
  uniqueStoresCount: number;
  uniqueZonesCount: number;
  morningCount: number;
  afternoonCount: number;
  completedCount: number;
  pendingCount: number;
  completionPct: number;
  totalSamples: number;
  shelfMovedUnits: number;
  avgOwnPrice: number;
  avgCompPrice: number;
  priceGapPct: number | null;
  estimatedBtlCostUsd: number;
  topStores: Array<{
    name: string;
    zone: string;
    qty: number;
    count: number;
    samples: number;
    mapsUrl?: string;
  }>;
  topZones: Array<{ zone: string; qty: number; count: number }>;
  topPromotoras: Array<{ name: string; qty: number; count: number; samples: number }>;
  topSellers: Array<{ name: string; qty: number; count: number }>;
  rollingWeeks: RollingWeek360Point[];
  portfolioMix: {
    mortadela: number;
    vencampoStands: number;
    vencampoUnits: number;
    espalda: number;
    azucarKg: number;
    lecheKg: number;
  };
}

const STORE_PLACEHOLDERS = new Set([
  '',
  '-',
  '--',
  'N/A',
  'NA',
  'NULL',
  'UNDEFINED',
  'PDV SIN NOMBRE',
  'PUNTO DE VENTA',
  'SIN TIENDA',
  'SIN PDV',
  'POR DEFINIR',
]);

const ZONE_PLACEHOLDERS = new Set([
  '',
  '-',
  '--',
  'N/A',
  'NA',
  'NULL',
  'UNDEFINED',
  'SIN ZONA',
  'POR DEFINIR',
  'SIN UBICACION',
]);

export function clampNumber(value: unknown, min: number, max: number, fallback = 0): number {
  const n = toFiniteNumber(value, fallback);
  return Math.min(max, Math.max(min, n));
}

export function toSanitizedNonNegative(value: unknown, fallback = 0): number {
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.-]/g, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
    return fallback;
  }
  return Math.max(0, toFiniteNumber(value, fallback));
}

export function stripDiacriticsUpper(raw?: string | null): string {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function canonicalStoreKey(storeName?: string | null, clienteCodigo?: string | null): string | null {
  const code = stripDiacriticsUpper(clienteCodigo);
  const cleanName = stripDiacriticsUpper(storeName);
  if (STORE_PLACEHOLDERS.has(cleanName) && !code) return null;
  if (code && cleanName && !STORE_PLACEHOLDERS.has(cleanName)) {
    return `${code}::${cleanName}`;
  }
  return code || (STORE_PLACEHOLDERS.has(cleanName) ? null : cleanName);
}

export function canonicalZoneKey(zoneName?: string | null): string | null {
  const cleanZone = stripDiacriticsUpper(zoneName);
  if (ZONE_PLACEHOLDERS.has(cleanZone)) return null;
  return cleanZone;
}

/**
 * Resuelve cualquier entrada de fecha o timestamp a YYYY-MM-DD en zona America/Caracas (UTC-4).
 * - Timestamps ISO reales con hora y zona (Z o ±HH:MM) se convierten primero a UTC-4.
 * - Fechas calendario puras (YYYY-MM-DD, DD/MM/YYYY, seriales Excel) conservan su día exacto sin desfase -1 día.
 */
export function resolveVenezuelaDateYmd(raw?: unknown): string | null {
  return normalizeAnyDateToYmd(raw);
}

function parseExplicitIsoTimestampMs(raw?: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (
    /^\d{4}-\d{2}-\d{2}[T\s](?!00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?$)\d{2}:\d{2}/i.test(
      trimmed
    ) &&
    /(?:Z|[+-]\d{2}:?\d{2}|[+-]\d{2})$/i.test(trimmed)
  ) {
    const normalizedOffset = /[+-]\d{2}$/.test(trimmed) ? `${trimmed}:00` : trimmed;
    const ms = new Date(normalizedOffset).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function ymdStartEndVenezuelaEpochMs(startYmd: string, endYmd: string): {
  startEpochMs: number;
  endEpochMs: number;
} {
  const startEpochMs = new Date(`${startYmd}T00:00:00.000-04:00`).getTime();
  const endEpochMs = new Date(`${endYmd}T23:59:59.999-04:00`).getTime();
  return { startEpochMs, endEpochMs };
}

export function getVenezuelaPeriodBounds(
  liveClock: LiveVenezuelaClock,
  lens: Metric360TimeLens
): VenezuelaPeriodBounds {
  if (lens === 'GLOBAL') {
    return {
      lens,
      startYmd: null,
      endYmd: null,
      startEpochMs: null,
      endEpochMs: null,
    };
  }

  if (lens === 'SEMANA_ACTUAL') {
    const startYmd = liveClock.currentWeek.mondayYmd;
    const endYmd = liveClock.currentWeek.sundayYmd;
    const { startEpochMs, endEpochMs } = ymdStartEndVenezuelaEpochMs(startYmd, endYmd);
    return { lens, startYmd, endYmd, startEpochMs, endEpochMs };
  }

  if (lens === 'SEMANA_ANTERIOR') {
    const prevWeek = getRollingWeekWindow(liveClock.todayYmd, -1);
    const startYmd = prevWeek.mondayYmd;
    const endYmd = prevWeek.sundayYmd;
    const { startEpochMs, endEpochMs } = ymdStartEndVenezuelaEpochMs(startYmd, endYmd);
    return { lens, startYmd, endYmd, startEpochMs, endEpochMs };
  }

  // MES_ACTUAL: día 01 al último día real del mes en UTC-4 inclusivo (00:00:00.000 a 23:59:59.999)
  const lastDay = new Date(Date.UTC(liveClock.year, liveClock.monthIndex + 1, 0, 12, 0, 0)).getUTCDate();
  const mm = String(liveClock.month).padStart(2, '0');
  const startYmd = `${liveClock.year}-${mm}-01`;
  const endYmd = `${liveClock.year}-${mm}-${String(lastDay).padStart(2, '0')}`;
  const { startEpochMs, endEpochMs } = ymdStartEndVenezuelaEpochMs(startYmd, endYmd);
  return { lens, startYmd, endYmd, startEpochMs, endEpochMs };
}

export function matchesVenezuelaTimeLens(
  rawDate: unknown,
  bounds: VenezuelaPeriodBounds
): boolean {
  if (bounds.lens === 'GLOBAL') return true;
  if (!bounds.startYmd || !bounds.endYmd) return true;

  const explicitEpochMs = parseExplicitIsoTimestampMs(rawDate);
  if (
    explicitEpochMs !== null &&
    bounds.startEpochMs !== null &&
    bounds.endEpochMs !== null
  ) {
    return explicitEpochMs >= bounds.startEpochMs && explicitEpochMs <= bounds.endEpochMs;
  }

  const ymd = resolveVenezuelaDateYmd(rawDate);
  if (!ymd) return false;
  return ymd >= bounds.startYmd && ymd <= bounds.endYmd;
}

export function matchesProductLineForSupabase(metricId: Metric360Id, text: string): boolean {
  const u = stripDiacriticsUpper(text);
  switch (metricId) {
    case 'mortadela':
      return (
        u.includes('MORTADELA') ||
        u.includes('JAMON') ||
        u.includes('SALCHICHA') ||
        u.includes('PECHUGA')
      );
    case 'vencampo':
      return (
        u.includes('VENCAMPO') ||
        u.includes('ARROZ') ||
        u.includes('CARAOTA') ||
        u.includes('ARVEJA') ||
        u.includes('ACEITE')
      );
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

function normalizeLinkToken(raw?: string | null): string {
  return String(raw || '')
    .trim()
    .replace(/^fdv-render:/i, '')
    .replace(/^DEG-(?=deg-)/i, '');
}

interface TastingLookupResult {
  findForVisit: (v: ScheduledVisit) => TastingScheduleItem | undefined;
  unmatchedItems: (visits: ScheduledVisit[]) => TastingScheduleItem[];
}

function buildTastingLookup(items: TastingScheduleItem[]): TastingLookupResult {
  const byKey = new Map<string, TastingScheduleItem>();
  items.forEach((it) => {
    const keys = [
      it.id,
      normalizeLinkToken(it.id),
      it.cronogramaId,
      it.degustacionId,
      normalizeLinkToken(it.degustacionId),
    ].filter((k): k is string => Boolean(k && String(k).trim()));

    keys.forEach((k) => {
      if (!byKey.has(k)) byKey.set(k, it);
    });
  });

  const findForVisit = (v: ScheduledVisit): TastingScheduleItem | undefined => {
    const candidates = [
      v.id,
      normalizeLinkToken(v.id),
      v.solicitudId,
      normalizeLinkToken(v.solicitudId),
      v.cronogramaId,
      v.degustacionId,
      normalizeLinkToken(v.degustacionId),
    ].filter((k): k is string => Boolean(k && String(k).trim()));

    for (const c of candidates) {
      const found = byKey.get(c);
      if (found) return found;
    }
    return undefined;
  };

  const unmatchedItems = (visits: ScheduledVisit[]): TastingScheduleItem[] => {
    const matchedIds = new Set<string>();
    visits.forEach((v) => {
      const found = findForVisit(v);
      if (found) matchedIds.add(found.id);
    });
    return items.filter((it) => !matchedIds.has(it.id));
  };

  return { findForVisit, unmatchedItems };
}

function computeShelfMovedFromInventory(inv: InventorySamplingRecord): number {
  const salesGen = toSanitizedNonNegative(inv.salesGenerated, 0);
  if (salesGen > 0) return Math.round(salesGen);
  const diff = toSanitizedNonNegative(inv.initialStock, 0) - toSanitizedNonNegative(inv.finalStock, 0);
  return Math.max(0, Math.round(diff));
}

function computeSurveyPeriodMetrics(surveys: ConsumerSurveyRecord[]): ConsumerSurveyPeriodMetrics {
  const totalSurveys = surveys.length;
  const breveCount = surveys.filter((s) => s.surveyType === 'Breve').length;
  const profundaCount = surveys.filter((s) => s.surveyType === 'Profunda').length;
  const rated = surveys.filter(
    (s): s is ConsumerSurveyRecord & { rating: number } =>
      s.rating !== null && Number.isFinite(s.rating) && s.rating > 0
  );
  const ratedCount = rated.length;
  const avgRating =
    ratedCount > 0
      ? +clampNumber(
          safeDiv(
            rated.reduce((acc, s) => acc + clampNumber(s.rating, 0, 5), 0),
            ratedCount,
            0
          ),
          0,
          5
        ).toFixed(2)
      : 0;
  const highAcceptanceCount = surveys.filter((s) => Boolean(s.highAcceptance)).length;
  const highAcceptancePercent =
    totalSurveys > 0
      ? Math.round(clampNumber(safePct(highAcceptanceCount, totalSurveys, 0), 0, 100))
      : 0;

  return {
    totalSurveys,
    breveCount,
    profundaCount,
    ratedCount,
    avgRating,
    highAcceptanceCount,
    highAcceptancePercent,
  };
}

function buildRowsForScheduleOrProductMetric(params: {
  metricId: Metric360Id;
  visits: ScheduledVisit[];
  tastingItems: TastingScheduleItem[];
  vencampoBadgeMode: 'stands' | 'units';
}): Unified360Row[] {
  const { metricId, visits, tastingItems, vencampoBadgeMode } = params;
  const lookup = buildTastingLookup(tastingItems);

  const fromVisits: Unified360Row[] = visits.map((v) => {
    const sup = lookup.findForVisit(v);
    const ymd = resolveVenezuelaDateYmd(v.date || sup?.date);
    const prodUpper = stripDiacriticsUpper(
      `${v.fillProductSelection || ''} ${v.productFocus || ''} ${sup?.productName || ''}`
    );

    const mortQty = toSanitizedNonNegative(v.mortadelaQty, 0);
    const espQty = toSanitizedNonNegative(v.espaldaQty, 0);
    const arrQty = toSanitizedNonNegative(v.arrozQty, 0);
    const azuG = toSanitizedNonNegative(v.azucarGrams, 0);
    const lecG = toSanitizedNonNegative(v.lecheGrams, 0);
    const planned = toSanitizedNonNegative(v.plannedUnits, 0);

    const isVencampoRow = arrQty > 0 || prodUpper.includes('VENCAMPO') || prodUpper.includes('ARROZ');
    const isMortadelaRow =
      mortQty > 0 || prodUpper.includes('MORTADELA') || prodUpper.includes('JAMON');
    const isEspaldaRow = espQty > 0 || prodUpper.includes('ESPALDA');
    const isAzucarRow = azuG > 0 || prodUpper.includes('AZUCAR');
    const isLecheRow = lecG > 0 || prodUpper.includes('LECHE');

    let primaryQty = planned || mortQty + espQty + arrQty || 1;
    let unitLabel = 'filas';

    if (metricId === 'mortadela') {
      primaryQty = mortQty;
      unitLabel = 'unid';
    } else if (metricId === 'vencampo') {
      primaryQty = vencampoBadgeMode === 'stands' ? (isVencampoRow ? 1 : 0) : arrQty;
      unitLabel = vencampoBadgeMode === 'stands' ? 'stands' : 'unid';
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
      primaryQty = 1;
      unitLabel = metricId === 'degustaciones_bd' ? 'registros' : 'filas';
    }

    const rawSamples = Math.max(
      toSanitizedNonNegative(v.tastedUnits, 0),
      toSanitizedNonNegative(sup?.currentSamples, 0)
    );

    return {
      id: v.id,
      ymd,
      dayLabel: v.dayLabel || ymd || 'Sin fecha',
      shift: v.shift || sup?.shift || 'MAÑANA',
      storeName: String(v.storeName || sup?.storeName || 'PDV Sin Nombre').trim(),
      clienteCodigo: sup?.clienteCodigo,
      zone: String(v.zone || sup?.zone || 'Zulia').trim(),
      productName: String(sup?.productName || v.fillProductSelection || v.productFocus || 'Portafolio Codizulca').trim(),
      promotora: String(v.promotoraName || sup?.responsibleName || 'SIN ASIGNAR').trim() || 'SIN ASIGNAR',
      seller:
        String(v.sellerName || sup?.sellerApplicant || 'SIN VENDEDOR')
          .replace(/\s*\(Vendedor\s*FDV\)\s*/gi, '')
          .trim() || 'SIN VENDEDOR',
      primaryQty,
      unitLabel,
      mortadelaQty: mortQty,
      espaldaQty: espQty,
      arrozQty: arrQty,
      azucarGrams: azuG,
      lecheGrams: lecG,
      samplesDelivered: Math.round(rawSamples),
      shelfMovedUnits: Math.round(toSanitizedNonNegative(v.assistedSalesUnits ?? sup?.salesAssistedCount, 0)),
      rating: null,
      acceptanceLabel:
        sup?.acceptancePercent !== undefined
          ? `${Math.round(clampNumber(sup.acceptancePercent, 0, 100))}%`
          : '',
      ownPriceUsd: null,
      status: String(sup?.status || v.status || 'PROGRAMADO').toUpperCase(),
      mapsUrl: v.mapsUrl || sup?.mapsUrl,
    };

    void isMortadelaRow;
    void isEspaldaRow;
    void isAzucarRow;
    void isLecheRow;
  });

  // En degustaciones_bd incorporamos solicitudes/degustaciones de Supabase aún no volcadas a visits sin duplicar
  const extraTastingRows: Unified360Row[] =
    metricId === 'degustaciones_bd'
      ? lookup.unmatchedItems(visits).map((it) => {
          const ymd = resolveVenezuelaDateYmd(it.date || it.createdAt);
          return {
            id: it.id,
            ymd,
            dayLabel: it.dayLabel || ymd || 'Sin fecha',
            shift: it.shift || 'MAÑANA',
            storeName: String(it.storeName || 'PDV Sin Nombre').trim(),
            clienteCodigo: it.clienteCodigo,
            zone: String(it.zone || 'Zulia').trim(),
            productName: String(it.productName || 'Portafolio Codizulca').trim(),
            promotora: String(it.responsibleName || 'SIN ASIGNAR').trim() || 'SIN ASIGNAR',
            seller:
              String(it.sellerApplicant || 'SIN VENDEDOR')
                .replace(/\s*\(Vendedor\s*FDV\)\s*/gi, '')
                .trim() || 'SIN VENDEDOR',
            primaryQty: 1,
            unitLabel: 'registros',
            mortadelaQty: toSanitizedNonNegative(it.mortadelaQty, 0),
            espaldaQty: toSanitizedNonNegative(it.espaldaQty, 0),
            arrozQty: toSanitizedNonNegative(it.arrozQty, 0),
            azucarGrams: toSanitizedNonNegative(it.azucarGrams, 0),
            lecheGrams: toSanitizedNonNegative(it.lecheGrams, 0),
            samplesDelivered: Math.round(toSanitizedNonNegative(it.currentSamples, 0)),
            shelfMovedUnits: Math.round(toSanitizedNonNegative(it.salesAssistedCount, 0)),
            rating: null,
            acceptanceLabel:
              it.acceptancePercent !== undefined
                ? `${Math.round(clampNumber(it.acceptancePercent, 0, 100))}%`
                : '',
            ownPriceUsd: null,
            status: String(it.status || 'PENDIENTE').toUpperCase(),
            mapsUrl: it.mapsUrl,
          };
        })
      : [];

  const combined = [...fromVisits, ...extraTastingRows];

  return combined.filter((row) => {
    const pUpper = stripDiacriticsUpper(row.productName);
    switch (metricId) {
      case 'mortadela':
        return row.mortadelaQty > 0 || (row.primaryQty > 0 && (pUpper.includes('MORTADELA') || pUpper.includes('JAMON')));
      case 'vencampo':
        return row.arrozQty > 0 || pUpper.includes('VENCAMPO') || pUpper.includes('ARROZ');
      case 'azucar':
        return row.azucarGrams > 0 || (row.primaryQty > 0 && pUpper.includes('AZUCAR'));
      case 'leche':
        return row.lecheGrams > 0 || (row.primaryQty > 0 && pUpper.includes('LECHE'));
      case 'espalda':
        return row.espaldaQty > 0 || (row.primaryQty > 0 && pUpper.includes('ESPALDA'));
      default:
        return true;
    }
  });
}

function buildRowsForConsumerSurveysAndSampling(params: {
  surveys: ConsumerSurveyRecord[];
  inventory: InventorySamplingRecord[];
  tastingItems: TastingScheduleItem[];
}): Unified360Row[] {
  const { surveys, inventory, tastingItems } = params;

  // Agrupar muestras y rotación reales de inventario por (ymd|storeKey)
  const invByDayStore = new Map<
    string,
    {
      used: boolean;
      samples: number;
      moved: number;
      record: InventorySamplingRecord;
    }
  >();

  inventory.forEach((inv) => {
    const ymd = resolveVenezuelaDateYmd(inv.isoDate || inv.date);
    const sKey = canonicalStoreKey(inv.storeName) || stripDiacriticsUpper(inv.storeName) || inv.id;
    const composite = `${ymd || 'NO_DATE'}|${sKey}`;
    const samples = Math.round(toSanitizedNonNegative(inv.portionsSampled, 0));
    const moved = computeShelfMovedFromInventory(inv);
    const existing = invByDayStore.get(composite);
    if (existing) {
      existing.samples += samples;
      existing.moved += moved;
    } else {
      invByDayStore.set(composite, { used: false, samples, moved, record: inv });
    }
  });

  const surveyRows: Unified360Row[] = surveys.map((s) => {
    const ymd = resolveVenezuelaDateYmd(s.date || s.createdAt);
    const sKey = canonicalStoreKey(s.storeName) || stripDiacriticsUpper(s.storeName) || s.id;
    const composite = `${ymd || 'NO_DATE'}|${sKey}`;
    const matchedInv = invByDayStore.get(composite);
    let attachedSamples = 0;
    let attachedMoved = 0;
    if (matchedInv && !matchedInv.used) {
      matchedInv.used = true;
      attachedSamples = matchedInv.samples;
      attachedMoved = matchedInv.moved;
    }

    return {
      id: s.id,
      ymd,
      dayLabel: s.dayLabel || ymd || 'Sin fecha',
      shift: s.shift || 'MAÑANA',
      storeName: s.storeName || 'PDV Sin Nombre',
      zone: s.zone || 'Zulia',
      productName: s.productName || 'Portafolio Codizulca',
      promotora: s.promotora || 'SIN ASIGNAR',
      seller: s.purchaseIntent ? `Intención: ${s.purchaseIntent}` : 'CONSUMIDOR PDV',
      primaryQty: 1,
      unitLabel: 'encuesta',
      mortadelaQty: 0,
      espaldaQty: 0,
      arrozQty: 0,
      azucarGrams: 0,
      lecheGrams: 0,
      samplesDelivered: attachedSamples,
      shelfMovedUnits: attachedMoved,
      rating: s.rating !== null ? clampNumber(s.rating, 0, 5) : null,
      acceptanceLabel: s.acceptanceLabel || (s.highAcceptance ? 'ALTA' : 'REGISTRADA'),
      ownPriceUsd: null,
      status: `ENCUESTA ${s.surveyType.toUpperCase()}`,
    };
  });

  const standaloneSamplingRows: Unified360Row[] = [];
  invByDayStore.forEach((entry, compositeKey) => {
    if (entry.used) return;
    entry.used = true;
    const inv = entry.record;
    const ymd = resolveVenezuelaDateYmd(inv.isoDate || inv.date);
    standaloneSamplingRows.push({
      id: `inv_pdv_${inv.id}_${compositeKey}`,
      ymd,
      dayLabel: inv.dateSlash || ymd || 'Sin fecha',
      shift: 'MAÑANA',
      storeName: inv.storeName || 'PDV Sin Nombre',
      zone: inv.zone || 'Zulia',
      productName: inv.productName || 'Portafolio Codizulca',
      promotora: inv.promotora || 'SIN ASIGNAR',
      seller: 'MUESTREO INVENTARIO',
      primaryQty: 0,
      unitLabel: 'encuesta',
      mortadelaQty: 0,
      espaldaQty: 0,
      arrozQty: 0,
      azucarGrams: 0,
      lecheGrams: 0,
      samplesDelivered: entry.samples,
      shelfMovedUnits: entry.moved,
      rating: null,
      acceptanceLabel: '',
      ownPriceUsd: null,
      status: 'MUESTREO PDV',
    });
  });

  // Incorporar muestras reportadas en degustaciones FDV/ejecución si esa tienda+día no tenía registro en inventorySampling
  tastingItems.forEach((it) => {
    const samples = Math.round(toSanitizedNonNegative(it.currentSamples, 0));
    const moved = Math.round(toSanitizedNonNegative(it.salesAssistedCount, 0));
    if (samples <= 0 && moved <= 0) return;
    const ymd = resolveVenezuelaDateYmd(it.date || it.createdAt);
    const sKey = canonicalStoreKey(it.storeName, it.clienteCodigo) || stripDiacriticsUpper(it.storeName) || it.id;
    const composite = `${ymd || 'NO_DATE'}|${sKey}`;
    if (invByDayStore.has(composite)) return;

    standaloneSamplingRows.push({
      id: `deg_sample_${it.id}`,
      ymd,
      dayLabel: it.dayLabel || ymd || 'Sin fecha',
      shift: it.shift || 'MAÑANA',
      storeName: it.storeName || 'PDV Sin Nombre',
      clienteCodigo: it.clienteCodigo,
      zone: it.zone || 'Zulia',
      productName: it.productName || 'Portafolio Codizulca',
      promotora: it.responsibleName || 'SIN ASIGNAR',
      seller:
        String(it.sellerApplicant || 'SIN VENDEDOR')
          .replace(/\s*\(Vendedor\s*FDV\)\s*/gi, '')
          .trim() || 'SIN VENDEDOR',
      primaryQty: 0,
      unitLabel: 'encuesta',
      mortadelaQty: 0,
      espaldaQty: 0,
      arrozQty: 0,
      azucarGrams: 0,
      lecheGrams: 0,
      samplesDelivered: samples,
      shelfMovedUnits: moved,
      rating: null,
      acceptanceLabel:
        it.acceptancePercent !== undefined
          ? `${Math.round(clampNumber(it.acceptancePercent, 0, 100))}%`
          : '',
      ownPriceUsd: null,
      status: 'DEGUSTACIÓN EJECUTADA',
    });
  });

  return [...surveyRows, ...standaloneSamplingRows];
}

function attachInventoryAndPricesToScheduleRows(params: {
  rows: Unified360Row[];
  matchingInventory: InventorySamplingRecord[];
  matchingPrices: PriceComparisonThreeBrands[];
}): { reconciledRows: Unified360Row[]; unlinkedAuditRows: Unified360Row[] } {
  const { rows, matchingInventory, matchingPrices } = params;
  const cloned: Unified360Row[] = rows.map((r) => ({ ...r }));

  // Mapa de precio propio promedio por tienda canónica
  const priceByStore = new Map<string, { sum: number; count: number }>();
  matchingPrices.forEach((p) => {
    const own = toSanitizedNonNegative(p.ownPriceUsd, 0);
    if (own <= 0 || own > 35) return;
    const sKey = canonicalStoreKey(p.storeName);
    if (!sKey) return;
    const cur = priceByStore.get(sKey) || { sum: 0, count: 0 };
    cur.sum += own;
    cur.count += 1;
    priceByStore.set(sKey, cur);
  });

  cloned.forEach((r) => {
    const sKey = canonicalStoreKey(r.storeName, r.clienteCodigo);
    if (sKey && priceByStore.has(sKey)) {
      const entry = priceByStore.get(sKey)!;
      r.ownPriceUsd = +safeDiv(entry.sum, entry.count, 0).toFixed(2);
    }
  });

  const unlinkedAuditRows: Unified360Row[] = [];

  matchingInventory.forEach((inv) => {
    const invYmd = resolveVenezuelaDateYmd(inv.isoDate || inv.date);
    const invStoreKey = canonicalStoreKey(inv.storeName);
    const invSamples = Math.round(toSanitizedNonNegative(inv.portionsSampled, 0));
    const invMoved = computeShelfMovedFromInventory(inv);

    // Buscar fila programada exacta (misma fecha + misma tienda), o misma tienda en el período
    const exactTarget = cloned.find(
      (r) =>
        invStoreKey !== null &&
        canonicalStoreKey(r.storeName, r.clienteCodigo) === invStoreKey &&
        r.ymd === invYmd
    );
    const fallbackStoreTarget =
      exactTarget ||
      cloned.find(
        (r) =>
          invStoreKey !== null &&
          canonicalStoreKey(r.storeName, r.clienteCodigo) === invStoreKey
      );

    if (fallbackStoreTarget) {
      fallbackStoreTarget.samplesDelivered = Math.max(
        fallbackStoreTarget.samplesDelivered,
        invSamples
      );
      fallbackStoreTarget.shelfMovedUnits += invMoved;
    } else if (invSamples > 0 || invMoved > 0) {
      const storePrice = invStoreKey ? priceByStore.get(invStoreKey) : undefined;
      unlinkedAuditRows.push({
        id: `audit_inv_${inv.id}`,
        ymd: invYmd,
        dayLabel: inv.dateSlash || invYmd || 'Sin fecha',
        shift: 'MAÑANA',
        storeName: inv.storeName || 'PDV Sin Nombre',
        zone: inv.zone || 'Zulia',
        productName: inv.productName || 'Portafolio Codizulca',
        promotora: inv.promotora || 'SIN ASIGNAR',
        seller: 'REPORTE CAMPO',
        primaryQty: 0,
        unitLabel: cloned[0]?.unitLabel || 'unid',
        mortadelaQty: 0,
        espaldaQty: 0,
        arrozQty: 0,
        azucarGrams: 0,
        lecheGrams: 0,
        samplesDelivered: invSamples,
        shelfMovedUnits: invMoved,
        rating: null,
        acceptanceLabel: '',
        ownPriceUsd: storePrice ? +safeDiv(storePrice.sum, storePrice.count, 0).toFixed(2) : null,
        status: 'MUESTREO CAMPO',
        isAuditSupplementRow: true,
      });
    }
  });

  return { reconciledRows: cloned, unlinkedAuditRows };
}

function computeDynamicSwitcherItems(params: {
  switcherItems: Metric360SwitcherItem[];
  visits: ScheduledVisit[];
  tastingItems: TastingScheduleItem[];
  module1Bundle: Module1SupabaseBundle | null;
  periodBounds: VenezuelaPeriodBounds;
}): Metric360SwitcherItem[] {
  const { switcherItems, visits, tastingItems, module1Bundle, periodBounds } = params;
  const periodVisits = visits.filter((v) => matchesVenezuelaTimeLens(v.date, periodBounds));
  const lookup = buildTastingLookup(tastingItems);
  const periodUnmatchedTastings = lookup
    .unmatchedItems(visits)
    .filter((t) => matchesVenezuelaTimeLens(t.date || t.createdAt, periodBounds));

  const surveysSource = module1Bundle?.consumerSurveys || [];
  const periodSurveys = surveysSource.filter((s) =>
    matchesVenezuelaTimeLens(s.date || s.createdAt, periodBounds)
  );
  const surveysCount =
    surveysSource.length > 0
      ? periodSurveys.length
      : periodBounds.lens === 'GLOBAL'
        ? toSanitizedNonNegative(module1Bundle?.surveySummary.totalSurveys, 0)
        : 0;

  const activeStaffCount = (module1Bundle?.staffMembers || []).filter(
    (s) => s.status === 'Activo'
  ).length;

  return switcherItems.map((sw) => {
    switch (sw.id) {
      case 'mortadela': {
        const sum = periodVisits.reduce(
          (acc, v) => acc + toSanitizedNonNegative(v.mortadelaQty, 0),
          0
        );
        return { ...sw, badgeValue: `${sum} un` };
      }
      case 'espalda': {
        const sum = periodVisits.reduce(
          (acc, v) => acc + toSanitizedNonNegative(v.espaldaQty, 0),
          0
        );
        return { ...sw, badgeValue: `${sum} un` };
      }
      case 'vencampo': {
        const usesStands = sw.badgeValue.toLowerCase().includes('stand') || sw.label.toLowerCase().includes('stand');
        if (usesStands) {
          const stands = periodVisits.filter((v) => {
            const p = stripDiacriticsUpper(`${v.fillProductSelection || ''} ${v.productFocus || ''}`);
            return toSanitizedNonNegative(v.arrozQty, 0) > 0 || p.includes('VENCAMPO') || p.includes('ARROZ');
          }).length;
          return { ...sw, badgeValue: `${stands} stands` };
        }
        const units = periodVisits.reduce(
          (acc, v) => acc + toSanitizedNonNegative(v.arrozQty, 0),
          0
        );
        return { ...sw, badgeValue: `${units} un` };
      }
      case 'azucar': {
        const grams = periodVisits.reduce(
          (acc, v) => acc + toSanitizedNonNegative(v.azucarGrams, 0),
          0
        );
        return { ...sw, badgeValue: `${grams} g` };
      }
      case 'leche': {
        const grams = periodVisits.reduce(
          (acc, v) => acc + toSanitizedNonNegative(v.lecheGrams, 0),
          0
        );
        return { ...sw, badgeValue: `${grams} g` };
      }
      case 'matriz_pdv':
        return { ...sw, badgeValue: `${periodVisits.length} filas` };
      case 'degustaciones_bd': {
        const total = periodVisits.length + periodUnmatchedTastings.length;
        return { ...sw, badgeValue: `${total}` };
      }
      case 'encuestas_pdv':
        return { ...sw, badgeValue: `${surveysCount}` };
      case 'personal_activo':
        return { ...sw, badgeValue: activeStaffCount > 0 ? `${activeStaffCount}` : sw.badgeValue };
      default:
        return sw;
    }
  });
}

export function computeMetric360Snapshot(params: {
  metricId: Metric360Id;
  timeLens: Metric360TimeLens;
  switcherItems: Metric360SwitcherItem[];
  visits: ScheduledVisit[];
  tastingItems?: TastingScheduleItem[];
  module1Bundle: Module1SupabaseBundle | null;
  liveClock: LiveVenezuelaClock;
  btlUnitCostUsd: number;
}): Metric360Snapshot {
  const {
    metricId,
    timeLens,
    switcherItems,
    visits,
    tastingItems,
    module1Bundle,
    liveClock,
    btlUnitCostUsd,
  } = params;

  const effectiveTastings = tastingItems || module1Bundle?.tastingItems || [];
  const periodBounds = getVenezuelaPeriodBounds(liveClock, timeLens);

  const vencampoSwitcher = switcherItems.find((s) => s.id === 'vencampo');
  const vencampoBadgeMode: 'stands' | 'units' =
    vencampoSwitcher &&
    (vencampoSwitcher.badgeValue.toLowerCase().includes('stand') ||
      vencampoSwitcher.label.toLowerCase().includes('stand'))
      ? 'stands'
      : 'units';

  const resolvedSwitcherItems = computeDynamicSwitcherItems({
    switcherItems,
    visits,
    tastingItems: effectiveTastings,
    module1Bundle,
    periodBounds,
  });

  // Precios e Inventario filtrados por línea de producto y período en Venezuela (UTC-4)
  const matchingPrices: PriceComparisonThreeBrands[] = (module1Bundle?.priceComparisons || []).filter(
    (pc) =>
      matchesProductLineForSupabase(metricId, `${pc.ownProduct} ${pc.category}`) &&
      matchesVenezuelaTimeLens(pc.date, periodBounds)
  );

  const allInventoryForMetric: InventorySamplingRecord[] = (
    module1Bundle?.inventorySampling || []
  ).filter((inv) => matchesProductLineForSupabase(metricId, inv.productName));

  const matchingInventory: InventorySamplingRecord[] = allInventoryForMetric.filter((inv) =>
    matchesVenezuelaTimeLens(inv.isoDate || inv.date, periodBounds)
  );

  // Encuestas de consumidor filtradas por producto (si aplica) y período en Venezuela (UTC-4)
  const allSurveysForMetric: ConsumerSurveyRecord[] = (
    module1Bundle?.consumerSurveys || []
  ).filter((s) =>
    metricId === 'encuestas_pdv'
      ? true
      : matchesProductLineForSupabase(metricId, s.productName)
  );

  const periodSurveys: ConsumerSurveyRecord[] = allSurveysForMetric.filter((s) =>
    matchesVenezuelaTimeLens(s.date || s.createdAt, periodBounds)
  );

  const surveyMetrics: ConsumerSurveyPeriodMetrics =
    (module1Bundle?.consumerSurveys || []).length > 0 || timeLens !== 'GLOBAL'
      ? computeSurveyPeriodMetrics(periodSurveys)
      : {
          totalSurveys: toSanitizedNonNegative(module1Bundle?.surveySummary.totalSurveys, 0),
          breveCount: toSanitizedNonNegative(module1Bundle?.surveySummary.breveCount, 0),
          profundaCount: toSanitizedNonNegative(module1Bundle?.surveySummary.profundaCount, 0),
          ratedCount: toSanitizedNonNegative(module1Bundle?.surveySummary.totalSurveys, 0),
          avgRating: clampNumber(module1Bundle?.surveySummary.avgRating, 0, 5, 0),
          highAcceptanceCount: Math.round(
            (toSanitizedNonNegative(module1Bundle?.surveySummary.totalSurveys, 0) *
              clampNumber(module1Bundle?.surveySummary.highAcceptancePercent, 0, 100, 0)) /
              100
          ),
          highAcceptancePercent: Math.round(
            clampNumber(module1Bundle?.surveySummary.highAcceptancePercent, 0, 100, 0)
          ),
        };

  let allRowsForRolling: Unified360Row[] = [];
  let lensFilteredRows: Unified360Row[] = [];
  let csvExportRows: Unified360Row[] = [];

  if (metricId === 'encuestas_pdv') {
    allRowsForRolling = buildRowsForConsumerSurveysAndSampling({
      surveys: allSurveysForMetric,
      inventory: allInventoryForMetric,
      tastingItems: effectiveTastings,
    });

    const periodTastings = effectiveTastings.filter((t) =>
      matchesVenezuelaTimeLens(t.date || t.createdAt, periodBounds)
    );
    const baseSurveyAndSampleRows = buildRowsForConsumerSurveysAndSampling({
      surveys: periodSurveys,
      inventory: matchingInventory,
      tastingItems: periodTastings,
    });

    // Anexar precio propio promedio por tienda si existe auditoría de precios en el período
    const priceByStore = new Map<string, { sum: number; count: number }>();
    matchingPrices.forEach((p) => {
      const own = toSanitizedNonNegative(p.ownPriceUsd, 0);
      if (own <= 0 || own > 35) return;
      const sKey = canonicalStoreKey(p.storeName);
      if (!sKey) return;
      const cur = priceByStore.get(sKey) || { sum: 0, count: 0 };
      cur.sum += own;
      cur.count += 1;
      priceByStore.set(sKey, cur);
    });

    lensFilteredRows = baseSurveyAndSampleRows.map((r) => {
      const sKey = canonicalStoreKey(r.storeName, r.clienteCodigo);
      const stPrice = sKey ? priceByStore.get(sKey) : undefined;
      return {
        ...r,
        ownPriceUsd: stPrice ? +safeDiv(stPrice.sum, stPrice.count, 0).toFixed(2) : null,
      };
    });
    csvExportRows = lensFilteredRows;
  } else {
    allRowsForRolling = buildRowsForScheduleOrProductMetric({
      metricId,
      visits,
      tastingItems: effectiveTastings,
      vencampoBadgeMode,
    });
    const rawPeriodRows = allRowsForRolling.filter((r) =>
      matchesVenezuelaTimeLens(r.ymd, periodBounds)
    );
    const { reconciledRows, unlinkedAuditRows } = attachInventoryAndPricesToScheduleRows({
      rows: rawPeriodRows,
      matchingInventory,
      matchingPrices,
    });
    lensFilteredRows = reconciledRows;
    csvExportRows = [...reconciledRows, ...unlinkedAuditRows];
  }

  const totalMatrixRows = visits.filter((v) => matchesVenezuelaTimeLens(v.date, periodBounds)).length;
  const totalPrimaryQty = lensFilteredRows.reduce(
    (acc, r) => acc + toSanitizedNonNegative(r.primaryQty, 0),
    0
  );
  const totalActivations = lensFilteredRows.length;
  const matrixSharePct =
    totalMatrixRows > 0
      ? Math.round(clampNumber(safePct(totalActivations, totalMatrixRows, 0), 0, 100))
      : 0;

  // Deduplicación estricta por Set canónico (excluyendo placeholders vacíos)
  const uniqueStoreKeys = new Set<string>();
  const uniqueZoneKeys = new Set<string>();
  csvExportRows.forEach((r) => {
    const sKey = canonicalStoreKey(r.storeName, r.clienteCodigo);
    if (sKey) uniqueStoreKeys.add(sKey);
    const zKey = canonicalZoneKey(r.zone);
    if (zKey) uniqueZoneKeys.add(zKey);
  });

  const morningCount = lensFilteredRows.filter((r) => r.shift === 'MAÑANA').length;
  const afternoonCount = lensFilteredRows.filter((r) => r.shift === 'TARDE').length;

  const completedCount = lensFilteredRows.filter((r) => {
    const st = r.status.toUpperCase();
    return (
      st.includes('COMPLETAD') ||
      st.startsWith('ENCUESTA ') ||
      st === 'MUESTREO PDV' ||
      st === 'DEGUSTACIÓN EJECUTADA' ||
      Boolean(r.ymd && r.ymd < liveClock.todayYmd && st !== 'PENDIENTE')
    );
  }).length;
  const pendingCount = lensFilteredRows.filter((r) => r.status.toUpperCase() === 'PENDIENTE').length;
  const completionPct =
    totalActivations > 0
      ? Math.round(clampNumber(safePct(completedCount, totalActivations, 0), 0, 100))
      : 0;

  // Muestras y Rotación 100% reconciliadas con csvExportRows (SUM(CSV) === KPI)
  const totalSamples = Math.round(
    csvExportRows.reduce((acc, r) => acc + toSanitizedNonNegative(r.samplesDelivered, 0), 0)
  );
  const shelfMovedUnits = Math.round(
    csvExportRows.reduce((acc, r) => acc + toSanitizedNonNegative(r.shelfMovedUnits, 0), 0)
  );

  // Precios propios vs competencia (filtrando outliers > $35 en Bs)
  const validOwnPrices = matchingPrices.filter((p) => {
    const own = toSanitizedNonNegative(p.ownPriceUsd, 0);
    return own > 0 && own <= 35;
  });
  const validPairedPrices = validOwnPrices.filter((p) => {
    const comp = toSanitizedNonNegative(p.averageCompetitorPriceUsd, 0);
    return comp > 0 && comp <= 35;
  });

  const avgOwnPrice =
    validOwnPrices.length > 0
      ? +safeDiv(
          validOwnPrices.reduce((s, p) => s + toSanitizedNonNegative(p.ownPriceUsd, 0), 0),
          validOwnPrices.length,
          0
        ).toFixed(2)
      : 0;

  const avgCompPrice =
    validPairedPrices.length > 0
      ? +safeDiv(
          validPairedPrices.reduce(
            (s, p) => s + toSanitizedNonNegative(p.averageCompetitorPriceUsd, 0),
            0
          ),
          validPairedPrices.length,
          0
        ).toFixed(2)
      : 0;

  const pairedAvgOwn =
    validPairedPrices.length > 0
      ? safeDiv(
          validPairedPrices.reduce((s, p) => s + toSanitizedNonNegative(p.ownPriceUsd, 0), 0),
          validPairedPrices.length,
          0
        )
      : 0;

  const priceGapPct =
    pairedAvgOwn > 0 && avgCompPrice > 0
      ? +safePct(pairedAvgOwn - avgCompPrice, avgCompPrice, 0).toFixed(1)
      : null;

  const btlUnitsForCost =
    metricId === 'azucar' || metricId === 'leche' ? totalPrimaryQty / 1000 : totalPrimaryQty;
  const estimatedBtlCostUsd = +(btlUnitsForCost * toSanitizedNonNegative(btlUnitCostUsd, 0)).toFixed(2);

  // Top PDVs deduplicados canónicamente
  const storeMap = new Map<
    string,
    { name: string; zone: string; qty: number; count: number; samples: number; mapsUrl?: string }
  >();
  csvExportRows.forEach((r) => {
    const key = canonicalStoreKey(r.storeName, r.clienteCodigo);
    if (!key) return;
    const cur = storeMap.get(key) || {
      name: r.storeName,
      zone: r.zone,
      qty: 0,
      count: 0,
      samples: 0,
      mapsUrl: r.mapsUrl,
    };
    cur.qty += toSanitizedNonNegative(r.primaryQty, 0);
    if (!r.isAuditSupplementRow) cur.count += 1;
    cur.samples += toSanitizedNonNegative(r.samplesDelivered, 0);
    if (!cur.mapsUrl && r.mapsUrl) cur.mapsUrl = r.mapsUrl;
    storeMap.set(key, cur);
  });
  const topStores = Array.from(storeMap.values())
    .sort((a, b) => b.qty - a.qty || b.samples - a.samples || b.count - a.count)
    .slice(0, 7);

  // Top Zonas deduplicadas canónicamente
  const zoneMap = new Map<string, { zone: string; pdvSet: Set<string>; qty: number }>();
  csvExportRows.forEach((r) => {
    const zKey = canonicalZoneKey(r.zone);
    if (!zKey) return;
    const cur = zoneMap.get(zKey) || { zone: r.zone.trim(), pdvSet: new Set<string>(), qty: 0 };
    const sKey = canonicalStoreKey(r.storeName, r.clienteCodigo) || r.id;
    cur.pdvSet.add(sKey);
    cur.qty += toSanitizedNonNegative(r.primaryQty, 0);
    zoneMap.set(zKey, cur);
  });
  const topZones = Array.from(zoneMap.values())
    .map((z) => ({ zone: z.zone, qty: z.qty, count: z.pdvSet.size }))
    .sort((a, b) => b.count - a.count || b.qty - a.qty)
    .slice(0, 6);

  // Top Promotoras
  const promMap = new Map<string, { name: string; qty: number; count: number; samples: number }>();
  csvExportRows.forEach((r) => {
    const clean = stripDiacriticsUpper(r.promotora) || 'SIN ASIGNAR';
    const cur = promMap.get(clean) || {
      name: r.promotora.trim() || 'SIN ASIGNAR',
      qty: 0,
      count: 0,
      samples: 0,
    };
    cur.qty += toSanitizedNonNegative(r.primaryQty, 0);
    if (!r.isAuditSupplementRow) cur.count += 1;
    cur.samples += toSanitizedNonNegative(r.samplesDelivered, 0);
    promMap.set(clean, cur);
  });
  const topPromotoras = Array.from(promMap.values())
    .sort((a, b) => b.count - a.count || b.qty - a.qty || b.samples - a.samples)
    .slice(0, 7);

  // Top Vendedores FDV / Intención
  const sellerMap = new Map<string, { name: string; qty: number; count: number }>();
  lensFilteredRows.forEach((r) => {
    const clean = stripDiacriticsUpper(r.seller) || 'SIN VENDEDOR';
    const cur = sellerMap.get(clean) || {
      name: r.seller.trim() || 'SIN VENDEDOR',
      qty: 0,
      count: 0,
    };
    cur.qty += toSanitizedNonNegative(r.primaryQty, 0);
    cur.count += 1;
    sellerMap.set(clean, cur);
  });
  const topSellers = Array.from(sellerMap.values())
    .sort((a, b) => b.count - a.count || b.qty - a.qty)
    .slice(0, 7);

  // Evolución Semanal Automática en Venezuela (Lunes 00:00:00.000 - Domingo 23:59:59.999)
  const rollingWeeks: RollingWeek360Point[] = [-4, -3, -2, -1, 0, 1].map((offset) => {
    const win = getRollingWeekWindow(liveClock.todayYmd, offset);
    const weekRows = allRowsForRolling.filter(
      (r) => r.ymd !== null && r.ymd >= win.mondayYmd && r.ymd <= win.sundayYmd
    );
    const qty = weekRows.reduce((s, r) => s + toSanitizedNonNegative(r.primaryQty, 0), 0);
    const samples = weekRows.reduce((s, r) => s + toSanitizedNonNegative(r.samplesDelivered, 0), 0);
    const pdvSet = new Set<string>();
    weekRows.forEach((r) => {
      const k = canonicalStoreKey(r.storeName, r.clienteCodigo);
      if (k) pdvSet.add(k);
    });
    return {
      offset,
      isoWeekNumber: win.isoWeekNumber,
      shortRangeLabel: win.shortRangeLabel,
      rangeLabel: win.rangeLabel,
      isCurrentWeek: win.isCurrentWeek,
      isFutureWeek: offset > 0,
      activationsCount: weekRows.length,
      qty,
      pdvs: pdvSet.size,
      samples,
    };
  });

  const portfolioMix = {
    mortadela: lensFilteredRows.reduce((s, r) => s + toSanitizedNonNegative(r.mortadelaQty, 0), 0),
    vencampoStands: lensFilteredRows.filter(
      (r) =>
        toSanitizedNonNegative(r.arrozQty, 0) > 0 ||
        stripDiacriticsUpper(r.productName).includes('VENCAMPO')
    ).length,
    vencampoUnits: lensFilteredRows.reduce((s, r) => s + toSanitizedNonNegative(r.arrozQty, 0), 0),
    espalda: lensFilteredRows.reduce((s, r) => s + toSanitizedNonNegative(r.espaldaQty, 0), 0),
    azucarKg: +(
      lensFilteredRows.reduce((s, r) => s + toSanitizedNonNegative(r.azucarGrams, 0), 0) / 1000
    ).toFixed(2),
    lecheKg: +(
      lensFilteredRows.reduce((s, r) => s + toSanitizedNonNegative(r.lecheGrams, 0), 0) / 1000
    ).toFixed(2),
  };

  return {
    periodBounds,
    lensFilteredRows,
    csvExportRows,
    matchingPrices,
    matchingInventory,
    surveyMetrics,
    resolvedSwitcherItems,
    totalPrimaryQty,
    totalActivations,
    matrixSharePct,
    uniqueStoresCount: uniqueStoreKeys.size,
    uniqueZonesCount: uniqueZoneKeys.size,
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
}

/**
 * Escapa de forma segura una celda CSV para Excel/LibreOffice:
 * - Neutraliza CSV Formula Injection cuando la cadena (o su primer carácter no blanco) inicia con =, +, -, @, \t, \r o \n.
 * - Duplica comillas dobles internas ("").
 */
export function escapeSafeCsvCell(value: string | number | null | undefined): string {
  let s = String(value ?? '');
  if (/^[\t\r\n=+\-@]/.test(s) || /^\s+[=+\-@]/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Genera el contenido CSV completo con BOM UTF-8 (\uFEFF) garantizando que la suma de sus columnas
 * coincida exactamente con los KPIs mostrados en pantalla.
 */
export function buildMetric360CsvContent(rows: ReadonlyArray<Unified360Row>): string {
  const header =
    'FECHA,DIA,JORNADA,CLIENTE_PDV,ZONA,PRODUCTO,CANTIDAD_METRICA,UNIDAD,PROMOTORA,VENDEDOR_O_ORIGEN,MUESTRAS,ROTACION_UN,CALIFICACION,ACEPTACION,PRECIO_PROM_USD,ESTADO\r\n';

  const body = rows
    .map((r) => {
      const safeQty = toSanitizedNonNegative(r.primaryQty, 0);
      const safeSamples = Math.round(toSanitizedNonNegative(r.samplesDelivered, 0));
      const safeMoved = Math.round(toSanitizedNonNegative(r.shelfMovedUnits, 0));
      const ratingStr =
        r.rating !== null && Number.isFinite(r.rating) ? clampNumber(r.rating, 0, 5).toFixed(2) : '';
      const priceStr =
        r.ownPriceUsd !== null && Number.isFinite(r.ownPriceUsd) && r.ownPriceUsd > 0
          ? r.ownPriceUsd.toFixed(2)
          : '';

      return [
        escapeSafeCsvCell(r.ymd || r.dayLabel),
        escapeSafeCsvCell(r.dayLabel),
        escapeSafeCsvCell(r.shift),
        escapeSafeCsvCell(r.storeName),
        escapeSafeCsvCell(r.zone),
        escapeSafeCsvCell(r.productName),
        safeQty,
        escapeSafeCsvCell(r.unitLabel),
        escapeSafeCsvCell(r.promotora),
        escapeSafeCsvCell(r.seller),
        safeSamples,
        safeMoved,
        ratingStr,
        escapeSafeCsvCell(r.acceptanceLabel),
        priceStr,
        escapeSafeCsvCell(r.status),
      ].join(',');
    })
    .join('\r\n');

  return `\uFEFF${header}${body}`;
}
