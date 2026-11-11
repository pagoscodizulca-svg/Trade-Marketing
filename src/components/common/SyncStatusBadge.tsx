import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Wifi } from 'lucide-react';
import { useApp } from '../../context/AppContext';

/**
 * Indicador de sincronización con el servidor + botón de sincronización manual.
 *  - Sincronizando…
 *  - Sincronizado en tiempo real (canal realtime activo)
 *  - Sincronizado (carga correcta, canal realtime aún no conectado)
 *  - Error de conexión con el servidor
 */
export const SyncStatusBadge: React.FC = () => {
  const { syncStatus, refreshAll } = useApp();
  const { state, errorMessage, lastSyncAt } = syncStatus;

  const lastLabel = lastSyncAt
    ? new Date(lastSyncAt).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  const view = {
    sincronizando: {
      label: 'Sincronizando…',
      classes: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    },
    tiempo_real: {
      label: 'Sincronizado en tiempo real',
      classes: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
      icon: <Wifi className="w-3.5 h-3.5" />,
    },
    sincronizado: {
      label: 'Sincronizado',
      classes: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    },
    error: {
      label: 'Error de conexión con el servidor',
      classes: 'bg-red-500/15 text-red-300 border-red-500/40',
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
    },
  }[state];

  const title =
    state === 'error'
      ? errorMessage || 'No se pudo comunicar con el servidor'
      : lastLabel
        ? `Última sincronización: ${lastLabel}`
        : 'Esperando la primera sincronización';

  return (
    <div className="flex items-center gap-1.5 shrink-0" data-testid="sync-status" data-sync-state={state}>
      <div
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold ${view.classes}`}
        title={title}
        role="status"
        aria-live="polite"
      >
        {view.icon}
        <span className="hidden md:inline">{view.label}</span>
        {lastLabel && state !== 'error' && state !== 'sincronizando' && (
          <span className="hidden xl:inline font-mono text-[10px] opacity-70">{lastLabel}</span>
        )}
      </div>
      <button
        type="button"
        data-testid="sync-refresh"
        onClick={() => void refreshAll()}
        disabled={state === 'sincronizando'}
        title="Sincronizar ahora"
        aria-label="Sincronizar ahora"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-white/15 bg-white/[0.04] text-[11px] font-semibold text-zinc-200 hover:bg-white/[0.1] disabled:opacity-60 transition"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${state === 'sincronizando' ? 'animate-spin' : ''}`} />
        <span className="hidden lg:inline">Sincronizar ahora</span>
      </button>
    </div>
  );
};
