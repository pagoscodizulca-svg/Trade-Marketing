/**
 * Hook reactivo unificado de sincronización BD <-> Pantallas para las 5 entidades maestras:
 *   1. `public."Regiones"` (`OCCIDENTE`, `CENTRO`, `ANDES`)
 *   2. `public."Productos"` / `vw_productos_detalle` (Catálogo Nacional Compartido)
 *   3. `public."Supervisores"`
 *   4. `public.promotoras` (`Fijas` / `Eventuales` / `Merchandising`)
 *   5. `public."Clientes"` (enlazado vía `invalidarCacheMaestros` + conteo de cuarentena)
 *
 * REGLA CERO ERRORES SILENCIADOS:
 *  - Prohibido tragar fallos HTTP/RLS/esquema devolviendo `[]` en silencio.
 *  - Cada entidad reporta su propio error en `entityErrors` y se consolida en `error`.
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
  clearMasterCatalogCaches,
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

export type MasterEntityErrorMap = Partial<
  Record<'regiones' | 'productos' | 'supervisores' | 'promotoras', string>
>;

export interface MasterEntitiesRefreshResult {
  ok: boolean;
  error: string | null;
  entityErrors: MasterEntityErrorMap;
}

export interface UseMasterEntitiesSyncOptions {
  /** Deshabilita cualquier consulta (ej. usuario sin región asignada o sesión pendiente). */
  disabled?: boolean;
  /** Activa suscripción WebSocket Supabase Realtime sobre las tablas maestras. */
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
  entityErrors: MasterEntityErrorMap;
  lastSyncedAtIso: string | null;
  refresh: (force?: boolean) => Promise<MasterEntitiesRefreshResult>;
}

const REALTIME_DEBOUNCE_MS = 350;

export function isRecordQuarantined(row: {
  region_id?: string | null;
  sucursal?: string | null;
  metadata?: Record<string, unknown>;
}): boolean {
  const hasRegionId = Boolean(row.region_id && String(row.region_id).trim().length > 0);
  const hasSucursal = Boolean(row.sucursal && String(row.sucursal).trim().length > 0);
  const hasMetaRegion = Boolean(
    row.metadata?.region_codigo && String(row.metadata.region_codigo).trim().length > 0
  );
  return !hasRegionId && !hasSucursal && !hasMetaRegion;
}

function sanitizeSyncErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '').trim();
  const clean = raw
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[TOKEN_REDACTADO]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/gi, '[SECRETO_REDACTADO]')
    .trim();
  return clean || fallback;
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
  const [entityErrors, setEntityErrors] = useState<MasterEntityErrorMap>({});
  const [lastSyncedAtIso, setLastSyncedAtIso] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(
    async (force = false): Promise<MasterEntitiesRefreshResult> => {
      if (disabled || !isSupabaseConfigured) {
        if (disabled) {
          setRegiones([]);
          setProductos([]);
          setSupervisores([]);
          setPromotoras([]);
        }
        return { ok: true, error: null, entityErrors: {} };
      }

      if (force) {
        clearMasterCatalogCaches();
      }

      setIsLoading(true);
      setError(null);
      setEntityErrors({});

      try {
        const [regSettled, prodSettled, supSettled, promSettled] = await Promise.allSettled([
          obtenerRegionesMaestras({ forzarRefresco: force }),
          obtenerProductosMaestros({ forzarRefresco: force }),
          obtenerSupervisoresMaestros({ forzarRefresco: force }),
          obtenerPromotorasMaestras({ forzarRefresco: force }),
        ]);

        const nextErrors: MasterEntityErrorMap = {};

        if (regSettled.status === 'fulfilled') {
          setRegiones(regSettled.value);
        } else {
          nextErrors.regiones = sanitizeSyncErrorMessage(
            regSettled.reason,
            'No se pudo cargar el catálogo de Regiones.'
          );
        }

        if (prodSettled.status === 'fulfilled') {
          setProductos(prodSettled.value);
        } else {
          nextErrors.productos = sanitizeSyncErrorMessage(
            prodSettled.reason,
            'No se pudo cargar el catálogo de Productos.'
          );
        }

        if (supSettled.status === 'fulfilled') {
          setSupervisores(supSettled.value);
        } else {
          nextErrors.supervisores = sanitizeSyncErrorMessage(
            supSettled.reason,
            'No se pudo cargar el catálogo de Supervisores.'
          );
        }

        if (promSettled.status === 'fulfilled') {
          setPromotoras(promSettled.value);
        } else {
          nextErrors.promotoras = sanitizeSyncErrorMessage(
            promSettled.reason,
            'No se pudo cargar el catálogo de Promotoras.'
          );
        }

        const errorEntries = Object.entries(nextErrors);
        if (errorEntries.length > 0) {
          const summary = errorEntries
            .map(([entity, msg]) => `${entity.toUpperCase()}: ${msg}`)
            .join(' · ');
          setEntityErrors(nextErrors);
          setError(summary);
          console.error('[useMasterEntitiesSync] Fallo de sincronización:', nextErrors);
          return { ok: false, error: summary, entityErrors: nextErrors };
        }

        setLastSyncedAtIso(new Date().toISOString());
        return { ok: true, error: null, entityErrors: {} };
      } catch (err) {
        const msg = sanitizeSyncErrorMessage(
          err,
          'No se pudieron sincronizar las entidades maestras.'
        );
        setError(msg);
        console.error('[useMasterEntitiesSync] Excepción al sincronizar:', msg);
        return { ok: false, error: msg, entityErrors: {} };
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

  // Suscripción nativa Supabase Realtime sobre las tablas reales ERP y Trade Marketing
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Regiones' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Productos' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Supervisores' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Clientes' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promotoras' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'regiones' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'productos' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supervisores' }, scheduleSync)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' }, scheduleSync)
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
    isRealtimeConnected: isRealtimeConnected && !error,
    error,
    entityErrors,
    lastSyncedAtIso,
    refresh,
  };
}
