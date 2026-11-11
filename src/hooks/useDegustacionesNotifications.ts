import { useCallback, useEffect, useRef, useState } from 'react';
import { DegustacionNotificationItem, DegustacionToastAlert } from '../types';
import { getSupabaseRealtimeClient } from '../services/supabaseClient';
import {
  DEGUSTACION_SURVEY_LOCAL_EVENT,
  fetchUnreadDegustacionNotifications,
  markAllSupabaseDegustacionesAsRead,
  markSupabaseDegustacionAsRead,
  normalizeCanonicalDegustacionId,
  parseDegustacionNotificationRow,
  RawSupabaseSurvey,
} from '../services/supabaseModule1';

export interface UseDegustacionesNotificationsOptions {
  onRealtimeChange?: () => void;
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

const FOCUS_RESYNC_THROTTLE_MS = 2500;

export function useDegustacionesNotifications(
  options?: UseDegustacionesNotificationsOptions
): UseDegustacionesNotificationsResult {
  const onRealtimeChangeRef = useRef(options?.onRealtimeChange);
  onRealtimeChangeRef.current = options?.onRealtimeChange;

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
  const lastFocusSyncAtRef = useRef<number>(0);
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unreadItemsRef = useRef<DegustacionNotificationItem[]>([]);
  unreadItemsRef.current = unreadItems;

  const triggerArrivalPulse = useCallback(() => {
    setHasRecentArrivalPulse(true);
    if (pulseTimeoutRef.current) {
      clearTimeout(pulseTimeoutRef.current);
    }
    pulseTimeoutRef.current = setTimeout(() => {
      setHasRecentArrivalPulse(false);
    }, 6500);
  }, []);

  const dismissToast = useCallback((toastId: string) => {
    setActiveToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }, []);

  const enqueueToastForItem = useCallback((item: DegustacionNotificationItem) => {
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
    setTimeout(() => {
      setActiveToasts((prev) => prev.filter((t) => t.toastId !== toastId));
    }, 7500);
  }, []);

  // Procesa un evento INSERT (Realtime WebSocket, reconciliación Render o puente local) garantizando deduplicación estricta (+1 exacto)
  const handleIncomingInsertRow = useCallback(
    (rawRow: Partial<RawSupabaseSurvey> | null | undefined, shouldNotifyToast: boolean) => {
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
      if (!rawRow || !rawRow.id) return;
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

  // Carga inicial exacta y re-sincronización automática al recuperar foco de ventana o reconectar red
  const syncUnreadFromDatabase = useCallback(
    async (isBackgroundDelta = false) => {
      lastFocusSyncAtRef.current = Date.now();
      if (!isBackgroundDelta) {
        setIsLoadingNotifications(true);
      }
      try {
        const freshUnread = await fetchUnreadDegustacionNotifications();
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
      } catch {
        setSyncError('Error de conexión con el servidor');
      } finally {
        if (!isBackgroundDelta) {
          setIsLoadingNotifications(false);
        }
      }
    },
    [enqueueToastForItem, triggerArrivalPulse]
  );

  // Suscripción Realtime (INSERT, UPDATE, DELETE) + re-sincronización al recuperar foco/red
  useEffect(() => {
    void syncUnreadFromDatabase(false);

    const supabase = getSupabaseRealtimeClient();
    // Sin credenciales no hay canal en tiempo real (el error de configuración lo reporta la sincronización inicial).
    if (!supabase) return;
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
          if (deletedId) {
            setUnreadItems((prev) => prev.filter((item) => item.id !== deletedId));
          }
        }
      )
      .subscribe((status) => {
        setIsRealtimeConnected(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED' && hasCompletedInitialLoadRef.current) {
          void syncUnreadFromDatabase(true);
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

    const triggerThrottledResync = (forceImmediate = false) => {
      const now = Date.now();
      if (!forceImmediate && now - lastFocusSyncAtRef.current < FOCUS_RESYNC_THROTTLE_MS) {
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return;
      }
      void syncUnreadFromDatabase(true);
    };

    // Re-sincronización exacta al recuperar conexión de red (`online`), foco de ventana (`focus`) o pestaña (`visibilitychange`)
    const handleOnline = () => {
      triggerThrottledResync(true);
    };

    const handleWindowFocus = () => {
      triggerThrottledResync(false);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerThrottledResync(false);
      }
    };

    window.addEventListener(DEGUSTACION_SURVEY_LOCAL_EVENT, handleLocalBridge);
    window.addEventListener('online', handleOnline);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Respaldo de reconciliación ligera cada 15s por si ocurren microcortes WebSocket o antes de correr ALTER PUBLICATION
    const safetyInterval = setInterval(() => {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        void syncUnreadFromDatabase(true);
      }
    }, 15000);

    return () => {
      window.removeEventListener(DEGUSTACION_SURVEY_LOCAL_EVENT, handleLocalBridge);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(safetyInterval);
      if (pulseTimeoutRef.current) {
        clearTimeout(pulseTimeoutRef.current);
      }
      void supabase.removeChannel(channel);
    };
  }, [handleIncomingInsertRow, handleIncomingUpdateRow, syncUnreadFromDatabase]);

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
      prev.filter((t) => t.surveyId !== surveyId && (!canonicalDegKey || t.degustacionId !== canonicalDegKey))
    );

    try {
      await markSupabaseDegustacionAsRead(surveyId, targetItem?.rawComments);
    } catch {
      if (targetItem) {
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
      await syncUnreadFromDatabase(true);
    }
  }, [syncUnreadFromDatabase]);

  const reloadNotifications = useCallback(async () => {
    await syncUnreadFromDatabase(false);
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
