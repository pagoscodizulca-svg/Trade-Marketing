/**
 * Hook reactivo unificado de sincronización BD <-> Pantallas para las 5 entidades maestras:
 *   1. `public.regiones`
 *   2. `public.productos` (Catálogo Nacional Compartido)
 *   3. `public.supervisores`
 *   4. `public.promotoras`
 *   5. `public.clientes` (enlazado vía `invalidarCacheMaestros` + conteo de cuarentena)
 *
 * Usa suscripciones nativas de Supabase Realtime (`postgres_changes`) con debounce
 * anti-ráfagas y limpieza estricta (`removeChannel` + `clearTimeout`) en `useEffect`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClienteConVendedor,
  ProductoMaestro,
  PromotoraMaestra,
  RegionMaestra,
  SupervisorMaestro,
} from '../types/masterData';
import {
  invalidateMasterCatalogCaches,
  obtenerProductosMaestros,
  obtenerPromotorasMaestras,
  obtenerRegionesMaestras,
  obtenerSupervisoresMaestros,
  subscribeMasterCatalogInvalidation,
} from '../services/masterCatalogSyncService';
import { invalidarCacheMaestros } from '../services/masterDataSyncService';
import { getSupabaseClient, isSupabaseConfigured } from '../services/supabaseClient';

export interface QuarantinedMasterCounts {
  clientes: number;
  promotoras: number;
  supervisores: number;
  total: number;
}

export interface UseMasterEntitiesSyncOptions {
  /** Deshabilita cualquier consulta (ej. usuario sin región asignada o sesión pendiente). */
  disabled?: boolean;
  /** Activa suscripción WebSocket Supabase Realtime sobre las 5 tablas maestras. */
  enableRealtime?: boolean;
  /** Identificador de sesión/contexto para reiniciar canales y revalidar limpiamente. */
  scopeKey?: string;
  /** Clientes ya cargados por `useMasterData` para consolidar el conteo de cuarentena. */
  clientesSnapshot?: readonly ClienteConVendedor[];
}

export interface UseMasterEntitiesSyncResult {
  regiones: RegionMaestra[];
  productos: ProductoMaestro[];
  supervisores: SupervisorMaestro[];
  promotoras: PromotoraMaestra[];
  quarantinedCounts: QuarantinedMasterCounts;
  isLoading: boolean;
  isRealtimeConnected: boolean;
  error: string | null;
  lastSyncedAtIso: string | null;
  refresh: (force?: boolean) => Promise<void>;
}

const REALTIME_DEBOUNCE_MS = 350;

export function isRecordQuarantined(row: {
  region_id?: string | null;
  sucursal?: string | null;
}): boolean {
  const hasRegionId = Boolean(row.region_id && String(row.region_id).trim().length > 0);
  const hasSucursal = Boolean(row.sucursal && String(row.sucursal).trim().length > 0);
  return !hasRegionId && !hasSucursal;
}

export function useMasterEntitiesSync(
  options: UseMasterEntitiesSyncOptions = {}
): UseMasterEntitiesSyncResult {
  const {
    disabled = false,
    enableRealtime = true,
    scopeKey = 'default',
    clientesSnapshot = [],
  } = options;

  const [regiones, setRegiones] = useState<RegionMaestra[]>([]);
  const [productos, setProductos] = useState<ProductoMaestro[]>([]);
  const [supervisores, setSupervisores] = useState<SupervisorMaestro[]>([]);
  const [promotoras, setPromotoras] = useState<PromotoraMaestra[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRealtimeConnected, setIsRealtimeConnected] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAtIso, setLastSyncedAtIso] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(
    async (force = false) => {
      if (disabled || !isSupabaseConfigured) {
        if (disabled) {
          setRegiones([]);
          setProductos([]);
          setSupervisores([]);
          setPromotoras([]);
        }
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const [regRows, prodRows, supRows, promRows] = await Promise.all([
          obtenerRegionesMaestras({ forzarRefresco: force }).catch(() => []),
          obtenerProductosMaestros({ forzarRefresco: force }).catch(() => []),
          obtenerSupervisoresMaestros({ forzarRefresco: force }).catch(() => []),
          obtenerPromotorasMaestras({ forzarRefresco: force }).catch(() => []),
        ]);
        setRegiones(regRows);
        setProductos(prodRows);
        setSupervisores(supRows);
        setPromotoras(promRows);
        setLastSyncedAtIso(new Date().toISOString());
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'No se pudieron sincronizar las entidades maestras.'
        );
      } finally {
        setIsLoading(false);
      }
    },
    [disabled]
  );

  // Carga inicial y al cambiar de usuario/región (`scopeKey`)
  useEffect(() => {
    void refresh(false);
  }, [refresh, scopeKey]);

  // Revalidación inmediata ante mutaciones locales en la misma sesión
  useEffect(() => {
    if (disabled) return;
    return subscribeMasterCatalogInvalidation(() => {
      void refresh(true);
    });
  }, [disabled, refresh]);

  // Suscripción nativa Supabase Realtime con cleanup garantizado en `useEffect`
  useEffect(() => {
    if (disabled || !enableRealtime || !isSupabaseConfigured) {
      setIsRealtimeConnected(false);
      return;
    }

    const client = getSupabaseClient();
    const scheduleSync = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        invalidateMasterCatalogCaches();
        invalidarCacheMaestros();
      }, REALTIME_DEBOUNCE_MS);
    };

    const channelName = `master-entities-5-sync-${scopeKey}`;
    const channel = client
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'regiones' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'productos' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supervisores' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promotoras' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff' }, scheduleSync)
      .subscribe((status) => {
        setIsRealtimeConnected(status === 'SUBSCRIBED');
      });

    return () => {
      setIsRealtimeConnected(false);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      void client.removeChannel(channel);
    };
  }, [disabled, enableRealtime, scopeKey]);

  const quarantinedCounts = useMemo<QuarantinedMasterCounts>(() => {
    const clientes = clientesSnapshot.filter((c) => isRecordQuarantined(c)).length;
    const promCount = promotoras.filter((p) => isRecordQuarantined(p)).length;
    const supCount = supervisores.filter((s) => isRecordQuarantined(s)).length;
    return {
      clientes,
      promotoras: promCount,
      supervisores: supCount,
      total: clientes + promCount + supCount,
    };
  }, [clientesSnapshot, promotoras, supervisores]);

  return {
    regiones,
    productos,
    supervisores,
    promotoras,
    quarantinedCounts,
    isLoading,
    isRealtimeConnected,
    error,
    lastSyncedAtIso,
    refresh,
  };
}
