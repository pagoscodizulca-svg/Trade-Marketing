export const EVIDENCIA_BUCKET_DEFAULT = 'entregas-evidencias';
export const EVIDENCIA_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const EVIDENCIA_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedEvidenceMime = (typeof EVIDENCIA_ALLOWED_MIME_TYPES)[number];
export type AllowedEvidenceExt = 'jpg' | 'png' | 'webp';

const MIME_TO_EXT: Record<AllowedEvidenceMime, AllowedEvidenceExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type EvidenceValidationResult =
  | { ok: true; mime: AllowedEvidenceMime; ext: AllowedEvidenceExt }
  | { ok: false; error: string };

/**
 * Valida estrictamente tipo MIME permitido (`image/jpeg`, `image/png`, `image/webp`)
 * y tamaño máximo (`<= 5 MB`) antes de subir una evidencia fotográfica a Supabase Storage.
 */
export function validateEvidenceImageFile(file: {
  name?: string;
  type?: string;
  size?: number;
}): EvidenceValidationResult {
  if (!file || typeof file !== 'object') {
    return { ok: false, error: 'Selecciona una imagen válida para subir como evidencia.' };
  }

  const rawMime = String(file.type || '').trim().toLowerCase();
  if (!(EVIDENCIA_ALLOWED_MIME_TYPES as readonly string[]).includes(rawMime)) {
    return {
      ok: false,
      error:
        'Formato no permitido. Solo se aceptan imágenes JPG, PNG o WebP (image/jpeg, image/png, image/webp).',
    };
  }

  const size = Number(file.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: 'El archivo de imagen está vacío.' };
  }

  if (size > EVIDENCIA_MAX_BYTES) {
    return {
      ok: false,
      error: `La imagen excede el límite máximo permitido de 5 MB (${(size / (1024 * 1024)).toFixed(2)} MB).`,
    };
  }

  const mime = rawMime as AllowedEvidenceMime;
  return { ok: true, mime, ext: MIME_TO_EXT[mime] };
}

/**
 * Construye una ruta única y sanitizada dentro de `entregas-evidencias` sin posibilidad de path traversal.
 */
export function buildSafeEvidenceStoragePath(
  entregaId: string,
  ext: AllowedEvidenceExt,
  nowMs = Date.now(),
  uniqueToken?: string
): string {
  const safeEntregaId = String(entregaId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);

  if (!safeEntregaId) {
    throw new Error('Identificador de entrega inválido para almacenar la evidencia.');
  }

  const tokenRaw =
    uniqueToken ??
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`);
  const safeToken = String(tokenRaw)
    .replace(/[^a-zA-Z0-9-]/g, '')
    .slice(0, 40) || 'evid';

  const safeExt: AllowedEvidenceExt = ext === 'png' || ext === 'webp' ? ext : 'jpg';
  return `entregas/${safeEntregaId}/${Math.floor(nowMs)}-${safeToken}.${safeExt}`;
}

/**
 * Comprueba que un path de Storage no contenga path traversal ni caracteres inseguros.
 */
export function isSafeStorageObjectPath(path: string | null | undefined): boolean {
  const clean = String(path || '').trim();
  if (!clean || clean.length > 260) return false;
  if (clean.startsWith('/') || clean.includes('\\') || clean.includes('..')) return false;
  if (/[\x00-\x1f\x7f]/.test(clean)) return false;
  return /^[a-zA-Z0-9._/-]+$/.test(clean);
}
