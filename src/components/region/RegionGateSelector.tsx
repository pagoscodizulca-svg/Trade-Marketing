import React from 'react';
import {
  BarChart3,
  Building2,
  CheckCircle2,
  Globe2,
  Lock,
  MapPin,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useOptionalApp } from '../../context/AppContext';
import {
  DEFAULT_OFFICIAL_REGIONES,
  type ActiveRegionItem,
} from '../../services/regionesService';
import {
  MANAGED_USER_ROLE_LABELS,
  type OperativeSucursal,
} from '../../services/userManagementService';
import {
  normalizeRegionName,
  type AllowedRegionCode,
} from '../../utils/regionalSyncClassifier';

export type RegionSelectorChoice = AllowedRegionCode | OperativeSucursal | 'ALL';

export interface RegionGateSelectorProps {
  mode?: 'gate' | 'bar';
  regiones?: readonly ActiveRegionItem[];
  activeSucursal?: RegionSelectorChoice | null;
  canSwitchSucursal?: boolean;
  userRoleLabel?: string;
  userEmail?: string;
  onSelectSucursal?: (sucursal: OperativeSucursal) => void;
  onSelectRegion?: (region: AllowedRegionCode | 'ALL') => void;
  onOpenComparativo?: () => void;
}

const REGION_COVERAGE_DESCRIPTIONS: Record<string, string> = {
  OCCIDENTE: 'Prioridad 1 · Zulia (Maracaibo, San Francisco, Cabimas, COL) · Falcón · Trujillo',
  CENTRO: 'Prioridad 2 · Carabobo (Valencia) · Aragua (Maracay) · Distrito Capital (Caracas)',
  ANDES: 'Prioridad 3 · Eje Andino · Mérida · Táchira · Barinas',
  ZULIA: 'Región Occidente · Zulia · Falcón',
  VALENCIA: 'Región Centro · Carabobo · Valencia',
  ORIENTE: 'Cobertura Oriental',
  CAPITAL: 'Región Centro · Distrito Capital',
};

const OFFICIAL_DISPLAY_NAMES: Record<AllowedRegionCode, string> = {
  OCCIDENTE: 'Región OCCIDENTE',
  CENTRO: 'Región CENTRO',
  ANDES: 'Región ANDES',
};

function resolveRegionDisplayName(
  selected: RegionSelectorChoice | null | undefined,
  regiones: readonly ActiveRegionItem[]
): string {
  if (!selected || selected === 'ALL') return 'Todas las Regiones';
  const official = normalizeRegionName(selected);
  if (official) {
    return OFFICIAL_DISPLAY_NAMES[official];
  }
  const matched = regiones.find((r) => r.codigo === selected);
  if (matched) {
    return `Región ${matched.nombre}`;
  }
  return `Región ${selected}`;
}

function mapRegionChoiceToLegacySucursal(choice: RegionSelectorChoice): OperativeSucursal {
  if (choice === 'OCCIDENTE' || choice === 'ZULIA') return 'ZULIA';
  if (choice === 'CENTRO' || choice === 'VALENCIA' || choice === 'CAPITAL') return 'CENTRO';
  if (choice === 'ORIENTE') return 'ORIENTE';
  // ANDES usa OCCIDENTE/ZULIA solo como código de compatibilidad en callbacks legados
  return 'ZULIA';
}

export const RegionGateSelector: React.FC<RegionGateSelectorProps> = ({
  mode = 'gate',
  regiones,
  activeSucursal,
  canSwitchSucursal,
  userRoleLabel,
  userEmail,
  onSelectSucursal,
  onSelectRegion,
  onOpenComparativo,
}) => {
  const appCtx = useOptionalApp();

  const effectiveRegiones: readonly ActiveRegionItem[] =
    regiones && regiones.length > 0
      ? regiones
      : appCtx?.activeRegiones && appCtx.activeRegiones.length > 0
        ? appCtx.activeRegiones
        : DEFAULT_OFFICIAL_REGIONES;

  const effectiveSelection: RegionSelectorChoice | null =
    activeSucursal !== undefined
      ? activeSucursal
      : appCtx?.activeRegionScope ?? (appCtx?.activeSucursal ?? null);

  const effectiveCanSwitch: boolean =
    canSwitchSucursal !== undefined
      ? canSwitchSucursal
      : (appCtx?.canSwitchSucursal ?? true);

  const effectiveRoleLabel: string =
    userRoleLabel ??
    (appCtx?.verifiedIamRole ? MANAGED_USER_ROLE_LABELS[appCtx.verifiedIamRole] : undefined) ??
    'Dirección Corporativa';

  const effectiveEmail: string = userEmail ?? appCtx?.currentUser?.email ?? '';

  const handleChooseRegion = (choice: RegionSelectorChoice) => {
    if (!effectiveCanSwitch) return;
    const official = choice === 'ALL' ? 'ALL' : normalizeRegionName(choice);
    if (onSelectRegion && official) {
      onSelectRegion(official);
      return;
    }
    if (onSelectSucursal && choice !== 'ALL') {
      onSelectSucursal(mapRegionChoiceToLegacySucursal(choice));
      return;
    }
    if (appCtx?.setActiveRegionScope && official) {
      appCtx.setActiveRegionScope(official);
      return;
    }
    if (choice !== 'ALL') {
      appCtx?.setActiveSucursal(mapRegionChoiceToLegacySucursal(choice));
    }
  };

  if (mode === 'bar') {
    const activeDisplayLabel = resolveRegionDisplayName(effectiveSelection, effectiveRegiones);
    const activeOfficialCode =
      effectiveSelection === 'ALL'
        ? 'ALL'
        : effectiveSelection
          ? normalizeRegionName(effectiveSelection) ?? effectiveSelection
          : null;

    if (!effectiveCanSwitch) {
      return (
        <div
          data-testid="region-bar-selector"
          className="bg-zinc-950/95 border-b border-white/[0.07] no-print"
        >
          <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div
              data-testid="region-bar-locked-badge"
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-900 border border-red-500/40 text-white font-semibold"
            >
              <Lock className="w-3.5 h-3.5 text-red-500 shrink-0" />
              <span>Región asignada por correo: {activeDisplayLabel}</span>
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
                activeOfficialCode
                  ? 'bg-red-600/15 text-white border-red-500/45'
                  : 'bg-zinc-900 text-zinc-300 border-zinc-700'
              }`}
            >
              <MapPin className="w-3.5 h-3.5 text-red-500 shrink-0" />
              <span>
                Región Activa: {activeOfficialCode ? activeDisplayLabel : 'Todas las Regiones'}
              </span>
            </span>

            {/* Selector rápido por botones para Todas + las 3 regiones reales ("Regiones") */}
            <div
              className="hidden lg:inline-flex items-center gap-1 p-0.5 rounded-xl bg-zinc-900 border border-white/10"
              role="group"
              aria-label="Cambio rápido de región activa"
            >
              <button
                type="button"
                data-testid="region-bar-btn-ALL"
                onClick={() => handleChooseRegion('ALL')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                  activeOfficialCode === 'ALL'
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-800'
                }`}
              >
                Todas las Regiones
              </button>
              {effectiveRegiones.map((reg) => {
                const isSelected = activeOfficialCode === reg.codigo;
                return (
                  <button
                    key={reg.id || reg.codigo}
                    type="button"
                    data-testid={`region-bar-btn-${reg.codigo}`}
                    onClick={() => handleChooseRegion(reg.codigo)}
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

            {/* Selector desplegable accesible en pantallas pequeñas */}
            <select
              aria-label="Seleccionar Región Activa"
              data-testid="region-bar-select"
              value={activeOfficialCode ?? 'ALL'}
              onChange={(e) => {
                const val = e.target.value as RegionSelectorChoice;
                if (val) handleChooseRegion(val);
              }}
              className="lg:hidden px-2.5 py-1 rounded-xl bg-zinc-900 border border-white/15 text-xs font-bold text-white focus:outline-none focus:border-red-500 cursor-pointer"
            >
              <option value="ALL" className="bg-zinc-900 text-white">
                Todas las Regiones
              </option>
              {effectiveRegiones.map((reg) => (
                <option
                  key={reg.id || reg.codigo}
                  value={reg.codigo}
                  className="bg-zinc-900 text-white"
                >
                  {reg.label || `Región ${reg.nombre}`}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span className="hidden xl:inline-flex items-center gap-1.5 text-[11px] text-zinc-400 font-mono">
              <RefreshCw className="w-3 h-3 text-red-400 shrink-0" />
              <span>Fuente Única: &quot;Regiones&quot; (OCCIDENTE · CENTRO · ANDES)</span>
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
      aria-label="Compuerta Ejecutiva de Selección de Región Activa"
      className="max-w-5xl mx-auto my-4 rounded-2xl bg-zinc-900/95 border border-zinc-800 shadow-2xl overflow-hidden"
    >
      <div className="h-1 w-full bg-gradient-to-r from-red-700 via-red-500 to-red-700" />

      <div className="p-6 sm:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 border-b border-zinc-800 pb-5">
          <div className="space-y-2 max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-wider">
                <ShieldCheck className="w-3.5 h-3.5" />
                Gobernanza Zero-Mixing · 3 Regiones Oficiales
              </span>
              <span className="px-2.5 py-0.5 rounded-md bg-zinc-950 border border-white/10 text-[11px] font-mono text-zinc-300">
                {effectiveRoleLabel}
                {effectiveEmail ? ` · ${effectiveEmail}` : ''}
              </span>
            </div>

            <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
              Selecciona la Región Activa a Operar o Auditar
            </h2>
            <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed">
              Las carteras de clientes, rutas de promotoras, supervisores y catálogos territoriales
              de <strong>CODIZULCA C.A.</strong> se sincronizan directamente desde{' '}
              <code>public.&quot;Regiones&quot;</code> en Supabase (<strong>OCCIDENTE</strong>,{' '}
              <strong>CENTRO</strong> y <strong>ANDES</strong>) con aislamiento RLS estricto.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 shrink-0">
            <button
              type="button"
              data-testid="region-gate-card-ALL"
              onClick={() => handleChooseRegion('ALL')}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white border border-red-400 text-xs font-extrabold transition shadow-md cursor-pointer"
            >
              <Globe2 className="w-4 h-4" />
              <span>Todas las Regiones</span>
            </button>

            {onOpenComparativo && (
              <button
                type="button"
                data-testid="region-gate-comparativo-btn"
                onClick={onOpenComparativo}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-950 hover:bg-red-600 text-white border border-red-500/45 hover:border-red-500 text-xs font-bold transition shadow-md cursor-pointer"
              >
                <BarChart3 className="w-4 h-4 text-red-400" />
                <span>Ver Comparativo Consolidado por Región (Solo Lectura)</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {effectiveRegiones.map((reg) => {
            const isSelected = effectiveSelection === reg.codigo;
            const coverageText =
              REGION_COVERAGE_DESCRIPTIONS[reg.codigo] ||
              `Operación territorial aislada · Región ${reg.nombre}`;
            const cardTitle = `Región ${reg.nombre}`;

            return (
              <button
                key={reg.id || reg.codigo}
                type="button"
                data-testid={`region-gate-card-${reg.codigo}`}
                onClick={() => handleChooseRegion(reg.codigo)}
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
                      {reg.regi_saba ? ' · SÁB' : ''}
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
                  <span className={isSelected ? 'text-white' : 'text-red-400 group-hover:text-white'}>
                    {isSelected ? 'Región Activa' : `Abrir ${reg.nombre}`}
                  </span>
                  <CheckCircle2
                    className={`w-4 h-4 transition ${
                      isSelected ? 'text-red-400' : 'text-zinc-600 group-hover:text-red-400'
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
