/**
 * Guardián de versión e invalidación automática de caché cliente (Capas 3, 4 y 5).
 *
 * Garantiza que al desplegar una nueva versión del Dashboard o Portal:
 *  - Los usuarios obtengan automáticamente el build nuevo sin borrar caché manualmente.
 *  - Nunca se cierre la sesión de Supabase (`sb-*`, `codizulca.*`) ni se toque IndexedDB offline.
 *  - Nunca se produzca un bucle infinito de recargas (resguardo temporal en `sessionStorage`).
 *  - No se interrumpa al usuario mientras escribe activamente en un formulario.
 *  - Cualquier fallo `vite:preloadError` o importación dinámica obsoleta se recupere sola.
 */

export const VERSION_RELOAD_GUARD_KEY = 'codizulca:app_version_reload_guard';
export const PRELOAD_RELOAD_GUARD_KEY = 'codizulca:preload_reload_guard';
export const APP_UPDATE_DEFERRED_EVENT = 'codizulca:app-update-available';
export const DEFAULT_VERSION_POLL_INTERVAL_MS = 3 * 60 * 1000;
export const DEFAULT_RELOAD_COOLDOWN_MS = 60 * 1000;
export const DEFAULT_MIN_CHECK_GAP_MS = 15 * 1000;
export const DEFAULT_TRADE_CACHE_PREFIXES: readonly string[] = ['codizulca-trade-'];

export interface AppUpdateDeferredDetail {
  buildId: string;
  reason: 'version-mismatch' | 'sw-controllerchange';
}

interface ReloadGuardRecord {
  signature: string;
  at: number;
}

const CHUNK_LOAD_ERROR_PATTERNS: readonly RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /error loading dynamically imported module/i,
  /chunkloaderror/i,
  /loading chunk [\w-]+ failed/i,
  /loading css chunk [\w-]+ failed/i,
  /unable to preload css/i,
];

const EDITABLE_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'tel',
  'url',
  'password',
  'number',
  'date',
  'datetime-local',
  'time',
  'month',
  'week',
]);

export function getCurrentBuildId(): string {
  try {
    return typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__.trim() : '';
  } catch {
    return '';
  }
}

export function isValidProductionBuildId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === '__APP_BUILD_ID__' || trimmed === 'dev' || trimmed === 'development') return false;
  return /^[a-zA-Z0-9._-]{4,80}$/.test(trimmed);
}

export function isChunkLoadErrorMessage(error: unknown): boolean {
  const text =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? `${error.name} ${error.message}`
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : '';
  if (!text) return false;
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Evita recargar la pestaña justo cuando el usuario está escribiendo dentro de un campo de texto.
 */
export function isUserActivelyEditingForm(doc?: Document | null): boolean {
  const targetDoc = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!targetDoc) return false;
  const active = targetDoc.activeElement as HTMLElement | null;
  if (!active || active === targetDoc.body || active === targetDoc.documentElement) return false;

  const tag = active.tagName?.toUpperCase() ?? '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const inputType = ((active as HTMLInputElement).type || '').toLowerCase();
    return EDITABLE_INPUT_TYPES.has(inputType);
  }
  return Boolean(active.isContentEditable);
}

function getSafeSessionStorage(explicit?: Storage | null): Storage | null {
  if (explicit !== undefined) return explicit;
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function canAttemptAutoReload(
  guardKey: string,
  signature: string,
  options?: { storage?: Storage | null; now?: number; cooldownMs?: number }
): boolean {
  const storage = getSafeSessionStorage(options?.storage);
  if (!storage) return true;
  const now = options?.now ?? Date.now();
  const cooldownMs = options?.cooldownMs ?? DEFAULT_RELOAD_COOLDOWN_MS;
  try {
    const raw = storage.getItem(guardKey);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as Partial<ReloadGuardRecord>;
    if (
      parsed &&
      parsed.signature === signature &&
      typeof parsed.at === 'number' &&
      now - parsed.at < cooldownMs
    ) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

export function markAutoReloadAttempt(
  guardKey: string,
  signature: string,
  options?: { storage?: Storage | null; now?: number }
): void {
  const storage = getSafeSessionStorage(options?.storage);
  if (!storage) return;
  const now = options?.now ?? Date.now();
  try {
    const record: ReloadGuardRecord = { signature, at: now };
    storage.setItem(guardKey, JSON.stringify(record));
  } catch {
    // sessionStorage puede estar bloqueado en modo privado estricto
  }
}

/**
 * Purga exclusivamente las cachés estáticas del App Shell en Cache Storage.
 * JAMÁS toca `localStorage` (sesión Supabase `sb-*` / `codizulca.*`) ni IndexedDB offline.
 */
export async function purgeStaticShellCaches(
  prefixes: readonly string[] = DEFAULT_TRADE_CACHE_PREFIXES,
  cacheStorage?: CacheStorage | null
): Promise<string[]> {
  const targetCaches =
    cacheStorage !== undefined
      ? cacheStorage
      : typeof caches !== 'undefined'
        ? caches
        : null;
  if (!targetCaches) return [];

  try {
    const keys = await targetCaches.keys();
    const matched = keys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
    await Promise.all(matched.map((key) => targetCaches.delete(key).catch(() => false)));
    return matched;
  } catch {
    return [];
  }
}

export async function fetchServerBuildId(options?: {
  versionUrl?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<string | null> {
  const fetchFn = options?.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return null;

  const baseUrl = options?.versionUrl ?? '/version.json';
  const separator = baseUrl.includes('?') ? '&' : '?';
  const cacheBustedUrl = `${baseUrl}${separator}t=${options?.now ?? Date.now()}`;

  try {
    const res = await fetchFn(cacheBustedUrl, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) return null;

    const payload = (await res.json()) as { buildId?: unknown } | null;
    if (!payload || !isValidProductionBuildId(payload.buildId)) return null;
    return payload.buildId.trim();
  } catch {
    return null;
  }
}

export interface PerformCleanReloadOptions {
  reason: 'version-mismatch' | 'sw-controllerchange' | 'preload-error' | 'manual';
  targetSignature: string;
  guardKey?: string;
  cachePrefixes?: readonly string[];
  swScope?: string;
  storage?: Storage | null;
  cacheStorage?: CacheStorage | null;
  reload?: () => void;
  now?: number;
  cooldownMs?: number;
}

let reloadInFlight = false;

export async function performCleanVersionReload(
  options: PerformCleanReloadOptions
): Promise<boolean> {
  if (reloadInFlight && options.reason !== 'manual') return false;

  const guardKey =
    options.guardKey ??
    (options.reason === 'preload-error' ? PRELOAD_RELOAD_GUARD_KEY : VERSION_RELOAD_GUARD_KEY);

  if (
    options.reason !== 'manual' &&
    !canAttemptAutoReload(guardKey, options.targetSignature, {
      storage: options.storage,
      now: options.now,
      cooldownMs: options.cooldownMs,
    })
  ) {
    return false;
  }

  reloadInFlight = true;
  if (options.reason !== 'manual') {
    markAutoReloadAttempt(guardKey, options.targetSignature, {
      storage: options.storage,
      now: options.now,
    });
  }

  try {
    await purgeStaticShellCaches(
      options.cachePrefixes ?? DEFAULT_TRADE_CACHE_PREFIXES,
      options.cacheStorage
    );

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration(options.swScope ?? '/');
        if (reg?.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        if (reg) {
          await Promise.race([
            reg.update().catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 1200)),
          ]);
        }
      } catch {
        // continuar con recarga limpia aunque el SW no esté disponible
      }
    }

    const doReload =
      options.reload ??
      (() => {
        if (typeof window !== 'undefined') {
          window.location.reload();
        }
      });
    doReload();
    return true;
  } finally {
    // En tests (donde `reload` es un stub síncrono) liberar el candado para siguientes pruebas.
    if (options.reload) {
      reloadInFlight = false;
    }
  }
}

export function notifyDeferredAppUpdate(detail: AppUpdateDeferredDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AppUpdateDeferredDetail>(APP_UPDATE_DEFERRED_EVENT, { detail }));
}

export interface CheckAppUpdateOptions {
  localBuildId?: string;
  versionUrl?: string;
  cachePrefixes?: readonly string[];
  swScope?: string;
  respectActiveInput?: boolean;
  fetchImpl?: typeof fetch;
  storage?: Storage | null;
  cacheStorage?: CacheStorage | null;
  doc?: Document | null;
  isOnline?: boolean;
  now?: number;
  reload?: () => void;
}

export interface CheckAppUpdateResult {
  status: 'up-to-date' | 'reloading' | 'deferred' | 'skipped';
  remoteBuildId?: string;
}

export async function checkAndApplyAppUpdate(
  options: CheckAppUpdateOptions = {}
): Promise<CheckAppUpdateResult> {
  const online =
    options.isOnline ?? (typeof navigator !== 'undefined' ? navigator.onLine !== false : true);
  if (!online) return { status: 'skipped' };

  const localBuildId = options.localBuildId ?? getCurrentBuildId();
  if (!isValidProductionBuildId(localBuildId)) {
    return { status: 'skipped' };
  }

  const remoteBuildId = await fetchServerBuildId({
    versionUrl: options.versionUrl,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  if (!remoteBuildId) return { status: 'skipped' };
  if (remoteBuildId === localBuildId) return { status: 'up-to-date', remoteBuildId };

  if (options.respectActiveInput !== false && isUserActivelyEditingForm(options.doc)) {
    notifyDeferredAppUpdate({ buildId: remoteBuildId, reason: 'version-mismatch' });
    return { status: 'deferred', remoteBuildId };
  }

  const reloaded = await performCleanVersionReload({
    reason: 'version-mismatch',
    targetSignature: remoteBuildId,
    cachePrefixes: options.cachePrefixes,
    swScope: options.swScope,
    storage: options.storage,
    cacheStorage: options.cacheStorage,
    reload: options.reload,
    now: options.now,
  });

  if (!reloaded) {
    notifyDeferredAppUpdate({ buildId: remoteBuildId, reason: 'version-mismatch' });
    return { status: 'deferred', remoteBuildId };
  }
  return { status: 'reloading', remoteBuildId };
}

export function installPreloadErrorRecovery(options?: {
  cachePrefixes?: readonly string[];
  swScope?: string;
}): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const recoverFromChunkError = (signature: string) => {
    void performCleanVersionReload({
      reason: 'preload-error',
      targetSignature: signature,
      guardKey: PRELOAD_RELOAD_GUARD_KEY,
      cachePrefixes: options?.cachePrefixes ?? DEFAULT_TRADE_CACHE_PREFIXES,
      swScope: options?.swScope ?? '/',
      cooldownMs: 30 * 1000,
    });
  };

  const onVitePreloadError = (event: Event) => {
    event.preventDefault();
    const payload = (event as CustomEvent<unknown>).detail ?? (event as unknown as { payload?: unknown }).payload;
    const sig = `vite-preload:${getCurrentBuildId() || 'current'}:${String(payload ?? '').slice(0, 60)}`;
    recoverFromChunkError(sig);
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (!isChunkLoadErrorMessage(event.reason)) return;
    event.preventDefault();
    const sig = `dynamic-import:${getCurrentBuildId() || 'current'}`;
    recoverFromChunkError(sig);
  };

  window.addEventListener('vite:preloadError', onVitePreloadError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    window.removeEventListener('vite:preloadError', onVitePreloadError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}

export interface StartAppVersionGuardOptions {
  versionUrl?: string;
  pollIntervalMs?: number;
  minCheckGapMs?: number;
  cachePrefixes?: readonly string[];
  swScope?: string;
}

let activeGuardCleanup: (() => void) | null = null;

/**
 * Inicia el ciclo completo de invalidación automática de caché en el cliente:
 *  - Instala recuperación inmediata de `vite:preloadError` / fallos de chunks diferidos.
 *  - Valida `version.json` al arrancar, al recuperar foco/visibilidad, al volver online y cada 3 min.
 *  - Si detecta nueva versión mientras el usuario editaba un campo, difiere la recarga hasta salir del campo.
 */
export function startAppVersionGuard(options: StartAppVersionGuardOptions = {}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (activeGuardCleanup) return activeGuardCleanup;

  const versionUrl = options.versionUrl ?? '/version.json';
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_VERSION_POLL_INTERVAL_MS;
  const minCheckGapMs = options.minCheckGapMs ?? DEFAULT_MIN_CHECK_GAP_MS;
  const cachePrefixes = options.cachePrefixes ?? DEFAULT_TRADE_CACHE_PREFIXES;
  const swScope = options.swScope ?? '/';

  const removePreloadRecovery = installPreloadErrorRecovery({ cachePrefixes, swScope });

  let lastCheckAt = 0;
  let pendingBuildId: string | null = null;

  const runCheck = (force: boolean, respectActiveInput: boolean) => {
    const now = Date.now();
    if (!force && now - lastCheckAt < minCheckGapMs) return;
    lastCheckAt = now;

    void checkAndApplyAppUpdate({
      versionUrl,
      cachePrefixes,
      swScope,
      respectActiveInput,
      now,
    }).then((result) => {
      if (result.status === 'deferred' && result.remoteBuildId) {
        pendingBuildId = result.remoteBuildId;
      }
    });
  };

  // En el arranque inicial nadie está editando un formulario: actualizar de inmediato si el HTML quedó viejo.
  runCheck(true, false);

  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    if (pendingBuildId && !isUserActivelyEditingForm()) {
      const target = pendingBuildId;
      pendingBuildId = null;
      void performCleanVersionReload({
        reason: 'version-mismatch',
        targetSignature: target,
        cachePrefixes,
        swScope,
      });
      return;
    }
    runCheck(false, true);
  };

  const onFocus = () => runCheck(false, true);
  const onOnline = () => runCheck(true, true);
  const onFocusOut = () => {
    if (!pendingBuildId) return;
    window.setTimeout(() => {
      if (pendingBuildId && !isUserActivelyEditingForm()) {
        const target = pendingBuildId;
        pendingBuildId = null;
        void performCleanVersionReload({
          reason: 'version-mismatch',
          targetSignature: target,
          cachePrefixes,
          swScope,
        });
      }
    }, 400);
  };

  const intervalId = window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      runCheck(true, true);
    }
  }, pollIntervalMs);

  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('focusout', onFocusOut);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);

  const cleanup = () => {
    removePreloadRecovery();
    window.clearInterval(intervalId);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('focusout', onFocusOut);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
    activeGuardCleanup = null;
  };

  activeGuardCleanup = cleanup;
  return cleanup;
}
