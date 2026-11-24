import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Compass,
  ExternalLink,
  Flag,
  MapPin,
  Navigation,
  WifiOff,
} from 'lucide-react';
import type { EntregaVista, GeoPoint } from '../../types';
import {
  buildGoogleMapsSingleStopUrl,
  haversineKm,
  isGpsNearRoute,
  type OptimizedRoutePlan,
  type OptimizedStop,
} from '../../lib/routeOptimizer';
import { isValidVenezuelaCoord } from '../../lib/clientGeoMatcher';

interface OfflineRouteMapProps {
  plan: OptimizedRoutePlan;
  driverGps: GeoPoint | null;
  onSelectStartStop: (deliveryId: string) => void;
  onFocusCard?: (deliveryId: string) => void;
}

interface ProjectedPin {
  id: string;
  kind: 'pending' | 'completed';
  orderIndex: number | null;
  entrega: EntregaVista;
  stop: OptimizedStop | null;
  lat: number;
  lng: number;
  x: number;
  y: number;
  isNext: boolean;
  isPinnedStart: boolean;
}

const SVG_W = 640;
const SVG_H = 340;
const PAD_X = 56;
const PAD_Y = 44;

function shortLabel(e: Pick<EntregaVista, 'cliente' | 'zona_direccion'>): string {
  const base = e.zona_direccion
    ? `${e.cliente} · ${e.zona_direccion}`
    : e.cliente;
  return base.length > 26 ? `${base.slice(0, 25)}…` : base;
}

/**
 * Mapa vectorial táctico 100 % OFFLINE (SVG proyectado sobre coordenadas reales lat/lng).
 * No requiere internet, ni tiles externos, ni API keys, ni infringe políticas CSP.
 */
export function OfflineRouteMap({
  plan,
  driverGps,
  onSelectStartStop,
  onFocusCard,
}: OfflineRouteMapProps) {
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);

  const rawDriverGps =
    driverGps && isValidVenezuelaCoord(driverGps.lat, driverGps.lng) ? driverGps : null;
  // Mostrar el pin GPS dentro del lienzo del mapa solo si está en la misma región operativa (<120 km)
  // y el chofer no fijó una parada remota diferente (evita comprimir los pines de ruta en un punto).
  const validDriverGps =
    rawDriverGps &&
    isGpsNearRoute(
      rawDriverGps,
      plan.orderedPending.map((s) => s.entrega),
    )
      ? rawDriverGps
      : null;
  const showGpsOriginLine = Boolean(validDriverGps && plan.anchor.kind === 'gps');

  const projection = useMemo(() => {
    const rawPoints: Array<{ lat: number; lng: number }> = [];

    if (validDriverGps) {
      rawPoints.push({ lat: validDriverGps.lat, lng: validDriverGps.lng });
    }
    if (
      plan.anchor.kind === 'completed_stop' &&
      plan.anchor.lat != null &&
      plan.anchor.lng != null &&
      isValidVenezuelaCoord(plan.anchor.lat, plan.anchor.lng)
    ) {
      rawPoints.push({ lat: plan.anchor.lat, lng: plan.anchor.lng });
    }

    for (const s of plan.orderedPending) {
      if (s.hasCoords && s.lat != null && s.lng != null) {
        rawPoints.push({ lat: s.lat, lng: s.lng });
      }
    }
    for (const c of plan.completedDeliveries) {
      if (isValidVenezuelaCoord(c.lat, c.lng)) {
        rawPoints.push({ lat: Number(c.lat), lng: Number(c.lng) });
      }
    }

    if (rawPoints.length === 0) return null;

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const p of rawPoints) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }

    const meanLat = (minLat + maxLat) / 2;
    const cosLat = Math.max(0.2, Math.cos((meanLat * Math.PI) / 180));

    // Garantizar un span mínimo (~3 km) si todos los puntos están en el mismo PDV
    const minSpanDeg = 0.025;
    const rawSpanLat = Math.max(maxLat - minLat, minSpanDeg);
    const rawSpanLng = Math.max(maxLng - minLng, minSpanDeg / cosLat);

    const padLat = rawSpanLat * 0.14;
    const padLng = rawSpanLng * 0.14;

    const boundMinLat = minLat - padLat;
    const boundMaxLat = maxLat + padLat;
    const boundMinLng = minLng - padLng;
    const boundMaxLng = maxLng + padLng;

    const spanLat = boundMaxLat - boundMinLat;
    const spanLngScaled = (boundMaxLng - boundMinLng) * cosLat;

    const drawW = SVG_W - PAD_X * 2;
    const drawH = SVG_H - PAD_Y * 2;
    const scale = Math.min(drawW / spanLngScaled, drawH / spanLat);

    const usedW = spanLngScaled * scale;
    const usedH = spanLat * scale;
    const offsetX = PAD_X + (drawW - usedW) / 2;
    const offsetY = PAD_Y + (drawH - usedH) / 2;

    const project = (lat: number, lng: number) => ({
      x: offsetX + (lng - boundMinLng) * cosLat * scale,
      y: offsetY + (boundMaxLat - lat) * scale,
    });

    // Barra de escala real en kilómetros (~110 px)
    const kmPerPixel =
      haversineKm({ lat: meanLat, lng: boundMinLng }, { lat: meanLat, lng: boundMaxLng }) /
      Math.max(1, usedW);
    const rawScaleKm = kmPerPixel * 100;
    const niceSteps = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
    const scaleKm = niceSteps.find((s) => s >= rawScaleKm) ?? Math.round(rawScaleKm);
    const scalePx = Math.max(36, Math.min(130, scaleKm / Math.max(kmPerPixel, 1e-6)));

    // Construir pines con leve separación radial si hay entregas co-ubicadas (p. ej. Mañana + Tarde en el mismo Makro)
    const overlapBuckets = new Map<string, number>();
    const jitterCoord = (lat: number, lng: number) => {
      const base = project(lat, lng);
      const bucketKey = `${lat.toFixed(4)}:${lng.toFixed(4)}`;
      const count = overlapBuckets.get(bucketKey) ?? 0;
      overlapBuckets.set(bucketKey, count + 1);
      if (count === 0) return base;
      const angle = (count * 2.2) % (Math.PI * 2);
      const radius = 15 + Math.floor(count / 4) * 10;
      return {
        x: Math.max(24, Math.min(SVG_W - 24, base.x + Math.cos(angle) * radius)),
        y: Math.max(24, Math.min(SVG_H - 24, base.y + Math.sin(angle) * radius)),
      };
    };

    const pins: ProjectedPin[] = [];
    for (const c of plan.completedDeliveries) {
      if (!isValidVenezuelaCoord(c.lat, c.lng)) continue;
      const pos = jitterCoord(Number(c.lat), Number(c.lng));
      pins.push({
        id: c.id,
        kind: 'completed',
        orderIndex: null,
        entrega: c,
        stop: null,
        lat: Number(c.lat),
        lng: Number(c.lng),
        x: pos.x,
        y: pos.y,
        isNext: false,
        isPinnedStart: false,
      });
    }

    for (let i = 0; i < plan.orderedPending.length; i += 1) {
      const stop = plan.orderedPending[i];
      if (!stop.hasCoords || stop.lat == null || stop.lng == null) continue;
      const pos = jitterCoord(stop.lat, stop.lng);
      pins.push({
        id: stop.entrega.id,
        kind: 'pending',
        orderIndex: stop.orderIndex,
        entrega: stop.entrega,
        stop,
        lat: stop.lat,
        lng: stop.lng,
        x: pos.x,
        y: pos.y,
        isNext: i === 0,
        isPinnedStart: stop.isPinnedStart,
      });
    }

    const gpsPos = validDriverGps ? project(validDriverGps.lat, validDriverGps.lng) : null;
    const completedAnchorPos =
      !validDriverGps &&
      plan.anchor.kind === 'completed_stop' &&
      plan.anchor.lat != null &&
      plan.anchor.lng != null
        ? project(plan.anchor.lat, plan.anchor.lng)
        : null;

    const pendingPins = pins.filter((p) => p.kind === 'pending');

    return {
      pins,
      pendingPins,
      gpsPos,
      completedAnchorPos,
      scaleKm,
      scalePx,
    };
  }, [plan, validDriverGps]);

  const activePin = useMemo(() => {
    if (!projection) return null;
    if (selectedPinId) {
      const found = projection.pins.find((p) => p.id === selectedPinId);
      if (found) return found;
    }
    return projection.pendingPins[0] ?? projection.pins[0] ?? null;
  }, [projection, selectedPinId]);

  if (!projection) {
    return (
      <div
        data-testid="mapa-offline-vacio"
        className="rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 p-4 text-center text-xs font-bold text-zinc-600"
      >
        Sin coordenadas GPS disponibles para trazar el mapa en este filtro.
      </div>
    );
  }

  const originDot = projection.gpsPos ?? projection.completedAnchorPos;

  return (
    <div
      data-testid="mapa-ruta-offline"
      className="rounded-xl border-2 border-zinc-800 bg-slate-950 text-white overflow-hidden shadow-inner"
    >
      {/* Cabecera compacta del mapa táctico */}
      <div className="px-3 py-2 bg-zinc-900/95 border-b border-white/10 flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/50 text-emerald-200">
            <WifiOff className="w-3 h-3" />
            Mapa Offline Activo
          </span>
          <span className="text-zinc-300">
            {projection.pendingPins.length} pendientes en mapa
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-zinc-300">
          {originDot && (
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-sky-400 inline-block ring-2 ring-sky-400/40" />
              {projection.gpsPos ? 'Tu GPS' : 'Última entrega'}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
            Siguiente (#1)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" />
            Ruta óptima
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
            Entregada
          </span>
        </div>
      </div>

      {/* Lienzo SVG proyectado en coordenadas reales */}
      <div className="relative bg-[radial-gradient(circle_at_top,#172554_0%,#090d16_75%)]">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          role="img"
          aria-label="Mapa offline de ruta óptima de entregas"
          className="w-full h-60 sm:h-72 block select-none"
        >
          <defs>
            <marker
              id="rd-arrow-route"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#f87171" />
            </marker>
            <marker
              id="rd-arrow-gps"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" />
            </marker>
          </defs>

          {/* Cuadrícula cartográfica sutil */}
          {[1, 2, 3, 4, 5].map((i) => (
            <line
              key={`v-${i}`}
              x1={(SVG_W / 6) * i}
              y1={0}
              x2={(SVG_W / 6) * i}
              y2={SVG_H}
              stroke="rgba(148,163,184,0.12)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ))}
          {[1, 2, 3].map((i) => (
            <line
              key={`h-${i}`}
              x1={0}
              y1={(SVG_H / 4) * i}
              x2={SVG_W}
              y2={(SVG_H / 4) * i}
              stroke="rgba(148,163,184,0.12)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ))}

          {/* Tramo desde el GPS actual / última entrega hacia la parada #1 */}
          {(showGpsOriginLine || projection.completedAnchorPos) && originDot && projection.pendingPins[0] && (
            <line
              x1={originDot.x}
              y1={originDot.y}
              x2={projection.pendingPins[0].x}
              y2={projection.pendingPins[0].y}
              stroke="#38bdf8"
              strokeWidth={3}
              strokeDasharray="7 5"
              markerEnd="url(#rd-arrow-gps)"
            />
          )}

          {/* Polilínea dirigida de la ruta óptima entre paradas pendientes (#1 -> #2 -> ... -> #N) */}
          {projection.pendingPins.map((pin, idx) => {
            if (idx === 0) return null;
            const prev = projection.pendingPins[idx - 1];
            const midX = (prev.x + pin.x) / 2;
            const midY = (prev.y + pin.y) / 2;
            const segPx = Math.hypot(pin.x - prev.x, pin.y - prev.y);
            const legKm = pin.stop?.legDistanceKm ?? 0;

            return (
              <g key={`leg-${prev.id}-${pin.id}`}>
                <line
                  x1={prev.x}
                  y1={prev.y}
                  x2={pin.x}
                  y2={pin.y}
                  stroke="#ef4444"
                  strokeWidth={3.2}
                  strokeLinecap="round"
                  markerEnd="url(#rd-arrow-route)"
                />
                {segPx >= 58 && legKm > 0 && (
                  <g transform={`translate(${midX}, ${midY})`}>
                    <rect
                      x={-24}
                      y={-10}
                      width={48}
                      height={18}
                      rx={9}
                      fill="#0f172a"
                      stroke="#f87171"
                      strokeWidth={1}
                    />
                    <text
                      x={0}
                      y={3}
                      textAnchor="middle"
                      fill="#fecaca"
                      fontSize="9.5"
                      fontWeight="800"
                    >
                      {legKm.toFixed(1)} km
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Pines de entregas completadas */}
          {projection.pins
            .filter((p) => p.kind === 'completed')
            .map((pin) => {
              const isSelected = activePin?.id === pin.id;
              return (
                <g
                  key={pin.id}
                  data-testid={`mapa-pin-${pin.id}`}
                  onClick={() => setSelectedPinId(pin.id)}
                  className="cursor-pointer"
                >
                  <circle
                    cx={pin.x}
                    cy={pin.y}
                    r={isSelected ? 14 : 11}
                    fill="#10b981"
                    stroke="#ecfdf5"
                    strokeWidth={isSelected ? 3 : 2}
                  />
                  <text
                    x={pin.x}
                    y={pin.y + 4}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize="11"
                    fontWeight="900"
                  >
                    ✓
                  </text>
                </g>
              );
            })}

          {/* Pines numerados de paradas pendientes en orden óptimo */}
          {(() => {
            const labeledClusters = new Set<string>();
            return projection.pendingPins.map((pin) => {
              const isSelected = activePin?.id === pin.id;
              const fill = pin.isNext ? '#f59e0b' : '#dc2626';
              const radius = pin.isNext ? 16 : isSelected ? 15 : 13;
              const clusterKey = `${pin.lat.toFixed(3)}:${pin.lng.toFixed(3)}`;
              const isFirstInCluster = !labeledClusters.has(clusterKey);
              labeledClusters.add(clusterKey);
              const showLabel = isSelected || (isFirstInCluster && (pin.isNext || labeledClusters.size <= 8));
              // Alternar arriba/abajo para ubicaciones cercanas horizontalmente
              const alternateBelow = (pin.orderIndex ?? 1) % 2 === 0 && pin.y < SVG_H - 60;
              const labelY =
                pin.y < 52 || alternateBelow ? pin.y + radius + 14 : pin.y - radius - 8;

              return (
                <g
                  key={pin.id}
                  data-testid={`mapa-pin-${pin.id}`}
                  onClick={() => setSelectedPinId(pin.id)}
                  className="cursor-pointer"
                >
                  {(pin.isNext || isSelected) && (
                    <circle
                      cx={pin.x}
                      cy={pin.y}
                      r={radius + 6}
                      fill="none"
                      stroke={pin.isNext ? '#fbbf24' : '#ffffff'}
                      strokeWidth={2}
                      strokeOpacity={0.65}
                    />
                  )}
                  <circle
                    cx={pin.x}
                    cy={pin.y}
                    r={radius}
                    fill={fill}
                    stroke="#ffffff"
                    strokeWidth={2.5}
                  />
                  <text
                    x={pin.x}
                    y={pin.y + 4.5}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize="12"
                    fontWeight="900"
                  >
                    {pin.orderIndex}
                  </text>
                  {showLabel && (
                    <g>
                      <text
                        x={pin.x}
                        y={labelY}
                        textAnchor="middle"
                        fill="#020617"
                        stroke="#020617"
                        strokeWidth={4}
                        fontSize="10.5"
                        fontWeight="800"
                      >
                        {shortLabel(pin.entrega)}
                      </text>
                      <text
                        x={pin.x}
                        y={labelY}
                        textAnchor="middle"
                        fill={pin.isNext ? '#fef3c7' : '#f1f5f9'}
                        fontSize="10.5"
                        fontWeight="800"
                      >
                        {shortLabel(pin.entrega)}
                      </text>
                    </g>
                  )}
                </g>
              );
            });
          })()}

          {/* Marcador de ubicación GPS actual del chofer */}
          {projection.gpsPos && (
            <g data-testid="mapa-pin-gps">
              <circle
                cx={projection.gpsPos.x}
                cy={projection.gpsPos.y}
                r={17}
                fill="#38bdf8"
                fillOpacity={0.22}
              />
              <circle
                cx={projection.gpsPos.x}
                cy={projection.gpsPos.y}
                r={8}
                fill="#0284c7"
                stroke="#ffffff"
                strokeWidth={2.5}
              />
              <text
                x={projection.gpsPos.x}
                y={projection.gpsPos.y + 22}
                textAnchor="middle"
                fill="#bae6fd"
                fontSize="10"
                fontWeight="800"
              >
                TÚ (GPS)
              </text>
            </g>
          )}

          {/* Rosa de los vientos (Norte) */}
          <g transform={`translate(${SVG_W - 30}, 28)`}>
            <circle cx={0} cy={0} r={15} fill="rgba(15,23,42,0.85)" stroke="rgba(255,255,255,0.22)" />
            <text x={0} y={4} textAnchor="middle" fill="#f87171" fontSize="11" fontWeight="900">
              N
            </text>
          </g>

          {/* Barra de escala real en kilómetros */}
          <g transform={`translate(16, ${SVG_H - 18})`}>
            <line
              x1={0}
              y1={0}
              x2={projection.scalePx}
              y2={0}
              stroke="#e2e8f0"
              strokeWidth={2.5}
            />
            <line x1={0} y1={-4} x2={0} y2={4} stroke="#e2e8f0" strokeWidth={2} />
            <line
              x1={projection.scalePx}
              y1={-4}
              x2={projection.scalePx}
              y2={4}
              stroke="#e2e8f0"
              strokeWidth={2}
            />
            <text x={projection.scalePx + 6} y={3.5} fill="#cbd5e1" fontSize="10" fontWeight="700">
              {projection.scaleKm} km
            </text>
          </g>
        </svg>
      </div>

      {/* HUD interactivo inferior del pin seleccionado */}
      {activePin && (
        <div
          data-testid="mapa-hud-activo"
          className="px-3 py-2.5 bg-zinc-900 border-t border-white/10 flex flex-wrap items-center justify-between gap-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {activePin.kind === 'completed' ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  <CheckCircle2 className="w-3 h-3" />
                  Entregada
                </span>
              ) : (
                <span
                  className={`inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                    activePin.isNext
                      ? 'bg-amber-500 text-zinc-950'
                      : 'bg-red-600 text-white'
                  }`}
                >
                  <Compass className="w-3 h-3" />
                  Parada #{activePin.orderIndex}
                  {activePin.isPinnedStart ? ' · Inicio elegido' : activePin.isNext ? ' · Siguiente' : ''}
                </span>
              )}
              {activePin.entrega.zona_direccion && (
                <span className="text-[11px] font-bold text-sky-300 inline-flex items-center gap-0.5">
                  <MapPin className="w-3 h-3" />
                  {activePin.entrega.zona_direccion}
                </span>
              )}
            </div>
            <p className="text-sm font-black text-white truncate mt-0.5">
              {activePin.entrega.cliente}
            </p>
            <p className="text-[11px] text-zinc-300 font-semibold">
              {activePin.stop && activePin.stop.legDistanceKm != null
                ? `Tramo: ${activePin.stop.legDistanceKm.toFixed(1)} km · ~${activePin.stop.legDurationMin ?? 0} min · Acumulado: ${activePin.stop.cumulativeDistanceKm.toFixed(1)} km`
                : `${activePin.lat.toFixed(4)}, ${activePin.lng.toFixed(4)}`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {activePin.kind === 'pending' && !activePin.isPinnedStart && (
              <button
                type="button"
                data-testid={`mapa-btn-iniciar-${activePin.id}`}
                onClick={() => onSelectStartStop(activePin.id)}
                className="min-h-9 px-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black text-xs inline-flex items-center gap-1 cursor-pointer"
              >
                <Flag className="w-3.5 h-3.5" />
                Iniciar aquí
              </button>
            )}
            <a
              href={
                activePin.stop?.googleMapsStopUrl ??
                buildGoogleMapsSingleStopUrl(activePin.entrega, validDriverGps)
              }
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`mapa-btn-gmaps-${activePin.id}`}
              className="min-h-9 px-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-black text-xs inline-flex items-center gap-1"
            >
              <Navigation className="w-3.5 h-3.5" />
              Maps
              <ExternalLink className="w-3 h-3" />
            </a>
            {onFocusCard && (
              <button
                type="button"
                onClick={() => onFocusCard(activePin.id)}
                className="min-h-9 px-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-white/15 font-bold text-xs cursor-pointer"
              >
                Ver entrega
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
