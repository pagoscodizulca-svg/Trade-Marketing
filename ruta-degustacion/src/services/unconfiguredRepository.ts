import type { EntregaVista } from '../types';
import type { EntregasRepository, SyncState } from './entregasRepository';

export const MENSAJE_SIN_CONFIGURAR =
  'Sin conexión configurada: defina VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY';

/**
 * Repositorio "no configurado": no hay credenciales de Supabase, por lo que no se inventa
 * ni se guarda nada. Estado `error`, lista vacía y operaciones que lanzan un error claro.
 */
export function createUnconfiguredRepository(): EntregasRepository {
  const vacio: EntregaVista[] = [];
  const estado: SyncState = {
    status: 'error',
    errorMessage: MENSAJE_SIN_CONFIGURAR,
    lastSyncAt: null,
    realtime: false,
    pendingCount: 0,
    flushing: false,
    offline: false,
    aviso: null,
  };
  const falla = (): Promise<never> => Promise.reject(new Error(MENSAJE_SIN_CONFIGURAR));

  return {
    kind: 'no-configurado',
    start: () => {},
    getSnapshot: () => vacio,
    subscribe: () => () => {},
    getSyncState: () => estado,
    status: estado.status,
    errorMessage: estado.errorMessage,
    lastSyncAt: null,
    refresh: () => Promise.resolve(),
    flushNow: () => Promise.resolve(),
    toggleEntrega: falla,
    setNota: falla,
    add: falla,
    importMany: falla,
  };
}
