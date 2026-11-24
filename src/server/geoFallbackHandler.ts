import type { Request, Response } from 'express';
import { z } from 'zod';
import { isValidCoordinatePair, normalizeGeofenceRadiusMeters } from '../utils/geofenceHaversine';
import { serverLogger } from './logger';
import {
  type AuthenticatedServerUser,
  createUserScopedSupabaseClient,
  isOperativeServerSucursal,
  normalizeOperativeServerSucursal,
} from './supabaseAdminAuth';

export type GeoFallbackStrategy = 'pdv_geofence' | 'proxy_geo_header' | 'regional_hub';

export interface GeoFallbackPdvMatch {
  lat: number;
  lng: number;
  accuracyMeters: number;
  label: string;
}

export interface GeoFallbackGateway {
  lookupPdvCoordinates(params: {
    authUser: AuthenticatedServerUser;
    clienteId?: string | null;
    pdvNombre?: string | null;
  }): Promise<GeoFallbackPdvMatch | null>;
}

const GeoFallbackBodySchema = z
  .object({
    pdvNombre: z.string().trim().max(180).optional().nullable(),
    clienteId: z.string().trim().max(64).optional().nullable(),
    region: z.string().trim().max(64).optional().nullable(),
    sucursal: z.string().trim().max(64).optional().nullable(),
  })
  .strict();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REGIONAL_HUB_COORDS: Record<
  'OCCIDENTE' | 'CENTRO' | 'ORIENTE' | 'CAPITAL',
  { lat: number; lng: number; label: string }
> = {
  OCCIDENTE: { lat: 10.65445, lng: -71.64058, label: 'Sede Occidente (Maracaibo)' },
  CENTRO: { lat: 10.16202, lng: -68.00765, label: 'Sede Centro (Valencia)' },
  ORIENTE: { lat: 10.13625, lng: -64.68618, label: 'Sede Oriente (Barcelona)' },
  CAPITAL: { lat: 10.48059, lng: -66.90361, label: 'Sede Capital (Caracas)' },
};

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function readSingleHeader(req: Request, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] ?? '').trim();
  return String(raw ?? '').trim();
}

export function extractProxyGeoHeaders(req: Request): {
  lat: number;
  lng: number;
  accuracyMeters: number;
  label: string;
} | null {
  const pairs: ReadonlyArray<[string, string, string]> = [
    ['cf-iplatitude', 'cf-iplongitude', 'cf-ipcity'],
    ['x-geo-latitude', 'x-geo-longitude', 'x-geo-city'],
    ['x-vercel-ip-latitude', 'x-vercel-ip-longitude', 'x-vercel-ip-city'],
  ];

  for (const [latKey, lngKey, cityKey] of pairs) {
    const rawLat = readSingleHeader(req, latKey);
    const rawLng = readSingleHeader(req, lngKey);
    if (!rawLat || !rawLng) continue;
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    if (!isValidCoordinatePair(lat, lng)) continue;
    // Evitar coordenadas nulas (0, 0) emitidas por proxies sin geolocalización real
    if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) continue;
    const city = readSingleHeader(req, cityKey).replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 60);
    return {
      lat: roundCoord(lat),
      lng: roundCoord(lng),
      accuracyMeters: 2500,
      label: city ? `Red servidor (${city})` : 'Red servidor (IP aproximada)',
    };
  }
  return null;
}

function resolveHubKey(params: {
  authSucursal?: string | null;
  requestedSucursal?: string | null;
  requestedRegion?: string | null;
}): 'OCCIDENTE' | 'CENTRO' | 'ORIENTE' | 'CAPITAL' {
  // Prioridad de seguridad: la sucursal verificada del actor autenticado prevalece sobre cualquier texto del cliente
  const actorOp = normalizeOperativeServerSucursal(params.authSucursal);
  if (actorOp === 'VALENCIA' || actorOp === 'CENTRO') return 'CENTRO';
  if (actorOp === 'ORIENTE') return 'ORIENTE';
  if (actorOp === 'CAPITAL') return 'CAPITAL';
  if (actorOp === 'ZULIA') return 'OCCIDENTE';

  const reqOp = normalizeOperativeServerSucursal(params.requestedSucursal);
  if (reqOp === 'VALENCIA' || reqOp === 'CENTRO') return 'CENTRO';
  if (reqOp === 'ORIENTE') return 'ORIENTE';
  if (reqOp === 'CAPITAL') return 'CAPITAL';
  if (reqOp === 'ZULIA') return 'OCCIDENTE';

  const reg = String(params.requestedRegion ?? '').trim().toLowerCase();
  if (reg === 'valencia' || reg === 'centro' || reg === 'andes') return 'CENTRO';
  if (reg === 'oriente') return 'ORIENTE';
  if (reg === 'capital' || reg === 'caracas') return 'CAPITAL';
  return 'OCCIDENTE';
}

function createDefaultGeoFallbackGateway(): GeoFallbackGateway {
  return {
    async lookupPdvCoordinates({ authUser, clienteId, pdvNombre }) {
      const cleanClientId = String(clienteId ?? '').trim();
      const cleanPdv = String(pdvNombre ?? '').trim();
      if (!cleanClientId && !cleanPdv) return null;
      if (!authUser.accessToken) return null;

      // Consulta exclusivamente bajo JWT del usuario autenticado (RLS estricto, cero service_role innecesario)
      const client = createUserScopedSupabaseClient(
        authUser.accessToken,
        isOperativeServerSucursal(authUser.sucursal) ? authUser.sucursal : authUser.activeSucursalHeader
      );
      if (!client) return null;

      try {
        interface PdvGeoRow {
          nombre_comercial?: unknown;
          latitud?: unknown;
          longitud?: unknown;
          radio_geocerca_m?: unknown;
        }
        let row: PdvGeoRow | null = null;

        if (cleanClientId && UUID_REGEX.test(cleanClientId)) {
          const byId = await client
            .from('clientes')
            .select('nombre_comercial, latitud, longitud, radio_geocerca_m')
            .eq('id', cleanClientId)
            .maybeSingle();
          if (!byId.error && byId.data) {
            row = byId.data as PdvGeoRow;
          }
        }

        if (!row && cleanPdv.length >= 2) {
          const escapedPdv = cleanPdv.replace(/[%_]/g, '').slice(0, 120);
          if (escapedPdv.length >= 2) {
            const byName = await client
              .from('clientes')
              .select('nombre_comercial, latitud, longitud, radio_geocerca_m')
              .ilike('nombre_comercial', escapedPdv)
              .limit(1)
              .maybeSingle();
            if (!byName.error && byName.data) {
              row = byName.data as PdvGeoRow;
            }
          }
        }

        if (!row) return null;
        const lat = Number(row.latitud);
        const lng = Number(row.longitud);
        if (!isValidCoordinatePair(lat, lng)) return null;
        const rawRadius =
          row.radio_geocerca_m !== null && row.radio_geocerca_m !== undefined
            ? Number(row.radio_geocerca_m)
            : 250;
        const accuracyMeters = Math.max(150, normalizeGeofenceRadiusMeters(rawRadius));
        const label = String(row.nombre_comercial || cleanPdv || 'PDV asignado').trim();
        return {
          lat: roundCoord(lat),
          lng: roundCoord(lng),
          accuracyMeters,
          label: `Geocerca PDV (${label})`,
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Endpoint interno autenticado `POST /api/geo/fallback-location` (Capa 3 — Cero bloqueo operativo).
 * - Exige JWT válido (`requireAttendanceActorAuth`).
 * - Cero API keys externas, cero procesamiento pesado en RAM, validación estricta WGS84.
 * - Devuelve `location_source: 'ip_fallback'` para auditoría transparente en gerencia.
 */
export function createGeoFallbackHandler(deps?: {
  gateway?: GeoFallbackGateway;
  now?: () => Date;
}) {
  const gateway = deps?.gateway ?? createDefaultGeoFallbackGateway();
  const getNow = deps?.now ?? (() => new Date());

  return async (req: Request, res: Response): Promise<void> => {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Autenticación requerida.', code: 'AUTH_REQUIRED' });
      return;
    }

    const parsed = GeoFallbackBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Parámetros de respaldo geográfico inválidos.',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { pdvNombre, clienteId, region, sucursal } = parsed.data;
    const capturedAtIso = getNow().toISOString();
    res.setHeader('Cache-Control', 'no-store');

    // 1. Prioridad 1: Geocerca maestra del PDV asignado en Supabase (bajo RLS del usuario)
    try {
      const pdvMatch = await gateway.lookupPdvCoordinates({
        authUser,
        clienteId,
        pdvNombre,
      });
      if (pdvMatch && isValidCoordinatePair(pdvMatch.lat, pdvMatch.lng)) {
        res.status(200).json({
          ok: true,
          lat: pdvMatch.lat,
          lng: pdvMatch.lng,
          accuracyMeters: Math.max(0, Math.round(pdvMatch.accuracyMeters)),
          locationSource: 'ip_fallback' as const,
          fallbackStrategy: 'pdv_geofence' as GeoFallbackStrategy,
          label: pdvMatch.label,
          capturedAtIso,
        });
        return;
      }
    } catch (err) {
      serverLogger.warn('geo_fallback_pdv_lookup_error', { err });
    }

    // 2. Prioridad 2: Cabeceras geográficas de proxy/CDN (Render/Cloudflare) validadas
    const proxyGeo = extractProxyGeoHeaders(req);
    if (proxyGeo) {
      res.status(200).json({
        ok: true,
        lat: proxyGeo.lat,
        lng: proxyGeo.lng,
        accuracyMeters: proxyGeo.accuracyMeters,
        locationSource: 'ip_fallback' as const,
        fallbackStrategy: 'proxy_geo_header' as GeoFallbackStrategy,
        label: proxyGeo.label,
        capturedAtIso,
      });
      return;
    }

    // 3. Prioridad 3: Coordenadas canónicas del hub regional autorizado del usuario
    const hubKey = resolveHubKey({
      authSucursal: authUser.sucursal,
      requestedSucursal: sucursal,
      requestedRegion: region,
    });
    const hub = REGIONAL_HUB_COORDS[hubKey];
    res.status(200).json({
      ok: true,
      lat: hub.lat,
      lng: hub.lng,
      accuracyMeters: 5000,
      locationSource: 'ip_fallback' as const,
      fallbackStrategy: 'regional_hub' as GeoFallbackStrategy,
      label: `${hub.label} (respaldo red)`,
      capturedAtIso,
    });
  };
}

export const defaultGeoFallbackHandler = createGeoFallbackHandler();
