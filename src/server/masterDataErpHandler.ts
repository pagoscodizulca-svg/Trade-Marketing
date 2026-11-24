import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildAuditedErpVendedoresDataset,
  computeClientesSummaryBySede,
  computeMasterEntitiesSummaryByRegion,
  filterNormalizedErpClientes,
  filterNormalizedErpVendedores,
  normalizeErpCadenasDataset,
  normalizeErpClientesDataset,
  normalizeErpProductosDataset,
  normalizeErpPromotorasDataset,
  normalizeErpRegionesDataset,
  normalizeErpSupervisoresDataset,
  normalizeErpZonasDataset,
  type ErpCanalComercializacionRow,
  type ErpClienteRow,
  type ErpEstadoRow,
  type ErpForecastExcludedVendedoresRow,
  type ErpMasterDataset,
  type ErpMunicipioRow,
  type ErpProductoRow,
  type ErpPromotoraRow,
  type ErpRegionRow,
  type ErpSucursalRow,
  type ErpSupervisorRow,
  type ErpTipificacionRow,
  type ErpVendedorRow,
  type ErpVwProductoDetalleRow,
  type RegionEntitiesSummary,
  type SedeClientCountSummary,
  type VendedoresAuditSummary,
} from '../utils/erpMasterAdapter';
import {
  classifyPromotoraCategoriaOficial,
  normalizeRegionName,
} from '../utils/regionalSyncClassifier';
import type {
  AllowedRegionCode,
  CadenaComercial,
  ClienteConVendedor,
  ProductoMaestro,
  PromotoraMaestra,
  RegionMaestra,
  SucursalMaestro,
  SupervisorMaestro,
  Vendedor,
  ZonaComercial,
} from '../types/masterData';
import {
  createUserScopedSupabaseClient,
  getAdminSupabaseClient,
  isOperativeServerSucursal,
  normalizeServerSucursal,
  type AuthenticatedServerUser,
} from './supabaseAdminAuth';
import { serverLogger } from './logger';

const ERP_PAGE_SIZE = 1000;
const DEFAULT_ERP_CACHE_TTL_MS = 60_000;
const MAX_USER_SCOPED_CACHE_ENTRIES = 32;

const PROMOTORAS_FULL_SELECT =
  'id,nombre_completo,direccion,telefono,correo,activo,created_at,updated_at,categoria,region,region_id,auth_user_id';
const PROMOTORAS_BASE_SELECT =
  'id,nombre_completo,direccion,telefono,correo,activo,created_at,updated_at,categoria';

export type ServerMasterDataCategoryCode =
  | 'ENV_MISSING'
  | 'AUTH_REQUIRED'
  | 'RLS_42501'
  | 'SCHEMA_PGRST'
  | 'UPSTREAM_503'
  | 'NETWORK_ERR'
  | 'UNKNOWN_ERR';

export class ServerMasterDataError extends Error {
  readonly categoryCode: ServerMasterDataCategoryCode;
  readonly technicalCode: string | null;
  readonly httpStatus: number;
  readonly table: string | null;
  readonly hint: string | null;

  constructor(params: {
    message: string;
    categoryCode: ServerMasterDataCategoryCode;
    technicalCode?: string | null;
    httpStatus?: number;
    table?: string | null;
    hint?: string | null;
  }) {
    super(params.message);
    this.name = 'ServerMasterDataError';
    this.categoryCode = params.categoryCode;
    this.technicalCode = params.technicalCode ?? null;
    this.httpStatus = params.httpStatus ?? 503;
    this.table = params.table ?? null;
    this.hint = params.hint ?? null;
  }
}

function classifyServerErpError(err: unknown, fallbackTable: string | null = null): ServerMasterDataError {
  if (err instanceof ServerMasterDataError) {
    return err;
  }
  const rec = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
  const code = rec.code ? String(rec.code).trim().toUpperCase() : null;
  const message = String(rec.message ?? (err instanceof Error ? err.message : err ?? 'Error consultando Supabase'));
  const hint = rec.hint ? String(rec.hint) : null;
  const lower = message.toLowerCase();

  if (code === 'ENV_MISSING' || lower.includes('falta configurar supabase_url')) {
    return new ServerMasterDataError({
      message,
      categoryCode: 'ENV_MISSING',
      technicalCode: 'ENV_MISSING',
      httpStatus: 503,
      table: fallbackTable,
      hint: 'Verifica SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_PUBLISHABLE_KEY + RLS) en Render.',
    });
  }
  if (code === '42501' || lower.includes('permission denied') || lower.includes('row-level security')) {
    return new ServerMasterDataError({
      message,
      categoryCode: 'RLS_42501',
      technicalCode: code ?? '42501',
      httpStatus: 403,
      table: fallbackTable,
      hint,
    });
  }
  if (code === 'PGRST301' || lower.includes('jwt expired') || lower.includes('invalid jwt')) {
    return new ServerMasterDataError({
      message,
      categoryCode: 'AUTH_REQUIRED',
      technicalCode: code ?? 'AUTH_REQUIRED',
      httpStatus: 401,
      table: fallbackTable,
      hint,
    });
  }
  if (
    code === '42P01' ||
    code === '42703' ||
    (code && code.startsWith('PGRST2')) ||
    lower.includes('could not find the table') ||
    lower.includes('does not exist')
  ) {
    return new ServerMasterDataError({
      message,
      categoryCode: 'SCHEMA_PGRST',
      technicalCode: code ?? 'SCHEMA_PGRST',
      httpStatus: 503,
      table: fallbackTable,
      hint,
    });
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('network')
  ) {
    return new ServerMasterDataError({
      message,
      categoryCode: 'NETWORK_ERR',
      technicalCode: code ?? 'NETWORK_ERR',
      httpStatus: 503,
      table: fallbackTable,
      hint,
    });
  }

  return new ServerMasterDataError({
    message,
    categoryCode: 'UPSTREAM_503',
    technicalCode: code ?? 'MASTER_DATA_UPSTREAM_ERROR',
    httpStatus: 503,
    table: fallbackTable,
    hint,
  });
}

function sendMasterDataErrorResponse(
  res: Response,
  err: unknown,
  entity: string,
  safeErrorMessage: string
): void {
  const classified = classifyServerErpError(err);
  serverLogger.error('master_data_erp_query_failed', {
    entity,
    categoryCode: classified.categoryCode,
    technicalCode: classified.technicalCode,
    table: classified.table,
    httpStatus: classified.httpStatus,
    message: classified.message,
    hint: classified.hint,
  });
  res.status(classified.httpStatus).json({
    error: safeErrorMessage,
    code: classified.categoryCode,
    technicalCode: classified.technicalCode ?? classified.categoryCode,
    entity,
  });
}

export interface MasterDataExactCounts {
  regiones: number;
  productos: number;
  clientesTotal: number;
  clientesActivos: number;
  clientesConGps: number;
  promotoras: number;
  supervisores: number;
  cadenas: number;
  zonas: number;
  vendedores: number;
}

export interface MasterDataErpSnapshot {
  regiones?: RegionMaestra[];
  productos?: ProductoMaestro[];
  supervisores?: SupervisorMaestro[];
  promotoras?: PromotoraMaestra[];
  cadenas?: CadenaComercial[];
  zonas?: ZonaComercial[];
  clientes: ClienteConVendedor[];
  vendedores: Vendedor[];
  vendedoresAuditoria: VendedoresAuditSummary;
  sedesResumen: SedeClientCountSummary[];
  resumenRegional?: RegionEntitiesSummary[];
  countsExact?: MasterDataExactCounts;
  fetchedAtMs: number;
  source: 'supabase_erp_clientes';
}

export interface MasterDataSnapshotLoadOptions {
  forceRefresh?: boolean;
  accessToken?: string;
  activeSucursalHeader?: string | null;
  userId?: string;
}

export interface MasterDataErpGateway {
  loadSnapshot(options?: MasterDataSnapshotLoadOptions): Promise<MasterDataErpSnapshot>;
}

let cachedSnapshot: MasterDataErpSnapshot | null = null;
let inflightSnapshotPromise: Promise<MasterDataErpSnapshot> | null = null;
const userScopedSnapshotCache = new Map<string, MasterDataErpSnapshot>();
const userScopedInflightMap = new Map<string, Promise<MasterDataErpSnapshot>>();

export function invalidateMasterDataErpServerCache(): void {
  cachedSnapshot = null;
  userScopedSnapshotCache.clear();
  userScopedInflightMap.clear();
}

function isMissingColumnError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? '').toUpperCase();
  const msg = String(err.message ?? '').toLowerCase();
  return code === '42703' || code === 'PGRST204' || msg.includes('does not exist');
}

async function fetchAllTablePages<T>(
  client: SupabaseClient,
  tableName: string,
  selectExpr = '*',
  orderBy?: string,
  fallbackSelectExpr?: string
): Promise<{ rows: T[]; exactCount: number }> {
  const rows: T[] = [];
  let exactCount: number | null = null;
  let activeSelect = selectExpr;
  let useOrder = Boolean(orderBy);

  for (let from = 0; ; from += ERP_PAGE_SIZE) {
    const runPage = async (sel: string, applyOrder: boolean) => {
      // Evitamos `{ count: 'exact' }` en cada página para prevenir statement_timeout (57014) bajo RLS;
      // el conteo exacto se obtiene del total paginado `rows.length`.
      let query = client.from(tableName).select(sel);
      if (applyOrder && orderBy && typeof query.order === 'function') {
        query = query.order(orderBy, { ascending: true });
      }
      return query.range(from, from + ERP_PAGE_SIZE - 1);
    };

    let { data, error } = await runPage(activeSelect, useOrder);

    if (error && fallbackSelectExpr && activeSelect !== fallbackSelectExpr && isMissingColumnError(error)) {
      activeSelect = fallbackSelectExpr;
      ({ data, error } = await runPage(activeSelect, useOrder));
    }

    if (error && useOrder && isMissingColumnError(error)) {
      useOrder = false;
      ({ data, error } = await runPage(activeSelect, false));
    }

    if (error) {
      throw classifyServerErpError(error, tableName);
    }

    const page = Array.isArray(data) ? (data as T[]) : [];
    rows.push(...page);
    if (page.length < ERP_PAGE_SIZE) {
      break;
    }
  }
  return { rows, exactCount: exactCount ?? rows.length };
}

async function fetchOptionalTablePages<T>(
  client: SupabaseClient,
  tableName: string,
  selectExpr = '*',
  orderBy?: string,
  fallbackSelectExpr?: string
): Promise<{ rows: T[]; exactCount: number }> {
  try {
    return await fetchAllTablePages<T>(client, tableName, selectExpr, orderBy, fallbackSelectExpr);
  } catch {
    return { rows: [], exactCount: 0 };
  }
}

/**
 * Carga y normaliza TODAS las entidades maestras de CODIZULCA desde Supabase
 * paginando automáticamente en bloques de 1,000 filas con orden determinístico por PK
 * (`count: 'exact'`) sin truncamiento:
 * `"Regiones"`, `"Productos"`, `"vw_productos_detalle"`, `"Clientes"`, `promotoras`,
 * `"Supervisores"`, `"Vendedores"`, `"Forecast_Vendedores_Excluidos"`, `"Sucursales"`,
 * `"Estados"`, `"Municipios"`, `"Tipificacion_Clientes"` y `"Canal_Comercializacion"`.
 *
 * SEGURIDAD:
 *  - Se ejecuta en servidor con `getAdminSupabaseClient()` (si `SUPABASE_SERVICE_ROLE_KEY`
 *    está configurada en Render) o con `createUserScopedSupabaseClient(jwt)` bajo RLS
 *    para rol `authenticated` (jamás `anon`, jamás expuesta al navegador).
 *  - Los handlers siempre filtran por región/sede autorizada antes de serializar la respuesta.
 */
export async function loadErpMasterSnapshotFromClient(
  client: SupabaseClient
): Promise<MasterDataErpSnapshot> {
  const [
    regionesRes,
    sucursalesRes,
    estadosRes,
    municipiosRes,
    supervisoresRes,
    vendedoresRes,
    vendedoresExcluidosRes,
    tipificacionesRes,
    canalesRes,
    clientesRes,
    productosRes,
    vwProductosRes,
    promotorasRes,
  ] = await Promise.all([
    fetchAllTablePages<ErpRegionRow>(client, 'Regiones', 'id_regi,created_at,regi_desd,regi_saba', 'id_regi'),
    fetchOptionalTablePages<ErpSucursalRow>(client, 'Sucursales', 'id_sucu,created_at,sucu_desc,id_regi', 'id_sucu'),
    fetchOptionalTablePages<ErpEstadoRow>(client, 'Estados', 'id_esta,created_at,esta_desc,id_regi', 'id_esta'),
    fetchOptionalTablePages<ErpMunicipioRow>(client, 'Municipios', 'id_muni,created_at,muni_desc,id_esta,id_regi', 'id_muni'),
    fetchOptionalTablePages<ErpSupervisorRow>(client, 'Supervisores', 'id_supe,created_at,supe_nomb,supe_acti,id_regi,supe_cont', 'id_supe'),
    fetchAllTablePages<ErpVendedorRow>(client, 'Vendedores', 'id_vend,created_at,vend_codi,vend_nomb,vend_acti,id_sucu,id_supe,vend_cont', 'id_vend'),
    fetchOptionalTablePages<ErpForecastExcludedVendedoresRow>(
      client,
      'Forecast_Vendedores_Excluidos',
      'id_fove,id_regi,fove_vend,updated_at',
      'id_fove'
    ),
    fetchOptionalTablePages<ErpTipificacionRow>(client, 'Tipificacion_Clientes', 'id_tipi,created_at,tipi_desc,id_cave', 'id_tipi'),
    fetchOptionalTablePages<ErpCanalComercializacionRow>(
      client,
      'Canal_Comercializacion',
      'id_cana,created_at,cana_desc',
      'id_cana'
    ),
    fetchAllTablePages<ErpClienteRow>(
      client,
      'Clientes',
      'id_clie,created_at,clie_rif,clie_nomb,id_esta,id_vend,id_muni,clie_regi,clie_acti,clie_lati,clie_long,id_tipi,id_clie_prin',
      'id_clie'
    ),
    fetchOptionalTablePages<ErpProductoRow>(
      client,
      'Productos',
      'id_prod,created_at,prod_codi,prod_desc,prod_unid,prod_acti',
      'id_prod'
    ),
    fetchOptionalTablePages<ErpVwProductoDetalleRow>(
      client,
      'vw_productos_detalle',
      'id_prod,codigo,producto,orden,activo,marca,marca_propia,familia,grupo,regiones,n_regiones,created_at',
      'id_prod'
    ),
    fetchOptionalTablePages<ErpPromotoraRow>(
      client,
      'promotoras',
      PROMOTORAS_FULL_SELECT,
      'id',
      PROMOTORAS_BASE_SELECT
    ),
  ]);

  const dataset: ErpMasterDataset = {
    regiones: regionesRes.rows,
    sucursales: sucursalesRes.rows,
    estados: estadosRes.rows,
    municipios: municipiosRes.rows,
    supervisores: supervisoresRes.rows,
    vendedores: vendedoresRes.rows,
    vendedoresExcluidos: vendedoresExcluidosRes.rows,
    tipificaciones: tipificacionesRes.rows,
    canalesComercializacion: canalesRes.rows,
    clientes: clientesRes.rows,
    productos: productosRes.rows,
    vwProductosDetalle: vwProductosRes.rows,
    promotoras: promotorasRes.rows,
  };

  const regiones = normalizeErpRegionesDataset(dataset.regiones);
  const productos = normalizeErpProductosDataset(dataset.productos, dataset.vwProductosDetalle);
  const supervisores = normalizeErpSupervisoresDataset(dataset.supervisores, dataset.regiones);
  const promotoras = normalizeErpPromotorasDataset(dataset.promotoras ?? [], dataset.regiones);
  const cadenas = normalizeErpCadenasDataset(dataset);
  const zonas = normalizeErpZonasDataset(dataset);
  const { vendedores, auditoria: vendedoresAuditoria } = buildAuditedErpVendedoresDataset(dataset);
  const clientes = normalizeErpClientesDataset(dataset);
  const sedesResumen = computeClientesSummaryBySede(clientes, vendedores);
  const resumenRegional = computeMasterEntitiesSummaryByRegion({
    regiones,
    clientes,
    promotoras,
    supervisores,
    vendedores,
    cadenas,
    zonas,
  });

  const clientesActivos = clientes.filter((c) => c.activo);
  const clientesConGps = clientesActivos.filter((c) => c.latitud !== null && c.longitud !== null).length;

  const countsExact: MasterDataExactCounts = {
    regiones: regiones.length,
    productos: productos.length,
    clientesTotal: clientes.length,
    clientesActivos: clientesActivos.length,
    clientesConGps,
    promotoras: promotoras.length,
    supervisores: supervisores.length,
    cadenas: cadenas.length,
    zonas: zonas.length,
    vendedores: vendedores.length,
  };

  return {
    regiones,
    productos,
    supervisores,
    promotoras,
    cadenas,
    zonas,
    clientes,
    vendedores,
    vendedoresAuditoria,
    sedesResumen,
    resumenRegional,
    countsExact,
    fetchedAtMs: Date.now(),
    source: 'supabase_erp_clientes',
  };
}

export function createDefaultMasterDataErpGateway(
  cacheTtlMs = DEFAULT_ERP_CACHE_TTL_MS
): MasterDataErpGateway {
  return {
    async loadSnapshot(options: MasterDataSnapshotLoadOptions = {}): Promise<MasterDataErpSnapshot> {
      const now = Date.now();
      const adminClient = getAdminSupabaseClient();

      const loadUserScopedSnapshot = async (reason: string): Promise<MasterDataErpSnapshot> => {
        const userToken = String(options.accessToken ?? '').trim();
        const userClient = userToken
          ? createUserScopedSupabaseClient(userToken, options.activeSucursalHeader)
          : null;

        if (!userClient) {
          throw new ServerMasterDataError({
            message:
              'Falta configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (o llave pública + sesión autenticada) en el servidor.',
            categoryCode: 'ENV_MISSING',
            technicalCode: 'ENV_MISSING',
            httpStatus: 503,
            hint: 'Configura SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY y SUPABASE_SERVICE_ROLE_KEY en Render.',
          });
        }

        const scopeKey = `${options.userId || 'auth-user'}::${options.activeSucursalHeader || 'ALL'}`;
        if (!options.forceRefresh) {
          const cachedUserSnap = userScopedSnapshotCache.get(scopeKey);
          if (cachedUserSnap && now - cachedUserSnap.fetchedAtMs < cacheTtlMs) {
            return cachedUserSnap;
          }
          const existingInflight = userScopedInflightMap.get(scopeKey);
          if (existingInflight) {
            return existingInflight;
          }
        }

        serverLogger.warn('master_data_using_user_scoped_rls_fallback', {
          reason,
          userId: options.userId ?? null,
        });

        const userPromise = loadErpMasterSnapshotFromClient(userClient)
          .then((snap) => {
            if (userScopedSnapshotCache.size >= MAX_USER_SCOPED_CACHE_ENTRIES) {
              userScopedSnapshotCache.clear();
            }
            userScopedSnapshotCache.set(scopeKey, snap);
            return snap;
          })
          .finally(() => {
            if (userScopedInflightMap.get(scopeKey) === userPromise) {
              userScopedInflightMap.delete(scopeKey);
            }
          });

        userScopedInflightMap.set(scopeKey, userPromise);
        return userPromise;
      };

      if (adminClient) {
        if (
          !options.forceRefresh &&
          cachedSnapshot &&
          now - cachedSnapshot.fetchedAtMs < cacheTtlMs
        ) {
          return cachedSnapshot;
        }

        if (inflightSnapshotPromise && !options.forceRefresh) {
          try {
            return await inflightSnapshotPromise;
          } catch (inflightErr) {
            const classified = classifyServerErpError(inflightErr);
            if (
              (classified.categoryCode === 'RLS_42501' || classified.categoryCode === 'AUTH_REQUIRED') &&
              options.accessToken
            ) {
              return loadUserScopedSnapshot(
                'adminClient rechazado por Supabase (42501/401); ejecutando respaldo con JWT authenticated bajo RLS.'
              );
            }
            throw inflightErr;
          }
        }

        const promise = loadErpMasterSnapshotFromClient(adminClient)
          .then((snap) => {
            cachedSnapshot = snap;
            return snap;
          })
          .finally(() => {
            if (inflightSnapshotPromise === promise) {
              inflightSnapshotPromise = null;
            }
          });

        inflightSnapshotPromise = promise;
        try {
          return await promise;
        } catch (adminErr) {
          const classified = classifyServerErpError(adminErr);
          if (
            (classified.categoryCode === 'RLS_42501' || classified.categoryCode === 'AUTH_REQUIRED') &&
            options.accessToken
          ) {
            return loadUserScopedSnapshot(
              'adminClient rechazado por Supabase (42501/401); ejecutando respaldo con JWT authenticated bajo RLS.'
            );
          }
          throw adminErr;
        }
      }

      return loadUserScopedSnapshot(
        'SUPABASE_SERVICE_ROLE_KEY ausente o no-secreta en runtime; consultando Data Maestra con JWT authenticated bajo RLS.'
      );
    },
  };
}

function parseOptionalRegionParam(raw: unknown): AllowedRegionCode | undefined {
  const norm = normalizeRegionName(raw);
  return norm ?? undefined;
}

function parseBoolParam(raw: unknown, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const s = String(raw).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no') return false;
  if (s === 'true' || s === '1' || s === 'si') return true;
  return defaultValue;
}

function normalizeSearchToken(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

function matchesTextQuery(haystack: string, query: string): boolean {
  const q = normalizeSearchToken(query);
  if (!q) return true;
  const h = normalizeSearchToken(haystack);
  if (h.includes(q)) return true;
  const compactQ = q.replace(/[^A-Z0-9Ñ]+/g, '');
  return compactQ.length >= 2 && h.replace(/[^A-Z0-9Ñ]+/g, '').includes(compactQ);
}

function matchesEntityRegion(
  item: { region_id?: string | null; sucursal?: string | null; metadata?: Record<string, unknown> },
  region: AllowedRegionCode | null,
  regionId: string | null,
  regions?: readonly AllowedRegionCode[] | null,
  allowedRegionIds?: ReadonlySet<string> | null
): boolean {
  const itemRegion =
    normalizeRegionName(item.metadata?.region_codigo) ?? normalizeRegionName(item.sucursal);

  if (regions && regions.length > 0) {
    if (region && !regions.includes(region)) return false;
    if (regionId) {
      if (item.region_id) {
        return (
          item.region_id === regionId &&
          (!itemRegion || regions.includes(itemRegion))
        );
      }
      return Boolean(itemRegion && (!region || itemRegion === region) && regions.includes(itemRegion));
    }
    if (itemRegion) {
      return (!region || itemRegion === region) && regions.includes(itemRegion);
    }
    if (allowedRegionIds && item.region_id) {
      return allowedRegionIds.has(item.region_id);
    }
    return false;
  }

  if (region && regionId) {
    if (item.region_id) {
      return item.region_id === regionId && (!itemRegion || itemRegion === region);
    }
    return itemRegion === region;
  }
  if (regionId) {
    if (item.region_id === regionId) return true;
    if (!region) return false;
  }
  if (!region) return true;
  return itemRegion === region;
}

function isGlobalMasterActor(actor: AuthenticatedServerUser): boolean {
  return (
    actor.isSuperAdmin === true ||
    actor.sucursal === 'GLOBAL' ||
    actor.appRole === 'super_admin' ||
    actor.appRole === 'superadmin'
  );
}

function parseOptionalRegionsParam(raw: unknown): AllowedRegionCode[] | null {
  const parts: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') parts.push(...item.split(','));
    }
  } else if (typeof raw === 'string' && raw.trim()) {
    parts.push(...raw.split(','));
  }
  const normalized: AllowedRegionCode[] = [];
  for (const part of parts) {
    const clean = part.trim().toUpperCase();
    if (!clean || clean === 'ALL' || clean === 'TODAS' || clean === 'GLOBAL' || clean === 'ASSIGNED') {
      continue;
    }
    const mapped = normalizeRegionName(clean);
    if (mapped && !normalized.includes(mapped)) {
      normalized.push(mapped);
    }
  }
  return normalized.length > 0 ? normalized : null;
}

function resolveActorAllowedRegionsList(actor: AuthenticatedServerUser): AllowedRegionCode[] {
  const out: AllowedRegionCode[] = [];
  if (Array.isArray(actor.allowedRegions)) {
    for (const item of actor.allowedRegions) {
      const mapped = normalizeRegionName(item);
      if (mapped && !out.includes(mapped)) out.push(mapped);
    }
  }
  if (out.length === 0 && actor.sucursal) {
    const mapped = normalizeRegionName(actor.sucursal);
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * Valida que un actor regional (mono o multi-región) no pueda inyectar un `?regionId=` ajeno a sus regiones asignadas.
 */
function resolveAuthorizedRegionIdFilter(params: {
  actor: AuthenticatedServerUser;
  scopeRegion: AllowedRegionCode | null;
  scopeRegions?: readonly AllowedRegionCode[] | null;
  rawRequestedRegionId: unknown;
  regiones: ReadonlyArray<{ id: string; codigo: string }>;
}):
  | { ok: true; regionId: string | null; allowedRegionIds: ReadonlySet<string> | null }
  | { ok: false; status: number; code: string; error: string } {
  const requestedId =
    typeof params.rawRequestedRegionId === 'string' && params.rawRequestedRegionId.trim()
      ? params.rawRequestedRegionId.trim()
      : null;

  if (isGlobalMasterActor(params.actor)) {
    return { ok: true, regionId: requestedId, allowedRegionIds: null };
  }

  const effectiveRegions: AllowedRegionCode[] =
    params.scopeRegions && params.scopeRegions.length > 0
      ? [...params.scopeRegions]
      : params.scopeRegion
        ? [params.scopeRegion]
        : resolveActorAllowedRegionsList(params.actor);

  const allowedIds = new Set<string>(
    params.regiones
      .filter((r) => {
        const code = normalizeRegionName(r.codigo);
        return Boolean(code && effectiveRegions.includes(code));
      })
      .map((r) => r.id)
  );

  if (requestedId && !allowedIds.has(requestedId)) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN_REGION_ACCESS',
      error: `Acceso denegado: tu cuenta (${effectiveRegions.join(', ') || 'región restringida'}) no puede consultar datos de otra región.`,
    };
  }

  if (requestedId) {
    return { ok: true, regionId: requestedId, allowedRegionIds: allowedIds };
  }

  if (params.scopeRegion) {
    const singleId =
      params.regiones.find((r) => normalizeRegionName(r.codigo) === params.scopeRegion)?.id ?? null;
    return { ok: true, regionId: singleId, allowedRegionIds: allowedIds };
  }

  return {
    ok: true,
    regionId: allowedIds.size === 1 ? Array.from(allowedIds)[0]! : null,
    allowedRegionIds: allowedIds,
  };
}

function filterSedesResumenForRegion<T extends { sucursal: string }>(
  sedesResumen: ReadonlyArray<T>,
  region: AllowedRegionCode | null,
  sucursal: SucursalMaestro | null,
  regions?: readonly AllowedRegionCode[] | null
): T[] {
  if (region) {
    return sedesResumen.filter((s) => normalizeRegionName(s.sucursal) === region);
  }
  if (regions && regions.length > 0) {
    return sedesResumen.filter((s) => {
      const code = normalizeRegionName(s.sucursal);
      return Boolean(code && regions.includes(code));
    });
  }
  if (sucursal) {
    return sedesResumen.filter((s) => s.sucursal === sucursal);
  }
  return [...sedesResumen];
}

function filterVendedoresAuditoriaForScope(
  auditoria: VendedoresAuditSummary,
  filteredVendedores: ReadonlyArray<{ activo: boolean; sucursal?: SucursalMaestro | null }>,
  region: AllowedRegionCode | null,
  sucursal: SucursalMaestro | null,
  regions?: readonly AllowedRegionCode[] | null
): VendedoresAuditSummary {
  if (!region && !sucursal && (!regions || regions.length === 0)) {
    return auditoria;
  }
  const porSede: Record<SucursalMaestro, number> = {
    ZULIA: 0,
    VALENCIA: 0,
    CENTRO: 0,
    ORIENTE: 0,
    CAPITAL: 0,
  };
  let activos = 0;
  for (const v of filteredVendedores) {
    if (v.activo) activos += 1;
    if (v.sucursal && v.sucursal in porSede) {
      porSede[v.sucursal] += 1;
    }
  }
  return {
    ...auditoria,
    totalErpRaw: filteredVendedores.length,
    activosRealesUnicos: activos,
    rutasComercialesActivas: activos,
    porSede,
  };
}

/**
 * Resuelve y aplica aislamiento estricto multi-región / sede para consultas de Data Maestra:
 *  - Actores regionales mono-región (ej. Grecia -> ['OCCIDENTE']) o multi-región (ej. María -> ['CENTRO', 'ANDES']):
 *    jamás pueden consultar regiones fuera de su alcance asignado (HTTP 403).
 *  - Actores globales (`GLOBAL` / `super_admin`): respetan `?region=`, `?regions=`, `?sucursal=` o `ALL`/`TODAS`.
 */
export function resolveAuthorizedSucursalScope(
  actor: AuthenticatedServerUser,
  requestedQuerySucursal: unknown,
  requestedQueryRegion?: unknown,
  requestedQueryRegions?: unknown
):
  | {
      ok: true;
      sucursal: SucursalMaestro | null;
      region: AllowedRegionCode | null;
      regions: AllowedRegionCode[] | null;
    }
  | { ok: false; status: number; code: string; error: string } {
  const rawReq = String(requestedQuerySucursal ?? '').trim().toUpperCase();
  const rawRegionReq = String(requestedQueryRegion ?? '').trim().toUpperCase();

  const isGlobalActor = isGlobalMasterActor(actor);

  const requestedOperative =
    rawReq && rawReq !== 'ALL' && rawReq !== 'TODAS' && rawReq !== 'GLOBAL'
      ? normalizeServerSucursal(rawReq)
      : null;

  const requestedRegion =
    rawRegionReq &&
    rawRegionReq !== 'ALL' &&
    rawRegionReq !== 'TODAS' &&
    rawRegionReq !== 'GLOBAL' &&
    rawRegionReq !== 'ASSIGNED'
      ? normalizeRegionName(rawRegionReq)
      : rawReq === 'OCCIDENTE' || rawReq === 'ANDES' || rawReq === 'CENTRO'
        ? (rawReq as AllowedRegionCode)
        : null;

  const requestedRegions = parseOptionalRegionsParam(requestedQueryRegions);

  if (!isGlobalActor) {
    const actorRegions = resolveActorAllowedRegionsList(actor);
    if (actorRegions.length === 0 && (!actor.sucursal || !isOperativeServerSucursal(actor.sucursal))) {
      return {
        ok: false,
        status: 403,
        code: 'UNASSIGNED_SUCURSAL',
        error: 'Cuenta regional sin región asignada. Contacta al Administrador General.',
      };
    }

    if (requestedOperative) {
      const reqOpRegion = normalizeRegionName(requestedOperative);
      const sucursalAllowed =
        (reqOpRegion && actorRegions.includes(reqOpRegion)) ||
        (isOperativeServerSucursal(actor.sucursal) && requestedOperative === actor.sucursal);
      if (!sucursalAllowed) {
        return {
          ok: false,
          status: 403,
          code: 'FORBIDDEN_SUCURSAL_ACCESS',
          error: `Acceso denegado: tu cuenta (${actorRegions.join(', ') || actor.sucursal}) no puede consultar datos de ${requestedOperative}.`,
        };
      }
    }

    if (requestedRegion && !actorRegions.includes(requestedRegion)) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN_REGION_ACCESS',
        error: `Acceso denegado: tu cuenta (${actorRegions.join(', ')}) no puede consultar datos de ${requestedRegion}.`,
      };
    }

    if (requestedRegions) {
      const unauthorized = requestedRegions.filter((r) => !actorRegions.includes(r));
      if (unauthorized.length > 0) {
        return {
          ok: false,
          status: 403,
          code: 'FORBIDDEN_REGION_ACCESS',
          error: `Acceso denegado: tu cuenta (${actorRegions.join(', ')}) no puede consultar datos de ${unauthorized.join(', ')}.`,
        };
      }
      return {
        ok: true,
        sucursal: null,
        region: requestedRegions.length === 1 ? requestedRegions[0]! : null,
        regions: requestedRegions,
      };
    }

    if (requestedRegion) {
      return {
        ok: true,
        sucursal: null,
        region: requestedRegion,
        regions: [requestedRegion],
      };
    }

    if (actorRegions.length === 1) {
      return {
        ok: true,
        sucursal: isOperativeServerSucursal(actor.sucursal) ? actor.sucursal : null,
        region: actorRegions[0]!,
        regions: actorRegions,
      };
    }

    return {
      ok: true,
      sucursal: null,
      region: null,
      regions: actorRegions,
    };
  }

  if (requestedRegions) {
    return {
      ok: true,
      sucursal: null,
      region: requestedRegions.length === 1 ? requestedRegions[0]! : null,
      regions: requestedRegions,
    };
  }

  if (
    rawReq === 'ALL' ||
    rawReq === 'TODAS' ||
    rawReq === 'GLOBAL' ||
    rawRegionReq === 'ALL' ||
    rawRegionReq === 'TODAS' ||
    rawRegionReq === 'GLOBAL'
  ) {
    return { ok: true, sucursal: null, region: null, regions: null };
  }

  if (requestedRegion) {
    return { ok: true, sucursal: null, region: requestedRegion, regions: [requestedRegion] };
  }

  if (requestedOperative && isOperativeServerSucursal(requestedOperative)) {
    return {
      ok: true,
      sucursal: requestedOperative,
      region: null,
      regions: null,
    };
  }

  if (actor.activeSucursalHeader && isOperativeServerSucursal(actor.activeSucursalHeader)) {
    return {
      ok: true,
      sucursal: actor.activeSucursalHeader,
      region: null,
      regions: null,
    };
  }

  return { ok: true, sucursal: null, region: null, regions: null };
}

export function createMasterDataErpHandlers(
  gateway: MasterDataErpGateway = createDefaultMasterDataErpGateway()
) {
  const buildLoadOpts = (
    actor: AuthenticatedServerUser,
    forceRefresh: boolean
  ): MasterDataSnapshotLoadOptions => ({
    forceRefresh,
    accessToken: actor.accessToken,
    activeSucursalHeader: actor.activeSucursalHeader ?? null,
    userId: actor.id,
  });

  return {
    async handleBootstrapMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, false);
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));

        const isGlobal = isGlobalMasterActor(actor);
        const allRegiones = snap.regiones ?? [];
        const regionFilter = isGlobal
          ? (scope.region ?? parseOptionalRegionParam(req.query.region) ?? null)
          : scope.region;
        const regionsFilter = scope.regions ?? (regionFilter ? [regionFilter] : null);

        const authRegionId = resolveAuthorizedRegionIdFilter({
          actor,
          scopeRegion: regionFilter,
          scopeRegions: regionsFilter,
          rawRequestedRegionId: req.query.regionId,
          regiones: allRegiones,
        });
        if (!authRegionId.ok) {
          res.status(authRegionId.status).json({ error: authRegionId.error, code: authRegionId.code });
          return;
        }

        const regionIdFilter =
          authRegionId.regionId ??
          (regionFilter
            ? allRegiones.find((r) => normalizeRegionName(r.codigo) === regionFilter)?.id ?? null
            : null);

        // Aislamiento estricto: actores regionales solo reciben sus regiones autorizadas en `data.regiones` y métricas.
        const regiones = !isGlobal && regionsFilter && regionsFilter.length > 0
          ? allRegiones.filter((r) => {
              const code = normalizeRegionName(r.codigo);
              return Boolean(code && regionsFilter.includes(code));
            })
          : allRegiones;
        const productos = (snap.productos ?? []).filter((p) => !soloActivos || p.activo);

        const clientes = filterNormalizedErpClientes(snap.clientes, {
          soloActivos,
          sucursal: regionFilter || regionsFilter ? undefined : scope.sucursal,
          region: regionFilter ?? undefined,
          regions: regionsFilter ?? undefined,
          regionId: !regionFilter && !regionsFilter ? regionIdFilter ?? undefined : undefined,
        });
        const vendedores = filterNormalizedErpVendedores(snap.vendedores, {
          soloActivos: true,
          sucursal: regionFilter || regionsFilter ? undefined : scope.sucursal,
          region: regionFilter ?? undefined,
          regions: regionsFilter ?? undefined,
        });
        const supervisores = (snap.supervisores ?? []).filter(
          (s) =>
            (!soloActivos || s.activo) &&
            matchesEntityRegion(s, regionFilter, regionIdFilter, regionsFilter, authRegionId.allowedRegionIds)
        );
        const promotoras = (snap.promotoras ?? []).filter(
          (p) =>
            (!soloActivos || p.activo) &&
            matchesEntityRegion(p, regionFilter, regionIdFilter, regionsFilter, authRegionId.allowedRegionIds)
        );
        const cadenas = (snap.cadenas ?? []).filter(
          (c) =>
            (!soloActivos || c.activo) &&
            ((!regionFilter && !regionsFilter) ||
              !c.region_id ||
              matchesEntityRegion(c, regionFilter, regionIdFilter, regionsFilter, authRegionId.allowedRegionIds))
        );
        const zonas = (snap.zonas ?? []).filter(
          (z) =>
            (!soloActivos || z.activo) &&
            matchesEntityRegion(z, regionFilter, regionIdFilter, regionsFilter, authRegionId.allowedRegionIds)
        );

        const clientesActivos = clientes.filter((c) => c.activo);
        const clientesConGps = clientesActivos.filter(
          (c) => c.latitud !== null && c.longitud !== null
        ).length;

        const resumenRegionalScoped =
          !isGlobal && regionsFilter && regionsFilter.length > 0
            ? (snap.resumenRegional ?? []).filter((r) => regionsFilter.includes(r.region))
            : (snap.resumenRegional ?? []);
        const sedesResumenScoped = !isGlobal
          ? filterSedesResumenForRegion(snap.sedesResumen, regionFilter, scope.sucursal, regionsFilter)
          : snap.sedesResumen;
        const vendedoresAuditoriaScoped = !isGlobal
          ? filterVendedoresAuditoriaForScope(
              snap.vendedoresAuditoria,
              vendedores,
              regionFilter,
              scope.sucursal,
              regionsFilter
            )
          : snap.vendedoresAuditoria;

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? (regionsFilter && regionsFilter.length > 0 ? regionsFilter.join(',') : 'ALL'),
          regions: regionsFilter ?? undefined,
          sucursal: scope.sucursal ?? 'ALL',
          fetchedAtMs: snap.fetchedAtMs,
          counts: {
            regiones: regiones.length,
            productos: productos.length,
            clientesTotal: clientes.length,
            clientesActivos: clientesActivos.length,
            clientesConGps,
            promotoras: promotoras.length,
            supervisores: supervisores.length,
            cadenas: cadenas.length,
            zonas: zonas.length,
            vendedores: vendedores.length,
          },
          resumenRegional: resumenRegionalScoped,
          sedesResumen: sedesResumenScoped,
          vendedoresAuditoria: vendedoresAuditoriaScoped,
          data: {
            regiones,
            productos,
            clientes,
            promotoras,
            supervisores,
            cadenas,
            zonas,
            vendedores,
          },
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'bootstrap',
          'No se pudo cargar el paquete consolidado de Data Maestra desde Supabase.'
        );
      }
    },

    async handleListRegionesMaestras(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivas = parseBoolParam(req.query.soloActivas, false);
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));
        const isGlobal = isGlobalMasterActor(actor);
        const allowedRegions = scope.regions ?? (scope.region ? [scope.region] : null);
        const regiones = (snap.regiones ?? []).filter((r) => {
          if (soloActivas && !r.activo) return false;
          if (!isGlobal && allowedRegions && allowedRegions.length > 0) {
            const code = normalizeRegionName(r.codigo);
            return Boolean(code && allowedRegions.includes(code));
          }
          return true;
        });

        res.setHeader('Cache-Control', 'private, max-age=60');
        res.status(200).json({
          source: snap.source,
          total: regiones.length,
          data: regiones,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'regiones',
          'No se pudo consultar el catálogo oficial de regiones en Supabase.'
        );
      }
    },

    async handleListProductosMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, false);
        const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda : '';
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));

        const filtered = (snap.productos ?? []).filter((p) => {
          if (soloActivos && !p.activo) return false;
          if (
            busqueda &&
            !matchesTextQuery(
              `${p.codigo} ${p.nombre} ${p.marca ?? ''} ${p.categoria ?? ''}`,
              busqueda
            )
          ) {
            return false;
          }
          return true;
        });

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          total: filtered.length,
          data: filtered,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'productos',
          'No se pudo consultar el catálogo nacional de productos en Supabase.'
        );
      }
    },

    async handleListSupervisoresMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, false);
        const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda : '';
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));

        const isGlobal = isGlobalMasterActor(actor);
        const regionFilter = isGlobal
          ? (scope.region ?? parseOptionalRegionParam(req.query.region) ?? null)
          : scope.region;
        const regionsFilter = scope.regions ?? (regionFilter ? [regionFilter] : null);
        const authRegionId = resolveAuthorizedRegionIdFilter({
          actor,
          scopeRegion: regionFilter,
          scopeRegions: regionsFilter,
          rawRequestedRegionId: req.query.regionId,
          regiones: snap.regiones ?? [],
        });
        if (!authRegionId.ok) {
          res.status(authRegionId.status).json({ error: authRegionId.error, code: authRegionId.code });
          return;
        }
        const regionIdFilter = authRegionId.regionId;

        const filtered = (snap.supervisores ?? []).filter((s) => {
          if (soloActivos && !s.activo) return false;
          if (!matchesEntityRegion(s, regionFilter, regionIdFilter, regionsFilter, authRegionId.allowedRegionIds)) return false;
          if (busqueda && !matchesTextQuery(`${s.nombre} ${s.zona ?? ''} ${s.telefono ?? ''}`, busqueda)) {
            return false;
          }
          return true;
        });

        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
          total: filtered.length,
          data: filtered,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'supervisores',
          'No se pudo consultar el catálogo maestro de supervisores en Supabase.'
        );
      }
    },

    async handleListPromotorasMaestras(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivas = parseBoolParam(req.query.soloActivas, false);
        const categoriaRaw =
          typeof req.query.categoria === 'string' ? req.query.categoria.trim() : 'TODAS';
        const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda : '';
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));

        const isGlobal = isGlobalMasterActor(actor);
        const regionFilter = isGlobal
          ? (scope.region ?? parseOptionalRegionParam(req.query.region) ?? null)
          : scope.region;
        const regionsFilter = scope.regions ?? (regionFilter ? [regionFilter] : null);
        const authRegionId = resolveAuthorizedRegionIdFilter({
          actor,
          scopeRegion: regionFilter,
          scopeRegions: regionsFilter,
          rawRequestedRegionId: req.query.regionId,
          regiones: snap.regiones ?? [],
        });
        if (!authRegionId.ok) {
          res.status(authRegionId.status).json({ error: authRegionId.error, code: authRegionId.code });
          return;
        }
        const regionIdFilter = authRegionId.regionId;

        const filtered = (snap.promotoras ?? []).filter((p) => {
          if (soloActivas && !p.activo) return false;
          if (!matchesEntityRegion(p, regionFilter, regionIdFilter, regionsFilter, authRegionId.allowedRegionIds)) return false;
          if (categoriaRaw && categoriaRaw.toUpperCase() !== 'TODAS') {
            const cat = classifyPromotoraCategoriaOficial(p as unknown as Record<string, unknown>);
            if (cat.toUpperCase() !== categoriaRaw.toUpperCase()) return false;
          }
          if (
            busqueda &&
            !matchesTextQuery(
              `${p.nombre_completo} ${p.email ?? ''} ${p.direccion ?? ''} ${p.ciudad ?? ''} ${p.categoria ?? ''}`,
              busqueda
            )
          ) {
            return false;
          }
          return true;
        });

        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
          total: filtered.length,
          data: filtered,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'promotoras',
          'No se pudo consultar el catálogo maestro de promotoras en Supabase.'
        );
      }
    },

    async handleListCadenasComerciales(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, true);
        const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda : '';
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));
        const regionFilter = scope.region ?? parseOptionalRegionParam(req.query.region) ?? null;
        const regionsFilter = scope.regions ?? (regionFilter ? [regionFilter] : null);

        const filtered = (snap.cadenas ?? []).filter((c) => {
          if (soloActivos && !c.activo) return false;
          if (
            (regionFilter || regionsFilter) &&
            c.region_id &&
            !matchesEntityRegion(c, regionFilter, null, regionsFilter)
          ) {
            return false;
          }
          if (busqueda && !matchesTextQuery(`${c.codigo} ${c.nombre} ${c.tipo_canal}`, busqueda)) {
            return false;
          }
          return true;
        });

        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
          total: filtered.length,
          data: filtered,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'cadenas',
          'No se pudo consultar el catálogo de cadenas comerciales en Supabase.'
        );
      }
    },

    async handleListZonasComerciales(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, true);
        const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda : '';
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));
        const regionFilter = scope.region ?? parseOptionalRegionParam(req.query.region) ?? null;
        const regionsFilter = scope.regions ?? (regionFilter ? [regionFilter] : null);

        const filtered = (snap.zonas ?? []).filter((z) => {
          if (soloActivos && !z.activo) return false;
          if (!matchesEntityRegion(z, regionFilter, null, regionsFilter)) return false;
          if (
            busqueda &&
            !matchesTextQuery(`${z.codigo} ${z.nombre} ${z.ciudad ?? ''} ${z.estado ?? ''}`, busqueda)
          ) {
            return false;
          }
          return true;
        });

        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
          total: filtered.length,
          data: filtered,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'zonas',
          'No se pudo consultar el catálogo de zonas geográficas en Supabase.'
        );
      }
    },

    async handleListClientesMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));
        const isGlobal = isGlobalMasterActor(actor);
        const explicitRegion = isGlobal ? parseOptionalRegionParam(req.query.region) : null;
        const effectiveRegion = isGlobal
          ? (explicitRegion ?? (!scope.sucursal ? scope.region ?? undefined : undefined))
          : (scope.region ?? undefined);
        const effectiveRegions = scope.regions ?? (effectiveRegion ? [effectiveRegion] : null);

        const authRegionId = resolveAuthorizedRegionIdFilter({
          actor,
          scopeRegion: effectiveRegion ?? null,
          scopeRegions: effectiveRegions,
          rawRequestedRegionId: req.query.regionId,
          regiones: snap.regiones ?? [],
        });
        if (!authRegionId.ok) {
          res.status(authRegionId.status).json({ error: authRegionId.error, code: authRegionId.code });
          return;
        }

        const hasExplicitRegionIdQuery =
          typeof req.query.regionId === 'string' && req.query.regionId.trim().length > 0;
        const filtered = filterNormalizedErpClientes(snap.clientes, {
          soloActivos: parseBoolParam(req.query.soloActivos, true),
          sucursal: effectiveRegion || effectiveRegions ? undefined : scope.sucursal,
          region: effectiveRegion,
          regions: effectiveRegions ?? undefined,
          regionId:
            hasExplicitRegionIdQuery || (!effectiveRegion && !effectiveRegions)
              ? (authRegionId.regionId ?? undefined)
              : undefined,
          zona: typeof req.query.zona === 'string' ? req.query.zona : undefined,
          ruta: typeof req.query.ruta === 'string' ? req.query.ruta : undefined,
          vendedorId: typeof req.query.vendedorId === 'string' ? req.query.vendedorId : undefined,
          codigoVendedor:
            typeof req.query.codigoVendedor === 'string' ? req.query.codigoVendedor : undefined,
          canal: typeof req.query.canal === 'string' ? req.query.canal : undefined,
          busqueda: typeof req.query.busqueda === 'string' ? req.query.busqueda : undefined,
        });

        const conGps = filtered.filter((c) => c.activo && c.latitud !== null && c.longitud !== null).length;
        const sedesResumenScoped = isGlobal
          ? (scope.sucursal
              ? snap.sedesResumen.filter((s) => s.sucursal === scope.sucursal)
              : snap.sedesResumen)
          : filterSedesResumenForRegion(snap.sedesResumen, effectiveRegion ?? null, scope.sucursal, effectiveRegions);
        const resumenRegionalScoped =
          !isGlobal && effectiveRegions && effectiveRegions.length > 0
            ? (snap.resumenRegional ?? []).filter((r) => effectiveRegions.includes(r.region))
            : (snap.resumenRegional ?? []);

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region:
            effectiveRegion ??
            (effectiveRegions && effectiveRegions.length > 0 ? effectiveRegions.join(',') : 'ALL'),
          regions: effectiveRegions ?? undefined,
          sucursal: scope.sucursal ?? 'ALL',
          total: filtered.length,
          conGps,
          sedesResumen: sedesResumenScoped,
          resumenRegional: resumenRegionalScoped,
          data: filtered,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'clientes',
          'No se pudo consultar el catálogo maestro de clientes en Supabase.'
        );
      }
    },

    async handleListVendedoresMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));
        const isGlobal = isGlobalMasterActor(actor);
        const explicitRegion = isGlobal ? parseOptionalRegionParam(req.query.region) : null;
        const effectiveRegion = isGlobal
          ? (explicitRegion ?? (!scope.sucursal ? scope.region ?? undefined : undefined))
          : (scope.region ?? undefined);
        const effectiveRegions = scope.regions ?? (effectiveRegion ? [effectiveRegion] : null);

        const authRegionId = resolveAuthorizedRegionIdFilter({
          actor,
          scopeRegion: effectiveRegion ?? null,
          scopeRegions: effectiveRegions,
          rawRequestedRegionId: req.query.regionId,
          regiones: snap.regiones ?? [],
        });
        if (!authRegionId.ok) {
          res.status(authRegionId.status).json({ error: authRegionId.error, code: authRegionId.code });
          return;
        }

        const hasExplicitRegionIdQuery =
          typeof req.query.regionId === 'string' && req.query.regionId.trim().length > 0;
        const filtered = filterNormalizedErpVendedores(snap.vendedores, {
          soloActivos: parseBoolParam(req.query.soloActivos, true),
          sucursal: effectiveRegion || effectiveRegions ? undefined : scope.sucursal,
          region: effectiveRegion,
          regions: effectiveRegions ?? undefined,
          regionId:
            hasExplicitRegionIdQuery || (!effectiveRegion && !effectiveRegions)
              ? (authRegionId.regionId ?? undefined)
              : undefined,
          zona: typeof req.query.zona === 'string' ? req.query.zona : undefined,
          supervisor: typeof req.query.supervisor === 'string' ? req.query.supervisor : undefined,
          busqueda: typeof req.query.busqueda === 'string' ? req.query.busqueda : undefined,
        });

        const auditoriaScoped = !isGlobal
          ? filterVendedoresAuditoriaForScope(
              snap.vendedoresAuditoria,
              filtered,
              effectiveRegion ?? null,
              scope.sucursal,
              effectiveRegions
            )
          : snap.vendedoresAuditoria;

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region:
            effectiveRegion ??
            (effectiveRegions && effectiveRegions.length > 0 ? effectiveRegions.join(',') : 'ALL'),
          regions: effectiveRegions ?? undefined,
          sucursal: scope.sucursal ?? 'ALL',
          total: filtered.length,
          auditoria: auditoriaScoped,
          data: filtered,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'vendedores',
          'No se pudo consultar el catálogo maestro de vendedores en Supabase.'
        );
      }
    },

    async handleGetSedesClientesResumen(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(
        actor,
        req.query.sucursal,
        req.query.region,
        req.query.regions
      );
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const snap = await gateway.loadSnapshot(buildLoadOpts(actor, forceRefresh));
        const isGlobal = isGlobalMasterActor(actor);
        const effectiveRegions = scope.regions ?? (scope.region ? [scope.region] : null);
        const resumen = !isGlobal
          ? filterSedesResumenForRegion(snap.sedesResumen, scope.region, scope.sucursal, effectiveRegions)
          : scope.sucursal
            ? snap.sedesResumen.filter((s) => s.sucursal === scope.sucursal)
            : snap.sedesResumen;
        const regionesResumen =
          effectiveRegions && effectiveRegions.length > 0
            ? (snap.resumenRegional ?? []).filter((r) => effectiveRegions.includes(r.region))
            : (snap.resumenRegional ?? []);
        const totalActivos = resumen.reduce((acc, s) => acc + s.activos, 0);
        const totalClientes = resumen.reduce((acc, s) => acc + s.total, 0);
        const scopedCounts = isGlobal
          ? snap.countsExact
          : {
              ...snap.countsExact,
              clientesTotal: totalClientes,
              clientesActivos: totalActivos,
              regiones: regionesResumen.length,
            };

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: scope.region ?? 'ALL',
          sucursal: scope.sucursal ?? 'ALL',
          sedes: resumen,
          regiones: regionesResumen,
          counts: scopedCounts,
          totalActivos,
          totalClientes,
        });
      } catch (err) {
        sendMasterDataErrorResponse(
          res,
          err,
          'resumen',
          'No se pudo consultar el resumen de clientes por región en Supabase.'
        );
      }
    },
  };
}

export const defaultMasterDataErpHandlers = createMasterDataErpHandlers();
