/**
 * Capa de servicio modular, tipada y segura para lectura de Catálogos Maestros
 * (`vendedores`, `clientes`, `cadenas`, `zonas`) desde Supabase / Backend BFF.
 *
 * GARANTÍAS DE SEGURIDAD Y RESILIENCIA:
 *  1. Cero secretos en frontend: opera únicamente con el cliente público + JWT `authenticated`.
 *  2. Anti-`anon`: exige sesión resuelta (`session?.access_token`) antes de disparar consultas
 *     en runtime real, y reintenta exactamente 1 vez tras `refreshSession()` ante `401` / `JWT expired`.
 *  3. Diagnóstico seguro: la UI recibe únicamente un código de categoría corto
 *     (`ENV_MISSING`, `AUTH_REQUIRED`, `RLS_42501`, `SCHEMA_PGRST`, `UPSTREAM_503`, `NETWORK_ERR`),
 *     enviando el detalle técnico completo (redactado de tokens/llaves) a `console.error`.
 *  4. Paginación determinística en bloques de 1,000 filas (`.order(pk, { ascending: true }).range(...)`).
 *  5. Deduplicación de peticiones en vuelo + caché de sesión con TTL de 5 min + purga automática en `SIGNED_OUT`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MasterDataDatabase } from '../types/masterData';
import type {
  ErpCanalComercializacionRow,
  ErpClienteRow,
  ErpEstadoRow,
  ErpForecastExcludedVendedoresRow,
  ErpMunicipioRow,
  ErpRegionRow,
  ErpSucursalRow,
  ErpSupervisorRow,
  ErpTipificacionRow,
  ErpVendedorRow,
} from '../utils/erpMasterAdapter';
import {
  ErrorConfiguracionIncompleta,
  ErrorSeguridadCredenciales,
  SUPABASE_MASTER_PROJECT_URL,
  getActiveClientSucursalHeader,
  getAuthenticatedSessionToken,
  isMasterDataSupabaseConfigured,
  registerSupabaseSessionResetCallback,
} from './supabaseClient';
import { registerMemoryCachePurgeCallback } from './sessionCacheHygiene';

export type MasterCatalogEntity = 'vendedores' | 'clientes' | 'cadenas' | 'zonas';

export type MasterDataErrorCode =
  | 'ENV_MISSING'
  | 'AUTH_REQUIRED'
  | 'RLS_42501'
  | 'SCHEMA_PGRST'
  | 'UPSTREAM_503'
  | 'NETWORK_ERR'
  | 'UNKNOWN_ERR';

export interface MasterDataDiagnosticInfo {
  categoryCode: MasterDataErrorCode;
  technicalCode: string | null;
  status: number | null;
  entity: MasterCatalogEntity | 'maestros';
  table: string | null;
  safeMessage: string;
  technicalMessage: string;
  hint: string | null;
}

export const MASTER_PAGINATION_BLOCK_SIZE = 1000;
export const DEFAULT_SHARED_ERP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Proyecciones explícitas de columnas usadas por la UI y normalizadores (cero `select('*')`).
 */
export const MASTER_SELECT_COLUMNS = {
  vendedores:
    'id,codigo_vendedor,nombre_completo,documento_identidad,telefono,email,zona,supervisor,sucursal,region_id,activo,metadata,ultima_sincronizacion,created_at,updated_at',
  vendedoresMinimal:
    'id,codigo_vendedor,nombre_completo,telefono,email,zona,supervisor,activo,created_at,updated_at',
  clientes:
    'id,codigo_cliente,rif,razon_social,nombre_comercial,canal,segmento,zona,ruta,direccion,ciudad,estado,telefono,latitud,longitud,cadena_id,zona_id,supervisor_id,region_id,radio_geocerca_m,sucursal,vendedor_id,codigo_vendedor,activo,metadata,ultima_sincronizacion,created_at,updated_at',
  clientesWithVendedor:
    'id,codigo_cliente,rif,razon_social,nombre_comercial,canal,segmento,zona,ruta,direccion,ciudad,estado,telefono,latitud,longitud,cadena_id,zona_id,supervisor_id,region_id,radio_geocerca_m,sucursal,vendedor_id,codigo_vendedor,activo,metadata,ultima_sincronizacion,created_at,updated_at,vendedor:vendedores(id,codigo_vendedor,nombre_completo,zona,supervisor,activo)',
  clientesMinimal:
    'id,codigo_cliente,rif,razon_social,nombre_comercial,canal,zona,ruta,direccion,ciudad,estado,latitud,longitud,vendedor_id,codigo_vendedor,activo,created_at,updated_at',
  cadenas:
    'id,codigo,nombre,tipo_canal,sucursal,region_id,activo,logo_storage_path,logo_mime_type,logo_updated_at,logo_updated_by,metadata,created_at,updated_at',
  cadenasMinimal: 'id,codigo,nombre,tipo_canal,sucursal,activo,created_at,updated_at',
  zonas: 'id,codigo,nombre,ciudad,estado,sucursal,region_id,activo,metadata,created_at,updated_at',
  zonasMinimal: 'id,codigo,nombre,ciudad,estado,sucursal,activo,created_at,updated_at',
  erpRegiones: 'id_regi,created_at,regi_desd,regi_saba',
  erpSucursales: 'id_sucu,created_at,sucu_desc,id_regi',
  erpEstados: 'id_esta,created_at,esta_desc,id_regi',
  erpMunicipios: 'id_muni,created_at,muni_desc,id_esta,id_regi',
  erpSupervisores: 'id_supe,created_at,supe_nomb,supe_acti,id_regi,supe_cont',
  erpVendedores: 'id_vend,created_at,vend_codi,vend_nomb,vend_acti,id_sucu,id_supe,vend_cont',
  erpVendedoresExcluidos: 'id_fove,id_regi,fove_vend,updated_at',
  erpTipificaciones: 'id_tipi,created_at,tipi_desc,id_cave',
  erpCanales: 'id_cana,created_at,cana_desc',
  erpClientes:
    'id_clie,created_at,clie_rif,clie_nomb,id_esta,id_vend,id_muni,clie_regi,clie_acti,clie_lati,clie_long,id_tipi,id_clie_prin',
} as const;

export const DEFAULT_ENTITY_ERROR_MESSAGES: Record<MasterCatalogEntity | 'maestros', string> = {
  vendedores: 'No se pudo consultar el catálogo maestro de vendedores en Supabase.',
  clientes: 'No se pudo consultar el catálogo maestro de clientes en Supabase.',
  cadenas: 'No se pudo consultar el catálogo de cadenas comerciales en Supabase.',
  zonas: 'No se pudo consultar el catálogo de zonas geográficas en Supabase.',
  maestros: 'No se pudieron consultar los catálogos maestros en Supabase.',
};

/**
 * Redacta JWTs, llaves Supabase y credenciales antes de emitir logs o textos de diagnóstico.
 */
export function redactMasterDataSecrets(input: unknown): string {
  return String(input ?? '')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[TOKEN_REDACTADO]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/gi, '[SECRETO_REDACTADO]')
    .replace(/sb_publishable_[A-Za-z0-9_-]+/gi, '[LLAVE_REDACTADA]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [TOKEN_REDACTADO]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[URI_REDACTADA]');
}

export class MasterDataDiagnosticError extends Error {
  readonly categoryCode: MasterDataErrorCode;
  readonly technicalCode: string | null;
  readonly status: number | null;
  readonly entity: MasterCatalogEntity | 'maestros';
  readonly table: string | null;
  readonly hint: string | null;
  readonly technicalMessage: string;

  constructor(info: MasterDataDiagnosticInfo) {
    super(info.safeMessage);
    this.name = 'MasterDataDiagnosticError';
    this.categoryCode = info.categoryCode;
    this.technicalCode = info.technicalCode;
    this.status = info.status;
    this.entity = info.entity;
    this.table = info.table;
    this.hint = info.hint;
    this.technicalMessage = redactMasterDataSecrets(info.technicalMessage);
  }

  toDiagnosticInfo(): MasterDataDiagnosticInfo {
    return {
      categoryCode: this.categoryCode,
      technicalCode: this.technicalCode,
      status: this.status,
      entity: this.entity,
      table: this.table,
      safeMessage: this.message,
      technicalMessage: this.technicalMessage,
      hint: this.hint,
    };
  }
}

function extractRawErrorFields(err: unknown): {
  code: string | null;
  status: number | null;
  message: string;
  hint: string | null;
} {
  if (!err || typeof err !== 'object') {
    return {
      code: null,
      status: null,
      message: redactMasterDataSecrets(err ?? ''),
      hint: null,
    };
  }
  const rec = err as Record<string, unknown>;
  const codeRaw = rec.technicalCode ?? rec.code ?? rec.error_code ?? null;
  const statusRaw = rec.status ?? rec.statusCode ?? null;
  const status =
    typeof statusRaw === 'number' && Number.isFinite(statusRaw)
      ? statusRaw
      : typeof statusRaw === 'string' && /^\d{3}$/.test(statusRaw.trim())
        ? Number(statusRaw.trim())
        : null;
  const message = redactMasterDataSecrets(
    rec.technicalMessage ?? rec.message ?? rec.error_description ?? rec.error ?? ''
  );
  const hint = rec.hint ? redactMasterDataSecrets(rec.hint) : null;
  return {
    code: codeRaw ? String(codeRaw).trim().toUpperCase() : null,
    status,
    message,
    hint,
  };
}

export function isJwtExpiredOrUnauthorizedError(err: unknown): boolean {
  if (err instanceof MasterDataDiagnosticError) {
    return err.categoryCode === 'AUTH_REQUIRED' && (err.status === 401 || err.technicalCode === 'PGRST301');
  }
  const { code, status, message } = extractRawErrorFields(err);
  const lower = message.toLowerCase();
  return (
    status === 401 ||
    code === 'PGRST301' ||
    code === 'AUTH_SESSION_EXPIRED' ||
    code === 'AUTH_TOKEN_INVALID' ||
    lower.includes('jwt expired') ||
    lower.includes('invalid jwt') ||
    lower.includes('token is expired') ||
    lower.includes('sesión inválida o expirada')
  );
}

/**
 * Clasifica cualquier fallo de Supabase / PostgREST / BFF / Red en un código de categoría
 * seguro para la interfaz sin filtrar detalles internos ni credenciales.
 */
export function classifyMasterDataError(
  err: unknown,
  context: {
    entity?: MasterCatalogEntity | 'maestros';
    table?: string | null;
    fallbackMessage?: string;
  } = {}
): MasterDataDiagnosticInfo {
  const entity = context.entity ?? 'maestros';
  const fallbackMessage = context.fallbackMessage ?? DEFAULT_ENTITY_ERROR_MESSAGES[entity];

  if (err instanceof MasterDataDiagnosticError) {
    return {
      ...err.toDiagnosticInfo(),
      entity: err.entity === 'maestros' ? entity : err.entity,
      table: err.table ?? context.table ?? null,
    };
  }

  const raw = extractRawErrorFields(err);
  const upperCode = raw.code ?? '';
  const lowerMsg = raw.message.toLowerCase();

  let categoryCode: MasterDataErrorCode = 'UNKNOWN_ERR';
  let safeMessage = fallbackMessage;

  if (
    err instanceof ErrorConfiguracionIncompleta ||
    err instanceof ErrorSeguridadCredenciales ||
    upperCode === 'ENV_MISSING' ||
    upperCode === 'SUPABASE_SERVER_UNCONFIGURED' ||
    lowerMsg.includes('vite_supabase_url') ||
    lowerMsg.includes('vite_supabase_publishable_key') ||
    lowerMsg.includes('falta configurar supabase_url') ||
    lowerMsg.includes('sin conexión configurada')
  ) {
    categoryCode = 'ENV_MISSING';
    safeMessage = 'Configuración de conexión a Supabase incompleta en este entorno.';
  } else if (
    upperCode === '42501' ||
    upperCode === 'RLS_42501' ||
    upperCode === 'FORBIDDEN_ROLE' ||
    upperCode === 'FORBIDDEN_SUCURSAL_ACCESS' ||
    upperCode === 'FORBIDDEN_REGION_ACCESS' ||
    upperCode === 'UNASSIGNED_SUCURSAL' ||
    raw.status === 403 ||
    lowerMsg.includes('permission denied') ||
    lowerMsg.includes('row-level security') ||
    lowerMsg.includes('acceso denegado')
  ) {
    categoryCode = 'RLS_42501';
    safeMessage = `${fallbackMessage} Acceso denegado por RLS (permission denied para rol authenticated).`;
  } else if (
    upperCode === 'AUTH_REQUIRED' ||
    upperCode === 'AUTH_TOKEN_MISSING' ||
    upperCode === 'AUTH_TOKEN_INVALID' ||
    upperCode === 'AUTH_SESSION_EXPIRED' ||
    upperCode === 'PGRST301' ||
    raw.status === 401 ||
    lowerMsg.includes('jwt expired') ||
    lowerMsg.includes('invalid jwt') ||
    lowerMsg.includes('sesión requerida') ||
    lowerMsg.includes('sesión inválida')
  ) {
    categoryCode = 'AUTH_REQUIRED';
    safeMessage = 'Tu sesión expiró o no está activa. Vuelve a iniciar sesión para cargar los catálogos.';
  } else if (
    upperCode === 'SCHEMA_PGRST' ||
    upperCode === '42P01' ||
    upperCode === '42703' ||
    upperCode.startsWith('PGRST2') ||
    lowerMsg.includes('could not find the table') ||
    lowerMsg.includes('could not find a relationship') ||
    lowerMsg.includes('schema cache') ||
    (lowerMsg.includes('relation') && lowerMsg.includes('does not exist'))
  ) {
    categoryCode = 'SCHEMA_PGRST';
    safeMessage = `${fallbackMessage} Esquema o tabla maestra no disponible en PostgREST.`;
  } else if (
    upperCode === 'UPSTREAM_503' ||
    upperCode === 'MASTER_DATA_UPSTREAM_ERROR' ||
    raw.status === 502 ||
    raw.status === 503 ||
    raw.status === 504
  ) {
    categoryCode = 'UPSTREAM_503';
    safeMessage = fallbackMessage;
  } else if (
    upperCode === 'NETWORK_ERR' ||
    (err instanceof TypeError && lowerMsg.includes('fetch')) ||
    lowerMsg.includes('failed to fetch') ||
    lowerMsg.includes('networkerror') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('etimedout') ||
    lowerMsg.includes('aborted') ||
    lowerMsg.includes('load failed')
  ) {
    categoryCode = 'NETWORK_ERR';
    safeMessage = `${fallbackMessage} Sin conectividad momentánea con el servidor.`;
  }

  return {
    categoryCode,
    technicalCode: raw.code ?? (raw.status ? `HTTP_${raw.status}` : null),
    status: raw.status,
    entity,
    table: context.table ?? null,
    safeMessage,
    technicalMessage: raw.message || fallbackMessage,
    hint: raw.hint,
  };
}

export function logStructuredMasterDataError(
  info: MasterDataDiagnosticInfo,
  extra: Record<string, unknown> = {}
): void {
  console.error('[MasterData]', {
    categoryCode: info.categoryCode,
    code: info.technicalCode,
    status: info.status,
    entity: info.entity,
    table: info.table,
    message: redactMasterDataSecrets(info.technicalMessage),
    hint: info.hint ? redactMasterDataSecrets(info.hint) : null,
    ...extra,
  });
}

export function assertMasterDataEnvReady(entity: MasterCatalogEntity | 'maestros' = 'maestros'): void {
  if (!isMasterDataSupabaseConfigured) {
    const info: MasterDataDiagnosticInfo = {
      categoryCode: 'ENV_MISSING',
      technicalCode: 'ENV_MISSING',
      status: null,
      entity,
      table: null,
      safeMessage: 'Configuración de conexión a Supabase incompleta en este entorno.',
      technicalMessage: 'Falta VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_ANON_KEY.',
      hint: 'Verifica las variables de entorno públicas en Render y ejecuta Clear build cache & deploy.',
    };
    logStructuredMasterDataError(info);
    throw new MasterDataDiagnosticError(info);
  }
}

export function clientHasAuthSessionSupport(
  client: SupabaseClient<MasterDataDatabase> | SupabaseClient | null | undefined
): boolean {
  return Boolean(client && typeof client.auth?.getSession === 'function');
}

function isNodeLoopbackMockHarness(
  client: SupabaseClient<MasterDataDatabase> | SupabaseClient
): boolean {
  if (typeof window !== 'undefined') return false;
  if (typeof process === 'undefined' || !process.env?.NODE_TEST_CONTEXT) return false;
  const clientRec = client as unknown as {
    supabaseUrl?: unknown;
    rest?: { url?: unknown };
  };
  const targetUrl = String(
    clientRec?.supabaseUrl ?? clientRec?.rest?.url ?? SUPABASE_MASTER_PROJECT_URL
  );
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(targetUrl);
}

/**
 * Exige una sesión autenticada válida (`session?.access_token`) antes de ejecutar
 * cualquier consulta a catálogos maestros. Impide peticiones silenciosas como `anon`.
 */
export async function requireAuthenticatedMasterToken(
  client: SupabaseClient<MasterDataDatabase> | SupabaseClient,
  entity: MasterCatalogEntity | 'maestros',
  options: { forceRefresh?: boolean; enforceInNodeTest?: boolean } = {}
): Promise<string | null> {
  if (!clientHasAuthSessionSupport(client)) {
    // Cliente mock mínimo en pruebas unitarias sin subsistema `auth`
    return null;
  }

  const token = await getAuthenticatedSessionToken(client as unknown as SupabaseClient, {
    forceRefresh: options.forceRefresh,
  });
  if (!token) {
    if (!options.enforceInNodeTest && isNodeLoopbackMockHarness(client)) {
      return null;
    }
    const info: MasterDataDiagnosticInfo = {
      categoryCode: 'AUTH_REQUIRED',
      technicalCode: 'AUTH_REQUIRED',
      status: 401,
      entity,
      table: null,
      safeMessage:
        'Tu sesión no está activa o expiró. Inicia sesión para consultar los catálogos maestros.',
      technicalMessage: 'No existe un access_token autenticado activo para consultar catálogos maestros.',
      hint: 'Se bloqueó la consulta para evitar llamadas como rol anon.',
    };
    logStructuredMasterDataError(info);
    throw new MasterDataDiagnosticError(info);
  }
  return token;
}

/**
 * Ejecuta una consulta autenticada y, si recibe `401` / `JWT expired`, refresca la sesión
 * exactamente 1 vez mediante `refreshSession()` antes de fallar limpiamente con `AUTH_REQUIRED`.
 */
export async function executeWithSessionRefreshRetry<T>(
  client: SupabaseClient<MasterDataDatabase> | SupabaseClient,
  entity: MasterCatalogEntity | 'maestros',
  operation: (accessToken: string | null) => Promise<T>,
  options: { enforceInNodeTest?: boolean } = {}
): Promise<T> {
  const initialToken = await requireAuthenticatedMasterToken(client, entity, {
    forceRefresh: false,
    enforceInNodeTest: options.enforceInNodeTest,
  });

  try {
    return await operation(initialToken);
  } catch (firstErr) {
    if (!clientHasAuthSessionSupport(client) || !isJwtExpiredOrUnauthorizedError(firstErr)) {
      throw firstErr;
    }

    const refreshedToken = await getAuthenticatedSessionToken(client as unknown as SupabaseClient, {
      forceRefresh: true,
    });
    if (!refreshedToken) {
      const info = classifyMasterDataError(firstErr, { entity });
      const authInfo: MasterDataDiagnosticInfo = {
        ...info,
        categoryCode: 'AUTH_REQUIRED',
        status: 401,
        safeMessage:
          'Tu sesión expiró y no pudo renovarse automáticamente. Inicia sesión nuevamente.',
      };
      logStructuredMasterDataError(authInfo, { retryAttempted: true });
      throw new MasterDataDiagnosticError(authInfo);
    }

    return operation(refreshedToken);
  }
}

export interface PaginatedTableQueryOptions {
  table: string;
  select: string;
  orderBy?: string;
  optional?: boolean;
  pageSize?: number;
  entity?: MasterCatalogEntity | 'maestros';
}

function isMissingOrderColumnError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? '').toUpperCase();
  const msg = String(err.message ?? '').toLowerCase();
  return code === '42703' || code === 'PGRST204' || msg.includes('does not exist');
}

/**
 * Helper genérico de lectura paginada en bloques de 1,000 filas con orden determinístico
 * (`.order(orderBy, { ascending: true }).range(from, to)`) para evitar el recorte
 * silencioso de PostgREST (>1,000 filas) y duplicación entre páginas.
 */
export async function fetchPaginatedPostgrestTable<T>(
  client: SupabaseClient<MasterDataDatabase> | SupabaseClient,
  options: PaginatedTableQueryOptions
): Promise<T[]> {
  const pageSize = Math.max(100, Math.min(options.pageSize ?? MASTER_PAGINATION_BLOCK_SIZE, 1000));
  const rows: T[] = [];
  let useOrder = Boolean(options.orderBy);

  for (let from = 0; ; from += pageSize) {
    const runPage = async (applyOrder: boolean) => {
      let query = (client as SupabaseClient).from(options.table).select(options.select);
      if (applyOrder && options.orderBy && typeof query.order === 'function') {
        query = query.order(options.orderBy, { ascending: true });
      }
      query = query.range(from, from + pageSize - 1);
      return query;
    };

    let { data, error } = await runPage(useOrder);

    if (error && useOrder && isMissingOrderColumnError(error)) {
      useOrder = false;
      ({ data, error } = await runPage(false));
    }

    if (error) {
      if (options.optional) {
        return [];
      }
      const info = classifyMasterDataError(error, {
        entity: options.entity ?? 'maestros',
        table: options.table,
      });
      logStructuredMasterDataError(info);
      throw new MasterDataDiagnosticError(info);
    }

    const page = Array.isArray(data) ? (data as unknown as T[]) : [];
    rows.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }

  return rows;
}

// =============================================================================
// DEDUPLICACIÓN EN VUELO + SNAPSHOT ERP COMPARTIDO EN MEMORIA (TTL 5 MIN)
// =============================================================================

export interface DirectErpMasterRawDataset {
  regiones: ErpRegionRow[];
  sucursales: ErpSucursalRow[];
  estados: ErpEstadoRow[];
  municipios: ErpMunicipioRow[];
  supervisores: ErpSupervisorRow[];
  vendedores: ErpVendedorRow[];
  vendedoresExcluidos: ErpForecastExcludedVendedoresRow[];
  tipificaciones: ErpTipificacionRow[];
  canalesComercializacion: ErpCanalComercializacionRow[];
  clientes: ErpClienteRow[];
  fetchedAtMs: number;
}

const inFlightRequests = new Map<string, Promise<unknown>>();
const sharedDirectErpCache = new Map<string, { dataset: DirectErpMasterRawDataset; expiresAt: number }>();

/**
 * Deduplica llamadas concurrentes en vuelo por clave (evita dobles fetch en re-renders
 * de React StrictMode o llamadas simultáneas a los 4 catálogos).
 */
export function deduplicateMasterRequest<T>(
  key: string,
  factory: () => Promise<T>,
  bypassInFlight = false
): Promise<T> {
  if (!bypassInFlight) {
    const existing = inFlightRequests.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
  }

  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (inFlightRequests.get(key) === promise) {
        inFlightRequests.delete(key);
      }
    });

  inFlightRequests.set(key, promise);
  return promise;
}

export function clearMasterCatalogRuntimeCaches(): void {
  inFlightRequests.clear();
  sharedDirectErpCache.clear();
}

registerSupabaseSessionResetCallback(clearMasterCatalogRuntimeCaches);
registerMemoryCachePurgeCallback(clearMasterCatalogRuntimeCaches);

/**
 * Descarga las tablas ERP reales (`"Regiones"`, `"Clientes"`, `"Vendedores"`, etc.) una sola vez
 * de forma deduplicada y paginada determinísticamente, compartiendo el resultado entre las 4
 * lecturas paralelas (`vendedores`, `clientes`, `cadenas`, `zonas`) durante 5 minutos.
 */
export async function loadSharedDirectErpDataset(
  client: SupabaseClient<MasterDataDatabase>,
  options: {
    forceRefresh?: boolean;
    useSingletonCache?: boolean;
    ttlMs?: number;
    entity?: MasterCatalogEntity | 'maestros';
  } = {}
): Promise<DirectErpMasterRawDataset> {
  const useCache = options.useSingletonCache !== false;
  const ttlMs = Math.max(10_000, options.ttlMs ?? DEFAULT_SHARED_ERP_CACHE_TTL_MS);
  const scope = (getActiveClientSucursalHeader() ?? 'GLOBAL').toUpperCase();
  const cacheKey = `ERP_DIRECT::${scope}`;

  if (useCache && !options.forceRefresh) {
    const hit = sharedDirectErpCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      return hit.dataset;
    }
    if (hit) {
      sharedDirectErpCache.delete(cacheKey);
    }
  }

  const loader = async (): Promise<DirectErpMasterRawDataset> => {
    return executeWithSessionRefreshRetry(client, options.entity ?? 'maestros', async () => {
      const [
        regiones,
        sucursales,
        estados,
        municipios,
        supervisores,
        vendedores,
        vendedoresExcluidos,
        tipificaciones,
        canalesComercializacion,
        clientes,
      ] = await Promise.all([
        fetchPaginatedPostgrestTable<ErpRegionRow>(client, {
          table: 'Regiones',
          select: MASTER_SELECT_COLUMNS.erpRegiones,
          orderBy: 'id_regi',
          optional: false,
          entity: options.entity ?? 'maestros',
        }),
        fetchPaginatedPostgrestTable<ErpSucursalRow>(client, {
          table: 'Sucursales',
          select: MASTER_SELECT_COLUMNS.erpSucursales,
          orderBy: 'id_sucu',
          optional: true,
          entity: options.entity ?? 'maestros',
        }),
        fetchPaginatedPostgrestTable<ErpEstadoRow>(client, {
          table: 'Estados',
          select: MASTER_SELECT_COLUMNS.erpEstados,
          orderBy: 'id_esta',
          optional: true,
          entity: options.entity ?? 'maestros',
        }),
        fetchPaginatedPostgrestTable<ErpMunicipioRow>(client, {
          table: 'Municipios',
          select: MASTER_SELECT_COLUMNS.erpMunicipios,
          orderBy: 'id_muni',
          optional: true,
          entity: options.entity ?? 'maestros',
        }),
        fetchPaginatedPostgrestTable<ErpSupervisorRow>(client, {
          table: 'Supervisores',
          select: MASTER_SELECT_COLUMNS.erpSupervisores,
          orderBy: 'id_supe',
          optional: true,
          entity: options.entity ?? 'maestros',
        }),
        fetchPaginatedPostgrestTable<ErpVendedorRow>(client, {
          table: 'Vendedores',
          select: MASTER_SELECT_COLUMNS.erpVendedores,
          orderBy: 'id_vend',
          optional: false,
          entity: 'vendedores',
        }),
        fetchPaginatedPostgrestTable<ErpForecastExcludedVendedoresRow>(client, {
          table: 'Forecast_Vendedores_Excluidos',
          select: MASTER_SELECT_COLUMNS.erpVendedoresExcluidos,
          orderBy: 'id_fove',
          optional: true,
          entity: 'vendedores',
        }),
        fetchPaginatedPostgrestTable<ErpTipificacionRow>(client, {
          table: 'Tipificacion_Clientes',
          select: MASTER_SELECT_COLUMNS.erpTipificaciones,
          orderBy: 'id_tipi',
          optional: true,
          entity: 'cadenas',
        }),
        fetchPaginatedPostgrestTable<ErpCanalComercializacionRow>(client, {
          table: 'Canal_Comercializacion',
          select: MASTER_SELECT_COLUMNS.erpCanales,
          orderBy: 'id_cana',
          optional: true,
          entity: 'cadenas',
        }),
        fetchPaginatedPostgrestTable<ErpClienteRow>(client, {
          table: 'Clientes',
          select: MASTER_SELECT_COLUMNS.erpClientes,
          orderBy: 'id_clie',
          optional: false,
          entity: 'clientes',
        }),
      ]);

      const dataset: DirectErpMasterRawDataset = {
        regiones,
        sucursales,
        estados,
        municipios,
        supervisores,
        vendedores,
        vendedoresExcluidos,
        tipificaciones,
        canalesComercializacion,
        clientes,
        fetchedAtMs: Date.now(),
      };

      if (useCache) {
        if (sharedDirectErpCache.size >= 8) {
          sharedDirectErpCache.clear();
        }
        sharedDirectErpCache.set(cacheKey, {
          dataset,
          expiresAt: Date.now() + ttlMs,
        });
      }
      return dataset;
    });
  };

  if (!useCache) {
    return loader();
  }

  return deduplicateMasterRequest(cacheKey, loader, Boolean(options.forceRefresh));
}
