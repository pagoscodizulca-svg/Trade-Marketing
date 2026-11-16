import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  HelpCircle,
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

const SAFE_EMAIL_FOR_SQL_REGEX = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

function isLocalLoopbackHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
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
  const canUseLocalWorkstation = import.meta.env.DEV && isLocalLoopbackHost();
  const initialHasAuthToken = isSupabaseConfigured && hasStoredSupabaseAuthToken();

  const [checking, setChecking] = useState<boolean>(
    () => !canUseLocalWorkstation || initialHasAuthToken
  );
  const [profile, setProfile] = useState<VerifiedAuthProfile | null>(null);
  const [localDevActive, setLocalDevActive] = useState<boolean>(
    () => canUseLocalWorkstation && !initialHasAuthToken
  );

  const [identifier, setIdentifier] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState<boolean>(false);
  const [copiedSql, setCopiedSql] = useState<boolean>(false);

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
        if (canUseLocalWorkstation) {
          setLocalDevActive(true);
        }
        setProfile(null);
        setChecking(false);
        return;
      }

      const resolved = await resolveVerifiedProfileWithStaffFallback(data.session);
      if (!active) return;
      if (resolved?.appRole === 'promotora' || Boolean(resolved?.staffId && !resolved?.isCoordinatorOrAdmin)) {
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
      if (resolved?.appRole === 'promotora' || Boolean(resolved?.staffId && !resolved?.isCoordinatorOrAdmin)) {
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

  const bootstrapSqlSnippet = useMemo(() => {
    const cleanEmail = identifier.trim().toLowerCase();
    const targetEmail = SAFE_EMAIL_FOR_SQL_REGEX.test(cleanEmail)
      ? cleanEmail
      : 'coordinacion@codizulca.com';
    return [
      `UPDATE auth.users`,
      `SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()),`,
      `    raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(`,
      `      'app_role', 'admin',`,
      `      'display_name', 'Coordinación Trade Marketing'`,
      `    )`,
      `WHERE lower(email) = '${targetEmail}';`,
    ].join('\n');
  }, [identifier]);

  const handleCopyBootstrapSql = async () => {
    try {
      await navigator.clipboard.writeText(bootstrapSqlSnippet);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 2500);
    } catch {
      // Sin acceso a portapapeles
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setErrorMsg(null);
    setSubmitting(true);

    try {
      const { profile: authenticated } = await signInWithSupabaseCredentials(identifier, password);
      setPassword('');
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
    if (!import.meta.env.DEV || !isLocalLoopbackHost()) return;
    setErrorMsg(null);
    setLocalDevActive(true);
  };

  const handleSignOut = async () => {
    setLocalDevActive(false);
    await signOutSupabaseSession();
    setProfile(null);
    setPassword('');
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
      displayName: 'Modo Edición Local (Admin)',
      appRole: 'admin',
      rawAppRole: 'admin',
      legacyRole: 'gerente_admin',
      staffId: null,
      isCoordinatorOrAdmin: true,
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

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowSetupGuide((prev) => !prev)}
              className="w-full flex items-center justify-between text-[11px] font-semibold text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                <HelpCircle className="w-3.5 h-3.5 text-red-400" />
                <span>¿Primera vez? Activa tu usuario Coordinación/Admin en Supabase</span>
              </span>
              <span>{showSetupGuide ? 'Ocultar' : 'Ver pasos'}</span>
            </button>

            {showSetupGuide && (
              <div className="rounded-xl bg-black/80 border border-white/10 p-3 space-y-2 text-[11px] text-zinc-300">
                <ol className="list-decimal list-inside space-y-1 text-zinc-400">
                  <li>
                    En Supabase Dashboard abre <strong>Authentication → Users → Add user</strong> y
                    crea tu correo y contraseña (marcando <em>Auto Confirm User</em>).
                  </li>
                  <li>
                    Ejecuta en <strong>SQL Editor</strong> este comando para asignarle el rol
                    firmado en <code className="text-red-300">app_metadata</code>:
                  </li>
                </ol>
                <div className="relative">
                  <pre className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[10px] font-mono text-emerald-300 overflow-x-auto leading-relaxed">
                    {bootstrapSqlSnippet}
                  </pre>
                  <button
                    type="button"
                    onClick={() => void handleCopyBootstrapSql()}
                    className="absolute top-1.5 right-1.5 px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-[10px] font-bold text-zinc-200 inline-flex items-center gap-1 cursor-pointer"
                  >
                    {copiedSql ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span>Copiado</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copiar SQL</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

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

  if (!profile.isCoordinatorOrAdmin) {
    return (
      <div className="min-h-screen bg-[#09090b] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-2xl bg-zinc-950 border border-red-500/30 p-6 space-y-4 text-center">
          <ShieldAlert className="w-11 h-11 text-red-500 mx-auto" />
          <h2 className="text-lg font-extrabold">Acceso Restringido (403)</h2>
          <p className="text-xs text-zinc-400">
            Tu sesión autenticada posee el rol <strong>{profile.appRole || 'sin asignar'}</strong> y
            no tiene permisos para operar la Torre de Control de Coordinación.
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
