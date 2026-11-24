/**
 * Motor geoespacial determinista Haversine para validación de geocercas en PDV (`B-08`).
 * Cero dependencias externas, compatible con navegador y Node.js.
 */

export const EARTH_RADIUS_METERS = 6_371_000;
export const DEFAULT_GEOFENCE_RADIUS_METERS = 150;
export const MIN_GEOFENCE_RADIUS_METERS = 20;
export const MAX_GEOFENCE_RADIUS_METERS = 5000;

export interface CapturedGeolocationFix {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  capturedAtIso: string;
  locationSource?: 'gps_high' | 'wifi_cell' | 'ip_fallback';
}

export interface GeofenceEvaluationResult {
  hasPdvCoordinates: boolean;
  distanceMeters: number | null;
  allowedRadiusMeters: number;
  insideGeofence: boolean | null;
  excessMeters: number;
  requiresAuditJustification: boolean;
}

export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

export function isValidCoordinatePair(lat: unknown, lng: unknown): boolean {
  return isValidLatitude(lat) && isValidLongitude(lng);
}

export function normalizeGeofenceRadiusMeters(rawRadius?: number | null): number {
  if (typeof rawRadius !== 'number' || !Number.isFinite(rawRadius)) {
    return DEFAULT_GEOFENCE_RADIUS_METERS;
  }
  const rounded = Math.round(rawRadius);
  return Math.min(MAX_GEOFENCE_RADIUS_METERS, Math.max(MIN_GEOFENCE_RADIUS_METERS, rounded));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Calcula la distancia ortodrómica Haversine en metros entre dos coordenadas WGS84.
 * Redondea a 2 decimales para paridad exacta con `public.fn_haversine_metros` en PostgreSQL.
 */
export function calculateHaversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  if (!isValidCoordinatePair(lat1, lng1) || !isValidCoordinatePair(lat2, lng2)) {
    throw new Error('Coordenadas GPS fuera de rango WGS84 válido.');
  }

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const clampedA = Math.min(1, Math.max(0, a));
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
  const rawMeters = EARTH_RADIUS_METERS * c;
  return Math.round(rawMeters * 100) / 100;
}

/**
 * Evalúa si la posición capturada cae dentro del radio de geocerca del PDV.
 * Si el PDV no tiene coordenadas maestras cargadas, devuelve `hasPdvCoordinates: false`
 * y no bloquea la operación de campo.
 */
export function evaluateGeofenceCheck(params: {
  capturedLat: number;
  capturedLng: number;
  accuracyMeters?: number | null;
  pdvLat?: number | null;
  pdvLng?: number | null;
  allowedRadiusMeters?: number | null;
}): GeofenceEvaluationResult {
  const allowedRadiusMeters = normalizeGeofenceRadiusMeters(params.allowedRadiusMeters);

  if (!isValidCoordinatePair(params.pdvLat, params.pdvLng)) {
    return {
      hasPdvCoordinates: false,
      distanceMeters: null,
      allowedRadiusMeters,
      insideGeofence: null,
      excessMeters: 0,
      requiresAuditJustification: false,
    };
  }

  const distanceMeters = calculateHaversineDistanceMeters(
    params.capturedLat,
    params.capturedLng,
    params.pdvLat as number,
    params.pdvLng as number
  );

  const insideGeofence = distanceMeters <= allowedRadiusMeters;
  const excessMeters = insideGeofence
    ? 0
    : Math.round((distanceMeters - allowedRadiusMeters) * 100) / 100;

  return {
    hasPdvCoordinates: true,
    distanceMeters,
    allowedRadiusMeters,
    insideGeofence,
    excessMeters,
    requiresAuditJustification: !insideGeofence,
  };
}

/**
 * Captura coordenadas en vivo desde `navigator.geolocation` (con inyección opcional para pruebas).
 * Incluye respaldo automático Capa 1 (alta precisión 5s) -> Capa 2 (triangulación Wi-Fi/celular)
 * y `watchPosition` acotado con `clearWatch` garantizado para interiores.
 */
export function captureBrowserGeolocation(options?: {
  timeoutMs?: number;
  maximumAgeMs?: number;
  enableHighAccuracy?: boolean;
  geolocationApi?: Geolocation | null;
}): Promise<CapturedGeolocationFix> {
  const geo =
    options?.geolocationApi !== undefined
      ? options.geolocationApi
      : typeof navigator !== 'undefined' && navigator.geolocation
        ? navigator.geolocation
        : null;

  if (!geo || typeof geo.getCurrentPosition !== 'function') {
    return Promise.reject(
      new Error('Este dispositivo o navegador no soporta geolocalización GPS.')
    );
  }

  const timeout = Math.max(2000, Math.min(options?.timeoutMs ?? 5000, 30000));
  const maximumAge = Math.max(0, options?.maximumAgeMs ?? 20000);
  const enableHighAccuracy = options?.enableHighAccuracy !== false;

  const parseFix = (
    pos: GeolocationPosition,
    source: 'gps_high' | 'wifi_cell'
  ): CapturedGeolocationFix | null => {
    const lat = pos?.coords?.latitude;
    const lng = pos?.coords?.longitude;
    if (!isValidCoordinatePair(lat, lng)) return null;
    const acc =
      typeof pos.coords.accuracy === 'number' &&
      Number.isFinite(pos.coords.accuracy) &&
      pos.coords.accuracy >= 0
        ? Math.round(pos.coords.accuracy * 10) / 10
        : null;
    return {
      lat: Math.round(lat * 1_000_000) / 1_000_000,
      lng: Math.round(lng * 1_000_000) / 1_000_000,
      accuracyMeters: acc,
      capturedAtIso: new Date().toISOString(),
      locationSource: source,
    };
  };

  const singleAttempt = (posOpts: PositionOptions) =>
    new Promise<{ ok: true; pos: GeolocationPosition } | { ok: false; code: number }>((resolve) => {
      geo.getCurrentPosition(
        (pos) => resolve({ ok: true, pos }),
        (err) => resolve({ ok: false, code: Number(err?.code ?? 2) }),
        posOpts
      );
    });

  const watchBriefAttempt = () =>
    new Promise<{ ok: true; pos: GeolocationPosition } | { ok: false; code: number }>((resolve) => {
      if (typeof geo.watchPosition !== 'function') {
        resolve({ ok: false, code: 2 });
        return;
      }
      let settled = false;
      let watchId: number | null = null;
      const timer = setTimeout(() => finish({ ok: false, code: 3 }), 8000);
      const finish = (res: { ok: true; pos: GeolocationPosition } | { ok: false; code: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (watchId !== null && typeof geo.clearWatch === 'function') {
          try {
            geo.clearWatch(watchId);
          } catch {
            // Ignorar
          }
          watchId = null;
        }
        resolve(res);
      };
      try {
        watchId = geo.watchPosition(
          (pos) => {
            if (isValidCoordinatePair(pos?.coords?.latitude, pos?.coords?.longitude)) {
              finish({ ok: true, pos });
            }
          },
          (err) => {
            if (Number(err?.code) === 1) finish({ ok: false, code: 1 });
          },
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 120_000 }
        );
      } catch {
        finish({ ok: false, code: 2 });
      }
    });

  return (async () => {
    // Capa 1: lectura satelital rápida
    const first = await singleAttempt({ enableHighAccuracy, timeout, maximumAge });
    if (first.ok) {
      const fix = parseFix(first.pos, enableHighAccuracy ? 'gps_high' : 'wifi_cell');
      if (!fix) throw new Error('El sensor GPS devolvió coordenadas inválidas.');
      return fix;
    }

    if (first.code === 1) {
      throw new Error(
        'Permiso de ubicación denegado. Habilite el GPS del navegador para validar el PDV.'
      );
    }

    // Capa 2: fallback automático e invisible a triangulación Wi-Fi / antenas celulares
    if (enableHighAccuracy) {
      const second = await singleAttempt({
        enableHighAccuracy: false,
        timeout: 10_000,
        maximumAge: 120_000,
      });
      if (second.ok) {
        const fix = parseFix(second.pos, 'wifi_cell');
        if (fix) return fix;
      } else if (second.code === 1) {
        throw new Error(
          'Permiso de ubicación denegado. Habilite el GPS del navegador para validar el PDV.'
        );
      }

      const watched = await watchBriefAttempt();
      if (watched.ok) {
        const fix = parseFix(watched.pos, 'wifi_cell');
        if (fix) return fix;
      } else if (watched.code === 1) {
        throw new Error(
          'Permiso de ubicación denegado. Habilite el GPS del navegador para validar el PDV.'
        );
      }
    }

    if (first.code === 3) {
      throw new Error(
        'Tiempo de espera agotado al obtener señal GPS. Intente ubicarse cerca de una entrada con señal.'
      );
    }
    throw new Error('No fue posible obtener la ubicación GPS actual del dispositivo.');
  })();
}
