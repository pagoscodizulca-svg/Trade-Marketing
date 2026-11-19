import {
  ackOperation,
  claimOperation,
  countOutbox,
  dropOperation,
  getMeta,
  listOutbox,
  releaseOperation,
  setMeta,
  type OutboxItem,
} from './offlineDb';
import { construirCuerpoServidor } from './deliveryOps';

/**
 * Núcleo de sincronización de la cola de salida. Sin React ni `window`: lo usan IGUAL la página
 * (syncEngine) y el Service Worker (evento `sync`).
 */
export const OUTBOX_LOCK = 'sync-deliveries-outbox';
export const TABLE = 'entregas_degustacion';
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const MENSAJE_SIN_CONFIG = 'Sin conexión configurada: faltan las credenciales públicas de Supabase.';
const MENSAJE_SIN_SESION =
  'Sesión requerida para sincronizar entregas con el servidor. Inicie sesión para enviar cambios pendientes.';
export const AUTH_TOKEN_META_KEY = 'auth_access_token';

export interface SyncConfig {
  url: string;
  anonKey: string;
}

export interface FlushOptions {
  /** Tiempo máximo por petición. 4 000 ms para el intento inmediato tras el toque; más largo en segundo plano. */
  timeoutMs?: number;
  /** Ignora el backoff (online, volver a la app, «Reintentar ahora»). */
  force?: boolean;
}

export type FlushStatus =
  | 'idle'
  | 'ok'
  | 'offline'
  | 'backoff'
  | 'error'
  | 'locked'
  | 'sin-config'
  | 'auth-required';

export interface FlushResult {
  status: FlushStatus;
  sent: number;
  dropped: number;
  remaining: number;
  lastError: string | null;
  droppedMessages: string[];
}

export async function saveConfig(cfg: SyncConfig): Promise<void> {
  await setMeta('config', cfg);
}

export async function readConfig(): Promise<SyncConfig | null> {
  const cfg = await getMeta<SyncConfig>('config');
  return cfg && cfg.url && cfg.anonKey ? cfg : null;
}

export async function saveAuthToken(token: string | null): Promise<void> {
  await setMeta(AUTH_TOKEN_META_KEY, token ? String(token).trim() : null);
}

export async function clearAuthToken(): Promise<void> {
  await saveAuthToken(null);
}

export async function readAuthToken(): Promise<string | null> {
  const token = await getMeta<string | null>(AUTH_TOKEN_META_KEY);
  const clean = typeof token === 'string' ? token.trim() : '';
  return clean.length > 0 ? clean : null;
}

const backoffMs = (retryCount: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, retryCount));

type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'dropped'; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'transient'; message: string }
  | { kind: 'permanent'; message: string };

async function fetchConTiempo(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Construye cabeceras Zero-Trust para PostgREST: `apikey` usa la llave pública del proyecto,
 * mientras `Authorization` usa SIEMPRE el Bearer JWT del usuario autenticado (jamás `anonKey`).
 */
export function buildOutboxHeaders(
  cfg: SyncConfig,
  accessToken: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const cleanToken = String(accessToken || '').trim();
  if (!cleanToken || cleanToken === cfg.anonKey) {
    throw new Error('Token de sesión ausente o inválido para sincronización autenticada.');
  }
  return {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cleanToken}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

const esErrorDeColumna = (status: number, texto: string) =>
  status === 400 && /PGRST204|42703|hora_entrega_real|actualizado_chofer_at/i.test(texto);

/**
 * Envía UNA operación como PATCH por `id` con valores absolutos (idempotente).
 * Con las columnas opcionales de la migración, además protege el «gana el último»:
 * solo actualiza si el servidor no tiene un cambio del chofer más reciente.
 */
async function sendOperation(
  cfg: SyncConfig,
  accessToken: string,
  item: OutboxItem,
  timeoutMs: number,
): Promise<SendOutcome> {
  const base = cfg.url.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const idFiltro = `id=eq.${encodeURIComponent(item.delivery_id)}`;

  const intentar = async (conExtra: boolean): Promise<SendOutcome | { kind: 'columnas' }> => {
    const iso = encodeURIComponent(item.created_at_iso);
    const filtro = conExtra
      ? `${idFiltro}&or=(actualizado_chofer_at.is.null,actualizado_chofer_at.lte.${iso})`
      : idFiltro;
    let res: Response;
    try {
      res = await fetchConTiempo(
        `${base}/rest/v1/${TABLE}?${filtro}`,
        {
          method: 'PATCH',
          headers: buildOutboxHeaders(cfg, accessToken, { Prefer: 'return=representation' }),
          body: JSON.stringify(construirCuerpoServidor(item.payload, item.created_at_iso, conExtra)),
        },
        timeoutMs,
      );
    } catch (err) {
      const abortado = err instanceof Error && err.name === 'AbortError';
      return {
        kind: 'network',
        message: abortado ? `Sin respuesta del servidor en ${Math.round(timeoutMs / 1000)} s` : 'Sin conexión con el servidor',
      };
    }

    if (res.ok) {
      let filas: unknown;
      try {
        filas = await res.json();
      } catch {
        return { kind: 'network', message: 'Respuesta incompleta del servidor' };
      }
      if (Array.isArray(filas) && filas.length > 0) return { kind: 'ok' };
      // 0 filas: o la entrega ya no existe, o el servidor tiene un cambio del chofer más reciente.
      if (conExtra) {
        try {
          const existe = await fetchConTiempo(
            `${base}/rest/v1/${TABLE}?${idFiltro}&select=id`,
            { method: 'GET', headers: buildOutboxHeaders(cfg, accessToken) },
            timeoutMs,
          );
          if (existe.status === 401 || existe.status === 403) {
            return { kind: 'auth', message: MENSAJE_SIN_SESION };
          }
          if (existe.ok) {
            const r = (await existe.json()) as unknown[];
            if (Array.isArray(r) && r.length > 0) {
              return { kind: 'dropped', message: 'Un cambio más reciente ya estaba guardado en el servidor.' };
            }
          }
        } catch {
          return { kind: 'network', message: 'Sin conexión con el servidor' };
        }
      }
      return { kind: 'dropped', message: 'La entrega ya no existe en el servidor (el cronograma fue reemplazado).' };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'auth',
        message: 'Sesión expirada o sin permisos para actualizar esta entrega. Inicie sesión nuevamente.',
      };
    }

    const texto = await res.text().catch(() => '');
    if (conExtra && esErrorDeColumna(res.status, texto)) return { kind: 'columnas' };
    if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
      return { kind: 'transient', message: `Servidor no disponible (${res.status})` };
    }
    return { kind: 'permanent', message: `El servidor rechazó el cambio (${res.status}): ${texto.slice(0, 160)}` };
  };

  const soportaExtra = await getMeta<boolean>('server_has_extra_cols');
  if (soportaExtra !== false) {
    const r = await intentar(true);
    if (r.kind !== 'columnas') {
      if (r.kind === 'ok' && soportaExtra === undefined) await setMeta('server_has_extra_cols', true);
      return r;
    }
    // Migración opcional no aplicada: se recuerda y se reintenta sin las columnas extra.
    await setMeta('server_has_extra_cols', false);
  }
  const r2 = await intentar(false);
  return r2.kind === 'columnas' ? { kind: 'permanent', message: 'Respuesta inesperada del servidor' } : r2;
}

/**
 * Vacía la cola en orden FIFO. Solo elimina cada operación tras un `200 OK` con la fila actualizada.
 * Un fallo de red/servidor detiene el vaciado (respeta el orden); un rechazo permanente de una entrega no
 * bloquea a las demás.
 */
export async function flushOutbox(opts: FlushOptions = {}): Promise<FlushResult> {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }) : undefined;
  if (nav?.locks) {
    return nav.locks.request(OUTBOX_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        return { status: 'locked', sent: 0, dropped: 0, remaining: await countOutbox(), lastError: null, droppedMessages: [] } satisfies FlushResult;
      }
      return ejecutar(opts);
    }) as Promise<FlushResult>;
  }
  return ejecutar(opts);
}

async function ejecutar(opts: FlushOptions): Promise<FlushResult> {
  const result: FlushResult = { status: 'idle', sent: 0, dropped: 0, remaining: 0, lastError: null, droppedMessages: [] };
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;

  if (nav && nav.onLine === false) {
    result.remaining = await countOutbox();
    result.status = result.remaining > 0 ? 'offline' : 'idle';
    return result;
  }
  const cfg = await readConfig();
  if (!cfg) {
    result.remaining = await countOutbox();
    result.status = result.remaining > 0 ? 'sin-config' : 'idle';
    result.lastError = result.remaining > 0 ? MENSAJE_SIN_CONFIG : null;
    return result;
  }

  const accessToken = await readAuthToken();
  if (!accessToken || accessToken === cfg.anonKey) {
    result.remaining = await countOutbox();
    result.status = result.remaining > 0 ? 'auth-required' : 'idle';
    result.lastError = result.remaining > 0 ? MENSAJE_SIN_SESION : null;
    return result;
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const bloqueadas = new Set<string>(); // entregas que no deben avanzar en esta pasada
  const intentadas = new Set<string>();
  let huboBackoff = false;

  for (;;) {
    const items = await listOutbox();
    const siguiente = items.find((it) => !bloqueadas.has(it.delivery_id) && !intentadas.has(it.operation_id));
    if (!siguiente) break;

    if (!opts.force && (siguiente.next_attempt_at ?? 0) > Date.now()) {
      bloqueadas.add(siguiente.delivery_id);
      huboBackoff = true;
      continue;
    }
    intentadas.add(siguiente.operation_id);

    const tomada = await claimOperation(siguiente.operation_id, siguiente.created_at_iso);
    if (!tomada) {
      bloqueadas.add(siguiente.delivery_id); // se fusionó o la tiene otro enviador
      continue;
    }

    const out = await sendOperation(cfg, accessToken, tomada, timeoutMs);
    if (out.kind === 'ok') {
      await ackOperation(tomada.operation_id, tomada.delivery_id);
      result.sent += 1;
    } else if (out.kind === 'dropped') {
      await dropOperation(tomada.operation_id, tomada.delivery_id);
      result.dropped += 1;
      result.droppedMessages.push(out.message);
    } else if (out.kind === 'auth') {
      // Se conserva la operación intacta en cola hasta que el usuario renueve su sesión.
      await releaseOperation(tomada.operation_id, {
        last_error: out.message,
        next_attempt_at: Date.now() + BACKOFF_BASE_MS,
        bumpRetry: false,
      });
      result.status = 'auth-required';
      result.lastError = out.message;
      break;
    } else if (out.kind === 'network') {
      await releaseOperation(tomada.operation_id, {
        last_error: out.message,
        next_attempt_at: Date.now() + backoffMs(tomada.retry_count + 1),
        bumpRetry: true,
      });
      result.status = 'offline';
      result.lastError = out.message;
      break;
    } else if (out.kind === 'transient') {
      await releaseOperation(tomada.operation_id, {
        last_error: out.message,
        next_attempt_at: Date.now() + backoffMs(tomada.retry_count + 1),
        bumpRetry: true,
      });
      result.status = 'error';
      result.lastError = out.message;
      break;
    } else {
      // Rechazo permanente: se CONSERVA con el error visible y reintento lento; no frena a las demás entregas.
      await releaseOperation(tomada.operation_id, {
        last_error: out.message,
        next_attempt_at: Date.now() + BACKOFF_MAX_MS,
        bumpRetry: true,
      });
      bloqueadas.add(tomada.delivery_id);
      result.status = 'error';
      result.lastError = out.message;
    }
  }

  result.remaining = await countOutbox();
  if (result.status === 'idle') {
    if (result.sent > 0 || result.dropped > 0) result.status = 'ok';
    else if (result.remaining > 0 && huboBackoff) result.status = 'backoff';
  }
  return result;
}
