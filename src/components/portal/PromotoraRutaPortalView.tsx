import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  LogOut,
  MapPin,
  Package,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { usePromotoraRutaRealtime } from '../../hooks/usePromotoraRutaRealtime';
import {
  GENERIC_INVALID_CREDENTIALS_MESSAGE,
  isValidPortalEmailFormat,
  normalizePortalEmail,
  signInPromotoraPortalWithPassword,
  signOutSupabaseSession,
  verifyActivePromotoraPortalAccess,
  type VerifiedAuthProfile,
} from '../../services/authService';
import {
  fetchPortalPdvGeofences,
  matchRutaPdvGeofence,
  submitPromotoraRouteExecution,
  type PortalPdvGeofenceRef,
} from '../../services/promotoraRutaPortalService';
import {
  decodeBase64ToBlob,
  enqueuePortalAction,
  flushPortalOfflineQueue,
  isTransientOfflineOrNetworkError,
  listPendingPortalActions,
  type QueuedPortalAction,
} from '../../services/portalOfflineQueueService';
import { createIncidenciaPdv } from '../../services/popIncidenciasService';
import { isOperativeSucursal } from '../../services/userManagementService';
import { IncidenciaQuickModal } from './IncidenciaQuickModal';
import { AnimatedTabContainer } from '../ui/AnimatedTabContainer';
import { ControlRoomThemeToggle } from '../ui/ControlRoomThemeToggle';
import {
  captureBrowserGeolocation,
  evaluateGeofenceCheck,
  type CapturedGeolocationFix,
} from '../../utils/geofenceHaversine';
import type { EjecucionPdvInput } from '../../types/degustacionesPipeline';
import {
  getSupabaseClient,
  isSupabaseConfigured,
  SUPABASE_NOT_CONFIGURED_MESSAGE,
} from '../../services/supabaseClient';
import type { RutaPromotoraRecord } from '../../types/degustacionesPipeline';
import { getCaracasTodayYmd } from '../../utils/caracasWeekCycle';

type DateFilterMode = 'hoy' | 'proximas';

function formatDisplayDate(ymd: string): string {
  const parts = String(ymd || '').split('-');
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'Pendiente';
  try {
    return new Date(iso).toLocaleTimeString('es-VE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return 'Sincronizado';
  }
}

export const PromotoraRutaPortalView: React.FC = () => {
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [profile, setProfile] = useState<VerifiedAuthProfile | null>(null);

  const [emailInput, setEmailInput] = useState<string>('');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [dateFilter, setDateFilter] = useState<DateFilterMode>('proximas');
  const [liveBanner, setLiveBanner] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [processingRutaId, setProcessingRutaId] = useState<string | null>(null);

  // Candados síncronos contra envíos múltiples en dispositivos móviles
  const inFlightLoginRef = useRef<boolean>(false);
  const inFlightStepIdsRef = useRef<Set<string>>(new Set());

  const showBanner = useCallback((msg: string) => {
    setLiveBanner(msg);
  }, []);

  useEffect(() => {
    if (!liveBanner) return;
    const t = window.setTimeout(() => setLiveBanner(null), 5000);
    return () => window.clearTimeout(t);
  }, [liveBanner]);

  // Verificación criptográfica de sesión y pertenencia activa a Personal (public.staff)
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setAuthChecking(false);
      return;
    }

    let active = true;
    const client = getSupabaseClient();

    void client.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      if (!data.session) {
        setProfile(null);
        setAuthChecking(false);
        return;
      }

      const { profile: verified, unauthorizedReason } = await verifyActivePromotoraPortalAccess(
        data.session
      );
      if (!active) return;
      setProfile(verified);
      if (unauthorizedReason) {
        setLoginError(unauthorizedReason);
      }
      setAuthChecking(false);
    });

    const { data: listener } = client.auth.onAuthStateChange(async (event, session) => {
      if (!active || inFlightLoginRef.current) return;
      if (event === 'SIGNED_OUT' || !session) {
        setProfile(null);
        setAuthChecking(false);
        return;
      }

      const { profile: verified, unauthorizedReason } =
        await verifyActivePromotoraPortalAccess(session);
      if (!active) return;
      setProfile(verified);
      if (unauthorizedReason) {
        setLoginError(unauthorizedReason);
      }
      setAuthChecking(false);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const {
    routes,
    isLoading,
    isRefreshing,
    isRealtimeConnected,
    lastSyncedAt,
    error: routeFetchError,
    refreshRoutes,
    applyOptimisticRouteUpdate,
  } = usePromotoraRutaRealtime({
    profile,
    supervisorFilterPromotoraId: null,
    onLiveBanner: showBanner,
  });

  const todayYmd = getCaracasTodayYmd();

  const filteredRoutes = useMemo(() => {
    return routes.filter((r) => {
      if (dateFilter === 'hoy') return r.fecha === todayYmd;
      return r.fecha >= todayYmd;
    });
  }, [routes, dateFilter, todayYmd]);

  const handleLoginSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting || inFlightLoginRef.current) return;

    const normalizedEmail = normalizePortalEmail(emailInput);
    if (!isValidPortalEmailFormat(normalizedEmail)) {
      setLoginError('Ingresa un correo electrónico con formato válido.');
      return;
    }
    if (passwordInput.trim().length === 0) {
      setLoginError('Ingresa tu contraseña.');
      return;
    }

    inFlightLoginRef.current = true;
    setLoginError(null);
    setIsSubmitting(true);

    try {
      const { profile: verifiedProfile } = await signInPromotoraPortalWithPassword(
        normalizedEmail,
        passwordInput
      );
      setPasswordInput('');
      setShowPassword(false);
      setProfile(verifiedProfile);
    } catch (err) {
      setPasswordInput('');
      setLoginError(
        err instanceof Error && err.message
          ? err.message
          : GENERIC_INVALID_CREDENTIALS_MESSAGE
      );
    } finally {
      inFlightLoginRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await signOutSupabaseSession();
    setProfile(null);
    setPasswordInput('');
    setShowPassword(false);
    setLoginError(null);
  };

  // ---- Hito 5 (B-08): GPS + geocerca + ejecución PDV + cola offline ----
  const [geofenceCatalog, setGeofenceCatalog] = useState<PortalPdvGeofenceRef[]>([]);
  const [pendingOffline, setPendingOffline] = useState<QueuedPortalAction[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [geoFeedback, setGeoFeedback] = useState<Record<string, string>>({});
  const [executionTarget, setExecutionTarget] = useState<RutaPromotoraRecord | null>(null);
  const [execForm, setExecForm] = useState({
    lote: '',
    vencimiento: '',
    abiertas: '0',
    muestras: '0',
    ventas: '0',
    observaciones: '',
    motivoFuera: '',
  });
  const [execError, setExecError] = useState<string | null>(null);
  const [incidenciaModalOpen, setIncidenciaModalOpen] = useState<boolean>(false);
  const [incidenciaRutaTarget, setIncidenciaRutaTarget] = useState<RutaPromotoraRecord | null>(
    null
  );
  const flushingRef = useRef(false);

  const openIncidenciaModalForRuta = useCallback((ruta: RutaPromotoraRecord | null) => {
    setIncidenciaRutaTarget(ruta);
    setIncidenciaModalOpen(true);
  }, []);

  const refreshPending = useCallback(async () => {
    try {
      setPendingOffline(await listPendingPortalActions());
    } catch {
      setPendingOffline([]);
    }
  }, []);

  useEffect(() => {
    if (!profile) return;
    let active = true;
    void fetchPortalPdvGeofences().then((rows) => {
      if (active) setGeofenceCatalog(rows);
    });
    void refreshPending();
    return () => {
      active = false;
    };
  }, [profile, refreshPending]);

  const flushOfflineQueue = useCallback(
    async (force = false) => {
      if (flushingRef.current) return;
      flushingRef.current = true;
      try {
        const result = await flushPortalOfflineQueue(
          async (action) => {
            if (action.kind === 'INCIDENCIA_PDV') {
              const photoBlob = action.photoBase64
                ? decodeBase64ToBlob(action.photoBase64, action.photoMimeType)
                : null;
              await createIncidenciaPdv(
                {
                  pdvNombre: action.pdvNombre,
                  clienteId: action.clienteId ?? null,
                  rutaId: action.rutaId ?? null,
                  tipoIncidencia: action.tipoIncidencia,
                  severidad: action.severidad,
                  descripcion: action.descripcion,
                  ...(action.reportadoPorNombre
                    ? { reportadoPorNombre: action.reportadoPorNombre }
                    : {}),
                  ...(action.sucursal ? { sucursal: action.sucursal } : {}),
                },
                photoBlob
              );
              return;
            }

            await submitPromotoraRouteExecution({
              rutaId: action.rutaId,
              accion: action.accion,
              clientSubmissionId: action.id,
              lat: action.lat,
              lng: action.lng,
              accuracyMeters: action.accuracyMeters,
              motivoFueraGeocerca: action.motivoFueraGeocerca,
              ejecucion: action.ejecucion ?? null,
            });
          },
          { forceIgnoreSchedule: force }
        );
        if (result.succeeded > 0) {
          showBanner(`${result.succeeded} registro(s) offline sincronizado(s).`);
          void refreshRoutes();
        }
        await refreshPending();
      } finally {
        flushingRef.current = false;
      }
    },
    [refreshPending, refreshRoutes, showBanner]
  );

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      void flushOfflineQueue(true);
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const timer = window.setInterval(() => {
      if (navigator.onLine) void flushOfflineQueue(false);
    }, 30000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(timer);
    };
  }, [flushOfflineQueue]);

  const performRouteStep = async (
    item: RutaPromotoraRecord,
    accion: 'CHECKIN' | 'CHECKOUT',
    ejecucion: EjecucionPdvInput | null,
    motivoFuera: string
  ) => {
    if (!item.id || inFlightStepIdsRef.current.has(item.id)) return;
    inFlightStepIdsRef.current.add(item.id);
    setProcessingRutaId(item.id);
    setActionError(null);

    let fix: CapturedGeolocationFix | null = null;
    let gpsWarning = '';
    try {
      fix = await captureBrowserGeolocation();
    } catch (err) {
      gpsWarning = err instanceof Error ? err.message : 'GPS no disponible.';
    }

    const pdv = matchRutaPdvGeofence(item, geofenceCatalog);
    const evaluation = fix
      ? evaluateGeofenceCheck({
          capturedLat: fix.lat,
          capturedLng: fix.lng,
          accuracyMeters: fix.accuracyMeters,
          pdvLat: pdv?.latitud,
          pdvLng: pdv?.longitud,
          allowedRadiusMeters: pdv?.radioGeocercaM,
        })
      : null;

    if (evaluation?.requiresAuditJustification && !motivoFuera.trim() && accion === 'CHECKIN') {
      // Se permite continuar, pero queda auditado con motivo por defecto en servidor
    }

    const feedback = evaluation?.hasPdvCoordinates
      ? evaluation.insideGeofence
        ? `Dentro de geocerca (${evaluation.distanceMeters} m / ${evaluation.allowedRadiusMeters} m).`
        : `FUERA de geocerca: ${evaluation.distanceMeters} m (máx. ${evaluation.allowedRadiusMeters} m). Alerta auditada.`
      : gpsWarning || 'PDV sin coordenadas maestras: no se valida geocerca.';
    setGeoFeedback((prev) => ({ ...prev, [item.id]: feedback }));

    const submissionId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      const result = await submitPromotoraRouteExecution({
        rutaId: item.id,
        accion,
        clientSubmissionId: submissionId,
        lat: fix?.lat ?? null,
        lng: fix?.lng ?? null,
        accuracyMeters: fix?.accuracyMeters ?? null,
        motivoFueraGeocerca: motivoFuera,
        ejecucion,
      });
      applyOptimisticRouteUpdate(result.ruta);
      showBanner(
        accion === 'CHECKIN'
          ? `Check-in registrado en ${item.cliente_nombre}.`
          : `Degustación completada en ${item.cliente_nombre}.`
      );
      if (accion === 'CHECKOUT') setExecutionTarget(null);
    } catch (err) {
      if (isTransientOfflineOrNetworkError(err)) {
        await enqueuePortalAction({
          id: submissionId,
          rutaId: item.id,
          accion,
          clienteNombre: item.cliente_nombre,
          lat: fix?.lat ?? null,
          lng: fix?.lng ?? null,
          accuracyMeters: fix?.accuracyMeters ?? null,
          motivoFueraGeocerca: motivoFuera,
          ejecucion,
        });
        await refreshPending();
        showBanner('Sin conexión: el registro quedó en cola offline y se sincronizará automáticamente.');
        if (accion === 'CHECKOUT') setExecutionTarget(null);
      } else {
        const message =
          err instanceof Error ? err.message : 'No se pudo actualizar el estado de la ruta.';
        setActionError(message);
        setExecError(message);
      }
    } finally {
      inFlightStepIdsRef.current.delete(item.id);
      setProcessingRutaId((prev) => (prev === item.id ? null : prev));
    }
  };

  const handleRouteStep = async (item: RutaPromotoraRecord, accion: 'CHECKIN' | 'CHECKOUT') => {
    if (accion === 'CHECKOUT') {
      setExecError(null);
      setExecForm({
        lote: '',
        vencimiento: '',
        abiertas: '0',
        muestras: String(item.personas_estimadas || 0),
        ventas: '0',
        observaciones: '',
        motivoFuera: '',
      });
      setExecutionTarget(item);
      return;
    }
    await performRouteStep(item, 'CHECKIN', null, '');
  };

  const handleSubmitExecution = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!executionTarget) return;
    const abiertas = Number(execForm.abiertas);
    const muestras = Number(execForm.muestras);
    const ventas = Number(execForm.ventas);
    if (![abiertas, muestras, ventas].every((n) => Number.isFinite(n) && n >= 0)) {
      setExecError('Unidades abiertas, muestras y ventas deben ser números iguales o mayores a 0.');
      return;
    }
    if (execForm.lote.trim().length < 2) {
      setExecError('Indica el lote del producto degustado.');
      return;
    }
    if (execForm.vencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(execForm.vencimiento)) {
      setExecError('La fecha de vencimiento no es válida.');
      return;
    }
    setExecError(null);
    await performRouteStep(
      executionTarget,
      'CHECKOUT',
      {
        lote_producto: execForm.lote.trim(),
        fecha_vencimiento: execForm.vencimiento || null,
        unidades_abiertas: abiertas,
        muestras_entregadas: Math.trunc(muestras),
        ventas_asistidas_unidades: Math.trunc(ventas),
        observaciones: execForm.observaciones.trim(),
      },
      execForm.motivoFuera
    );
  };

  if (!isSupabaseConfigured) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-red-500/30 p-6 text-center space-y-3">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto" />
          <h1 className="text-lg font-extrabold">Portal de Promotoras sin conexión</h1>
          <p className="text-xs text-zinc-400">{SUPABASE_NOT_CONFIGURED_MESSAGE}</p>
        </div>
      </div>
    );
  }

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="flex items-center gap-3 text-sm font-mono text-zinc-300">
          <Loader2 className="w-5 h-5 text-red-500 animate-spin" />
          <span>Verificando acceso seguro...</span>
        </div>
      </div>
    );
  }

  // 1. Pantalla Minimalista de Login Exclusivo (Solo Correo Electrónico y Contraseña)
  if (!profile) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center px-4 py-8 font-sans selection:bg-red-600 selection:text-white">
        <div className="w-full max-w-sm rounded-2xl bg-zinc-950 border border-white/15 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.9)] p-6 sm:p-8 space-y-6">
          {/* Encabezado limpio de identificación del Portal de Promotoras */}
          <div className="flex flex-col items-center text-center space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-white p-2 flex items-center justify-center shadow-[0_4px_20px_rgba(220,38,38,0.28)] border border-white/90">
              <img
                src="/codizulca-logo.png"
                alt="CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-red-600/15 text-red-400 border border-red-500/30">
                <Lock className="w-3 h-3" /> Portal de Promotoras
              </span>
              <h1 className="text-xl font-extrabold tracking-tight text-white">
                Módulo de Ruta
              </h1>
              <p className="text-xs text-zinc-400">
                Ingresa con tu correo electrónico y contraseña
              </p>
            </div>
          </div>

          <form onSubmit={handleLoginSubmit} noValidate className="space-y-4">
            <div>
              <label
                htmlFor="portal-promotora-email"
                className="block text-xs font-bold text-zinc-200 mb-1.5"
              >
                Correo electrónico
              </label>
              <input
                id="portal-promotora-email"
                name="email"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="email"
                spellCheck={false}
                required
                disabled={isSubmitting}
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="nombre@correo.com"
                className="w-full px-3.5 py-3 rounded-xl bg-black border border-zinc-700 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/40 disabled:opacity-60 transition"
              />
            </div>

            <div>
              <label
                htmlFor="portal-promotora-password"
                className="block text-xs font-bold text-zinc-200 mb-1.5"
              >
                Contraseña
              </label>
              <div className="relative">
                <input
                  id="portal-promotora-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  disabled={isSubmitting}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-3.5 pr-11 py-3 rounded-xl bg-black border border-zinc-700 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/40 disabled:opacity-60 transition"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={isSubmitting}
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  className="absolute inset-y-0 right-0 px-3 flex items-center justify-center text-zinc-400 hover:text-white disabled:opacity-50 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {loginError && (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-xl bg-red-950/60 border border-red-500/45 px-3.5 py-2.5 text-xs text-red-100 flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3 px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-55 disabled:cursor-not-allowed text-white font-extrabold text-sm flex items-center justify-center gap-2 transition cursor-pointer shadow-lg shadow-red-950/60"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verificando acceso...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Iniciar Sesión</span>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 2. Vista Operativa Exclusiva del Módulo de Ruta de la Promotora Activa
  return (
    <div className="min-h-screen bg-[#09090b] text-white flex flex-col font-sans">
      <header className="sticky top-0 z-30 bg-zinc-950/90 backdrop-blur-xl border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-white p-1 flex items-center justify-center shrink-0">
              <img
                src="/codizulca-logo.png"
                alt="CODIZULCA"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-sm sm:text-base font-extrabold truncate">
                  Mi Ruta de Degustaciones
                </h1>
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                    isRealtimeConnected
                      ? 'bg-emerald-950/70 text-emerald-300 border-emerald-700/60'
                      : 'bg-amber-950/70 text-amber-300 border-amber-700/60'
                  }`}
                  title={
                    isRealtimeConnected
                      ? 'Suscripción WebSocket activa en tiempo real'
                      : 'Modo respaldo seguro activo (reconciliación automática)'
                  }
                >
                  {isRealtimeConnected ? (
                    <>
                      <Wifi className="w-3 h-3" /> En Vivo
                    </>
                  ) : (
                    <>
                      <WifiOff className="w-3 h-3" /> Respaldo
                    </>
                  )}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 truncate flex items-center gap-1.5">
                <UserCheck className="w-3 h-3 text-red-400 shrink-0" />
                <span className="truncate">{profile.displayName}</span>
                <span className="text-zinc-600">·</span>
                <span className="font-mono text-[10px] text-zinc-500">
                  Sync: {formatSyncTime(lastSyncedAt)}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ControlRoomThemeToggle compact />
            {(pendingOffline.length > 0 || !isOnline) && (
              <button
                type="button"
                onClick={() => void flushOfflineQueue(true)}
                disabled={!isOnline}
                title="Registros pendientes de sincronizar (cola offline). Toca para reintentar."
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border bg-amber-950/70 text-amber-300 border-amber-700/60 cursor-pointer disabled:opacity-60"
              >
                <WifiOff className="w-3 h-3" />
                {isOnline ? 'Sincronizar' : 'Offline'} · {pendingOffline.length}
              </button>
            )}
            <button
              type="button"
              onClick={() => void refreshRoutes()}
              disabled={isRefreshing}
              title="Recargar ruta verificada desde Supabase"
              className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-red-400' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              title="Cerrar sesión"
              className="p-2 rounded-xl bg-zinc-900 hover:bg-red-950/60 border border-zinc-800 hover:border-red-700 text-zinc-300 hover:text-red-300 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-5 space-y-4">
        {liveBanner && (
          <div className="rounded-xl bg-emerald-950/60 border border-emerald-500/40 px-4 py-2.5 text-xs text-emerald-200 font-semibold flex items-center justify-between gap-2">
            <span>{liveBanner}</span>
            <button
              type="button"
              onClick={() => setLiveBanner(null)}
              className="text-emerald-300 hover:text-white text-[11px] font-mono cursor-pointer"
            >
              OK
            </button>
          </div>
        )}

        {(routeFetchError || actionError) && (
          <div className="rounded-xl bg-red-950/50 border border-red-500/40 px-4 py-3 text-xs text-red-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{actionError || routeFetchError}</span>
            </div>
            <button
              type="button"
              onClick={() => void refreshRoutes()}
              className="px-2.5 py-1 rounded-lg bg-red-600 text-white font-bold text-[11px] shrink-0 cursor-pointer"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Filtros rápidos de horizonte temporal */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="inline-flex rounded-xl bg-zinc-950 border border-white/10 p-1 gap-1">
            {(
              [
                { id: 'proximas', label: 'Hoy y Programación Próxima' },
                { id: 'hoy', label: 'Solo Hoy' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setDateFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  dateFilter === tab.id
                    ? 'bg-red-600 text-white shadow'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-xs font-mono text-zinc-400">
              {filteredRoutes.length}{' '}
              {filteredRoutes.length === 1 ? 'degustación autorizada' : 'degustaciones autorizadas'}
            </span>
            <button
              type="button"
              data-testid="btn-open-incidencia-general"
              onClick={() => openIncidenciaModalForRuta(null)}
              className="px-3 py-1.5 rounded-xl bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/40 text-amber-200 text-xs font-extrabold inline-flex items-center gap-1.5 transition cursor-pointer"
            >
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>Reportar Incidencia</span>
            </button>
          </div>
        </div>

        {/* Listado de tarjetas de ruta */}
        {isLoading ? (
          <div className="rounded-2xl bg-zinc-950 border border-white/10 p-12 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 className="w-6 h-6 text-red-500 animate-spin" />
            <span className="text-xs font-mono">Sincronizando degustaciones asignadas...</span>
          </div>
        ) : filteredRoutes.length === 0 ? (
          <div className="rounded-2xl bg-zinc-950 border border-white/10 p-10 text-center space-y-2">
            <Calendar className="w-9 h-9 text-zinc-600 mx-auto" />
            <h2 className="text-sm font-bold text-zinc-200">
              Sin degustaciones asignadas en este filtro
            </h2>
            <p className="text-xs text-zinc-500 max-w-md mx-auto">
              Cuando la Coordinadora de Trade Marketing autorice y te asigne una degustación,
              aparecerá aquí automáticamente en tiempo real.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredRoutes.map((ruta) => {
              const isBusy = processingRutaId === ruta.id;
              const isToday = ruta.fecha === todayYmd;

              return (
                <article
                  key={ruta.id}
                  className={`rounded-2xl bg-zinc-950 border p-4 sm:p-5 transition ${
                    ruta.estado_ruta === 'EN_CURSO'
                      ? 'border-red-500/70 shadow-lg shadow-red-950/30'
                      : isToday
                        ? 'border-white/20'
                        : 'border-white/10'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-xs font-mono font-bold text-white">
                          <Calendar className="w-3.5 h-3.5 text-red-400" />
                          {formatDisplayDate(ruta.fecha)}
                        </span>
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-300">
                          <Clock className="w-3.5 h-3.5 text-zinc-400" />
                          {ruta.hora_inicio} - {ruta.hora_fin} ({ruta.turno})
                        </span>
                        {isToday && (
                          <span className="px-2 py-0.5 rounded bg-red-600/20 border border-red-500/40 text-[10px] font-black uppercase text-red-300">
                            HOY
                          </span>
                        )}
                      </div>

                      <h3 className="text-base sm:text-lg font-extrabold text-white mt-2">
                        {ruta.cliente_nombre}
                      </h3>
                      {ruta.zona_direccion && (
                        <p className="text-xs text-zinc-400 flex items-center gap-1.5 mt-0.5">
                          <MapPin className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          <span>{ruta.zona_direccion}</span>
                        </p>
                      )}
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-mono font-black uppercase border ${
                        ruta.estado_ruta === 'COMPLETADA'
                          ? 'bg-emerald-950/70 text-emerald-300 border-emerald-700'
                          : ruta.estado_ruta === 'EN_CURSO'
                            ? 'bg-red-600 text-white border-red-400'
                            : 'bg-zinc-900 text-zinc-200 border-zinc-700'
                      }`}
                    >
                      {ruta.estado_ruta === 'COMPLETADA' && <CheckCircle2 className="w-3.5 h-3.5" />}
                      {ruta.estado_ruta === 'EN_CURSO' && <Play className="w-3 h-3 fill-white" />}
                      {ruta.estado_ruta}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-3 border-t border-white/10 text-xs">
                    <div className="rounded-xl bg-black/60 border border-zinc-900 p-2.5">
                      <span className="text-[10px] uppercase font-mono text-zinc-500 block">
                        Producto(s) Aprobados
                      </span>
                      <span className="font-bold text-white flex items-center gap-1.5 mt-0.5">
                        <Package className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        <span>{ruta.producto_resumen}</span>
                      </span>
                    </div>

                    <div className="rounded-xl bg-black/60 border border-zinc-900 p-2.5">
                      <span className="text-[10px] uppercase font-mono text-zinc-500 block">
                        Meta Operativa
                      </span>
                      <span className="font-mono font-bold text-zinc-200 block mt-0.5">
                        {ruta.cantidad_kilos} kg/un · {ruta.personas_estimadas || 0} impactos est.
                      </span>
                    </div>

                    <div className="rounded-xl bg-black/60 border border-zinc-900 p-2.5">
                      <span className="text-[10px] uppercase font-mono text-zinc-500 block">
                        Solicitante FDV / Coord.
                      </span>
                      <span className="font-semibold text-zinc-200 block mt-0.5 truncate">
                        {ruta.vendedor_fdv || ruta.aprobado_por || 'Trade Marketing'}
                      </span>
                    </div>
                  </div>

                  {geoFeedback[ruta.id] && (
                    <p className="mt-2.5 text-xs font-mono text-amber-200 bg-amber-950/40 border border-amber-700/40 rounded-xl px-3 py-2 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 shrink-0" />
                      <span>{geoFeedback[ruta.id]}</span>
                    </p>
                  )}

                  {ruta.observaciones && (
                    <p className="mt-2.5 text-xs text-zinc-400 bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2">
                      {ruta.observaciones}
                    </p>
                  )}

                  {/* Controles operativos exclusivos para la promotora propietaria */}
                  {ruta.estado_ruta !== 'COMPLETADA' && (
                    <div className="mt-4 pt-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        data-testid={`btn-reportar-incidencia-${ruta.id}`}
                        onClick={() => openIncidenciaModalForRuta(ruta)}
                        className="px-3.5 py-2 rounded-xl bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/40 text-amber-200 text-xs font-extrabold flex items-center gap-1.5 transition cursor-pointer"
                      >
                        <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                        <span>Reportar Incidencia</span>
                      </button>

                      <div className="flex items-center gap-2 ml-auto">
                        {ruta.estado_ruta === 'ASIGNADA' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleRouteStep(ruta, 'CHECKIN')}
                            className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-extrabold flex items-center gap-2 shadow-md shadow-red-950/50 cursor-pointer"
                          >
                            {isBusy ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5 fill-white" />
                            )}
                            <span>Iniciar Degustación (Check-in)</span>
                          </button>
                        )}

                        {ruta.estado_ruta === 'EN_CURSO' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleRouteStep(ruta, 'CHECKOUT')}
                            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-extrabold flex items-center gap-2 shadow-md shadow-emerald-950/50 cursor-pointer"
                          >
                            {isBusy ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            )}
                            <span>Finalizar Degustación (Check-out)</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </main>

      {executionTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-3"
          role="dialog"
          aria-modal="true"
          aria-label="Formulario de ejecución en punto de venta"
        >
          <form
            onSubmit={handleSubmitExecution}
            noValidate
            className="w-full max-w-lg rounded-2xl bg-zinc-950 border border-white/15 p-5 space-y-3 max-h-[92vh] overflow-y-auto"
          >
            <h2 className="text-base font-extrabold text-white">
              Ejecución en PDV · {executionTarget.cliente_nombre}
            </h2>
            <p className="text-[11px] text-zinc-400">
              Completa el reporte antes de finalizar. Se registrará tu ubicación GPS y la distancia al PDV.
            </p>

            <label className="block text-xs font-bold text-zinc-200">
              Lote del producto
              <input
                value={execForm.lote}
                maxLength={60}
                onChange={(e) => setExecForm((p) => ({ ...p, lote: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
              />
            </label>
            <label className="block text-xs font-bold text-zinc-200">
              Fecha de vencimiento
              <input
                type="date"
                value={execForm.vencimiento}
                onChange={(e) => setExecForm((p) => ({ ...p, vencimiento: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['abiertas', 'Unid. abiertas'],
                  ['muestras', 'Muestras'],
                  ['ventas', 'Ventas asist.'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="block text-[11px] font-bold text-zinc-200">
                  {label}
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={execForm[key]}
                    onChange={(e) => setExecForm((p) => ({ ...p, [key]: e.target.value }))}
                    className="mt-1 w-full px-2 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
                  />
                </label>
              ))}
            </div>
            <label className="block text-xs font-bold text-zinc-200">
              Observaciones
              <textarea
                rows={2}
                maxLength={500}
                value={execForm.observaciones}
                onChange={(e) => setExecForm((p) => ({ ...p, observaciones: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
              />
            </label>
            <label className="block text-xs font-bold text-zinc-200">
              Justificación si estás fuera de la geocerca (opcional)
              <input
                value={execForm.motivoFuera}
                maxLength={200}
                onChange={(e) => setExecForm((p) => ({ ...p, motivoFuera: e.target.value }))}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-black border border-zinc-700 text-sm text-white"
              />
            </label>

            {execError && (
              <div role="alert" className="rounded-xl bg-red-950/60 border border-red-500/45 px-3 py-2 text-xs text-red-100">
                {execError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setExecutionTarget(null)}
                className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs font-bold text-zinc-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={processingRutaId === executionTarget.id}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-extrabold cursor-pointer"
              >
                {processingRutaId === executionTarget.id ? 'Enviando...' : 'Finalizar y enviar'}
              </button>
            </div>
          </form>
        </div>
      )}

      <IncidenciaQuickModal
        isOpen={incidenciaModalOpen}
        onClose={() => {
          setIncidenciaModalOpen(false);
          setIncidenciaRutaTarget(null);
        }}
        defaultPdvNombre={incidenciaRutaTarget?.cliente_nombre || ''}
        defaultClienteId={
          incidenciaRutaTarget
            ? (matchRutaPdvGeofence(incidenciaRutaTarget, geofenceCatalog)?.id ?? null)
            : null
        }
        defaultRutaId={incidenciaRutaTarget?.id ?? null}
        pdvOptions={routes.map((r) => ({
          id: matchRutaPdvGeofence(r, geofenceCatalog)?.id ?? null,
          nombre: r.cliente_nombre,
        }))}
        sucursal={isOperativeSucursal(profile.sucursal) ? profile.sucursal : null}
        reportadoPorNombre={profile.displayName}
        onSuccess={(res) => {
          showBanner(res.message);
          void refreshPending();
        }}
      />
    </div>
  );
};
