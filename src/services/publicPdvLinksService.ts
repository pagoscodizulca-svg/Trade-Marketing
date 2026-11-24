/**
 * Servicio de Enlaces Públicos PDV por Sucursal (BLOQUE 5 — Sin Login, Token Único Regional)
 *
 * Consume exclusivamente las funciones PostgreSQL RPC `SECURITY DEFINER`:
 *   - `public.obtener_o_crear_enlace_pdv_mi_sucursal` (Coordinadora autenticada)
 *   - `public.regenerar_enlace_pdv_mi_sucursal`       (Coordinadora autenticada)
 *   - `public.revocar_enlace_pdv_mi_sucursal`         (Coordinadora autenticada)
 *   - `public.obtener_datos_pdv_por_token`            (Público PDV con token válido)
 *   - `public.reportar_ejecucion_pdv`                 (Público PDV con validación anti-cruce 42501)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import { registerMemoryCachePurgeCallback } from './sessionCacheHygiene';
import {
  normalizeCanonicalSucursal,
  type CanonicalSucursal,
} from '../utils/regionalSyncClassifier';
import { buildRegionalPdvPortalUrl } from '../utils/portalLinkSharing';

const PUBLIC_PDV_TOKEN_REGEX = /^[A-Za-z0-9_-]{24,256}$/;

export interface RegionalPdvLinkInfo {
  id: string;
  sucursal: CanonicalSucursal;
  token: string;
  url: string;
  tokenHint: string;
  createdAt: string;
  lastUsedAt: string | null;
  usoContador: number;
}

export interface PublicPdvTiendaItem {
  id: string;
  codigo_cliente: string | null;
  nombre_comercial: string;
  ciudad: string | null;
  estado: string | null;
  zona: string | null;
  ruta: string | null;
  latitud: number | null;
  longitud: number | null;
  radio_geocerca_m: number | null;
}

export interface PublicPdvPromotoraItem {
  id: string;
  nombre_completo: string;
  categoria: string;
}

export interface PublicPdvDegustacionAutorizadaItem {
  degustacion_id: string;
  fuente: 'cronograma' | 'survey';
  survey_origen_id: string | null;
  fecha: string;
  turno: string;
  cliente_nombre: string;
  cliente_codigo: string | null;
  zona_direccion: string | null;
  producto_resumen: string;
  productos: unknown[];
  promotora_id: string | null;
  promotora_nombre: string | null;
  vendedor_fdv: string | null;
  estado: string;
}

export interface PublicPdvProductoNacionalItem {
  id: string;
  codigo: string | null;
  nombre: string;
  marca: string | null;
  categoria: string | null;
  unidad_medida: string | null;
}

export interface PublicPdvBootstrapPayload {
  sucursal: CanonicalSucursal;
  tiendas: PublicPdvTiendaItem[];
  promotoras: PublicPdvPromotoraItem[];
  degustacionesAutorizadas: PublicPdvDegustacionAutorizadaItem[];
  productos: PublicPdvProductoNacionalItem[];
  serverTime: string;
  fromOfflineCache?: boolean;
}

export interface PublicPdvExecutionInput {
  degustacionId?: string | null;
  promotoraId?: string | null;
  promotoraNombre?: string | null;
  clienteId?: string | null;
  clienteNombre: string;
  productoNombre: string;
  muestrasEntregadas: number;
  ventasAsistidas: number;
  unidadesAbiertas?: number;
  loteProducto?: string | null;
  observaciones?: string | null;
  fecha?: string | null;
  clientSubmissionId?: string | null;
}

export interface PublicPdvExecutionResult {
  ok: boolean;
  sucursal: CanonicalSucursal;
  inventoryId: string | null;
  degustacionActualizada: boolean;
  clientSubmissionId: string;
  queuedOffline?: boolean;
}

export class PublicPdvSecurityError extends Error {
  readonly code: 'INVALID_TOKEN' | 'CROSS_BRANCH_FORBIDDEN' | 'VALIDATION_ERROR';
  constructor(
    code: 'INVALID_TOKEN' | 'CROSS_BRANCH_FORBIDDEN' | 'VALIDATION_ERROR',
    message: string
  ) {
    super(message);
    this.name = 'PublicPdvSecurityError';
    this.code = code;
  }
}

let cachedCoordinatorLinks = new Map<CanonicalSucursal, RegionalPdvLinkInfo>();

registerMemoryCachePurgeCallback(() => {
  cachedCoordinatorLinks.clear();
});

export function isValidPublicPdvTokenFormat(rawToken: unknown): boolean {
  const clean = String(rawToken ?? '').trim();
  return PUBLIC_PDV_TOKEN_REGEX.test(clean);
}

export function extractPublicPdvTokenFromSearch(rawSearch?: string): string | null {
  const search =
    rawSearch !== undefined
      ? rawSearch
      : typeof window !== 'undefined'
        ? window.location.search
        : '';
  if (!search) return null;
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
    const candidate = (params.get('token') ?? '').trim();
    if (!candidate) return null;
    return isValidPublicPdvTokenFormat(candidate) ? candidate : '__INVALID_FORMAT__';
  } catch {
    return null;
  }
}

function tokenStorageNamespace(token: string): string {
  // Solo usa un prefijo corto no reversible del token para aislar caché offline en el dispositivo
  const safe = token.replace(/[^A-Za-z0-9]/g, '');
  return `${safe.slice(0, 8)}_${safe.slice(-6)}`;
}

function parseRegionalLinkRow(
  raw: Record<string, unknown> | null | undefined,
  explicitOrigin?: string
): RegionalPdvLinkInfo {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Respuesta inválida al consultar el enlace público de la sucursal.');
  }
  const sucursal = normalizeCanonicalSucursal(raw.sucursal);
  const token = String(raw.token ?? '').trim();
  if (!sucursal || !isValidPublicPdvTokenFormat(token)) {
    throw new Error('El token devuelto por el servidor no cumple el formato de seguridad.');
  }
  return {
    id: String(raw.id ?? ''),
    sucursal,
    token,
    url: buildRegionalPdvPortalUrl(token, explicitOrigin),
    tokenHint: String(raw.token_hint ?? `${token.slice(0, 10)}...${token.slice(-4)}`),
    createdAt: String(raw.created_at ?? new Date().toISOString()),
    lastUsedAt: raw.last_used_at ? String(raw.last_used_at) : null,
    usoContador: Number(raw.uso_contador ?? 0) || 0,
  };
}

export async function obtenerOCrearEnlacePdvMiSucursal(options?: {
  sucursalOverride?: CanonicalSucursal | null;
  forceRefresh?: boolean;
  explicitOrigin?: string;
  clientOverride?: SupabaseClient;
}): Promise<RegionalPdvLinkInfo> {
  const override = options?.sucursalOverride ?? null;
  if (!options?.forceRefresh && override && cachedCoordinatorLinks.has(override)) {
    return cachedCoordinatorLinks.get(override)!;
  }
  if (!options?.clientOverride && !isSupabaseConfigured) {
    throw new Error('Supabase no está configurado en este entorno.');
  }
  const client = options?.clientOverride ?? getSupabaseClient();
  const { data, error } = await client.rpc('obtener_o_crear_enlace_pdv_mi_sucursal', {
    p_sucursal_override: override,
  });

  if (error) {
    throw new Error(
      error.message || 'No se pudo obtener el enlace público PDV de la sucursal activa.'
    );
  }

  const parsed = parseRegionalLinkRow(
    data as Record<string, unknown>,
    options?.explicitOrigin
  );
  cachedCoordinatorLinks.set(parsed.sucursal, parsed);
  return parsed;
}

export async function regenerarEnlacePdvMiSucursal(options?: {
  sucursalOverride?: CanonicalSucursal | null;
  explicitOrigin?: string;
  clientOverride?: SupabaseClient;
}): Promise<RegionalPdvLinkInfo> {
  if (!options?.clientOverride && !isSupabaseConfigured) {
    throw new Error('Supabase no está configurado en este entorno.');
  }
  const client = options?.clientOverride ?? getSupabaseClient();
  const { data, error } = await client.rpc('regenerar_enlace_pdv_mi_sucursal', {
    p_sucursal_override: options?.sucursalOverride ?? null,
  });

  if (error) {
    throw new Error(
      error.message || 'No se pudo regenerar el enlace público PDV de la sucursal.'
    );
  }

  const parsed = parseRegionalLinkRow(
    data as Record<string, unknown>,
    options?.explicitOrigin
  );
  cachedCoordinatorLinks.set(parsed.sucursal, parsed);
  return parsed;
}

export async function revocarEnlacePdvMiSucursal(options?: {
  sucursalOverride?: CanonicalSucursal | null;
  clientOverride?: SupabaseClient;
}): Promise<{ ok: boolean; sucursal: CanonicalSucursal; revocados: number }> {
  if (!options?.clientOverride && !isSupabaseConfigured) {
    throw new Error('Supabase no está configurado en este entorno.');
  }
  const client = options?.clientOverride ?? getSupabaseClient();
  const { data, error } = await client.rpc('revocar_enlace_pdv_mi_sucursal', {
    p_sucursal_override: options?.sucursalOverride ?? null,
  });

  if (error) {
    throw new Error(error.message || 'No se pudo revocar el enlace público PDV.');
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  const sucursal = normalizeCanonicalSucursal(raw.sucursal) ?? 'OCCIDENTE';
  cachedCoordinatorLinks.delete(sucursal);
  return {
    ok: true,
    sucursal,
    revocados: Number(raw.revocados ?? 0) || 0,
  };
}

function mapRpcErrorToSecurityError(error: { code?: string; message?: string }): Error {
  const combined = `${error.code ?? ''} ${error.message ?? ''}`;
  if (/ACCESO_DENEGADO_SUCURSAL_CRUZADA/i.test(combined)) {
    return new PublicPdvSecurityError(
      'CROSS_BRANCH_FORBIDDEN',
      'Operación rechazada por seguridad: el registro no pertenece a la sucursal de este enlace.'
    );
  }
  if (/TOKEN_PDV_INVALIDO_O_REVOCADO|42501/i.test(combined)) {
    return new PublicPdvSecurityError(
      'INVALID_TOKEN',
      'Este enlace público PDV es inválido o fue revocado por la coordinadora. Solicita el enlace vigente de tu sucursal.'
    );
  }
  return new PublicPdvSecurityError(
    'VALIDATION_ERROR',
    error.message || 'No se pudo procesar la operación en el punto de venta.'
  );
}

export async function obtenerDatosPdvPorToken(
  rawToken: string,
  options?: { clientOverride?: SupabaseClient }
): Promise<PublicPdvBootstrapPayload> {
  const cleanToken = String(rawToken ?? '').trim();
  if (!isValidPublicPdvTokenFormat(cleanToken)) {
    throw new PublicPdvSecurityError(
      'INVALID_TOKEN',
      'El enlace público PDV no contiene un token válido. Solicita el enlace oficial a tu coordinadora.'
    );
  }

  if (!options?.clientOverride && !isSupabaseConfigured) {
    throw new Error('Supabase no está configurado en este entorno.');
  }

  const ns = tokenStorageNamespace(cleanToken);
  const snapshotKey = `codizulca.pdv_token_snapshot.${ns}`;
  const client = options?.clientOverride ?? getSupabaseClient();

  try {
    const { data, error } = await client.rpc('obtener_datos_pdv_por_token', {
      p_token: cleanToken,
    });

    if (error) {
      // Si el token fue revocado, purgar inmediatamente cualquier snapshot offline previo
      if (/TOKEN_PDV_INVALIDO_O_REVOCADO|42501/i.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
        try {
          if (typeof window !== 'undefined') window.localStorage.removeItem(snapshotKey);
        } catch {
          // ignore storage errors
        }
      }
      throw mapRpcErrorToSecurityError(error);
    }

    const raw = (data ?? {}) as Record<string, unknown>;
    const sucursal = normalizeCanonicalSucursal(raw.sucursal);
    if (!sucursal) {
      throw new PublicPdvSecurityError(
        'INVALID_TOKEN',
        'El enlace público no tiene una sucursal válida asociada.'
      );
    }

    const payload: PublicPdvBootstrapPayload = {
      sucursal,
      tiendas: Array.isArray(raw.tiendas) ? (raw.tiendas as PublicPdvTiendaItem[]) : [],
      promotoras: Array.isArray(raw.promotoras)
        ? (raw.promotoras as PublicPdvPromotoraItem[])
        : [],
      degustacionesAutorizadas: Array.isArray(raw.degustaciones_autorizadas)
        ? (raw.degustaciones_autorizadas as PublicPdvDegustacionAutorizadaItem[])
        : [],
      productos: Array.isArray(raw.productos)
        ? (raw.productos as PublicPdvProductoNacionalItem[])
        : [],
      serverTime: String(raw.server_time ?? new Date().toISOString()),
      fromOfflineCache: false,
    };

    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(snapshotKey, JSON.stringify(payload));
      }
    } catch {
      // ignore quota errors
    }

    return payload;
  } catch (err) {
    if (err instanceof PublicPdvSecurityError) {
      throw err;
    }
    // Resiliencia ante pérdida temporal de señal móvil en el PDV
    if (typeof window !== 'undefined') {
      try {
        const cachedRaw = window.localStorage.getItem(snapshotKey);
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw) as PublicPdvBootstrapPayload;
          if (parsed && (parsed.sucursal === 'CENTRO' || parsed.sucursal === 'OCCIDENTE')) {
            return { ...parsed, fromOfflineCache: true };
          }
        }
      } catch {
        // ignore parse errors
      }
    }
    throw err;
  }
}

export function createClientSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback determinista RFC-4122 v4 compatible con columnas UUID y TEXT
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.trunc(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function reportarEjecucionPdv(
  rawToken: string,
  input: PublicPdvExecutionInput,
  options?: { clientOverride?: SupabaseClient }
): Promise<PublicPdvExecutionResult> {
  const cleanToken = String(rawToken ?? '').trim();
  if (!isValidPublicPdvTokenFormat(cleanToken)) {
    throw new PublicPdvSecurityError(
      'INVALID_TOKEN',
      'Token público PDV inválido o ausente.'
    );
  }

  const clienteNombre = String(input.clienteNombre ?? '').trim();
  const productoNombre = String(input.productoNombre ?? '').trim();
  if (!clienteNombre) {
    throw new PublicPdvSecurityError('VALIDATION_ERROR', 'Selecciona la tienda / PDV.');
  }
  if (!productoNombre) {
    throw new PublicPdvSecurityError('VALIDATION_ERROR', 'Selecciona el producto degustado.');
  }

  const submissionId =
    (input.clientSubmissionId && input.clientSubmissionId.trim()) || createClientSubmissionId();

  const rpcPayload = {
    degustacion_id: input.degustacionId || null,
    promotora_id: input.promotoraId || null,
    promotora_nombre: input.promotoraNombre || null,
    cliente_id: input.clienteId || null,
    cliente_nombre: clienteNombre,
    producto_nombre: productoNombre,
    muestras_entregadas: Math.max(0, Math.trunc(Number(input.muestrasEntregadas) || 0)),
    ventas_asistidas: Math.max(0, Math.trunc(Number(input.ventasAsistidas) || 0)),
    unidades_abiertas: Math.max(0, Math.trunc(Number(input.unidadesAbiertas) || 0)),
    lote_producto: input.loteProducto ? String(input.loteProducto).trim() : null,
    observaciones: input.observaciones ? String(input.observaciones).trim() : null,
    fecha: input.fecha || null,
    client_submission_id: submissionId,
  };

  if (!options?.clientOverride && !isSupabaseConfigured) {
    throw new Error('Supabase no está configurado en este entorno.');
  }

  const client = options?.clientOverride ?? getSupabaseClient();
  const { data, error } = await client.rpc('reportar_ejecucion_pdv', {
    p_token: cleanToken,
    p_payload: rpcPayload,
  });

  if (error) {
    throw mapRpcErrorToSecurityError(error);
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  const sucursal = normalizeCanonicalSucursal(raw.sucursal);
  if (!sucursal) {
    throw new Error('Respuesta inesperada al registrar la ejecución PDV.');
  }

  return {
    ok: true,
    sucursal,
    inventoryId: raw.inventory_id ? String(raw.inventory_id) : null,
    degustacionActualizada: Boolean(raw.degustacion_actualizada),
    clientSubmissionId: String(raw.client_submission_id ?? submissionId),
  };
}
