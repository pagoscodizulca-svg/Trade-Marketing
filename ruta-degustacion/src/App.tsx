import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, LogOut, MapPin, ShieldCheck, Truck } from 'lucide-react';
import type { AppMode, RutaAuthUser } from './types';
import { ChoferView } from './components/chofer/ChoferView';
import { OficinaView } from './components/oficina/OficinaView';
import { RutaAuthGate } from './components/auth/RutaAuthGate';
import { useEntregas } from './hooks/useEntregas';
import { SyncStatusBadge } from './components/common/SyncStatusBadge';
import { UpdateToast } from './components/common/UpdateToast';
import {
  canAccessOficinaMode,
  formatRutaRoleLabel,
  formatSucursalLabel,
  resolveEffectiveMode,
  resolveRutaSupabaseConfig,
  restoreRutaSession,
  signOutRutaUser,
  subscribeRutaAuthEvents,
} from './services/supabaseAuth';

const MODE_KEY = 'rutadegustacion:v1:modo';

/** El modo vive por pestaña (URL ?modo= o sessionStorage) y siempre respeta el rol del usuario. */
function modoInicial(): AppMode {
  const param = new URLSearchParams(window.location.search).get('modo');
  if (param === 'chofer' || param === 'oficina') return param;
  const guardado = sessionStorage.getItem(MODE_KEY);
  return guardado === 'oficina' ? 'oficina' : 'chofer';
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<RutaAuthUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [modoSolicitado, setModoSolicitado] = useState<AppMode>(modoInicial);
  const { entregas, repo, sync, refresh } = useEntregas();
  const headerRef = useRef<HTMLElement>(null);

  const { configError } = useMemo(() => resolveRutaSupabaseConfig(), []);

  // Restaurar sesión persistente y validar perfil activo en `public.profiles`
  useEffect(() => {
    let active = true;
    void restoreRutaSession().then((res) => {
      if (!active) return;
      if (res.ok) {
        setAuthUser(res.user);
        setAuthError(null);
      } else {
        setAuthUser(null);
        setAuthError(res.code === 'NO_SESSION' ? null : res.error);
      }
      setAuthLoading(false);
    });

    const unsubscribe = subscribeRutaAuthEvents({
      onSignedOut: () => {
        if (!active) return;
        setAuthUser(null);
      },
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Arrancar sincronización de entregas EXCLUSIVAMENTE con usuario autenticado y autorizado
  useEffect(() => {
    if (!authUser) {
      repo.stop();
      return;
    }
    repo.start();
    return () => {
      repo.stop();
    };
  }, [authUser, repo]);

  const modo: AppMode = authUser ? resolveEffectiveMode(modoSolicitado, authUser.role) : 'chofer';
  const puedeOficina = authUser ? canAccessOficinaMode(authUser.role) : false;

  // Si un chofer abrió con ?modo=oficina, normalizar la URL a ?modo=chofer inmediatamente
  useEffect(() => {
    if (!authUser) return;
    if (modoSolicitado !== modo) {
      setModoSolicitado(modo);
      sessionStorage.setItem(MODE_KEY, modo);
      const url = new URL(window.location.href);
      url.searchParams.set('modo', modo);
      window.history.replaceState(null, '', url);
    }
  }, [authUser, modo, modoSolicitado]);

  // Publica la altura de la cabecera fija (--hdr-h) para que el banner de conectividad quede pegado debajo de ella.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publicar = () => document.documentElement.style.setProperty('--hdr-h', `${el.offsetHeight}px`);
    publicar();
    const ro = new ResizeObserver(publicar);
    ro.observe(el);
    return () => ro.disconnect();
  }, [authUser]);

  const setModo = useCallback(
    (m: AppMode) => {
      const seguro = authUser ? resolveEffectiveMode(m, authUser.role) : 'chofer';
      setModoSolicitado(seguro);
      sessionStorage.setItem(MODE_KEY, seguro);
      const url = new URL(window.location.href);
      url.searchParams.set('modo', seguro);
      window.history.replaceState(null, '', url);
    },
    [authUser],
  );

  const handleSignOut = useCallback(async () => {
    repo.stop();
    await signOutRutaUser();
    setAuthUser(null);
    setAuthError(null);
  }, [repo]);

  if (authLoading || !authUser) {
    return (
      <RutaAuthGate
        loading={authLoading}
        configError={configError}
        authError={authError}
        onAuthenticated={(user) => {
          setAuthUser(user);
          setAuthError(null);
        }}
      />
    );
  }

  const tabs: { id: AppMode; label: string; icon: React.ReactNode }[] = puedeOficina
    ? [
        { id: 'chofer', label: 'Modo Chofer (Móvil)', icon: <Truck className="w-5 h-5" /> },
        { id: 'oficina', label: 'Modo Trade Marketing (Oficina)', icon: <Building2 className="w-5 h-5" /> },
      ]
    : [{ id: 'chofer', label: 'Modo Chofer (Móvil)', icon: <Truck className="w-5 h-5" /> }];

  return (
    <div className="min-h-screen flex flex-col">
      <header ref={headerRef} className="bg-ink text-white sticky top-0 z-40 shadow-lg border-b-4 border-brand">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 pt-3 pb-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-2.5">
            <div className="w-11 h-11 rounded-xl bg-white p-1 grid place-items-center shrink-0 shadow">
              <img src="/codizulca-logo.png" alt="Logo CODIZULCA C.A." className="w-full h-full object-contain" />
            </div>
            <div className="min-w-0 flex-1 basis-40">
              <h1 className="text-base sm:text-lg font-extrabold leading-tight truncate tracking-tight">
                Ruta<span className="text-red-500">Degustación</span>
              </h1>
              <p className="text-[11px] sm:text-xs text-zinc-300 leading-tight truncate">
                CODIZULCA C.A. · Control de Entregas Trade Marketing
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <span
                data-testid="ruta-user-badge"
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-100 bg-zinc-900 border border-white/15 rounded-full px-2.5 py-1"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="truncate max-w-[140px]">{authUser.fullName}</span>
                <span className="text-zinc-400">·</span>
                <span className="text-red-300">{formatRutaRoleLabel(authUser.role)}</span>
              </span>
              <span
                data-testid="ruta-sucursal-badge"
                className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-200 bg-amber-950/60 border border-amber-400/30 rounded-full px-2.5 py-1"
              >
                <MapPin className="w-3 h-3 shrink-0" />
                {formatSucursalLabel(authUser.sucursal)}
              </span>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                data-testid="ruta-signout"
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-200 hover:text-white bg-zinc-800 hover:bg-zinc-700 border border-white/15 rounded-full px-2.5 py-1 transition-colors"
                title="Cerrar sesión"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Salir</span>
              </button>
            </div>

            {/* En modo Chofer el estado de conectividad lo muestra el banner de la vista (SyncStatusBanner). */}
            {modo === 'oficina' && puedeOficina && (
              <div className="w-full sm:w-auto order-last sm:order-none shrink-0 sm:max-w-[60%]">
                <SyncStatusBadge sync={sync} onRefresh={refresh} />
              </div>
            )}
          </div>

          <div
            role="tablist"
            aria-label="Modo de la aplicación"
            className={`grid gap-1.5 bg-zinc-900 border border-white/10 p-1 rounded-xl ${
              tabs.length === 2 ? 'grid-cols-2' : 'grid-cols-1'
            }`}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={modo === t.id}
                data-testid={`modo-${t.id}`}
                onClick={() => setModo(t.id)}
                className={`flex items-center justify-center gap-2 min-h-12 px-2 rounded-lg text-xs sm:text-sm font-bold text-center leading-tight transition-colors ${
                  modo === t.id ? 'bg-brand text-white shadow' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto px-3 sm:px-6 py-4">
        {modo === 'oficina' && puedeOficina ? (
          <OficinaView entregas={entregas} repo={repo} sync={sync} />
        ) : (
          <ChoferView entregas={entregas} repo={repo} sync={sync} />
        )}
      </main>

      <footer className="bg-ink text-zinc-400 text-[11px] border-t-2 border-brand">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-2">
          <span className="font-extrabold text-white uppercase tracking-wider">CODIZULCA C.A.</span>
          <span>RutaDegustación · Control de Entregas Trade Marketing</span>
        </div>
      </footer>
      <UpdateToast />
    </div>
  );
}
