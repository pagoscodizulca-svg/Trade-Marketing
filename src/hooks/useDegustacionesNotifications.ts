import { useCallback, useEffect, useRef, useState } from 'react';
import { DegustacionNotificationItem, DegustacionToastAlert } from '../types';
import { getSupabaseRealtimeClient } from '../services/supabaseClient';
import {
  DEGUSTACION_SURVEY_LOCAL_EVENT,
  fetchUnreadDegustacionNotifications,
  markAllSupabaseDegustacionesAsRead,
  markSupabaseDegustacionAsRead,
  matchesAssignedRegionsForExternalFdvRow,
  normalizeCanonicalDegustacionId,
  parseDegustacionNotificationRow,
  RawSupabaseSurvey,
} from '../services/supabaseModule1';

export interface UseDegustacionesNotificationsOptions {
  onRealtimeChange?: () => void;
  /** Intervalo de respaldo en ms (por defecto 15 000 ms). */
  pollIntervalMs?: number;
  /** Cooldown mínimo entre refrescos de foco/visibilidad para evitar tormentas de requests. */
  resyncCooldownMs?: number;
  /** Sucursal(es) autorizadas de la sesión activa ('CENTRO' | 'OCCIDENTE') para aislamiento estricto */
  assignedRegions?: readonly string[] | null;
}

export interface UseDegustacionesNotificationsResult {
  unreadItems: DegustacionNotificationItem[];
  unreadCount: number;
  isLoadingNotifications: boolean;
  isRealtimeConnected: boolean;
  /** Último error de sincronización con el servidor (null si la última sincronización fue correcta) */
  syncError: string | null;
  hasRecentArrivalPulse: boolean;
  activeToasts: DegustacionToastAlert[];
  dismissToast: (toastId: string) => void;
  markAsRead: (surveyId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  reloadNotifications: () => Promise<void>;
}

export const NOTIFICATIONS_POLL_INTERVAL_MS = 15_000;
export const FOCUS_RESYNC_THROTTLE_MS = 2_500;

export interface VisibilityDocumentAdapter {
  readonly visibilityState: DocumentVisibilityState | 'visible' | 'hidden';
  addEventListener: (type: 'visibilitychange', listener: () => void) => void;
  removeEventListener: (type: 'visibilitychange', listener: () => void) => void;
}

export interface VisibilityAwarePollingOptions {
  pollIntervalMs?: number;
  cooldownMs?: number;
  documentAdapter?: VisibilityDocumentAdapter | null;
  isOnline?: () => boolean;
  now?: () => number;
  onSync: (signal: AbortSignal, isBackgroundDelta: boolean) => Promise<void>;
}

export interface VisibilityAwarePollingController {
  start: (options?: { runImmediateIfVisible?: boolean }) => void;
  triggerSync: (options?: { forceImmediate?: boolean; isBackgroundDelta?: boolean }) => Promise<void>;
  stopInterval: () => void;
  abortInFlight: () => void;
  dispose: () => void;
  getState: () => {
    isIntervalActive: boolean;
    isRequestInFlight: boolean;
    isDisposed: boolean;
    lastSyncAtMs: number;
  };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

/**
 * Controlador determinista de polling gobernado por Page Visibility API + AbortController:
 * - En `'hidden'`: detiene inmediatamente el intervalo de 15 s y aborta cualquier request en vuelo.
 * - Al volver a `'visible'`: aplica cooldown anti-tormenta + guardia anti-solapamiento y reinicia
 *   un intervalo limpio de 15 s.
 * - En `dispose()`: limpia listeners, timers y aborta requests pendientes (cero memory leaks).
 */
export function createVisibilityAwarePollingController(
  options: VisibilityAwarePollingOptions
): VisibilityAwarePollingController {
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? NOTIFICATIONS_POLL_INTERVAL_MS);
  const cooldownMs = Math.max(0, options.cooldownMs ?? FOCUS_RESYNC_THROTTLE_MS);
  const getNow = options.now ?? (() => Date.now());
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const docAdapter: VisibilityDocumentAdapter | null =
    options.documentAdapter !== undefined
      ? options.documentAdapter
      : typeof document !== 'undefined'
        ? document
        : null;

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let activeController: AbortController | null = null;
  let isRequestInFlight = false;
  let isDisposed = false;
  let lastSyncAtMs = 0;
  let hasAttachedListener = false;

  const isDocumentHidden = (): boolean => {
    if (!docAdapter) return false;
    return docAdapter.visibilityState === 'hidden';
  };

  const stopInterval = () => {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  };

  const abortInFlight = () => {
    if (activeController) {
      const ctrl = activeController;
      activeController = null;
      isRequestInFlight = false;
      ctrl.abort();
    }
  };

  const triggerSync = async (syncOpts?: {
    forceImmediate?: boolean;
    isBackgroundDelta?: boolean;
  }): Promise<void> => {
    if (isDisposed) return;

    const isBackgroundDelta = syncOpts?.isBackgroundDelta ?? true;
    const forceImmediate = syncOpts?.forceImmediate ?? false;

    if (isBackgroundDelta && isDocumentHidden()) {
      return;
    }
    if (!isOnline()) {
      return;
    }

    // Guardia anti-solapamiento: los polls/resyncs de fondo no se superponen si ya hay uno activo
    if (isRequestInFlight) {
      if (isBackgroundDelta) {
        return;
      }
      // Una recarga manual explícita cancela el request previo antes de iniciar uno limpio
      abortInFlight();
    }

    const nowMs = getNow();
    if (
      isBackgroundDelta &&
      !forceImmediate &&
      lastSyncAtMs > 0 &&
      nowMs - lastSyncAtMs < cooldownMs
    ) {
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    isRequestInFlight = true;
    lastSyncAtMs = nowMs;

    try {
      await options.onSync(controller.signal, isBackgroundDelta);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        return;
      }
    } finally {
      if (activeController === controller) {
        activeController = null;
        isRequestInFlight = false;
      }
    }
  };

  const startInterval = () => {
    if (isDisposed || isDocumentHidden()) return;
    stopInterval();
    intervalHandle = setInterval(() => {
      if (isDisposed || isDocumentHidden()) {
        stopInterval();
        abortInFlight();
        return;
      }
      void triggerSync({ forceImmediate: true, isBackgroundDelta: true });
    }, pollIntervalMs);
  };

  const handleVisibilityChange = () => {
    if (isDisposed) return;
    if (isDocumentHidden()) {
      stopInterval();
      abortInFlight();
      return;
    }

    // Al volver a 'visible': refresco controlado con cooldown/anti-solapamiento + reinicio limpio de 15s
    void triggerSync({ forceImmediate: false, isBackgroundDelta: true });
    startInterval();
  };

  const start = (startOpts?: { runImmediateIfVisible?: boolean }) => {
    if (isDisposed) return;

    if (docAdapter && !hasAttachedListener) {
      docAdapter.addEventListener('visibilitychange', handleVisibilityChange);
      hasAttachedListener = true;
    }

    if (isDocumentHidden()) {
      stopInterval();
      abortInFlight();
      return;
    }

    if (startOpts?.runImmediateIfVisible !== false) {
      void triggerSync({ forceImmediate: true, isBackgroundDelta: false });
    }
    startInterval();
  };

  const dispose = () => {
    if (isDisposed) return;
    isDisposed = true;
    stopInterval();
    abortInFlight();
    if (docAdapter && hasAttachedListener) {
      docAdapter.removeEventListener('visibilitychange', handleVisibilityChange);
      hasAttachedListener = false;
    }
  };

  return {
    start,
    triggerSync,
    stopInterval,
    abortInFlight,
    dispose,
    getState: () => ({
      isIntervalActive: intervalHandle !== null,
      isRequestInFlight,
      isDisposed,
      lastSyncAtMs,
    }),
  };
}

export function useDegustacionesNotifications(
  options?: UseDegustacionesNotificationsOptions
): UseDegustacionesNotificationsResult {
  const onRealtimeChangeRef = useRef(options?.onRealtimeChange);
  onRealtimeChangeRef.current = options?.onRealtimeChange;
  const pollIntervalMs = options?.pollIntervalMs ?? NOTIFICATIONS_POLL_INTERVAL_MS;
  const resyncCooldownMs = options?.resyncCooldownMs ?? FOCUS_RESYNC_THROTTLE_MS;
  const assignedRegionsRef = useRef<readonly string[] | null>(options?.assignedRegions ?? null);
  assignedRegionsRef.current = options?.assignedRegions ?? null;
  const assignedRegionsKey = options?.assignedRegions?.join('|') ?? '__ALL__';

  const [unreadItems, setUnreadItems] = useState<DegustacionNotificationItem[]>([]);
  const [isLoadingNotifications, setIsLoadingNotifications] = useState<boolean>(true);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [hasRecentArrivalPulse, setHasRecentArrivalPulse] = useState<boolean>(false);
  const [activeToasts, setActiveToasts] = useState<DegustacionToastAlert[]>([]);

  // Conjuntos de control para deduplicación estricta por UUID + degustacionId canónico y emisión única de Toasts
  const hasCompletedInitialLoadRef = useRef<boolean>(false);
  const baselineSeenIdsRef = useRef<Set<string>>(new Set());
  const emittedToastIdsRef = useRef<Set<string>>(new Set());
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const pollingControllerRef = useRef<VisibilityAwarePollingController | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const unreadItemsRef = useRef<DegustacionNotificationItem[]>([]);
  unreadItemsRef.current = unreadItems;

  const triggerArrivalPulse = useCallback(() => {
    if (!isMountedRef.current) return;
    setHasRecentArrivalPulse(true);
    if (pulseTimeoutRef.current) {
      clearTimeout(pulseTimeoutRef.current);
    }
    pulseTimeoutRef.current = setTimeout(() => {
      pulseTimeoutRef.current = null;
      if (isMountedRef.current) {
        setHasRecentArrivalPulse(false);
      }
    }, 6500);
  }, []);

  const dismissToast = useCallback((toastId: string) => {
    setActiveToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }, []);

  const enqueueToastForItem = useCallback((item: DegustacionNotificationItem) => {
    if (!isMountedRef.current) return;
    const canonicalDegKey = normalizeCanonicalDegustacionId(item.degustacionId, item.id);
    if (
      emittedToastIdsRef.current.has(item.id) ||
      (canonicalDegKey && emittedToastIdsRef.current.has(canonicalDegKey))
    ) {
      return;
    }
    emittedToastIdsRef.current.add(item.id);
    if (canonicalDegKey) {
      emittedToastIdsRef.current.add(canonicalDegKey);
    }

    const toastId = `toast-${item.id}-${Date.now()}`;
    const newToast: DegustacionToastAlert = {
      toastId,
      degustacionId: item.degustacionId,
      surveyId: item.id,
      sellerName: item.sellerName,
      storeName: item.storeName,
      productName: item.productName,
      requestedQty: item.requestedQty,
      date: item.date,
      shift: item.shift,
      createdAt: item.createdAt,
    };

    setActiveToasts((prev) => [newToast, ...prev].slice(0, 4));
    const timer = setTimeout(() => {
      toastTimeoutsRef.current.delete(timer);
      if (isMountedRef.current) {
        setActiveToasts((prev) => prev.filter((t) => t.toastId !== toastId));
      }
    }, 7500);
    toastTimeoutsRef.current.add(timer);
  }, []);

  // Procesa un evento INSERT (Realtime WebSocket, reconciliación Render o puente local) garantizando deduplicación estricta (+1 exacto)
  const handleIncomingInsertRow = useCallback(
    (rawRow: Partial<RawSupabaseSurvey> | null | undefined, shouldNotifyToast: boolean) => {
      if (!isMountedRef.current) return;
      if (!matchesAssignedRegionsForExternalFdvRow(rawRow, assignedRegionsRef.current)) {
        return;
      }
      const parsed = parseDegustacionNotificationRow(rawRow);
      if (!parsed) return;
      if (parsed.leidoTrade) {
        const cKey = normalizeCanonicalDegustacionId(parsed.degustacionId, parsed.id);
        const alreadyKnown =
          baselineSeenIdsRef.current.has(parsed.id) ||
          (Boolean(cKey) && baselineSeenIdsRef.current.has(cKey));
        baselineSeenIdsRef.current.add(parsed.id);
        if (cKey) baselineSeenIdsRef.current.add(cKey);
        if (!alreadyKnown) {
          onRealtimeChangeRef.current?.();
        }
        return;
      }

      const canonicalDegKey = normalizeCanonicalDegustacionId(parsed.degustacionId, parsed.id);
      let wasInsertedNew = false;

      setUnreadItems((prev) => {
        const alreadyExists = prev.some(
          (existing) =>
            existing.id === parsed.id ||
            (Boolean(canonicalDegKey) &&
              normalizeCanonicalDegustacionId(existing.degustacionId, existing.id) === canonicalDegKey)
        );
        if (alreadyExists) return prev;
        wasInsertedNew = true;
        return [parsed, ...prev].sort((a, b) =>
          (b.createdAt || b.date).localeCompare(a.createdAt || a.date)
        );
      });

      const neverSeenBefore =
        !baselineSeenIdsRef.current.has(parsed.id) &&
        (!canonicalDegKey || !baselineSeenIdsRef.current.has(canonicalDegKey));

      baselineSeenIdsRef.current.add(parsed.id);
      if (canonicalDegKey) {
        baselineSeenIdsRef.current.add(canonicalDegKey);
      }

      if (wasInsertedNew || neverSeenBefore) {
        triggerArrivalPulse();
        if (shouldNotifyToast) {
          enqueueToastForItem(parsed);
        }
        onRealtimeChangeRef.current?.();
      }
    },
    [enqueueToastForItem, triggerArrivalPulse]
  );

  // Procesa un evento UPDATE (ej. marcado como leído o aprobado desde otra pestaña) descontando -1 al instante
  const handleIncomingUpdateRow = useCallback(
    (rawRow: Partial<RawSupabaseSurvey> | null | undefined) => {
      if (!isMountedRef.current || !rawRow || !rawRow.id) return;
      if (!matchesAssignedRegionsForExternalFdvRow(rawRow, assignedRegionsRef.current)) {
        return;
      }
      const parsed = parseDegustacionNotificationRow(rawRow);
      const canonicalDegKey = parsed
        ? normalizeCanonicalDegustacionId(parsed.degustacionId, parsed.id)
        : '';

      if (!parsed || parsed.leidoTrade) {
        let removed = false;
        setUnreadItems((prev) => {
          const matchesTarget = (item: DegustacionNotificationItem) =>
            item.id === rawRow.id ||
            (Boolean(canonicalDegKey) &&
              normalizeCanonicalDegustacionId(item.degustacionId, item.id) === canonicalDegKey);
          if (!prev.some(matchesTarget)) return prev;
          removed = true;
          return prev.filter((item) => !matchesTarget(item));
        });
        if (removed) {
          onRealtimeChangeRef.current?.();
        }
        return;
      }

      setUnreadItems((prev) => {
        const idx = prev.findIndex(
          (item) =>
            item.id === parsed.id ||
            (Boolean(canonicalDegKey) &&
              normalizeCanonicalDegustacionId(item.degustacionId, item.id) === canonicalDegKey)
        );
        if (idx === -1) {
          return [parsed, ...prev].sort((a, b) =>
            (b.createdAt || b.date).localeCompare(a.createdAt || a.date)
          );
        }
        const next = [...prev];
        next[idx] = parsed;
        return next;
      });
    },
    []
  );

  // Carga inicial exacta y re-sincronización cancelable con AbortSignal
  const syncUnreadFromDatabase = useCallback(
    async (isBackgroundDelta = false, signal?: AbortSignal) => {
      if (!isMountedRef.current || signal?.aborted) return;
      if (!isBackgroundDelta) {
        setIsLoadingNotifications(true);
      }
      try {
        const freshUnread = await fetchUnreadDegustacionNotifications({
          signal,
          assignedRegions: assignedRegionsRef.current,
        });
        if (!isMountedRef.current || signal?.aborted) return;
        setSyncError(null);

        if (!hasCompletedInitialLoadRef.current) {
          freshUnread.forEach((item) => {
            const cKey = normalizeCanonicalDegustacionId(item.degustacionId, item.id);
            baselineSeenIdsRef.current.add(item.id);
            emittedToastIdsRef.current.add(item.id);
            if (cKey) {
              baselineSeenIdsRef.current.add(cKey);
              emittedToastIdsRef.current.add(cKey);
            }
          });
          hasCompletedInitialLoadRef.current = true;
          setUnreadItems(freshUnread);
          return;
        }

        // Si ya cargó la base inicial, detectar llegadas nuevas para disparar Toast + pulso sin duplicar
        const newlyArrived: DegustacionNotificationItem[] = [];
        freshUnread.forEach((item) => {
          const cKey = normalizeCanonicalDegustacionId(item.degustacionId, item.id);
          const alreadySeen =
            baselineSeenIdsRef.current.has(item.id) ||
            (Boolean(cKey) && baselineSeenIdsRef.current.has(cKey));
          baselineSeenIdsRef.current.add(item.id);
          if (cKey) baselineSeenIdsRef.current.add(cKey);
          if (!alreadySeen) {
            newlyArrived.push(item);
          }
        });

        setUnreadItems(freshUnread);

        if (newlyArrived.length > 0) {
          triggerArrivalPulse();
          newlyArrived.forEach((item) => enqueueToastForItem(item));
          onRealtimeChangeRef.current?.();
        }
      } catch (err) {
        if (!isMountedRef.current || signal?.aborted || isAbortError(err)) {
          return;
        }
        setSyncError('Error de conexión con el servidor');
      } finally {
        if (!isBackgroundDelta && isMountedRef.current) {
          setIsLoadingNotifications(false);
        }
      }
    },
    [enqueueToastForItem, triggerArrivalPulse]
  );

  // Limpiar estado en memoria al cambiar de cuenta o de sucursal activa
  useEffect(() => {
    hasCompletedInitialLoadRef.current = false;
    baselineSeenIdsRef.current.clear();
    emittedToastIdsRef.current.clear();
    setUnreadItems([]);
    setActiveToasts([]);
    if (pollingControllerRef.current) {
      void pollingControllerRef.current.triggerSync({
        forceImmediate: true,
        isBackgroundDelta: false,
      });
    }
  }, [assignedRegionsKey]);

  // Suscripción Realtime (INSERT, UPDATE, DELETE) + polling inteligente con Page Visibility API + AbortController
  useEffect(() => {
    isMountedRef.current = true;

    const controller = createVisibilityAwarePollingController({
      pollIntervalMs,
      cooldownMs: resyncCooldownMs,
      onSync: (signal, isBackgroundDelta) =>
        syncUnreadFromDatabase(isBackgroundDelta, signal),
    });
    pollingControllerRef.current = controller;

    const supabase = getSupabaseRealtimeClient();
    // Sin credenciales no hay canal ni polling periódico (solo carga inicial para reportar estado)
    if (!supabase) {
      void controller.triggerSync({ forceImmediate: true, isBackgroundDelta: false });
      return () => {
        isMountedRef.current = false;
        controller.dispose();
        pollingControllerRef.current = null;
        if (pulseTimeoutRef.current) {
          clearTimeout(pulseTimeoutRef.current);
          pulseTimeoutRef.current = null;
        }
        toastTimeoutsRef.current.forEach((t) => clearTimeout(t));
        toastTimeoutsRef.current.clear();
      };
    }

    controller.start({ runImmediateIfVisible: true });

    const channel = supabase
      .channel('trade-marketing-degustaciones-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'surveys',
          filter: 'type=eq.Degustacion',
        },
        (payload) => {
          handleIncomingInsertRow(payload.new as RawSupabaseSurvey, true);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'surveys',
          filter: 'type=eq.Degustacion',
        },
        (payload) => {
          handleIncomingUpdateRow(payload.new as RawSupabaseSurvey);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'surveys',
        },
        (payload) => {
          const deletedId = (payload.old as { id?: string } | undefined)?.id;
          if (deletedId && isMountedRef.current) {
            setUnreadItems((prev) => prev.filter((item) => item.id !== deletedId));
          }
        }
      )
      .subscribe((status) => {
        if (!isMountedRef.current) return;
        setIsRealtimeConnected(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED' && hasCompletedInitialLoadRef.current) {
          void controller.triggerSync({ forceImmediate: false, isBackgroundDelta: true });
        }
      });

    // Puente instantáneo local en la misma pestaña (deduplicado por id + degustacionId)
    const handleLocalBridge = (ev: Event) => {
      const customEv = ev as CustomEvent<{
        eventType: 'INSERT' | 'UPDATE';
        row: Partial<RawSupabaseSurvey> & { id: string };
      }>;
      if (!customEv.detail?.row) return;
      if (customEv.detail.eventType === 'INSERT') {
        handleIncomingInsertRow(customEv.detail.row, true);
      } else if (customEv.detail.eventType === 'UPDATE') {
        handleIncomingUpdateRow(customEv.detail.row);
      }
    };

    const handleOnline = () => {
      void controller.triggerSync({ forceImmediate: true, isBackgroundDelta: true });
    };

    const handleWindowFocus = () => {
      void controller.triggerSync({ forceImmediate: false, isBackgroundDelta: true });
    };

    window.addEventListener(DEGUSTACION_SURVEY_LOCAL_EVENT, handleLocalBridge);
    window.addEventListener('online', handleOnline);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      isMountedRef.current = false;
      window.removeEventListener(DEGUSTACION_SURVEY_LOCAL_EVENT, handleLocalBridge);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', handleWindowFocus);
      controller.dispose();
      pollingControllerRef.current = null;
      if (pulseTimeoutRef.current) {
        clearTimeout(pulseTimeoutRef.current);
        pulseTimeoutRef.current = null;
      }
      toastTimeoutsRef.current.forEach((t) => clearTimeout(t));
      toastTimeoutsRef.current.clear();
      void supabase.removeChannel(channel);
    };
  }, [
    handleIncomingInsertRow,
    handleIncomingUpdateRow,
    pollIntervalMs,
    resyncCooldownMs,
    syncUnreadFromDatabase,
  ]);

  const markAsRead = useCallback(async (surveyId: string) => {
    if (!surveyId) return;
    const targetItem = unreadItemsRef.current.find((i) => i.id === surveyId);
    const canonicalDegKey = targetItem
      ? normalizeCanonicalDegustacionId(targetItem.degustacionId, targetItem.id)
      : '';

    // Descuento optimista inmediato (-1 en el globito)
    setUnreadItems((prev) =>
      prev.filter(
        (i) =>
          i.id !== surveyId &&
          (!canonicalDegKey ||
            normalizeCanonicalDegustacionId(i.degustacionId, i.id) !== canonicalDegKey)
      )
    );
    setActiveToasts((prev) =>
      prev.filter(
        (t) =>
          t.surveyId !== surveyId &&
          (!canonicalDegKey || t.degustacionId !== canonicalDegKey)
      )
    );

    try {
      await markSupabaseDegustacionAsRead(surveyId, targetItem?.rawComments);
    } catch {
      if (targetItem && isMountedRef.current) {
        setUnreadItems((prev) =>
          prev.some((i) => i.id === targetItem.id)
            ? prev
            : [targetItem, ...prev].sort((a, b) =>
                (b.createdAt || b.date).localeCompare(a.createdAt || a.date)
              )
        );
      }
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    const snapshot = [...unreadItemsRef.current];
    if (snapshot.length === 0) return;

    setUnreadItems([]);
    setActiveToasts([]);

    try {
      await markAllSupabaseDegustacionesAsRead(snapshot);
    } catch {
      if (pollingControllerRef.current) {
        await pollingControllerRef.current.triggerSync({
          forceImmediate: true,
          isBackgroundDelta: true,
        });
      } else {
        await syncUnreadFromDatabase(true);
      }
    }
  }, [syncUnreadFromDatabase]);

  const reloadNotifications = useCallback(async () => {
    if (pollingControllerRef.current) {
      await pollingControllerRef.current.triggerSync({
        forceImmediate: true,
        isBackgroundDelta: false,
      });
    } else {
      await syncUnreadFromDatabase(false);
    }
  }, [syncUnreadFromDatabase]);

  return {
    unreadItems,
    unreadCount: unreadItems.length,
    isLoadingNotifications,
    isRealtimeConnected,
    syncError,
    hasRecentArrivalPulse,
    activeToasts,
    dismissToast,
    markAsRead,
    markAllAsRead,
    reloadNotifications,
  };
}
