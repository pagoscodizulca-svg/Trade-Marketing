import { countOutbox, subscribeChanges } from '../lib/offlineDb';
import { flushOutbox, type FlushOptions, type FlushResult } from '../lib/syncCore';

/** Etiqueta del evento `sync` del Service Worker (Background Sync API). */
export const BACKGROUND_SYNC_TAG = 'sync-deliveries-outbox';
export const PERIODIC_CHECK_MS = 30_000;
/** Tiempo máximo del intento inmediato tras el toque del chofer. */
export const IMMEDIATE_TIMEOUT_MS = 4_000;

export interface EngineState {
  /** Operaciones del chofer guardadas en el teléfono y aún sin confirmar. */
  pendingCount: number;
  /** Hay un vaciado de la cola en curso. */
  flushing: boolean;
  /** Sin conexión: `navigator.onLine === false` o la última petición falló por red. */
  offline: boolean;
  lastError: string | null;
  /** Mensaje informativo (p. ej. operaciones descartadas porque la entrega ya no existe). */
  aviso: string | null;
}

export interface SyncEngineHandlers {
  /** La cola quedó vacía: hay que refrescar el estado sincronizado desde el servidor. */
  onDrained: () => Promise<void>;
  /** Resultado de conectividad observado en una petición real. */
  onNetworkResult?: (ok: boolean) => void;
}

/** Pide al Service Worker (si el navegador lo soporta) que vacíe la cola aunque la página se cierre. */
export async function registerBackgroundSync(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };
    await reg.sync?.register(BACKGROUND_SYNC_TAG);
  } catch {
    /* Background Sync no soportado: quedan los otros 3 disparadores */
  }
}

/**
 * Motor de sincronización en segundo plano. Se dispara con:
 *  (a) `online`, (c) volver a la app (`visibilitychange`/`focus`), (d) verificador cada 30 s con pendientes;
 *  y (b) el Service Worker con Background Sync (ver src/sw.ts), que comparte `flushOutbox`.
 */
export function createSyncEngine(handlers: SyncEngineHandlers) {
  let networkOk: boolean | null = null;
  let state: EngineState = {
    pendingCount: 0,
    flushing: false,
    offline: typeof navigator !== 'undefined' ? navigator.onLine === false : false,
    lastError: null,
    aviso: null,
  };
  const listeners = new Set<() => void>();
  let started = false;
  let enCurso: Promise<FlushResult> | null = null;
  let intervalo: ReturnType<typeof setInterval> | null = null;
  let stopChanges: (() => void) | null = null;
  const limpiar: Array<() => void> = [];

  const emit = () => listeners.forEach((l) => l());
  const offlineAhora = () => (typeof navigator !== 'undefined' && navigator.onLine === false) || networkOk === false;

  const set = (patch: Partial<EngineState>) => {
    const next = { ...state, ...patch, offline: offlineAhora() };
    const igual =
      next.pendingCount === state.pendingCount &&
      next.flushing === state.flushing &&
      next.offline === state.offline &&
      next.lastError === state.lastError &&
      next.aviso === state.aviso;
    if (igual) return;
    state = next;
    emit();
  };

  const reportNetwork = (ok: boolean) => {
    networkOk = ok;
    handlers.onNetworkResult?.(ok);
    set({});
  };

  async function refreshPending(): Promise<number> {
    try {
      const n = await countOutbox();
      set({ pendingCount: n });
      return n;
    } catch {
      return state.pendingCount;
    }
  }

  /** Vacía la cola ahora (una sola ejecución a la vez; las demás esperan a la actual). */
  function flushNow(opts: FlushOptions = {}): Promise<FlushResult> {
    if (enCurso) return enCurso;
    set({ flushing: true });
    enCurso = (async () => {
      let res: FlushResult;
      try {
        res = await flushOutbox(opts);
      } catch (err) {
        res = {
          status: 'error',
          sent: 0,
          dropped: 0,
          remaining: state.pendingCount,
          lastError: err instanceof Error ? err.message : 'Error desconocido',
          droppedMessages: [],
        };
      }
      if (res.status === 'ok') networkOk = true;
      else if (res.status === 'offline') networkOk = false;
      const aviso = res.droppedMessages.length > 0 ? res.droppedMessages.join(' ') : state.aviso;
      set({ pendingCount: res.remaining, lastError: res.lastError, aviso });
      if (res.status === 'ok' || res.status === 'offline') handlers.onNetworkResult?.(res.status === 'ok');
      if (res.remaining === 0 && (res.sent > 0 || res.dropped > 0)) {
        try {
          await handlers.onDrained();
        } catch {
          /* el estado de red se actualiza dentro de onDrained */
        }
      }
      return res;
    })().finally(() => {
      enCurso = null;
      set({ flushing: false });
    });
    return enCurso;
  }

  const disparar = (force: boolean) => {
    void flushNow({ force, timeoutMs: 15_000 });
  };

  function start(): void {
    if (started || typeof window === 'undefined') return;
    started = true;
    void refreshPending().then((n) => {
      if (n > 0 && navigator.onLine) disparar(true);
    });

    // (a) Conexión recuperada
    const onOnline = () => {
      networkOk = null;
      set({});
      disparar(true);
    };
    const onOffline = () => set({});
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    limpiar.push(() => window.removeEventListener('online', onOnline), () => window.removeEventListener('offline', onOffline));

    // (c) La app vuelve a estar visible / recupera el foco
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) disparar(true);
    };
    const onFocus = () => {
      if (navigator.onLine) disparar(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    limpiar.push(() => document.removeEventListener('visibilitychange', onVisible), () => window.removeEventListener('focus', onFocus));

    // (d) Verificador silencioso cada 30 s mientras haya pendientes
    intervalo = setInterval(() => {
      if (navigator.onLine && state.pendingCount > 0) disparar(false);
    }, PERIODIC_CHECK_MS);

    // Cambios de la cola hechos por otra pestaña o por el Service Worker
    stopChanges = subscribeChanges((kind) => {
      if (kind === 'outbox') void refreshPending();
    });
  }

  function stop(): void {
    limpiar.splice(0).forEach((fn) => fn());
    if (intervalo) clearInterval(intervalo);
    stopChanges?.();
    intervalo = null;
    stopChanges = null;
    started = false;
  }

  return {
    start,
    stop,
    flushNow,
    refreshPending,
    reportNetwork,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearAviso: () => set({ aviso: null }),
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
