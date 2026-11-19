import type { Entrega } from '../types';
import type { OutboxPayload } from './deliveryOps';

/**
 * Base de datos local (IndexedDB) del chofer. Solo contiene:
 *  - `synced_deliveries`: la última copia REAL del cronograma recibida del servidor (+ cambios del chofer aún pendientes).
 *  - `sync_outbox_queue`: cola FIFO de acciones reales del chofer pendientes de subir.
 *  - `meta`: configuración pública de conexión (para el Service Worker) y marcas de sincronización.
 * Nunca se siembra ni se inyectan datos de ejemplo. Funciona igual en la página y en el Service Worker.
 */
export const DB_NAME = 'rutadegustacion-offline';
const DB_VERSION = 1;
export const STORE_DELIVERIES = 'synced_deliveries' as const;
export const STORE_OUTBOX = 'sync_outbox_queue' as const;
export const STORE_META = 'meta' as const;
const CHANNEL_NAME = 'rutadegustacion-offline-changes';
/** Una operación «en vuelo» más antigua que esto se considera abandonada (p. ej. la pestaña se cerró). */
export const IN_FLIGHT_STALE_MS = 60_000;

export interface DeliverySyncMeta {
  /** Hay operaciones del chofer aún sin confirmar por el servidor. */
  pendiente: boolean;
  /** La acción necesitó el teléfono (no se pudo enviar al instante). Controla la etiqueta de la tarjeta. */
  marcada_offline: boolean;
  /** Última confirmación del servidor para esta entrega. */
  sincronizada_at_iso: string | null;
}

export type StoredDelivery = Entrega & {
  _sync: DeliverySyncMeta;
  /** Posición de la entrega en la lista que devolvió el servidor (conserva el orden del cronograma). */
  _orden: number;
};

export interface OutboxItem {
  /** Orden FIFO (autoincremental). */
  seq?: number;
  operation_id: string;
  delivery_id: string;
  payload: OutboxPayload;
  /** Instante exacto del toque del chofer en su teléfono. */
  created_at_iso: string;
  retry_count: number;
  last_error?: string | null;
  last_attempt_iso?: string | null;
  /** Epoch ms antes del cual no se reintenta (backoff). */
  next_attempt_at?: number;
  /** Epoch ms en que un enviador tomó la operación; evita fusionarla mientras viaja. */
  in_flight_since_ms?: number | null;
}

// ---------------------------------------------------------------------------
// Apertura y utilidades de transacción
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      dbPromise = null;
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DELIVERIES)) {
        const s = db.createObjectStore(STORE_DELIVERIES, { keyPath: 'id' });
        s.createIndex('by_fecha', 'fecha');
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const s = db.createObjectStore(STORE_OUTBOX, { keyPath: 'seq', autoIncrement: true });
        s.createIndex('by_operation_id', 'operation_id', { unique: true });
        s.createIndex('by_delivery', 'delivery_id');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('No se pudo abrir el almacenamiento del teléfono (IndexedDB).'));
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('El almacenamiento del teléfono está bloqueado por otra pestaña.'));
    };
  });
  return dbPromise;
}

function reqToPromise<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Ejecuta `work` dentro de una transacción y resuelve cuando ésta se confirma (commit). */
async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('Error de transacción en IndexedDB'));
    tx.onabort = () => reject(tx.error ?? new Error('Transacción abortada en IndexedDB'));
    work(tx)
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        try {
          tx.abort();
        } catch {
          /* ya finalizada */
        }
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// Notificación de cambios (entre pestañas y Service Worker)
// ---------------------------------------------------------------------------

type ChangeKind = 'deliveries' | 'outbox' | 'meta';
const localListeners = new Set<(kind: ChangeKind) => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (ev) => {
    const kind = (ev.data as { kind?: ChangeKind } | null)?.kind;
    if (kind) localListeners.forEach((l) => l(kind));
  };
  return channel;
}

function notifyChange(kind: ChangeKind): void {
  localListeners.forEach((l) => l(kind));
  try {
    getChannel()?.postMessage({ kind });
  } catch {
    /* canal cerrado */
  }
}

/** Escucha cambios locales y de otras pestañas / del Service Worker. */
export function subscribeChanges(cb: (kind: ChangeKind) => void): () => void {
  getChannel();
  localListeners.add(cb);
  return () => localListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// synced_deliveries
// ---------------------------------------------------------------------------

export async function getAllDeliveries(): Promise<StoredDelivery[]> {
  return run([STORE_DELIVERIES], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_DELIVERIES).getAll() as IDBRequest<StoredDelivery[]>),
  );
}

/** Reemplaza el cronograma local por la copia del servidor (inserta/actualiza y elimina lo que ya no existe). */
export async function replaceDeliveries(rows: StoredDelivery[]): Promise<void> {
  await run([STORE_DELIVERIES], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_DELIVERIES);
    const keep = new Set(rows.map((r) => r.id));
    const existing = (await reqToPromise(store.getAllKeys())) as string[];
    for (const key of existing) {
      if (!keep.has(key)) store.delete(key);
    }
    for (const row of rows) store.put(row);
  });
  notifyChange('deliveries');
}

export async function putDelivery(row: StoredDelivery): Promise<void> {
  await run([STORE_DELIVERIES], 'readwrite', async (tx) => {
    tx.objectStore(STORE_DELIVERIES).put(row);
  });
  notifyChange('deliveries');
}

/** Lee, transforma y guarda una entrega en una sola transacción. `fn` devuelve null para no cambiar nada. */
export async function patchDelivery(
  id: string,
  fn: (current: StoredDelivery) => StoredDelivery | null,
): Promise<StoredDelivery | null> {
  const next = await run([STORE_DELIVERIES], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_DELIVERIES);
    const current = (await reqToPromise(store.get(id))) as StoredDelivery | undefined;
    if (!current) return null;
    const updated = fn(current);
    if (updated) store.put(updated);
    return updated;
  });
  if (next) notifyChange('deliveries');
  return next;
}

// ---------------------------------------------------------------------------
// sync_outbox_queue
// ---------------------------------------------------------------------------

export async function listOutbox(): Promise<OutboxItem[]> {
  // getAll sobre la clave primaria `seq` devuelve el orden FIFO.
  return run([STORE_OUTBOX], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_OUTBOX).getAll() as IDBRequest<OutboxItem[]>),
  );
}

export async function countOutbox(): Promise<number> {
  return run([STORE_OUTBOX], 'readonly', (tx) => reqToPromise(tx.objectStore(STORE_OUTBOX).count()));
}

export function newOperationId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'op-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
}

const estaEnVuelo = (it: OutboxItem) =>
  typeof it.in_flight_since_ms === 'number' && Date.now() - it.in_flight_since_ms < IN_FLIGHT_STALE_MS;

export interface EnqueueResult {
  item: OutboxItem;
  /** true si se fusionó con una operación pendiente del mismo delivery_id (compactación). */
  merged: boolean;
}

/**
 * Encola una acción del chofer. COMPACTACIÓN: si el mismo `delivery_id` ya tiene una operación pendiente que
 * NO está en vuelo, se fusiona en ella (los campos nuevos pisan a los viejos y se conserva su lugar en la cola).
 */
export async function enqueueOperation(input: {
  delivery_id: string;
  payload: OutboxPayload;
  created_at_iso: string;
}): Promise<EnqueueResult> {
  const result = await run([STORE_OUTBOX], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_OUTBOX);
    const mismas = (await reqToPromise(
      store.index('by_delivery').getAll(IDBKeyRange.only(input.delivery_id)),
    )) as OutboxItem[];
    const objetivo = [...mismas].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).reverse().find((it) => !estaEnVuelo(it));
    // Solo se puede fusionar si es la ÚLTIMA operación de esa entrega (no saltarse una operación en vuelo posterior).
    const ultima = [...mismas].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).pop();
    if (objetivo && ultima && objetivo.operation_id === ultima.operation_id) {
      const fusionada: OutboxItem = {
        ...objetivo,
        payload: { ...objetivo.payload, ...input.payload },
        created_at_iso: input.created_at_iso,
        next_attempt_at: 0,
        last_error: null,
      };
      store.put(fusionada);
      return { item: fusionada, merged: true } satisfies EnqueueResult;
    }
    const nueva: OutboxItem = {
      operation_id: newOperationId(),
      delivery_id: input.delivery_id,
      payload: { ...input.payload },
      created_at_iso: input.created_at_iso,
      retry_count: 0,
      last_error: null,
      last_attempt_iso: null,
      next_attempt_at: 0,
      in_flight_since_ms: null,
    };
    const key = await reqToPromise(store.add(nueva));
    return { item: { ...nueva, seq: Number(key) }, merged: false } satisfies EnqueueResult;
  });
  notifyChange('outbox');
  return result;
}

/** Toma la operación para enviarla. Devuelve null si cambió (se fusionó) o si otro enviador la tiene. */
export async function claimOperation(operationId: string, expectedCreatedAtIso: string): Promise<OutboxItem | null> {
  return run([STORE_OUTBOX], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_OUTBOX);
    const it = (await reqToPromise(store.index('by_operation_id').get(operationId))) as OutboxItem | undefined;
    if (!it) return null;
    if (it.created_at_iso !== expectedCreatedAtIso) return null;
    if (estaEnVuelo(it)) return null;
    const claimed: OutboxItem = { ...it, in_flight_since_ms: Date.now(), last_attempt_iso: new Date().toISOString() };
    store.put(claimed);
    return claimed;
  });
}

/** Devuelve la operación a la cola tras un fallo: suma un intento y programa el siguiente. */
export async function releaseOperation(
  operationId: string,
  patch: { last_error: string | null; next_attempt_at: number; bumpRetry: boolean },
): Promise<void> {
  await run([STORE_OUTBOX], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_OUTBOX);
    const it = (await reqToPromise(store.index('by_operation_id').get(operationId))) as OutboxItem | undefined;
    if (!it) return;
    store.put({
      ...it,
      in_flight_since_ms: null,
      retry_count: it.retry_count + (patch.bumpRetry ? 1 : 0),
      last_error: patch.last_error,
      next_attempt_at: patch.next_attempt_at,
    } satisfies OutboxItem);
  });
  notifyChange('outbox');
}

/**
 * Confirmación del servidor: SOLO ahora se elimina la operación de la cola, y en la misma transacción se marca
 * la entrega como sincronizada (si ya no le quedan operaciones pendientes).
 */
export async function ackOperation(operationId: string, deliveryId: string): Promise<void> {
  await run([STORE_OUTBOX, STORE_DELIVERIES], 'readwrite', async (tx) => {
    const outbox = tx.objectStore(STORE_OUTBOX);
    const it = (await reqToPromise(outbox.index('by_operation_id').get(operationId))) as OutboxItem | undefined;
    if (it?.seq !== undefined) outbox.delete(it.seq);
    const quedan = await reqToPromise(outbox.index('by_delivery').count(IDBKeyRange.only(deliveryId)));
    const deliveries = tx.objectStore(STORE_DELIVERIES);
    const d = (await reqToPromise(deliveries.get(deliveryId))) as StoredDelivery | undefined;
    if (d) {
      deliveries.put({
        ...d,
        _sync: {
          ...d._sync,
          pendiente: quedan > 0,
          sincronizada_at_iso: quedan > 0 ? d._sync.sincronizada_at_iso : new Date().toISOString(),
        },
      } satisfies StoredDelivery);
    }
  });
  notifyChange('outbox');
  notifyChange('deliveries');
}

/** Descarta una operación que ya no tiene sentido (la entrega no existe en el servidor). */
export async function dropOperation(operationId: string, deliveryId: string): Promise<void> {
  await run([STORE_OUTBOX, STORE_DELIVERIES], 'readwrite', async (tx) => {
    const outbox = tx.objectStore(STORE_OUTBOX);
    const it = (await reqToPromise(outbox.index('by_operation_id').get(operationId))) as OutboxItem | undefined;
    if (it?.seq !== undefined) outbox.delete(it.seq);
    const quedan = await reqToPromise(outbox.index('by_delivery').count(IDBKeyRange.only(deliveryId)));
    const deliveries = tx.objectStore(STORE_DELIVERIES);
    const d = (await reqToPromise(deliveries.get(deliveryId))) as StoredDelivery | undefined;
    if (d) deliveries.put({ ...d, _sync: { ...d._sync, pendiente: quedan > 0 } } satisfies StoredDelivery);
  });
  notifyChange('outbox');
  notifyChange('deliveries');
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await run([STORE_META], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_META).get(key) as IDBRequest<{ key: string; value: T } | undefined>),
  );
  return row?.value;
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  await run([STORE_META], 'readwrite', async (tx) => {
    tx.objectStore(STORE_META).put({ key, value });
  });
  notifyChange('meta');
}

/** Purga atómicamente todas las tablas locales de IndexedDB al expirar, revocarse o cerrarse una jornada. */
export async function purgeAllOfflineData(): Promise<void> {
  await run([STORE_DELIVERIES, STORE_OUTBOX, STORE_META], 'readwrite', async (tx) => {
    tx.objectStore(STORE_DELIVERIES).clear();
    tx.objectStore(STORE_OUTBOX).clear();
    tx.objectStore(STORE_META).clear();
  });
  notifyChange('deliveries');
  notifyChange('outbox');
  notifyChange('meta');
}
