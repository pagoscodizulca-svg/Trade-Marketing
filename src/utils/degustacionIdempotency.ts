/**
 * Utilidades deterministas de normalización e idempotencia (SHA-256) para el flujo
 * Módulo 1 (Carga Multiformato) -> Módulo 2 (Cronograma de Degustaciones).
 * Funciona tanto en navegador (Web Crypto API) como en Node.js 20+.
 */

export interface IdempotencySeedInput {
  fecha: string;
  clienteNombre: string;
  horaInicio?: string | null;
  productoResumen: string;
}

/**
 * Normaliza un texto eliminando tildes/diacríticos, signos de puntuación redundantes
 * y colapsando espacios múltiples en mayúsculas para que variaciones menores de escritura
 * (ej. `"FAMILIA CENTER, C.A."` vs `"Familia Center C.A"`) produzcan la misma llave canónica.
 */
export function normalizeCanonicalToken(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.,;:#'"()\-_/\\]+/g, ' ')
    .replace(/\b(C\s*A|S\s*A|R\s*L)\b/g, (m) => m.replace(/\s+/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normaliza una hora de inicio flexible (ej. `"9:00 am"`, `"09:00"`, `"2pm"`) a formato 24h `HH:MM`.
 */
export function normalizeHora24(rawHora?: string | null, fallback = '09:00'): string {
  const clean = String(rawHora ?? '').trim().toUpperCase();
  if (!clean) return fallback;

  const match = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM|A\.?\s*M\.?|P\.?\s*M\.?)?/i);
  if (!match) return fallback;

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  const meridiem = (match[3] ?? '').replace(/[\s.]/g, '').toUpperCase();

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes < 0 || minutes > 59) {
    return fallback;
  }

  if (meridiem === 'PM' && hours < 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  if (hours < 0 || hours > 23) return fallback;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Construye la semilla textual canónica legible antes de aplicar SHA-256:
 * `YYYY-MM-DD|PDV_CANONICO|HH:MM|PRODUCTOS_ORDENADOS`
 */
export function buildDegustacionCanonicalSeed(input: IdempotencySeedInput): string {
  const fecha = String(input.fecha ?? '').trim();
  const pdv = normalizeCanonicalToken(input.clienteNombre);
  const hora = normalizeHora24(input.horaInicio, '09:00');
  const sortedProducts = String(input.productoResumen ?? '')
    .split(/[,+/|]+/)
    .map((p) => normalizeCanonicalToken(p))
    .filter(Boolean)
    .sort()
    .join('+');

  return `${fecha}|${pdv}|${hora}|${sortedProducts}`;
}

/**
 * Calcula un hash SHA-256 hexadecimal en minúsculas a partir de un texto o binario.
 */
export async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API (crypto.subtle) no está disponible en este entorno.');
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeDegustacionIdempotencyHash(input: IdempotencySeedInput): Promise<string> {
  const seed = buildDegustacionCanonicalSeed(input);
  const encoded = new TextEncoder().encode(seed);
  return sha256HexFromBytes(encoded);
}
