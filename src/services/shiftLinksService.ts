import type { OperativeSucursal } from './userManagementService';

export type ShiftLinkRole = 'promotora' | 'chofer';

export interface VerifiedShiftSession {
  id: string;
  rol: ShiftLinkRole;
  personal_id: string | null;
  personal_nombre: string;
  region_id: string;
  region_nombre: string;
  sucursal: OperativeSucursal;
  ruta_codigo: string;
  duracion_horas: number;
  expires_at: string;
  last_used_at: string | null;
}

export interface ShiftBootstrapPayload {
  ok: true;
  session: VerifiedShiftSession;
  rutas: unknown[];
  entregas: unknown[];
  clientes: Array<{
    id: string;
    codigo_cliente: string;
    nombre_comercial: string;
    direccion?: string | null;
    ciudad?: string | null;
    zona?: string | null;
    ruta?: string | null;
    latitud?: number | null;
    longitud?: number | null;
    radio_geocerca_m?: number | null;
  }>;
  productos: Array<{
    id: string;
    codigo?: string | null;
    nombre: string;
    categoria?: string | null;
    marca?: string | null;
    unidad_medida?: string | null;
  }>;
  syncedAt: string;
}

export async function verifyShiftLinkToken(
  token: string
): Promise<
  | { ok: true; session: VerifiedShiftSession }
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
    session?: VerifiedShiftSession;
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

export async function fetchShiftBootstrapData(
  token: string
): Promise<ShiftBootstrapPayload> {
  const res = await fetch('/api/shift-links/bootstrap', {
    method: 'GET',
    headers: {
      'x-shift-token': token,
    },
  });
  const payload = (await res.json().catch(() => ({}))) as Partial<ShiftBootstrapPayload> & {
    error?: string;
    code?: string;
  };
  if (res.status === 401 || res.status === 403) {
    const err = new Error(payload.error || 'Sesión de jornada expirada o revocada.') as Error & {
      code?: string;
      status?: number;
    };
    err.code = payload.code || 'SESSION_EXPIRED';
    err.status = res.status;
    throw err;
  }
  if (!res.ok || !payload.ok || !payload.session) {
    throw new Error(payload.error || 'No se pudo precargar la jornada asignada.');
  }
  return {
    ok: true,
    session: payload.session,
    rutas: Array.isArray(payload.rutas) ? payload.rutas : [],
    entregas: Array.isArray(payload.entregas) ? payload.entregas : [],
    clientes: Array.isArray(payload.clientes) ? payload.clientes : [],
    productos: Array.isArray(payload.productos) ? payload.productos : [],
    syncedAt: payload.syncedAt || new Date().toISOString(),
  };
}

export interface ShiftOfflineSyncMutationInput {
  client_mutation_id: string;
  tipo: 'PROMOTORA_RUTA_STEP' | 'PROMOTORA_INCIDENCIA' | 'CHOFER_ENTREGA_PATCH';
  payload: Record<string, unknown>;
  photoBase64?: string | null;
}

export async function syncShiftOfflineMutationsBatch(
  token: string,
  mutations: ShiftOfflineSyncMutationInput[]
): Promise<{
  ok: boolean;
  synced: number;
  failed: number;
  results: Array<{
    client_mutation_id: string;
    ok: boolean;
    idempotentHit?: boolean;
    error?: string;
    code?: string;
  }>;
}> {
  const res = await fetch('/api/shift-links/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-shift-token': token,
    },
    body: JSON.stringify({ mutations }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    synced?: number;
    failed?: number;
    results?: Array<{
      client_mutation_id: string;
      ok: boolean;
      idempotentHit?: boolean;
      error?: string;
      code?: string;
    }>;
    error?: string;
    code?: string;
  };

  if (res.status === 401 || res.status === 403) {
    const err = new Error(payload.error || 'Sesión de jornada expirada o revocada.') as Error & {
      code?: string;
      status?: number;
    };
    err.code = payload.code || 'SESSION_REVOKED';
    err.status = res.status;
    throw err;
  }

  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || 'Error sincronizando lote offline.');
  }

  return {
    ok: true,
    synced: payload.synced ?? 0,
    failed: payload.failed ?? 0,
    results: Array.isArray(payload.results) ? payload.results : [],
  };
}
