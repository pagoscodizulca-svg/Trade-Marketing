import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  APP_UPDATE_DEFERRED_EVENT,
  DEFAULT_TRADE_CACHE_PREFIXES,
  performCleanVersionReload,
  type AppUpdateDeferredDetail,
} from '../../lib/appVersionGuard';

/**
 * Aviso no intrusivo que aparece únicamente cuando una nueva versión se detectó
 * mientras el usuario estaba escribiendo en un formulario (para no perder sus datos).
 * Permite actualizar al instante con un clic o se aplica sola al salir del campo.
 */
export const AppUpdateBanner: React.FC = () => {
  const [pendingUpdate, setPendingUpdate] = useState<AppUpdateDeferredDetail | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    const onDeferredUpdate = (event: Event) => {
      const detail = (event as CustomEvent<AppUpdateDeferredDetail>).detail;
      if (detail?.buildId) {
        setPendingUpdate(detail);
      }
    };
    window.addEventListener(APP_UPDATE_DEFERRED_EVENT, onDeferredUpdate);
    return () => window.removeEventListener(APP_UPDATE_DEFERRED_EVENT, onDeferredUpdate);
  }, []);

  if (!pendingUpdate) return null;

  const handleApplyNow = () => {
    setUpdating(true);
    void performCleanVersionReload({
      reason: 'manual',
      targetSignature: pendingUpdate.buildId,
      cachePrefixes: DEFAULT_TRADE_CACHE_PREFIXES,
      swScope: '/',
    });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="app-update-banner"
      className="fixed bottom-4 right-4 z-[9999] max-w-sm rounded-2xl bg-zinc-950/95 border border-red-500/40 text-white px-4 py-3 shadow-2xl backdrop-blur flex items-center gap-3"
    >
      <div className="flex-1 min-w-0">
        <p className="text-xs font-extrabold tracking-tight text-white">
          Nueva versión disponible
        </p>
        <p className="text-[11px] text-zinc-400">
          Se aplicará automáticamente sin cerrar tu sesión.
        </p>
      </div>
      <button
        type="button"
        onClick={handleApplyNow}
        disabled={updating}
        className="shrink-0 px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-60 text-xs font-extrabold text-white inline-flex items-center gap-1.5 cursor-pointer"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${updating ? 'animate-spin' : ''}`} aria-hidden="true" />
        {updating ? 'Actualizando...' : 'Actualizar'}
      </button>
    </div>
  );
};
