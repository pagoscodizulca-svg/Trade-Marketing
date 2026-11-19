import type { Entrega, EntregaVista } from '../types';

/** Estado de la conexión/sincronización con Supabase. `offline` = sin red, mostrando la copia guardada en el teléfono. */
export type SyncStatus = 'sincronizando' | 'sincronizado' | 'offline' | 'error';

/** Estado de sincronización. Cada objeto es inmutable: solo cambia de referencia cuando cambia algo. */
export interface SyncState {
  status: SyncStatus;
  /** Detalle del error cuando status === 'error' (o motivo de la falta de red cuando es 'offline'). */
  errorMessage: string | null;
  /** Última carga correcta desde Supabase (persiste entre sesiones en el teléfono). */
  lastSyncAt: Date | null;
  /** true cuando el canal Realtime está SUBSCRIBED. */
  realtime: boolean;
  /** Acciones del chofer guardadas en el teléfono y aún sin confirmar por el servidor. */
  pendingCount: number;
  /** Hay un vaciado de la cola en curso. */
  flushing: boolean;
  /** Sin conexión (navigator.onLine === false o última petición fallida por red). */
  offline: boolean;
  /** Mensaje informativo para el chofer (p. ej. operaciones descartadas). */
  aviso: string | null;
}

/** Contrato de acceso a datos. Supabase es la fuente de verdad; IndexedDB solo guarda su última copia real. */
export interface EntregasRepository {
  readonly kind: 'supabase' | 'no-configurado';
  /** Arranca la carga inicial, el motor de sincronización y el canal en tiempo real (idempotente). */
  start(): void;
  /** Detiene suscripciones activas, motor offline y limpia el snapshot en memoria al cerrar sesión. */
  stop(): void;
  /** Snapshot actual (referencia estable mientras no haya cambios). */
  getSnapshot(): EntregaVista[];
  /** Notifica ante cualquier cambio de datos (carga, realtime, cola) o de estado de sincronización. */
  subscribe(listener: () => void): () => void;
  /** Estado de sincronización (referencia estable mientras no cambie). */
  getSyncState(): SyncState;
  readonly status: SyncStatus;
  readonly errorMessage: string | null;
  readonly lastSyncAt: Date | null;
  /** Vacía la cola y vuelve a consultar Supabase. Nunca lanza: los fallos quedan en el estado. */
  refresh(): Promise<void>;
  /** Reintenta ahora el envío de lo pendiente (ignora el backoff). */
  flushNow(): Promise<void>;
  /** Alterna «Stand + Producto Entregado»; funciona sin conexión y registra la hora exacta del toque. */
  toggleEntrega(id: string): Promise<void>;
  /** Guarda la nota/incidencia; funciona sin conexión. */
  setNota(id: string, nota: string): Promise<void>;
  /** Requieren conexión. */
  add(entrega: Omit<Entrega, 'id'>): Promise<void>;
  importMany(entregas: Omit<Entrega, 'id'>[], modo: 'reemplazar' | 'agregar'): Promise<void>;
}

export const MENSAJE_REQUIERE_CONEXION = 'Esta acción requiere conexión a internet.';

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
