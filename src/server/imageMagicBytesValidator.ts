import crypto from 'node:crypto';
import {
  type AllowedAttendanceImageMime,
  ALL_SLOTS_FOTO_ASISTENCIA,
  MAX_ATTENDANCE_EVIDENCE_BYTES,
  type SlotFotoAsistencia,
} from '../types/attendanceEvidences';

export interface VerifiedImageBinary {
  mimeType: AllowedAttendanceImageMime;
  extension: 'jpg' | 'png' | 'webp';
  sizeBytes: number;
  sha256Hex: string;
}

export class AttendanceFileSecurityError extends Error {
  public readonly statusCode: number;
  public readonly code:
    | 'EMPTY_FILE_PAYLOAD'
    | 'FILE_TOO_LARGE'
    | 'UNSUPPORTED_MAGIC_BYTES'
    | 'DANGEROUS_CONTENT_DETECTED'
    | 'INVALID_PATH_COMPONENTS';

  constructor(
    statusCode: number,
    code:
      | 'EMPTY_FILE_PAYLOAD'
      | 'FILE_TOO_LARGE'
      | 'UNSUPPORTED_MAGIC_BYTES'
      | 'DANGEROUS_CONTENT_DETECTED'
      | 'INVALID_PATH_COMPONENTS',
    message: string
  ) {
    super(message);
    this.name = 'AttendanceFileSecurityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const UUID_STRICT_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMOTORA_ID_SAFE_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const YMD_STRICT_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const VALID_SLOTS_SET = new Set<string>(ALL_SLOTS_FOTO_ASISTENCIA);
const SAFE_STORAGE_PATH_REGEX =
  /^asistencia\/\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\/[A-Za-z0-9_-]{1,64}\/(JORNADA_INGRESO|JORNADA_SALIDA|MANANA_INGRESO|MANANA_SALIDA|TARDE_INGRESO|TARDE_SALIDA)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-\d{10,16})?\.(jpg|png|webp)$/;
const SAFE_PORTAL_MODULE_PATH_REGEX =
  /^[A-Za-z0-9_-]{1,64}\/(asistencia|inventario|degustacion|precios|merchandising)\/[A-Za-z0-9_.-]{8,96}\.(jpg|jpeg|png|webp)$/;

/**
 * Inspecciona los *magic bytes* reales del binario recibido en servidor:
 * - Acepta ÚNICAMENTE `image/jpeg` (FF D8 FF), `image/png` (89 50 4E 47 0D 0A 1A 0A)
 *   e `image/webp` (RIFF....WEBP).
 * - Rechaza de plano ejecutables (`MZ`), documentos HTML/SVG/XML (`<svg`, `<!DOCTYPE`, `<html`, `<script`),
 *   PDFs (`%PDF`) o extensiones falsificadas, así como archivos vacíos o mayores a 5 MB.
 */
export function verifyAttendanceImageMagicBytes(
  buffer: Buffer,
  maxBytes: number = MAX_ATTENDANCE_EVIDENCE_BYTES
): VerifiedImageBinary {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    throw new AttendanceFileSecurityError(
      400,
      'EMPTY_FILE_PAYLOAD',
      'No se recibió ningún archivo binario de imagen.'
    );
  }

  if (buffer.byteLength > maxBytes) {
    throw new AttendanceFileSecurityError(
      413,
      'FILE_TOO_LARGE',
      'La fotografía supera el límite máximo permitido de 5 MB.'
    );
  }

  if (buffer.byteLength < 12) {
    throw new AttendanceFileSecurityError(
      415,
      'UNSUPPORTED_MAGIC_BYTES',
      'El archivo es demasiado pequeño o está corrupto. Solo se permiten fotografías JPEG, PNG o WebP.'
    );
  }

  // Detección explícita de firmas peligrosas (ejecutables PE/ELF, scripts HTML/SVG/XML)
  const headAscii = buffer
    .subarray(0, Math.min(256, buffer.byteLength))
    .toString('utf8')
    .trimStart()
    .toLowerCase();

  if (
    (buffer[0] === 0x4d && buffer[1] === 0x5a) || // Windows PE (.exe / .dll)
    (buffer[0] === 0x7f &&
      buffer[1] === 0x45 &&
      buffer[2] === 0x4c &&
      buffer[3] === 0x46) || // Linux ELF
    headAscii.startsWith('<svg') ||
    headAscii.startsWith('<?xml') ||
    headAscii.startsWith('<!doctype html') ||
    headAscii.startsWith('<html') ||
    headAscii.startsWith('<script') ||
    headAscii.includes('<svg ')
  ) {
    throw new AttendanceFileSecurityError(
      415,
      'DANGEROUS_CONTENT_DETECTED',
      'Formato bloqueado por seguridad: no se admiten archivos ejecutables, HTML ni SVG.'
    );
  }

  let detectedMime: AllowedAttendanceImageMime | null = null;
  let extension: 'jpg' | 'png' | 'webp' | null = null;

  // 1. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    detectedMime = 'image/jpeg';
    extension = 'jpg';
  }
  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  else if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    detectedMime = 'image/png';
    extension = 'png';
  }
  // 3. WebP: "RIFF" (bytes 0..3) + "WEBP" (bytes 8..11)
  else if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    detectedMime = 'image/webp';
    extension = 'webp';
  }

  if (!detectedMime || !extension) {
    throw new AttendanceFileSecurityError(
      415,
      'UNSUPPORTED_MAGIC_BYTES',
      'Formato de archivo no permitido (magic bytes inválidos). Suba únicamente imágenes reales JPEG, PNG o WebP.'
    );
  }

  const sha256Hex = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    mimeType: detectedMime,
    extension,
    sizeBytes: buffer.byteLength,
    sha256Hex,
  };
}

/**
 * Valida estrictamente que una clave de Storage generada o leída para borrar/firmar
 * sea completamente inmune a Path Traversal (`..`, `\`, `\0`, `//`) y respete la estructura
 * canónica inmutable del bucket privado.
 */
export function assertSafeAttendanceStoragePath(storagePath: string): string {
  const clean = String(storagePath || '').trim();
  if (
    !clean ||
    clean.includes('..') ||
    clean.includes('\\') ||
    clean.includes('\0') ||
    clean.includes('//') ||
    clean.startsWith('/') ||
    (!SAFE_STORAGE_PATH_REGEX.test(clean) && !SAFE_PORTAL_MODULE_PATH_REGEX.test(clean))
  ) {
    throw new AttendanceFileSecurityError(
      400,
      'INVALID_PATH_COMPONENTS',
      'Ruta de Storage inválida o bloqueada por protección anti-path-traversal.'
    );
  }
  return clean;
}

/**
 * Construye una ruta determinística, única e inmutable en servidor ignorando por completo cualquier
 * nombre de archivo suministrado por el cliente (inmunidad total frente a Path Traversal):
 * - Con `timestampMs`: `asistencia/{yyyy-mm-dd}/{promotora_id}/{slot_foto}_{uuid}-{timestampMs}.{ext}`
 * - Sin `timestampMs`: `asistencia/{yyyy-mm-dd}/{promotora_id}/{slot_foto}_{uuid}.{ext}`
 */
export function buildDeterministicAttendanceStoragePath(params: {
  fechaJornada: string;
  promotoraId: string;
  slotFoto: SlotFotoAsistencia;
  extension: 'jpg' | 'png' | 'webp';
  fileUuid?: string;
  timestampMs?: number;
}): string {
  const cleanDate = String(params.fechaJornada || '').trim();
  const cleanPromotoraId = String(params.promotoraId || '')
    .trim()
    .toLowerCase();
  const cleanSlot = String(params.slotFoto || '').trim();
  const generatedUuid = (params.fileUuid || crypto.randomUUID()).trim().toLowerCase();

  let timestampSuffix = '';
  if (params.timestampMs !== undefined) {
    const safeTs = Math.trunc(params.timestampMs);
    if (!Number.isFinite(safeTs) || safeTs < 1_000_000_000 || safeTs > 9_999_999_999_999_999) {
      throw new AttendanceFileSecurityError(
        400,
        'INVALID_PATH_COMPONENTS',
        'Marca temporal inválida para generar la ruta segura en Storage.'
      );
    }
    timestampSuffix = `-${safeTs}`;
  }

  if (
    !YMD_STRICT_REGEX.test(cleanDate) ||
    !PROMOTORA_ID_SAFE_REGEX.test(cleanPromotoraId) ||
    !VALID_SLOTS_SET.has(cleanSlot) ||
    !UUID_STRICT_REGEX.test(generatedUuid) ||
    !['jpg', 'png', 'webp'].includes(params.extension)
  ) {
    throw new AttendanceFileSecurityError(
      400,
      'INVALID_PATH_COMPONENTS',
      'Componentes inválidos para generar la ruta segura en Storage.'
    );
  }

  return assertSafeAttendanceStoragePath(
    `asistencia/${cleanDate}/${cleanPromotoraId}/${cleanSlot}_${generatedUuid}${timestampSuffix}.${params.extension}`
  );
}
