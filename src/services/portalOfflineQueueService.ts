/**
 * Cola Offline resiliente en IndexedDB (`codizulca_portal_offline_v1`) con reintento
 * exponencial e idempotencia para el Portal de Campo (`/portal` · Hito 5 `B-08` + Compuerta G3).
 *
 * NOTA DE SEGURIDAD (`S-05`): `cleanSync.ts` preserva explícitamente toda base IndexedDB
 * cuyo nombre comience con `codizulca`, garantizando cero pérdida de marcajes e incidencias offline.
 */

import type { EjecucionPdvInput } from '../types/degustacionesPipeline';
import type { SeveridadIncidenciaPdv, TipoIncidenciaPdv } from './popIncidenciasService';
import type { OperativeSucursal } from './userManagementService';

export const PORTAL_OFFLINE_IDB_NAME = 'codizulca_portal_offline_v1';
export const PORTAL_OFFLINE_STORE_NAME = 'pending_actions';
const PORTAL_OFFLINE_IDB_VERSION = 1;

export const MAX_OFFLINE_INCIDENCIA_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB estricto

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

export type QueuedPortalAction =
  | QueuedPortalRutaStepAction
  | QueuedPortalIncidenciaAction;

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

function generateSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  const msg = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('fetch failed') ||
    msg.includes('load failed') ||
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
