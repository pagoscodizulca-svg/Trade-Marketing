import React from 'react';
import {
  AlertTriangle,
  CloudOff,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import type { OfflineSyncVisualState } from '../../hooks/useOfflineSync';

export interface OfflineSyncBannerProps {
  visualState: OfflineSyncVisualState;
  pendingCount: number;
  isSyncing: boolean;
  isOnline: boolean;
  lastError: string | null;
  cachedClientsCount?: number;
  cachedProductsCount?: number;
  shiftLabel?: string | null;
  shiftExpiresAtIso?: string | null;
  onRetryNow: () => void;
  onCloseShiftPurge?: () => void;
}

function formatExpiryVe(iso: string | null | undefined): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString('es-VE', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Banner superior reactivo de estado de sincronización Offline-First para el personal en campo (`/portal`).
 * Identidad corporativa Negro / Rojo / Blanco con estados claros de señal, cola pendiente y vigencia de jornada.
 */
export const OfflineSyncBanner: React.FC<OfflineSyncBannerProps> = ({
  visualState,
  pendingCount,
  isSyncing,
  isOnline,
  lastError,
  cachedClientsCount = 0,
  cachedProductsCount = 0,
  shiftLabel = null,
  shiftExpiresAtIso = null,
  onRetryNow,
  onCloseShiftPurge,
}) => {
  const palette =
    visualState === 'offline'
      ? {
          wrap: 'bg-amber-950/75 border-amber-500/55 text-amber-100',
          icon: <CloudOff className="w-4 h-4 text-amber-400 shrink-0" />,
          headline:
            pendingCount > 0
              ? `Sin cobertura móvil · ${pendingCount} ${pendingCount === 1 ? 'reporte en cola' : 'reportes en cola'} (sincronización automática al reconectar)`
              : 'Modo Offline activo · Operando con caché local precargada en el dispositivo',
        }
      : visualState === 'syncing'
        ? {
            wrap: 'bg-zinc-900 border-red-500/45 text-white',
            icon: <Loader2 className="w-4 h-4 text-[#DC2626] animate-spin shrink-0" />,
            headline: `Sincronizando ${pendingCount} ${pendingCount === 1 ? 'mutación pendiente' : 'mutaciones pendientes'} con el servidor...`,
          }
        : visualState === 'pending_retry'
          ? {
              wrap: 'bg-red-950/65 border-red-500/50 text-red-100',
              icon: <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />,
              headline: `${pendingCount} ${pendingCount === 1 ? 'registro pendiente' : 'registros pendientes'} por confirmar${lastError ? ` · ${lastError}` : ''}`,
            }
          : {
              wrap: 'bg-zinc-950/90 border-emerald-500/35 text-emerald-100',
              icon: <Wifi className="w-4 h-4 text-emerald-400 shrink-0" />,
              headline: 'En línea · Sincronizado (respaldo Offline PWA listo)',
            };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="portal-offline-sync-banner"
      data-sync-state={visualState}
      data-pending-count={pendingCount}
      className={`rounded-xl border px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5 text-xs ${palette.wrap}`}
    >
      <div className="flex items-start sm:items-center gap-2.5 min-w-0 flex-1">
        {palette.icon}
        <div className="min-w-0">
          <p className="font-bold leading-snug" data-testid="portal-offline-banner-text">
            {palette.headline}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-0.5 text-[10px] font-mono opacity-85">
            {(cachedClientsCount > 0 || cachedProductsCount > 0) && (
              <span>
                Caché local: {cachedClientsCount} PDVs · {cachedProductsCount} productos
              </span>
            )}
            {shiftLabel && (
              <span className="inline-flex items-center gap-1 text-red-300 font-bold">
                <ShieldCheck className="w-3 h-3" />
                <span>{shiftLabel}</span>
                {shiftExpiresAtIso && <span>· Expira {formatExpiryVe(shiftExpiresAtIso)}</span>}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {pendingCount > 0 && isOnline && (
          <button
            type="button"
            data-testid="btn-portal-sync-now"
            disabled={isSyncing}
            onClick={onRetryNow}
            className="px-2.5 py-1.5 rounded-lg bg-[#DC2626] hover:bg-red-500 text-white text-[11px] font-extrabold inline-flex items-center gap-1.5 transition cursor-pointer disabled:opacity-55"
          >
            <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>Sincronizar ahora</span>
          </button>
        )}

        {onCloseShiftPurge && (
          <button
            type="button"
            data-testid="btn-portal-close-shift-purge"
            onClick={onCloseShiftPurge}
            title="Cerrar enlace de jornada y purgar todos los datos locales de IndexedDB"
            className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-red-950/80 border border-white/15 hover:border-red-500/50 text-zinc-200 hover:text-red-200 text-[11px] font-bold inline-flex items-center gap-1 transition cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
            <span>Cerrar jornada</span>
          </button>
        )}
      </div>
    </div>
  );
};
