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
  getAdminSupabaseClient,
  isOperativeServerSucursal,
  normalizeServerSucursal,
  type AuthenticatedServerUser,
} from './supabaseAdminAuth';

const ERP_PAGE_SIZE = 1000;
const DEFAULT_ERP_CACHE_TTL_MS = 60_000;

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

export interface MasterDataErpGateway {
  loadSnapshot(options?: { forceRefresh?: boolean }): Promise<MasterDataErpSnapshot>;
}

let cachedSnapshot: MasterDataErpSnapshot | null = null;
let inflightSnapshotPromise: Promise<MasterDataErpSnapshot> | null = null;

export function invalidateMasterDataErpServerCache(): void {
  cachedSnapshot = null;
}

async function fetchAllTablePages<T>(
  client: SupabaseClient,
  tableName: string,
  selectExpr = '*'
): Promise<{ rows: T[]; exactCount: number }> {
  const rows: T[] = [];
  let exactCount: number | null = null;

  for (let from = 0; ; from += ERP_PAGE_SIZE) {
    const { data, error, count } = await client
      .from(tableName)
      .select(selectExpr, { count: 'exact' })
      .range(from, from + ERP_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Error consultando tabla ERP "${tableName}": ${error.message}`);
    }
    if (typeof count === 'number' && exactCount === null) {
      exactCount = count;
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
  selectExpr = '*'
): Promise<{ rows: T[]; exactCount: number }> {
  try {
    return await fetchAllTablePages<T>(client, tableName, selectExpr);
  } catch {
    return { rows: [], exactCount: 0 };
  }
}

/**
 * Carga y normaliza TODAS las entidades maestras de CODIZULCA desde Supabase
 * paginando automáticamente en bloques de 1,000 filas (`count: 'exact'`) sin truncamiento:
 * `"Regiones"`, `"Productos"`, `"vw_productos_detalle"`, `"Clientes"`, `promotoras`,
 * `"Supervisores"`, `"Vendedores"`, `"Forecast_Vendedores_Excluidos"`, `"Sucursales"`,
 * `"Estados"`, `"Municipios"`, `"Tipificacion_Clientes"` y `"Canal_Comercializacion"`.
 *
 * SEGURIDAD:
 *  - Se ejecuta exclusivamente en servidor usando `getAdminSupabaseClient()`
 *    (llave `SUPABASE_SERVICE_ROLE_KEY` jamás expuesta al navegador).
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
    fetchAllTablePages<ErpRegionRow>(client, 'Regiones', 'id_regi,created_at,regi_desd,regi_saba'),
    fetchOptionalTablePages<ErpSucursalRow>(client, 'Sucursales', 'id_sucu,created_at,sucu_desc,id_regi'),
    fetchOptionalTablePages<ErpEstadoRow>(client, 'Estados', 'id_esta,created_at,esta_desc,id_regi'),
    fetchOptionalTablePages<ErpMunicipioRow>(client, 'Municipios', 'id_muni,created_at,muni_desc,id_esta,id_regi'),
    fetchOptionalTablePages<ErpSupervisorRow>(client, 'Supervisores', 'id_supe,created_at,supe_nomb,supe_acti,id_regi,supe_cont'),
    fetchAllTablePages<ErpVendedorRow>(client, 'Vendedores', 'id_vend,created_at,vend_codi,vend_nomb,vend_acti,id_sucu,id_supe,vend_cont'),
    fetchOptionalTablePages<ErpForecastExcludedVendedoresRow>(
      client,
      'Forecast_Vendedores_Excluidos',
      'id_fove,id_regi,fove_vend,updated_at'
    ),
    fetchOptionalTablePages<ErpTipificacionRow>(client, 'Tipificacion_Clientes', 'id_tipi,created_at,tipi_desc,id_cave'),
    fetchOptionalTablePages<ErpCanalComercializacionRow>(
      client,
      'Canal_Comercializacion',
      'id_cana,created_at,cana_desc'
    ),
    fetchAllTablePages<ErpClienteRow>(
      client,
      'Clientes',
      'id_clie,created_at,clie_rif,clie_nomb,id_esta,id_vend,id_muni,clie_regi,clie_acti,clie_lati,clie_long,id_tipi,id_clie_prin'
    ),
    fetchOptionalTablePages<ErpProductoRow>(
      client,
      'Productos',
      'id_prod,created_at,prod_codi,prod_desc,prod_unid,prod_acti'
    ),
    fetchOptionalTablePages<ErpVwProductoDetalleRow>(
      client,
      'vw_productos_detalle',
      'id_prod,codigo,producto,orden,activo,marca,marca_propia,familia,grupo,regiones,n_regiones,created_at'
    ),
    fetchOptionalTablePages<ErpPromotoraRow>(client, 'promotoras', '*'),
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
    async loadSnapshot(options = {}): Promise<MasterDataErpSnapshot> {
      const now = Date.now();
      if (
        !options.forceRefresh &&
        cachedSnapshot &&
        now - cachedSnapshot.fetchedAtMs < cacheTtlMs
      ) {
        return cachedSnapshot;
      }

      if (inflightSnapshotPromise && !options.forceRefresh) {
        return inflightSnapshotPromise;
      }

      const adminClient = getAdminSupabaseClient();
      if (!adminClient) {
        throw new Error(
          'Falta configurar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el servidor para consultar Data Maestra ERP.'
        );
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
      return promise;
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
  regionId: string | null
): boolean {
  if (regionId) {
    if (item.region_id === regionId) return true;
    if (!region) return false;
  }
  if (!region) return true;
  const itemRegion =
    normalizeRegionName(item.metadata?.region_codigo) ?? normalizeRegionName(item.sucursal);
  return itemRegion === region;
}

/**
 * Resuelve y aplica aislamiento estricto de sede/región para consultas de Data Maestra:
 *  - Actores regionales (`OCCIDENTE`, `CENTRO`, `ANDES` o alias legado `ZULIA`/`VALENCIA`):
 *    jamás pueden consultar otra sede/región (devuelve error 403).
 *  - Actores globales (`GLOBAL` / `super_admin`): respetan `?region=` o `?sucursal=` o
 *    cabecera `x-region-activa` / `x-sucursal-activa`, o devuelven todas si se envía `ALL`/`TODAS`.
 */
export function resolveAuthorizedSucursalScope(
  actor: AuthenticatedServerUser,
  requestedQuerySucursal: unknown,
  requestedQueryRegion?: unknown
):
  | { ok: true; sucursal: SucursalMaestro | null; region: AllowedRegionCode | null }
  | { ok: false; status: number; code: string; error: string } {
  const rawReq = String(requestedQuerySucursal ?? '').trim().toUpperCase();
  const rawRegionReq = String(requestedQueryRegion ?? '').trim().toUpperCase();

  const isGlobalActor =
    actor.isSuperAdmin === true ||
    actor.sucursal === 'GLOBAL' ||
    actor.appRole === 'super_admin' ||
    actor.appRole === 'superadmin';

  const requestedOperative =
    rawReq && rawReq !== 'ALL' && rawReq !== 'TODAS' && rawReq !== 'GLOBAL'
      ? normalizeServerSucursal(rawReq)
      : null;

  const requestedRegion =
    rawRegionReq && rawRegionReq !== 'ALL' && rawRegionReq !== 'TODAS' && rawRegionReq !== 'GLOBAL'
      ? normalizeRegionName(rawRegionReq)
      : rawReq === 'OCCIDENTE' || rawReq === 'ANDES'
        ? (rawReq as AllowedRegionCode)
        : null;

  if (!isGlobalActor) {
    const actorRegion = normalizeRegionName(actor.sucursal);
    if (!actor.sucursal || (!isOperativeServerSucursal(actor.sucursal) && !actorRegion)) {
      return {
        ok: false,
        status: 403,
        code: 'UNASSIGNED_SUCURSAL',
        error: 'Cuenta regional sin región asignada. Contacta al Administrador General.',
      };
    }

    if (requestedOperative && isOperativeServerSucursal(actor.sucursal) && requestedOperative !== actor.sucursal) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN_SUCURSAL_ACCESS',
        error: `Acceso denegado: tu cuenta de ${actor.sucursal} no puede consultar datos de ${requestedOperative}.`,
      };
    }

    if (requestedRegion && actorRegion && requestedRegion !== actorRegion) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN_REGION_ACCESS',
        error: `Acceso denegado: tu cuenta de ${actorRegion} no puede consultar datos de ${requestedRegion}.`,
      };
    }

    return {
      ok: true,
      sucursal: isOperativeServerSucursal(actor.sucursal) ? actor.sucursal : null,
      region: actorRegion,
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
    return { ok: true, sucursal: null, region: null };
  }

  if (requestedRegion) {
    return { ok: true, sucursal: null, region: requestedRegion };
  }

  if (requestedOperative && isOperativeServerSucursal(requestedOperative)) {
    return {
      ok: true,
      sucursal: requestedOperative,
      region: null,
    };
  }

  if (actor.activeSucursalHeader && isOperativeServerSucursal(actor.activeSucursalHeader)) {
    return {
      ok: true,
      sucursal: actor.activeSucursalHeader,
      region: null,
    };
  }

  return { ok: true, sucursal: null, region: null };
}

export function createMasterDataErpHandlers(
  gateway: MasterDataErpGateway = createDefaultMasterDataErpGateway()
) {
  return {
    async handleBootstrapMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal, req.query.region);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, false);
        const snap = await gateway.loadSnapshot({ forceRefresh });

        const regiones = snap.regiones ?? [];
        const productos = (snap.productos ?? []).filter((p) => !soloActivos || p.activo);
        const regionFilter = scope.region ?? parseOptionalRegionParam(req.query.region) ?? null;
        const regionIdFilter =
          typeof req.query.regionId === 'string' && req.query.regionId.trim()
            ? req.query.regionId.trim()
            : regionFilter
              ? regiones.find((r) => r.codigo === regionFilter)?.id ?? null
              : null;

        const clientes = filterNormalizedErpClientes(snap.clientes, {
          soloActivos,
          sucursal: regionFilter ? undefined : scope.sucursal,
          region: regionFilter ?? undefined,
          regionId: !regionFilter ? regionIdFilter ?? undefined : undefined,
        });
        const vendedores = filterNormalizedErpVendedores(snap.vendedores, {
          soloActivos: true,
          sucursal: regionFilter ? undefined : scope.sucursal,
          region: regionFilter ?? undefined,
        });
        const supervisores = (snap.supervisores ?? []).filter(
          (s) => (!soloActivos || s.activo) && matchesEntityRegion(s, regionFilter, regionIdFilter)
        );
        const promotoras = (snap.promotoras ?? []).filter(
          (p) => (!soloActivos || p.activo) && matchesEntityRegion(p, regionFilter, regionIdFilter)
        );
        const cadenas = (snap.cadenas ?? []).filter(
          (c) =>
            (!soloActivos || c.activo) &&
            (!regionFilter ||
              !c.region_id ||
              matchesEntityRegion(c, regionFilter, regionIdFilter))
        );
        const zonas = (snap.zonas ?? []).filter(
          (z) => (!soloActivos || z.activo) && matchesEntityRegion(z, regionFilter, regionIdFilter)
        );

        const clientesActivos = clientes.filter((c) => c.activo);
        const clientesConGps = clientesActivos.filter(
          (c) => c.latitud !== null && c.longitud !== null
        ).length;

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
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
          resumenRegional: snap.resumenRegional ?? [],
          sedesResumen: snap.sedesResumen,
          vendedoresAuditoria: snap.vendedoresAuditoria,
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
      } catch {
        res.status(503).json({
          error: 'No se pudo cargar el paquete consolidado de Data Maestra desde Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },

    async handleListRegionesMaestras(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivas = parseBoolParam(req.query.soloActivas, false);
        const snap = await gateway.loadSnapshot({ forceRefresh });
        const regiones = (snap.regiones ?? []).filter((r) => !soloActivas || r.activo);

        res.setHeader('Cache-Control', 'private, max-age=60');
        res.status(200).json({
          source: snap.source,
          total: regiones.length,
          data: regiones,
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el catálogo oficial de regiones en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
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
        const snap = await gateway.loadSnapshot({ forceRefresh });

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
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el catálogo nacional de productos en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },

    async handleListSupervisoresMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal, req.query.region);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, false);
        const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda : '';
        const snap = await gateway.loadSnapshot({ forceRefresh });

        const regionFilter = scope.region ?? parseOptionalRegionParam(req.query.region) ?? null;
        const regionIdFilter =
          typeof req.query.regionId === 'string' && req.query.regionId.trim()
            ? req.query.regionId.trim()
            : null;

        const filtered = (snap.supervisores ?? []).filter((s) => {
          if (soloActivos && !s.activo) return false;
          if (!matchesEntityRegion(s, regionFilter, regionIdFilter)) return false;
          if (busqueda && !matchesTextQuery(`${s.nombre} ${s.zona ?? ''} ${s.telefono ?? ''}`, busqueda)) {
            return false;
          }
          return true;
        });

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
          total: filtered.length,
          data: filtered,
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el catálogo maestro de supervisores en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },

    async handleListPromotorasMaestras(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal, req.query.region);
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
        const snap = await gateway.loadSnapshot({ forceRefresh });

        const regionFilter = scope.region ?? parseOptionalRegionParam(req.query.region) ?? null;
        const regionIdFilter =
          typeof req.query.regionId === 'string' && req.query.regionId.trim()
            ? req.query.regionId.trim()
            : null;

        const filtered = (snap.promotoras ?? []).filter((p) => {
          if (soloActivas && !p.activo) return false;
          if (!matchesEntityRegion(p, regionFilter, regionIdFilter)) return false;
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

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
          total: filtered.length,
          data: filtered,
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el catálogo maestro de promotoras en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },

    async handleListCadenasComerciales(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal, req.query.region);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, true);
        const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda : '';
        const snap = await gateway.loadSnapshot({ forceRefresh });
        const regionFilter = scope.region ?? parseOptionalRegionParam(req.query.region) ?? null;

        const filtered = (snap.cadenas ?? []).filter((c) => {
          if (soloActivos && !c.activo) return false;
          if (regionFilter && c.region_id && !matchesEntityRegion(c, regionFilter, null)) {
            return false;
          }
          if (busqueda && !matchesTextQuery(`${c.codigo} ${c.nombre} ${c.tipo_canal}`, busqueda)) {
            return false;
          }
          return true;
        });

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
          total: filtered.length,
          data: filtered,
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el catálogo de cadenas comerciales en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },

    async handleListZonasComerciales(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal, req.query.region);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const soloActivos = parseBoolParam(req.query.soloActivos, true);
        const busqueda = typeof req.query.busqueda === 'string' ? req.query.busqueda : '';
        const snap = await gateway.loadSnapshot({ forceRefresh });
        const regionFilter = scope.region ?? parseOptionalRegionParam(req.query.region) ?? null;

        const filtered = (snap.zonas ?? []).filter((z) => {
          if (soloActivos && !z.activo) return false;
          if (!matchesEntityRegion(z, regionFilter, null)) return false;
          if (
            busqueda &&
            !matchesTextQuery(`${z.codigo} ${z.nombre} ${z.ciudad ?? ''} ${z.estado ?? ''}`, busqueda)
          ) {
            return false;
          }
          return true;
        });

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: regionFilter ?? 'ALL',
          total: filtered.length,
          data: filtered,
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el catálogo de zonas geográficas en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },

    async handleListClientesMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal, req.query.region);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const snap = await gateway.loadSnapshot({ forceRefresh });
        const explicitRegion = parseOptionalRegionParam(req.query.region);

        const filtered = filterNormalizedErpClientes(snap.clientes, {
          soloActivos: parseBoolParam(req.query.soloActivos, true),
          sucursal: explicitRegion ? undefined : scope.sucursal,
          region: explicitRegion ?? (!scope.sucursal ? scope.region ?? undefined : undefined),
          regionId: typeof req.query.regionId === 'string' ? req.query.regionId : undefined,
          zona: typeof req.query.zona === 'string' ? req.query.zona : undefined,
          ruta: typeof req.query.ruta === 'string' ? req.query.ruta : undefined,
          vendedorId: typeof req.query.vendedorId === 'string' ? req.query.vendedorId : undefined,
          codigoVendedor:
            typeof req.query.codigoVendedor === 'string' ? req.query.codigoVendedor : undefined,
          canal: typeof req.query.canal === 'string' ? req.query.canal : undefined,
          busqueda: typeof req.query.busqueda === 'string' ? req.query.busqueda : undefined,
        });

        const conGps = filtered.filter((c) => c.activo && c.latitud !== null && c.longitud !== null).length;

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: explicitRegion ?? scope.region ?? 'ALL',
          sucursal: scope.sucursal ?? 'ALL',
          total: filtered.length,
          conGps,
          sedesResumen: scope.sucursal
            ? snap.sedesResumen.filter((s) => s.sucursal === scope.sucursal)
            : snap.sedesResumen,
          resumenRegional: snap.resumenRegional ?? [],
          data: filtered,
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el catálogo maestro de clientes en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },

    async handleListVendedoresMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal, req.query.region);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const snap = await gateway.loadSnapshot({ forceRefresh });
        const explicitRegion = parseOptionalRegionParam(req.query.region);

        const filtered = filterNormalizedErpVendedores(snap.vendedores, {
          soloActivos: parseBoolParam(req.query.soloActivos, true),
          sucursal: explicitRegion ? undefined : scope.sucursal,
          region: explicitRegion ?? (!scope.sucursal ? scope.region ?? undefined : undefined),
          regionId: typeof req.query.regionId === 'string' ? req.query.regionId : undefined,
          zona: typeof req.query.zona === 'string' ? req.query.zona : undefined,
          supervisor: typeof req.query.supervisor === 'string' ? req.query.supervisor : undefined,
          busqueda: typeof req.query.busqueda === 'string' ? req.query.busqueda : undefined,
        });

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: explicitRegion ?? scope.region ?? 'ALL',
          sucursal: scope.sucursal ?? 'ALL',
          total: filtered.length,
          auditoria: snap.vendedoresAuditoria,
          data: filtered,
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el catálogo maestro de vendedores en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },

    async handleGetSedesClientesResumen(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal, req.query.region);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const snap = await gateway.loadSnapshot({ forceRefresh });
        const resumen = scope.sucursal
          ? snap.sedesResumen.filter((s) => s.sucursal === scope.sucursal)
          : snap.sedesResumen;
        const regionesResumen = scope.region
          ? (snap.resumenRegional ?? []).filter((r) => r.region === scope.region)
          : (snap.resumenRegional ?? []);

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          region: scope.region ?? 'ALL',
          sucursal: scope.sucursal ?? 'ALL',
          sedes: resumen,
          regiones: regionesResumen,
          counts: snap.countsExact,
          totalActivos: resumen.reduce((acc, s) => acc + s.activos, 0),
          totalClientes: resumen.reduce((acc, s) => acc + s.total, 0),
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el resumen de clientes por región en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },
  };
}

export const defaultMasterDataErpHandlers = createMasterDataErpHandlers();
