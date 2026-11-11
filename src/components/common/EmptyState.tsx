import React from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { useApp } from '../../context/AppContext';

interface EmptyStateProps {
  title?: string;
  description?: string;
  /** Muestra el botón «Sincronizar ahora» */
  showRefresh?: boolean;
  compact?: boolean;
}

/** Estado vacío estándar: se muestra cuando no existen registros sincronizados (nunca datos de ejemplo). */
export const EmptyState: React.FC<EmptyStateProps> = ({
  title = 'No hay registros sincronizados en este momento',
  description = 'Cuando existan datos en el servidor aparecerán aquí automáticamente.',
  showRefresh = true,
  compact = false,
}) => {
  const { refreshAll, syncStatus } = useApp();
  const busy = syncStatus.state === 'sincronizando';
  return (
    <div
      data-testid="empty-state"
      className={`flex flex-col items-center justify-center text-center border border-dashed border-white/15 rounded-2xl bg-white/[0.02] ${
        compact ? 'py-6 px-4' : 'py-12 px-6'
      }`}
    >
      <div className="w-11 h-11 rounded-xl bg-white/[0.06] border border-white/10 grid place-items-center mb-3">
        <Database className="w-5 h-5 text-zinc-400" />
      </div>
      <p className="text-sm font-bold text-zinc-100">{title}</p>
      <p className="text-xs text-zinc-400 mt-1 max-w-md">
        {syncStatus.state === 'error' && syncStatus.errorMessage ? syncStatus.errorMessage : description}
      </p>
      {showRefresh && (
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={busy}
          className="mt-4 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-xs font-bold transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          Sincronizar ahora
        </button>
      )}
    </div>
  );
};
