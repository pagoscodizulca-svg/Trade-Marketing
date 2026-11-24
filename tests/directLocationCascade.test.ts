import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import {
  buildValidatedFix,
  clearDirectLocationCache,
  getCachedFreshLocationFix,
  resolveDirectLocationCascade,
  type DirectLocationFix,
} from '../src/utils/directLocationEngine';
import { captureBrowserGeolocation } from '../src/utils/geofenceHaversine';
import { UploadAttendanceEvidenceMetadataSchema } from '../src/types/attendanceEvidences';
import {
  buildHttpsEnforceMiddleware,
  buildPermissionsPolicyValue,
  buildSecurityHeaders,
} from '../src/server/securityMiddleware';
import {
  createGeoFallbackHandler,
  extractProxyGeoHeaders,
} from '../src/server/geoFallbackHandler';
import type { AuthenticatedServerUser } from '../src/server/supabaseAdminAuth';

async function listenApp(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('DirectLocationEngine · Capa 1 éxito satelital (gps_high) + caché < 60s y expiración', async () => {
  clearDirectLocationCache();
  let calls = 0;
  let fakeNow = 1_700_000_000_000;

  const mockGeo: Partial<Geolocation> = {
    getCurrentPosition(success) {
      calls += 1;
      success({
        coords: { latitude: 10.654321, longitude: -71.640123, accuracy: 14.2 } as GeolocationCoordinates,
        timestamp: fakeNow,
      } as GeolocationPosition);
    },
  };

  const first = await resolveDirectLocationCascade({
    geolocationApi: mockGeo,
    isSecureContextOverride: true,
    enableServerFallback: false,
    now: () => fakeNow,
  });

  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.fix.locationSource, 'gps_high');
    assert.equal(first.fix.lat, 10.654321);
    assert.equal(first.fix.lng, -71.640123);
    assert.equal(first.fix.accuracyMeters, 14);
    assert.equal(first.diagnosticCode, 'NONE');
    assert.equal(first.permissionDeniedHint, false);
  }
  assert.equal(calls, 1);

  // Dentro de 30s usa caché compartida sin volver a despertar sensor GPS
  fakeNow += 30_000;
  const cached = await resolveDirectLocationCascade({
    geolocationApi: mockGeo,
    isSecureContextOverride: true,
    enableServerFallback: false,
    now: () => fakeNow,
  });
  assert.equal(cached.ok, true);
  assert.equal(calls, 1);
  assert.ok(getCachedFreshLocationFix(60_000, fakeNow));

  // Pasados 61s expira caché y re-consulta el sensor
  fakeNow += 31_000;
  const refreshed = await resolveDirectLocationCascade({
    geolocationApi: mockGeo,
    isSecureContextOverride: true,
    enableServerFallback: false,
    now: () => fakeNow,
  });
  assert.equal(refreshed.ok, true);
  assert.equal(calls, 2);
});

test('DirectLocationEngine · Capa 2A fallback invisible Wi-Fi/Celular ante TIMEOUT (code 3) y UNAVAILABLE (code 2)', async () => {
  clearDirectLocationCache();
  const seenOptions: PositionOptions[] = [];

  const mockGeo: Partial<Geolocation> = {
    getCurrentPosition(success, error, opts) {
      seenOptions.push(opts ?? {});
      if (opts?.enableHighAccuracy) {
        error?.({ code: 3, message: 'Timeout' } as GeolocationPositionError);
        return;
      }
      success({
        coords: { latitude: 10.16205, longitude: -68.00761, accuracy: 85 } as GeolocationCoordinates,
        timestamp: Date.now(),
      } as GeolocationPosition);
    },
  };

  const res = await resolveDirectLocationCascade({
    geolocationApi: mockGeo,
    isSecureContextOverride: true,
    enableServerFallback: false,
  });

  assert.equal(res.ok, true);
  assert.equal(seenOptions.length, 2);
  assert.equal(seenOptions[0].enableHighAccuracy, true);
  assert.equal(seenOptions[0].timeout, 5000);
  assert.equal(seenOptions[1].enableHighAccuracy, false);
  assert.equal(seenOptions[1].maximumAge, 120_000);
  if (res.ok) {
    assert.equal(res.fix.locationSource, 'wifi_cell');
    assert.equal(res.diagnosticCode, 'NONE');
    assert.equal(res.permissionDeniedHint, false);
  }
});

test('DirectLocationEngine · Capa 2B watchPosition en local cerrado ejecuta clearWatch inmediato y al abortar', async () => {
  clearDirectLocationCache();
  const clearedIds: number[] = [];

  const mockGeo: Partial<Geolocation> = {
    getCurrentPosition(_s, error) {
      error?.({ code: 2, message: 'Location unavailable' } as GeolocationPositionError);
    },
    watchPosition(success) {
      setTimeout(() => {
        success({
          coords: { latitude: 10.66, longitude: -71.63, accuracy: 92 } as GeolocationCoordinates,
          timestamp: Date.now(),
        } as GeolocationPosition);
      }, 10);
      return 77;
    },
    clearWatch(id: number) {
      clearedIds.push(id);
    },
  };

  const res = await resolveDirectLocationCascade({
    geolocationApi: mockGeo,
    isSecureContextOverride: true,
    enableServerFallback: false,
    watchTimeoutMs: 1000,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.fix.locationSource, 'wifi_cell');
    assert.equal(res.fix.lat, 10.66);
  }
  assert.deepEqual(clearedIds, [77], 'clearWatch debe ejecutarse inmediatamente tras la primera lectura válida');

  // Verificar también limpieza en AbortSignal (desmontaje del componente)
  clearDirectLocationCache();
  const abortedCleared: number[] = [];
  const controller = new AbortController();
  const neverResolvesGeo: Partial<Geolocation> = {
    getCurrentPosition(_s, error) {
      error?.({ code: 2, message: 'Location unavailable' } as GeolocationPositionError);
    },
    watchPosition() {
      setTimeout(() => controller.abort(), 15);
      return 88;
    },
    clearWatch(id: number) {
      abortedCleared.push(id);
    },
  };

  const abortedRes = await resolveDirectLocationCascade({
    geolocationApi: neverResolvesGeo,
    isSecureContextOverride: true,
    enableServerFallback: false,
    watchTimeoutMs: 5000,
    signal: controller.signal,
  });

  assert.equal(abortedRes.ok, false);
  assert.deepEqual(abortedCleared, [88], 'clearWatch debe ejecutarse al desmontar/abortar');
});

test('DirectLocationEngine · Capa 3 ante PERMISSION_DENIED (code 1) usa respaldo auditado sin bloquear + separa diagnóstico de contexto inseguro', async () => {
  clearDirectLocationCache();
  let getCurrentCalls = 0;
  const serverFallbackFix: DirectLocationFix = {
    lat: 10.65445,
    lng: -71.64058,
    accuracyMeters: 250,
    locationSource: 'ip_fallback',
    capturedAtMs: Date.now(),
    capturedAtIso: new Date().toISOString(),
    label: 'Geocerca PDV (351 EUROMARKET)',
    fallbackStrategy: 'pdv_geofence',
  };

  const deniedGeo: Partial<Geolocation> = {
    getCurrentPosition(_s, error) {
      getCurrentCalls += 1;
      error?.({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError);
    },
  };

  const res = await resolveDirectLocationCascade({
    geolocationApi: deniedGeo,
    isSecureContextOverride: true,
    fallbackContext: { pdvNombre: '351 EUROMARKET', region: 'Occidente', sucursal: 'ZULIA' },
    fetchServerFallback: async () => serverFallbackFix,
  });

  assert.equal(getCurrentCalls, 1, 'Ante code===1 salta directo a Capa 3 sin esperar Capa 2');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.fix.locationSource, 'ip_fallback');
    assert.equal(res.diagnosticCode, 'PERMISSION_DENIED');
    assert.equal(res.permissionDeniedHint, true);
  }

  // Contexto HTTP no seguro jamás se etiqueta como PERMISSION_DENIED
  const insecureRes = await resolveDirectLocationCascade({
    geolocationApi: deniedGeo,
    isSecureContextOverride: false,
    enableServerFallback: false,
  });
  assert.equal(insecureRes.ok, false);
  if (!insecureRes.ok) {
    assert.equal(insecureRes.diagnosticCode, 'INSECURE_CONTEXT');
    assert.equal(insecureRes.permissionDeniedHint, false);
    assert.match(insecureRes.errorMessage, /HTTPS/i);
  }
});

test('captureBrowserGeolocation · conserva compatibilidad y agrega fallback Capa 2 ante TIMEOUT', async () => {
  const res = await captureBrowserGeolocation({
    geolocationApi: {
      getCurrentPosition(success: PositionCallback, error?: PositionErrorCallback | null, opts?: PositionOptions) {
        if (opts?.enableHighAccuracy) {
          error?.({ code: 3 } as GeolocationPositionError);
          return;
        }
        success({
          coords: { latitude: 10.64, longitude: -71.62, accuracy: 42 } as GeolocationCoordinates,
        } as GeolocationPosition);
      },
    } as unknown as Geolocation,
  });

  assert.equal(res.lat, 10.64);
  assert.equal(res.lng, -71.62);
  assert.equal(res.locationSource, 'wifi_cell');
});

test('Seguridad WGS84 · validación estricta de coordenadas y locationSource en cliente, Zod y cabeceras proxy', () => {
  assert.equal(
    buildValidatedFix({ lat: 95, lng: -71, accuracyMeters: 10, locationSource: 'gps_high', capturedAtMs: Date.now() }),
    null
  );
  assert.equal(
    buildValidatedFix({ lat: 10, lng: -181, accuracyMeters: 10, locationSource: 'gps_high', capturedAtMs: Date.now() }),
    null
  );
  assert.equal(
    buildValidatedFix({ lat: 10, lng: -71, accuracyMeters: -5, locationSource: 'gps_high', capturedAtMs: Date.now() }),
    null
  );

  const validMeta = UploadAttendanceEvidenceMetadataSchema.safeParse({
    promotoraId: '42',
    fechaJornada: '2026-11-24',
    slotFoto: 'JORNADA_INGRESO',
    lat: 10.65445,
    lng: -71.64058,
    gpsAccuracy: 18,
    locationSource: 'wifi_cell',
  });
  assert.equal(validMeta.success, true);

  const invalidSource = UploadAttendanceEvidenceMetadataSchema.safeParse({
    promotoraId: '42',
    fechaJornada: '2026-11-24',
    slotFoto: 'JORNADA_INGRESO',
    lat: 10.65445,
    lng: -71.64058,
    locationSource: 'fake_spoof',
  });
  assert.equal(invalidSource.success, false);

  const invalidCoords = UploadAttendanceEvidenceMetadataSchema.safeParse({
    promotoraId: '42',
    fechaJornada: '2026-11-24',
    slotFoto: 'JORNADA_INGRESO',
    lat: 120,
    lng: -71,
    gpsAccuracy: -1,
  });
  assert.equal(invalidCoords.success, false);

  const badProxy = extractProxyGeoHeaders({
    headers: { 'cf-iplatitude': '0', 'cf-iplongitude': '0' },
  } as unknown as express.Request);
  assert.equal(badProxy, null);

  const goodProxy = extractProxyGeoHeaders({
    headers: { 'cf-iplatitude': '10.651234', 'cf-iplongitude': '-71.641234', 'cf-ipcity': 'Maracaibo' },
  } as unknown as express.Request);
  assert.ok(goodProxy);
  assert.equal(goodProxy.lat, 10.651234);
  assert.equal(goodProxy.lng, -71.641234);
});

test('Backend /api/geo/fallback-location + Permissions-Policy RFC 8941 + redirección HTTPS en Render', async () => {
  assert.equal(
    buildPermissionsPolicyValue([]),
    'geolocation=(self), camera=(self), microphone=()'
  );
  assert.equal(
    buildPermissionsPolicyValue(['https://trade-marketing-qi6j.onrender.com', 'http://inseguro.local']),
    'geolocation=(self "https://trade-marketing-qi6j.onrender.com"), camera=(self "https://trade-marketing-qi6j.onrender.com"), microphone=()'
  );

  const app = express();
  app.use(buildHttpsEnforceMiddleware({ isProduction: true }));
  for (const mw of buildSecurityHeaders({
    isProduction: true,
    allowedOrigins: ['https://trade-marketing-qi6j.onrender.com'],
  })) {
    app.use(mw);
  }
  app.use(express.json());

  const fakePromotoraUser: AuthenticatedServerUser = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'promotora.occidente@codizulca.com',
    appRole: 'promotora',
    sucursal: 'ZULIA',
    staffId: '101',
    isCoordinatorOrAdmin: false,
    isSuperAdmin: false,
    isReadOnlyViewer: false,
    accessToken: 'jwt-test',
  };

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/portal/asistencia', (_req, res) => res.send('ok'));

  const pdvHandler = createGeoFallbackHandler({
    gateway: {
      async lookupPdvCoordinates({ pdvNombre }) {
        if (pdvNombre === 'EUROMARKET') {
          return { lat: 10.67, lng: -71.61, accuracyMeters: 150, label: 'Geocerca PDV (EUROMARKET)' };
        }
        return null;
      },
    },
  });

  app.post('/api/geo/fallback-location', (req, res, next) => {
    if (req.headers.authorization === 'Bearer valid-jwt') {
      req.authUser = fakePromotoraUser;
      next();
      return;
    }
    res.status(401).json({ error: 'Autenticación requerida.' });
  }, pdvHandler);

  const srv = await listenApp(app);
  try {
    // 1. Cabecera Permissions-Policy nunca bloquea GPS y permite self + dominio oficial HTTPS
    const pageRes = await fetch(`${srv.base}/portal/asistencia`);
    const pp = pageRes.headers.get('permissions-policy') || '';
    assert.ok(!pp.includes('geolocation=()'));
    assert.match(pp, /geolocation=\(self "https:\/\/trade-marketing-qi6j\.onrender\.com"\)/);

    // 2. Redirección HTTPS en producción detrás de proxy con x-forwarded-proto: http (excluyendo /api/health)
    const redirectRes = await fetch(`${srv.base}/portal/asistencia`, {
      redirect: 'manual',
      headers: {
        'x-forwarded-host': 'trade-marketing-qi6j.onrender.com',
        'x-forwarded-proto': 'http',
      },
    });
    assert.equal(redirectRes.status, 301);
    assert.equal(redirectRes.headers.get('location'), 'https://trade-marketing-qi6j.onrender.com/portal/asistencia');

    const healthRes = await fetch(`${srv.base}/api/health`, {
      redirect: 'manual',
      headers: {
        'x-forwarded-host': 'trade-marketing-qi6j.onrender.com',
        'x-forwarded-proto': 'http',
      },
    });
    assert.equal(healthRes.status, 200);

    // 3. Sin JWT -> 401
    const unauth = await fetch(`${srv.base}/api/geo/fallback-location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdvNombre: 'EUROMARKET' }),
    });
    assert.equal(unauth.status, 401);

    // 4. Con JWT + PDV con geocerca -> pdv_geofence
    const pdvOk = await fetch(`${srv.base}/api/geo/fallback-location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-jwt' },
      body: JSON.stringify({ pdvNombre: 'EUROMARKET' }),
    });
    assert.equal(pdvOk.status, 200);
    const pdvJson = (await pdvOk.json()) as Record<string, unknown>;
    assert.equal(pdvJson.locationSource, 'ip_fallback');
    assert.equal(pdvJson.fallbackStrategy, 'pdv_geofence');
    assert.equal(pdvJson.lat, 10.67);

    // 5. Sin PDV en BD pero con intento de spoofing de sucursal CENTRO -> prevalece sucursal ZULIA/OCCIDENTE del JWT
    const hubOk = await fetch(`${srv.base}/api/geo/fallback-location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-jwt' },
      body: JSON.stringify({ pdvNombre: 'TIENDA NUEVA', sucursal: 'CENTRO', region: 'Valencia' }),
    });
    assert.equal(hubOk.status, 200);
    const hubJson = (await hubOk.json()) as Record<string, unknown>;
    assert.equal(hubJson.locationSource, 'ip_fallback');
    assert.equal(hubJson.fallbackStrategy, 'regional_hub');
    assert.equal(hubJson.lat, 10.65445, 'Debe prevalecer la sede Occidente verificada del actor autenticado');
  } finally {
    await srv.close();
  }
});
