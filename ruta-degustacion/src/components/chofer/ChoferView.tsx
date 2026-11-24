import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Filter } from 'lucide-react';
import type { EntregaVista, GeoPoint } from '../../types';
import type { EntregasRepository, SyncState } from '../../services/entregasRepository';
import {
  computeOptimalRoute,
  evaluateOffOrderCompletion,
  haversineKm,
  type OptimizedStop,
  type RouteAnchor,
  type RouteOriginMode,
} from '../../lib/routeOptimizer';
import { isValidVenezuelaCoord } from '../../lib/clientGeoMatcher';
import { getMeta, setMeta } from '../../lib/offlineDb';
import { diasUnicos, resumir } from '../../utils/format';
import { EmptyState } from '../common/EmptyState';
import { SyncStatusBanner } from '../common/SyncStatusBanner';
import { DayTabs, TurnoFilter, type TurnoFiltro } from './DayTabs';
import { ProgressBar } from './ProgressBar';
import { EntregaCard } from './EntregaCard';
import { RouteOptimizerPanel } from './RouteOptimizerPanel';

interface ChoferViewProps {
  entregas: EntregaVista[];
  repo: EntregasRepository;
  sync: SyncState;
}

const ROUTE_STATE_LS_KEY = 'codizulca.ruta.chofer_route_state.v1';
const ROUTE_STATE_IDB_KEY = 'chofer_route_state_v1';
const GPS_DRIFT_RECALC_KM = 0.25;

interface PersistedRouteState {
  originMode: RouteOriginMode;
  startDeliveryId: string | null;
  ordenOptimoActivo: boolean;
  lastCompletedAnchor: RouteAnchor | null;
  lastDriverGps: GeoPoint | null;
}

function readLocalRouteState(): PersistedRouteState {
  const fallback: PersistedRouteState = {
    originMode: 'gps',
    startDeliveryId: null,
    ordenOptimoActivo: true,
    lastCompletedAnchor: null,
    lastDriverGps: null,
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(ROUTE_STATE_LS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedRouteState>;
    return {
      originMode: parsed.originMode === 'stop' ? 'stop' : 'gps',
      startDeliveryId: typeof parsed.startDeliveryId === 'string' ? parsed.startDeliveryId : null,
      ordenOptimoActivo: parsed.ordenOptimoActivo !== false,
      lastCompletedAnchor: parsed.lastCompletedAnchor ?? null,
      lastDriverGps:
        parsed.lastDriverGps &&
        isValidVenezuelaCoord(parsed.lastDriverGps.lat, parsed.lastDriverGps.lng)
          ? parsed.lastDriverGps
          : null,
    };
  } catch {
    return fallback;
  }
}

function persistRouteState(state: PersistedRouteState): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ROUTE_STATE_LS_KEY, JSON.stringify(state));
    }
  } catch {
    /* modo restringido */
  }
  void setMeta(ROUTE_STATE_IDB_KEY, state).catch(() => undefined);
}

export function ChoferView({ entregas, repo, sync }: ChoferViewProps) {
  const dias = useMemo(() => diasUnicos(entregas), [entregas]);
  const [diaSel, setDiaSel] = useState<string>('');
  const [turno, setTurno] = useState<TurnoFiltro>('TODOS');
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [completadasAlFinal, setCompletadasAlFinal] = useState(true);
  const [errorAccion, setErrorAccion] = useState('');

  // Estado persistente offline del ruteo óptimo
  const initialRoute = useMemo(() => readLocalRouteState(), []);
  const [originMode, setOriginMode] = useState<RouteOriginMode>(initialRoute.originMode);
  const [startDeliveryId, setStartDeliveryId] = useState<string | null>(initialRoute.startDeliveryId);
  const [ordenOptimoActivo, setOrdenOptimoActivo] = useState<boolean>(initialRoute.ordenOptimoActivo);
  const [lastCompletedAnchor, setLastCompletedAnchor] = useState<RouteAnchor | null>(
    initialRoute.lastCompletedAnchor,
  );
  const [driverGps, setDriverGps] = useState<GeoPoint | null>(initialRoute.lastDriverGps);
  const [gpsStatus, setGpsStatus] = useState<'idle' | 'watching' | 'error'>('idle');
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [recalcNotice, setRecalcNotice] = useState<string | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const lastGpsAnchorRef = useRef<GeoPoint | null>(initialRoute.lastDriverGps);
  const plannedPendingIdsRef = useRef<string[]>([]);

  // Restaurar desde IndexedDB si localStorage fue limpiado pero IndexedDB conserva la ruta offline
  useEffect(() => {
    let active = true;
    void getMeta<PersistedRouteState>(ROUTE_STATE_IDB_KEY)
      .then((saved) => {
        if (!active || !saved) return;
        setOriginMode((prev) => (prev === 'gps' && saved.originMode === 'stop' ? 'stop' : prev));
        setStartDeliveryId((prev) => prev ?? saved.startDeliveryId ?? null);
        if (saved.lastCompletedAnchor) {
          setLastCompletedAnchor((prev) => prev ?? saved.lastCompletedAnchor);
        }
        if (
          saved.lastDriverGps &&
          isValidVenezuelaCoord(saved.lastDriverGps.lat, saved.lastDriverGps.lng)
        ) {
          setDriverGps((prev) => prev ?? saved.lastDriverGps);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Guardar estado de ruteo localmente (100 % offline, 0 llamadas de red)
  useEffect(() => {
    persistRouteState({
      originMode,
      startDeliveryId,
      ordenOptimoActivo,
      lastCompletedAnchor,
      lastDriverGps: driverGps,
    });
  }, [originMode, startDeliveryId, ordenOptimoActivo, lastCompletedAnchor, driverGps]);

  const startGpsWatch = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGpsStatus('error');
      setGpsError('Tu navegador no soporta GPS en vivo.');
      return;
    }

    setGpsError(null);
    setGpsStatus('watching');

    const handlePos = (pos: GeolocationPosition) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      if (!isValidVenezuelaCoord(lat, lng)) {
        setGpsError(
          'Tu GPS reportó una posición fuera de Venezuela (se mantiene tu punto de partida elegido).',
        );
        return;
      }
      const nextPoint: GeoPoint = {
        lat,
        lng,
        accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
        updatedAtIso: new Date().toISOString(),
      };
      const prevAnchor = lastGpsAnchorRef.current;
      const movedKm = prevAnchor ? haversineKm(prevAnchor, nextPoint) : Infinity;

      setDriverGps(nextPoint);
      setGpsError(null);

      // Si el vehículo se desplazó > 250 m en modo automático, actualizar referencia silenciosamente
      if (movedKm >= GPS_DRIFT_RECALC_KM) {
        lastGpsAnchorRef.current = nextPoint;
      }
    };

    const handleErr = (err: GeolocationPositionError) => {
      setGpsStatus('error');
      if (err.code === err.PERMISSION_DENIED) {
        setGpsError('Permiso de ubicación GPS denegado.');
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        setGpsError('Señal GPS temporalmente no disponible.');
      } else {
        setGpsError('Tiempo de espera agotado al obtener señal GPS.');
      }
    };

    navigator.geolocation.getCurrentPosition(handlePos, handleErr, {
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 15_000,
    });

    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    watchIdRef.current = navigator.geolocation.watchPosition(handlePos, () => undefined, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 15_000,
    });
  }, []);

  // Si el permiso de geolocalización ya está otorgado, arrancar seguimiento GPS en vivo en segundo plano
  useEffect(() => {
    let active = true;
    const perms = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
    if (perms?.query) {
      void perms
        .query({ name: 'geolocation' as PermissionName })
        .then((status) => {
          if (active && status.state === 'granted') {
            startGpsWatch();
          }
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [startGpsWatch]);

  // Si el día elegido ya no existe (p. ej. tras importar), cae al primero disponible.
  const dia = dias.includes(diaSel) ? diaSel : dias[0] ?? '';

  const conteoPorDia = useMemo(() => {
    const out: Record<string, { completadas: number; total: number }> = {};
    for (const d of dias) {
      const r = resumir(entregas.filter((e) => e.fecha === d));
      out[d] = { completadas: r.entregadas, total: r.total };
    }
    return out;
  }, [entregas, dias]);

  const delDia = useMemo(() => entregas.filter((e) => e.fecha === dia), [entregas, dia]);
  const progreso = resumir(delDia);

  const delDiaYTurno = useMemo(
    () => delDia.filter((e) => turno === 'TODOS' || e.turno === turno),
    [delDia, turno],
  );

  const pendingForSelect = useMemo(
    () => delDiaYTurno.filter((e) => !e.completado),
    [delDiaYTurno],
  );

  // Calcular ruta óptima offline en tiempo real (< 1 ms, 0 peticiones de red)
  const routePlan = useMemo(
    () =>
      computeOptimalRoute({
        deliveries: delDiaYTurno,
        originMode,
        startDeliveryId,
        driverGps,
        lastCompletedAnchor,
      }),
    [delDiaYTurno, originMode, startDeliveryId, driverGps, lastCompletedAnchor],
  );

  useEffect(() => {
    plannedPendingIdsRef.current = routePlan.orderedPending.map((s) => s.entrega.id);
  }, [routePlan.orderedPending]);

  const routeStopById = useMemo(() => {
    const map = new Map<string, OptimizedStop>();
    for (const stop of routePlan.orderedPending) {
      map.set(stop.entrega.id, stop);
    }
    return map;
  }, [routePlan.orderedPending]);

  const visibles = useMemo(() => {
    if (ordenOptimoActivo) {
      const pendingOrdered = routePlan.orderedPending.map((s) => s.entrega);
      if (soloPendientes) return pendingOrdered;
      return completadasAlFinal
        ? [...pendingOrdered, ...routePlan.completedDeliveries]
        : [...routePlan.completedDeliveries, ...pendingOrdered];
    }

    let lista = delDiaYTurno;
    if (soloPendientes) lista = lista.filter((e) => !e.completado);
    if (completadasAlFinal) {
      lista = [...lista].sort((a, b) => Number(a.completado) - Number(b.completado));
    }
    return lista;
  }, [delDiaYTurno, soloPendientes, completadasAlFinal, ordenOptimoActivo, routePlan]);

  const gestionar = useCallback((fn: () => Promise<void>) => {
    setErrorAccion('');
    fn().catch((err) => {
      console.error('[RutaDegustación]', err);
      setErrorAccion(err instanceof Error ? err.message : 'No se pudo completar la acción.');
    });
  }, []);

  const handleSelectStartStop = useCallback((deliveryId: string) => {
    setErrorAccion('');
    setOriginMode('stop');
    setStartDeliveryId(deliveryId);
    setOrdenOptimoActivo(true);
    setRecalcNotice(null);
  }, []);

  const handleSelectOriginModeGps = useCallback(() => {
    setErrorAccion('');
    setOriginMode('gps');
    setStartDeliveryId(null);
    setOrdenOptimoActivo(true);
    setRecalcNotice(null);
  }, []);

  const handleRequestGpsRecalculate = useCallback(() => {
    setOriginMode('gps');
    setStartDeliveryId(null);
    setOrdenOptimoActivo(true);
    startGpsWatch();
  }, [startGpsWatch]);

  /**
   * Recálculo dinámico automático cuando el chofer completa una entrega:
   * - Si entregó fuera de secuencia (A → C en vez de A → B), recalcula inmediatamente todas las
   *   paradas restantes desde su GPS actual (o desde C) hacia el siguiente cliente óptimo.
   * - Si entregó la #1 prevista, avanza el ancla suavemente hacia el siguiente óptimo.
   */
  const applyPostCompletionRecalc = useCallback(
    (deliveredId: string) => {
      const check = evaluateOffOrderCompletion({
        plannedPendingIds: plannedPendingIdsRef.current,
        deliveriesBefore: delDiaYTurno,
        deliveredId,
        driverGps,
      });

      const remainingAfter = delDiaYTurno.filter((d) => !d.completado && d.id !== deliveredId);
      const nextAnchor = check.recalculatedAnchor ?? lastCompletedAnchor;

      if (check.deviated) {
        // Desvío real (ej. A → C): liberar punto fijo anterior y recalcular desde ubicación actual / C
        setOriginMode('gps');
        setStartDeliveryId(null);
        if (nextAnchor) setLastCompletedAnchor(nextAnchor);

        if (remainingAfter.length > 0) {
          const previewNext = computeOptimalRoute({
            deliveries: remainingAfter,
            originMode: 'gps',
            startDeliveryId: null,
            driverGps,
            lastCompletedAnchor: nextAnchor,
          });
          const nextStop = previewNext.orderedPending[0];
          const nextLabel = nextStop
            ? `${nextStop.entrega.cliente}${nextStop.entrega.zona_direccion ? ` (${nextStop.entrega.zona_direccion})` : ''}${
                nextStop.legDistanceKm != null && nextStop.legDistanceKm > 0
                  ? ` · ${nextStop.legDistanceKm.toFixed(1)} km (~${nextStop.legDurationMin ?? 0} min)`
                  : ''
              }`
            : '';
          setRecalcNotice(
            nextLabel
              ? `${check.message} Siguiente parada óptima: ${nextLabel}.`
              : check.message,
          );
        } else {
          setRecalcNotice(check.message);
        }
      } else {
        // Entrega en orden normal: avanzar el punto de partida automáticamente
        if (startDeliveryId === deliveredId) {
          setStartDeliveryId(null);
          setOriginMode('gps');
        }
        if (nextAnchor) setLastCompletedAnchor(nextAnchor);
      }
    },
    [delDiaYTurno, driverGps, lastCompletedAnchor, startDeliveryId],
  );

  const handleConfirmarLlegada = useCallback(
    (id: string) => {
      applyPostCompletionRecalc(id);
      gestionar(() => repo.confirmarLlegada(id));
    },
    [applyPostCompletionRecalc, gestionar, repo],
  );

  const handleToggleEntrega = useCallback(
    (id: string) => {
      const current = delDiaYTurno.find((e) => e.id === id);
      if (current && !current.completado) {
        applyPostCompletionRecalc(id);
      }
      gestionar(() => repo.toggleEntrega(id));
    },
    [applyPostCompletionRecalc, delDiaYTurno, gestionar, repo],
  );

  const handlePinCurrentGps = useCallback(
    (deliveryId: string) => {
      if (!driverGps || !repo.saveManualGeoPin) return;
      gestionar(() => repo.saveManualGeoPin!(deliveryId, driverGps));
    },
    [driverGps, gestionar, repo],
  );

  const focusDeliveryCard = useCallback((deliveryId: string) => {
    const el = document.querySelector(`[data-testid="entrega-${deliveryId}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  return (
    <div className="space-y-3.5 max-w-3xl mx-auto" data-testid="vista-chofer">
      {/* Siempre visible: queda fijo justo debajo de la cabecera mientras el chofer recorre su ruta */}
      <div
        className="sticky z-30 -mx-3 sm:-mx-6 px-3 sm:px-6 pt-1.5 pb-1.5 bg-zinc-100/95 backdrop-blur"
        style={{ top: 'var(--hdr-h, 0px)' }}
      >
        <SyncStatusBanner sync={sync} onRetry={() => repo.flushNow()} />
      </div>
      <DayTabs dias={dias} dia={dia} onChange={setDiaSel} conteo={conteoPorDia} />
      <TurnoFilter turno={turno} onChange={setTurno} />
      <ProgressBar completadas={progreso.entregadas} total={progreso.total} etiquetaDia={dia} />

      {/* Panel de Ruteo Óptimo + Mapa Offline + Google Maps + Recálculo Dinámico */}
      {entregas.length > 0 && delDiaYTurno.length > 0 && (
        <RouteOptimizerPanel
          plan={routePlan}
          pendingForSelect={pendingForSelect}
          originMode={originMode}
          startDeliveryId={startDeliveryId}
          ordenOptimoActivo={ordenOptimoActivo}
          driverGps={driverGps}
          gpsStatus={gpsStatus}
          gpsError={gpsError}
          recalcNotice={recalcNotice}
          onSelectOriginModeGps={handleSelectOriginModeGps}
          onSelectStartStop={handleSelectStartStop}
          onToggleOrdenOptimo={() => setOrdenOptimoActivo((v) => !v)}
          onRequestGpsRecalculate={handleRequestGpsRecalculate}
          onDismissRecalcNotice={() => setRecalcNotice(null)}
          onFocusCard={focusDeliveryCard}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <button
          aria-pressed={soloPendientes}
          data-testid="filtro-solo-pendientes"
          onClick={() => setSoloPendientes((v) => !v)}
          className={`min-h-12 px-4 rounded-xl border-2 font-black text-sm flex items-center gap-2 cursor-pointer ${
            soloPendientes ? 'bg-brand border-brand text-white' : 'bg-white border-zinc-300 text-zinc-700'
          }`}
        >
          <Filter className="w-4 h-4" />
          Solo pendientes
        </button>
        <button
          aria-pressed={completadasAlFinal}
          data-testid="orden-completadas-al-final"
          onClick={() => setCompletadasAlFinal((v) => !v)}
          className={`min-h-12 px-4 rounded-xl border-2 font-black text-sm flex items-center gap-2 cursor-pointer ${
            completadasAlFinal ? 'bg-ink border-ink text-white' : 'bg-white border-zinc-300 text-zinc-700'
          }`}
        >
          <ArrowDownToLine className="w-4 h-4" />
          Completadas al final
        </button>
      </div>

      {errorAccion && (
        <p role="alert" data-testid="chofer-error" className="text-sm font-bold text-red-700 bg-red-50 border border-red-300 rounded-lg px-3 py-2">
          {errorAccion}
        </p>
      )}

      {entregas.length === 0 ? (
        <EmptyState sync={sync} onRefresh={() => repo.refresh()} />
      ) : visibles.length === 0 ? (
        <EmptyState
          testId="empty-state-filtro"
          titulo={soloPendientes && progreso.total > 0 ? '¡Todo entregado!' : 'No hay paradas para este filtro'}
          descripcion={
            soloPendientes && progreso.total > 0
              ? 'No quedan entregas pendientes con este filtro.'
              : 'Cambia el día o el turno para ver más paradas.'
          }
        />
      ) : (
        <ul className="space-y-3.5" data-testid="lista-entregas">
          {visibles.map((e) => (
            <li key={e.id}>
              <EntregaCard
                entrega={e}
                routeStop={ordenOptimoActivo ? routeStopById.get(e.id) ?? null : null}
                hasDriverGps={Boolean(driverGps)}
                onSelectStartStop={handleSelectStartStop}
                onPinCurrentGps={repo.saveManualGeoPin ? handlePinCurrentGps : undefined}
                onToggle={handleToggleEntrega}
                onConfirmarSalida={(id) => gestionar(() => repo.confirmarSalida(id))}
                onConfirmarLlegada={handleConfirmarLlegada}
                onSubirEvidencia={(id, file) => repo.subirEvidencia(id, file)}
                onObtenerUrlEvidencia={(path, bucket) => repo.obtenerUrlEvidencia(path, bucket)}
                onNota={(id, nota) => gestionar(() => repo.setNota(id, nota))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
