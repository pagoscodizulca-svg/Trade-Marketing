import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Store } from '../types';
import type {
  MasterCatalogEntity,
  MasterDataErrorCode,
  OpcionesSincronizacionMaestra,
} from '../services/masterDataSyncService';
import {
  classifyMasterDataError,
  invalidarCacheMaestros,
  loadMasterCatalogs,
  logStructuredMasterDataError,
  mapearClienteMaestroAStore,
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

export type MasterDataEntityErrors = Partial<Record<MasterCatalogEntity, string>>;
export type MasterDataEntityErrorCodes = Partial<Record<MasterCatalogEntity, MasterDataErrorCode>>;

export interface UseMasterDataResult {
  vendedores: Vendedor[];
  clientes: ClienteConVendedor[];
  cadenas: CadenaComercial[];
  zonas: ZonaComercial[];
  stores: Store[];
  cargando: boolean;
  sincronizando: boolean;
  error: string | null;
  errorCode: MasterDataErrorCode | null;
  entityErrors: MasterDataEntityErrors;
  entityErrorCodes: MasterDataEntityErrorCodes;
  ultimaActualizacionIso: string | null;
  refrescar: () => Promise<{ ok: boolean; error: string | null }>;
  refreshMasterCatalogs: () => Promise<{ ok: boolean; error: string | null }>;
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
  const [errorCode, setErrorCode] = useState<MasterDataErrorCode | null>(null);
  const [entityErrors, setEntityErrors] = useState<MasterDataEntityErrors>({});
  const [entityErrorCodes, setEntityErrorCodes] = useState<MasterDataEntityErrorCodes>({});
  const [ultimaActualizacionIso, setUltimaActualizacionIso] = useState<string | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef<number>(0);

  const claveFiltrosClientes = JSON.stringify(filtrosClientes ?? {});
  const claveFiltrosVendedores = JSON.stringify(filtrosVendedores ?? {});

  const ejecutarCarga = useCallback(
    async (forzarRefresco = false): Promise<{ ok: boolean; error: string | null }> => {
      if (deshabilitado) {
        return { ok: true, error: null };
      }

      if (!isMasterDataSupabaseConfigured) {
        const envMsg = 'Configuración de conexión a Supabase incompleta en este entorno.';
        const envErrors: MasterDataEntityErrors = {
          ...(cargarVendedores ? { vendedores: envMsg } : {}),
          ...(cargarClientes ? { clientes: envMsg } : {}),
          ...(cargarCadenas ? { cadenas: envMsg } : {}),
          ...(cargarZonas ? { zonas: envMsg } : {}),
        };
        const envCodes: MasterDataEntityErrorCodes = {
          ...(cargarVendedores ? { vendedores: 'ENV_MISSING' } : {}),
          ...(cargarClientes ? { clientes: 'ENV_MISSING' } : {}),
          ...(cargarCadenas ? { cadenas: 'ENV_MISSING' } : {}),
          ...(cargarZonas ? { zonas: 'ENV_MISSING' } : {}),
        };
        setErrorCode('ENV_MISSING');
        setEntityErrors(envErrors);
        setEntityErrorCodes(envCodes);
        setError(envMsg);
        logStructuredMasterDataError({
          categoryCode: 'ENV_MISSING',
          technicalCode: 'ENV_MISSING',
          status: null,
          entity: 'maestros',
          table: null,
          safeMessage: envMsg,
          technicalMessage:
            'Faltan VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_ANON_KEY en el build.',
          hint: 'Configura las variables públicas en Render y ejecuta Clear build cache & deploy.',
        });
        return { ok: false, error: envMsg };
      }

      const seq = ++requestSeqRef.current;
      setCargando(true);
      setError(null);
      setErrorCode(null);
      setEntityErrors({});
      setEntityErrorCodes({});
      try {
        const result = await loadMasterCatalogs({
          filtrosVendedores,
          filtrosClientes,
          cargarVendedores,
          cargarClientes,
          cargarCadenas,
          cargarZonas,
          forzarRefresco,
        });

        // Descartar respuestas obsoletas si el usuario cambió de región mientras la petición volaba
        if (seq !== requestSeqRef.current) {
          return { ok: true, error: null };
        }

        if (cargarVendedores && !result.errors.vendedores) {
          setVendedores(result.vendedores);
        }
        if (cargarClientes && !result.errors.clientes) {
          setClientes(result.clientes);
        }
        if (cargarCadenas && !result.errors.cadenas) {
          setCadenas(result.cadenas);
        }
        if (cargarZonas && !result.errors.zonas) {
          setZonas(result.zonas);
        }

        if (!result.ok && result.summaryError) {
          setEntityErrors(result.errors);
          setEntityErrorCodes(result.errorCodes);
          setErrorCode(result.primaryErrorCode);
          setError(result.summaryError);
          console.error('[useMasterData] Diagnóstico de carga parcial/fallida:', {
            primaryErrorCode: result.primaryErrorCode,
            entityErrorCodes: result.errorCodes,
            entityErrors: result.errors,
          });
          return { ok: false, error: result.summaryError };
        }

        setUltimaActualizacionIso(new Date().toISOString());
        return { ok: true, error: null };
      } catch (err) {
        const info = classifyMasterDataError(err, { entity: 'maestros' });
        logStructuredMasterDataError(info);
        setErrorCode(info.categoryCode);
        setError(info.safeMessage);
        return { ok: false, error: info.safeMessage };
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
      setErrorCode(null);
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
        const info = classifyMasterDataError(err, { entity: 'maestros' });
        setErrorCode(info.categoryCode);
        setError(info.safeMessage);
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
    errorCode,
    entityErrors,
    entityErrorCodes,
    ultimaActualizacionIso,
    refrescar,
    refreshMasterCatalogs: refrescar,
    sincronizarArchivo,
  };
}
