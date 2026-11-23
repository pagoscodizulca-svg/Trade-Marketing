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
  getSupabaseClient,
  isSupabaseConfigured,
  registerSupabaseSessionResetCallback,
} from './supabaseClient';
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
  type PromotoraCategoriaOficial,
} from '../utils/regionalSyncClassifier';

const CATALOG_CACHE_TTL_MS = 90_000;

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
  const codigo = normalizarCodigoMaestro(raw.codigo ?? raw.nombre ?? '');
  const nombre = limpiarCeldaTexto(raw.nombre ?? raw.codigo ?? '') || codigo;
  return {
    id: String(raw.id ?? ''),
    codigo,
    nombre,
    activo: raw.activo !== false,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

export function normalizeProductoMasterRow(raw: Record<string, unknown>): ProductoMaestro {
  const codigo = normalizarCodigoMaestro(raw.codigo ?? raw.sku ?? raw.codigo_producto ?? '');
  const nombre =
    limpiarCeldaTexto(raw.nombre ?? raw.descripcion ?? raw.producto ?? '') || codigo || 'Sin nombre';
  return {
    id: String(raw.id ?? ''),
    codigo,
    nombre,
    categoria: asNullableString(raw.categoria ?? raw.linea),
    marca: asNullableString(raw.marca),
    unidad_medida: limpiarCeldaTexto(raw.unidad_medida ?? raw.unidad ?? 'KG').toUpperCase() || 'KG',
    activo: raw.activo !== false,
    metadata: asObject(raw.metadata),
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
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

export function normalizeSupervisorMasterRow(raw: Record<string, unknown>): SupervisorMaestro {
  const nombre =
    limpiarCeldaTexto(raw.nombre ?? raw.nombre_completo ?? raw.full_name ?? '') || 'Sin nombre';
  const emailRaw = limpiarCeldaTexto(raw.email ?? raw.correo ?? '').toLowerCase();
  return {
    id: String(raw.id ?? ''),
    codigo: asNullableString(raw.codigo),
    nombre,
    email: emailRaw || null,
    telefono: asNullableString(raw.telefono),
    zona: asNullableString(raw.zona),
    sucursal: asSucursalOrNull(raw.sucursal ?? raw.region ?? raw.region_codigo ?? raw.sede),
    region_id: asNullableString(raw.region_id),
    activo: raw.activo !== false,
    metadata: asObject(raw.metadata),
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

export function normalizePromotoraMasterRow(raw: Record<string, unknown>): PromotoraMaestra {
  const nombre =
    limpiarCeldaTexto(raw.nombre_completo ?? raw.nombre ?? raw.full_name ?? raw.name ?? '') ||
    'Sin nombre';
  const emailRaw = limpiarCeldaTexto(raw.email ?? raw.correo ?? '').toLowerCase();
  const categoria = classifyPromotoraCategoriaOficial(raw);
  return {
    id: String(raw.id ?? ''),
    nombre_completo: nombre,
    email: emailRaw || null,
    telefono: asNullableString(raw.telefono ?? raw.phone),
    ciudad: asNullableString(raw.ciudad),
    estado: asNullableString(raw.estado),
    direccion: asNullableString(raw.direccion ?? raw.address),
    sucursal: asSucursalOrNull(raw.sucursal ?? raw.region ?? raw.region_codigo ?? raw.sede),
    region_id: asNullableString(raw.region_id),
    supervisor_id: asNullableString(raw.supervisor_id),
    categoria,
    tipo:
      asNullableString(
        raw.tipo ?? raw.tipo_promotora ?? raw.modalidad ?? raw.categoria ?? raw.perfil
      ) ?? formatPromotoraRoleForCategory(categoria),
    rol: asNullableString(raw.rol ?? raw.role ?? raw.cargo),
    metadata: asObject(raw.metadata),
    activo: raw.activo !== false,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

function resolveClient(customClient?: SupabaseClient | null): SupabaseClient | null {
  if (customClient) return customClient;
  if (!isSupabaseConfigured) return null;
  return getSupabaseClient();
}

// =============================================================================
// 1. REGIONES (`public.regiones`)
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

  let query = client.from('regiones').select('*').order('nombre', { ascending: true });
  if (options.soloActivas) {
    query = query.eq('activo', true);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message || 'No se pudieron consultar las regiones en Supabase.');
  }

  const rows = ((data as Record<string, unknown>[] | null) ?? []).map(normalizeRegionMasterRow);
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

  let query = client.from('productos').select('*').order('nombre', { ascending: true });
  if (options.soloActivos) {
    query = query.eq('activo', true);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message || 'No se pudo consultar el catálogo nacional de productos.');
  }

  const rows = ((data as Record<string, unknown>[] | null) ?? []).map(normalizeProductoMasterRow);
  writeTimedCache(productosCache, cacheKey, rows);
  return rows;
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

  let query = client.from('supervisores').select('*').order('nombre', { ascending: true });
  if (options.soloActivos) {
    query = query.eq('activo', true);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message || 'No se pudieron consultar los supervisores en Supabase.');
  }

  const rows = ((data as Record<string, unknown>[] | null) ?? []).map(normalizeSupervisorMasterRow);
  writeTimedCache(supervisoresCache, cacheKey, rows);
  return rows;
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

  let query = client.from('promotoras').select('*').order('nombre_completo', { ascending: true });
  if (options.soloActivas) {
    query = query.eq('activo', true);
  }
  if (options.regionId) {
    query = query.eq('region_id', options.regionId);
  }
  if (parsedCategoria !== 'TODAS') {
    query = query.eq('categoria', parsedCategoria);
  }

  let { data, error } = await query;
  if (error && isMissingColumnDbError(error)) {
    let fallbackQuery = client.from('promotoras').select('*');
    if (options.soloActivas) {
      fallbackQuery = fallbackQuery.eq('activo', true);
    }
    if (options.regionId) {
      fallbackQuery = fallbackQuery.eq('region_id', options.regionId);
    }
    const fallbackRes = await fallbackQuery;
    data = fallbackRes.data;
    error = fallbackRes.error;
  }
  if (error) {
    throw new Error(error.message || 'No se pudieron consultar las promotoras en Supabase.');
  }

  let rows = ((data as Record<string, unknown>[] | null) ?? [])
    .map(normalizePromotoraMasterRow)
    .sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo, 'es'));

  if (parsedCategoria !== 'TODAS') {
    rows = rows.filter((r) => r.categoria === parsedCategoria);
  }

  writeTimedCache(promotorasCache, cacheKey, rows);
  return rows;
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

  const emailClean = limpiarCeldaTexto(input.email).toLowerCase() || null;
  const basePayload: Record<string, unknown> = {
    nombre_completo: nombreCompleto,
    email: emailClean,
    telefono: normalizarTelefonoMaestro(input.telefono),
    ciudad: asNullableString(input.ciudad),
    estado: asNullableString(input.estado),
    direccion: asNullableString(input.direccion),
    supervisor_id: input.supervisor_id ? limpiarCeldaTexto(input.supervisor_id) : null,
    activo: input.activo !== false,
    ...(input.region_id ? { region_id: input.region_id } : {}),
    ...(input.sucursal ? { sucursal: input.sucursal } : {}),
  };

  const executeWrite = async (payload: Record<string, unknown>) =>
    input.id
      ? await client.from('promotoras').update(payload).eq('id', input.id).select('*').single()
      : await client.from('promotoras').insert(payload).select('*').single();

  const categoryPayloadAttempts: Record<string, unknown>[] = [
    { ...basePayload, categoria: validatedCategoria },
    {
      ...basePayload,
      tipo: input.tipo ?? formatPromotoraRoleForCategory(validatedCategoria),
    },
    { ...basePayload, metadata: { categoria: validatedCategoria } },
    basePayload,
  ];

  let result = await executeWrite(categoryPayloadAttempts[0]!);
  for (let i = 1; i < categoryPayloadAttempts.length && result.error && isMissingColumnDbError(result.error); i++) {
    result = await executeWrite(categoryPayloadAttempts[i]!);
  }

  if (result.error || !result.data) {
    throw new Error(result.error?.message || 'No se pudo guardar la promotora.');
  }

  invalidateMasterCatalogCaches();
  const normalized = normalizePromotoraMasterRow(result.data as Record<string, unknown>);
  return { ...normalized, categoria: validatedCategoria };
}

export async function cambiarEstadoPromotoraMaestra(
  id: string,
  activo: boolean,
  customClient?: SupabaseClient | null
): Promise<PromotoraMaestra> {
  const client = resolveClient(customClient);
  if (!client) throw new Error('Supabase no está configurado.');

  const { data, error } = await client
    .from('promotoras')
    .update({ activo })
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'No se pudo actualizar el estado de la promotora.');
  }

  invalidateMasterCatalogCaches();
  return normalizePromotoraMasterRow(data as Record<string, unknown>);
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
