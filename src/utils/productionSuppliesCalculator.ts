import { OperationalSupplies, ShiftType } from '../types';

export interface ProductionSuppliesResult {
  /** Categoría normalizada para el selector de la matriz: MORTADELA | VENCAMPO | ESPALDA | JAMON | SALCHICHA */
  normalizedProduct: string;
  /** Nombre descriptivo del producto enfocado */
  productFocus: string;
  /** Selección del selector de llenado en la matriz */
  fillProductSelection: string;
  /** Valor textual de cantidad para el input editable */
  fillQuantityInput: string;
  /** Unidades / kilos planificados */
  plannedUnits: number;
  /** Unidades de Mortadela / Jamón / Embutidos */
  mortadelaQty: number;
  /** Unidades de Espalda Ahumada */
  espaldaQty: number;
  /** Unidades / Stands de Línea Vencampo (Arroz / Leche) */
  arrozQty: number;
  /** Gramos de Azúcar calculados automáticamente (600g por unidad/stand Vencampo) */
  azucarGrams: number;
  /** Gramos de Leche en Polvo calculados automáticamente (600g por unidad/stand Vencampo) */
  lecheGrams: number;
  /** Resaltado visual de fila en la Matriz General */
  rowHighlight: 'green' | 'yellow' | 'none';
  /** Insumos adicionales expresados en kilogramos */
  additionalGoods: {
    arrozKg: number;
    azucarKg: number;
    lecheKg: number;
  };
  /** Dotación operativa de insumos descartables y gramaje para la ejecución de la degustación */
  operationalSupplies: OperationalSupplies;
}

const MAX_OPERATIONAL_UNITS = 10_000;
const MAX_OPERATIONAL_SAMPLES = 1_000_000;

function parseSafeQuantity(quantityInput: string | number | null | undefined): number {
  if (typeof quantityInput === 'number') {
    if (!Number.isFinite(quantityInput) || quantityInput <= 0) return 1;
    const clamped = Math.min(MAX_OPERATIONAL_UNITS, Math.max(0.1, quantityInput));
    return Math.round(clamped * 100) / 100;
  }
  const rawStr = String(quantityInput ?? '').trim();
  if (!rawStr) return 1;
  // Extraer el primer número válido (soportando coma o punto decimal)
  const match = rawStr.replace(/\s+/g, '').match(/[-+]?\d+(?:[.,]\d+)?/);
  if (!match) return 1;
  if (rawStr.trim().startsWith('-')) return 1;
  const normalizedNumStr = match[0].replace(',', '.');
  const parsed = parseFloat(normalizedNumStr);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  const clamped = Math.min(MAX_OPERATIONAL_UNITS, Math.max(0.1, parsed));
  return Math.round(clamped * 100) / 100;
}

/**
 * Calcula de forma determinística las columnas de la Matriz de Llenado e Insumos (Módulo 2)
 * a partir del producto y los kilos/unidades aprobados en una solicitud de degustación (Módulo 1)
 * o ingresados en el motor de llenado por lote.
 */
export function calculateProductionSupplies(
  rawProduct: string,
  quantityInput: string | number,
  targetSamples?: number
): ProductionSuppliesResult {
  const cleanProduct = String(rawProduct ?? '').trim() || 'MORTADELA';
  const prodUpper = cleanProduct.toUpperCase();
  const prodAscii = prodUpper.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const qtyNum = parseSafeQuantity(quantityInput);

  let mortadelaQty = 0;
  let espaldaQty = 0;
  let arrozQty = 0;
  let azucarGrams = 0;
  let lecheGrams = 0;
  let normalizedProduct = 'MORTADELA';
  let rowHighlight: 'green' | 'yellow' | 'none' = 'none';

  if (
    prodAscii.includes('VENCAMPO') ||
    prodAscii.includes('ARROZ') ||
    prodAscii.includes('LECHE') ||
    prodAscii.includes('AVENA') ||
    prodAscii.includes('AZUCAR') ||
    prodAscii.includes('CARAOTA') ||
    prodAscii.includes('GRANO') ||
    prodAscii.includes('LENTEJA') ||
    prodAscii.includes('ARVEJA') ||
    prodAscii.includes('ACEITE')
  ) {
    normalizedProduct = 'VENCAMPO';
    arrozQty = qtyNum;
    azucarGrams = Math.round(qtyNum * 600);
    lecheGrams = Math.round(qtyNum * 600);
    rowHighlight = 'green';
  } else if (prodAscii.includes('ESPALDA') || prodAscii.includes('FIAMBRE')) {
    normalizedProduct = 'ESPALDA';
    espaldaQty = qtyNum;
  } else if (
    prodAscii.includes('JAMON') ||
    prodAscii.includes('PECHUGA') ||
    prodAscii.includes('CHULETA') ||
    prodAscii.includes('TOCINETA') ||
    prodAscii.includes('SUPERIOR') ||
    prodAscii.includes('ESTANDAR') ||
    prodAscii.includes('AHUMADO')
  ) {
    normalizedProduct = 'JAMON';
    mortadelaQty = qtyNum;
  } else if (
    prodAscii.includes('SALCHICHA') ||
    prodAscii.includes('CHORIZO') ||
    prodAscii.includes('BOLOGNA')
  ) {
    normalizedProduct = 'SALCHICHA';
    mortadelaQty = qtyNum;
  } else if (prodAscii.includes('MORTADELA')) {
    normalizedProduct = 'MORTADELA';
    mortadelaQty = qtyNum;
  } else {
    normalizedProduct = 'MORTADELA';
    mortadelaQty = qtyNum;
  }

  // Cálculo de porciones e insumos descartables base (servilletas, palillos, envases y gramaje)
  const unitWeightGrams =
    prodAscii.includes('0.900') || prodAscii.includes('0,900') || prodAscii.includes('900G')
      ? 900
      : 1000;
  const gramajeTotalG = Math.max(1, Math.round(qtyNum * unitWeightGrams));
  const defaultPortionsPerUnit = normalizedProduct === 'VENCAMPO' ? 80 : 70;
  const validTargetSamples =
    typeof targetSamples === 'number' && Number.isFinite(targetSamples) && targetSamples > 0
      ? Math.min(MAX_OPERATIONAL_SAMPLES, Math.round(targetSamples))
      : 0;
  const estimatedPortions =
    validTargetSamples > 0
      ? validTargetSamples
      : Math.max(1, Math.round(qtyNum * defaultPortionsPerUnit));

  // Servilletas: 1 por porción + 15% margen operativo
  const servilletas = Math.ceil(estimatedPortions * 1.15);
  // Palillos: para embutidos/cárnicos (1 por porción + 10% margen); 0 para bebidas/cremas Vencampo
  const palillos = normalizedProduct === 'VENCAMPO' ? 0 : Math.ceil(estimatedPortions * 1.1);
  // Envases: vasos de degustación para Vencampo (1 por porción + 10%) o bandejas/contenedores para cárnicos (2 por unidad/kg)
  const envases =
    normalizedProduct === 'VENCAMPO'
      ? Math.ceil(estimatedPortions * 1.1)
      : Math.max(2, Math.ceil(qtyNum * 2));

  return {
    normalizedProduct,
    productFocus: prodUpper,
    fillProductSelection: normalizedProduct,
    fillQuantityInput: String(qtyNum),
    plannedUnits: qtyNum,
    mortadelaQty,
    espaldaQty,
    arrozQty,
    azucarGrams,
    lecheGrams,
    rowHighlight,
    additionalGoods: {
      arrozKg: arrozQty,
      azucarKg: +(azucarGrams / 1000).toFixed(3),
      lecheKg: +(lecheGrams / 1000).toFixed(3),
    },
    operationalSupplies: {
      servilletas,
      palillos,
      envases,
      gramajeTotalG,
      estimatedPortions,
    },
  };
}

/**
 * Calcula y agrega de forma determinística los insumos de degustación cuando el usuario
 * selecciona uno o múltiples productos en el Módulo 2 (`Cronograma`).
 */
export function calculateMultiProductSupplies(
  rawProducts: readonly string[],
  quantityInput: string | number,
  targetSamples?: number
): ProductionSuppliesResult {
  const uniqueProducts = Array.from(
    new Set(
      rawProducts
        .map((p) => String(p ?? '').trim())
        .filter((p) => p.length > 0)
    )
  );

  if (uniqueProducts.length <= 1) {
    return calculateProductionSupplies(uniqueProducts[0] || 'MORTADELA', quantityInput, targetSamples);
  }

  const perProduct = uniqueProducts.map((prod) =>
    calculateProductionSupplies(prod, quantityInput, undefined)
  );

  const mortadelaQty = +(
    perProduct.reduce((acc, r) => acc + r.mortadelaQty, 0)
  ).toFixed(2);
  const espaldaQty = +(
    perProduct.reduce((acc, r) => acc + r.espaldaQty, 0)
  ).toFixed(2);
  const arrozQty = +(
    perProduct.reduce((acc, r) => acc + r.arrozQty, 0)
  ).toFixed(2);
  const azucarGrams = perProduct.reduce((acc, r) => acc + r.azucarGrams, 0);
  const lecheGrams = perProduct.reduce((acc, r) => acc + r.lecheGrams, 0);
  const plannedUnits = +(
    perProduct.reduce((acc, r) => acc + r.plannedUnits, 0)
  ).toFixed(2);

  const combinedFocus = uniqueProducts.map((p) => p.toUpperCase()).join(' + ');
  const primaryNormalized = perProduct[0]?.normalizedProduct || 'MORTADELA';
  const hasVencampo = perProduct.some((r) => r.rowHighlight === 'green');

  const estimatedPortions =
    typeof targetSamples === 'number' && Number.isFinite(targetSamples) && targetSamples > 0
      ? Math.min(MAX_OPERATIONAL_SAMPLES, Math.round(targetSamples))
      : perProduct.reduce((acc, r) => acc + r.operationalSupplies.estimatedPortions, 0);
  const servilletas = perProduct.reduce((acc, r) => acc + r.operationalSupplies.servilletas, 0);
  const palillos = perProduct.reduce((acc, r) => acc + r.operationalSupplies.palillos, 0);
  const envases = perProduct.reduce((acc, r) => acc + r.operationalSupplies.envases, 0);
  const gramajeTotalG = perProduct.reduce((acc, r) => acc + r.operationalSupplies.gramajeTotalG, 0);

  return {
    normalizedProduct: primaryNormalized,
    productFocus: combinedFocus,
    fillProductSelection: combinedFocus,
    fillQuantityInput: String(parseSafeQuantity(quantityInput)),
    plannedUnits,
    mortadelaQty,
    espaldaQty,
    arrozQty,
    azucarGrams,
    lecheGrams,
    rowHighlight: hasVencampo ? 'green' : 'none',
    additionalGoods: {
      arrozKg: arrozQty,
      azucarKg: +(azucarGrams / 1000).toFixed(3),
      lecheKg: +(lecheGrams / 1000).toFixed(3),
    },
    operationalSupplies: {
      servilletas,
      palillos,
      envases,
      gramajeTotalG,
      estimatedPortions,
    },
  };
}

/**
 * Normaliza un turno operativo hacia 'MAÑANA' o 'TARDE' para las columnas de la Matriz de Producción.
 */
export function normalizeProductionShift(
  shift?: ShiftType | string | null,
  timeRange?: string | null
): ShiftType {
  const s = String(shift ?? '').trim().toUpperCase();
  if (s === 'TARDE' || s === 'NOCHE') return 'TARDE';
  if (s === 'MAÑANA' || s === 'MANANA') return 'MAÑANA';

  const t = String(timeRange ?? '').trim().toUpperCase();
  if (!t) return 'MAÑANA';
  if (t.includes('TARDE') || t.includes('NOCHE')) return 'TARDE';
  if (t.includes('MAÑANA') || t.includes('MANANA')) return 'MAÑANA';

  // Analizar el tramo de inicio (antes de '-' o '–' o ' A ')
  const startSegment = t.split(/\s*(?:[-–]|\bA\b|\bTO\b)\s*/)[0]?.trim() || t;
  if (startSegment.includes('AM')) return 'MAÑANA';
  if (startSegment.includes('PM')) return 'TARDE';

  const hourMatch = startSegment.match(/(\d{1,2})(?::\d{2})?/);
  if (hourMatch) {
    const hour = parseInt(hourMatch[1], 10);
    if (hour >= 12 && hour <= 23) return 'TARDE';
    if (hour >= 1 && hour <= 5) return 'TARDE';
  }

  return 'MAÑANA';
}
