/**
 * Servicio unificado de sincronización directa BD <-> Pantallas para las
 * entidades maestras existentes en `https://apaxdgxtaoeyswlfblgi.supabase.co`:
 *   - `public.regiones`
 *   - `public.productos` (Catálogo Único Nacional Compartido)
 *   - `public.supervisores`
 *   - `public.promotoras`
 *   - Reclasificación de cuarentena (`region_id = NULL`) sobre `clientes`, `promotoras` y `supervisores`
 *
 * SEGURIDAD ZERO-TRUST:
 *   - Jamás utiliza llaves secretas (`service_role`).
 *   - Todas las lecturas/escrituras se ejecutan con el JWT del usuario autenticado bajo RLS.
 *   - Los normalizadores son defensivos y se adaptan a columnas existentes en producción
 *     sin requerir tablas nuevas.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ProductoMaestro,
  ProductoMaestroInput,
  PromotoraMaestra,
  PromotoraMaestraInput,
  RegionMaestra,
  RegionMaestraInput,
  SucursalMaestro,
  SupervisorMaestro,
  SupervisorMaestroInput,
} from '../types/masterData';
import {
  getActiveClientSucursalHeader,
  getAuthenticatedSessionToken,
  getSupabaseClient,
  isSupabaseConfigured,
  registerSupabaseSessionResetCallback,
} from './supabaseClient';
import { executeWithSessionRefreshRetry } from './masterCatalogsService';
import { isOperativeSucursal, normalizeSucursalCodigo } from './userManagementService';
import {
  invalidarCacheMaestros,
  limpiarCeldaTexto,
  normalizarCodigoMaestro,
  normalizarTelefonoMaestro,
} from './masterDataSyncService';
import { registerMemoryCachePurgeCallback } from './sessionCacheHygiene';
import {
  PromotoraCategoriaFilterSchema,
  PromotoraCategoriaStrictSchema,
  classifyPromotoraCategoriaOficial,
  formatPromotoraRoleForCategory,
  normalizeRegionName,
  type PromotoraCategoriaOficial,
} from '../utils/regionalSyncClassifier';
import {
  normalizeErpProductosDataset,
  normalizeErpPromotorasDataset,
  normalizeErpRegionesDataset,
  normalizeErpSupervisoresDataset,
  type ErpProductoRow,
  type ErpPromotoraRow,
  type ErpRegionRow,
  type ErpSupervisorRow,
  type ErpVwProductoDetalleRow,
} from '../utils/erpMasterAdapter';

const CATALOG_CACHE_TTL_MS = 90_000;
const CATALOG_PAGE_SIZE = 1000;

interface TimedEntry<T> {
  value: T;
  expiresAt: number;
}

const regionesCache = new Map<string, TimedEntry<RegionMaestra[]>>();
const productosCache = new Map<string, TimedEntry<ProductoMaestro[]>>();
const supervisoresCache = new Map<string, TimedEntry<SupervisorMaestro[]>>();
const promotorasCache = new Map<string, TimedEntry<PromotoraMaestra[]>>();

const invalidationListeners = new Set<() => void>();

export function subscribeMasterCatalogInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

export function clearMasterCatalogCaches(): void {
  regionesCache.clear();
  productosCache.clear();
  supervisoresCache.clear();
  promotorasCache.clear();
}

export function invalidateMasterCatalogCaches(): void {
  clearMasterCatalogCaches();
  for (const listener of invalidationListeners) {
    try {
      listener();
    } catch {
      // Aislar fallo de suscriptores individuales
    }
  }
}

registerSupabaseSessionResetCallback(clearMasterCatalogCaches);
registerMemoryCachePurgeCallback(clearMasterCatalogCaches);

function getScopeKey(): string {
  return getActiveClientSucursalHeader() ?? 'GLOBAL';
}

function readTimedCache<T>(store: Map<string, TimedEntry<T>>, key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function writeTimedCache<T>(store: Map<string, TimedEntry<T>>, key: string, value: T): void {
  if (store.size > 16) {
    store.clear();
  }
  store.set(key, { value, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS });
}

function asSucursalOrNull(raw: unknown): SucursalMaestro | null {
  const clean = limpiarCeldaTexto(raw);
  if (!clean) return null;
  const norm = normalizeSucursalCodigo(clean);
  return norm && isOperativeSucursal(norm) ? norm : null;
}

function asNullableString(raw: unknown): string | null {
  const clean = limpiarCeldaTexto(raw);
  return clean ? clean : null;
}

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function normalizeRegionMasterRow(raw: Record<string, unknown>): RegionMaestra {
  const codigo = normalizarCodigoMaestro(raw.regi_desd ?? raw.codigo ?? raw.nombre ?? '');
  const nombre = limpiarCeldaTexto(raw.regi_desd ?? raw.nombre ?? raw.codigo ?? '') || codigo;
  const priority =
    codigo === 'OCCIDENTE' ? 1 : codigo === 'CENTRO' ? 2 : codigo === 'ANDES' ? 3 : undefined;
  return {
    id: String(raw.id ?? raw.id_regi ?? ''),
    codigo,
    nombre,
    activo: raw.activo !== false,
    ...(typeof raw.regi_saba === 'boolean' ? { regi_saba: raw.regi_saba } : {}),
    ...(priority ? { priority } : {}),
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}

export function normalizeProductoMasterRow(raw: Record<string, unknown>): ProductoMaestro {
  const codigo = normalizarCodigoMaestro(
    raw.codigo ?? raw.prod_codi ?? raw.sku ?? raw.codigo_producto ?? ''
  );
  const nombre =
    limpiarCeldaTexto(raw.nombre ?? raw.producto ?? raw.prod_desc ?? raw.descripcion ?? '') ||
    codigo ||
    'Sin nombre';
  const categoriaParts = [
    asNullableString(raw.categoria ?? raw.linea),
    !raw.categoria && !raw.linea ? asNullableString(raw.grupo) : null,
    !raw.categoria && !raw.linea ? asNullableString(raw.familia) : null,
  ].filter(Boolean);
  return {
    id: String(raw.id ?? raw.id_prod ?? ''),
    codigo,
    nombre,
    categoria: categoriaParts.length > 0 ? categoriaParts.join(' · ') : null,
    marca: asNullableString(raw.marca),
    unidad_medida:
      limpiarCeldaTexto(raw.unidad_medida ?? raw.prod_unid ?? raw.unidad ?? 'KG').toUpperCase() ||
      'KG',
    activo: raw.activo !== false && raw.prod_acti !== false,
    metadata: asObject(raw.metadata),
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}

function isMissingColumnDbError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? '').toUpperCase();
  const msg = String(err.message ?? '').toLowerCase();
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    msg.includes('does not exist') ||
    msg.includes('could not find the')
  );
}

function isMissingRelationDbError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? '').toUpperCase();
  const msg = String(err.message ?? '').toLowerCase();
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    msg.includes('could not find the table') ||
    (msg.includes('relation') && msg.includes('does not exist'))
  );
}

export function normalizeSupervisorMasterRow(raw: Record<string, unknown>): SupervisorMaestro {
  const nombre =
    limpiarCeldaTexto(raw.nombre ?? raw.supe_nomb ?? raw.nombre_completo ?? raw.full_name ?? '') ||
    'Sin nombre';
  const emailRaw = limpiarCeldaTexto(raw.email ?? raw.correo ?? '').toLowerCase();
  const metadata = asObject(raw.metadata);
  const regionCode = normalizeRegionName(
    metadata.region_codigo ?? raw.region ?? raw.region_codigo ?? raw.zona ?? raw.sucursal
  );
  return {
    id: String(raw.id ?? raw.id_supe ?? ''),
    codigo: asNullableString(raw.codigo),
    nombre,
    email: emailRaw || null,
    telefono: asNullableString(raw.telefono ?? raw.supe_cont),
    zona: asNullableString(raw.zona) ?? regionCode,
    sucursal: asSucursalOrNull(raw.sucursal ?? raw.region ?? raw.region_codigo ?? raw.sede),
    region_id: asNullableString(raw.region_id ?? raw.id_regi),
    activo: raw.activo !== false && raw.supe_acti !== false,
    metadata: regionCode ? { ...metadata, region_codigo: regionCode } : metadata,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}

export function normalizePromotoraMasterRow(raw: Record<string, unknown>): PromotoraMaestra {
  const nombre =
    limpiarCeldaTexto(raw.nombre_completo ?? raw.nombre ?? raw.full_name ?? raw.name ?? '') ||
    'Sin nombre';
  const emailRaw = limpiarCeldaTexto(raw.email ?? raw.correo ?? '').toLowerCase();
  const categoria = classifyPromotoraCategoriaOficial(raw);
  const metadata = asObject(raw.metadata);
  const direccion = asNullableString(raw.direccion ?? raw.address);
  const ciudad = asNullableString(raw.ciudad) ?? direccion;
  const estado = asNullableString(raw.estado);
  const regionCode =
    normalizeRegionName(metadata.region_codigo) ??
    normalizeRegionName(raw.region ?? raw.region_codigo ?? raw.sucursal ?? estado ?? ciudad ?? direccion) ??
    (emailRaw === 'joseabraham.barroso@gmail.com' ? 'OCCIDENTE' : null);
  const rawRegionText = limpiarCeldaTexto(raw.region ?? metadata.region_perfil ?? '');
  const normalizedRegionLabel =
    /^andes$/i.test(rawRegionText)
      ? 'Andes'
      : /^centro$/i.test(rawRegionText)
        ? 'Centro'
        : /^valencia$/i.test(rawRegionText)
          ? 'Valencia'
          : /^occidente$/i.test(rawRegionText)
            ? 'Occidente'
            : regionCode === 'OCCIDENTE'
              ? 'Occidente'
              : regionCode === 'CENTRO'
                ? 'Valencia'
                : regionCode === 'ANDES'
                  ? 'Andes'
                  : null;
  const compatSucursal =
    asSucursalOrNull(raw.sucursal ?? raw.region ?? raw.region_codigo ?? raw.sede) ??
    (normalizedRegionLabel === 'Valencia'
      ? 'VALENCIA'
      : regionCode === 'OCCIDENTE'
        ? 'ZULIA'
        : regionCode === 'CENTRO'
          ? 'CENTRO'
          : null);
  return {
    id: String(raw.id ?? ''),
    nombre_completo: nombre,
    email: emailRaw || null,
    telefono: asNullableString(raw.telefono ?? raw.phone),
    ciudad,
    estado,
    direccion,
    region: normalizedRegionLabel,
    auth_user_id: asNullableString(raw.auth_user_id),
    sucursal: compatSucursal,
    region_id: asNullableString(raw.region_id),
    supervisor_id: asNullableString(raw.supervisor_id),
    categoria,
    tipo:
      asNullableString(
        raw.tipo ?? raw.tipo_promotora ?? raw.modalidad ?? raw.categoria ?? raw.perfil
      ) ?? formatPromotoraRoleForCategory(categoria),
    rol: asNullableString(raw.rol ?? raw.role ?? raw.cargo),
    metadata: regionCode
      ? {
          ...metadata,
          region_codigo: regionCode,
          ...(normalizedRegionLabel ? { region_perfil: normalizedRegionLabel } : {}),
        }
      : metadata,
    activo: raw.activo !== false,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}

function resolveClient(customClient?: SupabaseClient | null): SupabaseClient | null {
  if (customClient) return customClient;
  if (!isSupabaseConfigured) return null;
  return getSupabaseClient();
}

async function resolveBearerTokenForCatalogApi(client: SupabaseClient): Promise<string> {
  return (await getAuthenticatedSessionToken(client)) ?? '';
}

async function fetchCatalogFromBackendApi<T>(
  endpoint: '/api/maestros/regiones' | '/api/maestros/productos' | '/api/maestros/supervisores' | '/api/maestros/promotoras',
  params: Record<string, string | boolean | undefined>,
  client: SupabaseClient
): Promise<{ status: 'ok'; data: T[] } | { status: 'no_token' } | { status: 'unavailable' }> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return { status: 'unavailable' };
  }
  const initialToken = await resolveBearerTokenForCatalogApi(client);
  if (!initialToken) {
    return { status: 'no_token' };
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    qs.set(k, typeof v === 'boolean' ? (v ? 'true' : 'false') : v);
  }
  const url = `${endpoint}${qs.toString() ? `?${qs.toString()}` : ''}`;
  const activeSucursal = getActiveClientSucursalHeader();

  return executeWithSessionRefreshRetry(client, 'maestros', async (token) => {
    const bearer = token || initialToken;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(activeSucursal ? { 'x-sucursal-activa': activeSucursal } : {}),
        },
      });
    } catch {
      return { status: 'unavailable' as const };
    }

    if (res.status === 401) {
      throw { status: 401, code: 'AUTH_SESSION_EXPIRED', message: 'Sesión inválida o expirada.' };
    }

    if (res.status === 404 || res.status === 502 || res.status === 503 || res.status === 504) {
      return { status: 'unavailable' as const };
    }

    if (!res.ok) {
      let serverMsg = '';
      try {
        const errBody = (await res.json()) as { error?: string };
        serverMsg = errBody?.error ? String(errBody.error) : '';
      } catch {
        // Sin cuerpo JSON
      }
      throw new Error(
        serverMsg ||
          `Error HTTP ${res.status} consultando ${endpoint.replace('/api/maestros/', '')} en el servidor.`
      );
    }

    const payload = (await res.json()) as { data?: unknown };
    if (!Array.isArray(payload?.data)) {
      throw new Error(`Respuesta inválida recibida desde ${endpoint}.`);
    }
    return { status: 'ok' as const, data: payload.data as T[] };
  });
}

async function fetchPaginatedDirectTable<T>(
  client: SupabaseClient,
  table: string,
  selectExpr: string,
  options: { orderBy?: string; eqFilters?: Record<string, unknown> } = {}
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += CATALOG_PAGE_SIZE) {
    let query = client.from(table).select(selectExpr);
    if (options.orderBy) {
      query = query.order(options.orderBy, { ascending: true });
    }
    if (options.eqFilters) {
      for (const [col, val] of Object.entries(options.eqFilters)) {
        query = query.eq(col, val);
      }
    }
    query = query.range(from, from + CATALOG_PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) {
      throw error;
    }
    const page = Array.isArray(data) ? (data as unknown as T[]) : [];
    rows.push(...page);
    if (page.length < CATALOG_PAGE_SIZE) break;
  }
  return rows;
}

// =============================================================================
// 1. REGIONES (`public."Regiones"` / `/api/maestros/regiones`)
// =============================================================================

export async function obtenerRegionesMaestras(
  options: { soloActivas?: boolean; forzarRefresco?: boolean; client?: SupabaseClient | null } = {}
): Promise<RegionMaestra[]> {
  const client = resolveClient(options.client);
  if (!client) return [];

  const cacheKey = `${getScopeKey()}:${options.soloActivas ? '1' : '0'}`;
  if (!options.forzarRefresco) {
    const cached = readTimedCache(regionesCache, cacheKey);
    if (cached) return cached;
  }

  if (!options.client) {
    const apiRes = await fetchCatalogFromBackendApi<RegionMaestra>(
      '/api/maestros/regiones',
      {
        soloActivas: options.soloActivas ? true : undefined,
        forzarRefresco: options.forzarRefresco ? '1' : undefined,
      },
      client
    );
    if (apiRes.status === 'ok') {
      const normalized = apiRes.data.map((r) =>
        normalizeRegionMasterRow(r as unknown as Record<string, unknown>)
      );
      writeTimedCache(regionesCache, cacheKey, normalized);
      return normalized;
    }
  }

  try {
    let query = client.from('regiones').select('*').order('nombre', { ascending: true });
    if (options.soloActivas) {
      query = query.eq('activo', true);
    }
    const { data, error } = await query;
    if (!error) {
      const rows = ((data as Record<string, unknown>[] | null) ?? []).map(normalizeRegionMasterRow);
      writeTimedCache(regionesCache, cacheKey, rows);
      return rows;
    }
    if (!isMissingRelationDbError(error)) {
      throw new Error(error.message || 'No se pudieron consultar las regiones en Supabase.');
    }
  } catch (err) {
    if (!isMissingRelationDbError(err as { code?: string; message?: string })) {
      throw err instanceof Error
        ? err
        : new Error('No se pudieron consultar las regiones en Supabase.');
    }
  }

  // Fallback directo al esquema real ERP `public."Regiones"`
  const { data: erpData, error: erpError } = await client
    .from('Regiones')
    .select('id_regi,created_at,regi_desd,regi_saba');
  if (erpError) {
    throw new Error(
      `No se pudo leer public."Regiones" en Supabase (requiere sesión autenticada y política RLS SELECT): ${erpError.message}`
    );
  }
  const rows = normalizeErpRegionesDataset((erpData ?? []) as unknown as ErpRegionRow[]);
  writeTimedCache(regionesCache, cacheKey, rows);
  return rows;
}

export async function guardarRegionMaestra(
  input: RegionMaestraInput,
  customClient?: SupabaseClient | null
): Promise<RegionMaestra> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const codigo = normalizarCodigoMaestro(input.codigo);
  const nombre = limpiarCeldaTexto(input.nombre);
  if (!codigo || !nombre) {
    throw new Error('Código y nombre de la región son obligatorios.');
  }

  const payload = {
    codigo,
    nombre,
    activo: input.activo !== false,
  };

  const result = input.id
    ? await client.from('regiones').update(payload).eq('id', input.id).select('*').single()
    : await client.from('regiones').insert(payload).select('*').single();

  if (result.error || !result.data) {
    throw new Error(
      result.error?.message || 'Solo el Administrador General puede modificar el catálogo de regiones.'
    );
  }

  invalidateMasterCatalogCaches();
  return normalizeRegionMasterRow(result.data as Record<string, unknown>);
}

export async function cambiarEstadoRegionMaestra(
  id: string,
  activo: boolean,
  customClient?: SupabaseClient | null
): Promise<RegionMaestra> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const { data, error } = await client
    .from('regiones')
    .update({ activo })
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar el estado de la región.');
  }

  invalidateMasterCatalogCaches();
  return normalizeRegionMasterRow(data as Record<string, unknown>);
}

// =============================================================================
// 2. PRODUCTOS — CATÁLOGO NACIONAL COMPARTIDO (`public.productos`)
// =============================================================================

export async function obtenerProductosMaestros(
  options: { soloActivos?: boolean; forzarRefresco?: boolean; client?: SupabaseClient | null } = {}
): Promise<ProductoMaestro[]> {
  const client = resolveClient(options.client);
  if (!client) return [];

  const cacheKey = `NACIONAL:${options.soloActivos ? '1' : '0'}`;
  if (!options.forzarRefresco) {
    const cached = readTimedCache(productosCache, cacheKey);
    if (cached) return cached;
  }

  if (!options.client) {
    const apiRes = await fetchCatalogFromBackendApi<ProductoMaestro>(
      '/api/maestros/productos',
      {
        soloActivos: options.soloActivos ? true : undefined,
        forzarRefresco: options.forzarRefresco ? '1' : undefined,
      },
      client
    );
    if (apiRes.status === 'ok') {
      const normalized = apiRes.data.map((r) =>
        normalizeProductoMasterRow(r as unknown as Record<string, unknown>)
      );
      writeTimedCache(productosCache, cacheKey, normalized);
      return normalized;
    }
  }

  try {
    const rowsRaw = await fetchPaginatedDirectTable<Record<string, unknown>>(
      client,
      'productos',
      '*',
      {
        orderBy: 'nombre',
        ...(options.soloActivos ? { eqFilters: { activo: true } } : {}),
      }
    );
    const rows = rowsRaw.map(normalizeProductoMasterRow);
    writeTimedCache(productosCache, cacheKey, rows);
    return rows;
  } catch (err) {
    if (!isMissingRelationDbError(err as { code?: string; message?: string })) {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: unknown }).message)
          : 'No se pudo consultar el catálogo nacional de productos.';
      throw new Error(msg);
    }
  }

  // Fallback directo al esquema real ERP `"vw_productos_detalle"` + `"Productos"` (paginado)
  const [vwRows, prodRows] = await Promise.all([
    fetchPaginatedDirectTable<ErpVwProductoDetalleRow>(
      client,
      'vw_productos_detalle',
      'id_prod,codigo,producto,orden,activo,marca,marca_propia,familia,grupo,regiones,n_regiones,created_at',
      { orderBy: 'id_prod' }
    ).catch((err) => {
      if (isMissingRelationDbError(err as { code?: string; message?: string })) return [];
      throw err;
    }),
    fetchPaginatedDirectTable<ErpProductoRow>(
      client,
      'Productos',
      'id_prod,created_at,prod_codi,prod_desc,prod_unid,prod_acti',
      { orderBy: 'id_prod' }
    ),
  ]);

  let normalized = normalizeErpProductosDataset(prodRows, vwRows);
  if (options.soloActivos) {
    normalized = normalized.filter((p) => p.activo);
  }
  writeTimedCache(productosCache, cacheKey, normalized);
  return normalized;
}

export async function guardarProductoMaestro(
  input: ProductoMaestroInput,
  customClient?: SupabaseClient | null
): Promise<ProductoMaestro> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const codigo = normalizarCodigoMaestro(input.codigo);
  const nombre = limpiarCeldaTexto(input.nombre);
  if (!nombre) {
    throw new Error('El nombre del producto es obligatorio.');
  }

  const payload: Record<string, unknown> = {
    ...(codigo ? { codigo } : {}),
    nombre,
    categoria: asNullableString(input.categoria),
    marca: asNullableString(input.marca),
    unidad_medida: limpiarCeldaTexto(input.unidad_medida ?? 'KG').toUpperCase() || 'KG',
    activo: input.activo !== false,
  };

  const result = input.id
    ? await client.from('productos').update(payload).eq('id', input.id).select('*').single()
    : await client.from('productos').insert(payload).select('*').single();

  if (result.error || !result.data) {
    throw new Error(
      result.error?.message ||
        'Solo el Administrador General puede crear o editar el catálogo nacional de productos.'
    );
  }

  invalidateMasterCatalogCaches();
  return normalizeProductoMasterRow(result.data as Record<string, unknown>);
}

export async function cambiarEstadoProductoMaestro(
  id: string,
  activo: boolean,
  customClient?: SupabaseClient | null
): Promise<ProductoMaestro> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const { data, error } = await client
    .from('productos')
    .update({ activo })
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(
      error?.message || 'Solo el Administrador General puede desactivar productos maestros.'
    );
  }

  invalidateMasterCatalogCaches();
  return normalizeProductoMasterRow(data as Record<string, unknown>);
}

// =============================================================================
// 3. SUPERVISORES (`public.supervisores`)
// =============================================================================

export async function obtenerSupervisoresMaestros(
  options: { soloActivos?: boolean; forzarRefresco?: boolean; client?: SupabaseClient | null } = {}
): Promise<SupervisorMaestro[]> {
  const client = resolveClient(options.client);
  if (!client) return [];

  const cacheKey = `${getScopeKey()}:${options.soloActivos ? '1' : '0'}`;
  if (!options.forzarRefresco) {
    const cached = readTimedCache(supervisoresCache, cacheKey);
    if (cached) return cached;
  }

  if (!options.client) {
    const apiRes = await fetchCatalogFromBackendApi<SupervisorMaestro>(
      '/api/maestros/supervisores',
      {
        soloActivos: options.soloActivos ? true : undefined,
        forzarRefresco: options.forzarRefresco ? '1' : undefined,
      },
      client
    );
    if (apiRes.status === 'ok') {
      const normalized = apiRes.data.map((r) =>
        normalizeSupervisorMasterRow(r as unknown as Record<string, unknown>)
      );
      writeTimedCache(supervisoresCache, cacheKey, normalized);
      return normalized;
    }
  }

  try {
    const rowsRaw = await fetchPaginatedDirectTable<Record<string, unknown>>(
      client,
      'supervisores',
      '*',
      {
        orderBy: 'nombre',
        ...(options.soloActivos ? { eqFilters: { activo: true } } : {}),
      }
    );
    const rows = rowsRaw.map(normalizeSupervisorMasterRow);
    writeTimedCache(supervisoresCache, cacheKey, rows);
    return rows;
  } catch (err) {
    if (!isMissingRelationDbError(err as { code?: string; message?: string })) {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: unknown }).message)
          : 'No se pudieron consultar los supervisores en Supabase.';
      throw new Error(msg);
    }
  }

  // Fallback directo al esquema real ERP `"Supervisores"` + `"Regiones"`
  const [supRaw, regRaw] = await Promise.all([
    fetchPaginatedDirectTable<ErpSupervisorRow>(
      client,
      'Supervisores',
      'id_supe,created_at,supe_nomb,supe_acti,id_regi,supe_cont',
      { orderBy: 'id_supe' }
    ),
    fetchPaginatedDirectTable<ErpRegionRow>(
      client,
      'Regiones',
      'id_regi,created_at,regi_desd,regi_saba',
      { orderBy: 'id_regi' }
    ).catch(() => [] as ErpRegionRow[]),
  ]);

  let normalized = normalizeErpSupervisoresDataset(supRaw, regRaw);
  const activeRegionFilter = normalizeRegionName(getActiveClientSucursalHeader());
  if (activeRegionFilter) {
    normalized = normalized.filter(
      (s) =>
        normalizeRegionName(s.metadata?.region_codigo ?? s.sucursal ?? s.zona) === activeRegionFilter
    );
  }
  if (options.soloActivos) {
    normalized = normalized.filter((s) => s.activo);
  }
  writeTimedCache(supervisoresCache, cacheKey, normalized);
  return normalized;
}

export async function guardarSupervisorMaestro(
  input: SupervisorMaestroInput,
  customClient?: SupabaseClient | null
): Promise<SupervisorMaestro> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const nombre = limpiarCeldaTexto(input.nombre);
  if (!nombre) {
    throw new Error('El nombre del supervisor es obligatorio.');
  }

  const emailClean = limpiarCeldaTexto(input.email).toLowerCase() || null;
  const payload: Record<string, unknown> = {
    codigo: input.codigo ? normalizarCodigoMaestro(input.codigo) : null,
    nombre,
    email: emailClean,
    telefono: normalizarTelefonoMaestro(input.telefono),
    zona: asNullableString(input.zona),
    activo: input.activo !== false,
    ...(input.region_id ? { region_id: input.region_id } : {}),
    ...(input.sucursal ? { sucursal: input.sucursal } : {}),
  };

  const result = input.id
    ? await client.from('supervisores').update(payload).eq('id', input.id).select('*').single()
    : await client.from('supervisores').insert(payload).select('*').single();

  if (result.error || !result.data) {
    throw new Error(result.error?.message || 'No se pudo guardar el supervisor.');
  }

  invalidateMasterCatalogCaches();
  return normalizeSupervisorMasterRow(result.data as Record<string, unknown>);
}

export async function cambiarEstadoSupervisorMaestro(
  id: string,
  activo: boolean,
  customClient?: SupabaseClient | null
): Promise<SupervisorMaestro> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const { data, error } = await client
    .from('supervisores')
    .update({ activo })
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar el estado del supervisor.');
  }

  invalidateMasterCatalogCaches();
  return normalizeSupervisorMasterRow(data as Record<string, unknown>);
}

export async function reasignarRegionSupervisor(
  id: string,
  regionId: string,
  sucursal: SucursalMaestro,
  customClient?: SupabaseClient | null
): Promise<SupervisorMaestro> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const { data, error } = await client
    .from('supervisores')
    .update({ region_id: regionId, sucursal })
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo asignar la región al supervisor.');
  }

  invalidateMasterCatalogCaches();
  return normalizeSupervisorMasterRow(data as Record<string, unknown>);
}

// =============================================================================
// 4. PROMOTORAS (`public.promotoras`)
// =============================================================================

export async function obtenerPromotorasMaestras(
  options: {
    soloActivas?: boolean;
    categoria?: PromotoraCategoriaOficial | 'TODAS';
    regionId?: string;
    forzarRefresco?: boolean;
    client?: SupabaseClient | null;
  } = {}
): Promise<PromotoraMaestra[]> {
  const parsedCategoria =
    options.categoria !== undefined
      ? PromotoraCategoriaFilterSchema.parse(options.categoria)
      : 'TODAS';

  const client = resolveClient(options.client);
  if (!client) return [];

  const cacheKey = `${getScopeKey()}:${options.soloActivas ? '1' : '0'}:${parsedCategoria}:${options.regionId ?? ''}`;
  if (!options.forzarRefresco) {
    const cached = readTimedCache(promotorasCache, cacheKey);
    if (cached) return cached;
  }

  if (!options.client) {
    const apiRes = await fetchCatalogFromBackendApi<PromotoraMaestra>(
      '/api/maestros/promotoras',
      {
        soloActivas: options.soloActivas ? true : undefined,
        categoria: parsedCategoria !== 'TODAS' ? parsedCategoria : undefined,
        regionId: options.regionId || undefined,
        forzarRefresco: options.forzarRefresco ? '1' : undefined,
      },
      client
    );
    if (apiRes.status === 'ok') {
      const normalized = apiRes.data.map((r) =>
        normalizePromotoraMasterRow(r as unknown as Record<string, unknown>)
      );
      writeTimedCache(promotorasCache, cacheKey, normalized);
      return normalized;
    }
  }

  const rawRows: Record<string, unknown>[] = [];
  let useMinimalFallback = false;
  for (let from = 0; ; from += CATALOG_PAGE_SIZE) {
    let query = client
      .from('promotoras')
      .select('*')
      .range(from, from + CATALOG_PAGE_SIZE - 1);
    if (!useMinimalFallback) {
      query = query.order('nombre_completo', { ascending: true });
    }
    if (options.soloActivas) {
      query = query.eq('activo', true);
    }
    if (options.regionId && !useMinimalFallback) {
      query = query.eq('region_id', options.regionId);
    }
    if (parsedCategoria !== 'TODAS' && !useMinimalFallback) {
      query = query.eq('categoria', parsedCategoria);
    }

    let { data, error } = await query;
    if (error && !useMinimalFallback && isMissingColumnDbError(error)) {
      useMinimalFallback = true;
      let fallbackQuery = client
        .from('promotoras')
        .select('*')
        .range(from, from + CATALOG_PAGE_SIZE - 1);
      if (options.soloActivas) {
        fallbackQuery = fallbackQuery.eq('activo', true);
      }
      const fallbackRes = await fallbackQuery;
      data = fallbackRes.data;
      error = fallbackRes.error;
    }
    if (error) {
      throw new Error(error.message || 'No se pudieron consultar las promotoras en Supabase.');
    }

    const page = (data as Record<string, unknown>[] | null) ?? [];
    rawRows.push(...page);
    if (page.length < CATALOG_PAGE_SIZE) break;
  }

  const regRaw = await fetchPaginatedDirectTable<ErpRegionRow>(
    client,
    'Regiones',
    'id_regi,created_at,regi_desd,regi_saba',
    { orderBy: 'id_regi' }
  ).catch(() => [] as ErpRegionRow[]);

  let rows =
    regRaw.length > 0
      ? normalizeErpPromotorasDataset(rawRows as unknown as ErpPromotoraRow[], regRaw)
      : rawRows
          .map(normalizePromotoraMasterRow)
          .sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es'));

  const activeRegionFilter = normalizeRegionName(getActiveClientSucursalHeader());
  if (activeRegionFilter && !options.regionId) {
    rows = rows.filter(
      (r) =>
        normalizeRegionName(r.metadata?.region_codigo ?? r.region ?? r.sucursal) ===
        activeRegionFilter
    );
  }
  if (options.regionId) {
    rows = rows.filter((r) => r.region_id === options.regionId);
  }
  if (parsedCategoria !== 'TODAS') {
    rows = rows.filter((r) => r.categoria === parsedCategoria);
  }

  writeTimedCache(promotorasCache, cacheKey, rows);
  return rows;
}

function formatPromotoraWriteError(
  error: { code?: string; message?: string; hint?: string; details?: string } | null | undefined,
  fallbackMessage: string
): Error {
  const code = String(error?.code ?? '').trim().toUpperCase();
  const message = String(error?.message ?? '').trim();
  const lower = message.toLowerCase();
  if (code === '42501' || lower.includes('permission denied') || lower.includes('row-level security')) {
    return new Error(
      `Permiso denegado por RLS al guardar en Supabase (${code || '42501'}). Aplica la migración de políticas para authenticated o verifica tu rol.`
    );
  }
  return new Error(message || fallbackMessage);
}

export async function guardarPromotoraMaestra(
  input: PromotoraMaestraInput,
  customClient?: SupabaseClient | null
): Promise<PromotoraMaestra> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const nombreCompleto = limpiarCeldaTexto(input.nombre_completo);
  if (!nombreCompleto) {
    throw new Error('El nombre completo de la promotora es obligatorio.');
  }

  const validatedCategoria: PromotoraCategoriaOficial =
    input.categoria !== undefined
      ? PromotoraCategoriaStrictSchema.parse(input.categoria)
      : 'Fijas';

  const rawId = input.id !== undefined && input.id !== null ? String(input.id).trim() : '';
  const isUpdate = Boolean(rawId);
  const isNumericId = isUpdate && /^\d+$/.test(rawId);
  const eqId: string | number = isNumericId ? Number(rawId) : rawId;

  const emailClean = limpiarCeldaTexto(input.email).toLowerCase() || null;
  const telefonoClean = normalizarTelefonoMaestro(input.telefono);
  const direccionClean = asNullableString(input.direccion ?? input.ciudad);

  const cleanRegionLabel =
    typeof input.region === 'string' && input.region.trim()
      ? input.region.trim()
      : input.sucursal === 'VALENCIA' || input.sucursal === 'CENTRO'
        ? 'Valencia'
        : input.sucursal === 'ZULIA'
          ? 'Occidente'
          : undefined;

  // Esquema real de producción (`public.promotoras` ERP: id entero, correo, direccion, telefono, activo, categoria, region, region_id)
  const erpProdPayload: Record<string, unknown> = {
    nombre_completo: nombreCompleto,
    correo: emailClean,
    telefono: telefonoClean,
    direccion: direccionClean,
    activo: input.activo !== false,
    categoria: validatedCategoria,
    ...(cleanRegionLabel ? { region: cleanRegionLabel } : {}),
    ...(input.region_id ? { region_id: input.region_id } : {}),
  };
  const erpProdRegionOnlyPayload: Record<string, unknown> = {
    nombre_completo: nombreCompleto,
    correo: emailClean,
    telefono: telefonoClean,
    direccion: direccionClean,
    activo: input.activo !== false,
    categoria: validatedCategoria,
    ...(cleanRegionLabel ? { region: cleanRegionLabel } : {}),
  };
  const erpProdMinimalPayload: Record<string, unknown> = {
    nombre_completo: nombreCompleto,
    correo: emailClean,
    telefono: telefonoClean,
    direccion: direccionClean,
    activo: input.activo !== false,
    ...(cleanRegionLabel ? { region: cleanRegionLabel } : {}),
  };

  // Esquema normalizado extendido (`email`, `ciudad`, `estado`, `supervisor_id`, `region_id`, `sucursal`)
  const extendedBasePayload: Record<string, unknown> = {
    nombre_completo: nombreCompleto,
    email: emailClean,
    telefono: telefonoClean,
    ciudad: asNullableString(input.ciudad),
    estado: asNullableString(input.estado),
    direccion: direccionClean,
    supervisor_id: input.supervisor_id ? limpiarCeldaTexto(input.supervisor_id) : null,
    activo: input.activo !== false,
    ...(cleanRegionLabel ? { region: cleanRegionLabel } : {}),
    ...(input.region_id ? { region_id: input.region_id } : {}),
    ...(input.sucursal ? { sucursal: input.sucursal } : {}),
  };

  const executeWrite = async (payload: Record<string, unknown>) =>
    isUpdate
      ? await client.from('promotoras').update(payload).eq('id', eqId).select('*')
      : await client.from('promotoras').insert(payload).select('*');

  const extendedAttempts: Record<string, unknown>[] = [
    { ...extendedBasePayload, categoria: validatedCategoria },
    {
      ...extendedBasePayload,
      tipo: input.tipo ?? formatPromotoraRoleForCategory(validatedCategoria),
    },
    { ...extendedBasePayload, metadata: { categoria: validatedCategoria } },
    extendedBasePayload,
  ];

  // Si es actualización sobre ID numérico de producción (o alta sin region_id), intentar primero el esquema real ERP (`correo`)
  const attempts: Record<string, unknown>[] =
    isNumericId || (!isUpdate && !input.region_id)
      ? [erpProdPayload, erpProdRegionOnlyPayload, erpProdMinimalPayload, ...extendedAttempts]
      : [...extendedAttempts, erpProdPayload, erpProdRegionOnlyPayload, erpProdMinimalPayload];

  let result = await executeWrite(attempts[0]!);
  for (let i = 1; i < attempts.length && result.error && isMissingColumnDbError(result.error); i++) {
    result = await executeWrite(attempts[i]!);
  }

  if (result.error) {
    console.error('[guardarPromotoraMaestra] Error guardando en public.promotoras', {
      code: result.error.code,
      message: result.error.message,
      hint: result.error.hint,
      details: result.error.details,
      id: rawId || null,
      operation: isUpdate ? 'UPDATE' : 'INSERT',
    });
    throw formatPromotoraWriteError(result.error, 'No se pudo guardar el perfil de la promotora.');
  }

  const savedRows = Array.isArray(result.data)
    ? (result.data as Record<string, unknown>[])
    : result.data
      ? [result.data as Record<string, unknown>]
      : [];

  if (savedRows.length === 0) {
    console.error('[guardarPromotoraMaestra] 0 filas afectadas en public.promotoras (posible bloqueo RLS o ID inexistente)', {
      id: rawId || null,
      operation: isUpdate ? 'UPDATE' : 'INSERT',
    });
    throw new Error(
      'No se guardaron los cambios en Supabase (0 filas afectadas). Verifica permisos RLS de UPDATE/INSERT o que el perfil exista.'
    );
  }

  invalidateMasterCatalogCaches();
  // Invalidar caché snapshot del servidor Express (60s) para que F5 inmediato refleje los cambios
  if (!customClient) {
    await fetchCatalogFromBackendApi<PromotoraMaestra>(
      '/api/maestros/promotoras',
      { forzarRefresco: '1' },
      client
    ).catch(() => undefined);
  }

  const normalized = normalizePromotoraMasterRow(savedRows[0]!);
  return { ...normalized, categoria: validatedCategoria };
}

export async function cambiarEstadoPromotoraMaestra(
  id: string,
  activo: boolean,
  customClient?: SupabaseClient | null
): Promise<PromotoraMaestra> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const rawId = String(id || '').trim();
  const eqId: string | number = /^\d+$/.test(rawId) ? Number(rawId) : rawId;

  const { data, error } = await client
    .from('promotoras')
    .update({ activo })
    .eq('id', eqId)
    .select('*');

  if (error) {
    console.error('[cambiarEstadoPromotoraMaestra] Error actualizando estado en public.promotoras', {
      code: error.code,
      message: error.message,
      hint: error.hint,
      details: error.details,
      id: rawId,
      activo,
    });
    throw formatPromotoraWriteError(error, 'No se pudo actualizar el estado de la promotora.');
  }

  const rows = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : data
      ? [data as Record<string, unknown>]
      : [];

  if (rows.length === 0) {
    console.error('[cambiarEstadoPromotoraMaestra] 0 filas afectadas (posible bloqueo RLS o ID inexistente)', {
      id: rawId,
      activo,
    });
    throw new Error(
      'No se actualizó el estado de la promotora en Supabase (0 filas afectadas). Verifica permisos RLS.'
    );
  }

  invalidateMasterCatalogCaches();
  if (!customClient) {
    await fetchCatalogFromBackendApi<PromotoraMaestra>(
      '/api/maestros/promotoras',
      { forzarRefresco: '1' },
      client
    ).catch(() => undefined);
  }

  return normalizePromotoraMasterRow(rows[0]!);
}

export async function reasignarRegionPromotora(
  id: string,
  regionId: string,
  sucursal: SucursalMaestro,
  customClient?: SupabaseClient | null
): Promise<PromotoraMaestra> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const { data, error } = await client
    .from('promotoras')
    .update({ region_id: regionId, sucursal })
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo asignar la región a la promotora.');
  }

  invalidateMasterCatalogCaches();
  return normalizePromotoraMasterRow(data as Record<string, unknown>);
}

// =============================================================================
// 5. RECLASIFICACIÓN DE CUARENTENA EN `public.clientes` (SOLO SUPER ADMIN)
// =============================================================================

export async function reasignarRegionCliente(
  id: string,
  regionId: string,
  sucursal: SucursalMaestro,
  customClient?: SupabaseClient | null
): Promise<void> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const { error } = await client
    .from('clientes')
    .update({ region_id: regionId, sucursal })
    .eq('id', id);

  if (error) {
    throw new Error(error.message || 'No se pudo asignar la región al cliente.');
  }

  invalidarCacheMaestros();
  invalidateMasterCatalogCaches();
}
