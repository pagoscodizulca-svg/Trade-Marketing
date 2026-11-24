import type { EntregaVista, GeoPoint } from '../types';
import { isValidVenezuelaCoord } from './clientGeoMatcher';

export type RouteOriginMode = 'gps' | 'stop';

export interface RouteAnchor {
  kind: 'gps' | 'stop' | 'completed_stop' | 'none';
  label: string;
  lat: number | null;
  lng: number | null;
  deliveryId?: string | null;
}

export interface OptimizedStop {
  entrega: EntregaVista;
  /** Posición 1-based en la ruta óptima actual */
  orderIndex: number;
  /** Coordenadas válidas disponibles para cálculo y mapa */
  hasCoords: boolean;
  lat: number | null;
  lng: number | null;
  /** true cuando el chofer fijó explícitamente esta parada como punto #1 de partida */
  isPinnedStart: boolean;
  /** Distancia estimada en vía (km) desde el punto anterior (origen o parada previa) */
  legDistanceKm: number | null;
  /** Tiempo estimado de manejo (minutos) del tramo */
  legDurationMin: number | null;
  /** Distancia acumulada desde el origen */
  cumulativeDistanceKm: number;
  /** Tiempo acumulado desde el origen */
  cumulativeDurationMin: number;
  /** Enlace seguro de Google Maps para navegar directamente hacia esta parada */
  googleMapsStopUrl: string;
}

export interface GoogleMapsRouteSegment {
  segmentIndex: number;
  label: string;
  stopsCount: number;
  url: string;
}

export interface OptimizedRoutePlan {
  anchor: RouteAnchor;
  orderedPending: OptimizedStop[];
  completedDeliveries: EntregaVista[];
  geocodedPendingCount: number;
  missingGeoPendingCount: number;
  /** Distancia total estimada en vía (km) de la ruta optimizada */
  totalDistanceKm: number;
  /** Tiempo total estimado de manejo (min) */
  totalDurationMin: number;
  /** Distancia estimada del orden original del cronograma (para mostrar ahorro real) */
  originalDistanceKm: number;
  /** Kilómetros ahorrados gracias al orden óptimo (>= 0) */
  savedDistanceKm: number;
  /** Minutos ahorrados gracias al orden óptimo (>= 0) */
  savedDurationMin: number;
  /** Enlaces multi-parada seguros para abrir en Google Maps (chunked cada <= 9 waypoints) */
  googleMapsSegments: GoogleMapsRouteSegment[];
  /** URL principal del primer tramo / ruta completa */
  googleMapsPrimaryUrl: string | null;
}

export interface DeviationCheckResult {
  deviated: boolean;
  deliveredDelivery: EntregaVista | null;
  expectedFirstDelivery: EntregaVista | null;
  recalculatedAnchor: RouteAnchor | null;
  message: string | null;
}

const EARTH_RADIUS_KM = 6371;
/** Factor de sinuosidad vial urbana (distancia real en calle vs línea recta Haversine). */
export const URBAN_ROAD_FACTOR = 1.32;
/** Velocidad media urbana conservadora para reparto comercial en Venezuela (km/h). */
export const URBAN_AVG_SPEED_KMH = 28;
/** Límite seguro de waypoints intermedios soportado por Google Maps URLs API. */
export const GOOGLE_MAPS_MAX_WAYPOINTS = 9;
/** Distancia máxima (km) para considerar que el GPS actual está en la misma región operativa de la ruta. */
export const MAX_LOCAL_GPS_ANCHOR_KM = 120;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Distancia Haversine pura en línea recta (kilómetros). */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  if (!isValidVenezuelaCoord(a.lat, a.lng) || !isValidVenezuelaCoord(b.lat, b.lng)) {
    return 0;
  }
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  return EARTH_RADIUS_KM * c;
}

/** Estima distancia vial en km (redondeada a 0.1 km). */
export function estimateRoadKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const straight = haversineKm(a, b);
  if (straight < 0.03) return 0;
  return Math.round(straight * URBAN_ROAD_FACTOR * 10) / 10;
}

/** Estima tiempo de conducción urbana en minutos a partir de distancia vial en km. */
export function estimateDriveMinutes(roadKm: number): number {
  if (!Number.isFinite(roadKm) || roadKm <= 0.05) return 0;
  return Math.max(2, Math.round((roadKm / URBAN_AVG_SPEED_KMH) * 60));
}

function formatStopForMaps(e: Pick<EntregaVista, 'cliente' | 'zona_direccion' | 'lat' | 'lng'>): string {
  if (isValidVenezuelaCoord(e.lat, e.lng)) {
    return `${Number(e.lat).toFixed(6)},${Number(e.lng).toFixed(6)}`;
  }
  const parts = [e.cliente, e.zona_direccion, 'Venezuela']
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  return parts.join(', ');
}

/** Elimina paradas consecutivas con el mismo punto destino (p. ej. 2 entregas en el mismo PDV) para enlaces limpios de Google Maps. */
function deduplicateConsecutiveMapStops(stops: readonly EntregaVista[]): EntregaVista[] {
  const unique: EntregaVista[] = [];
  let lastKey = '';
  for (const s of stops) {
    const key = formatStopForMaps(s);
    if (key && key === lastKey) continue;
    unique.push(s);
    lastKey = key;
  }
  return unique;
}

/** Verifica si el GPS del dispositivo está dentro de la región operativa de la ruta (< 120 km de alguna parada). */
export function isGpsNearRoute(
  gps: { lat: number; lng: number } | null | undefined,
  deliveries: readonly Pick<EntregaVista, 'lat' | 'lng'>[],
): boolean {
  if (!gps || !isValidVenezuelaCoord(gps.lat, gps.lng)) return false;
  const geocoded = deliveries.filter((d) => isValidVenezuelaCoord(d.lat, d.lng));
  if (geocoded.length === 0) return true;
  return geocoded.some(
    (d) => haversineKm(gps, { lat: Number(d.lat), lng: Number(d.lng) }) <= MAX_LOCAL_GPS_ANCHOR_KM,
  );
}

/** Valida estrictamente que una URL generada apunte a Google Maps HTTPS (Zero XSS). */
export function sanitizeGoogleMapsUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'www.google.com' &&
      parsed.pathname.startsWith('/maps/')
    ) {
      return parsed.toString();
    }
  } catch {
    /* fallback */
  }
  return 'https://www.google.com/maps/';
}

/** Construye URL oficial de navegación punto-a-punto en Google Maps (sin requerir API Key). */
export function buildGoogleMapsSingleStopUrl(
  stop: Pick<EntregaVista, 'cliente' | 'zona_direccion' | 'lat' | 'lng'>,
  origin?: { lat: number; lng: number } | null,
): string {
  const params = new URLSearchParams();
  params.set('api', '1');
  if (origin && isValidVenezuelaCoord(origin.lat, origin.lng)) {
    params.set('origin', `${origin.lat.toFixed(6)},${origin.lng.toFixed(6)}`);
  }
  params.set('destination', formatStopForMaps(stop));
  params.set('travelmode', 'driving');
  return sanitizeGoogleMapsUrl(`https://www.google.com/maps/dir/?${params.toString()}`);
}

/**
 * Construye enlaces multi-parada compatibles con Google Maps (App móvil y navegador)
 * respetando el límite oficial de 9 waypoints por tramo.
 */
export function buildGoogleMapsMultiStopSegments(
  orderedStops: readonly EntregaVista[],
  anchor: RouteAnchor,
): GoogleMapsRouteSegment[] {
  const uniqueStops = deduplicateConsecutiveMapStops(orderedStops);
  if (uniqueStops.length === 0) return [];

  const segments: GoogleMapsRouteSegment[] = [];
  const maxStopsPerSegmentWithOrigin = GOOGLE_MAPS_MAX_WAYPOINTS + 1; // 9 waypoints + 1 destination

  let cursor = 0;
  let segIdx = 1;

  while (cursor < uniqueStops.length) {
    const hasExplicitOriginCoord =
      cursor === 0 &&
      (anchor.kind === 'gps' || anchor.kind === 'completed_stop') &&
      anchor.lat != null &&
      anchor.lng != null &&
      isValidVenezuelaCoord(anchor.lat, anchor.lng);

    const isContinuation = cursor > 0;
    const prevStop = isContinuation ? uniqueStops[cursor - 1] : null;

    if (hasExplicitOriginCoord || prevStop) {
      const slice = uniqueStops.slice(cursor, cursor + maxStopsPerSegmentWithOrigin);
      const destination = slice[slice.length - 1];
      const waypoints = slice.slice(0, -1);

      const params = new URLSearchParams();
      params.set('api', '1');
      if (prevStop) {
        params.set('origin', formatStopForMaps(prevStop));
      } else if (anchor.lat != null && anchor.lng != null) {
        params.set('origin', `${anchor.lat.toFixed(6)},${anchor.lng.toFixed(6)}`);
      }
      params.set('destination', formatStopForMaps(destination));
      if (waypoints.length > 0) {
        params.set('waypoints', waypoints.map(formatStopForMaps).join('|'));
      }
      params.set('travelmode', 'driving');

      const startNum = cursor + 1;
      const endNum = cursor + slice.length;
      segments.push({
        segmentIndex: segIdx,
        label:
          uniqueStops.length <= maxStopsPerSegmentWithOrigin
            ? `Ruta óptima (${slice.length} ${slice.length === 1 ? 'punto' : 'puntos'})`
            : `Tramo ${segIdx} (Puntos #${startNum} a #${endNum})`,
        stopsCount: slice.length,
        url: sanitizeGoogleMapsUrl(`https://www.google.com/maps/dir/?${params.toString()}`),
      });

      cursor += slice.length;
      segIdx += 1;
    } else {
      // Sin GPS activo (o iniciando en la parada elegida #1):
      if (uniqueStops.length === 1) {
        segments.push({
          segmentIndex: 1,
          label: 'Ir a parada #1',
          stopsCount: 1,
          url: buildGoogleMapsSingleStopUrl(uniqueStops[0], null),
        });
        break;
      }

      // Parada #1 es el origen, intermedias son waypoints, última es destino.
      const maxTotalStops = GOOGLE_MAPS_MAX_WAYPOINTS + 2; // origin + 9 waypoints + destination = 11
      const slice = uniqueStops.slice(cursor, cursor + maxTotalStops);
      const originStop = slice[0];
      const destination = slice[slice.length - 1];
      const waypoints = slice.slice(1, -1);

      const params = new URLSearchParams();
      params.set('api', '1');
      params.set('origin', formatStopForMaps(originStop));
      params.set('destination', formatStopForMaps(destination));
      if (waypoints.length > 0) {
        params.set('waypoints', waypoints.map(formatStopForMaps).join('|'));
      }
      params.set('travelmode', 'driving');

      segments.push({
        segmentIndex: segIdx,
        label:
          uniqueStops.length <= maxTotalStops
            ? `Ruta óptima (${slice.length} puntos)`
            : `Tramo ${segIdx} (Puntos #1 a #${slice.length})`,
        stopsCount: slice.length,
        url: sanitizeGoogleMapsUrl(`https://www.google.com/maps/dir/?${params.toString()}`),
      });

      cursor += slice.length;
      segIdx += 1;
    }
  }

  return segments;
}

interface CoordNode {
  entrega: EntregaVista;
  lat: number;
  lng: number;
}

/** Calcula la distancia total de una secuencia de nodos a partir de un punto origen opcional. */
function pathDistanceKm(
  startCoord: { lat: number; lng: number } | null,
  nodes: readonly CoordNode[],
): number {
  let total = 0;
  let prev = startCoord;
  for (const node of nodes) {
    if (prev) {
      total += haversineKm(prev, node);
    }
    prev = node;
  }
  return total;
}

/**
 * Optimiza el orden de visita (camino abierto TSP sin retorno obligatorio)
 * combinando Vecino Más Cercano (Nearest Neighbor) + búsqueda local 2-opt.
 * Si `pinFirstNode === true`, el primer nodo queda fijo en la posición 0 (punto elegido por el chofer).
 */
function solveOpenTsp(
  startCoord: { lat: number; lng: number } | null,
  nodes: readonly CoordNode[],
  pinFirstNode: boolean,
): CoordNode[] {
  if (nodes.length <= 1) return [...nodes];

  const remaining = [...nodes];
  const tour: CoordNode[] = [];

  if (pinFirstNode) {
    tour.push(remaining.shift()!);
  }

  // 1) Construcción golosa por Vecino Más Cercano
  let current: { lat: number; lng: number } | null =
    tour.length > 0 ? tour[tour.length - 1] : startCoord;

  if (!current && remaining.length > 0) {
    const first = remaining.shift()!;
    tour.push(first);
    current = first;
  }

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = current ? haversineKm(current, remaining[i]) : 0;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    tour.push(chosen);
    current = chosen;
  }

  // 2) Refinamiento determinista 2-opt (mantiene fijo el inicio si `pinFirstNode`)
  const minSwapIdx = pinFirstNode ? 1 : 0;
  const maxIterations = 80;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    let improved = false;
    const baseDist = pathDistanceKm(startCoord, tour);

    for (let i = minSwapIdx; i < tour.length - 1; i += 1) {
      for (let k = i + 1; k < tour.length; k += 1) {
        // Invertir segmento [i..k]
        const candidate = [
          ...tour.slice(0, i),
          ...tour.slice(i, k + 1).reverse(),
          ...tour.slice(k + 1),
        ];
        const candDist = pathDistanceKm(startCoord, candidate);
        if (candDist + 0.005 < baseDist) {
          for (let j = 0; j < tour.length; j += 1) tour[j] = candidate[j];
          improved = true;
          break;
        }
      }
      if (improved) break;
    }

    if (!improved) break;
  }

  return tour;
}

/**
 * Motor principal de ruteo óptimo offline.
 * Calcula el recorrido óptimo de las entregas pendientes a partir del punto elegido por el chofer
 * (un cliente inicial o su ubicación GPS actual), estima distancias/tiempos reales y genera enlaces
 * sincronizados para Google Maps.
 */
export function computeOptimalRoute(params: {
  deliveries: readonly EntregaVista[];
  originMode: RouteOriginMode;
  startDeliveryId: string | null;
  driverGps: GeoPoint | null;
  lastCompletedAnchor?: RouteAnchor | null;
}): OptimizedRoutePlan {
  const { deliveries, originMode, startDeliveryId, driverGps, lastCompletedAnchor } = params;

  const pending = deliveries.filter((d) => !d.completado);
  const completedDeliveries = deliveries.filter((d) => d.completado);
  const rawValidGps =
    driverGps && isValidVenezuelaCoord(driverGps.lat, driverGps.lng) ? driverGps : null;
  const localDriverGps =
    rawValidGps && isGpsNearRoute(rawValidGps, pending.length > 0 ? pending : deliveries)
      ? rawValidGps
      : null;

  const pinnedStop =
    originMode === 'stop' && startDeliveryId
      ? pending.find((d) => d.id === startDeliveryId) ?? null
      : null;

  // Determinar el ancla de partida efectiva:
  // - Si el chofer eligió explícitamente un cliente inicial (`originMode === 'stop'`), la ruta
  //   arranca limpiamente DESDE ese cliente (evita distorsionar km/mapa si el GPS está en otra sede).
  // - En modo GPS / recálculo automático, usa el GPS actual si está dentro de la zona operativa (<120 km),
  //   o la última entrega completada como respaldo determinista.
  let anchor: RouteAnchor;
  if (pinnedStop) {
    const hasStopCoords = isValidVenezuelaCoord(pinnedStop.lat, pinnedStop.lng);
    anchor = hasStopCoords
      ? {
          kind: 'stop',
          label: pinnedStop.zona_direccion
            ? `${pinnedStop.cliente} (${pinnedStop.zona_direccion})`
            : pinnedStop.cliente,
          lat: Number(pinnedStop.lat),
          lng: Number(pinnedStop.lng),
          deliveryId: pinnedStop.id,
        }
      : {
          kind: 'stop',
          label: pinnedStop.cliente,
          lat: null,
          lng: null,
          deliveryId: pinnedStop.id,
        };
  } else if (localDriverGps) {
    anchor = {
      kind: 'gps',
      label: 'Tu ubicación GPS actual',
      lat: localDriverGps.lat,
      lng: localDriverGps.lng,
    };
  } else if (
    lastCompletedAnchor &&
    lastCompletedAnchor.lat != null &&
    lastCompletedAnchor.lng != null &&
    isValidVenezuelaCoord(lastCompletedAnchor.lat, lastCompletedAnchor.lng)
  ) {
    anchor = {
      kind: 'completed_stop',
      label: lastCompletedAnchor.label,
      lat: lastCompletedAnchor.lat,
      lng: lastCompletedAnchor.lng,
      deliveryId: lastCompletedAnchor.deliveryId ?? null,
    };
  } else {
    const firstWithCoords = pending.find((d) => isValidVenezuelaCoord(d.lat, d.lng));
    anchor = firstWithCoords
      ? {
          kind: 'stop',
          label: firstWithCoords.zona_direccion
            ? `${firstWithCoords.cliente} (${firstWithCoords.zona_direccion})`
            : firstWithCoords.cliente,
          lat: Number(firstWithCoords.lat),
          lng: Number(firstWithCoords.lng),
          deliveryId: firstWithCoords.id,
        }
      : {
          kind: 'none',
          label: 'Sin coordenadas GPS',
          lat: null,
          lng: null,
        };
  }

  // Separar pendientes con coordenadas vs sin coordenadas (nunca fallar si faltan coords)
  const withCoords: CoordNode[] = [];
  const withoutCoords: EntregaVista[] = [];

  for (const d of pending) {
    if (isValidVenezuelaCoord(d.lat, d.lng)) {
      withCoords.push({ entrega: d, lat: Number(d.lat), lng: Number(d.lng) });
    } else {
      withoutCoords.push(d);
    }
  }

  // Si la parada fijada tiene coordenadas, moverla al frente y fijarla en posición 0
  let pinFirstNode = false;
  let orderedGeoInput = [...withCoords];
  if (pinnedStop && isValidVenezuelaCoord(pinnedStop.lat, pinnedStop.lng)) {
    const idx = orderedGeoInput.findIndex((n) => n.entrega.id === pinnedStop.id);
    if (idx >= 0) {
      const [found] = orderedGeoInput.splice(idx, 1);
      orderedGeoInput = [found, ...orderedGeoInput];
      pinFirstNode = true;
    }
  }

  const startCoordForSolver =
    anchor.kind === 'gps' || anchor.kind === 'completed_stop'
      ? anchor.lat != null && anchor.lng != null
        ? { lat: anchor.lat, lng: anchor.lng }
        : null
      : null;

  // Calcular distancia original (sin optimizar) para comparar ahorro
  const originalNodes = withCoords;
  let originalDistanceKm = 0;
  let prevOrig: { lat: number; lng: number } | null = startCoordForSolver;
  for (const node of originalNodes) {
    if (prevOrig) originalDistanceKm += estimateRoadKm(prevOrig, node);
    prevOrig = node;
  }
  originalDistanceKm = Math.round(originalDistanceKm * 10) / 10;

  // Ejecutar optimización NN + 2-opt
  const optimizedNodes = solveOpenTsp(startCoordForSolver, orderedGeoInput, pinFirstNode);

  // Construir lista final ordenada (si pinnedStop NO tenía GPS, mantenerlo en #1 igualmente)
  const finalPendingList: EntregaVista[] = [];
  if (pinnedStop && !isValidVenezuelaCoord(pinnedStop.lat, pinnedStop.lng)) {
    finalPendingList.push(pinnedStop);
  }
  for (const n of optimizedNodes) {
    finalPendingList.push(n.entrega);
  }
  for (const noGeo of withoutCoords) {
    if (!pinnedStop || noGeo.id !== pinnedStop.id) {
      finalPendingList.push(noGeo);
    }
  }

  // Calcular tramos, acumulados y enlaces Google Maps por parada
  const orderedPending: OptimizedStop[] = [];
  let prevCoord: { lat: number; lng: number } | null = startCoordForSolver;
  let cumulativeDistanceKm = 0;
  let cumulativeDurationMin = 0;

  for (let i = 0; i < finalPendingList.length; i += 1) {
    const entrega = finalPendingList[i];
    const hasCoords = isValidVenezuelaCoord(entrega.lat, entrega.lng);
    const lat = hasCoords ? Number(entrega.lat) : null;
    const lng = hasCoords ? Number(entrega.lng) : null;

    let legDistanceKm: number | null = null;
    let legDurationMin: number | null = null;

    if (hasCoords && lat != null && lng != null) {
      if (prevCoord) {
        legDistanceKm = estimateRoadKm(prevCoord, { lat, lng });
        legDurationMin = estimateDriveMinutes(legDistanceKm);
        cumulativeDistanceKm = Math.round((cumulativeDistanceKm + legDistanceKm) * 10) / 10;
        cumulativeDurationMin += legDurationMin;
      } else {
        legDistanceKm = 0;
        legDurationMin = 0;
      }
      prevCoord = { lat, lng };
    }

    orderedPending.push({
      entrega,
      orderIndex: i + 1,
      hasCoords,
      lat,
      lng,
      isPinnedStart: Boolean(pinnedStop && entrega.id === pinnedStop.id),
      legDistanceKm,
      legDurationMin,
      cumulativeDistanceKm,
      cumulativeDurationMin,
      googleMapsStopUrl: buildGoogleMapsSingleStopUrl(
        entrega,
        localDriverGps ?? (i === 0 ? startCoordForSolver : null),
      ),
    });
  }

  const totalDistanceKm = Math.round(cumulativeDistanceKm * 10) / 10;
  const totalDurationMin = cumulativeDurationMin;
  const savedDistanceKm = Math.max(
    0,
    Math.round((originalDistanceKm - totalDistanceKm) * 10) / 10,
  );
  const originalDurationMin =
    originalDistanceKm > 0 ? Math.max(totalDurationMin, Math.round((originalDistanceKm / URBAN_AVG_SPEED_KMH) * 60)) : 0;
  const savedDurationMin = Math.max(0, originalDurationMin - totalDurationMin);

  const googleMapsSegments = buildGoogleMapsMultiStopSegments(finalPendingList, anchor);

  return {
    anchor,
    orderedPending,
    completedDeliveries,
    geocodedPendingCount: withCoords.length,
    missingGeoPendingCount: withoutCoords.length,
    totalDistanceKm,
    totalDurationMin,
    originalDistanceKm,
    savedDistanceKm,
    savedDurationMin,
    googleMapsSegments,
    googleMapsPrimaryUrl: googleMapsSegments[0]?.url ?? null,
  };
}

/**
 * Detecta si el chofer entregó una parada fuera del orden planificado (ej. A → C en vez de A → B)
 * y determina el nuevo ancla de recálculo inmediato (GPS actual prioritario, o coordenadas de C).
 */
export function evaluateOffOrderCompletion(params: {
  plannedPendingIds: readonly string[];
  deliveriesBefore: readonly EntregaVista[];
  deliveredId: string;
  driverGps: GeoPoint | null;
}): DeviationCheckResult {
  const { plannedPendingIds, deliveriesBefore, deliveredId, driverGps } = params;
  const delivered = deliveriesBefore.find((d) => d.id === deliveredId) ?? null;
  if (!delivered) {
    return {
      deviated: false,
      deliveredDelivery: null,
      expectedFirstDelivery: null,
      recalculatedAnchor: null,
      message: null,
    };
  }

  const idxInPlan = plannedPendingIds.indexOf(deliveredId);
  const expectedFirstId = plannedPendingIds[0] ?? null;
  const expectedFirst =
    expectedFirstId ? deliveriesBefore.find((d) => d.id === expectedFirstId) ?? null : null;

  const rawValidGps =
    driverGps && isValidVenezuelaCoord(driverGps.lat, driverGps.lng) ? driverGps : null;
  const hasDeliveredCoords = isValidVenezuelaCoord(delivered.lat, delivered.lng);
  const gpsNearDelivered =
    rawValidGps &&
    (hasDeliveredCoords
      ? haversineKm(rawValidGps, { lat: Number(delivered.lat), lng: Number(delivered.lng) }) <=
        MAX_LOCAL_GPS_ANCHOR_KM
      : isGpsNearRoute(rawValidGps, deliveriesBefore));
  const localDriverGps = gpsNearDelivered ? rawValidGps : null;

  const deliveredLabel = delivered.zona_direccion
    ? `${delivered.cliente} (${delivered.zona_direccion})`
    : delivered.cliente;

  const recalculatedAnchor: RouteAnchor | null = localDriverGps
    ? {
        kind: 'gps',
        label: 'Tu ubicación GPS actual',
        lat: localDriverGps.lat,
        lng: localDriverGps.lng,
      }
    : hasDeliveredCoords
      ? {
          kind: 'completed_stop',
          label: `Última entrega: ${deliveredLabel}`,
          lat: Number(delivered.lat),
          lng: Number(delivered.lng),
          deliveryId: delivered.id,
        }
      : null;

  const deviated = idxInPlan > 0;
  if (!deviated) {
    return {
      deviated: false,
      deliveredDelivery: delivered,
      expectedFirstDelivery: expectedFirst,
      recalculatedAnchor,
      message: null,
    };
  }

  const expectedLabel = expectedFirst
    ? expectedFirst.zona_direccion
      ? `${expectedFirst.cliente} (${expectedFirst.zona_direccion})`
      : expectedFirst.cliente
    : 'la parada prevista';

  const sourceDesc = localDriverGps
    ? 'tu ubicación GPS actual'
    : `la entrega en ${deliveredLabel}`;

  return {
    deviated: true,
    deliveredDelivery: delivered,
    expectedFirstDelivery: expectedFirst,
    recalculatedAnchor,
    message: `Cambio de orden detectado (entregaste ${deliveredLabel} antes que ${expectedLabel}). Ruta recalculada automáticamente desde ${sourceDesc}.`,
  };
}
