/**
 * Compresor de evidencias fotográficas en cliente (Canvas -> WebP <= 350 KB)
 * antes de persistir en IndexedDB (`outbox_mutations`) para operación Offline-First.
 *
 * Seguridad:
 *  - Inspecciona magic bytes antes de decodificar, bloqueando `.svg`, `.xml`, `.html` y ejecutables.
 *  - Garantiza estrictamente que la salida final nunca exceda `350 KB` (358 400 bytes).
 */

import {
  encodeBinaryToBase64,
  validateClientImageMagicBytes,
  type AllowedIncidenciaPhotoMime,
} from '../services/portalOfflineQueueService';
import { isCanvasFrameSolidBlack } from './cameraFrameGuard';

export const MAX_OFFLINE_COMPRESSED_PHOTO_BYTES = 350 * 1024; // 350 KB estricto

export interface CompressedOfflinePhotoResult {
  blob: Blob;
  base64: string;
  mimeType: AllowedIncidenciaPhotoMime;
  width: number;
  height: number;
  originalBytes: number;
  compressedBytes: number;
}

const PASS_PLAN: ReadonlyArray<{ maxSide: number; quality: number }> = [
  { maxSide: 1280, quality: 0.78 },
  { maxSide: 1080, quality: 0.68 },
  { maxSide: 900, quality: 0.56 },
  { maxSide: 720, quality: 0.46 },
  { maxSide: 600, quality: 0.36 },
];

function computeScaledDimensions(
  srcW: number,
  srcH: number,
  maxSide: number
): { width: number; height: number } {
  const w = Math.max(1, Math.round(srcW));
  const h = Math.max(1, Math.round(srcH));
  const longest = Math.max(w, h);
  if (longest <= maxSide) return { width: w, height: h };
  const ratio = maxSide / longest;
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
  };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: AllowedIncidenciaPhotoMime,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('No se pudo decodificar la fotografía seleccionada.'));
    };
    img.src = objectUrl;
  });
}

/**
 * Comprime cualquier imagen JPEG/PNG/WebP en el navegador a WebP (fallback JPEG) <= 350 KB.
 * En entorno Node sin Canvas valida magic bytes y límite estricto de 350 KB.
 */
export async function compressOfflineEvidencePhoto(
  input: File | Blob,
  maxBytes: number = MAX_OFFLINE_COMPRESSED_PHOTO_BYTES
): Promise<CompressedOfflinePhotoResult> {
  const rawBuffer = await input.arrayBuffer();
  const verified = validateClientImageMagicBytes(rawBuffer, 15 * 1024 * 1024);

  if (typeof document === 'undefined') {
    if (rawBuffer.byteLength > maxBytes) {
      throw new Error(
        `La fotografía supera el límite offline de ${Math.round(maxBytes / 1024)} KB.`
      );
    }
    const base64 = encodeBinaryToBase64(rawBuffer, maxBytes);
    const safeBytes = new Uint8Array(rawBuffer.byteLength);
    safeBytes.set(new Uint8Array(rawBuffer));
    return {
      blob: new Blob([safeBytes.buffer], { type: verified.mimeType }),
      base64,
      mimeType: verified.mimeType,
      width: 0,
      height: 0,
      originalBytes: rawBuffer.byteLength,
      compressedBytes: rawBuffer.byteLength,
    };
  }

  let source: CanvasImageSource;
  let naturalWidth = 0;
  let naturalHeight = 0;
  let bitmap: ImageBitmap | null = null;

  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(input);
      source = bitmap;
      naturalWidth = bitmap.width;
      naturalHeight = bitmap.height;
    } catch {
      const img = await loadImageElement(input);
      source = img;
      naturalWidth = img.naturalWidth || img.width;
      naturalHeight = img.naturalHeight || img.height;
    }
  } else {
    const img = await loadImageElement(input);
    source = img;
    naturalWidth = img.naturalWidth || img.width;
    naturalHeight = img.naturalHeight || img.height;
  }

  try {
    let bestBlob: Blob | null = null;
    let bestMime: AllowedIncidenciaPhotoMime = 'image/webp';
    let bestDims = { width: naturalWidth, height: naturalHeight };

    for (const step of PASS_PLAN) {
      const dims = computeScaledDimensions(naturalWidth, naturalHeight, step.maxSide);
      const canvas = document.createElement('canvas');
      canvas.width = dims.width;
      canvas.height = dims.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        throw new Error('No se pudo inicializar Canvas 2D para comprimir la fotografía.');
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dims.width, dims.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, dims.width, dims.height);

      // Respaldo anti-fotograma negro si createImageBitmap falló al decodificar en GPU móvil
      if (bitmap && isCanvasFrameSolidBlack(ctx, dims.width, dims.height)) {
        const imgFallback = await loadImageElement(input);
        if (typeof imgFallback.decode === 'function') {
          await imgFallback.decode().catch(() => undefined);
        }
        source = imgFallback;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, dims.width, dims.height);
        ctx.drawImage(imgFallback, 0, 0, dims.width, dims.height);
      }

      let candidate = await canvasToBlob(canvas, 'image/webp', step.quality);
      let candidateMime: AllowedIncidenciaPhotoMime = 'image/webp';

      if (!candidate || candidate.type !== 'image/webp') {
        candidate = await canvasToBlob(canvas, 'image/jpeg', step.quality);
        candidateMime = 'image/jpeg';
      }

      if (candidate) {
        bestBlob = candidate;
        bestMime = candidateMime;
        bestDims = dims;
        if (candidate.size <= maxBytes) {
          break;
        }
      }
    }

    if (!bestBlob) {
      throw new Error('No se pudo comprimir la fotografía para almacenamiento offline.');
    }

    if (bestBlob.size > maxBytes) {
      throw new Error(
        `La fotografía comprimida (${Math.round(bestBlob.size / 1024)} KB) aún supera el límite offline de ${Math.round(maxBytes / 1024)} KB.`
      );
    }

    const outBuf = await bestBlob.arrayBuffer();
    const outVerified = validateClientImageMagicBytes(outBuf, maxBytes);
    const base64 = encodeBinaryToBase64(outBuf, maxBytes);

    return {
      blob: bestBlob,
      base64,
      mimeType: bestMime === outVerified.mimeType ? bestMime : outVerified.mimeType,
      width: bestDims.width,
      height: bestDims.height,
      originalBytes: rawBuffer.byteLength,
      compressedBytes: outBuf.byteLength,
    };
  } finally {
    if (bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }
  }
}
