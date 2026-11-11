import { ControllerRequest, PriceComparisonThreeBrands, ScheduledVisit } from '../types';
import type { TastingScheduleItem } from '../components/field/FieldPromotoraView';
import type { InventorySamplingRecord } from '../services/supabaseModule1';
import { getWeekNumberInMonth } from './monthlyTastingReportPdf';

export type FeasibilityVerdictLevel =
  | 'ALTAMENTE_FACTIBLE'
  | 'FACTIBLE'
  | 'MARGEN_AJUSTADO'
  | 'NO_FACTIBLE'
  | 'SIN_DATOS';

export type FeasibilityReturnBasis = 'VENTAS_DIRECTAS_BTL' | 'SELL_OUT_TOTAL_PDV';

export interface FeasibilityProductLineSpec {
  id: string;
  label: string;
  brand: 'ASTURIAS' | 'VENCAMPO';
  /** Costo estimado en USD por unidad/pieza/kit abierto para degustación */
  tastingUnitCostUsd: number;
  /** Precio unitario comercial de referencia en anaquel (si no hay toma de precio en el período) */
  defaultRetailUnitPriceUsd: number;
  unitLabel: string;
}

export interface ProductFeasibilityRow {
  lineId: string;
  productLine: string;
  brand: 'ASTURIAS' | 'VENCAMPO';
  unitLabel: string;
  activationsCount: number;
  pdvCount: number;
  tastedUnits: number;
  samplesDelivered: number;
  tastedProductCostUsd: number;
  unitSellPriceUsd: number;
  breakEvenUnits: number;
  soldUnits: number;
  generatedRevenueUsd: number;
  netBalanceUsd: number;
  returnMultiplier: number; // Ingreso Generado / Costo Producto Degustado (ej. 3.4x)
  roiPercent: number; // ((Ingreso - Costo) / Costo) * 100
  costToSalesRatioPct: number; // (Costo / Ingreso) * 100
  verdict: FeasibilityVerdictLevel;
  verdictLabel: string;
}

export interface TastingFeasibilityReport {
  periodLabel: string;
  returnBasis: FeasibilityReturnBasis;
  totalActivations: number;
  totalPdvs: number;
  totalTastedUnits: number;
  totalSamplesDelivered: number;
  totalTastedProductCostUsd: number;
  totalBreakEvenUnits: number;
  totalSoldUnits: number;
  totalGeneratedRevenueUsd: number;
  netBalanceUsd: number;
  returnMultiplier: number;
  roiPercent: number;
  costToSalesRatioPct: number;
  costPerSampleUsd: number;
  costPerSoldUnitUsd: number;
  breakEvenCoveragePct: number;
  verdict: FeasibilityVerdictLevel;
  verdictLabel: string;
  verdictRecommendation: string;
  rows: ProductFeasibilityRow[];
}

export interface ParsedFeasibilityDate {
  year: number;
  monthIndex: number;
  day: number;
  yearMonth: string;
  ymd: string;
  weekNumber: number;
}

export function parseFeasibilityDate(raw?: string | null): ParsedFeasibilityDate | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

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

export function classifyFeasibilityProductLine(rawProduct?: string | null): FeasibilityProductLineSpec {
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
      tastingUnitCostUsd: 13.5,
      defaultRetailUnitPriceUsd: 7.35,
      unitLabel: 'Piezas / Unid',
    };
  }
  if (norm.includes('PECHUGA')) {
    return {
      id: 'pechuga_pollo_asturias',
      label: 'Pechuga de Pollo Asturias',
      brand: 'ASTURIAS',
      tastingUnitCostUsd: 13.0,
      defaultRetailUnitPriceUsd: 7.01,
      unitLabel: 'Piezas / Unid',
    };
  }
  if (norm.includes('ESPALDA')) {
    return {
      id: 'espalda_asturias',
      label: 'Espalda Cocida / Ahumada Asturias',
      brand: 'ASTURIAS',
      tastingUnitCostUsd: 12.5,
      defaultRetailUnitPriceUsd: 6.5,
      unitLabel: 'Piezas / Unid',
    };
  }
  if (norm.includes('JAMON') || norm.includes('CHULETA') || norm.includes('TOCINETA')) {
    return {
      id: 'jamon_asturias',
      label: 'Jamón Cocido y Ahumado Asturias',
      brand: 'ASTURIAS',
      tastingUnitCostUsd: 13.5,
      defaultRetailUnitPriceUsd: 7.05,
      unitLabel: 'Piezas / Unid',
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
      tastingUnitCostUsd: 12.0, // Referencia exacta Acta Contraloría MP-07-0067 ($12.00/pieza 1kg)
      defaultRetailUnitPriceUsd: 5.25,
      unitLabel: 'Piezas (1kg)',
    };
  }
  if (norm.includes('AZUCAR')) {
    return {
      id: 'azucar_vencampo',
      label: 'Azúcar Refinada Vencampo (1kg)',
      brand: 'VENCAMPO',
      tastingUnitCostUsd: 2.1,
      defaultRetailUnitPriceUsd: 1.95,
      unitLabel: 'Empaques (1kg)',
    };
  }
  if (norm.includes('ACEITE')) {
    return {
      id: 'aceite_vencampo',
      label: 'Aceite Comestible Vencampo (900ml)',
      brand: 'VENCAMPO',
      tastingUnitCostUsd: 2.85,
      defaultRetailUnitPriceUsd: 2.85,
      unitLabel: 'Unid (900ml)',
    };
  }
  if (norm.includes('LECHE')) {
    return {
      id: 'leche_vencampo',
      label: 'Leche en Polvo Vencampo',
      brand: 'VENCAMPO',
      tastingUnitCostUsd: 8.5,
      defaultRetailUnitPriceUsd: 8.2,
      unitLabel: 'Empaques',
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
      tastingUnitCostUsd: 2.5,
      defaultRetailUnitPriceUsd: 2.45,
      unitLabel: 'Empaques',
    };
  }
  // Si es stand multipropósito "VENCAMPO" vs paquete individual de Arroz
  if (norm === 'VENCAMPO' || norm.includes('KIT') || norm.includes('STAND')) {
    return {
      id: 'arroz_vencampo',
      label: 'Arroz Blanco e Insumos Vencampo',
      brand: 'VENCAMPO',
      tastingUnitCostUsd: 12.5,
      defaultRetailUnitPriceUsd: 2.4,
      unitLabel: 'Kits / Unid',
    };
  }
  return {
    id: 'arroz_vencampo',
    label: 'Arroz Blanco e Insumos Vencampo',
    brand: 'VENCAMPO',
    tastingUnitCostUsd: 2.6,
    defaultRetailUnitPriceUsd: 1.35,
    unitLabel: 'Unid (1kg)',
  };
}

export function resolveFeasibilityVerdict(
  tastedCostUsd: number,
  generatedRevenueUsd: number
): {
  verdict: FeasibilityVerdictLevel;
  verdictLabel: string;
  recommendation: string;
} {
  if (tastedCostUsd <= 0 && generatedRevenueUsd <= 0) {
    return {
      verdict: 'SIN_DATOS',
      verdictLabel: 'SIN EJECUCIÓN EN PERÍODO',
      recommendation: 'Seleccione una semana o temporada con degustaciones registradas para evaluar su factibilidad.',
    };
  }

  const multiplier = tastedCostUsd > 0 ? generatedRevenueUsd / tastedCostUsd : 0;

  if (multiplier >= 2.5) {
    return {
      verdict: 'ALTAMENTE_FACTIBLE',
      verdictLabel: 'ALTAMENTE FACTIBLE',
      recommendation: `Excelente rentabilidad BTL: las ventas superaron ${multiplier.toFixed(2)} veces el costo del producto degustado, cubriendo inversión y aportando margen neto.`,
    };
  }
  if (multiplier >= 1.5) {
    return {
      verdict: 'FACTIBLE',
      verdictLabel: 'FACTIBLE / RENTABLE',
      recommendation: `Activación rentable (${multiplier.toFixed(2)}x): se recuperó el 100% del costo de los productos degustados con superávit comercial saludable.`,
    };
  }
  if (multiplier >= 1.0) {
    return {
      verdict: 'MARGEN_AJUSTADO',
      verdictLabel: 'FACTIBILIDAD AJUSTADA',
      recommendation: `Retorno ajustado (${multiplier.toFixed(2)}x): la venta cubrió el costo del producto degustado pero con bajo margen; optimizar porciones por pieza y cierre de venta en PDV.`,
    };
  }
  return {
    verdict: 'NO_FACTIBLE',
    verdictLabel: 'NO FACTIBLE (DEFICITARIA)',
    recommendation: `Alerta de costo (${multiplier.toFixed(2)}x): el costo del producto degustado superó el retorno en ventas registradas; reasignar PDVs o reducir merma de degustación.`,
  };
}

export interface EvaluateFeasibilityParams {
  periodLabel: string;
  dateMatcher: (parsed: ParsedFeasibilityDate) => boolean;
  brandFilter?: 'TODAS' | 'ASTURIAS' | 'VENCAMPO';
  returnBasis?: FeasibilityReturnBasis;
  tastingItems?: TastingScheduleItem[] | null;
  inventorySampling?: InventorySamplingRecord[] | null;
  priceComparisons?: PriceComparisonThreeBrands[] | null;
  formalRequests?: ControllerRequest[] | null;
  fallbackVisits?: ScheduledVisit[] | null;
}

export function evaluateTastingFeasibility(params: EvaluateFeasibilityParams): TastingFeasibilityReport {
  const {
    periodLabel,
    dateMatcher,
    brandFilter = 'TODAS',
    returnBasis = 'VENTAS_DIRECTAS_BTL',
    tastingItems,
    inventorySampling,
    priceComparisons,
    formalRequests,
    fallbackVisits,
  } = params;

  interface LineWork {
    spec: FeasibilityProductLineSpec;
    activationsCount: number;
    pdvSet: Set<string>;
    tastedUnits: number;
    rawTastedCostUsd: number;
    formalMatchedCostUsd: number;
    formalMatchedUnits: number;
    samplesDelivered: number;
    directAssistedUnits: number;
    shelfSamplingSoldUnits: number;
    totalShelfSoldUnits: number;
    priceSum: number;
    priceCount: number;
  }

  const lineMap = new Map<string, LineWork>();

  const getLine = (rawProduct: string): LineWork | null => {
    const spec = classifyFeasibilityProductLine(rawProduct);
    if (brandFilter !== 'TODAS' && spec.brand !== brandFilter) return null;
    let entry = lineMap.get(spec.id);
    if (!entry) {
      entry = {
        spec,
        activationsCount: 0,
        pdvSet: new Set<string>(),
        tastedUnits: 0,
        rawTastedCostUsd: 0,
        formalMatchedCostUsd: 0,
        formalMatchedUnits: 0,
        samplesDelivered: 0,
        directAssistedUnits: 0,
        shelfSamplingSoldUnits: 0,
        totalShelfSoldUnits: 0,
        priceSum: 0,
        priceCount: 0,
      };
      lineMap.set(spec.id, entry);
    }
    return entry;
  };

  // 1. Precios reales auditados en mercado (primero en el período, luego histórico como respaldo)
  const globalPriceFallback = new Map<string, { sum: number; count: number }>();
  if (priceComparisons && priceComparisons.length > 0) {
    priceComparisons.forEach((pc) => {
      if (!(pc.ownPriceUsd > 0 && pc.ownPriceUsd <= 35)) return;
      const spec = classifyFeasibilityProductLine(pc.ownProduct);
      const gf = globalPriceFallback.get(spec.id) || { sum: 0, count: 0 };
      gf.sum += pc.ownPriceUsd;
      gf.count += 1;
      globalPriceFallback.set(spec.id, gf);

      const p = parseFeasibilityDate(pc.date);
      if (p && dateMatcher(p)) {
        const entry = getLine(pc.ownProduct);
        if (entry) {
          entry.priceSum += pc.ownPriceUsd;
          entry.priceCount += 1;
        }
      }
    });
  }

  // 2. Degustaciones ejecutadas / activas en el período
  const storeDateTastedKeys = new Set<string>();

  if (tastingItems && tastingItems.length > 0) {
    tastingItems.forEach((item) => {
      const p = parseFeasibilityDate(item.date);
      if (!p || !dateMatcher(p)) return;

      const spec = classifyFeasibilityProductLine(item.productName);
      const entry = getLine(item.productName);
      if (!entry) return;

      const rawQty = Number(item.requestedQty) || 1;
      const normUnits =
        rawQty > 30 ? Math.max(0.5, Number((rawQty / 1000).toFixed(2))) : Math.max(1, rawQty);

      const samples = Number(item.currentSamples) > 0 ? Number(item.currentSamples) : 0;

      const directSales =
        Number(item.salesAssistedCount) > 0 ? Number(item.salesAssistedCount) : 0;

      entry.activationsCount += 1;
      entry.tastedUnits += normUnits;
      entry.rawTastedCostUsd += normUnits * spec.tastingUnitCostUsd;
      entry.samplesDelivered += samples;
      entry.directAssistedUnits += directSales;
      if (item.storeName) {
        const normStore = item.storeName.trim().toUpperCase();
        entry.pdvSet.add(normStore);
        storeDateTastedKeys.add(`${p.ymd}__${spec.id}__${normStore}`);
      }
    });
  } else if (fallbackVisits && fallbackVisits.length > 0) {
    fallbackVisits.forEach((v) => {
      const p = parseFeasibilityDate(v.date);
      if (!p || !dateMatcher(p)) return;
      const spec = classifyFeasibilityProductLine(v.productFocus);
      const entry = getLine(v.productFocus);
      if (!entry) return;

      const units = Math.max(0, v.tastedUnits || v.plannedUnits || 0);
      const directSales = Math.max(0, v.assistedSalesUnits || 0);

      if (units <= 0 && directSales <= 0) return;

      entry.activationsCount += 1;
      entry.tastedUnits += units;
      entry.rawTastedCostUsd += units * spec.tastingUnitCostUsd;
      entry.samplesDelivered += 0;
      entry.directAssistedUnits += directSales;
      if (v.storeName) entry.pdvSet.add(v.storeName.trim().toUpperCase());
    });
  }

  // 3. Cruce con Inventario y Degustación en Anaquel (`inventorySampling`)
  if (inventorySampling && inventorySampling.length > 0) {
    inventorySampling.forEach((inv) => {
      const p = parseFeasibilityDate(inv.isoDate || inv.date);
      if (!p || !dateMatcher(p)) return;

      const spec = classifyFeasibilityProductLine(inv.productName);
      if (brandFilter !== 'TODAS' && spec.brand !== brandFilter) return;

      const hasSamplingHere = Number(inv.portionsSampled) > 0;
      const netSold = Math.max(0, Number(inv.salesGenerated) || 0);

      // Solo crear nueva línea si hubo degustación o si ya existe en degustaciones o en modo Sell-Out Total
      if (!hasSamplingHere && !lineMap.has(spec.id) && returnBasis === 'VENTAS_DIRECTAS_BTL') {
        return;
      }

      const entry = getLine(inv.productName);
      if (!entry) return;

      const normStore = (inv.storeName || '').trim().toUpperCase();
      const dedupKey = `${p.ymd}__${spec.id}__${normStore}`;

      entry.totalShelfSoldUnits += netSold;
      if (normStore) entry.pdvSet.add(normStore);

      if (hasSamplingHere) {
        entry.shelfSamplingSoldUnits += netSold;
        // Si esta degustación en inventario no estaba ya registrada en `surveys`, sumar su insumo degustado
        if (!storeDateTastedKeys.has(dedupKey)) {
          const opened = Math.max(1, Number(inv.openedUnits) || Math.ceil(Number(inv.portionsSampled) / 50));
          entry.activationsCount += 1;
          entry.tastedUnits += opened;
          entry.rawTastedCostUsd += opened * spec.tastingUnitCostUsd;
          entry.samplesDelivered += Number(inv.portionsSampled) || 0;
          storeDateTastedKeys.add(dedupKey);
        }
      }
    });
  }

  // 4. Vincular costos reales de Actas Formales de Contraloría (MP-*) cuando caen en el período evaluado
  if (formalRequests && formalRequests.length > 0) {
    formalRequests.forEach((req) => {
      if (req.status === 'RECHAZADO') return;
      const p = parseFeasibilityDate(req.requestDate);
      if (!p || !dateMatcher(p)) return;

      if (req.items && req.items.length > 0) {
        req.items.forEach((it) => {
          const entry = getLine(it.productName);
          if (!entry) return;
          entry.formalMatchedCostUsd += Number(it.totalCostUsd) || 0;
          entry.formalMatchedUnits += Number(it.quantityRequested) || 0;
        });
      } else {
        const entry = getLine(req.campaignOrPurpose);
        if (entry) {
          entry.formalMatchedCostUsd += Number(req.estimatedCostUsd) || 0;
          entry.formalMatchedUnits += Number(req.totalUnits) || 0;
        }
      }
    });
  }

  // 5. Consolidar métricas financieras de factibilidad por línea de producto
  const rows: ProductFeasibilityRow[] = [];

  lineMap.forEach((w) => {
    const tastedProductCostUsd =
      w.formalMatchedCostUsd > 0
        ? Math.max(w.formalMatchedCostUsd, w.rawTastedCostUsd * 0.65)
        : w.rawTastedCostUsd;

    const tastedUnits =
      w.tastedUnits > 0 ? Number(w.tastedUnits.toFixed(1)) : w.formalMatchedUnits;

    if (tastedProductCostUsd <= 0 && w.directAssistedUnits <= 0 && w.shelfSamplingSoldUnits <= 0) {
      return;
    }

    const fallbackPriceObj = globalPriceFallback.get(w.spec.id);
    const unitSellPriceUsd =
      w.priceCount > 0
        ? w.priceSum / w.priceCount
        : fallbackPriceObj && fallbackPriceObj.count > 0
        ? fallbackPriceObj.sum / fallbackPriceObj.count
        : w.spec.defaultRetailUnitPriceUsd;

    const directUnitsBasis = Math.max(w.directAssistedUnits, w.shelfSamplingSoldUnits);
    const soldUnits =
      returnBasis === 'SELL_OUT_TOTAL_PDV'
        ? Math.max(directUnitsBasis, Math.round(w.totalShelfSoldUnits))
        : Math.round(directUnitsBasis);

    const generatedRevenueUsd = soldUnits * unitSellPriceUsd;
    const netBalanceUsd = generatedRevenueUsd - tastedProductCostUsd;
    const breakEvenUnits =
      unitSellPriceUsd > 0 ? Math.ceil(tastedProductCostUsd / unitSellPriceUsd) : 0;

    const returnMultiplier =
      tastedProductCostUsd > 0 ? generatedRevenueUsd / tastedProductCostUsd : 0;
    const roiPercent =
      tastedProductCostUsd > 0
        ? ((generatedRevenueUsd - tastedProductCostUsd) / tastedProductCostUsd) * 100
        : 0;
    const costToSalesRatioPct =
      generatedRevenueUsd > 0 ? (tastedProductCostUsd / generatedRevenueUsd) * 100 : 100;

    const verdictMeta = resolveFeasibilityVerdict(tastedProductCostUsd, generatedRevenueUsd);

    rows.push({
      lineId: w.spec.id,
      productLine: w.spec.label,
      brand: w.spec.brand,
      unitLabel: w.spec.unitLabel,
      activationsCount: w.activationsCount,
      pdvCount: w.pdvSet.size,
      tastedUnits,
      samplesDelivered: Math.round(w.samplesDelivered),
      tastedProductCostUsd,
      unitSellPriceUsd,
      breakEvenUnits,
      soldUnits,
      generatedRevenueUsd,
      netBalanceUsd,
      returnMultiplier,
      roiPercent,
      costToSalesRatioPct,
      verdict: verdictMeta.verdict,
      verdictLabel: verdictMeta.verdictLabel,
    });
  });

  rows.sort((a, b) => b.generatedRevenueUsd - a.generatedRevenueUsd || b.tastedProductCostUsd - a.tastedProductCostUsd);

  const totalActivations = rows.reduce((s, r) => s + r.activationsCount, 0);
  const totalPdvs = rows.reduce((s, r) => Math.max(s, r.pdvCount), 0);
  const totalTastedUnits = Number(rows.reduce((s, r) => s + r.tastedUnits, 0).toFixed(1));
  const totalSamplesDelivered = rows.reduce((s, r) => s + r.samplesDelivered, 0);
  const totalTastedProductCostUsd = rows.reduce((s, r) => s + r.tastedProductCostUsd, 0);
  const totalBreakEvenUnits = rows.reduce((s, r) => s + r.breakEvenUnits, 0);
  const totalSoldUnits = rows.reduce((s, r) => s + r.soldUnits, 0);
  const totalGeneratedRevenueUsd = rows.reduce((s, r) => s + r.generatedRevenueUsd, 0);
  const netBalanceUsd = totalGeneratedRevenueUsd - totalTastedProductCostUsd;

  const returnMultiplier =
    totalTastedProductCostUsd > 0 ? totalGeneratedRevenueUsd / totalTastedProductCostUsd : 0;
  const roiPercent =
    totalTastedProductCostUsd > 0
      ? ((totalGeneratedRevenueUsd - totalTastedProductCostUsd) / totalTastedProductCostUsd) * 100
      : 0;
  const costToSalesRatioPct =
    totalGeneratedRevenueUsd > 0
      ? (totalTastedProductCostUsd / totalGeneratedRevenueUsd) * 100
      : totalTastedProductCostUsd > 0
      ? 100
      : 0;

  const costPerSampleUsd =
    totalSamplesDelivered > 0 ? totalTastedProductCostUsd / totalSamplesDelivered : 0;
  const costPerSoldUnitUsd =
    totalSoldUnits > 0 ? totalTastedProductCostUsd / totalSoldUnits : 0;
  const breakEvenCoveragePct =
    totalBreakEvenUnits > 0 ? (totalSoldUnits / totalBreakEvenUnits) * 100 : 0;

  const globalVerdict = resolveFeasibilityVerdict(
    totalTastedProductCostUsd,
    totalGeneratedRevenueUsd
  );

  return {
    periodLabel,
    returnBasis,
    totalActivations,
    totalPdvs,
    totalTastedUnits,
    totalSamplesDelivered,
    totalTastedProductCostUsd,
    totalBreakEvenUnits,
    totalSoldUnits,
    totalGeneratedRevenueUsd,
    netBalanceUsd,
    returnMultiplier,
    roiPercent,
    costToSalesRatioPct,
    costPerSampleUsd,
    costPerSoldUnitUsd,
    breakEvenCoveragePct,
    verdict: globalVerdict.verdict,
    verdictLabel: globalVerdict.verdictLabel,
    verdictRecommendation: globalVerdict.recommendation,
    rows,
  };
}
