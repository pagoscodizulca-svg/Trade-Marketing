import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, LogOut, MapPin, Monitor, ShieldCheck, Sun, Truck } from 'lucide-react';
import {
  persistRutaUiThemeMode,
  readStoredRutaUiThemeMode,
  UI_THEME_STORAGE_KEY,
  type RutaUiThemeMode,
} from './bootTheme';
import { OPERATIVE_SUCURSALES, type AppMode, type OperativeSucursal, type RutaAuthUser } from './types';
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
  getRutaSupabaseClient,
  isRutaSuperAdmin,
  resolveEffectiveMode,
  resolveRutaSupabaseConfig,
  restoreRutaSession,
  signOutRutaUser,
  subscribeRutaAuthEvents,
} from './services/supabaseAuth';
import {
  loadChoferShiftSessionSync,
  purgeChoferOfflineSensitiveData,
  saveChoferShiftSession,
  verifyChoferShiftToken,
  type StoredChoferShiftSession,
} from './services/shiftSessionService';

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
  const [shiftSession, setShiftSession] = useState<StoredChoferShiftSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [modoSolicitado, setModoSolicitado] = useState<AppMode>(modoInicial);
  const [superAdminSucursalFilter, setSuperAdminSucursalFilter] = useState<
    'TODAS' | OperativeSucursal
  >('TODAS');
  const [uiTheme, setUiTheme] = useState<RutaUiThemeMode>(() => readStoredRutaUiThemeMode());
  const { entregas, repo, sync, refresh } = useEntregas();

  const isSuperAdmin = isRutaSuperAdmin(authUser);

  const visibleEntregas = useMemo(() => {
    if (!isSuperAdmin || superAdminSucursalFilter === 'TODAS') return entregas;
    return entregas.filter((e) => !e.sucursal || e.sucursal === superAdminSucursalFilter);
  }, [entregas, isSuperAdmin, superAdminSucursalFilter]);

  const scopedRepo = useMemo(() => {
    if (!isSuperAdmin) return repo;
    const defaultHub: OperativeSucursal =
      superAdminSucursalFilter !== 'TODAS' ? superAdminSucursalFilter : 'ZULIA';
    return {
      ...repo,
      add: (entrega: Parameters<typeof repo.add>[0]) =>
        repo.add({ ...entrega, sucursal: entrega.sucursal ?? defaultHub }),
      importMany: (
        items: Parameters<typeof repo.importMany>[0],
        modoImport: Parameters<typeof repo.importMany>[1]
      ) =>
        repo.importMany(
          items.map((e) => ({ ...e, sucursal: e.sucursal ?? defaultHub })),
          modoImport
        ),
    };
  }, [isSuperAdmin, repo, superAdminSucursalFilter]);

  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === UI_THEME_STORAGE_KEY) {
        setUiTheme(persistRutaUiThemeMode(ev.newValue === 'default' ? 'default' : 'control-room'));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleRutaTheme = useCallback(() => {
    setUiTheme((prev) => persistRutaUiThemeMode(prev === 'control-room' ? 'default' : 'control-room'));
  }, []);
  const headerRef = useRef<HTMLElement>(null);

  const { configError } = useMemo(() => resolveRutaSupabaseConfig(), []);

  // Restaurar enlace dinámico firmado (`?t=...`) O sesión persistente Supabase Auth
  useEffect(() => {
    let active = true;

    const toChoferUserFromShift = (stored: StoredChoferShiftSession): RutaAuthUser => ({
      id: stored.session.personal_id || stored.session.id,
      email: '',
      fullName:
        stored.session.personal_nombre ||
        `Chofer Jornada · ${stored.session.ruta_codigo}`,
      role: 'chofer',
      sucursal: stored.session.sucursal,
    });

    const bootstrapSession = async () => {
      const url = new URL(window.location.href);
      const rawToken = url.searchParams.get('t')?.trim() || '';

      if (rawToken) {
        url.searchParams.delete('t');
        url.searchParams.set('modo', 'chofer');
        window.history.replaceState(null, '', url);

        const verified = await verifyChoferShiftToken(rawToken);
        if (!active) return;

        if (!verified.ok) {
          await purgeChoferOfflineSensitiveData();
          setShiftSession(null);
          setAuthUser(null);
          setAuthError(verified.error);
          setAuthLoading(false);
          return;
        }

        if (verified.session.rol !== 'chofer') {
          await purgeChoferOfflineSensitiveData();
          setShiftSession(null);
          setAuthUser(null);
          setAuthError('Este enlace firmado corresponde al portal de Promotoras (/portal).');
          setAuthLoading(false);
          return;
        }

        const stored: StoredChoferShiftSession = {
          token: rawToken,
          session: verified.session,
          savedAtIso: new Date().toISOString(),
        };
        await saveChoferShiftSession(stored);
        if (!active) return;
        setShiftSession(stored);
        setAuthUser(toChoferUserFromShift(stored));
        setAuthError(null);
        setAuthLoading(false);
        return;
      }

      const cachedShift = loadChoferShiftSessionSync();
      if (cachedShift && cachedShift.session.rol === 'chofer') {
        const expMs = new Date(cachedShift.session.expires_at).getTime();
        if (!Number.isFinite(expMs) || expMs <= Date.now()) {
          await purgeChoferOfflineSensitiveData();
          setShiftSession(null);
          setAuthUser(null);
          setAuthError('Tu enlace de jornada expiró y los datos locales fueron purgados.');
          setAuthLoading(false);
          return;
        }
        await saveChoferShiftSession(cachedShift);
        if (!active) return;
        setShiftSession(cachedShift);
        setAuthUser(toChoferUserFromShift(cachedShift));
        setAuthError(null);
        setAuthLoading(false);
        return;
      }

      const res = await restoreRutaSession();
      if (!active) return;
      if (res.ok) {
        setAuthUser(res.user);
        setAuthError(null);
      } else {
        setAuthUser(null);
        setAuthError(res.code === 'NO_SESSION' ? null : res.error);
      }
      setAuthLoading(false);
    };

    void bootstrapSession();

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

  // Vigilante automático de expiración UTC o revocación de jornada -> purga inmediata de IndexedDB
  useEffect(() => {
    if (!shiftSession) return;
    const expMs = new Date(shiftSession.session.expires_at).getTime();
    const triggerPurge = async (reason: string) => {
      repo.stop();
      await purgeChoferOfflineSensitiveData();
      setShiftSession(null);
      setAuthUser(null);
      setAuthError(reason);
    };

    const check = () => {
      if (!Number.isFinite(expMs) || Date.now() >= expMs) {
        void triggerPurge('Tu enlace de jornada expiró. Los datos locales fueron purgados.');
      }
    };
    check();
    const timer = window.setInterval(check, 15_000);
    return () => window.clearInterval(timer);
  }, [repo, shiftSession]);

  // Si la sincronización de jornada devuelve error de revocación/expiración, purgar automáticamente
  useEffect(() => {
    if (!shiftSession || !sync.errorMessage) return;
    if (/expir[oó]|revocado|401|403|SESSION_REVOKED|SESSION_EXPIRED/i.test(sync.errorMessage)) {
      repo.stop();
      void purgeChoferOfflineSensitiveData().then(() => {
        setShiftSession(null);
        setAuthUser(null);
        setAuthError('Tu enlace de jornada fue revocado o expiró. Los datos locales se purgaron.');
      });
    }
  }, [repo, shiftSession, sync.errorMessage]);

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

  // Suscripción reactiva a cambios en las 5 entidades maestras (BD <-> App Chofer/Oficina)
  useEffect(() => {
    if (!authUser || shiftSession) return;
    const client = getRutaSupabaseClient();
    if (!client) return;

    let timerId: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => {
        void refresh();
      }, 400);
    };

    const channel = client
      .channel(`ruta-maestros-sync-${authUser.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'productos' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promotoras' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'supervisores' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'regiones' }, scheduleRefresh)
      .subscribe();

    return () => {
      if (timerId) clearTimeout(timerId);
      void client.removeChannel(channel);
    };
  }, [authUser, shiftSession, refresh]);

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
    if (shiftSession) {
      await purgeChoferOfflineSensitiveData();
      setShiftSession(null);
      setAuthUser(null);
      setAuthError(null);
      return;
    }
    await signOutRutaUser();
    await purgeChoferOfflineSensitiveData();
    setAuthUser(null);
    setAuthError(null);
  }, [repo, shiftSession]);

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
            <div className="cz-logo-badge w-11 h-11 rounded-xl bg-white p-1 grid place-items-center shrink-0 shadow">
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
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-white bg-zinc-900 border border-white/15 rounded-full px-2.5 py-1"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-red-500 shrink-0" />
                <span className="truncate max-w-[140px]">{authUser.fullName}</span>
                <span className="text-zinc-400">·</span>
                <span className="text-red-400">{formatRutaRoleLabel(authUser.role)}</span>
              </span>
              <span
                data-testid="ruta-sucursal-badge"
                className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-red-600/20 border border-red-500/45 rounded-full px-2.5 py-1"
              >
                <MapPin className="w-3 h-3 text-red-400 shrink-0" />
                {formatSucursalLabel(authUser.sucursal)}
              </span>
              <button
                type="button"
                onClick={toggleRutaTheme}
                aria-pressed={uiTheme === 'control-room'}
                data-testid="ruta-theme-toggle"
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-200 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-white/15 rounded-full px-2.5 py-1 transition-colors"
                title={
                  uiTheme === 'control-room'
                    ? 'Modo Sala de Control activo — cambiar a Día Ejecutivo'
                    : 'Activar Modo Oscuro Nocturno (Sala de Control)'
                }
              >
                {uiTheme === 'control-room' ? (
                  <Monitor className="w-3.5 h-3.5 text-red-400" />
                ) : (
                  <Sun className="w-3.5 h-3.5 text-red-400" />
                )}
                <span className="hidden sm:inline">
                  {uiTheme === 'control-room' ? 'Sala de Control' : 'Día Ejecutivo'}
                </span>
              </button>
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

      <main className="flex-1 w-full max-w-7xl mx-auto px-3 sm:px-6 py-4 space-y-3">
        {isSuperAdmin && (
          <section
            data-testid="ruta-super-admin-bar"
            aria-label="Modo Supervisión Global Super Admin"
            className="rounded-xl bg-zinc-950 border border-red-500/40 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5 text-white"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand text-white text-[10px] font-mono font-black uppercase">
                <ShieldCheck className="w-3 h-3" />
                Supervisión Global · Super Admin
              </span>
              <span className="text-zinc-300">
                Acceso total a Chofer y Oficina en todas las sedes ({visibleEntregas.length} entregas)
              </span>
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-bold text-zinc-200">
              <span>Sede:</span>
              <select
                data-testid="ruta-supervision-sucursal-select"
                value={superAdminSucursalFilter}
                onChange={(e) =>
                  setSuperAdminSucursalFilter(e.target.value as 'TODAS' | OperativeSucursal)
                }
                className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-white/15 text-xs text-white font-semibold focus:outline-none focus:border-brand cursor-pointer"
              >
                <option value="TODAS">Todas las Sedes (Nacional)</option>
                {OPERATIVE_SUCURSALES.map((hub) => (
                  <option key={hub} value={hub}>
                    {formatSucursalLabel(hub)}
                  </option>
                ))}
              </select>
            </label>
          </section>
        )}

        <div key={modo} className="cz-tab-panel-enter">
          {modo === 'oficina' && puedeOficina ? (
            <OficinaView entregas={visibleEntregas} repo={scopedRepo} sync={sync} />
          ) : (
            <ChoferView entregas={visibleEntregas} repo={scopedRepo} sync={sync} />
          )}
        </div>
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
