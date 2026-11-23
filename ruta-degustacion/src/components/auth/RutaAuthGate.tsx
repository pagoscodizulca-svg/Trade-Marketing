import { useState, type FormEvent } from 'react';
import { AlertTriangle, Lock, LogIn, ShieldCheck, Truck } from 'lucide-react';
import type { RutaAuthUser } from '../../types';
import { signInRutaUser } from '../../services/supabaseAuth';

interface RutaAuthGateProps {
  loading: boolean;
  configError: string | null;
  authError: string | null;
  onAuthenticated: (user: RutaAuthUser) => void;
}

export function RutaAuthGate({
  loading,
  configError,
  authError,
  onAuthenticated,
}: RutaAuthGateProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const visibleError = formError || authError || configError;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting || configError) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await signInRutaUser(email, password);
      if (res.ok) {
        setPassword('');
        onAuthenticated(res.user);
      } else {
        setFormError(res.error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col justify-between">
      <div className="h-1.5 bg-brand w-full" />

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
          <div className="bg-ink px-6 py-5 border-b border-white/10 flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-white p-1.5 grid place-items-center shrink-0 shadow">
              <img
                src={`${import.meta.env.BASE_URL}codizulca-logo.png`}
                alt="Logo CODIZULCA C.A."
                className="w-full h-full object-contain"
              />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-extrabold tracking-tight leading-tight">
                Ruta<span className="text-red-500">Degustación</span>
              </h1>
              <p className="text-xs text-zinc-300 leading-tight mt-0.5">
                CODIZULCA C.A. · Acceso Logístico Autenticado
              </p>
            </div>
          </div>

          <div className="p-6">
            {loading ? (
              <div className="py-10 flex flex-col items-center gap-3 text-center">
                <div className="w-9 h-9 rounded-full border-2 border-brand border-t-transparent animate-spin" />
                <p className="text-sm font-semibold text-zinc-200">
                  Verificando sesión corporativa y sucursal…
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-start gap-2.5 bg-zinc-800/70 border border-white/10 rounded-xl p-3 mb-5 text-xs text-zinc-300">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <p>
                    Acceso exclusivo para <strong>Chofer</strong> (Modo Móvil) y{' '}
                    <strong>Coordinación Trade / Super Admin</strong> (Oficina y Supervisión),
                    con aislamiento estricto por sucursal (Zulia, Valencia, Centro, Oriente y Capital).
                  </p>
                </div>

                {visibleError && (
                  <div
                    role="alert"
                    data-testid="ruta-auth-error"
                    className="mb-4 flex items-start gap-2.5 bg-red-950/70 border border-red-500/40 text-red-200 rounded-xl p-3 text-xs font-medium"
                  >
                    <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <span>{visibleError}</span>
                  </div>
                )}

                <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
                  <div>
                    <label
                      htmlFor="ruta-email"
                      className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1.5"
                    >
                      Correo corporativo
                    </label>
                    <input
                      id="ruta-email"
                      type="email"
                      autoComplete="email"
                      required
                      disabled={Boolean(configError) || submitting}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="usuario@codizulca.com"
                      className="w-full rounded-xl bg-zinc-950 border border-white/15 px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-50"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="ruta-password"
                      className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1.5"
                    >
                      Contraseña
                    </label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="ruta-password"
                        type="password"
                        autoComplete="current-password"
                        required
                        disabled={Boolean(configError) || submitting}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full rounded-xl bg-zinc-950 border border-white/15 pl-10 pr-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-50"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={Boolean(configError) || submitting}
                    data-testid="ruta-login-submit"
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-brand hover:bg-brand-dark text-white font-bold text-sm py-3 px-4 transition-colors disabled:opacity-50"
                  >
                    {submitting ? (
                      <>
                        <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                        <span>Validando acceso…</span>
                      </>
                    ) : (
                      <>
                        <LogIn className="w-4 h-4" />
                        <span>Iniciar sesión</span>
                      </>
                    )}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </main>

      <footer className="py-3 px-4 text-center text-[11px] text-zinc-500 flex items-center justify-center gap-2">
        <Truck className="w-3.5 h-3.5 text-brand" />
        <span>CODIZULCA C.A. · RutaDegustación · Sesión Persistente Zero-Trust</span>
      </footer>
    </div>
  );
}
