import type { BcvRateSnapshot } from '../types';
import { getCaracasIsoDate, isReasonableBcvRate, round4 } from '../utils/bimonetaryPriceMath';
import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import { fetchLiveBcvRate } from './supabaseModule1';

let cachedBcvSnapshot: { snapshot: BcvRateSnapshot; expiresAtMs: number } | null = null;
let tasasBcvTableUnavailable = false;
const CLIENT_BCV_CACHE_TTL_MS = 5 * 60 * 1000;
const BCV_API_TIMEOUT_MS = 60_000;

export function clearBcvRateCache(): void {
  cachedBcvSnapshot = null;
}

async function fetchBcvApiWithColdStartRetry(url: string, token: string): Promise<Response | null> {
  const backoffMs = [0, 1500];
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BCV_API_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (resp.ok || (resp.status < 500 && resp.status !== 408)) {
        return resp;
      }
    } catch {
      // Reintenta una vez ante arranque en frío o microcorte de red
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function getAccessToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data } = await getSupabaseClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Obtiene la tasa BCV oficial vigente desde el endpoint autenticado `/api/tasa-bcv`
 * (respaldado por caché en `public.tasas_bcv` + fallback automático ante caída de BCV).
 */
export async function fetchOfficialBcvRate(options?: {
  forceRefresh?: boolean;
}): Promise<BcvRateSnapshot | null> {
  const forceRefresh = options?.forceRefresh === true;
  if (!forceRefresh && cachedBcvSnapshot && Date.now() < cachedBcvSnapshot.expiresAtMs) {
    return cachedBcvSnapshot.snapshot;
  }

  const token = await getAccessToken();

  if (token) {
    try {
      const qs = forceRefresh ? '?refresh=true' : '';
      const resp = await fetchBcvApiWithColdStartRetry(`/api/tasa-bcv${qs}`, token);
      if (resp && resp.ok) {
        const body = (await resp.json()) as {
          ok?: boolean;
          fecha?: string;
          tasaUsdVes?: number;
          fuente?: BcvRateSnapshot['fuente'];
          fetchedAt?: string;
          isFallback?: boolean;
          fromCache?: boolean;
        };
        if (body?.ok && isReasonableBcvRate(body.tasaUsdVes)) {
          const snapshot: BcvRateSnapshot = {
            fecha: String(body.fecha || getCaracasIsoDate()),
            tasaUsdVes: round4(Number(body.tasaUsdVes)),
            fuente: body.fuente ?? 'BCV_OFICIAL',
            fetchedAt: String(body.fetchedAt || new Date().toISOString()),
            isFallback: Boolean(body.isFallback),
            fromCache: Boolean(body.fromCache),
          };
          cachedBcvSnapshot = {
            snapshot,
            expiresAtMs: Date.now() + CLIENT_BCV_CACHE_TTL_MS,
          };
          return snapshot;
        }
      }
    } catch {
      // Fallback controlado a tabla/dolarapi abajo
    }
  }

  // Respaldo 1: leer última fila directamente desde `public.tasas_bcv` bajo RLS (solo lectura authenticated)
  if (isSupabaseConfigured && !tasasBcvTableUnavailable) {
    try {
      const { data, error } = await getSupabaseClient()
        .from('tasas_bcv')
        .select('fecha, tasa_usd_ves, fuente, fetched_at')
        .order('fecha', { ascending: false })
        .limit(1);
      if (error) {
        if (
          error.code === 'PGRST205' ||
          error.code === '42P01' ||
          /could not find the table|does not exist/i.test(String(error.message || ''))
        ) {
          tasasBcvTableUnavailable = true;
        }
      } else if (Array.isArray(data) && data.length > 0) {
        const row = data[0] as Record<string, unknown>;
        if (isReasonableBcvRate(row.tasa_usd_ves)) {
          const today = getCaracasIsoDate();
          const rowFecha = String(row.fecha || today).slice(0, 10);
          const snapshot: BcvRateSnapshot = {
            fecha: rowFecha,
            tasaUsdVes: round4(Number(row.tasa_usd_ves)),
            fuente: (String(row.fuente || 'BCV_OFICIAL') as BcvRateSnapshot['fuente']),
            fetchedAt: String(row.fetched_at || new Date().toISOString()),
            isFallback: rowFecha !== today,
            fromCache: true,
          };
          cachedBcvSnapshot = {
            snapshot,
            expiresAtMs: Date.now() + CLIENT_BCV_CACHE_TTL_MS,
          };
          return snapshot;
        }
      }
    } catch {
      // Continúa a último respaldo vivo
    }
  }

  // Respaldo 2: lectura directa si no hay backend Express activo
  const live = await fetchLiveBcvRate().catch(() => null);
  if (live !== null && isReasonableBcvRate(live)) {
    const snapshot: BcvRateSnapshot = {
      fecha: getCaracasIsoDate(),
      tasaUsdVes: round4(live),
      fuente: 'BCV_OFICIAL',
      fetchedAt: new Date().toISOString(),
      isFallback: false,
      fromCache: false,
    };
    cachedBcvSnapshot = {
      snapshot,
      expiresAtMs: Date.now() + CLIENT_BCV_CACHE_TTL_MS,
    };
    return snapshot;
  }

  return cachedBcvSnapshot?.snapshot ?? null;
}

/**
 * Registra una tasa oficial BCV manual de contingencia (exclusivo para Admin Global).
 */
export async function saveManualBcvRate(params: {
  tasaUsdVes: number;
  fecha?: string;
}): Promise<BcvRateSnapshot> {
  if (!isReasonableBcvRate(params.tasaUsdVes)) {
    throw new Error('Ingresa una tasa BCV válida entre 10 y 100.000 Bs/USD.');
  }

  const token = await getAccessToken();
  if (!token) {
    throw new Error('Tu sesión ha expirado. Inicia sesión nuevamente.');
  }

  const resp = await fetch('/api/tasa-bcv/manual', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tasaUsdVes: round4(params.tasaUsdVes),
      ...(params.fecha ? { fecha: params.fecha } : {}),
    }),
  });

  const body = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    fecha?: string;
    tasaUsdVes?: number;
    fuente?: BcvRateSnapshot['fuente'];
    fetchedAt?: string;
  };

  if (!resp.ok || !body.ok || !isReasonableBcvRate(body.tasaUsdVes)) {
    throw new Error(body.error || 'No se pudo guardar la tasa BCV manual.');
  }

  const snapshot: BcvRateSnapshot = {
    fecha: String(body.fecha || params.fecha || getCaracasIsoDate()),
    tasaUsdVes: round4(Number(body.tasaUsdVes)),
    fuente: body.fuente ?? 'MANUAL_ADMIN',
    fetchedAt: String(body.fetchedAt || new Date().toISOString()),
    isFallback: false,
    fromCache: false,
  };
  cachedBcvSnapshot = {
    snapshot,
    expiresAtMs: Date.now() + CLIENT_BCV_CACHE_TTL_MS,
  };
  return snapshot;
}
