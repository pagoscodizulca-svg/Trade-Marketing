import { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, Truck } from 'lucide-react';
import type { AppMode } from './types';
import { ChoferView } from './components/chofer/ChoferView';
import { OficinaView } from './components/oficina/OficinaView';
import { useEntregas } from './hooks/useEntregas';
import { SyncStatusBadge } from './components/common/SyncStatusBadge';
import { UpdateToast } from './components/common/UpdateToast';

const MODE_KEY = 'rutadegustacion:v1:modo';

/** El modo vive por pestaña (URL ?modo= o sessionStorage) para poder abrir ambas vistas a la vez. */
function modoInicial(): AppMode {
  const param = new URLSearchParams(window.location.search).get('modo');
  if (param === 'chofer' || param === 'oficina') return param;
  const guardado = sessionStorage.getItem(MODE_KEY);
  return guardado === 'oficina' ? 'oficina' : 'chofer';
}

export default function App() {
  const [modo, setModoState] = useState<AppMode>(modoInicial);
  const { entregas, repo, sync, refresh } = useEntregas();
  const headerRef = useRef<HTMLElement>(null);

  // Publica la altura de la cabecera fija (--hdr-h) para que el banner de conectividad quede pegado debajo de ella.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publicar = () => document.documentElement.style.setProperty('--hdr-h', `${el.offsetHeight}px`);
    publicar();
    const ro = new ResizeObserver(publicar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const setModo = useCallback((m: AppMode) => {
    setModoState(m);
    sessionStorage.setItem(MODE_KEY, m);
    const url = new URL(window.location.href);
    url.searchParams.set('modo', m);
    window.history.replaceState(null, '', url);
  }, []);

  const tabs: { id: AppMode; label: string; icon: React.ReactNode }[] = [
    { id: 'chofer', label: 'Modo Chofer (Móvil)', icon: <Truck className="w-5 h-5" /> },
    { id: 'oficina', label: 'Modo Trade Marketing (Oficina)', icon: <Building2 className="w-5 h-5" /> },
  ];

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
            {/* En modo Chofer el estado de conectividad lo muestra el banner de la vista (SyncStatusBanner). */}
            {modo === 'oficina' && (
              <div className="w-full sm:w-auto order-last sm:order-none shrink-0 sm:max-w-[60%]">
                <SyncStatusBadge sync={sync} onRefresh={refresh} />
              </div>
            )}
          </div>
          <div role="tablist" aria-label="Modo de la aplicación" className="grid grid-cols-2 gap-1.5 bg-zinc-900 border border-white/10 p-1 rounded-xl">
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
        {modo === 'chofer' ? (
          <ChoferView entregas={entregas} repo={repo} sync={sync} />
        ) : (
          <OficinaView entregas={entregas} repo={repo} sync={sync} />
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
