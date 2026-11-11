/** Convierte cualquier valor a un número finito; null/undefined/NaN/Infinity → fallback. */
export function toFiniteNumber(valor: unknown, fallback = 0): number {
  const n = typeof valor === 'number' ? valor : typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** División segura: divisor 0 o valores no finitos devuelven el fallback (nunca NaN/Infinity). */
export function safeDiv(a: unknown, b: unknown, fallback = 0): number {
  const num = toFiniteNumber(a, NaN);
  const den = toFiniteNumber(b, NaN);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return fallback;
  const r = num / den;
  return Number.isFinite(r) ? r : fallback;
}

/** Porcentaje entero (0–100 redondeado) de parte/total; 0 si no se puede calcular. */
export function safePct(parte: unknown, total: unknown): number {
  return Math.round(safeDiv(parte, total, 0) * 100);
}
