import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Check,
  CheckCheck,
  Clock,
  ExternalLink,
  Package,
  Store,
  UserCheck,
  Wifi,
  X,
} from 'lucide-react';
import { DegustacionNotificationItem, DegustacionToastAlert } from '../../types';

function formatExactAndRelativeVeTime(isoString: string, nowMs: number): {
  relative: string;
  exactTime: string;
} {
  if (!isoString) {
    return { relative: 'Reciente', exactTime: '--:--' };
  }
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return { relative: isoString, exactTime: isoString };
  }

  const diffSec = Math.max(0, Math.floor((nowMs - parsed.getTime()) / 1000));
  let relative = 'Justo ahora';
  if (diffSec >= 10 && diffSec < 60) {
    relative = `Hace ${diffSec} seg`;
  } else if (diffSec >= 60 && diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    relative = `Hace ${mins} min`;
  } else if (diffSec >= 3600 && diffSec < 86400) {
    const hrs = Math.floor(diffSec / 3600);
    relative = `Hace ${hrs} h`;
  } else if (diffSec >= 86400) {
    const days = Math.floor(diffSec / 86400);
    relative = `Hace ${days} d`;
  }

  const exactTime = parsed.toLocaleString('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  return { relative, exactTime };
}

function formatScheduledDateShort(ymd: string): string {
  const parts = String(ymd || '').slice(0, 10).split('-');
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export interface DegustacionesNotificationBellProps {
  unreadItems: DegustacionNotificationItem[];
  unreadCount: number;
  isLoading: boolean;
  isRealtimeConnected: boolean;
  hasRecentArrivalPulse: boolean;
  onSelectNotification: (item: DegustacionNotificationItem) => void;
  onMarkAsRead: (surveyId: string) => Promise<void>;
  onMarkAllAsRead: () => Promise<void>;
}

export const DegustacionesNotificationBell: React.FC<DegustacionesNotificationBellProps> = ({
  unreadItems,
  unreadCount,
  isLoading,
  isRealtimeConnected,
  hasRecentArrivalPulse,
  onSelectNotification,
  onMarkAsRead,
  onMarkAllAsRead,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isMarkingAll, setIsMarkingAll] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Actualizar reloj relativo cada 20 segundos mientras esté montado
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 20000);
    return () => clearInterval(timer);
  }, []);

  // Cerrar Popover al hacer clic fuera o presionar Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (ev: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount);

  const handleMarkAllClick = async () => {
    if (unreadCount === 0 || isMarkingAll) return;
    setIsMarkingAll(true);
    try {
      await onMarkAllAsRead();
    } finally {
      setIsMarkingAll(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Botón del Globito en el Header Superior */}
      <button
        type="button"
        onClick={() => {
          setNowMs(Date.now());
          setIsOpen((prev) => !prev);
        }}
        aria-label={
          unreadCount > 0
            ? `Notificaciones de degustaciones: ${unreadCount} sin leer`
            : 'Notificaciones de degustaciones: sin pendientes'
        }
        aria-expanded={isOpen}
        title={
          unreadCount > 0
            ? `${unreadCount} degustación(es) nueva(s) enviada(s) por Fuerza de Ventas`
            : 'Bandeja de degustaciones FDV en tiempo real (0 pendientes)'
        }
        className={`relative inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-all cursor-pointer select-none ${
          isOpen
            ? 'bg-[#18181B] border-[#DC2626] text-[#FFFFFF] shadow-[0_0_16px_rgba(220,38,38,0.35)]'
            : unreadCount > 0
              ? 'bg-[#18181B] hover:bg-zinc-800 border-[#DC2626]/60 text-[#FFFFFF] shadow-[0_2px_12px_rgba(220,38,38,0.25)]'
              : 'bg-[#18181B]/90 hover:bg-zinc-800/90 border-white/10 text-zinc-300 hover:text-[#FFFFFF]'
        }`}
      >
        <Bell
          className={`w-[18px] h-[18px] transition-transform ${
            hasRecentArrivalPulse ? 'text-[#FFFFFF] scale-110' : unreadCount > 0 ? 'text-[#FFFFFF]' : 'text-zinc-300'
          }`}
        />

        {/* Indicador discreto de conexión Realtime en esquina inferior derecha */}
        <span
          className={`absolute bottom-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${
            isRealtimeConnected ? 'bg-emerald-400' : 'bg-amber-400'
          }`}
          title={isRealtimeConnected ? 'Escucha Realtime activa' : 'Modo sincronización activa'}
        />

        {/* GLOBITO CIRCULAR CORPORATIVO (#DC2626 con texto #FFFFFF en negrita) */}
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center">
            <span
              className={`absolute inline-flex h-full w-full rounded-full bg-[#DC2626] ${
                hasRecentArrivalPulse ? 'animate-ping opacity-85' : 'animate-pulse opacity-45'
              }`}
            />
            <span className="relative inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-[#DC2626] text-[#FFFFFF] text-[10px] font-black font-mono leading-none tracking-tight border-2 border-[#09090B] shadow-[0_2px_10px_rgba(220,38,38,0.7)]">
              {badgeLabel}
            </span>
          </span>
        )}
      </button>

      {/* PANEL FLOTANTE DESPLEGABLE (POPOVER / DROPDOWN) */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Panel de notificaciones de degustaciones"
          className="absolute right-0 mt-2.5 w-[350px] sm:w-[420px] max-w-[calc(100vw-1.5rem)] rounded-2xl bg-[#09090B] border border-white/15 shadow-[0_24px_64px_rgba(0,0,0,0.92),0_0_0_1px_rgba(220,38,38,0.18)] overflow-hidden z-50"
        >
          {/* Línea superior corporativa roja */}
          <div className="h-[3px] w-full bg-[#DC2626]" />

          {/* Encabezado del Dropdown */}
          <div className="px-4 py-3.5 bg-[#09090B] border-b border-white/10 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-extrabold text-[#FFFFFF] uppercase tracking-wider">
                  Degustaciones FDV
                </span>
                <span
                  className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-black font-mono ${
                    unreadCount > 0
                      ? 'bg-[#DC2626] text-[#FFFFFF]'
                      : 'bg-[#18181B] text-zinc-400 border border-white/10'
                  }`}
                >
                  {unreadCount} {unreadCount === 1 ? 'nueva' : 'nuevas'}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-1 text-[10px] text-zinc-400">
                <Wifi className={`w-3 h-3 ${isRealtimeConnected ? 'text-emerald-400' : 'text-amber-400'}`} />
                <span>
                  {isRealtimeConnected
                    ? 'Sincronización Realtime activa (Vendedores → Trade)'
                    : 'Canal de respaldo activo con Supabase'}
                </span>
              </div>
            </div>

            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllClick}
                disabled={isMarkingAll}
                className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#18181B] hover:bg-[#DC2626] text-zinc-200 hover:text-[#FFFFFF] border border-white/10 hover:border-[#DC2626] text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-50"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>{isMarkingAll ? 'Marcando...' : 'Marcar todas como vistas'}</span>
              </button>
            )}
          </div>

          {/* Lista de Degustaciones Pendientes de Revisión */}
          <div className="max-h-[410px] overflow-y-auto divide-y divide-white/[0.06] bg-[#09090B]">
            {isLoading && unreadCount === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-zinc-400 font-mono">
                Consultando bandeja de degustaciones en Supabase...
              </div>
            ) : unreadItems.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <div className="w-11 h-11 rounded-2xl bg-[#18181B] border border-white/10 flex items-center justify-center mx-auto mb-3 text-zinc-400">
                  <Bell className="w-5 h-5" />
                </div>
                <p className="text-xs font-bold text-[#FFFFFF]">
                  Sin degustaciones nuevas pendientes de lectura
                </p>
                <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">
                  Cuando un vendedor envíe una nueva solicitud de degustación, aparecerá aquí al instante.
                </p>
              </div>
            ) : (
              unreadItems.map((item) => {
                const timeInfo = formatExactAndRelativeVeTime(item.createdAt, nowMs);
                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      setIsOpen(false);
                      onSelectNotification(item);
                    }}
                    className="group px-4 py-3.5 bg-[#18181B]/70 hover:bg-[#18181B] transition-colors cursor-pointer relative"
                  >
                    {/* Indicador lateral rojo de no leído */}
                    <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r-full bg-[#DC2626]" />

                    <div className="flex items-start justify-between gap-2.5">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        {/* Vendedor + Hora relativa/exacta */}
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-extrabold text-[#FFFFFF] truncate">
                            <UserCheck className="w-3.5 h-3.5 text-[#DC2626] shrink-0" />
                            <span className="truncate">{item.sellerName}</span>
                          </span>
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-mono text-zinc-400 shrink-0"
                            title={`Enviado exactamente: ${timeInfo.exactTime}`}
                          >
                            <Clock className="w-3 h-3 text-zinc-500" />
                            <span>{timeInfo.relative}</span>
                          </span>
                        </div>

                        {/* Cliente PDV */}
                        <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-100">
                          <Store className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          <span className="truncate">{item.storeName}</span>
                          {item.clienteCodigo && (
                            <span className="shrink-0 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-[#09090B] text-zinc-300 border border-white/10">
                              #{item.clienteCodigo}
                            </span>
                          )}
                        </div>

                        {/* Producto, Cantidad, Fecha programada y Turno */}
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#DC2626]/15 text-red-300 border border-[#DC2626]/30 text-[10px] font-bold">
                            <Package className="w-3 h-3 text-[#DC2626]" />
                            <span>{item.productName}</span>
                            <span className="font-mono text-[#FFFFFF]">({item.requestedQty} kg/un)</span>
                          </span>
                          <span className="px-1.5 py-0.5 rounded-md bg-[#09090B] text-zinc-300 border border-white/10 text-[10px] font-mono">
                            {formatScheduledDateShort(item.date)} · {item.shift}
                          </span>
                        </div>

                        {/* Pie de tarjeta: Hora exacta de envío + acciones individuales */}
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className="text-[10px] font-mono text-zinc-400 truncate">
                            Envío: {timeInfo.exactTime}
                          </span>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void onMarkAsRead(item.id);
                              }}
                              title="Marcar como vista (-1)"
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#09090B] hover:bg-zinc-800 text-zinc-300 hover:text-[#FFFFFF] border border-white/10 text-[10px] font-semibold transition-colors cursor-pointer"
                            >
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span>Vista</span>
                            </button>

                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#DC2626] group-hover:bg-red-500 text-[#FFFFFF] text-[10px] font-bold transition-colors">
                              <span>Abrir</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export interface DegustacionesRealtimeToastStackProps {
  toasts: DegustacionToastAlert[];
  onDismiss: (toastId: string) => void;
  onOpenDegustacion: (surveyId: string) => void;
}

export const DegustacionesRealtimeToastStack: React.FC<DegustacionesRealtimeToastStackProps> = ({
  toasts,
  onDismiss,
  onOpenDegustacion,
}) => {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed top-20 right-4 z-[80] flex flex-col gap-2.5 w-[360px] max-w-[calc(100vw-2rem)] pointer-events-none no-print"
    >
      {toasts.map((toast) => (
        <div
          key={toast.toastId}
          className="pointer-events-auto relative rounded-2xl bg-[#09090B]/95 backdrop-blur-xl border border-white/15 shadow-[0_18px_45px_rgba(0,0,0,0.85),0_0_0_1px_rgba(220,38,38,0.3)] overflow-hidden"
        >
          <div className="absolute left-0 inset-y-0 w-1.5 bg-[#DC2626]" />
          <div className="pl-4 pr-3 py-3.5 flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#DC2626] text-[#FFFFFF] flex items-center justify-center shrink-0 shadow-[0_0_14px_rgba(220,38,38,0.6)]">
              <Bell className="w-4 h-4 animate-bounce" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[10px] font-black uppercase tracking-wider text-red-400 font-mono">
                  Nueva Degustación en Tiempo Real
                </span>
                <button
                  type="button"
                  onClick={() => onDismiss(toast.toastId)}
                  aria-label="Cerrar alerta"
                  className="text-zinc-500 hover:text-[#FFFFFF] transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <p className="text-xs font-bold text-[#FFFFFF] mt-1 leading-snug">
                Nueva degustación enviada por{' '}
                <span className="text-red-400">{toast.sellerName}</span> - Cliente:{' '}
                <span className="underline decoration-[#DC2626]/70 underline-offset-2">
                  {toast.storeName}
                </span>
              </p>

              <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-white/[0.08]">
                <span className="text-[10px] font-mono text-zinc-300 truncate">
                  {toast.productName} · {toast.requestedQty} kg/un
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onDismiss(toast.toastId);
                    onOpenDegustacion(toast.surveyId);
                  }}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#DC2626] hover:bg-red-500 text-[#FFFFFF] text-[10px] font-bold transition-colors cursor-pointer"
                >
                  <span>Ver en Trade</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
