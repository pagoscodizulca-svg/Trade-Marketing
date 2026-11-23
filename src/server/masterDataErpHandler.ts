import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeClientesSummaryBySede,
  filterNormalizedErpClientes,
  filterNormalizedErpVendedores,
  normalizeErpClientesDataset,
  normalizeErpVendedoresDataset,
  type ErpClienteRow,
  type ErpEstadoRow,
  type ErpMasterDataset,
  type ErpMunicipioRow,
  type ErpRegionRow,
  type ErpSucursalRow,
  type ErpSupervisorRow,
  type ErpTipificacionRow,
  type ErpVendedorRow,
  type SedeClientCountSummary,
} from '../utils/erpMasterAdapter';
import type {
  AllowedRegionCode,
  ClienteConVendedor,
  SucursalMaestro,
  Vendedor,
} from '../types/masterData';
import {
  getAdminSupabaseClient,
  isOperativeServerSucursal,
  normalizeServerSucursal,
  type AuthenticatedServerUser,
} from './supabaseAdminAuth';

const ERP_PAGE_SIZE = 1000;
const DEFAULT_ERP_CACHE_TTL_MS = 60_000;

export interface MasterDataErpSnapshot {
  clientes: ClienteConVendedor[];
  vendedores: Vendedor[];
  sedesResumen: SedeClientCountSummary[];
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
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += ERP_PAGE_SIZE) {
    const { data, error } = await client
      .from(tableName)
      .select(selectExpr)
      .range(from, from + ERP_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Error consultando tabla ERP "${tableName}": ${error.message}`);
    }
    const page = Array.isArray(data) ? (data as T[]) : [];
    rows.push(...page);
    if (page.length < ERP_PAGE_SIZE) {
      break;
    }
  }
  return rows;
}

async function fetchOptionalTablePages<T>(
  client: SupabaseClient,
  tableName: string,
  selectExpr = '*'
): Promise<T[]> {
  try {
    return await fetchAllTablePages<T>(client, tableName, selectExpr);
  } catch {
    return [];
  }
}

/**
 * Carga y normaliza todas las tablas ERP maestras de Codizulca en Supabase:
 * `"Regiones"`, `"Sucursales"`, `"Estados"`, `"Municipios"`, `"Supervisores"`,
 * `"Vendedores"`, `"Tipificacion_Clientes"` y `"Clientes"`.
 *
 * SEGURIDAD:
 *  - Se ejecuta exclusivamente en servidor usando `getAdminSupabaseClient()`
 *    (llave `SUPABASE_SERVICE_ROLE_KEY` jamás expuesta al navegador).
 *  - Los handlers siempre filtran por sede autorizada antes de serializar la respuesta.
 */
export async function loadErpMasterSnapshotFromClient(
  client: SupabaseClient
): Promise<MasterDataErpSnapshot> {
  const [
    regiones,
    sucursales,
    estados,
    municipios,
    supervisores,
    vendedoresRaw,
    tipificaciones,
    clientesRaw,
  ] = await Promise.all([
    fetchAllTablePages<ErpRegionRow>(client, 'Regiones', 'id_regi,created_at,regi_desd,regi_saba'),
    fetchOptionalTablePages<ErpSucursalRow>(client, 'Sucursales', 'id_sucu,created_at,sucu_desc,id_regi'),
    fetchOptionalTablePages<ErpEstadoRow>(client, 'Estados', 'id_esta,created_at,esta_desc,id_regi'),
    fetchOptionalTablePages<ErpMunicipioRow>(client, 'Municipios', 'id_muni,created_at,muni_desc,id_esta,id_regi'),
    fetchOptionalTablePages<ErpSupervisorRow>(client, 'Supervisores', 'id_supe,created_at,supe_nomb,supe_acti,id_regi,supe_cont'),
    fetchAllTablePages<ErpVendedorRow>(client, 'Vendedores', 'id_vend,created_at,vend_codi,vend_nomb,vend_acti,id_sucu,id_supe,vend_cont'),
    fetchOptionalTablePages<ErpTipificacionRow>(client, 'Tipificacion_Clientes', 'id_tipi,created_at,tipi_desc,id_cave'),
    fetchAllTablePages<ErpClienteRow>(
      client,
      'Clientes',
      'id_clie,created_at,clie_rif,clie_nomb,id_esta,id_vend,id_muni,clie_regi,clie_acti,clie_lati,clie_long,id_tipi'
    ),
  ]);

  const dataset: ErpMasterDataset = {
    regiones,
    sucursales,
    estados,
    municipios,
    supervisores,
    vendedores: vendedoresRaw,
    tipificaciones,
    clientes: clientesRaw,
  };

  const vendedores = normalizeErpVendedoresDataset(dataset);
  const clientes = normalizeErpClientesDataset(dataset);
  const sedesResumen = computeClientesSummaryBySede(clientes);

  return {
    clientes,
    vendedores,
    sedesResumen,
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
  const clean = String(raw ?? '').trim().toUpperCase();
  if (clean === 'OCCIDENTE' || clean === 'CENTRO' || clean === 'ANDES') {
    return clean;
  }
  return undefined;
}

function parseBoolParam(raw: unknown, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const s = String(raw).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no') return false;
  if (s === 'true' || s === '1' || s === 'si') return true;
  return defaultValue;
}

/**
 * Resuelve y aplica aislamiento estricto de sede para consultas de Data Maestra:
 *  - Actores regionales (`sucursal` en `ZULIA|VALENCIA|CENTRO|ORIENTE|CAPITAL`): jamás pueden
 *    consultar otra sede (devuelve error 403 `FORBIDDEN_SUCURSAL_ACCESS` si solicitan otra).
 *  - Actores globales (`GLOBAL` / `super_admin`): respetan `?sucursal=` o `x-sucursal-activa`
 *    (o `null` para todas las sedes si se envía `?sucursal=ALL` o no se especifica sede).
 */
export function resolveAuthorizedSucursalScope(
  actor: AuthenticatedServerUser,
  requestedQuerySucursal: unknown
): { ok: true; sucursal: SucursalMaestro | null } | { ok: false; status: number; code: string; error: string } {
  const rawReq = String(requestedQuerySucursal ?? '').trim().toUpperCase();
  const requestedOperative =
    rawReq && rawReq !== 'ALL' && rawReq !== 'TODAS' && rawReq !== 'GLOBAL'
      ? normalizeServerSucursal(rawReq)
      : null;

  const isGlobalActor =
    actor.isSuperAdmin === true ||
    actor.sucursal === 'GLOBAL' ||
    actor.appRole === 'super_admin' ||
    actor.appRole === 'superadmin';

  if (!isGlobalActor) {
    if (!actor.sucursal || !isOperativeServerSucursal(actor.sucursal)) {
      return {
        ok: false,
        status: 403,
        code: 'UNASSIGNED_SUCURSAL',
        error: 'Cuenta regional sin sucursal asignada. Contacta al Administrador General.',
      };
    }

    if (requestedOperative && requestedOperative !== actor.sucursal) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN_SUCURSAL_ACCESS',
        error: `Acceso denegado: tu cuenta de ${actor.sucursal} no puede consultar clientes de ${requestedOperative}.`,
      };
    }

    return { ok: true, sucursal: actor.sucursal };
  }

  if (rawReq === 'ALL' || rawReq === 'TODAS' || rawReq === 'GLOBAL') {
    return { ok: true, sucursal: null };
  }

  if (requestedOperative && isOperativeServerSucursal(requestedOperative)) {
    return { ok: true, sucursal: requestedOperative };
  }

  if (actor.activeSucursalHeader && isOperativeServerSucursal(actor.activeSucursalHeader)) {
    return { ok: true, sucursal: actor.activeSucursalHeader };
  }

  return { ok: true, sucursal: null };
}

export function createMasterDataErpHandlers(
  gateway: MasterDataErpGateway = createDefaultMasterDataErpGateway()
) {
  return {
    async handleListClientesMaestros(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const snap = await gateway.loadSnapshot({ forceRefresh });

        const filtered = filterNormalizedErpClientes(snap.clientes, {
          soloActivos: parseBoolParam(req.query.soloActivos, true),
          sucursal: scope.sucursal,
          region: parseOptionalRegionParam(req.query.region),
          regionId: typeof req.query.regionId === 'string' ? req.query.regionId : undefined,
          zona: typeof req.query.zona === 'string' ? req.query.zona : undefined,
          ruta: typeof req.query.ruta === 'string' ? req.query.ruta : undefined,
          vendedorId: typeof req.query.vendedorId === 'string' ? req.query.vendedorId : undefined,
          codigoVendedor:
            typeof req.query.codigoVendedor === 'string' ? req.query.codigoVendedor : undefined,
          canal: typeof req.query.canal === 'string' ? req.query.canal : undefined,
          busqueda: typeof req.query.busqueda === 'string' ? req.query.busqueda : undefined,
        });

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          sucursal: scope.sucursal ?? 'ALL',
          total: filtered.length,
          sedesResumen: scope.sucursal
            ? snap.sedesResumen.filter((s) => s.sucursal === scope.sucursal)
            : snap.sedesResumen,
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

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal);
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error, code: scope.code });
        return;
      }

      try {
        const forceRefresh = parseBoolParam(req.query.forzarRefresco, false);
        const snap = await gateway.loadSnapshot({ forceRefresh });

        const filtered = filterNormalizedErpVendedores(snap.vendedores, {
          soloActivos: parseBoolParam(req.query.soloActivos, true),
          sucursal: scope.sucursal,
          zona: typeof req.query.zona === 'string' ? req.query.zona : undefined,
          supervisor: typeof req.query.supervisor === 'string' ? req.query.supervisor : undefined,
          busqueda: typeof req.query.busqueda === 'string' ? req.query.busqueda : undefined,
        });

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          sucursal: scope.sucursal ?? 'ALL',
          total: filtered.length,
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

      const scope = resolveAuthorizedSucursalScope(actor, req.query.sucursal);
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

        res.setHeader('Cache-Control', 'private, max-age=30');
        res.status(200).json({
          source: snap.source,
          sucursal: scope.sucursal ?? 'ALL',
          sedes: resumen,
          totalActivos: resumen.reduce((acc, s) => acc + s.activos, 0),
          totalClientes: resumen.reduce((acc, s) => acc + s.total, 0),
        });
      } catch {
        res.status(503).json({
          error: 'No se pudo consultar el resumen de clientes por sede en Supabase.',
          code: 'MASTER_DATA_UPSTREAM_ERROR',
        });
      }
    },
  };
}

export const defaultMasterDataErpHandlers = createMasterDataErpHandlers();
