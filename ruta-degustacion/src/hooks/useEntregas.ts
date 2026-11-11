import { useCallback, useSyncExternalStore } from 'react';
import { entregasRepo } from '../services';

export function useEntregas() {
  const entregas = useSyncExternalStore(entregasRepo.subscribe, entregasRepo.getSnapshot);
  const sync = useSyncExternalStore(entregasRepo.subscribe, entregasRepo.getSyncState);
  const refresh = useCallback(() => entregasRepo.refresh(), []);
  const flushNow = useCallback(() => entregasRepo.flushNow(), []);
  return {
    entregas,
    repo: entregasRepo,
    sync,
    status: sync.status,
    errorMessage: sync.errorMessage,
    lastSyncAt: sync.lastSyncAt,
    pendingCount: sync.pendingCount,
    offline: sync.offline,
    refresh,
    flushNow,
  };
}
