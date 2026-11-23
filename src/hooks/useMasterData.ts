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

export type MasterDataEntityErrors = Partial<
  Record<'clientes' | 'vendedores' | 'cadenas' | 'zonas', string>
>;

export interface UseMasterDataResult {
  vendedores: Vendedor[];
  clientes: ClienteConVendedor[];
  cadenas: CadenaComercial[];
  zonas: ZonaComercial[];
  stores: Store[];
  cargando: boolean;
  sincronizando: boolean;
  error: string | null;
  entityErrors: MasterDataEntityErrors;
  ultimaActualizacionIso: string | null;
  refrescar: () => Promise<{ ok: boolean; error: string | null }>;
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
  const [entityErrors, setEntityErrors] = useState<MasterDataEntityErrors>({});
  const [ultimaActualizacionIso, setUltimaActualizacionIso] = useState<string | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef<number>(0);

  const claveFiltrosClientes = JSON.stringify(filtrosClientes ?? {});
  const claveFiltrosVendedores = JSON.stringify(filtrosVendedores ?? {});

  const ejecutarCarga = useCallback(
    async (forzarRefresco = false): Promise<{ ok: boolean; error: string | null }> => {
      if (deshabilitado || !isMasterDataSupabaseConfigured) {
        return { ok: true, error: null };
      }

      const seq = ++requestSeqRef.current;
      setCargando(true);
      setError(null);
      setEntityErrors({});
      try {
        const [vendSettled, cliSettled, cadSettled, zonSettled] = await Promise.allSettled([
          cargarVendedores
            ? obtenerVendedoresMaestros({ ...(filtrosVendedores ?? {}), forzarRefresco })
            : Promise.resolve([]),
          cargarClientes
            ? obtenerClientesMaestros({ ...(filtrosClientes ?? {}), forzarRefresco })
            : Promise.resolve([]),
          cargarCadenas
            ? obtenerCadenasComerciales({
                soloActivos: false,
                region: filtrosClientes?.region,
                forzarRefresco,
              })
            : Promise.resolve([]),
          cargarZonas
            ? obtenerZonasComerciales({
                soloActivos: false,
                region: filtrosClientes?.region,
                forzarRefresco,
              })
            : Promise.resolve([]),
        ]);

        // Descartar respuestas obsoletas si el usuario cambió de región mientras la petición volaba
        if (seq !== requestSeqRef.current) {
          return { ok: true, error: null };
        }

        const nextErrors: MasterDataEntityErrors = {};

        if (cargarVendedores) {
          if (vendSettled.status === 'fulfilled') {
            setVendedores(vendSettled.value);
          } else {
            nextErrors.vendedores =
              vendSettled.reason instanceof Error
                ? vendSettled.reason.message
                : 'Error consultando vendedores maestros.';
          }
        }
        if (cargarClientes) {
          if (cliSettled.status === 'fulfilled') {
            setClientes(cliSettled.value);
          } else {
            nextErrors.clientes =
              cliSettled.reason instanceof Error
                ? cliSettled.reason.message
                : 'Error consultando clientes maestros.';
          }
        }
        if (cargarCadenas) {
          if (cadSettled.status === 'fulfilled') {
            setCadenas(cadSettled.value);
          } else {
            nextErrors.cadenas =
              cadSettled.reason instanceof Error
                ? cadSettled.reason.message
                : 'Error consultando cadenas comerciales.';
          }
        }
        if (cargarZonas) {
          if (zonSettled.status === 'fulfilled') {
            setZonas(zonSettled.value);
          } else {
            nextErrors.zonas =
              zonSettled.reason instanceof Error
                ? zonSettled.reason.message
                : 'Error consultando zonas geográficas.';
          }
        }

        const errorList = Object.entries(nextErrors);
        if (errorList.length > 0) {
          const summary = errorList
            .map(([k, msg]) => `${k.toUpperCase()}: ${msg}`)
            .join(' · ');
          setEntityErrors(nextErrors);
          setError(summary);
          console.error('[useMasterData] Error cargando Data Maestra:', nextErrors);
          return { ok: false, error: summary };
        }

        setUltimaActualizacionIso(new Date().toISOString());
        return { ok: true, error: null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error consultando Data Maestra.';
        setError(msg);
        console.error('[useMasterData] Excepción:', msg);
        return { ok: false, error: msg };
      } finally {
        if (seq === requestSeqRef.current) {
          setCargando(false);
        }
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Vendedores' }, programarRefresco)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Clientes' }, programarRefresco)
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
    invalidarCacheMaestros();
    return ejecutarCarga(true);
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
    entityErrors,
    ultimaActualizacionIso,
    refrescar,
    sincronizarArchivo,
  };
}
