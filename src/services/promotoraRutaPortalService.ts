import type {
  EjecucionPdvInput,
  ResultadoEjecucionRutaPromotora,
  RutaPromotoraRecord,
} from '../types/degustacionesPipeline';
import { getCaracasTodayYmd } from '../utils/caracasWeekCycle';
import { DEFAULT_GEOFENCE_RADIUS_METERS } from '../utils/geofenceHaversine';
import type { VerifiedAuthProfile } from './authService';
import {
  getAuthenticatedSessionToken,
  getSupabaseClient,
  isSupabaseConfigured,
} from './supabaseClient';

export interface PortalPdvGeofenceRef {
  id: string;
  codigoCliente: string;
  nombreComercial: string;
  latitud: number | null;
  longitud: number | null;
  radioGeocercaM: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sortAndDeduplicateRutas(rows: RutaPromotoraRecord[]): RutaPromotoraRecord[] {
  const byId = new Map<string, RutaPromotoraRecord>();
  const seenCronograma = new Set<string>();

  for (const row of rows) {
    if (!row || !row.id || row.estado_ruta === 'CANCELADA') continue;
    if (row.cronograma_id && seenCronograma.has(row.cronograma_id) && !byId.has(row.id)) {
      // Si la misma degustación se recreó con nuevo ID tras reasignación, prevalece la más reciente
      for (const [existingKey, existingRow] of byId.entries()) {
        if (existingRow.cronograma_id === row.cronograma_id) {
          byId.delete(existingKey);
        }
      }
    }
    if (row.cronograma_id) {
      seenCronograma.add(row.cronograma_id);
    }
    byId.set(row.id, {
      ...row,
      productos: Array.isArray(row.productos) ? row.productos : [row.producto_resumen].filter(Boolean),
    });
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha.localeCompare(b.fecha);
    if (a.hora_inicio !== b.hora_inicio) return a.hora_inicio.localeCompare(b.hora_inicio);
    return a.cliente_nombre.localeCompare(b.cliente_nombre, 'es');
  });
}

/**
 * Consulta segura Zero Trust para `/portal`:
 * - Jamás envía identificadores de identidad desde query params o cabeceras HTTP personalizadas.
 * - El filtrado de propiedad ocurre en PostgreSQL mediante RLS (`private.current_active_promotora_id()`
 *   y coincidencia exacta `LOWER(TRIM(email))` del JWT).
 * - Para promotoras devuelve únicamente sus degustaciones autorizadas del día actual (`America/Caracas`)
 *   y programación próxima asignada (`fecha >= hoy_caracas`), ordenadas por fecha y punto de venta.
 */
export async function fetchPortalRutaRecords(params: {
  profile: VerifiedAuthProfile;
  supervisorFilterPromotoraId?: string | null;
}): Promise<RutaPromotoraRecord[]> {
  if (!isSupabaseConfigured) return [];
  const { profile, supervisorFilterPromotoraId } = params;

  if (profile.appRole !== 'promotora' && !profile.isCoordinatorOrAdmin) {
    throw new Error('Tu perfil no tiene autorización para consultar rutas de promotoras.');
  }

  const todayYmd = getCaracasTodayYmd();
  const client = getSupabaseClient();
  let query = client
    .from('rutas_promotoras')
    .select('*')
    .in('estado_ruta', ['ASIGNADA', 'EN_CURSO', 'COMPLETADA'])
    .order('fecha', { ascending: true })
    .order('hora_inicio', { ascending: true })
    .order('cliente_nombre', { ascending: true })
    .limit(300);

  if (profile.appRole === 'promotora') {
    query = query.gte('fecha', todayYmd);
  }

  if (
    profile.isCoordinatorOrAdmin &&
    supervisorFilterPromotoraId &&
    UUID_REGEX.test(supervisorFilterPromotoraId)
  ) {
    query = query.eq('promotora_id', supervisorFilterPromotoraId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error('No se pudo cargar la hoja de ruta verificada desde el servidor.');
  }

  const rawList = Array.isArray(data) ? (data as RutaPromotoraRecord[]) : [];
  const normalizedEmail = String(profile.email || '').trim().toLowerCase();

  // Defensa en profundidad adicional en cliente para perfil promotora
  const filtered =
    profile.appRole === 'promotora'
      ? rawList.filter((r) => {
          const rowEmail = String(r.promotora_email || '').trim().toLowerCase();
          const matchesId = Boolean(profile.staffId && r.promotora_id === profile.staffId);
          const matchesEmail = Boolean(normalizedEmail && rowEmail && rowEmail === normalizedEmail);
          return (matchesId || matchesEmail) && r.fecha >= todayYmd;
        })
      : rawList;

  return sortAndDeduplicateRutas(filtered);
}

/**
 * Registra Check-in (`EN_CURSO`) o Check-out (`COMPLETADA`) en `/portal/ruta`
 * mediante la RPC transaccional idempotente `public.registrar_avance_ruta_promotora`,
 * con respaldo directo seguro por RLS sobre `public.rutas_promotoras` cuando la RPC aún no existe.
 */
export async function registerPromotoraRouteStep(
  rutaId: string,
  accion: 'CHECKIN' | 'CHECKOUT'
): Promise<RutaPromotoraRecord> {
  const cleanId = String(rutaId || '').trim();
  if (!UUID_REGEX.test(cleanId)) {
    throw new Error('Identificador de ruta inválido.');
  }

  const client = getSupabaseClient();
  const { data, error } = await client.rpc('registrar_avance_ruta_promotora', {
    p_ruta_id: cleanId,
    p_accion: accion,
  });

  if (!error && data) {
    return data as RutaPromotoraRecord;
  }

  if (error && isRpcMissingError(error)) {
    const nowIso = new Date().toISOString();
    const patchPayload: Record<string, unknown> =
      accion === 'CHECKIN'
        ? { estado_ruta: 'EN_CURSO', checkin_at: nowIso, updated_at: nowIso }
        : { estado_ruta: 'COMPLETADA', checkout_at: nowIso, updated_at: nowIso };

    const upd = await client
      .from('rutas_promotoras')
      .update(patchPayload)
      .eq('id', cleanId)
      .select('*');

    if (upd.error) {
      console.error('[registerPromotoraRouteStep] Error en UPDATE directo rutas_promotoras:', {
        code: upd.error.code,
        message: upd.error.message,
        hint: upd.error.hint,
        rutaId: cleanId,
        accion,
      });
      throw new Error(
        upd.error.code === '42501'
          ? 'Permiso denegado por RLS al registrar tu avance de ruta. Verifica tu sesión.'
          : upd.error.message || 'No se pudo registrar el avance operativo de la degustación.'
      );
    }

    const rows = Array.isArray(upd.data) ? upd.data : upd.data ? [upd.data] : [];
    if (rows.length === 0) {
      console.error('[registerPromotoraRouteStep] 0 filas afectadas en rutas_promotoras (RLS)', {
        rutaId: cleanId,
        accion,
      });
      throw new Error(
        'No se registró el avance en Supabase (0 filas afectadas). Verifica que la degustación esté asignada a tu usuario.'
      );
    }

    return rows[0] as RutaPromotoraRecord;
  }

  console.error('[registerPromotoraRouteStep] Error en RPC registrar_avance_ruta_promotora:', {
    code: error?.code,
    message: error?.message,
    hint: error?.hint,
    rutaId: cleanId,
    accion,
  });
  throw new Error(
    error?.message || 'No se pudo registrar el avance operativo de la degustación.'
  );
}

/**
 * Consulta las geocercas maestras (`latitud`, `longitud`, `radio_geocerca_m`) de `public.clientes`
 * dentro de la sucursal autorizada por RLS, con respaldo automático al endpoint ERP `/api/maestros/clientes`.
 */
export async function fetchPortalPdvGeofences(): Promise<PortalPdvGeofenceRef[]> {
  if (!isSupabaseConfigured) return [];
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('clientes')
    .select('id, codigo_cliente, nombre_comercial, latitud, longitud, radio_geocerca_m')
    .eq('activo', true)
    .limit(2000);

  let sourceRows: Record<string, unknown>[] = [];
  if (!error && Array.isArray(data)) {
    sourceRows = data as Record<string, unknown>[];
  } else if (typeof window !== 'undefined' && typeof fetch === 'function') {
    const token = await getAuthenticatedSessionToken(client).catch(() => null);
    if (token) {
      try {
        const res = await fetch('/api/maestros/clientes?soloActivos=true', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const parsed = (await res.json()) as { data?: unknown };
          if (Array.isArray(parsed?.data)) {
            sourceRows = parsed.data as Record<string, unknown>[];
          }
        }
      } catch {
        // Sin conectividad con el endpoint ERP local
      }
    }
  }

  return sourceRows.map((raw: Record<string, unknown>) => ({
    id: String(raw.id || ''),
    codigoCliente: String(raw.codigo_cliente || '').trim(),
    nombreComercial: String(raw.nombre_comercial || raw.razon_social || '').trim(),
    latitud:
      raw.latitud !== null && raw.latitud !== undefined && Number.isFinite(Number(raw.latitud))
        ? Number(raw.latitud)
        : null,
    longitud:
      raw.longitud !== null && raw.longitud !== undefined && Number.isFinite(Number(raw.longitud))
        ? Number(raw.longitud)
        : null,
    radioGeocercaM:
      raw.radio_geocerca_m !== null &&
      raw.radio_geocerca_m !== undefined &&
      Number.isFinite(Number(raw.radio_geocerca_m))
        ? Number(raw.radio_geocerca_m)
        : DEFAULT_GEOFENCE_RADIUS_METERS,
  }));
}

export function matchRutaPdvGeofence(
  ruta: Pick<RutaPromotoraRecord, 'cliente_codigo' | 'cliente_nombre'>,
  catalog: PortalPdvGeofenceRef[]
): PortalPdvGeofenceRef | null {
  const codeNorm = String(ruta.cliente_codigo || '').trim().toUpperCase();
  if (codeNorm) {
    const byCode = catalog.find(
      (c) => c.codigoCliente && c.codigoCliente.toUpperCase() === codeNorm
    );
    if (byCode) return byCode;
  }

  const nameNorm = String(ruta.cliente_nombre || '').trim().toLowerCase();
  if (nameNorm) {
    const byName = catalog.find(
      (c) => c.nombreComercial && c.nombreComercial.toLowerCase() === nameNorm
    );
    if (byName) return byName;
  }

  return null;
}

function isRpcMissingError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toLowerCase();
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    msg.includes('could not find the function') ||
    msg.includes('rpc_registrar_ejecucion_ruta_promotora') ||
    msg.includes('registrar_avance_ruta_promotora')
  );
}

/**
 * Registra Check-in / Check-out con validación Haversine en servidor, alerta auditada
 * cuando está fuera de rango y reporte operativo de ejecución en PDV (`B-08`).
 */
export async function submitPromotoraRouteExecution(params: {
  rutaId: string;
  accion: 'CHECKIN' | 'CHECKOUT';
  clientSubmissionId: string;
  lat: number | null;
  lng: number | null;
  accuracyMeters?: number | null;
  motivoFueraGeocerca?: string;
  ejecucion?: EjecucionPdvInput | null;
  superAdminBypass?: boolean;
}): Promise<ResultadoEjecucionRutaPromotora> {
  const cleanId = String(params.rutaId || '').trim();
  if (!UUID_REGEX.test(cleanId)) {
    throw new Error('Identificador de ruta inválido.');
  }

  const client = getSupabaseClient();
  const payload = {
    ruta_id: cleanId,
    accion: params.accion,
    client_submission_id: params.clientSubmissionId,
    lat: params.lat,
    lng: params.lng,
    accuracy_m: params.accuracyMeters ?? null,
    motivo_fuera_geocerca: params.motivoFueraGeocerca?.trim() || '',
    ejecucion: params.ejecucion ?? null,
    super_admin_bypass: params.superAdminBypass === true,
  };

  const { data, error } = await client.rpc('rpc_registrar_ejecucion_ruta_promotora', {
    p_payload: payload,
  });

  if (error) {
    if (isRpcMissingError(error)) {
      const fallbackRuta = await registerPromotoraRouteStep(cleanId, params.accion);
      return {
        ok: true,
        ruta: fallbackRuta,
        distancia_m: null,
        radio_geocerca_m: DEFAULT_GEOFENCE_RADIUS_METERS,
        dentro_geocerca: null,
        alerta_geocerca_registrada: false,
      };
    }
    throw new Error(
      error.message || 'No se pudo registrar el avance operativo de la degustación.'
    );
  }

  const parsed = (data ?? {}) as Record<string, unknown>;
  if (!parsed.ruta) {
    throw new Error('Respuesta incompleta del servidor al registrar ejecución en PDV.');
  }

  return {
    ok: true,
    ruta: parsed.ruta as RutaPromotoraRecord,
    distancia_m: typeof parsed.distancia_m === 'number' ? parsed.distancia_m : null,
    radio_geocerca_m:
      typeof parsed.radio_geocerca_m === 'number'
        ? parsed.radio_geocerca_m
        : DEFAULT_GEOFENCE_RADIUS_METERS,
    dentro_geocerca:
      typeof parsed.dentro_geocerca === 'boolean' ? parsed.dentro_geocerca : null,
    alerta_geocerca_registrada: Boolean(parsed.alerta_geocerca_registrada),
  };
}
