/**
 * Utilidades numéricas a prueba de datos vacíos: jamás devuelven NaN ni Infinity.
 */

/** Convierte cualquier valor a número finito; si no lo es, devuelve `fallback`. */
export function toFiniteNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** División segura: si el divisor es 0/null/undefined o el resultado no es finito, devuelve `fallback`. */
export function safeDiv(numerator: unknown, denominator: unknown, fallback = 0): number {
  const d = toFiniteNumber(denominator, 0);
  if (d === 0) return fallback;
  const result = toFiniteNumber(numerator, 0) / d;
  return Number.isFinite(result) ? result : fallback;
}

/** Porcentaje (0-100) seguro. */
export function safePct(part: unknown, total: unknown, fallback = 0): number {
  return safeDiv(part, total, fallback) * 100;
}

/** Promedio seguro de una lista de números (lista vacía → fallback). */
export function safeAvg(values: ReadonlyArray<unknown>, fallback = 0): number {
  if (!values || values.length === 0) return fallback;
  return safeDiv(
    values.reduce<number>((acc, v) => acc + toFiniteNumber(v, 0), 0),
    values.length,
    fallback
  );
}

/** `toFixed` seguro: devuelve «—» si el valor no es un número finito. */
export function fixedOrDash(value: unknown, digits = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}
