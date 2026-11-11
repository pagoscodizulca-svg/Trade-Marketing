import { RefreshCw } from 'lucide-react';
import type { SyncState } from '../../services/entregasRepository';

interface SyncStatusBadgeProps {
  sync: SyncState;
  onRefresh: () => void | Promise<void>;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const formatoHora = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** Insignia de estado de sincronización con Supabase + botón «Sincronizar ahora». */
export function SyncStatusBadge({ sync, onRefresh }: SyncStatusBadgeProps) {
  const { status, errorMessage, lastSyncAt, realtime, offline, pendingCount } = sync;

  const cfg = offline
    ? {
        dot: 'bg-amber-400',
        texto: pendingCount > 0 ? `Sin conexión · ${pendingCount} pendiente${pendingCount === 1 ? '' : 's'}` : 'Sin conexión',
        title: 'Sin internet: se muestra la última copia guardada. Los cambios se enviarán solos al volver la señal.',
      }
    : status === 'error'
      ? {
          dot: 'bg-red-500',
          texto: 'Error de conexión con el servidor',
          title: errorMessage ?? 'Error desconocido',
        }
      : status === 'sincronizado'
        ? {
            dot: 'bg-green-500',
            texto: realtime ? 'Sincronizado en tiempo real' : 'Sincronizado',
            title: realtime
              ? 'Conectado a Supabase con actualizaciones en tiempo real'
              : 'Carga correcta. El canal en tiempo real no está activo: pulse «Sincronizar ahora» para actualizar.',
          }
        : { dot: 'bg-yellow-400 animate-pulse', texto: 'Sincronizando…', title: 'Consultando el servidor' };

  return (
    <div className="flex items-center gap-2 min-w-0" data-testid="sync-status" data-status={status}>
      <span
        className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-200 border border-white/15 rounded-full px-2.5 py-1 min-w-0"
        title={cfg.title}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} aria-hidden="true" />
        <span className="truncate" role="status">
          {cfg.texto}
        </span>
        {status === 'sincronizado' && lastSyncAt && (
          <span className="hidden sm:inline text-zinc-400 font-semibold" data-testid="sync-last">
            · última sincronización {formatoHora(lastSyncAt)}
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => void onRefresh()}
        disabled={status === 'sincronizando'}
        data-testid="sync-refresh"
        className="inline-flex items-center gap-1.5 text-[11px] font-bold text-white bg-brand hover:bg-brand-dark rounded-full px-2.5 py-1 min-h-7 shrink-0 disabled:opacity-60"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${status === 'sincronizando' ? 'animate-spin' : ''}`} aria-hidden="true" />
        Sincronizar ahora
      </button>
    </div>
  );
}
