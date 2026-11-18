import React from 'react';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { ManagedUserRole } from '../../services/userManagementService';

export interface RoleGuardProps {
  allowedRoles: readonly ManagedUserRole[];
  variant?: 'inline' | 'route';
  deniedTitle?: string;
  deniedDescription?: string;
  onReturnHome?: () => void;
  children?: React.ReactNode;
}

/**
 * Guardia declarativo de autorización IAM:
 * - En modo `inline` (por defecto, ej. enlaces de menú): oculta completamente el nodo del DOM
 *   si el rol verificado no pertenece a `allowedRoles`.
 * - En modo `route` (acceso directo por URL o pestaña): bloquea el montaje de la vista protegida y
 *   muestra una pantalla corporativa 403 con retorno controlado al inicio.
 */
export const RoleGuard: React.FC<RoleGuardProps> = ({
  allowedRoles,
  variant = 'inline',
  deniedTitle = 'Acceso restringido para tu rol corporativo',
  deniedDescription = 'Tu perfil actual no cuenta con autorización para operar este módulo.',
  onReturnHome,
  children,
}) => {
  const { verifiedIamRole } = useApp();

  const isAuthorized =
    verifiedIamRole !== null && allowedRoles.includes(verifiedIamRole);

  if (isAuthorized) {
    return <>{children}</>;
  }

  if (variant === 'inline') {
    return null;
  }

  return (
    <div
      role="alert"
      data-testid="role-guard-denied"
      className="max-w-lg mx-auto my-14 rounded-2xl bg-zinc-950/95 border border-red-500/30 p-7 text-center shadow-2xl space-y-4"
    >
      <div className="w-12 h-12 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center mx-auto">
        <ShieldAlert className="w-6 h-6 text-red-400" />
      </div>

      <div className="space-y-1.5">
        <span className="inline-block text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/25">
          HTTP 403 · Acceso Restringido
        </span>
        <h2 className="text-lg font-extrabold text-white tracking-tight">
          {deniedTitle}
        </h2>
        <p className="text-xs text-zinc-400 leading-relaxed">
          {deniedDescription}
        </p>
      </div>

      {onReturnHome && (
        <div className="pt-2">
          <button
            type="button"
            onClick={onReturnHome}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-bold text-white transition cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Volver al panel operativo</span>
          </button>
        </div>
      )}
    </div>
  );
};
