/**
 * Cola Offline resiliente en IndexedDB (`codizulca_portal_offline_v1`) con reintento
 * exponencial e idempotencia para el Portal de Campo (`/portal` · Hito 5 `B-08` + Compuerta G3).
 *
 * NOTA DE SEGURIDAD (`S-05`): `cleanSync.ts` preserva explícitamente toda base IndexedDB
 * cuyo nombre comience con `codizulca`, garantizando cero pérdida de marcajes e incidencias offline.
 */

import type { EjecucionPdvInput, RutaPromotoraRecord } from '../types/degustacionesPipeline';
import type {
  AttendanceLocationSource,
  SlotFotoAsistencia,
} from '../types/attendanceEvidences';
import type { PriceCurrency } from '../utils/bimonetaryPriceMath';
import { compressAttendancePhotoForMobileUpload } from '../utils/attendanceImageCompressor';
import type { SeveridadIncidenciaPdv, TipoIncidenciaPdv } from './popIncidenciasService';
import type { OperativeSucursal } from './userManagementService';
import type { VerifiedShiftSession } from './shiftLinksService';
import { requestSwPurgePrivateCaches } from '../lib/registerTradeSw';

export const PORTAL_OFFLINE_IDB_NAME = 'codizulca_portal_offline_v1';
export const PORTAL_OFFLINE_STORE_NAME = 'pending_actions';
export const PORTAL_CACHE_ROUTES_STORE = 'cached_routes';
export const PORTAL_CACHE_CLIENTS_STORE = 'cached_clients';
export const PORTAL_CACHE_PRODUCTS_STORE = 'cached_products';
export const PORTAL_SHIFT_META_STORE = 'shift_session';
const PORTAL_OFFLINE_IDB_VERSION = 2;

export const MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB máximo en lectura bruta
export const MAX_OFFLINE_QUEUE_PHOTO_BYTES = 350 * 1024; // 350 KB recomendado tras compresión Canvas/WebP

export const SHIFT_SESSION_STORAGE_KEY = 'codizulca.shift.promotora.v1';

export type AllowedIncidenciaPhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface QueuedPortalRutaStepAction {
  /** Identificador único idempotente (`client_submission_id`) */
  id: string;
  kind: 'RUTA_STEP';
  rutaId: string;
  accion: 'CHECKIN' | 'CHECKOUT';
  clienteNombre: string;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  motivoFueraGeocerca?: string;
  ejecucion?: EjecucionPdvInput | null;
  attemptCount: number;
  nextRetryAtMs: number;
  lastError: string | null;
  createdAtIso: string;
}

export interface QueuedPortalIncidenciaAction {
  /** Identificador único idempotente (`client_submission_id`) */
  id: string;
  kind: 'INCIDENCIA_PDV';
  pdvNombre: string;
  clienteId: string | null;
  rutaId: string | null;
  tipoIncidencia: TipoIncidenciaPdv;
  severidad: SeveridadIncidenciaPdv;
  descripcion: string;
  sucursal: OperativeSucursal | null;
  reportadoPorNombre?: string;
  photoBase64?: string | null;
  photoMimeType?: AllowedIncidenciaPhotoMime | null;
  attemptCount: number;
  nextRetryAtMs: number;
  lastError: string | null;
  createdAtIso: string;
}

export interface QueuedPortalInventoryAction {
  /** Identificador único idempotente (`client_submission_id`) */
  id: string;
  kind: 'INVENTARIO_LOG';
  store: string;
  zona?: string;
  product: string;
  initialQuantity: number;
  salesGenerated: number;
  degustations: number;
  comments?: string;
  cronogramaId?: string | null;
  attemptCount: number;
  nextRetryAtMs: number;
  lastError: string | null;
  createdAtIso: string;
}

export interface QueuedPortalPriceAction {
  /** Identificador único idempotente (`client_submission_id`) */
  id: string;
  kind: 'PRECIO_SURVEY';
  store: string;
  cadena?: string;
  zona?: string;
  ourProduct: string;
  ourPriceUsd: number;
  ownCurrency?: PriceCurrency;
  ownOriginalPrice?: number;
  bcvRate: number;
  bcvRateDate?: string;
  competitors: Array<{
    name: string;
    priceUsd?: number;
    originalPrice?: number;
    currency?: PriceCurrency;
  }>;
  photoBase64?: string | null;
  photoMimeType?: AllowedIncidenciaPhotoMime | null;
  observations?: string;
  ocrAsistido?: boolean;
  ocrConfianza?: 'alta' | 'media' | 'baja' | null;
  attemptCount: number;
  nextRetryAtMs: number;
  lastError: string | null;
  createdAtIso: string;
}

export interface QueuedPortalSurveyAction {
  /** Identificador único idempotente (`client_submission_id`) */
  id: string;
  kind: 'ENCUESTA_CONSUMIDOR';
  store: string;
  product: string;
  sabor: number;
  textura: number;
  intencionCompra: 'Muy probable' | 'Probable' | 'Poco probable' | 'Nada probable';
  percepcionCalidad: 'Mejor' | 'Igual' | 'Peor';
  relacionCalidadPrecio: 'Excelente' | 'Buena' | 'Regular' | 'Mala';
  recomendacion: number;
  comments?: string;
  attemptCount: number;
  nextRetryAtMs: number;
  lastError: string | null;
  createdAtIso: string;
}

export interface QueuedPortalMerchandisingAction {
  /** Identificador único idempotente (`client_submission_id`) */
  id: string;
  kind: 'MERCHANDISING_REPORT';
  mode: 'escaneo_gondola' | 'certificacion_visita';
  store: string;
  address?: string;
  date: string;
  time: string;
  activities: string[];
  productDetail: string;
  observations?: string;
  storeManagerName?: string;
  storeManagerRole?: string;
  storeManagerPhone?: string;
  photosBase64: Array<{ base64: string; mimeType: AllowedIncidenciaPhotoMime }>;
  signatureBase64?: string | null;
  shelfMetrics?: {
    category: string;
    ourFacings: number;
    competitorFacings: number;
    totalFacings: number;
    shareOfShelfPercent: number;
    outOfStockDetected: boolean;
    popDetected: boolean;
  };
  attemptCount: number;
  nextRetryAtMs: number;
  lastError: string | null;
  createdAtIso: string;
}

export interface QueuedPortalAttendanceAction {
  /** Identificador único idempotente (`client_submission_id`) */
  id: string;
  kind: 'ASISTENCIA_EVIDENCIA';
  slotFoto: SlotFotoAsistencia;
  pdvNombre: string;
  zona?: string;
  lat: number | null;
  lng: number | null;
  gpsAccuracy: number | null;
  locationSource?: AttendanceLocationSource;
  fechaJornada?: string;
  photoBase64: string;
  photoMimeType: AllowedIncidenciaPhotoMime;
  attemptCount: number;
  nextRetryAtMs: number;
  lastError: string | null;
  createdAtIso: string;
}

export type QueuedPortalAction =
  | QueuedPortalRutaStepAction
  | QueuedPortalIncidenciaAction
  | QueuedPortalInventoryAction
  | QueuedPortalPriceAction
  | QueuedPortalSurveyAction
  | QueuedPortalMerchandisingAction
  | QueuedPortalAttendanceAction;

export interface EnqueuePortalActionInput {
  id?: string;
  rutaId: string;
  accion: 'CHECKIN' | 'CHECKOUT';
  clienteNombre: string;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  motivoFueraGeocerca?: string;
  ejecucion?: EjecucionPdvInput | null;
  nowMs?: number;
}

export interface EnqueuePortalIncidenciaInput {
  id?: string;
  pdvNombre: string;
  clienteId?: string | null;
  rutaId?: string | null;
  tipoIncidencia: TipoIncidenciaPdv;
  severidad: SeveridadIncidenciaPdv;
  descripcion: string;
  sucursal?: OperativeSucursal | null;
  reportadoPorNombre?: string;
  photoBase64?: string | null;
  photoMimeType?: AllowedIncidenciaPhotoMime | string | null;
  nowMs?: number;
}

export interface FlushPortalQueueResult {
  attempted: number;
  succeeded: number;
  failed: number;
  remaining: number;
  syncedIds: string[];
}

// Almacén de respaldo en memoria para entornos sin IndexedDB (pruebas Node o WebView restringido)
const memoryFallbackQueue = new Map<string, QueuedPortalAction>();

export interface CachedPortalClientRef {
  id: string;
  codigo_cliente: string;
  nombre_comercial: string;
  direccion?: string | null;
  ciudad?: string | null;
  zona?: string | null;
  ruta?: string | null;
  latitud?: number | null;
  longitud?: number | null;
  radio_geocerca_m?: number | null;
}

export interface CachedPortalProductRef {
  id: string;
  codigo?: string | null;
  nombre: string;
  categoria?: string | null;
  marca?: string | null;
  unidad_medida?: string | null;
}

export interface PortalOfflineSnapshot {
  routes: RutaPromotoraRecord[];
  clients: CachedPortalClientRef[];
  products: CachedPortalProductRef[];
  syncedAtIso: string | null;
}

export interface StoredPortalShiftSession {
  token: string;
  session: VerifiedShiftSession;
  savedAtIso: string;
}

let memorySnapshot: PortalOfflineSnapshot = {
  routes: [],
  clients: [],
  products: [],
  syncedAtIso: null,
};
let memoryShiftSession: StoredPortalShiftSession | null = null;

function generateSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
}

function hasNativeIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openPortalQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PORTAL_OFFLINE_IDB_NAME, PORTAL_OFFLINE_IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PORTAL_OFFLINE_STORE_NAME)) {
        const store = db.createObjectStore(PORTAL_OFFLINE_STORE_NAME, { keyPath: 'id' });
        store.createIndex('by_created_at', 'createdAtIso', { unique: false });
        store.createIndex('by_next_retry', 'nextRetryAtMs', { unique: false });
      }
      if (!db.objectStoreNames.contains(PORTAL_CACHE_ROUTES_STORE)) {
        db.createObjectStore(PORTAL_CACHE_ROUTES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PORTAL_CACHE_CLIENTS_STORE)) {
        db.createObjectStore(PORTAL_CACHE_CLIENTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PORTAL_CACHE_PRODUCTS_STORE)) {
        db.createObjectStore(PORTAL_CACHE_PRODUCTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PORTAL_SHIFT_META_STORE)) {
        db.createObjectStore(PORTAL_SHIFT_META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('No se pudo abrir IndexedDB offline.'));
  });
}

/**
 * Inspección preventiva de *magic bytes* en cliente (sin dependencias Node):
 *  - Acepta exclusivamente `image/jpeg`, `image/png` e `image/webp`.
 *  - Rechaza archivos vacíos, > 5 MB, ejecutables PE/ELF y contenido HTML/SVG/XML.
 */
export function validateClientImageMagicBytes(
  rawBytes: ArrayBuffer | Uint8Array,
  maxBytes: number = MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES
): {
  mimeType: AllowedIncidenciaPhotoMime;
  extension: 'jpg' | 'png' | 'webp';
  sizeBytes: number;
} {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);

  if (bytes.byteLength === 0) {
    throw new Error('El archivo de evidencia fotográfica está vacío.');
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error('La fotografía supera el límite máximo permitido de 5 MB.');
  }
  if (bytes.byteLength < 12) {
    throw new Error(
      'Archivo demasiado pequeño o corrupto. Adjunta únicamente imágenes JPEG, PNG o WebP.'
    );
  }

  const headSample = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(256, bytes.byteLength)))
    .trimStart()
    .toLowerCase();

  if (
    (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
    (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) ||
    headSample.startsWith('<svg') ||
    headSample.startsWith('<?xml') ||
    headSample.startsWith('<!doctype html') ||
    headSample.startsWith('<html') ||
    headSample.startsWith('<script') ||
    headSample.includes('<svg ')
  ) {
    throw new Error(
      'Formato bloqueado por seguridad: no se admiten archivos ejecutables, HTML ni SVG.'
    );
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg', sizeBytes: bytes.byteLength };
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
    return { mimeType: 'image/png', extension: 'png', sizeBytes: bytes.byteLength };
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
    return { mimeType: 'image/webp', extension: 'webp', sizeBytes: bytes.byteLength };
  }

  throw new Error(
    'Formato de imagen no permitido (magic bytes inválidos). Usa únicamente JPEG, PNG o WebP reales.'
  );
}

function stripDataUrlBase64Prefix(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^data:[^;,]+;base64,/i, '')
    .replace(/\s+/g, '');
}

export function estimateBase64DecodedBytes(rawBase64: string): number {
  const clean = stripDataUrlBase64Prefix(rawBase64);
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function encodeBinaryToBase64(
  input: ArrayBuffer | Uint8Array,
  maxBytes: number = MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES
): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > maxBytes) {
    throw new Error('La fotografía supera el límite máximo permitido de 5 MB.');
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    for (let i = 0; i < slice.length; i += 1) {
      binary += String.fromCharCode(slice[i]!);
    }
  }
  return btoa(binary);
}

export function decodeBase64ToUint8Array(
  rawBase64: string,
  maxBytes: number = MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES
): Uint8Array {
  const clean = stripDataUrlBase64Prefix(rawBase64);
  if (!clean) return new Uint8Array(0);

  const estimated = estimateBase64DecodedBytes(clean);
  if (estimated > maxBytes) {
    throw new Error('La fotografía codificada supera el límite máximo permitido de 5 MB.');
  }

  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(clean, 'base64');
    if (buf.byteLength > maxBytes) {
      throw new Error('La fotografía codificada supera el límite máximo permitido de 5 MB.');
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  const binary = atob(clean);
  if (binary.length > maxBytes) {
    throw new Error('La fotografía codificada supera el límite máximo permitido de 5 MB.');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function decodeBase64ToBlob(
  rawBase64: string,
  mimeType?: string | null,
  maxBytes: number = MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES
): Blob {
  const bytes = decodeBase64ToUint8Array(rawBase64, maxBytes);
  const safeCopy = new Uint8Array(bytes.byteLength);
  safeCopy.set(bytes);
  const safeMime: AllowedIncidenciaPhotoMime =
    mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/jpeg'
      ? mimeType
      : 'image/jpeg';
  return new Blob([safeCopy.buffer], { type: safeMime });
}

/**
 * Calcula la espera de reintento exponencial: `min(maxDelayMs, baseDelayMs * 2^attempt)` + jitter acotado.
 */
export function computeExponentialBackoffMs(
  attempt: number,
  options?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    randomFn?: () => number;
  }
): number {
  const safeAttempt = Math.max(0, Math.min(20, Math.trunc(attempt) || 0));
  const baseDelayMs = Math.max(250, options?.baseDelayMs ?? 1500);
  const maxDelayMs = Math.max(baseDelayMs, options?.maxDelayMs ?? 120_000);
  const jitterRatio = Math.max(0, Math.min(0.5, options?.jitterRatio ?? 0.15));
  const rng = options?.randomFn ?? Math.random;

  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, safeAttempt));
  if (jitterRatio === 0) {
    return Math.round(exponential);
  }
  const jitterOffset = exponential * jitterRatio * rng();
  return Math.min(maxDelayMs, Math.round(exponential + jitterOffset));
}

/**
 * Determina si un error corresponde a falla transitoria de red/conectividad apta para encolar offline.
 */
export function isTransientOfflineOrNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }
  if (err && typeof err === 'object') {
    const obj = err as { category?: unknown; name?: unknown };
    if (obj.category === 'NETWORK_OFFLINE' || obj.name === 'AbortError') {
      return true;
    }
  }
  const msg = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('fetch failed') ||
    msg.includes('load failed') ||
    msg.includes('aborted') ||
    msg.includes('offline') ||
    msg.includes('sin conexión') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  );
}

async function putActionRecord(record: QueuedPortalAction): Promise<void> {
  if (!hasNativeIndexedDb()) {
    memoryFallbackQueue.set(record.id, { ...record });
    return;
  }

  const db = await openPortalQueueDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PORTAL_OFFLINE_STORE_NAME, 'readwrite');
      tx.objectStore(PORTAL_OFFLINE_STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error guardando registro offline.'));
    });
  } finally {
    db.close();
  }
}

export async function enqueuePortalAction(
  input: EnqueuePortalActionInput
): Promise<QueuedPortalRutaStepAction> {
  const nowMs = input.nowMs ?? Date.now();
  const item: QueuedPortalRutaStepAction = {
    id: input.id && input.id.trim() ? input.id.trim() : generateSubmissionId(),
    kind: 'RUTA_STEP',
    rutaId: input.rutaId,
    accion: input.accion,
    clienteNombre: input.clienteNombre,
    lat: input.lat,
    lng: input.lng,
    accuracyMeters: input.accuracyMeters,
    motivoFueraGeocerca: input.motivoFueraGeocerca,
    ejecucion: input.ejecucion ?? null,
    attemptCount: 0,
    nextRetryAtMs: nowMs,
    lastError: null,
    createdAtIso: new Date(nowMs).toISOString(),
  };

  await putActionRecord(item);
  return item;
}

/**
 * Encola una incidencia PDV (incluyendo evidencia fotográfica opcional <= 5 MB)
 * dentro de `codizulca_portal_offline_v1` cuando `/portal` opera sin red.
 */
export async function enqueuePortalIncidenciaOffline(
  input: EnqueuePortalIncidenciaInput
): Promise<QueuedPortalIncidenciaAction> {
  const cleanPdvNombre = String(input.pdvNombre ?? '').trim();
  if (cleanPdvNombre.length < 2) {
    throw new Error('Indique el nombre del Punto de Venta para reportar la incidencia.');
  }

  const cleanDescripcion = String(input.descripcion ?? '').trim();
  if (cleanDescripcion.length < 5) {
    throw new Error('Describa la incidencia con al menos 5 caracteres.');
  }

  let normalizedPhotoB64: string | null = null;
  let normalizedPhotoMime: AllowedIncidenciaPhotoMime | null = null;

  if (input.photoBase64 && String(input.photoBase64).trim().length > 0) {
    const cleanB64 = stripDataUrlBase64Prefix(input.photoBase64);
    const decodedBytes = decodeBase64ToUint8Array(cleanB64, MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES);
    const verified = validateClientImageMagicBytes(
      decodedBytes,
      MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES
    );
    normalizedPhotoB64 = cleanB64;
    normalizedPhotoMime =
      input.photoMimeType === 'image/jpeg' ||
      input.photoMimeType === 'image/png' ||
      input.photoMimeType === 'image/webp'
        ? input.photoMimeType
        : verified.mimeType;
  }

  const nowMs = input.nowMs ?? Date.now();
  const item: QueuedPortalIncidenciaAction = {
    id: input.id && input.id.trim() ? input.id.trim() : generateSubmissionId(),
    kind: 'INCIDENCIA_PDV',
    pdvNombre: cleanPdvNombre,
    clienteId: input.clienteId ? String(input.clienteId).trim() : null,
    rutaId: input.rutaId ? String(input.rutaId).trim() : null,
    tipoIncidencia: input.tipoIncidencia,
    severidad: input.severidad,
    descripcion: cleanDescripcion.slice(0, 1000),
    sucursal: input.sucursal ?? null,
    ...(input.reportadoPorNombre && input.reportadoPorNombre.trim()
      ? { reportadoPorNombre: input.reportadoPorNombre.trim() }
      : {}),
    photoBase64: normalizedPhotoB64,
    photoMimeType: normalizedPhotoMime,
    attemptCount: 0,
    nextRetryAtMs: nowMs,
    lastError: null,
    createdAtIso: new Date(nowMs).toISOString(),
  };

  await putActionRecord(item);
  return item;
}

/**
 * Comprime (incluyendo fotos HEIC/HEIF de iPhone en navegador) y codifica un Blob de imagen
 * a Base64 seguro para persistencia offline en IndexedDB.
 */
export async function encodeBlobToOfflineBase64(
  file: Blob,
  maxLongestSidePx = 1280
): Promise<{ base64: string; mimeType: AllowedIncidenciaPhotoMime }> {
  let targetBlob: Blob = file;
  let mimeType: AllowedIncidenciaPhotoMime =
    file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/jpeg'
      ? file.type
      : 'image/jpeg';

  try {
    const compressed = await compressAttendancePhotoForMobileUpload(file, {
      maxLongestSidePx,
      quality: 0.78,
    });
    targetBlob = compressed.blob;
    mimeType = compressed.mimeType;
  } catch {
    // Si ya es JPEG/PNG/WebP válido en entorno sin canvas, validar magic bytes abajo
  }

  const rawBuf = await targetBlob.arrayBuffer();
  const verified = validateClientImageMagicBytes(rawBuf, MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES);
  const base64 = encodeBinaryToBase64(rawBuf, MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES);
  return { base64, mimeType: verified.mimeType ?? mimeType };
}

export async function enqueuePortalInventoryAction(input: {
  id?: string;
  store: string;
  zona?: string;
  product: string;
  initialQuantity: number;
  salesGenerated: number;
  degustations: number;
  comments?: string;
  cronogramaId?: string | null;
  nowMs?: number;
}): Promise<QueuedPortalInventoryAction> {
  const nowMs = input.nowMs ?? Date.now();
  const item: QueuedPortalInventoryAction = {
    id: input.id && input.id.trim() ? input.id.trim() : generateSubmissionId(),
    kind: 'INVENTARIO_LOG',
    store: String(input.store || '').trim(),
    zona: input.zona,
    product: String(input.product || '').trim(),
    initialQuantity: Number(input.initialQuantity),
    salesGenerated: Number(input.salesGenerated),
    degustations: Number(input.degustations),
    comments: input.comments,
    cronogramaId: input.cronogramaId ?? null,
    attemptCount: 0,
    nextRetryAtMs: nowMs,
    lastError: null,
    createdAtIso: new Date(nowMs).toISOString(),
  };
  await putActionRecord(item);
  return item;
}

export async function enqueuePortalPriceAction(input: {
  id?: string;
  store: string;
  cadena?: string;
  zona?: string;
  ourProduct: string;
  ourPriceUsd: number;
  ownCurrency?: PriceCurrency;
  ownOriginalPrice?: number;
  bcvRate: number;
  bcvRateDate?: string;
  competitors: Array<{
    name: string;
    priceUsd?: number;
    originalPrice?: number;
    currency?: PriceCurrency;
  }>;
  photoFile?: Blob | null;
  observations?: string;
  ocrAsistido?: boolean;
  ocrConfianza?: 'alta' | 'media' | 'baja' | null;
  nowMs?: number;
}): Promise<QueuedPortalPriceAction> {
  let photoBase64: string | null = null;
  let photoMimeType: AllowedIncidenciaPhotoMime | null = null;
  if (input.photoFile) {
    const encoded = await encodeBlobToOfflineBase64(input.photoFile, 960);
    photoBase64 = encoded.base64;
    photoMimeType = encoded.mimeType;
  }
  const nowMs = input.nowMs ?? Date.now();
  const item: QueuedPortalPriceAction = {
    id: input.id && input.id.trim() ? input.id.trim() : generateSubmissionId(),
    kind: 'PRECIO_SURVEY',
    store: String(input.store || '').trim(),
    cadena: input.cadena,
    zona: input.zona,
    ourProduct: String(input.ourProduct || '').trim(),
    ourPriceUsd: Number(input.ourPriceUsd),
    ownCurrency: input.ownCurrency,
    ownOriginalPrice: input.ownOriginalPrice,
    bcvRate: Number(input.bcvRate),
    bcvRateDate: input.bcvRateDate,
    competitors: input.competitors,
    photoBase64,
    photoMimeType,
    observations: input.observations,
    ocrAsistido: input.ocrAsistido,
    ocrConfianza: input.ocrConfianza ?? null,
    attemptCount: 0,
    nextRetryAtMs: nowMs,
    lastError: null,
    createdAtIso: new Date(nowMs).toISOString(),
  };
  await putActionRecord(item);
  return item;
}

export async function enqueuePortalSurveyAction(input: {
  id?: string;
  store: string;
  product: string;
  sabor: number;
  textura: number;
  intencionCompra: 'Muy probable' | 'Probable' | 'Poco probable' | 'Nada probable';
  percepcionCalidad: 'Mejor' | 'Igual' | 'Peor';
  relacionCalidadPrecio: 'Excelente' | 'Buena' | 'Regular' | 'Mala';
  recomendacion: number;
  comments?: string;
  nowMs?: number;
}): Promise<QueuedPortalSurveyAction> {
  const nowMs = input.nowMs ?? Date.now();
  const item: QueuedPortalSurveyAction = {
    id: input.id && input.id.trim() ? input.id.trim() : generateSubmissionId(),
    kind: 'ENCUESTA_CONSUMIDOR',
    store: String(input.store || '').trim(),
    product: String(input.product || '').trim(),
    sabor: input.sabor,
    textura: input.textura,
    intencionCompra: input.intencionCompra,
    percepcionCalidad: input.percepcionCalidad,
    relacionCalidadPrecio: input.relacionCalidadPrecio,
    recomendacion: input.recomendacion,
    comments: input.comments,
    attemptCount: 0,
    nextRetryAtMs: nowMs,
    lastError: null,
    createdAtIso: new Date(nowMs).toISOString(),
  };
  await putActionRecord(item);
  return item;
}

export async function enqueuePortalMerchandisingAction(input: {
  id?: string;
  mode: 'escaneo_gondola' | 'certificacion_visita';
  store: string;
  address?: string;
  date: string;
  time: string;
  activities: string[];
  productDetail: string;
  observations?: string;
  storeManagerName?: string;
  storeManagerRole?: string;
  storeManagerPhone?: string;
  photoFiles: Blob[];
  signatureBlob?: Blob | null;
  shelfMetrics?: QueuedPortalMerchandisingAction['shelfMetrics'];
  nowMs?: number;
}): Promise<QueuedPortalMerchandisingAction> {
  const photosBase64: Array<{ base64: string; mimeType: AllowedIncidenciaPhotoMime }> = [];
  for (const photo of input.photoFiles.slice(0, 6)) {
    photosBase64.push(await encodeBlobToOfflineBase64(photo, 1200));
  }
  let signatureBase64: string | null = null;
  if (input.signatureBlob) {
    const rawBuf = await input.signatureBlob.arrayBuffer();
    signatureBase64 = encodeBinaryToBase64(rawBuf, MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES);
  }
  const nowMs = input.nowMs ?? Date.now();
  const item: QueuedPortalMerchandisingAction = {
    id: input.id && input.id.trim() ? input.id.trim() : generateSubmissionId(),
    kind: 'MERCHANDISING_REPORT',
    mode: input.mode,
    store: String(input.store || '').trim(),
    address: input.address,
    date: input.date,
    time: input.time,
    activities: input.activities,
    productDetail: input.productDetail,
    observations: input.observations,
    storeManagerName: input.storeManagerName,
    storeManagerRole: input.storeManagerRole,
    storeManagerPhone: input.storeManagerPhone,
    photosBase64,
    signatureBase64,
    shelfMetrics: input.shelfMetrics,
    attemptCount: 0,
    nextRetryAtMs: nowMs,
    lastError: null,
    createdAtIso: new Date(nowMs).toISOString(),
  };
  await putActionRecord(item);
  return item;
}

export async function enqueuePortalAttendanceAction(input: {
  id?: string;
  slotFoto: SlotFotoAsistencia;
  pdvNombre: string;
  zona?: string;
  lat: number | null;
  lng: number | null;
  gpsAccuracy: number | null;
  locationSource?: AttendanceLocationSource;
  fechaJornada?: string;
  imageFile: Blob;
  nowMs?: number;
}): Promise<QueuedPortalAttendanceAction> {
  const encoded = await encodeBlobToOfflineBase64(input.imageFile, 1280);
  const nowMs = input.nowMs ?? Date.now();
  const item: QueuedPortalAttendanceAction = {
    id: input.id && input.id.trim() ? input.id.trim() : generateSubmissionId(),
    kind: 'ASISTENCIA_EVIDENCIA',
    slotFoto: input.slotFoto,
    pdvNombre: String(input.pdvNombre || '').trim(),
    zona: input.zona,
    lat: input.lat,
    lng: input.lng,
    gpsAccuracy: input.gpsAccuracy,
    locationSource: input.locationSource ?? 'gps_high',
    fechaJornada: input.fechaJornada,
    photoBase64: encoded.base64,
    photoMimeType: encoded.mimeType,
    attemptCount: 0,
    nextRetryAtMs: nowMs,
    lastError: null,
    createdAtIso: new Date(nowMs).toISOString(),
  };
  await putActionRecord(item);
  return item;
}

export async function listPendingPortalActions(): Promise<QueuedPortalAction[]> {
  if (!hasNativeIndexedDb()) {
    return Array.from(memoryFallbackQueue.values()).sort((a, b) =>
      a.createdAtIso.localeCompare(b.createdAtIso)
    );
  }

  const db = await openPortalQueueDb();
  try {
    const rows = await new Promise<QueuedPortalAction[]>((resolve, reject) => {
      const tx = db.transaction(PORTAL_OFFLINE_STORE_NAME, 'readonly');
      const req = tx.objectStore(PORTAL_OFFLINE_STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as QueuedPortalAction[]) || []);
      req.onerror = () => reject(req.error ?? new Error('Error leyendo cola offline.'));
    });
    return rows.sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  } finally {
    db.close();
  }
}

export async function removePortalAction(id: string): Promise<void> {
  if (!hasNativeIndexedDb()) {
    memoryFallbackQueue.delete(id);
    return;
  }

  const db = await openPortalQueueDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PORTAL_OFFLINE_STORE_NAME, 'readwrite');
      tx.objectStore(PORTAL_OFFLINE_STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error limpiando marcaje sincronizado.'));
    });
  } finally {
    db.close();
  }
}

export function clearMemoryPortalQueueForTests(): void {
  memoryFallbackQueue.clear();
  memorySnapshot = { routes: [], clients: [], products: [], syncedAtIso: null };
  memoryShiftSession = null;
}

/**
 * Precarga en IndexedDB la foto acotada de la jornada activa (rutas, clientes y productos de la región/ruta)
 * para permitir trabajo 100 % offline cuando la promotora pierde cobertura en tienda.
 */
export async function savePortalOfflineSnapshot(snapshot: PortalOfflineSnapshot): Promise<void> {
  memorySnapshot = {
    routes: [...snapshot.routes],
    clients: [...snapshot.clients],
    products: [...snapshot.products],
    syncedAtIso: snapshot.syncedAtIso ?? new Date().toISOString(),
  };

  if (!hasNativeIndexedDb()) return;

  const db = await openPortalQueueDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [
          PORTAL_CACHE_ROUTES_STORE,
          PORTAL_CACHE_CLIENTS_STORE,
          PORTAL_CACHE_PRODUCTS_STORE,
          PORTAL_SHIFT_META_STORE,
        ],
        'readwrite'
      );
      const rStore = tx.objectStore(PORTAL_CACHE_ROUTES_STORE);
      const cStore = tx.objectStore(PORTAL_CACHE_CLIENTS_STORE);
      const pStore = tx.objectStore(PORTAL_CACHE_PRODUCTS_STORE);
      const mStore = tx.objectStore(PORTAL_SHIFT_META_STORE);

      rStore.clear();
      for (const r of memorySnapshot.routes) rStore.put(r);
      cStore.clear();
      for (const c of memorySnapshot.clients) cStore.put(c);
      pStore.clear();
      for (const p of memorySnapshot.products) pStore.put(p);
      mStore.put({ key: 'snapshot_synced_at', value: memorySnapshot.syncedAtIso });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error precargando caché offline de jornada.'));
    });
  } finally {
    db.close();
  }
}

export async function loadPortalOfflineSnapshot(): Promise<PortalOfflineSnapshot> {
  if (!hasNativeIndexedDb()) {
    return {
      routes: [...memorySnapshot.routes],
      clients: [...memorySnapshot.clients],
      products: [...memorySnapshot.products],
      syncedAtIso: memorySnapshot.syncedAtIso,
    };
  }

  const db = await openPortalQueueDb();
  try {
    return await new Promise<PortalOfflineSnapshot>((resolve, reject) => {
      const tx = db.transaction(
        [
          PORTAL_CACHE_ROUTES_STORE,
          PORTAL_CACHE_CLIENTS_STORE,
          PORTAL_CACHE_PRODUCTS_STORE,
          PORTAL_SHIFT_META_STORE,
        ],
        'readonly'
      );
      const rReq = tx.objectStore(PORTAL_CACHE_ROUTES_STORE).getAll();
      const cReq = tx.objectStore(PORTAL_CACHE_CLIENTS_STORE).getAll();
      const pReq = tx.objectStore(PORTAL_CACHE_PRODUCTS_STORE).getAll();
      const mReq = tx.objectStore(PORTAL_SHIFT_META_STORE).get('snapshot_synced_at');

      tx.oncomplete = () => {
        const metaRec = mReq.result as { key: string; value?: string | null } | undefined;
        resolve({
          routes: (rReq.result as RutaPromotoraRecord[]) || [],
          clients: (cReq.result as CachedPortalClientRef[]) || [],
          products: (pReq.result as CachedPortalProductRef[]) || [],
          syncedAtIso: metaRec?.value ?? null,
        });
      };
      tx.onerror = () => reject(tx.error ?? new Error('Error leyendo caché offline de jornada.'));
    });
  } finally {
    db.close();
  }
}

export async function savePortalShiftSession(
  record: StoredPortalShiftSession | null
): Promise<void> {
  memoryShiftSession = record ? { ...record } : null;
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (record) {
        sessionStorage.setItem(SHIFT_SESSION_STORAGE_KEY, JSON.stringify(record));
      } else {
        sessionStorage.removeItem(SHIFT_SESSION_STORAGE_KEY);
      }
    }
  } catch {
    /* sessionStorage restringido */
  }

  if (!hasNativeIndexedDb()) return;

  const db = await openPortalQueueDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PORTAL_SHIFT_META_STORE, 'readwrite');
      const store = tx.objectStore(PORTAL_SHIFT_META_STORE);
      if (record) {
        store.put({ key: 'active_shift', value: record });
      } else {
        store.delete('active_shift');
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Error guardando sesión temporal.'));
    });
  } finally {
    db.close();
  }
}

export async function loadPortalShiftSession(): Promise<StoredPortalShiftSession | null> {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(SHIFT_SESSION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredPortalShiftSession;
        if (parsed?.token && parsed?.session?.expires_at) {
          memoryShiftSession = parsed;
          return parsed;
        }
      }
    }
  } catch {
    /* continuar con IndexedDB */
  }

  if (!hasNativeIndexedDb()) return memoryShiftSession;

  const db = await openPortalQueueDb();
  try {
    return await new Promise<StoredPortalShiftSession | null>((resolve, reject) => {
      const tx = db.transaction(PORTAL_SHIFT_META_STORE, 'readonly');
      const req = tx.objectStore(PORTAL_SHIFT_META_STORE).get('active_shift');
      req.onsuccess = () => {
        const rec = req.result as { value?: StoredPortalShiftSession } | undefined;
        resolve(rec?.value ?? null);
      };
      req.onerror = () => reject(req.error ?? new Error('Error leyendo sesión temporal.'));
    });
  } finally {
    db.close();
  }
}

/**
 * Purga total y determinista de datos sensibles locales (Regla 5):
 * limpia todas las tablas de IndexedDB (`pending_actions`, `cached_routes`, `cached_clients`,
 * `cached_products`, `shift_session`), `sessionStorage` y solicita al Service Worker purgar cachés privadas.
 * Debe ejecutarse automáticamente al expirar, revocarse o cerrarse una jornada.
 */
export async function purgePortalOfflineSensitiveData(): Promise<void> {
  memoryFallbackQueue.clear();
  memorySnapshot = { routes: [], clients: [], products: [], syncedAtIso: null };
  memoryShiftSession = null;

  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(SHIFT_SESSION_STORAGE_KEY);
    }
  } catch {
    /* ignorar */
  }

  if (hasNativeIndexedDb()) {
    try {
      const db = await openPortalQueueDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const storeNames = [
            PORTAL_OFFLINE_STORE_NAME,
            PORTAL_CACHE_ROUTES_STORE,
            PORTAL_CACHE_CLIENTS_STORE,
            PORTAL_CACHE_PRODUCTS_STORE,
            PORTAL_SHIFT_META_STORE,
          ].filter((s) => db.objectStoreNames.contains(s));
          if (storeNames.length === 0) {
            resolve();
            return;
          }
          const tx = db.transaction(storeNames, 'readwrite');
          for (const s of storeNames) {
            tx.objectStore(s).clear();
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('Error purgando IndexedDB.'));
        });
      } finally {
        db.close();
      }
    } catch {
      /* intentar borrado completo de BD si no abrió */
      try {
        indexedDB.deleteDatabase(PORTAL_OFFLINE_IDB_NAME);
      } catch {
        /* ignorar */
      }
    }
  }

  // Purgar cachés privadas del navegador si el API CacheStorage está presente
  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith('codizulca-trade-shell-') && !k.startsWith('rutadegustacion-fuentes'))
          .map((k) => caches.delete(k))
      );
    } catch {
      /* ignorar */
    }
  }

  await requestSwPurgePrivateCaches().catch(() => undefined);
}

/**
 * Procesa en orden FIFO los marcajes/ejecuciones/incidencias pendientes de sincronización.
 * Si un envío falla, incrementa `attemptCount` y programa el siguiente intento con backoff exponencial.
 */
export async function flushPortalOfflineQueue(
  executor: (action: QueuedPortalAction) => Promise<void>,
  options?: {
    nowMs?: number;
    forceIgnoreSchedule?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
    randomFn?: () => number;
  }
): Promise<FlushPortalQueueResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const pending = await listPendingPortalActions();

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const syncedIds: string[] = [];

  for (const item of pending) {
    if (!options?.forceIgnoreSchedule && item.nextRetryAtMs > nowMs) {
      continue;
    }

    attempted += 1;
    try {
      await executor(item);
      await removePortalAction(item.id);
      succeeded += 1;
      syncedIds.push(item.id);
    } catch (err) {
      failed += 1;
      const nextAttempt = item.attemptCount + 1;
      const delayMs = computeExponentialBackoffMs(nextAttempt, {
        baseDelayMs: options?.baseDelayMs,
        maxDelayMs: options?.maxDelayMs,
        randomFn: options?.randomFn,
      });
      await putActionRecord({
        ...item,
        attemptCount: nextAttempt,
        nextRetryAtMs: nowMs + delayMs,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const remainingList = await listPendingPortalActions();
  return {
    attempted,
    succeeded,
    failed,
    remaining: remainingList.length,
    syncedIds,
  };
}
