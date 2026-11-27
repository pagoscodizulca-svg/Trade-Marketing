/**
 * Control unificado de unidad de medida para productos en Trade Marketing
 * (Módulo 2 Cronograma, Módulo 1 Solicitudes, App de Promotoras `/portal` y `/pdv/:token`).
 *
 * Permite registrar y planificar productos indistintamente por **Unidad** o por **Bulto**
 * (además de `Kg` y `Caja` cuando aplica en el catálogo maestro), evitando que artículos
 * marcados como `BULTO` en el ERP bloqueen su uso operativo por unidad individual.
 */

export type ProductQuantityUnit = 'UNIDAD' | 'BULTO' | 'KG' | 'CAJA';

export type PortalExecutionUnit = 'UNIDAD' | 'BULTO';

export const PORTAL_EXECUTION_UNIT_OPTIONS: ReadonlyArray<{
  value: PortalExecutionUnit;
  label: string;
  shortLabel: string;
  pluralLabel: string;
}> = [
  { value: 'UNIDAD', label: 'Por Unidad', shortLabel: 'Unid.', pluralLabel: 'Unidades' },
  { value: 'BULTO', label: 'Por Bulto', shortLabel: 'Bulto', pluralLabel: 'Bultos' },
];

export const SCHEDULE_QUANTITY_UNIT_OPTIONS: ReadonlyArray<{
  value: ProductQuantityUnit;
  label: string;
  shortLabel: string;
}> = [
  { value: 'UNIDAD', label: 'Unidad', shortLabel: 'Unid.' },
  { value: 'BULTO', label: 'Bulto', shortLabel: 'Bulto' },
  { value: 'KG', label: 'Kg', shortLabel: 'Kg' },
];

const UNIT_TAG_REGEX = /\[(?:Medida|Presentación|Presentacion|Unidad)\s*:\s*([^\]]+)\]/i;

/**
 * Normaliza cualquier texto libre o unidad del ERP (`UND`, `UNID`, `UNIDAD`, `BULTO`, `BULTOS`, `KG`, `CAJAS`)
 * hacia un código canónico `ProductQuantityUnit`.
 */
export function normalizeProductQuantityUnit(raw: unknown): ProductQuantityUnit | null {
  const clean = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
  if (!clean) return null;
  if (clean === 'BULTO' || clean === 'BULTOS' || clean === 'BLT' || clean.startsWith('BULTO')) {
    return 'BULTO';
  }
  if (
    clean === 'UNIDAD' ||
    clean === 'UNIDADES' ||
    clean === 'UND' ||
    clean === 'UNID' ||
    clean === 'UNID.' ||
    clean === 'PIEZA' ||
    clean === 'PIEZAS' ||
    clean === 'UN'
  ) {
    return 'UNIDAD';
  }
  if (clean === 'KG' || clean === 'KGS' || clean === 'KILO' || clean === 'KILOS' || clean === 'KILOGRAMO' || clean === 'KILOGRAMOS') {
    return 'KG';
  }
  if (clean === 'CAJA' || clean === 'CAJAS' || clean === 'CJA') {
    return 'CAJA';
  }
  return null;
}

/**
 * Normaliza a las 2 modalidades operativas principales de campo (`UNIDAD` | `BULTO`).
 */
export function normalizePortalExecutionUnit(
  raw: unknown,
  fallback: PortalExecutionUnit = 'UNIDAD'
): PortalExecutionUnit {
  const parsed = normalizeProductQuantityUnit(raw);
  if (parsed === 'BULTO') return 'BULTO';
  if (parsed === 'UNIDAD') return 'UNIDAD';
  return fallback;
}

/**
 * Etiqueta corta compacta para badges, celdas de tabla y botones inline.
 */
export function formatQuantityUnitShort(unit?: ProductQuantityUnit | null): string {
  switch (unit) {
    case 'BULTO':
      return 'Bulto';
    case 'KG':
      return 'Kg';
    case 'CAJA':
      return 'Caja';
    case 'UNIDAD':
    default:
      return 'Unid.';
  }
}

/**
 * Etiqueta legible singular/plural según la cantidad.
 */
export function formatQuantityUnitLabel(
  unit?: ProductQuantityUnit | null,
  qty?: number | string | null
): string {
  const num = typeof qty === 'number' ? qty : Number(String(qty ?? '').replace(',', '.'));
  const isSingular = Number.isFinite(num) && Math.abs(num) === 1;
  switch (unit) {
    case 'BULTO':
      return isSingular ? 'Bulto' : 'Bultos';
    case 'KG':
      return 'Kg';
    case 'CAJA':
      return isSingular ? 'Caja' : 'Cajas';
    case 'UNIDAD':
    default:
      return isSingular ? 'Unidad' : 'Unidades';
  }
}

/**
 * Formatea una cantidad junto a su unidad legible (ej. `1 Bulto`, `3 Unidades`, `2.5 Kg`).
 */
export function formatQuantityWithUnit(
  qty: number | string,
  unit?: ProductQuantityUnit | null
): string {
  const cleanQty = typeof qty === 'number' ? Number(qty.toFixed(2)) : String(qty).trim() || '0';
  return `${cleanQty} ${formatQuantityUnitLabel(unit ?? 'UNIDAD', cleanQty)}`;
}

/**
 * Cicla entre las modalidades operativas de fila en la Tabla General (`UNIDAD` -> `BULTO` -> `KG` -> `UNIDAD`).
 */
export function getNextScheduleQuantityUnit(current?: ProductQuantityUnit | null): ProductQuantityUnit {
  if (current === 'UNIDAD' || !current) return 'BULTO';
  if (current === 'BULTO') return 'KG';
  return 'UNIDAD';
}

/**
 * Sugiere la unidad inicial más segura al seleccionar productos en Módulo 2:
 * - Si TODOS los productos elegidos vienen por `KG`, sugiere `KG`.
 * - En cualquier otro caso (incluidos productos marcados como `BULTO` en el ERP),
 *   sugiere `UNIDAD` para evitar cargas accidentales por bulto completo, permitiendo
 *   cambiar a `BULTO` con un solo clic.
 */
export function inferDefaultScheduleQuantityUnit(
  catalogUnits: ReadonlyArray<string | null | undefined>
): ProductQuantityUnit {
  const normalized = catalogUnits
    .map((u) => normalizeProductQuantityUnit(u))
    .filter((u): u is ProductQuantityUnit => u !== null);
  if (normalized.length > 0 && normalized.every((u) => u === 'KG')) {
    return 'KG';
  }
  return 'UNIDAD';
}

/**
 * Extrae la etiqueta estructurada `[Medida: Unidad|Bulto|Kg|Caja]` desde un campo de observaciones/comentarios,
 * devolviendo el texto limpio para mostrar al usuario y la unidad detectada.
 */
export function extractUnitFromObservations(rawText?: string | null): {
  cleanText: string;
  unit: ProductQuantityUnit | null;
} {
  const source = String(rawText ?? '').trim();
  if (!source) return { cleanText: '', unit: null };
  const match = source.match(UNIT_TAG_REGEX);
  const unit = match ? normalizeProductQuantityUnit(match[1]) : null;
  const cleanText = source
    .replace(new RegExp(UNIT_TAG_REGEX.source, 'gi'), '')
    .replace(/\s*·\s*$/, '')
    .replace(/^\s*·\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { cleanText, unit };
}

/**
 * Adjunta o actualiza de forma idempotente la etiqueta `[Medida: Unidad|Bulto|Kg|Caja]`
 * en un campo de observaciones/comentarios sin duplicar etiquetas existentes.
 */
export function appendUnitTagToObservations(
  rawText: string | null | undefined,
  unit: ProductQuantityUnit
): string {
  const { cleanText } = extractUnitFromObservations(rawText);
  const unitLabel =
    unit === 'BULTO' ? 'Bulto' : unit === 'KG' ? 'Kg' : unit === 'CAJA' ? 'Caja' : 'Unidad';
  const tag = `[Medida: ${unitLabel}]`;
  return cleanText ? `${tag} ${cleanText}` : tag;
}

/**
 * Resuelve la unidad de cantidad almacenada en `insumos_calculados` JSONB de `cronograma_degustaciones`
 * o como respaldo desde `observaciones` / `fill_quantity`.
 */
export function resolveQuantityUnitFromInsumos(
  insumos?: Record<string, unknown> | null,
  fallbackObservations?: string | null
): ProductQuantityUnit | null {
  if (insumos && typeof insumos === 'object') {
    const direct = normalizeProductQuantityUnit(
      insumos.unidad_cantidad ?? insumos.quantity_unit ?? insumos.unidad_medida
    );
    if (direct) return direct;

    const fillQtyRaw = String(insumos.fill_quantity ?? '').trim();
    if (fillQtyRaw) {
      if (/\bBULTOS?\b/i.test(fillQtyRaw)) return 'BULTO';
      if (/\b(?:UND|UNID\.?|UNIDADES?)\b/i.test(fillQtyRaw)) return 'UNIDAD';
      if (/\bKGS?|KILOS?\b/i.test(fillQtyRaw)) return 'KG';
      if (/\bCAJAS?\b/i.test(fillQtyRaw)) return 'CAJA';
    }
  }
  return extractUnitFromObservations(fallbackObservations).unit;
}
