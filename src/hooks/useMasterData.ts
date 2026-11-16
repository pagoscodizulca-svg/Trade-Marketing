import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Store } from '../types';
import type { OpcionesSincronizacionMaestra } from '../services/masterDataSyncService';
import {
  invalidarCacheMaestros,
  mapearClienteMaestroAStore,
  obtenerClientesMaestros,
  obtenerVendedoresMaestros,
  sincronizarArchivoMaestroTrade,
  suscribirInvalidacionCacheMaestros,
} from '../services/masterDataSyncService';
import {
  getMasterDataSupabaseClient,
  isMasterDataSupabaseConfigured,
} from '../services/supabaseClient';
import type {
  ClienteConVendedor,
  FiltrosConsultaClientes,
  FiltrosConsultaVendedores,
  ResultadoSincronizacion,
  Vendedor,
} from '../types/masterData';

export interface UseMasterDataOptions {
  filtrosClientes?: FiltrosConsultaClientes;
  filtrosVendedores?: FiltrosConsultaVendedores;
  cargarVendedores?: boolean;
  cargarClientes?: boolean;
  suscribirCambiosRealtime?: boolean;
  deshabilitado?: boolean;
}

export interface UseMasterDataResult {
  vendedores: Vendedor[];
  clientes: ClienteConVendedor[];
  stores: Store[];
  cargando: boolean;
  sincronizando: boolean;
  error: string | null;
  ultimaActualizacionIso: string | null;
  refrescar: () => Promise<void>;
  sincronizarArchivo: (
    archivo: File | string | ArrayBuffer,
    opciones?: Omit<OpcionesSincronizacionMaestra, 'nombreArchivo'> & { nombreArchivo?: string }
  ) => Promise<ResultadoSincronizacion>;
}

/**
 * Hook reactivo para consultar y mantener sincronizada en toda la app Trade Marketing
 * la Fuente Única de Verdad de Vendedores y Clientes (`activo = true` por defecto).
 */
export function useMasterData(options: UseMasterDataOptions = {}): UseMasterDataResult {
  const {
    filtrosClientes,
    filtrosVendedores,
    cargarVendedores = true,
    cargarClientes = true,
    suscribirCambiosRealtime = false,
    deshabilitado = false,
  } = options;

  const [vendedores, setVendedores] = useState<Vendedor[]>([]);
  const [clientes, setClientes] = useState<ClienteConVendedor[]>([]);
  const [cargando, setCargando] = useState<boolean>(false);
  const [sincronizando, setSincronizando] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [ultimaActualizacionIso, setUltimaActualizacionIso] = useState<string | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const claveFiltrosClientes = JSON.stringify(filtrosClientes ?? {});
  const claveFiltrosVendedores = JSON.stringify(filtrosVendedores ?? {});

  const ejecutarCarga = useCallback(
    async (forzarRefresco = false) => {
      if (deshabilitado || !isMasterDataSupabaseConfigured) {
        return;
      }

      setCargando(true);
      setError(null);
      try {
        const promesas: [Promise<Vendedor[]>, Promise<ClienteConVendedor[]>] = [
          cargarVendedores
            ? obtenerVendedoresMaestros({ ...(filtrosVendedores ?? {}), forzarRefresco })
            : Promise.resolve([]),
          cargarClientes
            ? obtenerClientesMaestros({ ...(filtrosClientes ?? {}), forzarRefresco })
            : Promise.resolve([]),
        ];

        const [resVend, resCli] = await Promise.all(promesas);
        if (cargarVendedores) setVendedores(resVend);
        if (cargarClientes) setClientes(resCli);
        setUltimaActualizacionIso(new Date().toISOString());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error consultando Data Maestra.');
      } finally {
        setCargando(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      deshabilitado,
      cargarVendedores,
      cargarClientes,
      claveFiltrosClientes,
      claveFiltrosVendedores,
    ]
  );

  useEffect(() => {
    void ejecutarCarga(false);
  }, [ejecutarCarga]);

  // Refresco automático cuando otra vista de la misma sesión completa una sincronización
  useEffect(() => {
    if (deshabilitado) return;
    return suscribirInvalidacionCacheMaestros(() => {
      void ejecutarCarga(false);
    });
  }, [deshabilitado, ejecutarCarga]);

  // Suscripción opcional a cambios Realtime en PostgreSQL con debounce anti-ráfagas por lotes
  useEffect(() => {
    if (deshabilitado || !suscribirCambiosRealtime || !isMasterDataSupabaseConfigured) {
      return;
    }

    const client = getMasterDataSupabaseClient();
    const programarRefresco = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        invalidarCacheMaestros();
      }, 450);
    };

    const channel = client
      .channel('master-data-trade-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vendedores' }, programarRefresco)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' }, programarRefresco)
      .subscribe();

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      void client.removeChannel(channel);
    };
  }, [deshabilitado, suscribirCambiosRealtime]);

  const refrescar = useCallback(async () => {
    await ejecutarCarga(true);
  }, [ejecutarCarga]);

  const sincronizarArchivo = useCallback(
    async (
      archivo: File | string | ArrayBuffer,
      opciones?: Omit<OpcionesSincronizacionMaestra, 'nombreArchivo'> & { nombreArchivo?: string }
    ): Promise<ResultadoSincronizacion> => {
      setSincronizando(true);
      setError(null);
      try {
        let contenido: string | ArrayBuffer;
        let nombreArchivo = opciones?.nombreArchivo;

        if (typeof archivo === 'string' || archivo instanceof ArrayBuffer) {
          contenido = archivo;
        } else {
          nombreArchivo = nombreArchivo ?? archivo.name;
          const esCsv = archivo.name.toLowerCase().endsWith('.csv');
          contenido = esCsv ? await archivo.text() : await archivo.arrayBuffer();
        }

        const resultado = await sincronizarArchivoMaestroTrade(contenido, {
          ...opciones,
          nombreArchivo,
        });
        return resultado;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error ejecutando sincronización maestra.';
        setError(msg);
        throw err;
      } finally {
        setSincronizando(false);
      }
    },
    []
  );

  const stores = useMemo(
    () => clientes.map((cliente) => mapearClienteMaestroAStore(cliente)),
    [clientes]
  );

  return {
    vendedores,
    clientes,
    stores,
    cargando,
    sincronizando,
    error,
    ultimaActualizacionIso,
    refrescar,
    sincronizarArchivo,
  };
}
