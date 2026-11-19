import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  LogOut,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import {
  hasStoredSupabaseAuthToken,
  resolveVerifiedProfileWithStaffFallback,
  signInWithSupabaseCredentials,
  signOutSupabaseSession,
  type VerifiedAuthProfile,
} from '../../services/authService';
import {
  MIN_SUPABASE_PASSWORD_LENGTH,
  completeOwnPasswordChange,
} from '../../services/userManagementService';
import {
  getSupabaseClient,
  isSupabaseConfigured,
  SUPABASE_NOT_CONFIGURED_MESSAGE,
} from '../../services/supabaseClient';

interface TradeAuthGateProps {
  children: (ctx: {
    profile: VerifiedAuthProfile;
    isLocalDevWorkstation: boolean;
    onSignOut: () => Promise<void>;
  }) => React.ReactNode;
}

function isLocalLoopbackHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function isClienteProfile(p: VerifiedAuthProfile | null | undefined): boolean {
  return Boolean(p && (p.iamRole === 'cliente' || p.appRole === 'cliente'));
}

function isOnClienteRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '').toLowerCase();
  return path === '/cliente' || path.startsWith('/cliente/');
}

/**
 * Guardia de Acceso Zero Trust para la Torre de Control de Trade Marketing (`/`):
 * - En producción (`import.meta.env.PROD` / Render): exige obligatoriamente sesión Supabase Auth
 *   verificada con rol `coordinadora` o `admin` en `app_metadata`.
 * - En desarrollo local (`import.meta.env.DEV` sobre loopback): permite abrir la estación local
 *   mientras se ejecuta la migración SQL y el alta inicial en `auth.users` (eliminado del bundle
 *   de producción por dead-code elimination de Vite).
 * - Si detecta un perfil `promotora`, redirige de inmediato a `/portal/ruta` sin montar módulos administrativos.
 */
export const TradeAuthGate: React.FC<TradeAuthGateProps> = ({ children }) => {
  const canUseLocalWorkstation =
    import.meta.env.DEV &&
    isLocalLoopbackHost() &&
    import.meta.env.VITE_ENABLE_LOCAL_DEV_BYPASS === 'true';
  const initialHasAuthToken = isSupabaseConfigured && hasStoredSupabaseAuthToken();

  const [checking, setChecking] = useState<boolean>(() => isSupabaseConfigured || initialHasAuthToken);
  const [profile, setProfile] = useState<VerifiedAuthProfile | null>(null);
  const [localDevActive, setLocalDevActive] = useState<boolean>(false);

  const [identifier, setIdentifier] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Estado para cambio obligatorio de contraseña en primer inicio (`must_change_password = true`)
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmNewPassword, setConfirmNewPassword] = useState<string>('');
  const [showNewPassword, setShowNewPassword] = useState<boolean>(false);
  const [changingPassword, setChangingPassword] = useState<boolean>(false);
  const [passwordChangeError, setPasswordChangeError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setChecking(false);
      return;
    }

    let active = true;
    const client = getSupabaseClient();

    void client.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      if (!data.session) {
        setProfile(null);
        setChecking(false);
        return;
      }

      const resolved = await resolveVerifiedProfileWithStaffFallback(data.session);
      if (!active) return;
      if (isClienteProfile(resolved) && !isOnClienteRoute()) {
        window.location.replace('/cliente');
        return;
      }
      if (
        resolved?.appRole === 'promotora' ||
        Boolean(resolved?.staffId && !resolved?.canAccessTorreControl)
      ) {
        window.location.replace('/portal');
        return;
      }
      setLocalDevActive(false);
      setProfile(resolved);
      setChecking(false);
    });

    const { data: sub } = client.auth.onAuthStateChange(async (_event, session) => {
      if (!active) return;
      if (!session) {
        setProfile(null);
        setChecking(false);
        return;
      }

      const resolved = await resolveVerifiedProfileWithStaffFallback(session);
      if (!active) return;
      if (isClienteProfile(resolved) && !isOnClienteRoute()) {
        window.location.replace('/cliente');
        return;
      }
      if (
        resolved?.appRole === 'promotora' ||
        Boolean(resolved?.staffId && !resolved?.canAccessTorreControl)
      ) {
        window.location.replace('/portal');
        return;
      }
      setLocalDevActive(false);
      setProfile(resolved);
      setChecking(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [canUseLocalWorkstation]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setErrorMsg(null);

    const normalizedIdentifier = identifier.trim().toLowerCase();
    setIdentifier(normalizedIdentifier);
    setSubmitting(true);

    try {
      const { profile: authenticated } = await signInWithSupabaseCredentials(
        normalizedIdentifier,
        password
      );
      setPassword('');
      if (isClienteProfile(authenticated) && !isOnClienteRoute()) {
        window.location.replace('/cliente');
        return;
      }
      if (authenticated.appRole === 'promotora') {
        window.location.replace('/portal');
        return;
      }
      setLocalDevActive(false);
      setProfile(authenticated);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'No se pudo autenticar la sesión.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnterLocalWorkstation = () => {
    if (!canUseLocalWorkstation) return;
    setErrorMsg(null);
    setLocalDevActive(true);
  };

  const handleSignOut = async () => {
    setLocalDevActive(false);
    setNewPassword('');
    setConfirmNewPassword('');
    setPasswordChangeError(null);
    await signOutSupabaseSession();
    setProfile(null);
    setPassword('');
  };

  const handleCompleteMandatoryPasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (changingPassword || !profile) return;
    setPasswordChangeError(null);

    if (newPassword.trim().length === 0 || newPassword.length < MIN_SUPABASE_PASSWORD_LENGTH) {
      setPasswordChangeError(
        `La nueva contraseña debe tener al menos ${MIN_SUPABASE_PASSWORD_LENGTH} caracteres.`
      );
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setPasswordChangeError('Las contraseñas no coinciden. Verifícalas e intenta nuevamente.');
      return;
    }

    setChangingPassword(true);
    try {
      await completeOwnPasswordChange(newPassword);
      setNewPassword('');
      setConfirmNewPassword('');
      setShowNewPassword(false);
      setProfile((prev) => (prev ? { ...prev, mustChangePassword: false } : null));
    } catch (err) {
      setPasswordChangeError(
        err instanceof Error
          ? err.message
          : 'No se pudo actualizar la contraseña corporativa.'
      );
    } finally {
      setChangingPassword(false);
    }
  };

  if (!isSupabaseConfigured && !(import.meta.env.DEV && localDevActive && canUseLocalWorkstation)) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-red-500/30 p-6 text-center space-y-3">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto" />
          <h1 className="text-lg font-extrabold">Configuración de Supabase requerida</h1>
          <p className="text-xs text-zinc-400">{SUPABASE_NOT_CONFIGURED_MESSAGE}</p>
        </div>
      </div>
    );
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="flex items-center gap-3 text-sm font-mono text-zinc-300">
          <Loader2 className="w-5 h-5 text-red-500 animate-spin" />
          <span>Validando sesión corporativa CODIZULCA...</span>
        </div>
      </div>
    );
  }

  if (import.meta.env.DEV && localDevActive && !profile && canUseLocalWorkstation) {
    const devProfile: VerifiedAuthProfile = {
      userId: 'local-dev-workstation',
      email: 'estacion.local@codizulca.local',
      displayName: 'Modo Edición Local (Super Admin)',
      appRole: 'admin',
      iamRole: 'super_admin',
      sucursal: 'GLOBAL',
      rawAppRole: 'super_admin',
      legacyRole: 'gerente_admin',
      staffId: null,
      isCoordinatorOrAdmin: true,
      canAccessTorreControl: true,
      mustChangePassword: false,
    };

    return (
      <>
        {children({
          profile: devProfile,
          isLocalDevWorkstation: true,
          onSignOut: handleSignOut,
        })}
      </>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-white/10 shadow-2xl p-6 sm:p-8 space-y-5">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-white p-1.5 flex items-center justify-center shrink-0 shadow-md">
              <img
                src="/codizulca-logo.png"
                alt="CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-red-600/15 text-red-400 border border-red-500/30">
                <Lock className="w-3 h-3" /> Acceso Coordinación & Admin
              </span>
              <h1 className="text-lg font-extrabold tracking-tight mt-1">
                CODIZULCA · Trade Marketing
              </h1>
              <p className="text-xs text-zinc-400">
                Torre de Control de Degustaciones, Cronograma y Contraloría
              </p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                Correo Corporativo
              </label>
              <input
                type="email"
                autoComplete="username"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                onBlur={() => setIdentifier((prev) => prev.trim().toLowerCase())}
                placeholder="coordinacion@codizulca.com"
                className="w-full px-3.5 py-2.5 rounded-xl bg-black border border-zinc-800 text-sm text-white focus:outline-none focus:border-red-500"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">Contraseña</label>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl bg-black border border-zinc-800 text-sm text-white focus:outline-none focus:border-red-500"
              />
            </div>

            {errorMsg && (
              <div className="rounded-xl bg-red-950/50 border border-red-500/40 px-3.5 py-2.5 text-xs text-red-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-extrabold text-sm flex items-center justify-center gap-2 transition cursor-pointer shadow-lg shadow-red-950/50"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verificando credenciales...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Ingresar a Torre de Control</span>
                </>
              )}
            </button>
          </form>

          {import.meta.env.DEV && canUseLocalWorkstation && (
            <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3.5 space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] text-amber-200/90 leading-relaxed">
                  <strong className="text-amber-300">Estación Local detectada:</strong> entra de
                  inmediato en modo desarrollo mientras habilitas tu cuenta en Supabase Auth.
                </p>
              </div>
              <button
                type="button"
                onClick={handleEnterLocalWorkstation}
                className="w-full py-2 px-3 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Laptop className="w-3.5 h-3.5" />
                <span>Entrar a Estación Local (Modo Desarrollo)</span>
              </button>
            </div>
          )}

          <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs">
            <span className="text-zinc-400">¿Personal de campo / promotora?</span>
            <a
              href="/portal"
              className="inline-flex items-center gap-1 font-bold text-red-400 hover:text-red-300"
            >
              <span>Ir a /portal</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (!profile.canAccessTorreControl && !(isClienteProfile(profile) && isOnClienteRoute())) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-red-500/30 p-6 space-y-4 text-center">
          <ShieldAlert className="w-11 h-11 text-red-500 mx-auto" />
          <h2 className="text-lg font-extrabold">Acceso Restringido (403)</h2>
          <p className="text-xs text-zinc-400">
            Tu sesión autenticada posee el rol{' '}
            <strong>{profile.iamRole || profile.appRole || 'sin asignar'}</strong> y no tiene
            permisos para operar la Torre de Control corporativa.
          </p>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="w-full py-2.5 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-bold text-white flex items-center justify-center gap-2 cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Cerrar sesión</span>
          </button>
        </div>
      </div>
    );
  }

  if (profile.mustChangePassword) {
    return (
      <div
        className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4"
        data-testid="mandatory-password-change-gate"
      >
        <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-white/10 shadow-2xl p-6 sm:p-8 space-y-5">
          <div className="flex items-start gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <span className="inline-block text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                Seguridad Corporativa · Primer Acceso
              </span>
              <h2 className="text-lg font-extrabold tracking-tight mt-1">
                Actualiza tu contraseña
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
                Hola <strong className="text-white">{profile.displayName}</strong>, por política de
                seguridad debes definir una contraseña personal antes de ingresar.
              </p>
            </div>
          </div>

          <form onSubmit={handleCompleteMandatoryPasswordChange} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                Nueva contraseña (mínimo {MIN_SUPABASE_PASSWORD_LENGTH} caracteres)
              </label>
              <div className="relative">
                <input
                  type={showNewPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={MIN_SUPABASE_PASSWORD_LENGTH}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-3.5 pr-10 py-2.5 rounded-xl bg-black border border-zinc-800 text-sm text-white focus:outline-none focus:border-red-500"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white cursor-pointer"
                  aria-label={showNewPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showNewPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-zinc-300 mb-1.5">
                Confirmar nueva contraseña
              </label>
              <input
                type={showNewPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={MIN_SUPABASE_PASSWORD_LENGTH}
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 rounded-xl bg-black border border-zinc-800 text-sm text-white focus:outline-none focus:border-red-500"
              />
            </div>

            {passwordChangeError && (
              <div className="rounded-xl bg-red-950/50 border border-red-500/40 px-3.5 py-2.5 text-xs text-red-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <span>{passwordChangeError}</span>
              </div>
            )}

            <div className="space-y-2.5 pt-1">
              <button
                type="submit"
                disabled={changingPassword}
                className="w-full py-2.5 px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-extrabold text-sm flex items-center justify-center gap-2 transition cursor-pointer shadow-lg shadow-red-950/50"
              >
                {changingPassword ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Actualizando credencial...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Guardar contraseña y continuar</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={changingPassword}
                onClick={() => void handleSignOut()}
                className="w-full py-2 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-semibold text-zinc-300 flex items-center justify-center gap-2 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Cerrar sesión</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <>
      {children({
        profile,
        isLocalDevWorkstation: false,
        onSignOut: handleSignOut,
      })}
    </>
  );
};
