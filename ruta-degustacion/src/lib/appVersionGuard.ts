/**
 * Guardián de versión e invalidación automática de caché para RutaDegustación (`/logistica`).
 *
 * - Consulta `${BASE_URL}version.json` con `cache: 'no-store'` al arrancar, al volver a primer plano,
 *   al reconectar y periódicamente cada 5 minutos.
 * - Purga únicamente cachés precacheadas de Workbox (`workbox-precache`), preservando SIEMPRE
 *   la sesión de Supabase y la cola offline de entregas en IndexedDB (`rutadegustacion-offline`).
 * - Si el chofer no está llenando un campo, actualiza automáticamente; si está editando un formulario,
 *   avisa vía `EVENTO_ACTUALIZACION_SW` para que no pierda datos.
 * - Auto-recupera fallos `vite:preloadError` / importación dinámica tras despliegues.
 */

export const EVENTO_ACTUALIZACION_SW = 'rd:sw-update';
export const RUTA_VERSION_RELOAD_GUARD_KEY = 'codizulca:ruta_version_reload_guard';
export const RUTA_PRELOAD_RELOAD_GUARD_KEY = 'codizulca:ruta_preload_reload_guard';
export const RUTA_CACHE_PREFIXES: readonly string[] = ['workbox-precache', 'ruta-degustacion-'];
const RUTA_POLL_INTERVAL_MS = 5 * 60 * 1000;
const RUTA_MIN_CHECK_GAP_MS = 15 * 1000;
const RUTA_RELOAD_COOLDOWN_MS = 60 * 1000;

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
]);

function getRutaBuildId(): string {
  try {
    return typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__.trim() : '';
  } catch {
    return '';
  }
}

function isValidBuildId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '__APP_BUILD_ID__' || trimmed === 'dev') return false;
  return /^[a-zA-Z0-9._-]{4,80}$/.test(trimmed);
}

export function isRutaUserEditingForm(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || active === document.documentElement) return false;
  const tag = active.tagName?.toUpperCase() ?? '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    return EDITABLE_INPUT_TYPES.has(((active as HTMLInputElement).type || '').toLowerCase());
  }
  return Boolean(active.isContentEditable);
}

function isChunkError(err: unknown): boolean {
  const text =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? `${err.name} ${err.message}`
        : '';
  return Boolean(text) && CHUNK_LOAD_ERROR_PATTERNS.some((re) => re.test(text));
}

function canReloadWithGuard(guardKey: string, signature: string, cooldownMs = RUTA_RELOAD_COOLDOWN_MS): boolean {
  try {
    const raw = window.sessionStorage.getItem(guardKey);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as Partial<ReloadGuardRecord>;
    if (parsed?.signature === signature && typeof parsed.at === 'number' && Date.now() - parsed.at < cooldownMs) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function markReloadGuard(guardKey: string, signature: string): void {
  try {
    window.sessionStorage.setItem(guardKey, JSON.stringify({ signature, at: Date.now() }));
  } catch {
    // ignorar si sessionStorage está restringido
  }
}

export async function purgeRutaStaticCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => RUTA_CACHE_PREFIXES.some((prefix) => k.startsWith(prefix)))
        .map((k) => caches.delete(k).catch(() => false)),
    );
  } catch {
    // ignorar fallos de Cache Storage
  }
}

let reloadInProgress = false;

export async function performCleanRutaReload(options: {
  signature: string;
  guardKey?: string;
  manual?: boolean;
  cooldownMs?: number;
}): Promise<boolean> {
  if (reloadInProgress && !options.manual) return false;
  const guardKey = options.guardKey ?? RUTA_VERSION_RELOAD_GUARD_KEY;
  if (!options.manual && !canReloadWithGuard(guardKey, options.signature, options.cooldownMs)) {
    return false;
  }

  reloadInProgress = true;
  if (!options.manual) {
    markReloadGuard(guardKey, options.signature);
  }

  await purgeRutaStaticCaches();

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
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
      // continuar con recarga
    }
  }

  window.location.reload();
  return true;
}

async function fetchRutaServerBuildId(): Promise<string | null> {
  const versionUrl = `${import.meta.env.BASE_URL}version.json?t=${Date.now()}`;
  try {
    const res = await fetch(versionUrl, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return null;
    const data = (await res.json()) as { buildId?: unknown } | null;
    return data && isValidBuildId(data.buildId) ? data.buildId.trim() : null;
  } catch {
    return null;
  }
}

let started = false;

export function startRutaVersionGuard(): void {
  if (typeof window === 'undefined' || started) return;
  started = true;

  // Capa 5: recuperación inmediata ante fallos de carga de módulos diferidos tras un deploy.
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    void performCleanRutaReload({
      signature: `ruta-preload:${getRutaBuildId() || 'current'}`,
      guardKey: RUTA_PRELOAD_RELOAD_GUARD_KEY,
      cooldownMs: 30 * 1000,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (!isChunkError(event.reason)) return;
    event.preventDefault();
    void performCleanRutaReload({
      signature: `ruta-dynamic-import:${getRutaBuildId() || 'current'}`,
      guardKey: RUTA_PRELOAD_RELOAD_GUARD_KEY,
      cooldownMs: 30 * 1000,
    });
  });

  if (!import.meta.env.PROD) return;

  const localBuildId = getRutaBuildId();
  if (!isValidBuildId(localBuildId)) return;

  let lastCheckAt = 0;
  let pendingBuildId: string | null = null;

  const checkVersion = (force: boolean, respectInput: boolean) => {
    if (navigator.onLine === false) return;
    const now = Date.now();
    if (!force && now - lastCheckAt < RUTA_MIN_CHECK_GAP_MS) return;
    lastCheckAt = now;

    void fetchRutaServerBuildId().then(async (remoteBuildId) => {
      if (!remoteBuildId || remoteBuildId === localBuildId) return;

      if (respectInput && isRutaUserEditingForm()) {
        pendingBuildId = remoteBuildId;
        const reg =
          'serviceWorker' in navigator
            ? await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL).catch(() => undefined)
            : undefined;
        window.dispatchEvent(new CustomEvent(EVENTO_ACTUALIZACION_SW, { detail: reg ?? null }));
        return;
      }

      const reloaded = await performCleanRutaReload({ signature: remoteBuildId });
      if (!reloaded) {
        pendingBuildId = remoteBuildId;
        window.dispatchEvent(new CustomEvent(EVENTO_ACTUALIZACION_SW, { detail: null }));
      }
    });
  };

  // En arranque frío nadie está editando un formulario: actualizar de inmediato si el App Shell quedó viejo.
  checkVersion(true, false);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (pendingBuildId && !isRutaUserEditingForm()) {
      const target = pendingBuildId;
      pendingBuildId = null;
      void performCleanRutaReload({ signature: target });
      return;
    }
    checkVersion(false, true);
  });

  document.addEventListener('focusout', () => {
    if (!pendingBuildId) return;
    window.setTimeout(() => {
      if (pendingBuildId && !isRutaUserEditingForm()) {
        const target = pendingBuildId;
        pendingBuildId = null;
        void performCleanRutaReload({ signature: target });
      }
    }, 400);
  });

  window.addEventListener('focus', () => checkVersion(false, true));
  window.addEventListener('online', () => checkVersion(true, true));
  window.setInterval(() => {
    if (document.visibilityState === 'visible') checkVersion(true, true);
  }, RUTA_POLL_INTERVAL_MS);
}
