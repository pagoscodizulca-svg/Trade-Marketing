import type { EntregaVista } from '../types';
import type { SyncState } from './entregasRepository';

const FECHA_IGUAL = (a: Date | null, b: Date | null) => a?.getTime() === b?.getTime();

/**
 * Almacén reactivo en memoria (datos + estado de sincronización) compatible con useSyncExternalStore.
 * La persistencia local vive en IndexedDB (src/lib/offlineDb.ts); este almacén solo refleja su contenido.
 */
export function createSyncStore(initial: SyncState) {
  let entregas: EntregaVista[] = [];
  let state: SyncState = initial;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const iguales = (a: SyncState, b: SyncState) =>
    a.status === b.status &&
    a.errorMessage === b.errorMessage &&
    a.realtime === b.realtime &&
    a.pendingCount === b.pendingCount &&
    a.flushing === b.flushing &&
    a.offline === b.offline &&
    a.aviso === b.aviso &&
    FECHA_IGUAL(a.lastSyncAt, b.lastSyncAt);

  return {
    getEntregas: () => entregas,
    getState: () => state,
    setEntregas(next: EntregaVista[]) {
      entregas = next;
      emit();
    },
    /** Cambia el estado solo si algo difiere (mantiene la referencia estable). */
    setState(patch: Partial<SyncState>) {
      const next = { ...state, ...patch };
      if (iguales(next, state)) return;
      state = next;
      emit();
    },
    /** Aplica datos y estado en una sola notificación. */
    commit(nextEntregas: EntregaVista[], patch: Partial<SyncState>) {
      entregas = nextEntregas;
      state = { ...state, ...patch };
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
