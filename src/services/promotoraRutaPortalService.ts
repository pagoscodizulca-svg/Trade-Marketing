import type { RutaPromotoraRecord } from '../types/degustacionesPipeline';
import { getCaracasTodayYmd } from '../utils/caracasWeekCycle';
import type { VerifiedAuthProfile } from './authService';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';

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
 * mediante la RPC transaccional idempotente `public.registrar_avance_ruta_promotora`.
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

  if (error || !data) {
    throw new Error(
      error?.message || 'No se pudo registrar el avance operativo de la degustación.'
    );
  }

  return data as RutaPromotoraRecord;
}
