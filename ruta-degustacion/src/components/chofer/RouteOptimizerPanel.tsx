import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Flag,
  LocateFixed,
  Map as MapIcon,
  Navigation,
  RefreshCw,
  Route,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import type { EntregaVista, GeoPoint } from '../../types';
import type { OptimizedRoutePlan, RouteOriginMode } from '../../lib/routeOptimizer';
import { OfflineRouteMap } from './OfflineRouteMap';

interface RouteOptimizerPanelProps {
  plan: OptimizedRoutePlan;
  pendingForSelect: EntregaVista[];
  originMode: RouteOriginMode;
  startDeliveryId: string | null;
  ordenOptimoActivo: boolean;
  driverGps: GeoPoint | null;
  gpsStatus: 'idle' | 'watching' | 'error';
  gpsError: string | null;
  recalcNotice: string | null;
  onSelectOriginModeGps: () => void;
  onSelectStartStop: (deliveryId: string) => void;
  onToggleOrdenOptimo: () => void;
  onRequestGpsRecalculate: () => void;
  onDismissRecalcNotice: () => void;
  onFocusCard?: (deliveryId: string) => void;
}

function formatStopOptionLabel(e: EntregaVista): string {
  const zona = e.zona_direccion ? ` · ${e.zona_direccion}` : '';
  return `${e.cliente}${zona} (${e.turno})`;
}

export function RouteOptimizerPanel({
  plan,
  pendingForSelect,
  originMode,
  startDeliveryId,
  ordenOptimoActivo,
  driverGps,
  gpsStatus,
  gpsError,
  recalcNotice,
  onSelectOriginModeGps,
  onSelectStartStop,
  onToggleOrdenOptimo,
  onRequestGpsRecalculate,
  onDismissRecalcNotice,
  onFocusCard,
}: RouteOptimizerPanelProps) {
  const [mapaVisible, setMapaVisible] = useState(true);
  const [itinerarioVisible, setItinerarioVisible] = useState(true);

  const selectValue =
    originMode === 'stop' && startDeliveryId && pendingForSelect.some((e) => e.id === startDeliveryId)
      ? startDeliveryId
      : '__GPS__';

  const handleSelectChange = (val: string) => {
    if (val === '__GPS__') {
      onSelectOriginModeGps();
    } else if (val) {
      onSelectStartStop(val);
    }
  };

  if (plan.orderedPending.length === 0 && plan.completedDeliveries.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="panel-ruteo-optimo"
      aria-label="Ruteo óptimo y mapa offline"
      className="rounded-2xl border-2 border-zinc-800 bg-white shadow-sm overflow-hidden"
    >
      {/* Cabecera de Ruteo Óptimo */}
      <div className="bg-ink text-white px-3.5 py-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-brand grid place-items-center shrink-0">
            <Route className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-black leading-tight flex items-center gap-1.5 flex-wrap">
              <span>Ruteo Óptimo + Google Maps</span>
              <span className="inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/45 text-emerald-200">
                <WifiOff className="w-3 h-3" />
                Funciona Offline
              </span>
            </h2>
            <p className="text-[11px] text-zinc-300 font-semibold truncate">
              {plan.orderedPending.length > 0
                ? `${plan.orderedPending.length} paradas pendientes · ${plan.totalDistanceKm.toFixed(1)} km · ~${plan.totalDurationMin} min`
                : 'Todas las paradas de este filtro ya fueron entregadas'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="btn-toggle-orden-optimo"
            aria-pressed={ordenOptimoActivo}
            onClick={onToggleOrdenOptimo}
            className={`min-h-9 px-2.5 rounded-lg text-xs font-black border transition cursor-pointer inline-flex items-center gap-1 ${
              ordenOptimoActivo
                ? 'bg-amber-400 border-amber-300 text-zinc-950'
                : 'bg-zinc-900 border-white/20 text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            {ordenOptimoActivo ? 'Orden Óptimo: ON' : 'Orden Óptimo: OFF'}
          </button>

          <button
            type="button"
            data-testid="btn-toggle-mapa-offline"
            onClick={() => setMapaVisible((v) => !v)}
            className="min-h-9 px-2.5 rounded-lg text-xs font-bold bg-zinc-900 hover:bg-zinc-800 border border-white/15 text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
          >
            <MapIcon className="w-3.5 h-3.5 text-red-400" />
            <span>{mapaVisible ? 'Ocultar mapa' : 'Ver mapa'}</span>
            {mapaVisible ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="p-3.5 space-y-3">
        {/* Aviso automático de recálculo dinámico ante desvío (A -> C) */}
        {recalcNotice && (
          <div
            role="status"
            data-testid="ruta-recalculada-aviso"
            className="rounded-xl border-2 border-emerald-600 bg-emerald-50 px-3 py-2.5 text-xs sm:text-sm font-bold text-emerald-950 flex items-start justify-between gap-2"
          >
            <div className="flex items-start gap-2">
              <RefreshCw className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
              <span>{recalcNotice}</span>
            </div>
            <button
              type="button"
              onClick={onDismissRecalcNotice}
              aria-label="Cerrar aviso de recálculo"
              className="p-1 rounded hover:bg-emerald-200/70 text-emerald-900 cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Selector de punto de partida */}
        {pendingForSelect.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="chofer-start-stop-select"
                className="text-xs font-black uppercase tracking-wide text-zinc-700 flex items-center gap-1.5"
              >
                <Flag className="w-4 h-4 text-brand" />
                Punto de partida de entregas
              </label>

              <button
                type="button"
                data-testid="btn-recalcular-gps"
                onClick={onRequestGpsRecalculate}
                className={`min-h-9 px-3 rounded-lg border-2 text-xs font-black inline-flex items-center gap-1.5 cursor-pointer transition ${
                  gpsStatus === 'watching' && driverGps
                    ? 'bg-sky-50 border-sky-600 text-sky-900 hover:bg-sky-100'
                    : 'bg-white border-zinc-400 text-zinc-800 hover:bg-zinc-50'
                }`}
              >
                <LocateFixed className="w-3.5 h-3.5 text-sky-600" />
                {driverGps
                  ? `GPS Activo${driverGps.accuracy ? ` (±${Math.round(driverGps.accuracy)}m)` : ''} · Recalcular`
                  : 'Activar GPS y Recalcular'}
              </button>
            </div>

            <select
              id="chofer-start-stop-select"
              data-testid="ruta-inicio-select"
              value={selectValue}
              onChange={(e) => handleSelectChange(e.target.value)}
              className="w-full min-h-12 rounded-xl border-2 border-zinc-400 bg-zinc-50 px-3 py-2 text-sm font-extrabold text-ink focus:outline-none focus:border-brand focus:bg-white cursor-pointer"
            >
              <option value="__GPS__">
                📍 Automático desde mi ubicación GPS / última entrega
              </option>
              {pendingForSelect.map((e) => (
                <option key={e.id} value={e.id}>
                  🏁 Iniciar en: {formatStopOptionLabel(e)}
                </option>
              ))}
            </select>

            {gpsError && (
              <p data-testid="ruta-gps-aviso" className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-2.5 py-1.5">
                {gpsError} Puedes elegir manualmente cualquier cliente de partida; el ruteo offline sigue 100 % operativo.
              </p>
            )}
          </div>
        )}

        {/* Mapa táctico interactivo 100 % offline */}
        {mapaVisible && (
          <OfflineRouteMap
            plan={plan}
            driverGps={driverGps}
            onSelectStartStop={onSelectStartStop}
            onFocusCard={onFocusCard}
          />
        )}

        {/* Resumen de métricas + Botón principal Google Maps */}
        {plan.orderedPending.length > 0 && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-zinc-50 border border-zinc-200 px-2.5 py-2">
                <p className="text-[10px] font-bold uppercase text-zinc-500">Distancia Est.</p>
                <p data-testid="ruta-total-km" className="text-base sm:text-lg font-black text-ink">
                  {plan.totalDistanceKm.toFixed(1)} km
                </p>
              </div>
              <div className="rounded-xl bg-zinc-50 border border-zinc-200 px-2.5 py-2">
                <p className="text-[10px] font-bold uppercase text-zinc-500 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Tiempo Est.
                </p>
                <p data-testid="ruta-total-min" className="text-base sm:text-lg font-black text-ink">
                  ~{plan.totalDurationMin} min
                </p>
              </div>
              <div className="rounded-xl bg-emerald-50 border border-emerald-300 px-2.5 py-2">
                <p className="text-[10px] font-bold uppercase text-emerald-700">Ahorro Óptimo</p>
                <p data-testid="ruta-ahorro-km" className="text-base sm:text-lg font-black text-emerald-900">
                  {plan.savedDistanceKm >= 0.2 ? `-${plan.savedDistanceKm.toFixed(1)} km` : 'Óptima ✓'}
                </p>
              </div>
            </div>

            {/* Botones de Google Maps sincronizados */}
            <div className="flex flex-wrap gap-2">
              {plan.googleMapsSegments.map((seg) => (
                <a
                  key={seg.segmentIndex}
                  href={seg.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={
                    seg.segmentIndex === 1
                      ? 'btn-abrir-google-maps-ruta'
                      : `btn-abrir-google-maps-tramo-${seg.segmentIndex}`
                  }
                  className="flex-1 min-w-[210px] min-h-12 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-sm flex items-center justify-center gap-2 shadow-sm transition"
                >
                  <Navigation className="w-4 h-4 shrink-0" />
                  <span>Abrir {seg.label} en Google Maps</span>
                  <ExternalLink className="w-4 h-4 shrink-0" />
                </a>
              ))}
            </div>

            {/* Itinerario secuencial compacto */}
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 overflow-hidden">
              <button
                type="button"
                onClick={() => setItinerarioVisible((v) => !v)}
                className="w-full px-3 py-2 flex items-center justify-between text-xs font-black uppercase text-zinc-700 hover:bg-zinc-100 cursor-pointer"
              >
                <span>Secuencia recomendada ({plan.orderedPending.length} paradas)</span>
                {itinerarioVisible ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>

              {itinerarioVisible && (
                <ol
                  data-testid="lista-secuencia-optima"
                  className="divide-y divide-zinc-200 border-t border-zinc-200"
                >
                  {plan.orderedPending.map((stop) => (
                    <li
                      key={stop.entrega.id}
                      data-testid={`secuencia-stop-${stop.entrega.id}`}
                      className={`px-3 py-2 flex flex-wrap items-center justify-between gap-2 ${
                        stop.orderIndex === 1 ? 'bg-amber-50/90' : 'bg-white'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => onFocusCard?.(stop.entrega.id)}
                        className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <span
                          className={`w-7 h-7 rounded-full grid place-items-center text-xs font-black shrink-0 ${
                            stop.orderIndex === 1
                              ? 'bg-amber-500 text-zinc-950'
                              : 'bg-zinc-900 text-white'
                          }`}
                        >
                          {stop.orderIndex}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs sm:text-sm font-black text-ink truncate">
                            {stop.entrega.cliente}
                            {stop.entrega.zona_direccion ? ` · ${stop.entrega.zona_direccion}` : ''}
                          </p>
                          <p className="text-[11px] font-semibold text-zinc-600">
                            {stop.isPinnedStart
                              ? 'Punto de partida elegido'
                              : stop.orderIndex === 1
                                ? 'Siguiente parada óptima'
                                : `Tramo +${(stop.legDistanceKm ?? 0).toFixed(1)} km · ~${stop.legDurationMin ?? 0} min`}
                            {stop.entrega.geo_precision === 'exacta'
                              ? ' · GPS exacto'
                              : stop.entrega.geo_precision === 'manual'
                                ? ' · GPS fijado'
                                : stop.entrega.geo_precision === 'zona'
                                  ? ' · GPS zona'
                                  : ' · Por dirección'}
                          </p>
                        </div>
                      </button>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {!stop.isPinnedStart && (
                          <button
                            type="button"
                            data-testid={`secuencia-iniciar-${stop.entrega.id}`}
                            onClick={() => onSelectStartStop(stop.entrega.id)}
                            className="min-h-8 px-2 rounded-lg border border-zinc-300 bg-white hover:bg-amber-50 text-[11px] font-black text-zinc-800 cursor-pointer"
                            title="Elegir este cliente como primera visita"
                          >
                            Iniciar aquí
                          </button>
                        )}
                        <a
                          href={stop.googleMapsStopUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-h-8 px-2 rounded-lg bg-blue-50 hover:bg-blue-100 border border-blue-300 text-[11px] font-black text-blue-800 inline-flex items-center gap-1"
                          title="Abrir este cliente en Google Maps"
                        >
                          <Navigation className="w-3 h-3" />
                          Maps
                        </a>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
