import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCheck,
  CheckCircle2,
  CheckSquare,
  Clock,
  FileText,
  History,
  MapPin,
  Package,
  Play,
  RefreshCw,
  Route as RouteIcon,
  Search,
  Store,
  Tag,
  Users,
  X,
} from 'lucide-react';
import type { RutaPromotoraRecord } from '../../types/degustacionesPipeline';
import {
  savePortalActiveStore,
  updatePortalRutaProgress,
  type PortalPromotoraContext,
} from '../../services/promotoraCampoService';
import {
  extractUnitFromObservations,
  formatQuantityWithUnit,
} from '../../utils/productQuantityUnit';

interface PortalRutaTabProps {
  context: PortalPromotoraContext;
  routes: RutaPromotoraRecord[];
  isLoading: boolean;
  isRefreshing: boolean;
  isSuperAdminMode: boolean;
  onRefresh: () => void;
  onRouteUpdated: (updated: RutaPromotoraRecord) => void;
  onStartRouteStep: (ruta: RutaPromotoraRecord) => void;
  onCompleteRouteStep: (ruta: RutaPromotoraRecord) => void;
  onOpenIncidencia: (ruta: RutaPromotoraRecord) => void;
  onJumpToModule: (
    target: 'asistencia' | 'inventario' | 'precios',
    storeName: string
  ) => void;
  onNotify: (msg: string) => void;
}

type StatusKpiFilter = 'all' | 'ASIGNADA' | 'EN_CURSO' | 'COMPLETADA';

export const PortalRutaTab: React.FC<PortalRutaTabProps> = ({
  context,
  routes,
  isLoading,
  isRefreshing,
  isSuperAdminMode,
  onRefresh,
  onRouteUpdated,
  onStartRouteStep,
  onCompleteRouteStep,
  onOpenIncidencia,
  onJumpToModule,
  onNotify,
}) => {
  const [viewMode, setViewMode] = useState<'actual' | 'historial'>('actual');
  const [statusFilter, setStatusFilter] = useState<StatusKpiFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRoute, setSelectedRoute] = useState<RutaPromotoraRecord | null>(null);
  const [isUpdatingSamples, setIsUpdatingSamples] = useState(false);

  const kpis = useMemo(() => {
    const total = routes.length;
    const prog = routes.filter((r) => r.estado_ruta === 'ASIGNADA').length;
    const enCurso = routes.filter((r) => r.estado_ruta === 'EN_CURSO').length;
    const listas = routes.filter((r) => r.estado_ruta === 'COMPLETADA').length;
    return { total, prog, enCurso, listas };
  }, [routes]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return routes.filter((r) => {
      if (statusFilter !== 'all') {
        if (r.estado_ruta !== statusFilter) return false;
      } else if (viewMode === 'actual') {
        if (r.estado_ruta === 'COMPLETADA') return false;
      } else {
        if (r.estado_ruta !== 'COMPLETADA') return false;
      }
      if (!q) return true;
      return (
        String(r.cliente_nombre || '').toLowerCase().includes(q) ||
        String(r.producto_resumen || '').toLowerCase().includes(q) ||
        String(r.zona_direccion || '').toLowerCase().includes(q) ||
        String(r.promotora_nombre || '').toLowerCase().includes(q) ||
        String(r.observaciones || '').toLowerCase().includes(q) ||
        String(r.fecha || '').toLowerCase().includes(q)
      );
    });
  }, [routes, searchQuery, statusFilter, viewMode]);

  const getDelivered = (r: RutaPromotoraRecord): number =>
    Number((r as RutaPromotoraRecord & { muestras_entregadas?: number }).muestras_entregadas ?? 0);
  const getTarget = (r: RutaPromotoraRecord): number =>
    Math.max(
      1,
      Number(
        (r as RutaPromotoraRecord & { meta_muestras?: number }).meta_muestras ??
          r.personas_estimadas ??
          150
      )
    );

  const handleAddSamples = async (ruta: RutaPromotoraRecord, delta: number) => {
    if (isUpdatingSamples) return;
    setIsUpdatingSamples(true);
    try {
      const nextSamples = getDelivered(ruta) + delta;
      const updated = await updatePortalRutaProgress({
        rutaId: ruta.id,
        muestrasEntregadas: nextSamples,
        estadoRuta: ruta.estado_ruta === 'ASIGNADA' ? 'EN_CURSO' : undefined,
      });
      onRouteUpdated(updated);
      setSelectedRoute(updated);
      onNotify(`+${delta} muestras registradas (${nextSamples} acumuladas)`);
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'No se pudieron actualizar las muestras entregadas.'
      );
    } finally {
      setIsUpdatingSamples(false);
    }
  };

  return (
    <div className="space-y-3.5 pb-6" data-testid="portal-ruta-tab">
      {/* 1. 4 Tarjetas KPI clickables (Paridad exacta con CampoRuta.tsx) */}
      <div className="grid grid-cols-4 gap-1.5">
        {(
          [
            { id: 'all', label: 'Total', value: kpis.total, accent: 'text-white' },
            { id: 'ASIGNADA', label: 'Prog.', value: kpis.prog, accent: 'text-sky-400' },
            { id: 'EN_CURSO', label: 'En Curso', value: kpis.enCurso, accent: 'text-amber-400' },
            { id: 'COMPLETADA', label: 'Listas', value: kpis.listas, accent: 'text-emerald-400' },
          ] as const
        ).map((kpi) => {
          const active = statusFilter === kpi.id;
          return (
            <button
              key={kpi.id}
              type="button"
              data-testid={`ruta-kpi-${kpi.id}`}
              onClick={() => {
                setStatusFilter(kpi.id);
                if (kpi.id === 'COMPLETADA') setViewMode('historial');
                else if (kpi.id !== 'all') setViewMode('actual');
              }}
              className={`rounded-2xl p-2.5 border text-center transition-all cursor-pointer ${
                active
                  ? 'bg-red-600/20 border-red-500 shadow-lg shadow-red-950/40'
                  : 'bg-[#0d0d0d] border-neutral-800 hover:border-neutral-700'
              }`}
            >
              <span className={`text-lg font-black font-mono block leading-none ${kpi.accent}`}>
                {kpi.value}
              </span>
              <span className="text-[9px] font-bold uppercase tracking-wider text-neutral-400 mt-1 block">
                {kpi.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* 2. Sub-pestañas Ruta Actual vs Historial + Buscador */}
      <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-3 space-y-2.5 shadow-xl">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-testid="ruta-tab-actual"
            onClick={() => {
              setViewMode('actual');
              setStatusFilter('all');
            }}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              viewMode === 'actual' && statusFilter !== 'COMPLETADA'
                ? 'bg-red-600 text-white shadow-md shadow-red-600/25'
                : 'bg-[#171717] text-neutral-400 hover:text-white'
            }`}
          >
            <RouteIcon className="w-3.5 h-3.5" />
            <span>Ruta Actual ({kpis.prog + kpis.enCurso})</span>
          </button>
          <button
            type="button"
            data-testid="ruta-tab-historial"
            onClick={() => {
              setViewMode('historial');
              setStatusFilter('all');
            }}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              viewMode === 'historial' || statusFilter === 'COMPLETADA'
                ? 'bg-red-600 text-white shadow-md shadow-red-600/25'
                : 'bg-[#171717] text-neutral-400 hover:text-white'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>Historial ({kpis.listas})</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              data-testid="ruta-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar PDV, producto, zona o fecha..."
              className="w-full bg-[#171717] border border-neutral-800 focus:border-red-500 rounded-xl pl-8 pr-8 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Limpiar búsqueda de ruta"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            title="Sincronizar ruta desde Supabase"
            className="p-2 rounded-xl bg-[#171717] hover:bg-neutral-800 border border-neutral-800 text-neutral-300 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 text-emerald-400 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 3. Listado de Tarjetas de Degustación */}
      {isLoading ? (
        <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-8 text-center text-xs text-neutral-400 font-mono">
          Sincronizando degustaciones asignadas...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-[#0d0d0d] border border-neutral-800 rounded-2xl p-8 text-center space-y-2">
          <Store className="w-8 h-8 text-neutral-600 mx-auto" />
          <p className="text-xs font-bold text-neutral-300">
            No hay degustaciones en esta vista ({context.region}).
          </p>
          <p className="text-[11px] text-neutral-500">
            Puedes cambiar entre Ruta Actual / Historial o registrar directamente tu Asistencia o
            Inventario desde la barra de pestañas.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((item) => {
            const delivered = getDelivered(item);
            const target = getTarget(item);
            const progressPct = Math.min(100, Math.round((delivered / target) * 100));
            const obsMeta = extractUnitFromObservations(item.observaciones);
            const assignedQty = Number(item.cantidad_kilos || 0);
            return (
              <article
                key={item.id}
                data-testid={`portal-ruta-card-${item.id}`}
                className="bg-[#121212] border border-white/10 rounded-2xl overflow-hidden shadow-xl"
              >
                <div className="p-3.5 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[10px] font-mono text-zinc-400 font-bold block">
                        {item.fecha} • {item.turno} ({item.hora_inicio}–{item.hora_fin})
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                        <h3 className="text-xs font-black text-white leading-snug truncate">
                          {item.producto_resumen}
                        </h3>
                        {assignedQty > 0 && (
                          <span className="px-1.5 py-0.5 rounded-md bg-zinc-900 border border-white/10 text-[9px] font-mono font-bold text-zinc-200 shrink-0">
                            {formatQuantityWithUnit(assignedQty, obsMeta.unit ?? 'UNIDAD')}
                          </span>
                        )}
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-lg text-[9px] font-black uppercase font-mono shrink-0 ${
                        item.estado_ruta === 'EN_CURSO'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : item.estado_ruta === 'COMPLETADA'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                            : 'bg-zinc-800 text-zinc-300 border border-white/10'
                      }`}
                    >
                      {item.estado_ruta === 'EN_CURSO'
                        ? 'En Curso'
                        : item.estado_ruta === 'COMPLETADA'
                          ? 'Completada'
                          : 'Programada'}
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <Store className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-white text-xs truncate">{item.cliente_nombre}</p>
                      <p className="text-[10px] text-zinc-400 truncate">
                        {item.zona_direccion || context.region}
                      </p>
                      {isSuperAdminMode && item.promotora_nombre && (
                        <p className="text-[10px] text-emerald-400 font-bold truncate mt-0.5 flex items-center gap-1">
                          <Users className="w-3 h-3 shrink-0" />
                          <span>Promotora: {item.promotora_nombre}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Barra de progreso de muestras */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-zinc-400">Muestras Entregadas</span>
                      <span className="font-mono font-bold text-white">
                        {delivered} / {target} ({progressPct}%)
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 rounded-full ${
                          item.estado_ruta === 'COMPLETADA'
                            ? 'bg-emerald-500'
                            : item.estado_ruta === 'EN_CURSO'
                              ? 'bg-amber-400'
                              : 'bg-red-600'
                        }`}
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Barra de Acciones */}
                <div className="bg-[#181818] px-3 py-2 border-t border-white/5 flex items-center justify-between gap-1.5">
                  <button
                    type="button"
                    data-testid={`ruta-details-btn-${item.id}`}
                    onClick={() => {
                      savePortalActiveStore(item.cliente_nombre);
                      setSelectedRoute(item);
                    }}
                    className="flex-1 py-1.5 px-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5 text-red-400" />
                    <span>Detalles</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onOpenIncidencia(item)}
                    className="py-1.5 px-2.5 rounded-xl bg-zinc-900 hover:bg-amber-950/60 border border-amber-500/30 text-amber-300 text-xs font-bold flex items-center gap-1 cursor-pointer"
                    title="Reportar incidencia en PDV"
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                  </button>

                  {item.estado_ruta !== 'COMPLETADA' && (
                    <button
                      type="button"
                      onClick={() =>
                        item.estado_ruta === 'EN_CURSO'
                          ? onCompleteRouteStep(item)
                          : onStartRouteStep(item)
                      }
                      className={`py-1.5 px-3 rounded-xl text-xs font-black flex items-center justify-center gap-1.5 shadow-md cursor-pointer ${
                        item.estado_ruta === 'EN_CURSO'
                          ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                          : 'bg-red-600 hover:bg-red-500 text-white'
                      }`}
                    >
                      {item.estado_ruta === 'EN_CURSO' ? (
                        <>
                          <CheckCheck className="w-3.5 h-3.5" />
                          <span>Completar</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5" />
                          <span>Iniciar</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* 4. Modal de Especificaciones de Degustación (Paridad 100% CampoRuta.tsx) */}
      {selectedRoute && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
        >
          <div className="w-full max-w-lg bg-[#141414] border border-white/15 rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="p-4 border-b border-white/10 flex items-start justify-between gap-3 bg-[#181818]">
              <div className="space-y-1">
                <span className="px-2 py-0.5 rounded bg-red-600 text-white font-black text-[9px] uppercase tracking-wider">
                  Especificación de Degustación
                </span>
                <h3 className="text-sm font-black text-white leading-snug">
                  {selectedRoute.producto_resumen}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedRoute(null)}
                className="w-8 h-8 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white flex items-center justify-center text-sm font-bold shrink-0 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-4 overflow-y-auto space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-[#1a1a1a] p-3 rounded-2xl border border-white/5 space-y-1">
                  <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                    Promotora Asignada
                  </span>
                  <p className="font-bold text-white">{selectedRoute.promotora_nombre}</p>
                </div>
                <div className="bg-[#1a1a1a] p-3 rounded-2xl border border-white/5 space-y-1">
                  <span className="text-[10px] text-zinc-400 uppercase font-bold block">
                    Estado
                  </span>
                  <span className="inline-block px-2 py-0.5 rounded-lg bg-zinc-800 text-white font-mono text-[10px] font-black uppercase">
                    {selectedRoute.estado_ruta}
                  </span>
                </div>
              </div>

              <div className="bg-[#1a1a1a] p-3 rounded-2xl border border-white/5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400 uppercase font-bold flex items-center gap-1">
                    <Store className="w-3.5 h-3.5 text-red-500" />
                    <span>Punto de Venta (PDV)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const st = selectedRoute.cliente_nombre;
                      setSelectedRoute(null);
                      onJumpToModule('asistencia', st);
                    }}
                    className="text-[10px] text-red-400 hover:text-red-300 font-bold flex items-center gap-0.5 underline cursor-pointer"
                  >
                    <span>Ir a Asistencia</span>
                    <ArrowUpRight className="w-3 h-3" />
                  </button>
                </div>
                <p className="font-bold text-white">{selectedRoute.cliente_nombre}</p>
                <p className="text-[11px] text-zinc-400 flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-red-400 shrink-0" />
                  <span>{selectedRoute.zona_direccion || context.region}</span>
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="bg-[#1a1a1a] p-3 rounded-2xl border border-white/5 space-y-1">
                  <span className="text-[10px] text-zinc-400 uppercase font-bold flex items-center gap-1">
                    <Package className="w-3 h-3 text-red-400" />
                    <span>Producto SKU</span>
                  </span>
                  <p className="font-bold text-white">{selectedRoute.producto_resumen}</p>
                  {Number(selectedRoute.cantidad_kilos || 0) > 0 && (
                    <span className="inline-block px-2 py-0.5 rounded-md bg-zinc-900 border border-white/10 text-[10px] font-mono font-bold text-zinc-200">
                      Asignado:{' '}
                      {formatQuantityWithUnit(
                        Number(selectedRoute.cantidad_kilos),
                        extractUnitFromObservations(selectedRoute.observaciones).unit ?? 'UNIDAD'
                      )}
                    </span>
                  )}
                </div>
                <div className="bg-[#1a1a1a] p-3 rounded-2xl border border-white/5 space-y-1">
                  <span className="text-[10px] text-zinc-400 uppercase font-bold flex items-center gap-1">
                    <Clock className="w-3 h-3 text-zinc-400" />
                    <span>Fecha & Horario</span>
                  </span>
                  <p className="font-mono font-bold text-white">
                    {selectedRoute.hora_inicio} – {selectedRoute.hora_fin}
                  </p>
                  <p className="text-[10px] text-zinc-400">{selectedRoute.fecha}</p>
                </div>
              </div>

              {/* Progreso + Botones rápidos +5 / +10 / +25 */}
              <div className="bg-[#1a1a1a] p-3 rounded-2xl border border-white/5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-zinc-400 uppercase font-bold flex items-center gap-1">
                    <CheckSquare className="w-3.5 h-3.5 text-red-400" />
                    <span>Progreso de Muestras</span>
                  </span>
                  <span className="font-mono font-bold text-white">
                    {getDelivered(selectedRoute)} / {getTarget(selectedRoute)} porciones
                  </span>
                </div>
                {selectedRoute.estado_ruta !== 'COMPLETADA' && (
                  <div className="pt-1 flex items-center gap-1.5">
                    <span className="text-[10px] text-zinc-400">Registrar entrega:</span>
                    {[5, 10, 25].map((delta) => (
                      <button
                        key={delta}
                        type="button"
                        disabled={isUpdatingSamples}
                        onClick={() => void handleAddSamples(selectedRoute, delta)}
                        className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-red-600 border border-white/10 text-white font-mono text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-50"
                      >
                        +{delta}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {(() => {
                const { cleanText } = extractUnitFromObservations(selectedRoute.observaciones);
                if (!cleanText) return null;
                return (
                  <div className="p-3 bg-red-950/20 border border-red-500/25 rounded-2xl space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wider text-red-400 block">
                      Indicaciones de Trade Marketing:
                    </span>
                    <p className="text-zinc-300 text-[11px] italic">&ldquo;{cleanText}&rdquo;</p>
                  </div>
                );
              })()}
            </div>

            <div className="p-3.5 bg-[#181818] border-t border-white/10 flex flex-wrap gap-2">
              {selectedRoute.estado_ruta !== 'COMPLETADA' ? (
                <button
                  type="button"
                  onClick={() => {
                    const target = selectedRoute;
                    setSelectedRoute(null);
                    if (target.estado_ruta === 'EN_CURSO') onCompleteRouteStep(target);
                    else onStartRouteStep(target);
                  }}
                  className={`flex-1 py-2.5 px-3 rounded-xl font-black text-xs flex items-center justify-center gap-1.5 cursor-pointer ${
                    selectedRoute.estado_ruta === 'EN_CURSO'
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      : 'bg-red-600 hover:bg-red-500 text-white'
                  }`}
                >
                  {selectedRoute.estado_ruta === 'EN_CURSO' ? (
                    <>
                      <CheckCheck className="w-4 h-4" />
                      <span>Marcar Completada</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      <span>Iniciar en PDV</span>
                    </>
                  )}
                </button>
              ) : (
                <div className="flex-1 py-2 px-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 text-center font-bold text-xs flex items-center justify-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Completada</span>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  const st = selectedRoute.cliente_nombre;
                  setSelectedRoute(null);
                  onJumpToModule('asistencia', st);
                }}
                className="py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
              >
                <CheckSquare className="w-3.5 h-3.5 text-red-500" />
                <span>Asistencia</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const st = selectedRoute.cliente_nombre;
                  setSelectedRoute(null);
                  onJumpToModule('precios', st);
                }}
                className="py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
              >
                <Tag className="w-3.5 h-3.5 text-amber-400" />
                <span>Precios</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const st = selectedRoute.cliente_nombre;
                  setSelectedRoute(null);
                  onJumpToModule('inventario', st);
                }}
                className="py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
              >
                <Package className="w-3.5 h-3.5 text-zinc-300" />
                <span>Inventario</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
