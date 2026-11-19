import { getSupabaseClient, isSupabaseConfigured } from './supabaseClient';
import type { OperativeSucursal } from './userManagementService';

export type ShiftLinkRole = 'promotora' | 'chofer';
export type ShiftDurationHours = 8 | 12 | 24;

export interface ShiftSessionSummary {
  id: string;
  rol: ShiftLinkRole;
  personal_id: string | null;
  personal_nombre: string;
  region_id: string;
  region_nombre?: string;
  sucursal: OperativeSucursal;
  ruta_codigo: string;
  duracion_horas: ShiftDurationHours;
  created_by: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface GenerateShiftLinkRequest {
  rol: ShiftLinkRole;
  duracionHoras: ShiftDurationHours;
  rutaCodigo: string;
  personalId?: string | null;
  personalNombre?: string;
  sucursal: OperativeSucursal;
}

export interface GenerateShiftLinkResponse {
  ok: true;
  url: string;
  session: ShiftSessionSummary;
}

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

async function getActiveBearerToken(): Promise<string> {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase no está configurado en el cliente.');
  }
  const client = getSupabaseClient();
  const { data, error } = await client.auth.getSession();
  const token = data.session?.access_token?.trim() || '';
  if (error || !token) {
    throw new Error('Se requiere una sesión corporativa activa para gestionar enlaces de jornada.');
  }
  return token;
}

export async function generateSignedShiftLink(
  input: GenerateShiftLinkRequest
): Promise<GenerateShiftLinkResponse> {
  const token = await getActiveBearerToken();
  const res = await fetch('/api/generate-shift-link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-sucursal-activa': input.sucursal,
    },
    body: JSON.stringify({
      rol: input.rol,
      duracionHoras: input.duracionHoras,
      rutaCodigo: input.rutaCodigo.trim(),
      personalId: input.personalId || undefined,
      personalNombre: input.personalNombre?.trim() || undefined,
      sucursal: input.sucursal,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    url?: string;
    session?: ShiftSessionSummary;
    error?: string;
  };
  if (!res.ok || !payload.ok || !payload.url || !payload.session) {
    throw new Error(payload.error || 'No se pudo generar el enlace dinámico firmado.');
  }
  return { ok: true, url: payload.url, session: payload.session };
}

export async function listRegionShiftLinks(
  sucursal: OperativeSucursal
): Promise<ShiftSessionSummary[]> {
  const token = await getActiveBearerToken();
  const res = await fetch(`/api/shift-links?sucursal=${encodeURIComponent(sucursal)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-sucursal-activa': sucursal,
    },
  });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    sessions?: ShiftSessionSummary[];
    error?: string;
  };
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || 'No se pudieron consultar los enlaces activos.');
  }
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

export async function revokeSignedShiftLink(
  sessionId: string,
  sucursal: OperativeSucursal
): Promise<ShiftSessionSummary> {
  const token = await getActiveBearerToken();
  const res = await fetch('/api/revoke-shift-link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-sucursal-activa': sucursal,
    },
    body: JSON.stringify({ sessionId }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    session?: ShiftSessionSummary;
    error?: string;
  };
  if (!res.ok || !payload.ok || !payload.session) {
    throw new Error(payload.error || 'No se pudo revocar el enlace de jornada.');
  }
  return payload.session;
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

/**
 * Construye enlace `https://wa.me/...` seguro para compartir el enlace dinámico firmado
 * (jamás añade PII a la URL dinámica `?t=...` ni en los parámetros del portal).
 */
export function buildSignedShiftWhatsAppShareUrl(params: {
  signedUrl: string;
  rol: ShiftLinkRole;
  regionLabel: string;
  rutaCodigo: string;
  duracionHoras: ShiftDurationHours;
  personalNombre?: string;
}): string {
  const safeSigned = new URL(params.signedUrl);
  if (safeSigned.protocol !== 'https:' && safeSigned.protocol !== 'http:') {
    throw new Error('URL de enlace dinámico inválida.');
  }
  const roleTitle =
    params.rol === 'chofer' ? 'Acceso Logístico Chofer' : 'Plataforma de Promotoras';
  const greeting = params.personalNombre?.trim()
    ? `Hola ${params.personalNombre.trim()},`
    : 'Hola,';

  const text = [
    `${greeting} CODIZULCA C.A. habilitó tu enlace temporal firmado (${roleTitle}).`,
    `Región: ${params.regionLabel} · Ruta/Jornada: ${params.rutaCodigo}`,
    `Vigencia: ${params.duracionHoras} horas (modo Offline PWA habilitado).`,
    `Ingresa aquí: ${safeSigned.toString()}`,
  ].join('\n');

  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
