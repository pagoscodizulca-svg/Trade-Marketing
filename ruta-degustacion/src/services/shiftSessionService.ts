import type { SucursalCodigo } from '../types';
import { clearShiftToken, saveShiftToken } from '../lib/syncCore';
import { purgeAllOfflineData, setMeta } from '../lib/offlineDb';
import { RUTA_PROFILE_CACHE_KEY } from './supabaseAuth';

export const CHOFER_SHIFT_SESSION_KEY = 'codizulca.shift.chofer.v1';

export interface VerifiedChoferShiftSession {
  id: string;
  rol: 'promotora' | 'chofer';
  personal_id: string | null;
  personal_nombre: string;
  region_id: string;
  region_nombre: string;
  sucursal: SucursalCodigo;
  ruta_codigo: string;
  duracion_horas: number;
  expires_at: string;
  last_used_at: string | null;
}

export interface StoredChoferShiftSession {
  token: string;
  session: VerifiedChoferShiftSession;
  savedAtIso: string;
}

export interface ChoferShiftBootstrapResponse {
  ok: true;
  session: VerifiedChoferShiftSession;
  entregas: Record<string, unknown>[];
  clientes: Record<string, unknown>[];
  productos: Record<string, unknown>[];
  syncedAt: string;
}

export async function verifyChoferShiftToken(
  token: string
): Promise<
  | { ok: true; session: VerifiedChoferShiftSession }
  | { ok: false; code: string; error: string }
> {
  const res = await fetch('/api/verify-shift-link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-shift-token': token,
    },
    body: JSON.stringify({ token }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    valid?: boolean;
    session?: VerifiedChoferShiftSession;
    code?: string;
    error?: string;
  };
  if (!res.ok || !payload.ok || !payload.valid || !payload.session) {
    return {
      ok: false,
      code: payload.code || `HTTP_${res.status}`,
      error: payload.error || 'Enlace de jornada expirado o revocado.',
    };
  }
  return { ok: true, session: payload.session };
}

export async function fetchChoferShiftBootstrap(
  token: string
): Promise<ChoferShiftBootstrapResponse> {
  const res = await fetch('/api/shift-links/bootstrap', {
    method: 'GET',
    headers: {
      'x-shift-token': token,
    },
  });
  const payload = (await res.json().catch(() => ({}))) as Partial<ChoferShiftBootstrapResponse> & {
    error?: string;
    code?: string;
  };
  if (res.status === 401 || res.status === 403) {
    const err = new Error(payload.error || 'Enlace de jornada expirado o revocado.') as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = payload.code || 'SESSION_REVOKED';
    throw err;
  }
  if (!res.ok || !payload.ok || !payload.session) {
    throw new Error(payload.error || 'No se pudo descargar la ruta de la jornada.');
  }

  // Precargar clientes y productos acotados en IndexedDB meta para consulta offline
  await setMeta('shift_cached_clientes', Array.isArray(payload.clientes) ? payload.clientes : []).catch(
    () => undefined
  );
  await setMeta('shift_cached_productos', Array.isArray(payload.productos) ? payload.productos : []).catch(
    () => undefined
  );

  return {
    ok: true,
    session: payload.session,
    entregas: Array.isArray(payload.entregas) ? payload.entregas : [],
    clientes: Array.isArray(payload.clientes) ? payload.clientes : [],
    productos: Array.isArray(payload.productos) ? payload.productos : [],
    syncedAt: payload.syncedAt || new Date().toISOString(),
  };
}

export async function saveChoferShiftSession(record: StoredChoferShiftSession | null): Promise<void> {
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (record) sessionStorage.setItem(CHOFER_SHIFT_SESSION_KEY, JSON.stringify(record));
      else sessionStorage.removeItem(CHOFER_SHIFT_SESSION_KEY);
    }
  } catch {
    /* ignorar */
  }
  if (record) {
    await saveShiftToken(record.token).catch(() => undefined);
    await setMeta('shift_session_meta', record).catch(() => undefined);
  } else {
    await clearShiftToken().catch(() => undefined);
  }
}

export function loadChoferShiftSessionSync(): StoredChoferShiftSession | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(CHOFER_SHIFT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredChoferShiftSession;
    if (parsed?.token && parsed?.session?.expires_at) return parsed;
  } catch {
    /* ignorar */
  }
  return null;
}

/**
 * Purga total y determinista de datos sensibles locales del Chofer al expirar,
 * revocarse o cerrarse el enlace de jornada (Regla 5).
 */
export async function purgeChoferOfflineSensitiveData(): Promise<void> {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(CHOFER_SHIFT_SESSION_KEY);
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(RUTA_PROFILE_CACHE_KEY);
    }
  } catch {
    /* ignorar */
  }

  await purgeAllOfflineData().catch(() => undefined);

  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith('workbox-precache') && !k.startsWith('rutadegustacion-fuentes'))
          .map((k) => caches.delete(k))
      );
    } catch {
      /* ignorar */
    }
  }
}
