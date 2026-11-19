/**
 * Cola Offline resiliente en IndexedDB (`codizulca_portal_offline_v1`) con reintento
 * exponencial e idempotencia para el Portal de Campo (`/portal` · Hito 5 `B-08`).
 *
 * NOTA DE SEGURIDAD (`S-05`): `cleanSync.ts` preserva explícitamente toda base IndexedDB
 * cuyo nombre comience con `codizulca`, garantizando cero pérdida de marcajes offline.
 */

import type { EjecucionPdvInput } from '../types/degustacionesPipeline';

export const PORTAL_OFFLINE_IDB_NAME = 'codizulca_portal_offline_v1';
export const PORTAL_OFFLINE_STORE_NAME = 'pending_actions';
const PORTAL_OFFLINE_IDB_VERSION = 1;

export interface QueuedPortalAction {
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
      tx.onerror = () => reject(tx.error ?? new Error('Error guardando marcaje offline.'));
    });
  } finally {
    db.close();
  }
}

export async function enqueuePortalAction(
  input: EnqueuePortalActionInput
): Promise<QueuedPortalAction> {
  const nowMs = input.nowMs ?? Date.now();
  const item: QueuedPortalAction = {
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
 * Procesa en orden FIFO los marcajes/ejecuciones pendientes de sincronización.
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
