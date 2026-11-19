import crypto from 'node:crypto';

export type AllowedFiscalDocumentMime =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

export type AllowedFiscalDocumentExtension = 'pdf' | 'jpg' | 'png' | 'webp';

export const CONTRALORIA_FACTURAS_BUCKET_ID = 'contraloria-facturas';
export const MAX_FISCAL_RECEIPT_BYTES = 10 * 1024 * 1024; // 10 MB

export interface VerifiedFiscalDocumentBinary {
  mimeType: AllowedFiscalDocumentMime;
  extension: AllowedFiscalDocumentExtension;
  sizeBytes: number;
  sha256Hex: string;
}

export class FiscalDocumentSecurityError extends Error {
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
    this.name = 'FiscalDocumentSecurityError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const UUID_STRICT_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valida por bytes mágicos reales el comprobante fiscal recibido en el servidor:
 * - Acepta ÚNICAMENTE PDF (`%PDF-`), JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`)
 *   y WebP (`RIFF....WEBP`), hasta 10 MB.
 * - Rechaza ejecutables PE/ELF, ZIP/Office, HTML, SVG, XML, scripts o extensiones falsificadas.
 */
export function verifyFiscalDocumentMagicBytes(
  buffer: Buffer,
  maxBytes: number = MAX_FISCAL_RECEIPT_BYTES
): VerifiedFiscalDocumentBinary {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    throw new FiscalDocumentSecurityError(
      400,
      'EMPTY_FILE_PAYLOAD',
      'No se recibió ningún archivo binario de comprobante fiscal.'
    );
  }

  if (buffer.byteLength > maxBytes) {
    throw new FiscalDocumentSecurityError(
      413,
      'FILE_TOO_LARGE',
      'El archivo del comprobante fiscal supera el límite máximo permitido de 10 MB.'
    );
  }

  if (buffer.byteLength < 12) {
    throw new FiscalDocumentSecurityError(
      415,
      'UNSUPPORTED_MAGIC_BYTES',
      'Archivo demasiado pequeño o corrupto. Solo se admiten PDF, JPEG, PNG o WebP válidos.'
    );
  }

  const headAscii = buffer
    .subarray(0, Math.min(256, buffer.byteLength))
    .toString('utf8')
    .trimStart()
    .toLowerCase();

  // Bloqueo explícito de ejecutables, archivos comprimidos y vectores XSS (HTML/SVG/XML/JS)
  if (
    (buffer[0] === 0x4d && buffer[1] === 0x5a) || // Windows PE (.exe / .dll)
    (buffer[0] === 0x7f &&
      buffer[1] === 0x45 &&
      buffer[2] === 0x4c &&
      buffer[3] === 0x46) || // Linux ELF
    (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) || // ZIP / DOCX / XLSX
    headAscii.startsWith('<svg') ||
    headAscii.startsWith('<?xml') ||
    headAscii.startsWith('<!doctype html') ||
    headAscii.startsWith('<html') ||
    headAscii.startsWith('<script') ||
    headAscii.includes('<svg ') ||
    headAscii.includes('<script')
  ) {
    throw new FiscalDocumentSecurityError(
      415,
      'DANGEROUS_CONTENT_DETECTED',
      'Archivo bloqueado por seguridad: no se permiten ejecutables, HTML, SVG ni contenedores ZIP.'
    );
  }

  let mimeType: AllowedFiscalDocumentMime | null = null;
  let extension: AllowedFiscalDocumentExtension | null = null;

  // 1. PDF: %PDF- (25 50 44 46 2D)
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    mimeType = 'application/pdf';
    extension = 'pdf';
  }
  // 2. JPEG: FF D8 FF
  else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    mimeType = 'image/jpeg';
    extension = 'jpg';
  }
  // 3. PNG: 89 50 4E 47 0D 0A 1A 0A
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
    mimeType = 'image/png';
    extension = 'png';
  }
  // 4. WebP: RIFF....WEBP
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
    mimeType = 'image/webp';
    extension = 'webp';
  }

  if (!mimeType || !extension) {
    throw new FiscalDocumentSecurityError(
      415,
      'UNSUPPORTED_MAGIC_BYTES',
      'Formato de comprobante no permitido (magic bytes inválidos). Suba únicamente PDF, JPEG, PNG o WebP reales.'
    );
  }

  const sha256Hex = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    mimeType,
    extension,
    sizeBytes: buffer.byteLength,
    sha256Hex,
  };
}

/**
 * Construye una ruta determinística en servidor ignorando el nombre original del cliente
 * (inmunidad ante Path Traversal):
 * `facturas/{ZULIA|VALENCIA}/{requisicion_uuid}/{uuid}.{pdf|jpg|png|webp}`
 */
export function buildDeterministicInvoiceStoragePath(params: {
  sucursal: 'ZULIA' | 'VALENCIA';
  requisicionId: string;
  extension: AllowedFiscalDocumentExtension;
  fileUuid?: string;
}): string {
  const cleanBranch = String(params.sucursal || '').trim().toUpperCase();
  const cleanReqId = String(params.requisicionId || '').trim().toLowerCase();
  const cleanUuid = String(params.fileUuid || crypto.randomUUID()).trim().toLowerCase();

  if (cleanBranch !== 'ZULIA' && cleanBranch !== 'VALENCIA') {
    throw new FiscalDocumentSecurityError(
      400,
      'INVALID_PATH_COMPONENTS',
      'Sucursal operativa inválida para ruta de almacenamiento fiscal.'
    );
  }
  if (!UUID_STRICT_REGEX.test(cleanReqId) || !UUID_STRICT_REGEX.test(cleanUuid)) {
    throw new FiscalDocumentSecurityError(
      400,
      'INVALID_PATH_COMPONENTS',
      'Identificador UUID inválido para ruta de comprobante fiscal.'
    );
  }
  if (!['pdf', 'jpg', 'png', 'webp'].includes(params.extension)) {
    throw new FiscalDocumentSecurityError(
      400,
      'INVALID_PATH_COMPONENTS',
      'Extensión inválida para comprobante fiscal.'
    );
  }

  return `facturas/${cleanBranch}/${cleanReqId}/${cleanUuid}.${params.extension}`;
}
