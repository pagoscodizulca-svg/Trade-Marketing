/**
 * Motor Matemático Bimonetario Inmutable (USD / VES - BCV) y Analítica de Precios.
 *
 * Reglas de negocio:
 *  - Los montos capturados en campo (USD o VES) se conservan intactos.
 *  - Toda comparación entre marcas y toda serie histórica se normaliza a USD
 *    utilizando el snapshot inmutable `tasa_bcv_aplicada` del día de captura.
 *  - La caída porcentual de un competidor se calcula como:
 *      ((precioAnteriorUsd - precioActualUsd) / precioAnteriorUsd) * 100
 *    (valor positivo = el competidor bajó su precio en USD).
 */

export type PriceCurrency = 'USD' | 'VES';

export type PriceAlertSeverity = 'baja' | 'media' | 'alta' | 'critica';

export interface NormalizedCompetitorPriceEntry {
  brand: string;
  originalPrice: number;
  currency: PriceCurrency;
  priceUsd: number;
  priceBs: number | null;
  gapUsd: number;
  gapPercent: number;
}

export interface BimonetaryNormalizationResult {
  ownCurrency: PriceCurrency;
  ownOriginalPrice: number;
  ownPriceUsd: number;
  ownPriceBs: number | null;
  primaryCompetitorCurrency: PriceCurrency;
  primaryCompetitorOriginalPrice: number;
  primaryCompetitorPriceUsd: number;
  primaryCompetitorPriceBs: number | null;
  bcvRateApplied: number | null;
  brechaUsd: number;
  brechaPorcentaje: number;
  competitorsMeta: NormalizedCompetitorPriceEntry[];
}

export function normalizeCurrencyCode(raw: unknown): PriceCurrency {
  const token = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (
    token === 'VES' ||
    token === 'BS' ||
    token === 'BS.' ||
    token === 'BS.S' ||
    token === 'BS.D' ||
    token === 'BOLIVARES' ||
    token === 'BOLÍVARES'
  ) {
    return 'VES';
  }
  return 'USD';
}

export function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/**
 * Convierte un monto en USD o VES a su equivalente exacto en USD y VES usando la tasa BCV.
 * Falla explícitamente si la moneda es VES y no existe una tasa BCV válida (> 0).
 */
export function convertAmountBimonetary(params: {
  amount: number;
  currency: PriceCurrency;
  bcvRate: number | null | undefined;
}): {
  originalPrice: number;
  currency: PriceCurrency;
  priceUsd: number;
  priceBs: number | null;
} {
  const cleanAmount = Number(params.amount);
  const safeAmount = Number.isFinite(cleanAmount) && cleanAmount > 0 ? round4(cleanAmount) : 0;
  const rate =
    params.bcvRate !== null &&
    params.bcvRate !== undefined &&
    Number.isFinite(Number(params.bcvRate)) &&
    Number(params.bcvRate) > 0
      ? round4(Number(params.bcvRate))
      : null;

  if (safeAmount <= 0) {
    return {
      originalPrice: 0,
      currency: params.currency,
      priceUsd: 0,
      priceBs: rate !== null ? 0 : null,
    };
  }

  if (params.currency === 'VES') {
    if (rate === null) {
      throw new Error(
        'Se requiere una tasa BCV oficial válida (> 0) para convertir precios en Bolívares (VES) a USD.'
      );
    }
    return {
      originalPrice: round2(safeAmount),
      currency: 'VES',
      priceUsd: round4(safeAmount / rate),
      priceBs: round2(safeAmount),
    };
  }

  return {
    originalPrice: round4(safeAmount),
    currency: 'USD',
    priceUsd: round4(safeAmount),
    priceBs: rate !== null ? round2(safeAmount * rate) : null,
  };
}

/**
 * Calcula la brecha entre precio propio y competidor en USD normalizados:
 *  - `brechaUsd = ownPriceUsd - competitorPriceUsd` (negativo = Codizulca es más económico)
 *  - `brechaPorcentaje = ((ownPriceUsd - competitorPriceUsd) / competitorPriceUsd) * 100`
 */
export function computeBimonetaryGap(
  ownPriceUsd: number,
  competitorPriceUsd: number
): { brechaUsd: number; brechaPorcentaje: number } {
  if (
    !Number.isFinite(ownPriceUsd) ||
    !Number.isFinite(competitorPriceUsd) ||
    ownPriceUsd <= 0 ||
    competitorPriceUsd <= 0
  ) {
    return { brechaUsd: 0, brechaPorcentaje: 0 };
  }
  const brechaUsd = round4(ownPriceUsd - competitorPriceUsd);
  const brechaPorcentaje = round2(((ownPriceUsd - competitorPriceUsd) / competitorPriceUsd) * 100);
  return { brechaUsd, brechaPorcentaje };
}

/**
 * Normaliza un formulario completo de captura bimonetaria (propio + hasta 3 competidores mixtos)
 * produciendo un snapshot matemáticamente consistente e inmutable.
 */
export function normalizePriceSurveyBimonetary(params: {
  ownPrice: number;
  ownCurrency: PriceCurrency;
  bcvRate: number | null | undefined;
  competitors: ReadonlyArray<{
    name: string;
    price: number;
    currency: PriceCurrency;
  }>;
}): BimonetaryNormalizationResult {
  const rate =
    params.bcvRate !== null &&
    params.bcvRate !== undefined &&
    Number.isFinite(Number(params.bcvRate)) &&
    Number(params.bcvRate) > 0
      ? round4(Number(params.bcvRate))
      : null;

  const own = convertAmountBimonetary({
    amount: params.ownPrice,
    currency: params.ownCurrency,
    bcvRate: rate,
  });

  const competitorsMeta: NormalizedCompetitorPriceEntry[] = [];
  for (const comp of params.competitors) {
    const brand = String(comp.name ?? '').trim();
    const numericPrice = Number(comp.price);
    if (!brand || !Number.isFinite(numericPrice) || numericPrice <= 0) continue;

    const conv = convertAmountBimonetary({
      amount: numericPrice,
      currency: comp.currency,
      bcvRate: rate,
    });
    const gap = computeBimonetaryGap(own.priceUsd, conv.priceUsd);
    competitorsMeta.push({
      brand,
      originalPrice: conv.originalPrice,
      currency: conv.currency,
      priceUsd: conv.priceUsd,
      priceBs: conv.priceBs,
      gapUsd: gap.brechaUsd,
      gapPercent: gap.brechaPorcentaje,
    });
  }

  const primary = competitorsMeta[0];
  const primaryGap = primary
    ? computeBimonetaryGap(own.priceUsd, primary.priceUsd)
    : { brechaUsd: 0, brechaPorcentaje: 0 };

  return {
    ownCurrency: own.currency,
    ownOriginalPrice: own.originalPrice,
    ownPriceUsd: own.priceUsd,
    ownPriceBs: own.priceBs,
    primaryCompetitorCurrency: primary?.currency ?? 'USD',
    primaryCompetitorOriginalPrice: primary?.originalPrice ?? 0,
    primaryCompetitorPriceUsd: primary?.priceUsd ?? 0,
    primaryCompetitorPriceBs: primary?.priceBs ?? (rate !== null ? 0 : null),
    bcvRateApplied: rate,
    brechaUsd: primaryGap.brechaUsd,
    brechaPorcentaje: primaryGap.brechaPorcentaje,
    competitorsMeta,
  };
}

/**
 * Clasifica la severidad de una caída porcentual de precio de un competidor respecto al umbral X%.
 */
export function classifyPriceDropSeverity(
  dropPercent: number,
  thresholdPercent: number
): PriceAlertSeverity {
  if (dropPercent >= Math.max(thresholdPercent * 2, 25)) return 'critica';
  if (dropPercent >= Math.max(thresholdPercent * 1.5, 15)) return 'alta';
  if (dropPercent >= thresholdPercent) return 'media';
  return 'baja';
}

/**
 * Evalúa si un competidor bajó su precio en USD normalizado más de `thresholdPercent` (X%).
 */
export function evaluateCompetitorPriceDrop(params: {
  previousPriceUsd: number;
  currentPriceUsd: number;
  thresholdPercent: number;
}): {
  triggered: boolean;
  dropPercent: number;
  severity: PriceAlertSeverity;
} {
  const prev = Number(params.previousPriceUsd);
  const curr = Number(params.currentPriceUsd);
  const threshold = Number(params.thresholdPercent);

  if (
    !Number.isFinite(prev) ||
    !Number.isFinite(curr) ||
    !Number.isFinite(threshold) ||
    prev <= 0 ||
    curr <= 0 ||
    threshold <= 0
  ) {
    return { triggered: false, dropPercent: 0, severity: 'baja' };
  }

  if (curr >= prev) {
    return { triggered: false, dropPercent: 0, severity: 'baja' };
  }

  const dropPercent = round2(((prev - curr) / prev) * 100);
  const triggered = dropPercent >= threshold;
  return {
    triggered,
    dropPercent,
    severity: classifyPriceDropSeverity(dropPercent, threshold),
  };
}

/**
 * Obtiene la fecha YYYY-MM-DD actual en la zona horaria oficial de Venezuela (`America/Caracas`).
 */
export function getCaracasIsoDate(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // Fallback UTC-4 manual
  }
  const shifted = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Valida que una tasa BCV recibida de fuente externa o manual sea finita y esté dentro
 * de un rango operativo razonable para Venezuela (protección contra datos corruptos/NaN/0).
 */
export function isReasonableBcvRate(rate: unknown): rate is number {
  const n = Number(rate);
  return Number.isFinite(n) && n > 10 && n < 100000;
}

export interface PriceEvolutionPoint {
  date: string;
  priceUsd: number;
  originalPrice: number;
  currency: PriceCurrency;
  bcvRate: number | null;
  storeName: string;
  cadena: string;
  zona: string;
  sampleCount: number;
  hasDropAlert?: boolean;
  dropPercent?: number;
}

export interface PriceEvolutionSeries {
  key: string;
  label: string;
  isOwnBrand: boolean;
  color: string;
  points: PriceEvolutionPoint[];
}

const CHART_SERIES_COLORS = [
  '#F59E0B', // amber-500
  '#38BDF8', // sky-400
  '#A855F7', // purple-500
  '#10B981', // emerald-500
  '#F472B6', // pink-400
];

/**
 * Construye series temporales diarias agrupadas en USD normalizado (Codizulca propio +
 * top marcas competidoras) listas para renderizar en `PriceEvolutionChart`.
 */
export function buildPriceEvolutionSeries(
  rows: ReadonlyArray<{
    id?: string;
    date: string;
    storeName: string;
    cadena?: string;
    zone: string;
    ownProduct: string;
    ownPriceUsd: number;
    ownOriginalPrice?: number;
    ownCurrency?: PriceCurrency;
    bcvRate?: number;
    competitorsList?: ReadonlyArray<{
      brand: string;
      priceUsd: number;
      originalPrice?: number;
      currency?: PriceCurrency;
    }>;
  }>,
  alertDropByKey?: ReadonlyMap<string, number>
): { dates: string[]; series: PriceEvolutionSeries[] } {
  if (!rows.length) return { dates: [], series: [] };

  const ownByDate = new Map<
    string,
    {
      sumUsd: number;
      sumOrig: number;
      count: number;
      currency: PriceCurrency;
      bcvRate: number | null;
      storeName: string;
      cadena: string;
      zona: string;
    }
  >();

  const compByBrandDate = new Map<
    string,
    Map<
      string,
      {
        sumUsd: number;
        sumOrig: number;
        count: number;
        currency: PriceCurrency;
        bcvRate: number | null;
        storeName: string;
        cadena: string;
        zona: string;
        maxDrop: number;
      }
    >
  >();

  const allDates = new Set<string>();

  for (const r of rows) {
    const ymd = String(r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    allDates.add(ymd);

    if (r.ownPriceUsd > 0) {
      const prev = ownByDate.get(ymd);
      const orig = r.ownOriginalPrice && r.ownOriginalPrice > 0 ? r.ownOriginalPrice : r.ownPriceUsd;
      if (prev) {
        prev.sumUsd += r.ownPriceUsd;
        prev.sumOrig += orig;
        prev.count += 1;
      } else {
        ownByDate.set(ymd, {
          sumUsd: r.ownPriceUsd,
          sumOrig: orig,
          count: 1,
          currency: r.ownCurrency ?? 'USD',
          bcvRate: r.bcvRate ?? null,
          storeName: r.storeName,
          cadena: r.cadena || r.storeName,
          zona: r.zone,
        });
      }
    }

    for (const c of r.competitorsList ?? []) {
      const brand = String(c.brand || '').trim();
      if (!brand || brand === '—' || !Number.isFinite(c.priceUsd) || c.priceUsd <= 0) continue;
      const brandKey = brand.toUpperCase();
      let dateMap = compByBrandDate.get(brandKey);
      if (!dateMap) {
        dateMap = new Map();
        compByBrandDate.set(brandKey, dateMap);
      }
      const alertLookupKey = `${ymd}|${brandKey}`;
      const alertDrop = alertDropByKey?.get(alertLookupKey) ?? 0;
      const orig = c.originalPrice && c.originalPrice > 0 ? c.originalPrice : c.priceUsd;
      const prev = dateMap.get(ymd);
      if (prev) {
        prev.sumUsd += c.priceUsd;
        prev.sumOrig += orig;
        prev.count += 1;
        prev.maxDrop = Math.max(prev.maxDrop, alertDrop);
      } else {
        dateMap.set(ymd, {
          sumUsd: c.priceUsd,
          sumOrig: orig,
          count: 1,
          currency: c.currency ?? 'USD',
          bcvRate: r.bcvRate ?? null,
          storeName: r.storeName,
          cadena: r.cadena || r.storeName,
          zona: r.zone,
          maxDrop: alertDrop,
        });
      }
    }
  }

  const dates = Array.from(allDates).sort();
  const series: PriceEvolutionSeries[] = [];

  if (ownByDate.size > 0) {
    series.push({
      key: '__OWN__',
      label: 'Codizulca (Propio)',
      isOwnBrand: true,
      color: '#EF4444', // red-500 corporativo
      points: dates
        .filter((d) => ownByDate.has(d))
        .map((d) => {
          const agg = ownByDate.get(d)!;
          return {
            date: d,
            priceUsd: round2(agg.sumUsd / agg.count),
            originalPrice: round2(agg.sumOrig / agg.count),
            currency: agg.currency,
            bcvRate: agg.bcvRate,
            storeName: agg.storeName,
            cadena: agg.cadena,
            zona: agg.zona,
            sampleCount: agg.count,
          };
        }),
    });
  }

  // Ordenar competidores por cantidad de puntos para mostrar los más relevantes (máx. 5)
  const sortedBrands = Array.from(compByBrandDate.entries())
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], 'es'))
    .slice(0, 5);

  sortedBrands.forEach(([brandKey, dateMap], idx) => {
    const friendly = brandKey
      .toLowerCase()
      .replace(/(^|\s)\S/g, (ch) => ch.toUpperCase());
    series.push({
      key: brandKey,
      label: friendly,
      isOwnBrand: false,
      color: CHART_SERIES_COLORS[idx % CHART_SERIES_COLORS.length],
      points: dates
        .filter((d) => dateMap.has(d))
        .map((d) => {
          const agg = dateMap.get(d)!;
          return {
            date: d,
            priceUsd: round2(agg.sumUsd / agg.count),
            originalPrice: round2(agg.sumOrig / agg.count),
            currency: agg.currency,
            bcvRate: agg.bcvRate,
            storeName: agg.storeName,
            cadena: agg.cadena,
            zona: agg.zona,
            sampleCount: agg.count,
            hasDropAlert: agg.maxDrop > 0,
            dropPercent: agg.maxDrop > 0 ? agg.maxDrop : undefined,
          };
        }),
    });
  });

  return { dates, series };
}
