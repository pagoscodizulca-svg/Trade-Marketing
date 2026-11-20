import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Store } from '../types';
import type { OpcionesSincronizacionMaestra } from '../services/masterDataSyncService';
import {
  invalidarCacheMaestros,
  mapearClienteMaestroAStore,
  obtenerCadenasComerciales,
  obtenerClientesMaestros,
  obtenerVendedoresMaestros,
  obtenerZonasComerciales,
  sincronizarArchivoMaestroTrade,
  suscribirInvalidacionCacheMaestros,
} from '../services/masterDataSyncService';
import {
  getMasterDataSupabaseClient,
  isMasterDataSupabaseConfigured,
} from '../services/supabaseClient';
import type {
  CadenaComercial,
  ClienteConVendedor,
  FiltrosConsultaClientes,
  FiltrosConsultaVendedores,
  ResultadoSincronizacion,
  Vendedor,
  ZonaComercial,
} from '../types/masterData';

export interface UseMasterDataOptions {
  filtrosClientes?: FiltrosConsultaClientes;
  filtrosVendedores?: FiltrosConsultaVendedores;
  cargarVendedores?: boolean;
  cargarClientes?: boolean;
  cargarCadenas?: boolean;
  cargarZonas?: boolean;
  suscribirCambiosRealtime?: boolean;
  deshabilitado?: boolean;
}

export interface UseMasterDataResult {
  vendedores: Vendedor[];
  clientes: ClienteConVendedor[];
  cadenas: CadenaComercial[];
  zonas: ZonaComercial[];
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
 * la Fuente Única de Verdad de Vendedores, Clientes, Cadenas Comerciales y Zonas (`activo = true` por defecto).
 */
export function useMasterData(options: UseMasterDataOptions = {}): UseMasterDataResult {
  const {
    filtrosClientes,
    filtrosVendedores,
    cargarVendedores = true,
    cargarClientes = true,
    cargarCadenas = true,
    cargarZonas = true,
    suscribirCambiosRealtime = false,
    deshabilitado = false,
  } = options;

  const [vendedores, setVendedores] = useState<Vendedor[]>([]);
  const [clientes, setClientes] = useState<ClienteConVendedor[]>([]);
  const [cadenas, setCadenas] = useState<CadenaComercial[]>([]);
  const [zonas, setZonas] = useState<ZonaComercial[]>([]);
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
        const [resVend, resCli, resCad, resZon] = await Promise.all([
          cargarVendedores
            ? obtenerVendedoresMaestros({ ...(filtrosVendedores ?? {}), forzarRefresco })
            : Promise.resolve([]),
          cargarClientes
            ? obtenerClientesMaestros({ ...(filtrosClientes ?? {}), forzarRefresco })
            : Promise.resolve([]),
          cargarCadenas
            ? obtenerCadenasComerciales({ soloActivos: false, forzarRefresco }).catch(() => [])
            : Promise.resolve([]),
          cargarZonas
            ? obtenerZonasComerciales({ soloActivos: false, forzarRefresco }).catch(() => [])
            : Promise.resolve([]),
        ]);
        if (cargarVendedores) setVendedores(resVend);
        if (cargarClientes) setClientes(resCli);
        if (cargarCadenas) setCadenas(resCad);
        if (cargarZonas) setZonas(resZon);
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
      cargarCadenas,
      cargarZonas,
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cadenas_comerciales' }, programarRefresco)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'zonas' }, programarRefresco)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'regiones' }, programarRefresco)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'productos' }, programarRefresco)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supervisores' }, programarRefresco)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promotoras' }, programarRefresco)
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

  const stores = useMemo(() => {
    const cadenasById = new Map(cadenas.map((c) => [c.id, c]));
    const zonasById = new Map(zonas.map((z) => [z.id, z]));
    return clientes.map((cliente) =>
      mapearClienteMaestroAStore(cliente, {
        cadenaNombre: cliente.cadena_id ? cadenasById.get(cliente.cadena_id)?.nombre : undefined,
        zonaNombre: cliente.zona_id ? zonasById.get(cliente.zona_id)?.nombre : undefined,
      })
    );
  }, [clientes, cadenas, zonas]);

  return {
    vendedores,
    clientes,
    cadenas,
    zonas,
    stores,
    cargando,
    sincronizando,
    error,
    ultimaActualizacionIso,
    refrescar,
    sincronizarArchivo,
  };
}
