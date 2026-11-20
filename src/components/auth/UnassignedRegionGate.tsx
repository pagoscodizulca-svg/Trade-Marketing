import React from 'react';
import { Lock, LogOut, ShieldAlert } from 'lucide-react';
import type { VerifiedAuthProfile } from '../../services/authService';

export interface UnassignedRegionGateProps {
  profile: Pick<VerifiedAuthProfile, 'email' | 'displayName' | 'iamRole'>;
  onSignOut: () => Promise<void> | void;
}

/**
 * Pantalla segura Fail-Closed para usuarios regionales autenticados sin `region_id` asignado.
 * Garantiza 0 consultas a tablas maestras/operativas y 0 exposición de registros.
 */
export const UnassignedRegionGate: React.FC<UnassignedRegionGateProps> = ({
  profile,
  onSignOut,
}) => {
  return (
    <div
      data-testid="unassigned-region-screen"
      role="alert"
      className="min-h-screen bg-[#09090B] text-white flex items-center justify-center p-4 font-sans"
    >
      <div className="max-w-md w-full rounded-2xl bg-[#121215] border border-red-600/50 shadow-2xl p-6 sm:p-8 space-y-5">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-white p-1.5 flex items-center justify-center shrink-0">
            <img
              src="/codizulca-logo.png"
              alt="CODIZULCA C.A."
              className="w-full h-full object-contain"
            />
          </div>
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-red-600 text-white">
              <Lock className="w-3 h-3" /> Acceso Restringido · Fail-Closed
            </span>
            <h1 className="text-lg font-extrabold tracking-tight text-white mt-1">
              Sin Región Asignada
            </h1>
          </div>
        </div>

        <div className="rounded-xl bg-[#09090B] border border-zinc-800 p-4 space-y-2 text-xs text-zinc-300 leading-relaxed">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p>
              Tu cuenta corporativa (<strong className="text-white">{profile.email}</strong>) aún
              no tiene una sucursal/región confirmada por el Administrador General (
              <code className="text-red-400">admin@codizulca.com</code>).
            </p>
          </div>
          <p className="text-zinc-400">
            Por política estricta de aislamiento multi-sucursal (RLS), no se muestran clientes,
            promotoras, supervisores ni operaciones hasta que se asigne tu región oficial.
          </p>
        </div>

        <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 px-1">
          <span>Usuario: {profile.displayName}</span>
          <span>Región: PENDIENTE</span>
        </div>

        <button
          type="button"
          data-testid="btn-unassigned-region-signout"
          onClick={() => void onSignOut()}
          className="w-full py-2.5 px-4 rounded-xl bg-red-600 hover:bg-red-500 text-white font-extrabold text-sm flex items-center justify-center gap-2 transition cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Cerrar sesión y purgar caché</span>
        </button>
      </div>
    </div>
  );
};
