import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CreateSolicitudContraloriaInput,
  SolicitudProductoContraloria,
} from '../types';
import { getSupabaseRealtimeClient } from '../services/supabaseClient';
import {
  computeNextSolicitudCorrelativeCode,
  createSolicitudContraloriaInSupabase,
  fetchSolicitudesContraloriaFromSupabase,
  parseDedicatedSolicitudRow,
  parseSurveyEnvelopeSolicitudRow,
  resolveSolicitudContraloriaInSupabase,
  SOLICITUD_CONTRALORIA_BROADCAST_CHANNEL,
  SOLICITUD_CONTRALORIA_LOCAL_EVENT,
  SOLICITUD_SURVEY_TYPE,
} from '../services/solicitudesContraloriaService';

export interface UseSolicitudesContraloriaOptions {
  onSolicitudCreated?: (solicitud: SolicitudProductoContraloria) => void;
  onSolicitudResolved?: (solicitud: SolicitudProductoContraloria) => void;
}

export interface UseSolicitudesContraloriaResult {
  solicitudes: SolicitudProductoContraloria[];
  pendingSolicitudes: SolicitudProductoContraloria[];
  pendingCount: number;
  nextCorrelativeCode: string;
  isLoading: boolean;
  isRealtimeConnected: boolean;
  error: string | null;
  refreshSolicitudes: () => Promise<void>;
  submitSolicitud: (
    input: CreateSolicitudContraloriaInput
  ) => Promise<{ success: boolean; solicitud?: SolicitudProductoContraloria; error?: string }>;
  approveSolicitud: (
    solicitudId: string,
    notaContraloria?: string,
    auditorName?: string
  ) => Promise<{ success: boolean; solicitud?: SolicitudProductoContraloria; error?: string }>;
  rejectSolicitud: (
    solicitudId: string,
    notaContraloria?: string,
    auditorName?: string
  ) => Promise<{ success: boolean; solicitud?: SolicitudProductoContraloria; error?: string }>;
}

export function useSolicitudesContraloria(
  options?: UseSolicitudesContraloriaOptions
): UseSolicitudesContraloriaResult {
  const [solicitudes, setSolicitudes] = useState<SolicitudProductoContraloria[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const onCreatedRef = useRef(options?.onSolicitudCreated);
  const onResolvedRef = useRef(options?.onSolicitudResolved);
  onCreatedRef.current = options?.onSolicitudCreated;
  onResolvedRef.current = options?.onSolicitudResolved;

  const upsertSolicitudInState = useCallback((incoming: SolicitudProductoContraloria) => {
    setSolicitudes((prev) => {
      const idx = prev.findIndex((item) => item.id === incoming.id);
      let next: SolicitudProductoContraloria[];
      if (idx === -1) {
        next = [incoming, ...prev];
      } else {
        next = prev.map((item) => (item.id === incoming.id ? incoming : item));
      }
      next.sort((a, b) => {
        const tsB = new Date(b.createdAt).getTime() || 0;
        const tsA = new Date(a.createdAt).getTime() || 0;
        return tsB - tsA;
      });
      return next;
    });
  }, []);

  const refreshSolicitudes = useCallback(async () => {
    try {
      setError(null);
      const remote = await fetchSolicitudesContraloriaFromSupabase();
      setSolicitudes(remote);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Error sincronizando solicitudes de Contraloría.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSolicitudes();
  }, [refreshSolicitudes]);

  // Escucha en tiempo real: Supabase WebSocket (surveys + solicitudes_contraloria), CustomEvent y BroadcastChannel
  useEffect(() => {
    const client = getSupabaseRealtimeClient();
    // Sin credenciales no hay canal en tiempo real; el error se reporta en la carga inicial.
    if (!client) return;

    const channel = client
      .channel('codizulca-solicitudes-contraloria-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'surveys',
          filter: `type=eq.${SOLICITUD_SURVEY_TYPE}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldId = (payload.old as { id?: string } | null)?.id;
            if (oldId) {
              setSolicitudes((prev) => {
                const next = prev.filter((s) => s.id !== oldId);
                return next;
              });
            }
            return;
          }
          const parsed = parseSurveyEnvelopeSolicitudRow(
            payload.new as Record<string, unknown>
          );
          if (parsed) {
            upsertSolicitudInState(parsed);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'solicitudes_contraloria',
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldId = (payload.old as { id?: string } | null)?.id;
            if (oldId) {
              setSolicitudes((prev) => {
                const next = prev.filter((s) => s.id !== oldId);
                return next;
              });
            }
            return;
          }
          const parsed = parseDedicatedSolicitudRow(
            payload.new as Record<string, unknown>
          );
          if (parsed) {
            upsertSolicitudInState(parsed);
          }
        }
      )
      .subscribe((status) => {
        setIsRealtimeConnected(status === 'SUBSCRIBED');
      });

    const handleLocalEvent = (evt: Event) => {
      const custom = evt as CustomEvent<{
        eventType: 'INSERT' | 'UPDATE';
        solicitud: SolicitudProductoContraloria;
      }>;
      if (custom.detail?.solicitud) {
        upsertSolicitudInState(custom.detail.solicitud);
      }
    };

    window.addEventListener(SOLICITUD_CONTRALORIA_LOCAL_EVENT, handleLocalEvent);

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel(SOLICITUD_CONTRALORIA_BROADCAST_CHANNEL);
        bc.onmessage = (msg) => {
          if (msg.data?.solicitud) {
            upsertSolicitudInState(msg.data.solicitud as SolicitudProductoContraloria);
          }
        };
      }
    } catch {
      bc = null;
    }

    const handleReconnectOrFocus = () => {
      void refreshSolicitudes();
    };
    window.addEventListener('online', handleReconnectOrFocus);
    window.addEventListener('focus', handleReconnectOrFocus);

    return () => {
      window.removeEventListener(SOLICITUD_CONTRALORIA_LOCAL_EVENT, handleLocalEvent);
      window.removeEventListener('online', handleReconnectOrFocus);
      window.removeEventListener('focus', handleReconnectOrFocus);
      if (bc) {
        try {
          bc.close();
        } catch {
          // ignore
        }
      }
      void client.removeChannel(channel);
    };
  }, [refreshSolicitudes, upsertSolicitudInState]);

  const submitSolicitud = useCallback(
    async (
      input: CreateSolicitudContraloriaInput
    ): Promise<{ success: boolean; solicitud?: SolicitudProductoContraloria; error?: string }> => {
      try {
        setError(null);
        const created = await createSolicitudContraloriaInSupabase(input);
        upsertSolicitudInState(created);
        onCreatedRef.current?.(created);
        return { success: true, solicitud: created };
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : 'No se pudo enviar la solicitud a Contraloría.';
        setError(msg);
        return { success: false, error: msg };
      }
    },
    [upsertSolicitudInState]
  );

  const resolveByDecision = useCallback(
    async (
      solicitudId: string,
      decision: 'APROBADA' | 'RECHAZADA',
      notaContraloria?: string,
      auditorName?: string
    ): Promise<{ success: boolean; solicitud?: SolicitudProductoContraloria; error?: string }> => {
      const target = solicitudes.find((s) => s.id === solicitudId);
      if (!target) {
        return { success: false, error: 'Solicitud no encontrada en la Bandeja de Entrada.' };
      }
      try {
        setError(null);
        const updated = await resolveSolicitudContraloriaInSupabase({
          solicitud: target,
          decision,
          notaContraloria,
          auditorName,
        });
        upsertSolicitudInState(updated);
        onResolvedRef.current?.(updated);
        return { success: true, solicitud: updated };
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : 'No se pudo procesar la decisión en Contraloría.';
        setError(msg);
        return { success: false, error: msg };
      }
    },
    [solicitudes, upsertSolicitudInState]
  );

  const approveSolicitud = useCallback(
    (solicitudId: string, notaContraloria?: string, auditorName?: string) =>
      resolveByDecision(solicitudId, 'APROBADA', notaContraloria, auditorName),
    [resolveByDecision]
  );

  const rejectSolicitud = useCallback(
    (solicitudId: string, notaContraloria?: string, auditorName?: string) =>
      resolveByDecision(solicitudId, 'RECHAZADA', notaContraloria, auditorName),
    [resolveByDecision]
  );

  const pendingSolicitudes = useMemo(
    () => solicitudes.filter((s) => s.estado === 'PENDIENTE_APROBACION'),
    [solicitudes]
  );

  const nextCorrelativeCode = useMemo(
    () => computeNextSolicitudCorrelativeCode(solicitudes),
    [solicitudes]
  );

  return {
    solicitudes,
    pendingSolicitudes,
    pendingCount: pendingSolicitudes.length,
    nextCorrelativeCode,
    isLoading,
    isRealtimeConnected,
    error,
    refreshSolicitudes,
    submitSolicitud,
    approveSolicitud,
    rejectSolicitud,
  };
}
