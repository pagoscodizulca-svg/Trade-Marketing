import { AlertTriangle, CloudOff, Loader2, RefreshCw, Wifi } from 'lucide-react';
import type { SyncState } from '../../services/entregasRepository';

interface SyncStatusBannerProps {
  sync: SyncState;
  /** «Reintentar ahora»: vacía la cola ignorando la espera entre reintentos. */
  onRetry: () => void | Promise<void>;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const plural = (n: number) => (n === 1 ? '1 entrega guardada' : `${n} entregas guardadas`);

export type EstadoBanner = 'en-linea' | 'offline' | 'sincronizando' | 'error';

/** Decide el estado visible del banner a partir del estado de sincronización. */
export function estadoBanner(sync: SyncState): EstadoBanner {
  if (sync.offline) return 'offline';
  if (sync.status === 'error') return 'error';
  if (sync.flushing || sync.pendingCount > 0) return 'sincronizando';
  return 'en-linea';
}

/**
 * Banner compacto de conectividad para el teléfono del chofer.
 *  Verde: en línea y sincronizado · Ámbar: sin internet · Azul: sincronizando en segundo plano ·
 *  Rojo: el servidor devolvió un error (no se muestra «Sincronizado» si no lo está).
 */
export function SyncStatusBanner({ sync, onRetry }: SyncStatusBannerProps) {
  const estado = estadoBanner(sync);
  const n = sync.pendingCount;

  const cfg =
    estado === 'offline'
      ? {
          caja: 'bg-amber-100 border-amber-500 text-amber-950',
          icono: <CloudOff className="w-5 h-5 shrink-0" aria-hidden="true" />,
          texto:
            n > 0
              ? `Modo Offline • ${plural(n)} en el teléfono (se sincronizarán solas al volver la señal)`
              : sync.lastSyncAt
                ? `Modo Offline • Mostrando tu ruta guardada a las ${hhmm(sync.lastSyncAt)}`
                : 'Modo Offline • Sin ruta guardada en el teléfono: conéctate una vez para descargarla',
        }
      : estado === 'error'
        ? {
            caja: 'bg-red-100 border-red-600 text-red-950',
            icono: <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden="true" />,
            texto: 'Error de conexión con el servidor' + (sync.errorMessage ? ` • ${sync.errorMessage}` : ''),
          }
        : estado === 'sincronizando'
          ? {
              caja: 'bg-blue-100 border-blue-600 text-blue-950',
              icono: <Loader2 className="w-5 h-5 shrink-0 animate-spin" aria-hidden="true" />,
              texto:
                n > 0
                  ? `Conexión recuperada • Sincronizando ${n} ${n === 1 ? 'entrega' : 'entregas'} en segundo plano…`
                  : 'Conexión recuperada • Sincronizando en segundo plano…',
            }
          : {
              caja: 'bg-green-100 border-green-600 text-green-950',
              icono: <Wifi className="w-5 h-5 shrink-0" aria-hidden="true" />,
              texto: sync.realtime ? 'En línea • Sincronizado en tiempo real' : 'En línea • Sincronizado',
            };

  const mostrarReintentar = estado === 'error' || (estado === 'sincronizando' && n > 0);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sync-banner"
      data-estado={estado}
      data-pendientes={n}
      className={`rounded-xl border-2 px-3 py-2 flex flex-wrap items-center gap-2.5 text-sm font-bold leading-snug ${cfg.caja}`}
    >
      {cfg.icono}
      <span className="flex-1 min-w-0" data-testid="sync-banner-texto">
        {cfg.texto}
      </span>
      {mostrarReintentar && (
        <button
          type="button"
          onClick={() => void onRetry()}
          disabled={sync.flushing}
          data-testid="sync-reintentar"
          className={`shrink-0 min-h-10 px-3 rounded-lg text-white text-xs font-black inline-flex items-center gap-1.5 disabled:opacity-60 ${
            estado === 'error' ? 'bg-red-700' : 'bg-blue-700'
          }`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${sync.flushing ? 'animate-spin' : ''}`} aria-hidden="true" />
          Reintentar ahora
        </button>
      )}
      {sync.aviso && (
        <span className="basis-full text-xs font-semibold opacity-90" data-testid="sync-banner-aviso">
          {sync.aviso}
        </span>
      )}
    </div>
  );
}
