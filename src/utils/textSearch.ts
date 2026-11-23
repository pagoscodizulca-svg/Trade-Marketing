/**
 * Normalización pura e insensible a acentos/diacríticos (NFD) para búsquedas de texto.
 * Maneja de forma segura valores `null` y `undefined`.
 */
export function normalizeSearchText(value: string | null | undefined): string {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
