import React from 'react';
import {
  ChevronRight,
  Clock,
  LogOut,
  Mail,
  MapPin,
  Package,
  Phone,
  ShieldCheck,
  Sparkles,
  Store,
} from 'lucide-react';
import type { RutaPromotoraRecord } from '../../types/degustacionesPipeline';
import type { PortalPromotoraContext } from '../../services/promotoraCampoService';

interface PortalPerfilTabProps {
  context: PortalPromotoraContext;
  routes: RutaPromotoraRecord[];
  onGoToRuta: () => void;
  onSignOut: () => void;
}

export const PortalPerfilTab: React.FC<PortalPerfilTabProps> = ({
  context,
  routes,
  onGoToRuta,
  onSignOut,
}) => {
  const activeRoute =
    routes.find((r) => r.estado_ruta === 'EN_CURSO') ||
    routes.find((r) => r.estado_ruta === 'ASIGNADA') ||
    routes[0] ||
    null;

  const initials = context.nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');

  return (
    <div className="space-y-4 pb-8 text-white" data-testid="portal-perfil-tab">
      {/* Cabecera de Ficha */}
      <div className="bg-[#141414] border border-white/10 rounded-2xl p-4 shadow-lg flex items-center gap-3.5">
        <div className="w-16 h-16 rounded-2xl border-2 border-red-500/40 bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center font-black text-white text-xl shrink-0">
          {initials || 'PR'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h2 className="text-base font-black text-white truncate">{context.nombre}</h2>
            <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase font-mono bg-red-600/20 text-red-400 border border-red-500/30">
              {context.categoria}
            </span>
          </div>
          <p className="text-xs text-zinc-400 font-mono mt-0.5 flex items-center gap-1">
            <MapPin className="w-3 h-3 text-red-500 shrink-0" />
            <span className="truncate">
              {context.region} • {context.direccion || 'Zona asignada'}
            </span>
          </p>
          <p className="text-[11px] text-zinc-400 font-mono mt-0.5 flex items-center gap-1">
            <Mail className="w-3 h-3 text-zinc-500 shrink-0" />
            <span className="truncate">{context.correo}</span>
          </p>
        </div>
      </div>

      {/* Degustación Asignada */}
      <div className="bg-[#141414] border border-white/10 rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-red-400">
            <Sparkles className="w-4 h-4" />
            <span>Degustaciones Asignadas</span>
          </div>
          <span className="text-[10px] font-mono font-bold text-zinc-400">
            {routes.length} programada(s)
          </span>
        </div>

        {activeRoute ? (
          <div className="bg-[#1a1a1a] border border-red-500/30 rounded-xl p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="text-[10px] font-mono text-zinc-400 font-bold block">
                  {activeRoute.fecha} • {activeRoute.turno}
                </span>
                <h4 className="text-xs font-black text-white mt-0.5">
                  {activeRoute.cliente_nombre}
                </h4>
              </div>
              <span
                className={`px-2 py-0.5 rounded text-[9px] font-black uppercase font-mono ${
                  activeRoute.estado_ruta === 'EN_CURSO'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : activeRoute.estado_ruta === 'COMPLETADA'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-zinc-800 text-zinc-300'
                }`}
              >
                {activeRoute.estado_ruta}
              </span>
            </div>

            <div className="space-y-1 text-xs text-zinc-300">
              <div className="flex items-center gap-1.5">
                <Store className="w-3.5 h-3.5 text-red-500 shrink-0" />
                <span className="truncate">{activeRoute.zona_direccion || context.region}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span className="truncate">{activeRoute.producto_resumen}</span>
              </div>
              <div className="flex items-center gap-1.5 text-zinc-400 text-[11px]">
                <Clock className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {activeRoute.hora_inicio} – {activeRoute.hora_fin}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={onGoToRuta}
              className="mt-2 w-full py-2 px-3 rounded-lg bg-red-600/20 hover:bg-red-600 border border-red-500/40 text-red-400 hover:text-white text-xs font-black flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            >
              <span>Ver en Pestaña de Ruta</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="p-4 rounded-xl bg-[#1a1a1a] border border-white/5 text-center text-xs text-zinc-400">
            No tienes degustaciones activas asignadas en este momento.
          </div>
        )}
      </div>

      {/* Seguridad y Sesión (Zero-Trust — cero contraseñas expuestas) */}
      <div className="bg-[#141414] border border-white/10 rounded-2xl p-4 space-y-2.5 text-xs">
        <h3 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>Sesión Autenticada (Zero-Trust)</span>
        </h3>
        <div className="flex items-center justify-between py-1.5 border-b border-white/5">
          <span className="text-zinc-400">Correo Verificado</span>
          <span className="font-mono font-bold text-white truncate max-w-[200px]">
            {context.correo}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-white/5">
          <span className="text-zinc-400">Perfil de Asistencia</span>
          <span className="font-mono font-bold text-sky-400">
            {context.perfilAsistencia === 'EVENTUAL' ? 'EVENTUAL (4 fotos)' : 'FIJA (2 fotos)'}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-white/5">
          <span className="text-zinc-400 flex items-center gap-1">
            <Phone className="w-3 h-3" /> Teléfono
          </span>
          <span className="font-mono font-bold text-white">
            {context.telefono || 'Sin registrar'}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5">
          <span className="text-zinc-400">Autenticación</span>
          <span className="px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-500/40 text-emerald-400 font-bold text-[10px]">
            Supabase Auth + RLS Activo
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={onSignOut}
        className="w-full py-3 rounded-2xl bg-zinc-900 hover:bg-red-950/60 border border-white/10 hover:border-red-500/40 text-red-400 font-black text-xs flex items-center justify-center gap-2 transition-all cursor-pointer"
      >
        <LogOut className="w-4 h-4" />
        <span>Cerrar Sesión</span>
      </button>
    </div>
  );
};
