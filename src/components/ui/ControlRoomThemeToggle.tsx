import React from 'react';
import { Monitor, Sun } from 'lucide-react';
import { useThemeMode } from '../../context/ThemeModeContext';

export interface ControlRoomThemeToggleProps {
  compact?: boolean;
  className?: string;
}

/**
 * Selector sobrio de estilo suizo corporativo (cero emojis):
 * Alterna en caliente entre `default` (Modo Día Ejecutivo 60/30/10)
 * y `control-room` (Modo Oscuro Nocturno Completo para Sala de Control).
 */
export const ControlRoomThemeToggle: React.FC<ControlRoomThemeToggleProps> = ({
  compact = false,
  className = '',
}) => {
  const { isControlRoom, toggleMode } = useThemeMode();

  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-pressed={isControlRoom}
      aria-label={
        isControlRoom
          ? 'Modo Sala de Control activo. Cambiar a Modo Día Ejecutivo'
          : 'Modo Día Ejecutivo activo. Activar Modo Oscuro Nocturno de Sala de Control'
      }
      title={
        isControlRoom
          ? 'Modo Oscuro Nocturno Completo activo (Sala de Control) — clic para volver a Modo Día Ejecutivo'
          : 'Activar Modo Oscuro Nocturno Completo (Sala de Control)'
      }
      data-testid="control-room-theme-toggle"
      data-theme-state={isControlRoom ? 'control-room' : 'default'}
      className={`cz-theme-toggle inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-xs font-bold tracking-tight cursor-pointer select-none no-print ${
        isControlRoom
          ? 'bg-[#18181B] border-[#27272A] text-[#FAFAFA] hover:border-[#DC2626]'
          : 'bg-[#FFFFFF] border-[#E4E4E7] text-[#09090B] hover:border-[#DC2626]'
      } ${className}`}
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${
          isControlRoom ? 'bg-[#EF4444]' : 'bg-[#09090B]'
        }`}
        aria-hidden="true"
      />
      {isControlRoom ? (
        <Monitor className="w-3.5 h-3.5 text-[#EF4444] shrink-0" aria-hidden="true" />
      ) : (
        <Sun className="w-3.5 h-3.5 text-[#DC2626] shrink-0" aria-hidden="true" />
      )}
      {!compact && (
        <span className="hidden sm:inline whitespace-nowrap">
          {isControlRoom ? 'Sala de Control' : 'Día Ejecutivo'}
        </span>
      )}
    </button>
  );
};
