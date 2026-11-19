import { useCallback, useEffect, useRef, useState } from 'react';
import {
  flushPortalOfflineQueue,
  listPendingPortalActions,
  purgePortalOfflineSensitiveData,
  type QueuedPortalAction,
} from '../services/portalOfflineQueueService';

export type OfflineSyncVisualState =
  | 'online_synced'
  | 'offline'
  | 'syncing'
  | 'pending_retry'
  | 'expired_purged';

export interface UseOfflineSyncOptions {
  enabled: boolean;
  /** Fecha ISO UTC de expiración cuando se opera bajo un Enlace Dinámico Firmado (`?t=...`) */
  shiftExpiresAtIso?: string | null;
  /** Ejecutor de una mutación individual (con `client_mutation_id === action.id`) */
  executeAction: (action: QueuedPortalAction) => Promise<void>;
  /** Callback opcional cuando la cola drena >= 1 acción exitosamente */
  onSynced?: (syncedCount: number) => void;
  /** Callback cuando la sesión temporal expira o es revocada (`401/403`) tras purgar IndexedDB */
  onShiftInvalidated?: (reason: string) => void;
}

export interface UseOfflineSyncResult {
  isOnline: boolean;
  isSyncing: boolean;
  pendingActions: QueuedPortalAction[];
  pendingCount: number;
  lastSyncedAtIso: string | null;
  lastError: string | null;
  visualState: OfflineSyncVisualState;
  refreshPending: () => Promise<void>;
  syncNow: (force?: boolean) => Promise<void>;
  purgeAndCloseShift: (reason?: string) => Promise<void>;
}

function isShiftAuthInvalidError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const code = String((err as { code?: string })?.code ?? '').toUpperCase();
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  return (
    status === 401 ||
    status === 403 ||
    code === 'SESSION_REVOKED' ||
    code === 'SESSION_EXPIRED' ||
    code === 'TOKEN_EXPIRED' ||
    code === 'INVALID_SIGNATURE' ||
    /SESSION_REVOKED|SESSION_EXPIRED|TOKEN_EXPIRED|revocado|expir[oó]/i.test(msg)
  );
}

/**
 * Hook reactivo Offline-First para el Portal de Campo (`/portal`):
 *  - Detecta cambios de conectividad (`online` / `offline`) y regreso a primer plano.
 *  - Drena la cola `IndexedDB` (`outbox_mutations`) en lote con exponential backoff + `client_mutation_id`.
 *  - Vigila expiración UTC y revocación de enlaces dinámicos, purgando automáticamente IndexedDB y cachés privadas.
 */
export function useOfflineSync({
  enabled,
  shiftExpiresAtIso = null,
  executeAction,
  onSynced,
  onShiftInvalidated,
}: UseOfflineSyncOptions): UseOfflineSyncResult {
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [pendingActions, setPendingActions] = useState<QueuedPortalAction[]>([]);
  const [lastSyncedAtIso, setLastSyncedAtIso] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [wasExpiredPurged, setWasExpiredPurged] = useState<boolean>(false);

  const flushingRef = useRef<boolean>(false);
  const executeActionRef = useRef(executeAction);
  executeActionRef.current = executeAction;
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const onShiftInvalidatedRef = useRef(onShiftInvalidated);
  onShiftInvalidatedRef.current = onShiftInvalidated;

  const refreshPending = useCallback(async () => {
    try {
      const items = await listPendingPortalActions();
      setPendingActions(items);
    } catch {
      setPendingActions([]);
    }
  }, []);

  const purgeAndCloseShift = useCallback(async (reason?: string) => {
    await purgePortalOfflineSensitiveData();
    setPendingActions([]);
    setLastError(reason ?? null);
    setWasExpiredPurged(true);
    onShiftInvalidatedRef.current?.(
      reason ?? 'Jornada finalizada. Los datos locales se purgaron por seguridad.'
    );
  }, []);

  const syncNow = useCallback(
    async (force = false) => {
      if (!enabled || flushingRef.current) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setIsOnline(false);
        await refreshPending();
        return;
      }

      flushingRef.current = true;
      setIsSyncing(true);
      let shiftInvalidatedMsg: string | null = null;

      try {
        const result = await flushPortalOfflineQueue(
          async (action) => {
            try {
              await executeActionRef.current(action);
            } catch (err) {
              if (isShiftAuthInvalidError(err)) {
                shiftInvalidatedMsg =
                  err instanceof Error
                    ? err.message
                    : 'El enlace de jornada expiró o fue revocado.';
                throw err;
              }
              throw err;
            }
          },
          { forceIgnoreSchedule: force }
        );

        if (shiftInvalidatedMsg) {
          await purgeAndCloseShift(shiftInvalidatedMsg);
          return;
        }

        if (result.succeeded > 0) {
          setLastSyncedAtIso(new Date().toISOString());
          setLastError(null);
          onSyncedRef.current?.(result.succeeded);
        } else if (result.failed > 0) {
          const remaining = await listPendingPortalActions();
          const firstErr = remaining.find((i) => i.lastError)?.lastError ?? null;
          setLastError(firstErr);
        }
        await refreshPending();
      } finally {
        flushingRef.current = false;
        setIsSyncing(false);
      }
    },
    [enabled, purgeAndCloseShift, refreshPending]
  );

  // Carga inicial de cola pendiente
  useEffect(() => {
    if (!enabled) return;
    setWasExpiredPurged(false);
    void refreshPending();
  }, [enabled, refreshPending]);

  // Listeners reactivos de red y visibilidad + reconciliación periódica cada 25s
  useEffect(() => {
    if (!enabled) return;

    const handleOnline = () => {
      setIsOnline(true);
      setLastError(null);
      void syncNow(true);
    };
    const handleOffline = () => {
      setIsOnline(false);
    };
    const handleVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void syncNow(false);
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisible);
    const interval = window.setInterval(() => {
      if (navigator.onLine) void syncNow(false);
    }, 25_000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisible);
      window.clearInterval(interval);
    };
  }, [enabled, syncNow]);

  // Vigilante automático de expiración UTC del enlace de jornada -> purga inmediata de IndexedDB
  useEffect(() => {
    if (!enabled || !shiftExpiresAtIso) return;
    const expMs = new Date(shiftExpiresAtIso).getTime();
    if (!Number.isFinite(expMs)) return;

    const checkExpiry = () => {
      if (Date.now() >= expMs) {
        void purgeAndCloseShift(
          'Tu enlace dinámico de jornada expiró. Se purgaron los datos sensibles del dispositivo.'
        );
      }
    };

    checkExpiry();
    const timer = window.setInterval(checkExpiry, 15_000);
    return () => window.clearInterval(timer);
  }, [enabled, shiftExpiresAtIso, purgeAndCloseShift]);

  const visualState: OfflineSyncVisualState = wasExpiredPurged
    ? 'expired_purged'
    : !isOnline
      ? 'offline'
      : isSyncing
        ? 'syncing'
        : pendingActions.length > 0
          ? 'pending_retry'
          : 'online_synced';

  return {
    isOnline,
    isSyncing,
    pendingActions,
    pendingCount: pendingActions.length,
    lastSyncedAtIso,
    lastError,
    visualState,
    refreshPending,
    syncNow,
    purgeAndCloseShift,
  };
}
