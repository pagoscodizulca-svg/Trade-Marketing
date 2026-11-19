import React from 'react';
import {
  BarChart3,
  Building2,
  CheckCircle2,
  Lock,
  MapPin,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useOptionalApp } from '../../context/AppContext';
import {
  DEFAULT_FIVE_REGIONES,
  type ActiveRegionItem,
} from '../../services/regionesService';
import {
  MANAGED_USER_ROLE_LABELS,
  SUCURSAL_LABELS,
  isOperativeSucursal,
  type OperativeSucursal,
} from '../../services/userManagementService';

export interface RegionGateSelectorProps {
  mode?: 'gate' | 'bar';
  regiones?: readonly ActiveRegionItem[];
  activeSucursal?: OperativeSucursal | null;
  canSwitchSucursal?: boolean;
  userRoleLabel?: string;
  userEmail?: string;
  onSelectSucursal?: (sucursal: OperativeSucursal) => void;
  onOpenComparativo?: () => void;
}

const HUB_COVERAGE_DESCRIPTIONS: Record<string, string> = {
  ZULIA: 'Maracaibo · San Francisco · Cabimas · Costa Oriental del Lago',
  VALENCIA: 'Valencia · Naguanagua · San Diego · Guacara · Carabobo',
  CENTRO: 'Maracay · Aragua · Barquisimeto · Lara · Eje Central',
  ORIENTE: 'Puerto La Cruz · Anzoátegui · Maturín · Margarita · Bolívar',
  CAPITAL: 'Caracas · Distrito Capital · Miranda · La Guaira',
};

function resolveSucursalDisplayName(
  sucursal: OperativeSucursal | null | undefined,
  regiones: readonly ActiveRegionItem[]
): string {
  if (!sucursal) return 'Sin asignar';
  if (isOperativeSucursal(sucursal)) {
    return SUCURSAL_LABELS[sucursal];
  }
  const matched = regiones.find((r) => r.codigo === sucursal);
  if (matched) {
    return /^sucursal\b/i.test(matched.nombre)
      ? matched.nombre
      : `Sucursal ${matched.nombre}`;
  }
  return `Sucursal ${sucursal}`;
}

export const RegionGateSelector: React.FC<RegionGateSelectorProps> = ({
  mode = 'gate',
  regiones,
  activeSucursal,
  canSwitchSucursal,
  userRoleLabel,
  userEmail,
  onSelectSucursal,
  onOpenComparativo,
}) => {
  const appCtx = useOptionalApp();

  const effectiveRegiones: readonly ActiveRegionItem[] =
    regiones && regiones.length > 0
      ? regiones
      : appCtx?.activeRegiones && appCtx.activeRegiones.length > 0
        ? appCtx.activeRegiones
        : DEFAULT_FIVE_REGIONES;

  const effectiveActiveSucursal: OperativeSucursal | null =
    activeSucursal !== undefined ? activeSucursal : (appCtx?.activeSucursal ?? null);

  const effectiveCanSwitch: boolean =
    canSwitchSucursal !== undefined
      ? canSwitchSucursal
      : (appCtx?.canSwitchSucursal ?? true);

  const effectiveRoleLabel: string =
    userRoleLabel ??
    (appCtx?.verifiedIamRole ? MANAGED_USER_ROLE_LABELS[appCtx.verifiedIamRole] : undefined) ??
    'Dirección Corporativa';

  const effectiveEmail: string = userEmail ?? appCtx?.currentUser?.email ?? '';

  const handleChooseSucursal = (nextSucursal: OperativeSucursal) => {
    if (!effectiveCanSwitch) return;
    if (onSelectSucursal) {
      onSelectSucursal(nextSucursal);
      return;
    }
    appCtx?.setActiveSucursal(nextSucursal);
  };

  if (mode === 'bar') {
    const activeDisplayLabel = resolveSucursalDisplayName(
      effectiveActiveSucursal,
      effectiveRegiones
    );

    if (!effectiveCanSwitch) {
      return (
        <div
          data-testid="region-bar-selector"
          className="bg-zinc-950/95 border-b border-white/[0.07] no-print"
        >
          <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div
              data-testid="region-bar-locked-badge"
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-900 border border-emerald-500/30 text-zinc-100 font-semibold"
            >
              <Lock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Sucursal asignada por correo: {activeDisplayLabel}</span>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-zinc-400 font-mono">
              <ShieldCheck className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <span>
                Aislamiento RLS activo · {effectiveRoleLabel}
                {effectiveEmail ? ` (${effectiveEmail})` : ''}
              </span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        data-testid="region-bar-selector"
        className="bg-zinc-950/95 border-b border-white/[0.07] no-print"
      >
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <span
              data-testid="region-bar-active-pill"
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
                effectiveActiveSucursal
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                  : 'bg-amber-500/15 text-amber-300 border-amber-500/35'
              }`}
            >
              <MapPin className="w-3.5 h-3.5 shrink-0" />
              <span>
                Sucursal Activa:{' '}
                {effectiveActiveSucursal ? activeDisplayLabel : 'Pendiente de selección'}
              </span>
            </span>

            {/* Selector rápido por botones para las 5 sedes */}
            <div
              className="hidden lg:inline-flex items-center gap-1 p-0.5 rounded-xl bg-zinc-900 border border-white/10"
              role="group"
              aria-label="Cambio rápido de sucursal activa"
            >
              {effectiveRegiones.map((reg) => {
                const isSelected = effectiveActiveSucursal === reg.codigo;
                return (
                  <button
                    key={reg.id || reg.codigo}
                    type="button"
                    data-testid={`region-bar-btn-${reg.codigo}`}
                    onClick={() => handleChooseSucursal(reg.codigo)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                      isSelected
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'text-zinc-300 hover:text-white hover:bg-zinc-800'
                    }`}
                  >
                    {reg.nombre}
                  </button>
                );
              })}
            </div>

            {/* Selector desplegable accesible en todas las resoluciones */}
            <select
              aria-label="Seleccionar Sucursal Activa"
              data-testid="region-bar-select"
              value={effectiveActiveSucursal ?? ''}
              onChange={(e) => {
                const val = e.target.value as OperativeSucursal;
                if (val) handleChooseSucursal(val);
              }}
              className="lg:hidden px-2.5 py-1 rounded-xl bg-zinc-900 border border-white/15 text-xs font-bold text-white focus:outline-none focus:border-red-500 cursor-pointer"
            >
              <option value="" disabled>
                Elegir sucursal...
              </option>
              {effectiveRegiones.map((reg) => (
                <option
                  key={reg.id || reg.codigo}
                  value={reg.codigo}
                  className="bg-zinc-900 text-white"
                >
                  {reg.label || `Sucursal ${reg.nombre}`}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span className="hidden xl:inline-flex items-center gap-1.5 text-[11px] text-zinc-400 font-mono">
              <RefreshCw className="w-3 h-3 text-red-400 shrink-0" />
              <span>Cambiar de sede purga caché en memoria · Cero mezcla</span>
            </span>

            {onOpenComparativo && (
              <button
                type="button"
                data-testid="region-bar-comparativo-btn"
                onClick={onOpenComparativo}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-red-600/20 text-zinc-100 hover:text-red-200 border border-red-500/35 text-xs font-bold transition cursor-pointer"
              >
                <BarChart3 className="w-3.5 h-3.5 text-red-400" />
                <span>Comparativo por Región</span>
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section
      data-testid="region-gate-selector"
      aria-label="Compuerta Ejecutiva de Selección de Sucursal Activa"
      className="max-w-5xl mx-auto my-4 rounded-2xl bg-zinc-900/95 border border-zinc-800 shadow-2xl overflow-hidden"
    >
      <div className="h-1 w-full bg-gradient-to-r from-red-700 via-red-500 to-red-700" />

      <div className="p-6 sm:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 border-b border-zinc-800 pb-5">
          <div className="space-y-2 max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-wider">
                <ShieldCheck className="w-3.5 h-3.5" />
                Gobernanza Zero-Mixing · 5 Regiones
              </span>
              <span className="px-2.5 py-0.5 rounded-md bg-zinc-950 border border-white/10 text-[11px] font-mono text-zinc-300">
                {effectiveRoleLabel}
                {effectiveEmail ? ` · ${effectiveEmail}` : ''}
              </span>
            </div>

            <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
              Selecciona la Sucursal Activa a Operar o Auditar
            </h2>
            <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed">
              Por política de integridad contable y operativa de <strong>CODIZULCA C.A.</strong>,
              las carteras de clientes, rutas de promotoras, cronogramas de degustación, stock POP y
              requisiciones <code>MP-07-XXXX</code> nunca se mezclan entre ciudades. Al elegir una
              sucursal se inyecta el contexto regional aislado (<code>x-sucursal-activa</code>) y se
              purga cualquier caché previo en memoria.
            </p>
          </div>

          {onOpenComparativo && (
            <button
              type="button"
              data-testid="region-gate-comparativo-btn"
              onClick={onOpenComparativo}
              className="shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-950 hover:bg-red-600 text-white border border-red-500/45 hover:border-red-500 text-xs font-bold transition shadow-md cursor-pointer"
            >
              <BarChart3 className="w-4 h-4 text-red-400" />
              <span>Ver Comparativo Consolidado por Región (Solo Lectura)</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {effectiveRegiones.map((reg) => {
            const isSelected = effectiveActiveSucursal === reg.codigo;
            const coverageText =
              HUB_COVERAGE_DESCRIPTIONS[reg.codigo] ||
              `Operación territorial aislada · Región ${reg.nombre}`;
            const cardTitle = /^sucursal\b/i.test(reg.nombre)
              ? reg.nombre
              : `Sucursal ${reg.nombre}`;

            return (
              <button
                key={reg.id || reg.codigo}
                type="button"
                data-testid={`region-gate-card-${reg.codigo}`}
                onClick={() => handleChooseSucursal(reg.codigo)}
                className={`group text-left p-4 rounded-2xl border transition-all flex flex-col justify-between gap-4 cursor-pointer ${
                  isSelected
                    ? 'bg-red-950/35 border-red-500 shadow-[0_0_24px_-6px_rgba(220,38,38,0.55)]'
                    : 'bg-zinc-950/90 border-zinc-800 hover:border-red-500/60 hover:bg-zinc-900'
                }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-500/15 text-red-300 border border-red-500/30 text-[10px] font-mono font-bold">
                      {reg.codigo}
                    </span>
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center border transition ${
                        isSelected
                          ? 'bg-red-600 text-white border-red-400'
                          : 'bg-zinc-900 text-zinc-300 border-white/10 group-hover:text-red-400 group-hover:border-red-500/40'
                      }`}
                    >
                      <Building2 className="w-4 h-4" />
                    </div>
                  </div>

                  <div>
                    <h3 className="text-base font-extrabold text-white group-hover:text-red-200 transition">
                      {cardTitle}
                    </h3>
                    <p className="text-[11px] text-zinc-400 mt-1 leading-snug">
                      {coverageText}
                    </p>
                  </div>
                </div>

                <div className="pt-2.5 border-t border-white/[0.06] flex items-center justify-between text-xs font-bold">
                  <span className={isSelected ? 'text-emerald-300' : 'text-red-400 group-hover:text-white'}>
                    {isSelected ? 'Sucursal Activa' : `Abrir ${reg.nombre}`}
                  </span>
                  <CheckCircle2
                    className={`w-4 h-4 ${
                      isSelected
                        ? 'text-emerald-400'
                        : 'text-zinc-600 group-hover:text-red-400'
                    }`}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};
