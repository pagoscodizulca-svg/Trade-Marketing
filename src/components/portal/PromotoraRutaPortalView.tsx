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
import { registerPromotoraRouteStep } from '../../services/promotoraRutaPortalService';
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

  const handleRouteStep = async (item: RutaPromotoraRecord, accion: 'CHECKIN' | 'CHECKOUT') => {
    if (!item.id || inFlightStepIdsRef.current.has(item.id)) return;
    inFlightStepIdsRef.current.add(item.id);
    setProcessingRutaId(item.id);
    setActionError(null);

    try {
      const updated = await registerPromotoraRouteStep(item.id, accion);
      applyOptimisticRouteUpdate(updated);
      showBanner(
        accion === 'CHECKIN'
          ? `Check-in registrado en ${item.cliente_nombre}.`
          : `Degustación marcada como completada en ${item.cliente_nombre}.`
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'No se pudo actualizar el estado de la ruta.'
      );
    } finally {
      inFlightStepIdsRef.current.delete(item.id);
      setProcessingRutaId((prev) => (prev === item.id ? null : prev));
    }
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

          <span className="text-xs font-mono text-zinc-400">
            {filteredRoutes.length}{' '}
            {filteredRoutes.length === 1 ? 'degustación autorizada' : 'degustaciones autorizadas'}
          </span>
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

                  {ruta.observaciones && (
                    <p className="mt-2.5 text-xs text-zinc-400 bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2">
                      {ruta.observaciones}
                    </p>
                  )}

                  {/* Controles operativos exclusivos para la promotora propietaria */}
                  {ruta.estado_ruta !== 'COMPLETADA' && (
                    <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-end gap-2">
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
                  )}
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};
