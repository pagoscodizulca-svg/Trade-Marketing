/**
 * Capa de compatibilidad y resiliencia de autenticación para iOS (iPhone Safari,
 * PWA standalone, WKWebView de WhatsApp/Instagram) y Android Chrome.
 *
 * Resuelve los bloqueos reales más frecuentes en iPhone:
 *  1. Deadlocks de `navigator.locks` en WebKit/Safari con `@supabase/supabase-js` v2.
 *  2. Fallos `QuotaExceededError` / `SecurityError` en `localStorage` (Modo Privado iOS / ITP).
 *  3. Caracteres invisibles Unicode (`\u200B`, `\uFEFF`, `\u00A0`) y comillas tipográficas
 *     introducidas por el teclado predictivo de iOS o al copiar/pegar desde WhatsApp.
 */

const INVISIBLE_UNICODE_REGEX = /[\u200B-\u200D\u2060\uFEFF]/g;
const ALL_WHITESPACE_REGEX = /[\s\u00A0\u200B-\u200D\u2060\uFEFF]+/g;

/**
 * Normaliza un correo ingresado desde iOS/Android eliminando espacios ocultos,
 * NBSP y caracteres de ancho cero frecuentes al copiar desde WhatsApp/Mail.
 */
export function normalizeMobileLoginEmail(rawEmail: unknown): string {
  return String(rawEmail ?? '')
    .replace(ALL_WHITESPACE_REGEX, '')
    .trim()
    .toLowerCase();
}

/**
 * Limpia artefactos invisibles del teclado iOS / copy-paste de WhatsApp en contraseñas
 * sin alterar mayúsculas, minúsculas ni símbolos reales de la contraseña.
 */
export function sanitizeMobileLoginPassword(rawPassword: unknown): string {
  return String(rawPassword ?? '')
    .replace(INVISIBLE_UNICODE_REGEX, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

export interface MobileSafeAuthStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Almacenamiento resiliente de triple capa para Supabase Auth:
 *   `localStorage` -> `sessionStorage` -> memoria en proceso (`Map`).
 * Nunca lanza excepciones en iOS Safari Private Mode, WebViews restringidos o cuota llena.
 */
export function createMobileSafeAuthStorage(options?: {
  localStorageImpl?: Storage | null;
  sessionStorageImpl?: Storage | null;
}): MobileSafeAuthStorageAdapter {
  const memoryFallback = new Map<string, string>();

  const getLocal = (): Storage | null => {
    if (options && 'localStorageImpl' in options) return options.localStorageImpl ?? null;
    try {
      return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
      return null;
    }
  };

  const getSession = (): Storage | null => {
    if (options && 'sessionStorageImpl' in options) return options.sessionStorageImpl ?? null;
    try {
      return typeof window !== 'undefined' ? window.sessionStorage : null;
    } catch {
      return null;
    }
  };

  return {
    getItem(key: string): string | null {
      try {
        const val = getLocal()?.getItem(key);
        if (val !== null && val !== undefined) return val;
      } catch {
        /* fallback a sessionStorage */
      }
      try {
        const val = getSession()?.getItem(key);
        if (val !== null && val !== undefined) return val;
      } catch {
        /* fallback a memoria */
      }
      return memoryFallback.get(key) ?? null;
    },

    setItem(key: string, value: string): void {
      memoryFallback.set(key, value);
      try {
        getLocal()?.setItem(key, value);
        return;
      } catch {
        /* localStorage bloqueado o sin cuota (Safari Privado / iOS WebView) */
      }
      try {
        getSession()?.setItem(key, value);
      } catch {
        /* sessionStorage bloqueado: la sesión continúa operando en memoria */
      }
    },

    removeItem(key: string): void {
      memoryFallback.delete(key);
      try {
        getLocal()?.removeItem(key);
      } catch {
        /* ignorar */
      }
      try {
        getSession()?.removeItem(key);
      } catch {
        /* ignorar */
      }
    },
  };
}

export type SupabaseAuthLockFn = <R>(
  name: string,
  acquireTimeout: number,
  fn: () => Promise<R>,
) => Promise<R>;

/**
 * Lock asíncrono en memoria por clave para `@supabase/supabase-js` v2.
 * Evita los deadlocks documentados de `navigator.locks` en iOS Safari / WebKit PWA
 * cuando el teléfono suspende pestañas o abre el enlace desde WhatsApp.
 * Incluye guardia de liberación automática si una operación anterior tarda demasiado.
 */
export function createMobileSafeAuthLock(defaultTimeoutMs = 10_000): SupabaseAuthLockFn {
  const queues = new Map<string, Promise<unknown>>();

  return async <R>(
    name: string,
    acquireTimeout: number,
    fn: () => Promise<R>,
  ): Promise<R> => {
    const prev = queues.get(name) ?? Promise.resolve();
    const waitMs =
      typeof acquireTimeout === 'number' && acquireTimeout > 0
        ? Math.min(acquireTimeout, defaultTimeoutMs)
        : defaultTimeoutMs;

    let releaseCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const nextTail = prev.then(() => currentGate, () => currentGate);
    queues.set(name, nextTail);

    // Esperar al turno anterior con techo seguro para jamás colgar indefinidamente en iOS
    await Promise.race([
      prev.catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref();
        }
      }),
    ]);

    try {
      return await fn();
    } finally {
      releaseCurrent();
      if (queues.get(name) === nextTail) {
        queues.delete(name);
      }
    }
  };
}

/**
 * Envuelve `fetch` con un timeout compatible con TODOS los iPhone/iOS (incluyendo iOS 14/15
 * donde `AbortSignal.timeout()` no existe), evitando bloqueos infinitos tras volver de segundo plano.
 */
export async function fetchWithCompatibleTimeout(
  fetchFn: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  if (init?.signal || typeof AbortController === 'undefined' || timeoutMs <= 0) {
    return fetchFn(input, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  try {
    return await fetchFn(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Detecta errores típicos de conectividad / timeout de red en Safari iOS y Android Chrome. */
export function isMobileNetworkAuthError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    name === 'AbortError' ||
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    /failed to fetch|load failed|networkerror|network request failed|fetch failed|aborted|timeout|timed out|the internet connection appears to be offline/i.test(
      msg,
    )
  );
}
