import {
  type AllowedAttendanceImageMime,
  ALLOWED_ATTENDANCE_IMAGE_MIMES,
  MAX_ATTENDANCE_EVIDENCE_BYTES,
} from '../types/attendanceEvidences';
import { isCanvasFrameSolidBlack } from './cameraFrameGuard';

export interface CompressedAttendanceImage {
  blob: Blob;
  mimeType: AllowedAttendanceImageMime;
  width: number;
  height: number;
  originalBytes: number;
  compressedBytes: number;
}

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_ATTENDANCE_IMAGE_MIMES);
const DEFAULT_MAX_LONGEST_SIDE_PX = 1600;
const DEFAULT_QUALITY = 0.8;
const HEIC_ISOBMFF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
]);

/**
 * Detecta cabeceras reales ISO-BMFF de fotografías HEIC/HEIF capturadas por iPhone (iOS),
 * permitiendo su transcodificación segura a JPEG/WebP en `<canvas>` sin permitir archivos maliciosos.
 */
export function isHeicHeaderBytes(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 12) return false;
  // Caja ISO-BMFF `ftyp` en bytes 4..7
  if (
    bytes[4] !== 0x66 || // f
    bytes[5] !== 0x74 || // t
    bytes[6] !== 0x79 || // y
    bytes[7] !== 0x70 // p
  ) {
    return false;
  }
  const majorBrand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
  return HEIC_ISOBMFF_BRANDS.has(majorBrand);
}

/**
 * Valida en el navegador los primeros bytes reales del archivo seleccionado antes de
 * decodificarlo en `<canvas>` o enviarlo por red, bloqueando de inmediato archivos
 * `.svg`, `.html`, `.exe` o extensiones falsificadas.
 * Admite fotos HEIC/HEIF nativas de iPhone (iOS) para transcodificarlas a JPEG en `<canvas>`.
 */
export async function validateClientImageHeaderBytes(
  file: Blob
): Promise<AllowedAttendanceImageMime> {
  if (!file || file.size === 0) {
    throw new Error('El archivo seleccionado está vacío.');
  }

  const headBuf = await file.slice(0, 32).arrayBuffer();
  const bytes = new Uint8Array(headBuf);

  if (bytes.length < 12) {
    throw new Error(
      'Archivo inválido. Seleccione una fotografía válida en formato JPEG, PNG, WebP o HEIC (iPhone).'
    );
  }

  // Bloqueo temprano de SVG / HTML / XML / Ejecutables
  const asciiPrefix = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes)
    .trimStart()
    .toLowerCase();

  if (
    (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
    asciiPrefix.startsWith('<svg') ||
    asciiPrefix.startsWith('<?xml') ||
    asciiPrefix.startsWith('<!doctype') ||
    asciiPrefix.startsWith('<html') ||
    asciiPrefix.startsWith('<script')
  ) {
    throw new Error(
      'Formato bloqueado por seguridad: no se permiten archivos SVG, HTML ni ejecutables.'
    );
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (isHeicHeaderBytes(bytes)) {
    return 'image/jpeg';
  }

  throw new Error(
    'Formato no admitido. Suba únicamente fotografías reales en formato JPEG, PNG, WebP o HEIC (iPhone).'
  );
}

function computeTargetDimensions(
  srcWidth: number,
  srcHeight: number,
  maxLongestSide: number
): { width: number; height: number } {
  const safeW = Math.max(1, Math.round(srcWidth));
  const safeH = Math.max(1, Math.round(srcHeight));
  const longest = Math.max(safeW, safeH);

  if (longest <= maxLongestSide) {
    return { width: safeW, height: safeH };
  }

  const scale = maxLongestSide / longest;
  return {
    width: Math.max(1, Math.round(safeW * scale)),
    height: Math.max(1, Math.round(safeH * scale)),
  };
}

function canvasToBlobPromise(
  canvas: HTMLCanvasElement,
  mimeType: AllowedAttendanceImageMime,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob);
      },
      mimeType,
      quality
    );
  });
}

function loadHtmlImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('No se pudo decodificar la imagen seleccionada.'));
    };
    img.src = objectUrl;
  });
}

/**
 * Redimensiona y comprime fotografías capturadas desde cámaras móviles lentas:
 * - Lado mayor máximo: `1600px` preservando proporción exacta.
 * - Formato preferido: `image/webp` a calidad `0.80` (fallback automático a `image/jpeg` `0.80`).
 * - Verifica que el resultado final nunca exceda `5 MB` (`5_242_880` bytes).
 */
export async function compressAttendancePhotoForMobileUpload(
  file: File | Blob,
  options?: {
    maxLongestSidePx?: number;
    quality?: number;
  }
): Promise<CompressedAttendanceImage> {
  const headBytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const sourceIsHeic = isHeicHeaderBytes(headBytes);
  const detectedMime = await validateClientImageHeaderBytes(file);
  const maxSide = options?.maxLongestSidePx ?? DEFAULT_MAX_LONGEST_SIDE_PX;
  const quality = options?.quality ?? DEFAULT_QUALITY;

  // Entorno Node/pruebas sin DOM Canvas: validar tamaño y devolver blob verificado
  if (typeof document === 'undefined') {
    if (file.size > MAX_ATTENDANCE_EVIDENCE_BYTES) {
      throw new Error('La fotografía supera el límite máximo permitido de 5 MB.');
    }
    return {
      blob: file,
      mimeType: detectedMime,
      width: maxSide,
      height: maxSide,
      originalBytes: file.size,
      compressedBytes: file.size,
    };
  }

  let drawSource: CanvasImageSource;
  let naturalWidth = 0;
  let naturalHeight = 0;
  let bitmapToClose: ImageBitmap | null = null;

  if (typeof createImageBitmap === 'function') {
    try {
      bitmapToClose = await createImageBitmap(file);
      drawSource = bitmapToClose;
      naturalWidth = bitmapToClose.width;
      naturalHeight = bitmapToClose.height;
    } catch {
      const imgEl = await loadHtmlImageFromBlob(file);
      drawSource = imgEl;
      naturalWidth = imgEl.naturalWidth || imgEl.width;
      naturalHeight = imgEl.naturalHeight || imgEl.height;
    }
  } else {
    const imgEl = await loadHtmlImageFromBlob(file);
    drawSource = imgEl;
    naturalWidth = imgEl.naturalWidth || imgEl.width;
    naturalHeight = imgEl.naturalHeight || imgEl.height;
  }

  try {
    const { width, height } = computeTargetDimensions(naturalWidth, naturalHeight, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('No se pudo inicializar el motor gráfico de compresión en el navegador.');
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawSource, 0, 0, width, height);

    // Protección contra fallo GPU/iOS Safari donde createImageBitmap pinta un lienzo en negro
    if (bitmapToClose && isCanvasFrameSolidBlack(ctx, width, height)) {
      const imgEl = await loadHtmlImageFromBlob(file);
      if (typeof imgEl.decode === 'function') {
        await imgEl.decode().catch(() => undefined);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(imgEl, 0, 0, width, height);
    }

    // Si aún así el canvas quedara corrupto/en negro pero el archivo original es seguro <= 5 MB (y no HEIC crudo), preservar el original
    if (
      !sourceIsHeic &&
      isCanvasFrameSolidBlack(ctx, width, height) &&
      file.size <= MAX_ATTENDANCE_EVIDENCE_BYTES
    ) {
      return {
        blob: file,
        mimeType: detectedMime,
        width: naturalWidth || width,
        height: naturalHeight || height,
        originalBytes: file.size,
        compressedBytes: file.size,
      };
    }

    // Intentar WebP primero (óptimo para redes móviles 3G/4G), con fallback a JPEG
    let outputMime: AllowedAttendanceImageMime = 'image/webp';
    let encodedBlob = await canvasToBlobPromise(canvas, 'image/webp', quality);

    if (!encodedBlob || encodedBlob.type !== 'image/webp') {
      outputMime = 'image/jpeg';
      encodedBlob = await canvasToBlobPromise(canvas, 'image/jpeg', quality);
    }

    if (!encodedBlob || !ALLOWED_MIME_SET.has(outputMime)) {
      throw new Error('No se pudo comprimir la fotografía en un formato seguro.');
    }

    // Si aún excediera 5 MB en imágenes extremadamente densas, aplicar segunda pasada a calidad 0.68
    if (encodedBlob.size > MAX_ATTENDANCE_EVIDENCE_BYTES) {
      const tighter = await canvasToBlobPromise(canvas, outputMime, 0.68);
      if (tighter) {
        encodedBlob = tighter;
      }
    }

    if (encodedBlob.size > MAX_ATTENDANCE_EVIDENCE_BYTES) {
      throw new Error(
        'La fotografía comprimida aún supera el límite máximo de 5 MB. Intente tomar una foto con menor resolución.'
      );
    }

    return {
      blob: encodedBlob,
      mimeType: outputMime,
      width,
      height,
      originalBytes: file.size,
      compressedBytes: encodedBlob.size,
    };
  } finally {
    if (bitmapToClose && typeof bitmapToClose.close === 'function') {
      bitmapToClose.close();
    }
  }
}
