import { useCallback, useEffect, useRef, useState } from 'react';
import type { RutaPromotoraRecord } from '../types/degustacionesPipeline';
import type { VerifiedAuthProfile } from '../services/authService';
import {
  fetchPortalRutaRecords,
  sortAndDeduplicateRutas,
} from '../services/promotoraRutaPortalService';
import { getSupabaseClient, isSupabaseConfigured } from '../services/supabaseClient';
import { getCaracasTodayYmd } from '../utils/caracasWeekCycle';

export interface UsePromotoraRutaRealtimeOptions {
  profile: VerifiedAuthProfile | null;
  supervisorFilterPromotoraId?: string | null;
  onLiveBanner?: (message: string) => void;
}

export interface UsePromotoraRutaRealtimeResult {
  routes: RutaPromotoraRecord[];
  isLoading: boolean;
  isRefreshing: boolean;
  isRealtimeConnected: boolean;
  lastSyncedAt: string | null;
  error: string | null;
  refreshRoutes: () => Promise<void>;
  applyOptimisticRouteUpdate: (updated: RutaPromotoraRecord) => void;
}

/**
 * Hook reactivo para `/portal/ruta`:
 * 1. Suscripción WebSocket `postgres_changes` autenticada con JWT sobre `public.rutas_promotoras`.
 * 2. Manejo instantáneo de `INSERT` (nueva asignación), `UPDATE` y `DELETE` (reasignación a otra promotora o cancelación).
 * 3. Respaldo automático de recarga segura al reconectar el canal, recuperar internet (`online`),
 *    volver a primer plano (`visibilitychange`) y reconciliación silenciosa cada 60 s.
 */
export function usePromotoraRutaRealtime({
  profile,
  supervisorFilterPromotoraId = null,
  onLiveBanner,
}: UsePromotoraRutaRealtimeOptions): UsePromotoraRutaRealtimeResult {
  const [routes, setRoutes] = useState<RutaPromotoraRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlightFetchRef = useRef<boolean>(false);
  const hadDisconnectionRef = useRef<boolean>(false);
  const onLiveBannerRef = useRef(onLiveBanner);
  onLiveBannerRef.current = onLiveBanner;

  const canReadRoutes = Boolean(
    profile && (profile.appRole === 'promotora' || profile.isCoordinatorOrAdmin)
  );

  const refreshRoutes = useCallback(async () => {
    if (!profile || !canReadRoutes || !isSupabaseConfigured) {
      setRoutes([]);
      setIsLoading(false);
      return;
    }
    if (inFlightFetchRef.current) return;
    inFlightFetchRef.current = true;
    setIsRefreshing(true);

    try {
      const fresh = await fetchPortalRutaRecords({
        profile,
        supervisorFilterPromotoraId,
      });
      setRoutes(fresh);
      setError(null);
      setLastSyncedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error sincronizando tu ruta.');
    } finally {
      inFlightFetchRef.current = false;
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [profile, canReadRoutes, supervisorFilterPromotoraId]);

  const applyOptimisticRouteUpdate = useCallback((updated: RutaPromotoraRecord) => {
    setRoutes((prev) =>
      sortAndDeduplicateRutas(
        prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item))
      )
    );
  }, []);

  // Carga inicial verificada
  useEffect(() => {
    setIsLoading(true);
    void refreshRoutes();
  }, [refreshRoutes]);

  // Suscripción Supabase Realtime (WebSocket con JWT de sesión)
  useEffect(() => {
    if (!profile || !canReadRoutes || !isSupabaseConfigured) {
      setIsRealtimeConnected(false);
      return;
    }

    // Para perfil promotora exigimos staffId o email verificado para filtrar además de RLS en servidor
    const normalizedEmail = String(profile.email || '').trim().toLowerCase();
    if (profile.appRole === 'promotora' && !profile.staffId && !normalizedEmail) {
      setIsRealtimeConnected(false);
      return;
    }

    const client = getSupabaseClient();
    const targetFilterStaffId =
      profile.appRole === 'promotora'
        ? profile.staffId
        : supervisorFilterPromotoraId || null;

    const ownsPromotoraRow = (row: Partial<RutaPromotoraRecord>): boolean => {
      if (profile.isCoordinatorOrAdmin) {
        return targetFilterStaffId ? row.promotora_id === targetFilterStaffId : true;
      }
      const rowEmail = String(row.promotora_email || '').trim().toLowerCase();
      const matchesStaff = Boolean(targetFilterStaffId && row.promotora_id === targetFilterStaffId);
      const matchesEmail = Boolean(normalizedEmail && rowEmail && rowEmail === normalizedEmail);
      return matchesStaff || matchesEmail;
    };

    const channelTopic = `portal-ruta:${profile.userId}:${targetFilterStaffId || normalizedEmail || 'all'}`;
    const pgFilterConfig: {
      event: '*';
      schema: 'public';
      table: 'rutas_promotoras';
      filter?: string;
    } = {
      event: '*',
      schema: 'public',
      table: 'rutas_promotoras',
      ...(targetFilterStaffId ? { filter: `promotora_id=eq.${targetFilterStaffId}` } : {}),
    };

    const channel = client
      .channel(channelTopic)
      .on('postgres_changes', pgFilterConfig, (payload) => {
        const todayYmd = getCaracasTodayYmd();

        if (payload.eventType === 'INSERT') {
          const incoming = payload.new as RutaPromotoraRecord;
          if (!ownsPromotoraRow(incoming)) {
            return;
          }
          if (incoming.estado_ruta === 'CANCELADA') return;
          if (profile.appRole === 'promotora' && incoming.fecha < todayYmd) return;

          setRoutes((prev) => sortAndDeduplicateRutas([...prev, incoming]));
          setLastSyncedAt(new Date().toISOString());
          onLiveBannerRef.current?.(
            `Nueva degustación autorizada: ${incoming.cliente_nombre} (${incoming.fecha} · ${incoming.turno})`
          );
          return;
        }

        if (payload.eventType === 'UPDATE') {
          const updated = payload.new as RutaPromotoraRecord;
          const noLongerMine = !ownsPromotoraRow(updated);
          const expiredForPromotora =
            profile.appRole === 'promotora' && Boolean(updated.fecha) && updated.fecha < todayYmd;

          if (updated.estado_ruta === 'CANCELADA' || noLongerMine || expiredForPromotora) {
            setRoutes((prev) =>
              prev.filter(
                (r) => r.id !== updated.id && r.cronograma_id !== updated.cronograma_id
              )
            );
            setLastSyncedAt(new Date().toISOString());
            onLiveBannerRef.current?.('Una degustación de la ruta fue actualizada por Coordinación.');
            return;
          }

          setRoutes((prev) => {
            const exists = prev.some((r) => r.id === updated.id);
            const next = exists
              ? prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r))
              : [...prev, updated];
            return sortAndDeduplicateRutas(next);
          });
          setLastSyncedAt(new Date().toISOString());
          return;
        }

        if (payload.eventType === 'DELETE') {
          const oldRow = (payload.old ?? {}) as Partial<RutaPromotoraRecord>;
          setRoutes((prev) =>
            prev.filter(
              (r) =>
                (oldRow.id ? r.id !== oldRow.id : true) &&
                (oldRow.cronograma_id ? r.cronograma_id !== oldRow.cronograma_id : true)
            )
          );
          setLastSyncedAt(new Date().toISOString());
          onLiveBannerRef.current?.(
            oldRow.cliente_nombre
              ? `Ruta actualizada: se retiró ${oldRow.cliente_nombre} de tu programación.`
              : 'Tu hoja de ruta fue actualizada por Coordinación.'
          );
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setIsRealtimeConnected(true);
          if (hadDisconnectionRef.current) {
            hadDisconnectionRef.current = false;
            void refreshRoutes();
          }
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          setIsRealtimeConnected(false);
          hadDisconnectionRef.current = true;
        }
      });

    return () => {
      void client.removeChannel(channel);
    };
  }, [profile, canReadRoutes, supervisorFilterPromotoraId, refreshRoutes]);

  // Respaldo seguro para red móvil / supermercados: online, foco de pestaña y reconciliación cada 60s
  useEffect(() => {
    if (!profile || !canReadRoutes) return;

    const handleOnline = () => {
      void refreshRoutes();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshRoutes();
      }
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshRoutes();
      }
    }, 60_000);

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, [profile, canReadRoutes, refreshRoutes]);

  return {
    routes,
    isLoading,
    isRefreshing,
    isRealtimeConnected,
    lastSyncedAt,
    error,
    refreshRoutes,
    applyOptimisticRouteUpdate,
  };
}
