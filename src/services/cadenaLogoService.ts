import { invalidarCacheMaestros } from './masterDataSyncService';
import { getActiveClientSucursalHeader, getSupabaseClient, isSupabaseConfigured } from './supabaseClient';

export const MAX_CADENA_LOGO_BYTES = 512 * 1024; // 512 KB
export const ALLOWED_CADENA_LOGO_MIMES = ['image/png', 'image/webp'] as const;
export type AllowedClientCadenaLogoMime = (typeof ALLOWED_CADENA_LOGO_MIMES)[number];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadedCadenaLogoSummary {
  id: string;
  codigo: string;
  nombre: string;
  sucursal: string | null;
  hasLogo: boolean;
  logoMimeType: string | null;
  logoUpdatedAt: string | null;
  sha256Hex?: string;
  sizeBytes?: number;
}

/**
 * Validación preventiva en cliente antes de transmitir el binario:
 * - Bloquea `.svg`, `.xml`, `.html`, `.jpg` o extensiones sospechosas.
 * - Exige `image/png` o `image/webp` con peso máximo de `512 KB`.
 */
export function validateClientCadenaLogoFile(file: File): string | null {
  const lowerName = String(file.name || '').trim().toLowerCase();
  if (
    lowerName.endsWith('.svg') ||
    lowerName.endsWith('.svgz') ||
    lowerName.endsWith('.xml') ||
    lowerName.endsWith('.html') ||
    lowerName.endsWith('.htm') ||
    file.type === 'image/svg+xml'
  ) {
    return 'Por seguridad Anti-XSS no se permiten archivos SVG, XML ni HTML. Usa únicamente PNG o WebP.';
  }

  if (!(ALLOWED_CADENA_LOGO_MIMES as readonly string[]).includes(file.type)) {
    return 'Formato no admitido. Selecciona una imagen rasterizada PNG (.png) o WebP (.webp).';
  }

  if (file.size <= 0) {
    return 'El archivo seleccionado está vacío.';
  }

  if (file.size > MAX_CADENA_LOGO_BYTES) {
    const kb = Math.ceil(file.size / 1024);
    return `El logotipo pesa ${kb} KB y supera el límite máximo permitido de 512 KB.`;
  }

  return null;
}

/**
 * Calcula un monograma ejecutivo limpio (2 a 3 letras) para el respaldo tipográfico
 * cuando una cadena comercial aún no posee logotipo secundario cargado.
 */
export function computeCadenaInitials(nombre: string, codigo?: string | null): string {
  const stopWords = new Set([
    'DE',
    'DEL',
    'LA',
    'LAS',
    'LOS',
    'EL',
    'Y',
    'CA',
    'C.A.',
    'SA',
    'S.A.',
    'SUPERMERCADO',
    'SUPERMERCADOS',
    'AUTOMERCADO',
    'AUTOMERCADOS',
    'CADENA',
    'COMERCIAL',
  ]);

  const tokens = String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const meaningful = tokens.filter((t) => !stopWords.has(t));
  const pool = meaningful.length > 0 ? meaningful : tokens;

  if (pool.length >= 2) {
    return `${pool[0]![0] || ''}${pool[1]![0] || ''}`;
  }
  if (pool.length === 1 && pool[0]!.length >= 2) {
    return pool[0]!.slice(0, 2);
  }
  const cleanCode = String(codigo || '')
    .replace(/^CAD[-_]?/i, '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase();
  return cleanCode.slice(0, 2) || 'CC';
}

/**
 * Garantiza que `<img src>` en Co-Branding jamás apunte a una URL externa arbitraria
 * ni a un data URI SVG/HTML (prevención estricta de SSRF, píxeles de rastreo y violaciones CSP).
 */
export function isSafeLocalLogoSrc(src: string | null | undefined): src is string {
  if (!src || typeof src !== 'string') return false;
  const trimmed = src.trim();
  if (trimmed.startsWith('blob:')) return true;
  if (/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) return true;
  return false;
}

export function revokeLogoBlobUrl(url: string | null | undefined): void {
  if (!url || typeof url !== 'string') return;
  if (url.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignorar URLs ya revocadas
    }
  }
}

async function resolveAuthHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  if (!isSupabaseConfigured) {
    throw new Error('Conexión a Supabase no configurada en este entorno.');
  }
  const client = getSupabaseClient();
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');
  }

  const activeHub = getActiveClientSucursalHeader();
  return {
    Authorization: `Bearer ${token}`,
    ...(activeHub ? { 'x-sucursal-activa': activeHub } : {}),
    ...extra,
  };
}

export async function uploadCadenaSecondaryLogo(
  cadenaId: string,
  file: File
): Promise<UploadedCadenaLogoSummary> {
  if (!UUID_REGEX.test(String(cadenaId || '').trim())) {
    throw new Error('Identificador de cadena comercial inválido.');
  }
  const validationError = validateClientCadenaLogoFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const headers = await resolveAuthHeaders({
    'Content-Type': file.type || 'application/octet-stream',
  });
  const bodyBuffer = await file.arrayBuffer();

  const res = await fetch(`/api/cadenas-comerciales/${encodeURIComponent(cadenaId.trim())}/logo`, {
    method: 'POST',
    headers,
    body: bodyBuffer,
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    cadena?: UploadedCadenaLogoSummary;
  };

  if (!res.ok || !payload.ok || !payload.cadena) {
    throw new Error(payload.error || `No se pudo cargar el logotipo (HTTP ${res.status}).`);
  }

  invalidarCacheMaestros();
  return payload.cadena;
}

export async function deleteCadenaSecondaryLogo(
  cadenaId: string
): Promise<UploadedCadenaLogoSummary> {
  if (!UUID_REGEX.test(String(cadenaId || '').trim())) {
    throw new Error('Identificador de cadena comercial inválido.');
  }

  const headers = await resolveAuthHeaders();
  const res = await fetch(`/api/cadenas-comerciales/${encodeURIComponent(cadenaId.trim())}/logo`, {
    method: 'DELETE',
    headers,
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    cadena?: UploadedCadenaLogoSummary;
  };

  if (!res.ok || !payload.ok || !payload.cadena) {
    throw new Error(payload.error || `No se pudo retirar el logotipo (HTTP ${res.status}).`);
  }

  invalidarCacheMaestros();
  return payload.cadena;
}

/**
 * Descarga autenticada del logotipo secundario y conversión a `Blob URL` local
 * (100 % compatible con `img-src 'self' data: blob:` de Content-Security-Policy).
 * El llamador debe invocar `revokeLogoBlobUrl(url)` al desmontar o cambiar de cadena.
 */
export async function fetchCadenaSecondaryLogoBlobUrl(
  cadenaId: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!UUID_REGEX.test(String(cadenaId || '').trim()) || !isSupabaseConfigured) {
    return null;
  }

  const headers = await resolveAuthHeaders();
  const res = await fetch(`/api/cadenas-comerciales/${encodeURIComponent(cadenaId.trim())}/logo`, {
    method: 'GET',
    headers,
    signal,
  });

  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    return null;
  }

  const contentType = String(res.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'image/png' && contentType !== 'image/webp') {
    return null;
  }

  const rawBlob = await res.blob();
  const safeBlob =
    rawBlob.type === contentType ? rawBlob : new Blob([rawBlob], { type: contentType });
  return URL.createObjectURL(safeBlob);
}
