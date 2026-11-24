import { getActiveAccessToken } from '../services/authService';
import { isValidCoordinatePair } from './geofenceHaversine';

export const LOCATION_SOURCES = ['gps_high', 'wifi_cell', 'ip_fallback'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

export type LocationDiagnosticCode =
  | 'NONE'
  | 'PERMISSION_DENIED'
  | 'POSITION_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INSECURE_CONTEXT'
  | 'UNSUPPORTED';

export type GeoFallbackStrategy = 'pdv_geofence' | 'proxy_geo_header' | 'regional_hub';

export interface DirectLocationFix {
  lat: number;
  lng: number;
  accuracyMeters: number;
  locationSource: LocationSource;
  capturedAtMs: number;
  capturedAtIso: string;
  label?: string;
  fallbackStrategy?: GeoFallbackStrategy;
}

export type DirectLocationOutcome =
  | {
      ok: true;
      fix: DirectLocationFix;
      diagnosticCode: LocationDiagnosticCode;
      permissionDeniedHint: boolean;
    }
  | {
      ok: false;
      diagnosticCode: Exclude<LocationDiagnosticCode, 'NONE'>;
      errorMessage: string;
      permissionDeniedHint: boolean;
    };

export interface FallbackLocationRequestContext {
  pdvNombre?: string | null;
  clienteId?: string | null;
  region?: string | null;
  sucursal?: string | null;
}

export type ServerFallbackFetcher = (
  ctx: FallbackLocationRequestContext,
  signal?: AbortSignal
) => Promise<DirectLocationFix | null>;

export interface DirectLocationCascadeOptions {
  /** Si true, ignora la caché de 60s y consulta de nuevo los sensores. */
  forceFresh?: boolean;
  /** En entrada inicial al módulo usa maximumAge: 45000ms para respuesta instantánea iOS/Android. */
  preferWarmCache?: boolean;
  /** Contexto del PDV/región para la Capa 3 (/api/geo/fallback-location). */
  fallbackContext?: FallbackLocationRequestContext;
  /** Habilita el respaldo Capa 3 en servidor (default: true). */
  enableServerFallback?: boolean;
  /** Señal de cancelación (desmontaje o nuevo intento) que limpia timers y watchPosition. */
  signal?: AbortSignal;
  /** Inyección determinística para pruebas unitarias. */
  geolocationApi?: Partial<Geolocation> | null;
  /** Inyección determinística de contexto seguro para pruebas. */
  isSecureContextOverride?: boolean;
  /** Inyección determinística del reloj para pruebas. */
  now?: () => number;
  /** Inyección determinística del fetcher Capa 3 para pruebas. */
  fetchServerFallback?: ServerFallbackFetcher;
  /** Timeouts configurables (usados principalmente en pruebas). */
  layer1TimeoutMs?: number;
  layer2TimeoutMs?: number;
  watchTimeoutMs?: number;
}

export const FRESH_LOCATION_CACHE_TTL_MS = 60_000;
export const PREWARM_MAXIMUM_AGE_MS = 45_000;
export const LAYER1_HIGH_ACCURACY_TIMEOUT_MS = 5_000;
export const LAYER1_HIGH_ACCURACY_MAX_AGE_MS = 20_000;
export const LAYER2_WIFI_CELL_TIMEOUT_MS = 10_000;
export const LAYER2_WIFI_CELL_MAX_AGE_MS = 120_000;
export const LAYER2_WATCH_MAX_MS = 8_000;

export const IOS_SAFARI_GPS_COMPACT_HINT =
  'GPS exacto en Safari iOS: toca [aA / ≡] en la barra → Configuración del sitio web → Ubicación: Permitir.';

let recentDeviceFixCache: DirectLocationFix | null = null;

function roundCoord(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}

export function normalizeValidatedAccuracy(rawAccuracy: unknown, defaultMeters = 25): number {
  const num = Number(rawAccuracy);
  if (!Number.isFinite(num) || num < 0) return defaultMeters;
  return Math.min(100_000, Math.round(num));
}

export function buildValidatedFix(params: {
  lat: unknown;
  lng: unknown;
  accuracyMeters: unknown;
  locationSource: LocationSource;
  capturedAtMs: number;
  label?: string;
  fallbackStrategy?: GeoFallbackStrategy;
}): DirectLocationFix | null {
  const lat = Number(params.lat);
  const lng = Number(params.lng);
  if (!isValidCoordinatePair(lat, lng)) {
    return null;
  }
  const acc = Number(params.accuracyMeters);
  if (!Number.isFinite(acc) || acc < 0) {
    return null;
  }
  return {
    lat: roundCoord(lat),
    lng: roundCoord(lng),
    accuracyMeters: Math.min(100_000, Math.round(acc)),
    locationSource: params.locationSource,
    capturedAtMs: params.capturedAtMs,
    capturedAtIso: new Date(params.capturedAtMs).toISOString(),
    ...(params.label ? { label: params.label } : {}),
    ...(params.fallbackStrategy ? { fallbackStrategy: params.fallbackStrategy } : {}),
  };
}

export function rememberDirectLocationFix(fix: DirectLocationFix): void {
  // Solo persistimos en caché prioritaria lecturas reales de sensor (gps_high / wifi_cell)
  if (fix.locationSource === 'gps_high' || fix.locationSource === 'wifi_cell') {
    recentDeviceFixCache = fix;
  }
}

export function getCachedFreshLocationFix(
  maxAgeMs: number = FRESH_LOCATION_CACHE_TTL_MS,
  nowMs: number = Date.now()
): DirectLocationFix | null {
  if (!recentDeviceFixCache) return null;
  const age = nowMs - recentDeviceFixCache.capturedAtMs;
  if (age < 0 || age > maxAgeMs) {
    return null;
  }
  return recentDeviceFixCache;
}

export function clearDirectLocationCache(): void {
  recentDeviceFixCache = null;
}

export function isLocationSource(value: unknown): value is LocationSource {
  return (
    value === 'gps_high' || value === 'wifi_cell' || value === 'ip_fallback'
  );
}

export function formatLocationSourceLabel(source?: LocationSource | string | null): string {
  if (source === 'gps_high') return 'GPS Satelital';
  if (source === 'wifi_cell') return 'Triangulación Wi-Fi / Celular';
  if (source === 'ip_fallback') return 'Respaldo Red / PDV';
  return 'GPS';
}

export function describeLocationDiagnostic(code: LocationDiagnosticCode): string {
  switch (code) {
    case 'PERMISSION_DENIED':
      return 'Ubicación bloqueada en los ajustes del navegador/teléfono. Se requiere habilitarla para precisión satelital exacta.';
    case 'POSITION_UNAVAILABLE':
      return 'Señal GPS no disponible bajo techo o sin cobertura satelital en este punto.';
    case 'TIMEOUT':
      return 'Tiempo de espera agotado buscando señal satelital en interiores.';
    case 'INSECURE_CONTEXT':
      return 'La geolocalización del navegador requiere conexión segura HTTPS.';
    case 'UNSUPPORTED':
      return 'Este dispositivo o navegador no expone el sensor de geolocalización.';
    default:
      return '';
  }
}

function isBrowserSecureContext(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  if (typeof window === 'undefined') return true;
  if (window.isSecureContext) return true;
  const host = String(window.location?.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function mapPositionErrorCode(err: unknown): Exclude<LocationDiagnosticCode, 'NONE' | 'INSECURE_CONTEXT' | 'UNSUPPORTED'> {
  const code = Number((err as { code?: unknown } | null)?.code);
  if (code === 1) return 'PERMISSION_DENIED';
  if (code === 2) return 'POSITION_UNAVAILABLE';
  return 'TIMEOUT';
}

function querySinglePosition(
  geo: Partial<Geolocation>,
  posOptions: PositionOptions,
  signal?: AbortSignal
): Promise<
  | { ok: true; position: GeolocationPosition }
  | { ok: false; code: Exclude<LocationDiagnosticCode, 'NONE' | 'INSECURE_CONTEXT' | 'UNSUPPORTED'>; aborted?: boolean }
> {
  if (typeof geo.getCurrentPosition !== 'function') {
    return Promise.resolve({ ok: false, code: 'POSITION_UNAVAILABLE' });
  }
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, code: 'TIMEOUT', aborted: true });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result:
        | { ok: true; position: GeolocationPosition }
        | {
            ok: false;
            code: Exclude<LocationDiagnosticCode, 'NONE' | 'INSECURE_CONTEXT' | 'UNSUPPORTED'>;
            aborted?: boolean;
          }
    ) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => finish({ ok: false, code: 'TIMEOUT', aborted: true });
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      geo.getCurrentPosition!(
        (pos) => finish({ ok: true, position: pos }),
        (err) => finish({ ok: false, code: mapPositionErrorCode(err) }),
        posOptions
      );
    } catch {
      finish({ ok: false, code: 'POSITION_UNAVAILABLE' });
    }
  });
}

/**
 * Capa 2B: `watchPosition` breve (máx. 8s) que toma la primera lectura válida Wi-Fi/Celular
 * y ejecuta `navigator.geolocation.clearWatch(watchId)` de inmediato para proteger batería y privacidad.
 */
function watchSingleValidPosition(
  geo: Partial<Geolocation>,
  options: { timeoutMs: number; maximumAgeMs: number; signal?: AbortSignal }
): Promise<
  | { ok: true; position: GeolocationPosition }
  | { ok: false; code: Exclude<LocationDiagnosticCode, 'NONE' | 'INSECURE_CONTEXT' | 'UNSUPPORTED'>; aborted?: boolean }
> {
  if (typeof geo.watchPosition !== 'function') {
    return Promise.resolve({ ok: false, code: 'POSITION_UNAVAILABLE' });
  }
  if (options.signal?.aborted) {
    return Promise.resolve({ ok: false, code: 'TIMEOUT', aborted: true });
  }

  return new Promise((resolve) => {
    let settled = false;
    let watchId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (watchId !== null && typeof geo.clearWatch === 'function') {
        try {
          geo.clearWatch(watchId);
        } catch {
          // Ignorar fallo de clearWatch al desmontar
        }
        watchId = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (
      result:
        | { ok: true; position: GeolocationPosition }
        | {
            ok: false;
            code: Exclude<LocationDiagnosticCode, 'NONE' | 'INSECURE_CONTEXT' | 'UNSUPPORTED'>;
            aborted?: boolean;
          }
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => finish({ ok: false, code: 'TIMEOUT', aborted: true });
    options.signal?.addEventListener('abort', onAbort, { once: true });

    timerId = setTimeout(() => {
      finish({ ok: false, code: 'TIMEOUT' });
    }, Math.max(500, options.timeoutMs));

    try {
      const id = geo.watchPosition!(
        (pos) => {
          const lat = pos?.coords?.latitude;
          const lng = pos?.coords?.longitude;
          if (isValidCoordinatePair(lat, lng)) {
            finish({ ok: true, position: pos });
          }
        },
        (err) => {
          const mapped = mapPositionErrorCode(err);
          // Ante PERMISSION_DENIED abortamos el watch inmediatamente; en errores transitorios esperamos hasta timeout
          if (mapped === 'PERMISSION_DENIED') {
            finish({ ok: false, code: 'PERMISSION_DENIED' });
          }
        },
        {
          enableHighAccuracy: false,
          timeout: Math.max(1000, options.timeoutMs),
          maximumAge: options.maximumAgeMs,
        }
      );
      if (settled) {
        if (typeof geo.clearWatch === 'function') {
          try {
            geo.clearWatch(id);
          } catch {
            // Ignorar
          }
        }
      } else {
        watchId = id;
      }
    } catch {
      finish({ ok: false, code: 'POSITION_UNAVAILABLE' });
    }
  });
}

/**
 * Capa 3: Consulta al endpoint interno autenticado `/api/geo/fallback-location`
 * para obtener ubicación aproximada por geocerca del PDV asignado / cabeceras de red / hub regional.
 */
export async function fetchServerFallbackLocation(
  ctx: FallbackLocationRequestContext = {},
  signal?: AbortSignal
): Promise<DirectLocationFix | null> {
  if (typeof fetch !== 'function') return null;
  if (signal?.aborted) return null;

  const token = await getActiveAccessToken().catch(() => null);
  if (!token) return null;

  try {
    const res = await fetch('/api/geo/fallback-location', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pdvNombre: ctx.pdvNombre ? String(ctx.pdvNombre).trim().slice(0, 180) : null,
        clienteId: ctx.clienteId ? String(ctx.clienteId).trim().slice(0, 64) : null,
        region: ctx.region ? String(ctx.region).trim().slice(0, 64) : null,
        sucursal: ctx.sucursal ? String(ctx.sucursal).trim().slice(0, 64) : null,
      }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      lat?: unknown;
      lng?: unknown;
      accuracyMeters?: unknown;
      locationSource?: unknown;
      fallbackStrategy?: GeoFallbackStrategy;
      label?: string;
      capturedAtIso?: string;
    } | null;

    if (!data?.ok) return null;
    const nowMs = Date.now();
    return buildValidatedFix({
      lat: data.lat,
      lng: data.lng,
      accuracyMeters: data.accuracyMeters ?? 5000,
      locationSource: 'ip_fallback',
      capturedAtMs: nowMs,
      label: typeof data.label === 'string' ? data.label : 'Respaldo Red / PDV',
      fallbackStrategy: data.fallbackStrategy,
    });
  } catch {
    return null;
  }
}

/**
 * Disparo ligero de pre-calentamiento pensado para invocarse sincrónicamente dentro de un gesto
 * natural del usuario (ej. tocar la pestaña "Asistencia") para satisfacer la política WebKit de iOS Safari.
 */
export function prewarmBrowserGeolocationOnGesture(
  geolocationApi?: Partial<Geolocation> | null
): void {
  const geo =
    geolocationApi !== undefined
      ? geolocationApi
      : typeof navigator !== 'undefined' && navigator.geolocation
        ? navigator.geolocation
        : null;
  if (!geo || typeof geo.getCurrentPosition !== 'function') return;
  if (!isBrowserSecureContext()) return;
  if (getCachedFreshLocationFix(FRESH_LOCATION_CACHE_TTL_MS)) return;

  try {
    geo.getCurrentPosition(
      (pos) => {
        const fix = buildValidatedFix({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyMeters: normalizeValidatedAccuracy(pos.coords.accuracy, 20),
          locationSource:
            typeof pos.coords.accuracy === 'number' && pos.coords.accuracy <= 100
              ? 'gps_high'
              : 'wifi_cell',
          capturedAtMs: Date.now(),
        });
        if (fix) rememberDirectLocationFix(fix);
      },
      () => {
        // Silencioso: el pre-calentamiento nunca muestra errores en UI
      },
      {
        enableHighAccuracy: true,
        timeout: LAYER1_HIGH_ACCURACY_TIMEOUT_MS,
        maximumAge: PREWARM_MAXIMUM_AGE_MS,
      }
    );
  } catch {
    // Silencioso
  }
}

/**
 * Motor de Captura Directa en Cascada de 3 Capas:
 *  - Memoria reciente (< 60s) para respuesta instantánea sin re-encender radio GPS.
 *  - Capa 1: GPS satelital rápido (`enableHighAccuracy: true, timeout: 5s, maximumAge: 20s/45s`).
 *  - Capa 2 (invisible): Fallback Wi-Fi / Celular (`enableHighAccuracy: false, timeout: 10s, maximumAge: 120s`)
 *    + `watchPosition` breve (`<= 8s`) con `clearWatch` garantizado tras la primera lectura válida.
 *  - Capa 3 (cero bloqueo): Contingencia auditada `/api/geo/fallback-location` (`location_source: 'ip_fallback'`).
 */
export async function resolveDirectLocationCascade(
  options: DirectLocationCascadeOptions = {}
): Promise<DirectLocationOutcome> {
  const nowFn = options.now ?? (() => Date.now());
  const enableServerFallback = options.enableServerFallback !== false;
  const fallbackFetcher = options.fetchServerFallback ?? fetchServerFallbackLocation;

  // 0. Coordenada válida reciente en memoria (< 60s)
  if (!options.forceFresh) {
    const cached = getCachedFreshLocationFix(FRESH_LOCATION_CACHE_TTL_MS, nowFn());
    if (cached) {
      return {
        ok: true,
        fix: cached,
        diagnosticCode: 'NONE',
        permissionDeniedHint: false,
      };
    }
  }

  const runServerFallback = async (
    diagnosticCode: Exclude<LocationDiagnosticCode, 'NONE'>
  ): Promise<DirectLocationOutcome> => {
    const permissionDeniedHint = diagnosticCode === 'PERMISSION_DENIED';
    if (enableServerFallback && !options.signal?.aborted) {
      const serverFix = await fallbackFetcher(options.fallbackContext ?? {}, options.signal).catch(
        () => null
      );
      if (serverFix) {
        return {
          ok: true,
          fix: serverFix,
          diagnosticCode,
          permissionDeniedHint,
        };
      }
    }
    return {
      ok: false,
      diagnosticCode,
      errorMessage: describeLocationDiagnostic(diagnosticCode),
      permissionDeniedHint,
    };
  };

  // Validar contexto seguro HTTPS antes de culpar permisos
  if (!isBrowserSecureContext(options.isSecureContextOverride)) {
    return runServerFallback('INSECURE_CONTEXT');
  }

  const geo =
    options.geolocationApi !== undefined
      ? options.geolocationApi
      : typeof navigator !== 'undefined' && navigator.geolocation
        ? navigator.geolocation
        : null;

  if (!geo || typeof geo.getCurrentPosition !== 'function') {
    return runServerFallback('UNSUPPORTED');
  }

  // CAPA 1 -> Satelital rápido (alta precisión)
  const layer1Res = await querySinglePosition(
    geo,
    {
      enableHighAccuracy: true,
      timeout: options.layer1TimeoutMs ?? LAYER1_HIGH_ACCURACY_TIMEOUT_MS,
      maximumAge: options.preferWarmCache
        ? PREWARM_MAXIMUM_AGE_MS
        : LAYER1_HIGH_ACCURACY_MAX_AGE_MS,
    },
    options.signal
  );

  if (layer1Res.ok) {
    const fix = buildValidatedFix({
      lat: layer1Res.position.coords.latitude,
      lng: layer1Res.position.coords.longitude,
      accuracyMeters: normalizeValidatedAccuracy(layer1Res.position.coords.accuracy, 15),
      locationSource: 'gps_high',
      capturedAtMs: nowFn(),
    });
    if (fix) {
      rememberDirectLocationFix(fix);
      return {
        ok: true,
        fix,
        diagnosticCode: 'NONE',
        permissionDeniedHint: false,
      };
    }
  } else if (layer1Res.aborted) {
    return {
      ok: false,
      diagnosticCode: 'TIMEOUT',
      errorMessage: describeLocationDiagnostic('TIMEOUT'),
      permissionDeniedHint: false,
    };
  } else if (layer1Res.code === 'PERMISSION_DENIED') {
    // Permiso denegado en navegador/SO -> saltar directo a Capa 3 auditada (sin bloqueo)
    return runServerFallback('PERMISSION_DENIED');
  }

  // CAPA 2A -> Fallback invisible a Wi-Fi / antenas celulares (sin mostrar error en pantalla)
  const layer2ARes = await querySinglePosition(
    geo,
    {
      enableHighAccuracy: false,
      timeout: options.layer2TimeoutMs ?? LAYER2_WIFI_CELL_TIMEOUT_MS,
      maximumAge: LAYER2_WIFI_CELL_MAX_AGE_MS,
    },
    options.signal
  );

  if (layer2ARes.ok) {
    const fix = buildValidatedFix({
      lat: layer2ARes.position.coords.latitude,
      lng: layer2ARes.position.coords.longitude,
      accuracyMeters: normalizeValidatedAccuracy(layer2ARes.position.coords.accuracy, 65),
      locationSource: 'wifi_cell',
      capturedAtMs: nowFn(),
    });
    if (fix) {
      rememberDirectLocationFix(fix);
      return {
        ok: true,
        fix,
        diagnosticCode: 'NONE',
        permissionDeniedHint: false,
      };
    }
  } else if (layer2ARes.aborted) {
    return {
      ok: false,
      diagnosticCode: 'TIMEOUT',
      errorMessage: describeLocationDiagnostic('TIMEOUT'),
      permissionDeniedHint: false,
    };
  } else if (layer2ARes.code === 'PERMISSION_DENIED') {
    return runServerFallback('PERMISSION_DENIED');
  }

  // CAPA 2B -> watchPosition breve (máx. 8s) que toma primera lectura válida y ejecuta clearWatch inmediato
  const watchRes = await watchSingleValidPosition(geo, {
    timeoutMs: options.watchTimeoutMs ?? LAYER2_WATCH_MAX_MS,
    maximumAgeMs: LAYER2_WIFI_CELL_MAX_AGE_MS,
    signal: options.signal,
  });

  if (watchRes.ok) {
    const fix = buildValidatedFix({
      lat: watchRes.position.coords.latitude,
      lng: watchRes.position.coords.longitude,
      accuracyMeters: normalizeValidatedAccuracy(watchRes.position.coords.accuracy, 80),
      locationSource: 'wifi_cell',
      capturedAtMs: nowFn(),
    });
    if (fix) {
      rememberDirectLocationFix(fix);
      return {
        ok: true,
        fix,
        diagnosticCode: 'NONE',
        permissionDeniedHint: false,
      };
    }
  } else if (watchRes.aborted) {
    return {
      ok: false,
      diagnosticCode: 'TIMEOUT',
      errorMessage: describeLocationDiagnostic('TIMEOUT'),
      permissionDeniedHint: false,
    };
  } else if (watchRes.code === 'PERMISSION_DENIED') {
    return runServerFallback('PERMISSION_DENIED');
  }

  // CAPA 3 -> Contingencia auditada cuando el local cerrado bloquea toda señal satelital/Wi-Fi
  const finalDiag: Exclude<LocationDiagnosticCode, 'NONE'> = !layer1Res.ok
    ? layer1Res.code
    : !layer2ARes.ok
      ? layer2ARes.code
      : 'POSITION_UNAVAILABLE';
  return runServerFallback(finalDiag);
}
