import { useEffect, useRef, useState } from 'react';
import { getSupabaseClient, isSupabaseConfigured } from '../services/supabaseClient';

export interface UseCronogramaRealtimeSyncOptions {
  onRealtimeChange: () => void;
  debounceMs?: number;
}

export interface UseCronogramaRealtimeSyncResult {
  isRealtimeConnected: boolean;
  lastRealtimeEventAt: string | null;
}

/**
 * Suscripción Supabase Realtime (`postgres_changes`) sobre `public.cronograma_degustaciones`
 * y `public.rutas_promotoras` para actualizar instantáneamente el Módulo 2 (`Cronograma de productos`)
 * y la vista administrativa ante cualquier autorización, reasignación, avance o baja,
 * con limpieza estricta (`removeChannel`) al desmontar para evitar fugas de memoria.
 */
export function useCronogramaRealtimeSync({
  onRealtimeChange,
  debounceMs = 200,
}: UseCronogramaRealtimeSyncOptions): UseCronogramaRealtimeSyncResult {
  const [isRealtimeConnected, setIsRealtimeConnected] = useState<boolean>(false);
  const [lastRealtimeEventAt, setLastRealtimeEventAt] = useState<string | null>(null);

  const callbackRef = useRef(onRealtimeChange);
  callbackRef.current = onRealtimeChange;

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsRealtimeConnected(false);
      return;
    }

    const client = getSupabaseClient();
    let debounceTimer: number | undefined;
    let hadDisconnect = false;

    const scheduleSync = () => {
      setLastRealtimeEventAt(new Date().toISOString());
      if (debounceTimer !== undefined) {
        window.clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(() => {
        callbackRef.current();
      }, debounceMs);
    };

    const channel = client
      .channel('trade-cronograma-productos-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'cronograma_degustaciones',
        },
        () => {
          scheduleSync();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rutas_promotoras',
        },
        () => {
          scheduleSync();
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setIsRealtimeConnected(true);
          if (hadDisconnect) {
            hadDisconnect = false;
            scheduleSync();
          }
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          setIsRealtimeConnected(false);
          hadDisconnect = true;
        }
      });

    return () => {
      if (debounceTimer !== undefined) {
        window.clearTimeout(debounceTimer);
      }
      void client.removeChannel(channel);
    };
  }, [debounceMs]);

  return {
    isRealtimeConnected,
    lastRealtimeEventAt,
  };
}
