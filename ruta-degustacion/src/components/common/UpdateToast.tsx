import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { EVENTO_ACTUALIZACION_SW, aplicarActualizacion } from '../../lib/registerSw';

/** Aviso discreto cuando hay una versión nueva de la app lista para instalar. */
export function UpdateToast() {
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    const onUpdate = (ev: Event) => setReg((ev as CustomEvent<ServiceWorkerRegistration>).detail);
    window.addEventListener(EVENTO_ACTUALIZACION_SW, onUpdate);
    return () => window.removeEventListener(EVENTO_ACTUALIZACION_SW, onUpdate);
  }, []);

  if (!reg) return null;
  return (
    <div
      role="status"
      data-testid="update-toast"
      className="fixed bottom-3 inset-x-3 z-50 mx-auto max-w-md rounded-xl bg-ink text-white border-2 border-brand px-3 py-2.5 flex items-center gap-3 shadow-xl"
    >
      <span className="flex-1 text-sm font-bold">Nueva versión disponible</span>
      <button
        type="button"
        onClick={() => aplicarActualizacion(reg)}
        className="min-h-10 px-3 rounded-lg bg-brand text-white text-xs font-black inline-flex items-center gap-1.5"
      >
        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
        Actualizar
      </button>
      <button type="button" onClick={() => setReg(null)} className="min-h-10 px-2 text-xs font-bold text-zinc-300">
        Luego
      </button>
    </div>
  );
}
