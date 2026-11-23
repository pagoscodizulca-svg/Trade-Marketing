import type { PriceAlertConfigRecord, PriceDropAlertRecord } from '../types';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import { ASISTENCIA_PRIVATE_BUCKET_ID } from '../types/attendanceEvidences';

async function getAccessToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export interface PriceAlertsBundle {
  alertas: PriceDropAlertRecord[];
  configs: PriceAlertConfigRecord[];
  pendingCount: number;
}

/**
 * Carga las alertas automáticas de caída de precio (> X%) y la configuración de umbrales
 * respetando estrictamente el aislamiento multi-región (BFF + RLS).
 */
export async function fetchPriceAlertsBundle(options?: {
  region?: string;
  estado?: string;
}): Promise<PriceAlertsBundle> {
  const token = await getAccessToken();

  if (token) {
    try {
      const qs = new URLSearchParams();
      if (options?.region) qs.set('region', options.region);
      if (options?.estado && options.estado !== 'TODAS') qs.set('estado', options.estado);
      const queryStr = qs.toString() ? `?${qs.toString()}` : '';

      const resp = await fetch(`/api/precios/alertas${queryStr}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (resp.ok) {
        const body = (await resp.json()) as {
          ok?: boolean;
          alertas?: PriceDropAlertRecord[];
          configs?: PriceAlertConfigRecord[];
          pendingCount?: number;
        };
        if (body?.ok) {
          const alertas = Array.isArray(body.alertas) ? body.alertas : [];
          const configs = Array.isArray(body.configs) ? body.configs : [];
          return {
            alertas,
            configs,
            pendingCount:
              typeof body.pendingCount === 'number'
                ? body.pendingCount
                : alertas.filter((a) => a.estado === 'pendiente').length,
          };
        }
      }
    } catch {
      // Fallback controlado a consulta directa RLS en Supabase
    }
  }

  if (!isSupabaseConfigured) {
    return {
      alertas: [],
      configs: [{ region: 'GLOBAL', umbral_caida_porcentaje: 10, ventana_dias: 30, activo: true }],
      pendingCount: 0,
    };
  }

  try {
    const sb = getSupabaseClient();
    const [alertsRes, cfgRes] = await Promise.all([
      sb
        .from('alertas_precios')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200),
      sb
        .from('configuracion_alertas_precios')
        .select('id, region, umbral_caida_porcentaje, ventana_dias, activo, updated_at')
        .order('region', { ascending: true }),
    ]);

    const alertas: PriceDropAlertRecord[] =
      !alertsRes.error && Array.isArray(alertsRes.data)
        ? (alertsRes.data as PriceDropAlertRecord[])
        : [];
    const configs: PriceAlertConfigRecord[] =
      !cfgRes.error && Array.isArray(cfgRes.data) && cfgRes.data.length > 0
        ? (cfgRes.data as PriceAlertConfigRecord[])
        : [{ region: 'GLOBAL', umbral_caida_porcentaje: 10, ventana_dias: 30, activo: true }];

    return {
      alertas,
      configs,
      pendingCount: alertas.filter((a) => a.estado === 'pendiente').length,
    };
  } catch {
    return {
      alertas: [],
      configs: [{ region: 'GLOBAL', umbral_caida_porcentaje: 10, ventana_dias: 30, activo: true }],
      pendingCount: 0,
    };
  }
}

export async function updatePriceAlertStatus(params: {
  id: string;
  estado: 'pendiente' | 'revisada' | 'descartada';
  notasRevision?: string | null;
}): Promise<PriceDropAlertRecord> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Sesión requerida para actualizar alertas de precios.');
  }

  const resp = await fetch(`/api/precios/alertas/${encodeURIComponent(params.id)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      estado: params.estado,
      notas_revision: params.notasRevision ?? null,
    }),
  });

  const body = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    alerta?: PriceDropAlertRecord;
  };
  if (!resp.ok || !body.ok || !body.alerta) {
    throw new Error(body.error || 'No se pudo actualizar el estado de la alerta.');
  }
  return body.alerta;
}

export async function savePriceAlertConfig(params: {
  region: string;
  umbralCaidaPorcentaje: number;
  ventanaDias: number;
  activo: boolean;
}): Promise<PriceAlertConfigRecord> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Sesión requerida para modificar la configuración de alertas.');
  }

  const resp = await fetch('/api/precios/alertas/config', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      region: params.region,
      umbral_caida_porcentaje: params.umbralCaidaPorcentaje,
      ventana_dias: params.ventanaDias,
      activo: params.activo,
    }),
  });

  const body = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    config?: PriceAlertConfigRecord;
  };
  if (!resp.ok || !body.ok || !body.config) {
    throw new Error(body.error || 'No se pudo guardar el umbral de alertas.');
  }
  return body.config;
}

/**
 * Obtiene una URL firmada temporal (15 min) para visualizar la fotografía de soporte
 * del hablador/fleje almacenada en el bucket privado `asistencia-evidencias`.
 */
export async function resolveShelfTagPhotoSignedUrl(storagePath: string): Promise<string | null> {
  const cleanPath = String(storagePath || '').trim();
  if (!cleanPath || cleanPath.includes('..') || !isSupabaseConfigured) return null;
  try {
    const { data, error } = await getSupabaseClient()
      .storage.from(ASISTENCIA_PRIVATE_BUCKET_ID)
      .createSignedUrl(cleanPath, 900);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}
