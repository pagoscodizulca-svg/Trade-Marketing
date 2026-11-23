import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Camera,
  CheckCircle2,
  DollarSign,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  BcvRateSnapshot,
  PriceAlertConfigRecord,
  PriceComparisonThreeBrands,
  PriceDropAlertRecord,
} from '../../types';
import type { AllowedRegionCode } from '../../utils/regionalSyncClassifier';
import { buildPriceEvolutionSeries } from '../../utils/bimonetaryPriceMath';
import { fetchOfficialBcvRate, saveManualBcvRate } from '../../services/bcvRateService';
import {
  fetchPriceAlertsBundle,
  resolveShelfTagPhotoSignedUrl,
  savePriceAlertConfig,
  updatePriceAlertStatus,
} from '../../services/priceAnalyticsService';
import { PriceEvolutionChart } from './PriceEvolutionChart';

type PriceRegionBucket = 'Occidente' | 'Centro' | 'Andes';
type PriceRegionFilter = 'TODAS' | 'ASSIGNED' | PriceRegionBucket;

export interface PriceComparisonReportSubTabProps {
  priceComparisons: PriceComparisonThreeBrands[];
  isStrictAdmin: boolean;
  isRegionalRestricted: boolean;
  assignedRegionCodes: AllowedRegionCode[];
  assignedRegions: string[];
  canSwitchAmongAssignedRegions: boolean;
  onNotify?: (message: string) => void;
  /** Override determinista opcional para pruebas SSR / unitarias */
  qaInitialState?: {
    bcvSnapshot?: BcvRateSnapshot | null;
    alertas?: PriceDropAlertRecord[];
    configs?: PriceAlertConfigRecord[];
  };
}

function normalizePriceRegionBucket(rawRegion?: string | null, rawZone?: string | null): PriceRegionBucket {
  const token = String(rawRegion || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
  if (
    token === 'ANDES' ||
    token === 'LOS ANDES' ||
    token === 'MERIDA' ||
    token === 'TACHIRA' ||
    token === 'TRUJILLO' ||
    token === 'BARINAS'
  ) {
    return 'Andes';
  }
  if (
    token === 'CENTRO' ||
    token === 'VALENCIA' ||
    token === 'CAPITAL' ||
    token === 'CARABOBO' ||
    token === 'ARAGUA'
  ) {
    return 'Centro';
  }
  if (token === 'OCCIDENTE' || token === 'ZULIA' || token === 'FALCON') {
    return 'Occidente';
  }
  const z = String(rawZone || '');
  if (/merida|mérida|tachira|táchira|san cristobal|trujillo|valera|barinas|andes/i.test(z)) {
    return 'Andes';
  }
  if (/valencia|carabobo|maracay|aragua|caracas|los guayos|tocuyito/i.test(z)) {
    return 'Centro';
  }
  return 'Occidente';
}

export const PriceComparisonReportSubTab: React.FC<PriceComparisonReportSubTabProps> = ({
  priceComparisons,
  isStrictAdmin,
  isRegionalRestricted,
  assignedRegionCodes,
  assignedRegions,
  canSwitchAmongAssignedRegions,
  onNotify,
  qaInitialState,
}) => {
  const allowedBuckets = useMemo<PriceRegionBucket[] | null>(() => {
    if (!isRegionalRestricted) return null;
    if (assignedRegionCodes.length === 0) return ['Occidente'];
    const out: PriceRegionBucket[] = [];
    for (const c of assignedRegionCodes) {
      const b: PriceRegionBucket = c === 'ANDES' ? 'Andes' : c === 'CENTRO' ? 'Centro' : 'Occidente';
      if (!out.includes(b)) out.push(b);
    }
    return out;
  }, [isRegionalRestricted, assignedRegionCodes]);

  const singleLockedBucket: PriceRegionBucket | null =
    isRegionalRestricted && allowedBuckets && allowedBuckets.length === 1 ? allowedBuckets[0] : null;
  const isMultiRegionScope = Boolean(
    isRegionalRestricted && canSwitchAmongAssignedRegions && allowedBuckets && allowedBuckets.length >= 2
  );
  const assignedLabel =
    assignedRegions.length > 0
      ? assignedRegions.join(' y ')
      : allowedBuckets
        ? allowedBuckets.join(' y ')
        : 'Mis Regiones';

  const defaultRegionFilter: PriceRegionFilter =
    singleLockedBucket ?? (isMultiRegionScope ? 'ASSIGNED' : 'TODAS');

  const [regionFilter, setRegionFilter] = useState<PriceRegionFilter>(() => defaultRegionFilter);
  const [cadenaFilter, setCadenaFilter] = useState<string>('TODAS');
  const [zonaFilter, setZonaFilter] = useState<string>('TODAS');
  const [productFilter, setProductFilter] = useState<string>('TODOS');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Widget BCV
  const [bcvSnapshot, setBcvSnapshot] = useState<BcvRateSnapshot | null>(
    qaInitialState?.bcvSnapshot ?? null
  );
  const [isRefreshingBcv, setIsRefreshingBcv] = useState<boolean>(false);
  const [manualBcvOpen, setManualBcvOpen] = useState<boolean>(false);
  const [manualBcvInput, setManualBcvInput] = useState<string>('');
  const [isSavingManualBcv, setIsSavingManualBcv] = useState<boolean>(false);
  const [bcvFeedback, setBcvFeedback] = useState<string | null>(null);

  // Alertas automáticas + configuración umbral X%
  const [alertas, setAlertas] = useState<PriceDropAlertRecord[]>(qaInitialState?.alertas ?? []);
  const [configs, setConfigs] = useState<PriceAlertConfigRecord[]>(
    qaInitialState?.configs ?? [
      { region: 'GLOBAL', umbral_caida_porcentaje: 10, ventana_dias: 30, activo: true },
    ]
  );
  const [loadingAlerts, setLoadingAlerts] = useState<boolean>(false);
  const [showAllAlerts, setShowAllAlerts] = useState<boolean>(false);
  const [busyAlertId, setBusyAlertId] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState<boolean>(false);
  const [cfgRegion, setCfgRegion] = useState<string>(() =>
    isStrictAdmin ? 'GLOBAL' : assignedRegionCodes[0] ?? 'OCCIDENTE'
  );
  const [cfgThreshold, setCfgThreshold] = useState<string>('10');
  const [cfgWindowDays, setCfgWindowDays] = useState<string>('30');
  const [isSavingCfg, setIsSavingCfg] = useState<boolean>(false);

  // Visor de foto firmada de hablador
  const [previewPhoto, setPreviewPhoto] = useState<{
    title: string;
    url: string;
  } | null>(null);
  const [loadingPhotoId, setLoadingPhotoId] = useState<string | null>(null);

  useEffect(() => {
    setRegionFilter(defaultRegionFilter);
  }, [defaultRegionFilter]);

  const loadBcvAndAlerts = useCallback(
    async (forceRefreshBcv = false) => {
      if (qaInitialState) return;
      setIsRefreshingBcv(true);
      setLoadingAlerts(true);
      try {
        const [bcvRes, alertsRes] = await Promise.all([
          fetchOfficialBcvRate({ forceRefresh: forceRefreshBcv }).catch(() => null),
          fetchPriceAlertsBundle().catch(() => null),
        ]);
        if (bcvRes) setBcvSnapshot(bcvRes);
        if (alertsRes) {
          setAlertas(alertsRes.alertas);
          setConfigs(alertsRes.configs);
          const matchingCfg =
            alertsRes.configs.find((c) => c.region === cfgRegion) ??
            alertsRes.configs.find((c) => c.region === 'GLOBAL');
          if (matchingCfg) {
            setCfgThreshold(String(matchingCfg.umbral_caida_porcentaje));
            setCfgWindowDays(String(matchingCfg.ventana_dias));
          }
        }
      } finally {
        setIsRefreshingBcv(false);
        setLoadingAlerts(false);
      }
    },
    [qaInitialState, cfgRegion]
  );

  useEffect(() => {
    void loadBcvAndAlerts(false);
  }, [loadBcvAndAlerts]);

  const handleManualBcvSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isStrictAdmin || isSavingManualBcv) return;
    const numeric = Number(manualBcvInput.replace(',', '.'));
    setIsSavingManualBcv(true);
    setBcvFeedback(null);
    try {
      const saved = await saveManualBcvRate({ tasaUsdVes: numeric });
      setBcvSnapshot(saved);
      setManualBcvOpen(false);
      setManualBcvInput('');
      const msg = `✓ Tasa BCV manual registrada (${saved.tasaUsdVes.toFixed(2)} Bs/USD · ${saved.fecha}).`;
      setBcvFeedback(msg);
      onNotify?.(msg);
    } catch (err) {
      setBcvFeedback(err instanceof Error ? err.message : 'No se pudo guardar la tasa manual.');
    } finally {
      setIsSavingManualBcv(false);
    }
  };

  const handleAlertStatusChange = async (
    id: string,
    estado: 'revisada' | 'descartada'
  ) => {
    setBusyAlertId(id);
    try {
      const updated = await updatePriceAlertStatus({ id, estado });
      setAlertas((prev) => prev.map((a) => (a.id === id ? updated : a)));
      onNotify?.(`✓ Alerta marcada como ${estado}.`);
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : 'No se pudo actualizar la alerta.');
    } finally {
      setBusyAlertId(null);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingCfg) return;
    const umbral = Number(cfgThreshold.replace(',', '.'));
    const dias = Number(cfgWindowDays);
    setIsSavingCfg(true);
    try {
      const saved = await savePriceAlertConfig({
        region: cfgRegion,
        umbralCaidaPorcentaje: umbral,
        ventanaDias: dias,
        activo: true,
      });
      setConfigs((prev) => {
        const exists = prev.some((c) => c.region === saved.region);
        return exists ? prev.map((c) => (c.region === saved.region ? saved : c)) : [...prev, saved];
      });
      setConfigOpen(false);
      onNotify?.(`✓ Umbral de alertas (${saved.region}) actualizado a ${saved.umbral_caida_porcentaje}%.`);
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : 'No se pudo guardar el umbral.');
    } finally {
      setIsSavingCfg(false);
    }
  };

  const handleOpenPhotoPreview = async (row: PriceComparisonThreeBrands) => {
    if (!row.photoStoragePath) return;
    setLoadingPhotoId(row.id);
    try {
      const signed = await resolveShelfTagPhotoSignedUrl(row.photoStoragePath);
      if (signed) {
        setPreviewPhoto({
          title: `${row.storeName} · ${row.ownProduct} (${row.date})`,
          url: signed,
        });
      } else {
        onNotify?.('No se pudo generar la URL firmada de la fotografía del hablador.');
      }
    } finally {
      setLoadingPhotoId(null);
    }
  };

  // Defensa en profundidad en UI: aislar filas a las regiones autorizadas
  const authorizedRows = useMemo(() => {
    if (!allowedBuckets) return priceComparisons;
    return priceComparisons.filter((row) =>
      allowedBuckets.includes(normalizePriceRegionBucket(row.region, row.zone))
    );
  }, [priceComparisons, allowedBuckets]);

  const authorizedAlerts = useMemo(() => {
    if (!allowedBuckets) return alertas;
    return alertas.filter((a) =>
      allowedBuckets.includes(normalizePriceRegionBucket(a.region, a.zona))
    );
  }, [alertas, allowedBuckets]);

  const cadenaOptions = useMemo(() => {
    const set = new Set<string>();
    authorizedRows.forEach((r) => {
      const c = String(r.cadena || '').trim();
      if (c) set.add(c);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [authorizedRows]);

  const zonaOptions = useMemo(() => {
    const set = new Set<string>();
    authorizedRows.forEach((r) => {
      const z = String(r.zone || '').trim();
      if (z) set.add(z);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [authorizedRows]);

  const productOptions = useMemo(() => {
    const set = new Set<string>();
    authorizedRows.forEach((r) => {
      const p = String(r.ownProduct || '').trim();
      if (p) set.add(p);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [authorizedRows]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return authorizedRows.filter((row) => {
      const bucket = normalizePriceRegionBucket(row.region, row.zone);
      if (regionFilter !== 'TODAS' && regionFilter !== 'ASSIGNED' && bucket !== regionFilter) {
        return false;
      }
      if (cadenaFilter !== 'TODAS' && String(row.cadena || '').trim() !== cadenaFilter) {
        return false;
      }
      if (zonaFilter !== 'TODAS' && String(row.zone || '').trim() !== zonaFilter) {
        return false;
      }
      if (productFilter !== 'TODOS' && String(row.ownProduct || '').trim() !== productFilter) {
        return false;
      }
      const ymd = String(row.date || '').slice(0, 10);
      if (dateFrom && ymd && ymd < dateFrom) return false;
      if (dateTo && ymd && ymd > dateTo) return false;
      if (!q) return true;
      return (
        row.storeName.toLowerCase().includes(q) ||
        String(row.cadena || '').toLowerCase().includes(q) ||
        row.zone.toLowerCase().includes(q) ||
        row.ownProduct.toLowerCase().includes(q) ||
        row.promotora.toLowerCase().includes(q) ||
        (row.competitorsList ?? []).some((c) => c.brand.toLowerCase().includes(q))
      );
    });
  }, [
    authorizedRows,
    regionFilter,
    cadenaFilter,
    zonaFilter,
    productFilter,
    dateFrom,
    dateTo,
    searchQuery,
  ]);

  const alertDropLookup = useMemo(() => {
    const map = new Map<string, number>();
    authorizedAlerts.forEach((a) => {
      const ymd = String(a.created_at || '').slice(0, 10);
      const key = `${ymd}|${String(a.marca_competidor || '').trim().toUpperCase()}`;
      map.set(key, Math.max(map.get(key) ?? 0, Number(a.caida_porcentaje) || 0));
    });
    return map;
  }, [authorizedAlerts]);

  const evolution = useMemo(
    () => buildPriceEvolutionSeries(filteredRows, alertDropLookup),
    [filteredRows, alertDropLookup]
  );

  const pendingAlerts = useMemo(
    () => authorizedAlerts.filter((a) => a.estado === 'pendiente'),
    [authorizedAlerts]
  );
  const displayedAlerts = showAllAlerts ? authorizedAlerts : pendingAlerts;

  const editableConfigRegions = useMemo(() => {
    if (isStrictAdmin) return ['GLOBAL', 'OCCIDENTE', 'CENTRO', 'ANDES'];
    return assignedRegionCodes.length > 0 ? assignedRegionCodes : ['OCCIDENTE'];
  }, [isStrictAdmin, assignedRegionCodes]);

  const activeThresholdDisplay = useMemo(() => {
    const match =
      configs.find((c) => !isStrictAdmin && assignedRegionCodes.includes(c.region as AllowedRegionCode)) ??
      configs.find((c) => c.region === 'GLOBAL') ??
      configs[0];
    return match ? `${match.umbral_caida_porcentaje}% (${match.ventana_dias}d)` : '10% (30d)';
  }, [configs, isStrictAdmin, assignedRegionCodes]);

  return (
    <div className="space-y-5" data-testid="price-comparison-report-subtab">
      {/* FILA SUPERIOR: WIDGET BCV + PANEL RESUMEN DE ALERTAS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Widget Tasa BCV Oficial */}
        <div
          data-testid="admin-bcv-widget"
          className="rounded-2xl bg-[#121215] border border-zinc-800 p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-red-600/20 border border-red-500/40 text-red-400 flex items-center justify-center">
                <DollarSign className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-extrabold text-white uppercase tracking-wider">
                  Tasa Oficial Diaria BCV
                </h4>
                <p className="text-[10px] text-zinc-400 font-mono">
                  Inmutabilidad histórica · Conversión automática Bs ↔ USD
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="btn-refresh-bcv"
                disabled={isRefreshingBcv}
                onClick={() => void loadBcvAndAlerts(true)}
                className="px-2.5 py-1.5 rounded-lg bg-black hover:bg-zinc-900 border border-zinc-700 text-[11px] font-bold text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-red-400 ${isRefreshingBcv ? 'animate-spin' : ''}`} />
                <span>Actualizar BCV</span>
              </button>
              {isStrictAdmin && (
                <button
                  type="button"
                  data-testid="btn-open-manual-bcv"
                  onClick={() => {
                    setManualBcvInput(bcvSnapshot ? String(bcvSnapshot.tasaUsdVes) : '');
                    setManualBcvOpen((v) => !v);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-red-600/20 hover:bg-red-600/35 border border-red-500/45 text-[11px] font-bold text-red-200 cursor-pointer"
                >
                  Contingencia Manual
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 bg-black/70 border border-zinc-800 rounded-xl px-3.5 py-2.5">
            <div>
              <span className="text-xl font-black font-mono text-white">
                {bcvSnapshot ? `${bcvSnapshot.tasaUsdVes.toFixed(2)} Bs/USD` : 'Sin tasa cargada'}
              </span>
              {bcvSnapshot && (
                <span className="ml-2 text-[10px] font-mono text-zinc-400">
                  Fecha: {bcvSnapshot.fecha}
                </span>
              )}
            </div>
            {bcvSnapshot && (
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
                  bcvSnapshot.isFallback
                    ? 'bg-amber-950/70 text-amber-300 border-amber-500/40'
                    : bcvSnapshot.fuente === 'MANUAL_ADMIN'
                      ? 'bg-sky-950/70 text-sky-300 border-sky-500/40'
                      : 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40'
                }`}
              >
                {bcvSnapshot.isFallback
                  ? 'Respaldo histórico'
                  : bcvSnapshot.fuente === 'MANUAL_ADMIN'
                    ? 'Manual Admin'
                    : 'BCV Oficial'}
              </span>
            )}
          </div>

          {bcvFeedback && <p className="text-[11px] text-zinc-300">{bcvFeedback}</p>}

          {isStrictAdmin && manualBcvOpen && (
            <form
              onSubmit={(e) => void handleManualBcvSubmit(e)}
              data-testid="manual-bcv-form"
              className="flex flex-wrap items-center gap-2 pt-1"
            >
              <input
                type="number"
                step="any"
                min={10.01}
                required
                value={manualBcvInput}
                onChange={(e) => setManualBcvInput(e.target.value)}
                placeholder="Tasa Bs/USD (ej. 92.45)"
                className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-black border border-zinc-700 text-xs font-mono text-white"
              />
              <button
                type="submit"
                disabled={isSavingManualBcv}
                className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-extrabold cursor-pointer disabled:opacity-50"
              >
                {isSavingManualBcv ? 'Guardando...' : 'Guardar Tasa'}
              </button>
            </form>
          )}
        </div>

        {/* Panel Resumen Alertas Automáticas (> X%) */}
        <div
          data-testid="price-alerts-panel"
          className="rounded-2xl bg-[#121215] border border-zinc-800 p-4 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-red-600/20 border border-red-500/40 text-red-400 flex items-center justify-center">
                <Bell className="w-4 h-4" />
              </div>
              <div>
                <h4 className="text-xs font-extrabold text-white uppercase tracking-wider flex items-center gap-2">
                  <span>Alertas de Caída de Competidores</span>
                  {pendingAlerts.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] font-mono">
                      {pendingAlerts.length}
                    </span>
                  )}
                </h4>
                <p className="text-[10px] text-zinc-400 font-mono">
                  Umbral activo: ≥ {activeThresholdDisplay} · Aislamiento RLS regional
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowAllAlerts((v) => !v)}
                className="px-2.5 py-1.5 rounded-lg bg-black hover:bg-zinc-900 border border-zinc-700 text-[11px] font-bold text-zinc-300 cursor-pointer"
              >
                {showAllAlerts ? 'Solo pendientes' : `Ver todas (${authorizedAlerts.length})`}
              </button>
              <button
                type="button"
                data-testid="btn-config-alert-threshold"
                onClick={() => setConfigOpen((v) => !v)}
                className="px-2.5 py-1.5 rounded-lg bg-black hover:bg-zinc-900 border border-zinc-700 text-[11px] font-bold text-white inline-flex items-center gap-1 cursor-pointer"
              >
                <Settings2 className="w-3.5 h-3.5 text-red-400" />
                <span>Umbral X%</span>
              </button>
            </div>
          </div>

          {configOpen && (
            <form
              onSubmit={(e) => void handleSaveConfig(e)}
              data-testid="price-alert-config-form"
              className="grid grid-cols-1 sm:grid-cols-4 gap-2 bg-black/80 border border-zinc-800 rounded-xl p-2.5 text-xs"
            >
              <select
                value={cfgRegion}
                onChange={(e) => {
                  const nextReg = e.target.value;
                  setCfgRegion(nextReg);
                  const found = configs.find((c) => c.region === nextReg);
                  if (found) {
                    setCfgThreshold(String(found.umbral_caida_porcentaje));
                    setCfgWindowDays(String(found.ventana_dias));
                  }
                }}
                aria-label="Región de configuración de umbral"
                className="px-2 py-1.5 rounded-lg bg-[#121215] border border-zinc-700 text-white font-bold"
              >
                {editableConfigRegions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <input
                type="number"
                step="0.5"
                min={0.5}
                max={95}
                required
                value={cfgThreshold}
                onChange={(e) => setCfgThreshold(e.target.value)}
                aria-label="Porcentaje umbral de caída"
                placeholder="Caída % (ej. 10)"
                className="px-2.5 py-1.5 rounded-lg bg-[#121215] border border-zinc-700 text-white font-mono"
              />
              <input
                type="number"
                min={1}
                max={365}
                required
                value={cfgWindowDays}
                onChange={(e) => setCfgWindowDays(e.target.value)}
                aria-label="Ventana de comparación en días"
                placeholder="Días (ej. 30)"
                className="px-2.5 py-1.5 rounded-lg bg-[#121215] border border-zinc-700 text-white font-mono"
              />
              <button
                type="submit"
                disabled={isSavingCfg}
                className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-extrabold cursor-pointer disabled:opacity-50"
              >
                {isSavingCfg ? 'Guardando...' : 'Guardar'}
              </button>
            </form>
          )}

          {loadingAlerts ? (
            <div className="flex items-center gap-2 text-xs text-zinc-400 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-red-400" />
              <span>Verificando alertas regionales...</span>
            </div>
          ) : displayedAlerts.length === 0 ? (
            <div className="rounded-xl bg-black/60 border border-zinc-800 px-3 py-2.5 text-xs text-zinc-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              <span>Sin alertas pendientes de caídas agresivas de competidores en tu alcance.</span>
            </div>
          ) : (
            <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
              {displayedAlerts.map((al) => (
                <div
                  key={al.id}
                  data-testid={`price-alert-row-${al.id}`}
                  className="rounded-xl bg-black/80 border border-red-500/35 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[10px] font-mono font-black">
                        -{Number(al.caida_porcentaje).toFixed(1)}%
                      </span>
                      <strong className="text-white">{al.marca_competidor}</strong>
                      <span className="text-zinc-400 truncate">en {al.store}</span>
                      <span className="text-[10px] font-mono text-zinc-500">({al.region})</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5 font-mono">
                      {al.producto_propio}: ${Number(al.precio_anterior_usd).toFixed(2)} →{' '}
                      <strong className="text-red-300">${Number(al.precio_actual_usd).toFixed(2)} USD</strong>
                    </p>
                  </div>

                  {al.estado === 'pendiente' ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={busyAlertId === al.id}
                        onClick={() => void handleAlertStatusChange(al.id, 'revisada')}
                        className="px-2 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold cursor-pointer"
                      >
                        Revisada
                      </button>
                      <button
                        type="button"
                        disabled={busyAlertId === al.id}
                        onClick={() => void handleAlertStatusChange(al.id, 'descartada')}
                        className="px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] font-bold cursor-pointer"
                      >
                        Descartar
                      </button>
                    </div>
                  ) : (
                    <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-400">
                      {al.estado}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* BARRA DE FILTROS REGIONALES + CADENA + ZONA + PRODUCTO + FECHAS */}
      <div className="rounded-2xl bg-zinc-950 border border-zinc-900 p-3.5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {singleLockedBucket ? (
              <span
                data-testid="prices-region-locked-badge"
                className="min-h-[34px] inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold bg-red-600/15 text-white border border-red-500/45"
              >
                <Lock className="w-3.5 h-3.5 text-red-500 shrink-0" />
                <span>Región: {singleLockedBucket}</span>
              </span>
            ) : isMultiRegionScope ? (
              <>
                <span
                  data-testid="prices-region-multiregion-badge"
                  className="min-h-[34px] inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold bg-red-600/15 text-white border border-red-500/45"
                >
                  <Lock className="w-3.5 h-3.5 text-red-500 shrink-0" />
                  <span>Regiones: {assignedLabel}</span>
                </span>
                {(
                  [
                    { id: 'ASSIGNED' as const, label: `${assignedLabel} (Mis Regiones)` },
                    ...(allowedBuckets ?? []).map((b) => ({ id: b, label: b })),
                  ]
                ).map((reg) => (
                  <button
                    key={reg.id}
                    type="button"
                    data-testid={`prices-region-${reg.id}`}
                    onClick={() => setRegionFilter(reg.id)}
                    className={`min-h-[34px] px-3 py-1 rounded-xl text-xs font-bold border transition cursor-pointer ${
                      regionFilter === reg.id
                        ? 'bg-red-600 text-white border-red-500'
                        : 'bg-black text-zinc-300 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    {reg.label}
                  </button>
                ))}
              </>
            ) : (
              (
                [
                  { id: 'TODAS' as const, label: 'Todas las Regiones' },
                  { id: 'Occidente' as const, label: 'Occidente' },
                  { id: 'Centro' as const, label: 'Centro / Valencia' },
                  { id: 'Andes' as const, label: 'Andes' },
                ] as const
              ).map((reg) => (
                <button
                  key={reg.id}
                  type="button"
                  data-testid={`prices-region-${reg.id}`}
                  onClick={() => setRegionFilter(reg.id)}
                  className={`min-h-[34px] px-3 py-1 rounded-xl text-xs font-bold border transition cursor-pointer ${
                    regionFilter === reg.id
                      ? 'bg-red-600 text-white border-red-500'
                      : 'bg-black text-zinc-300 border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  {reg.label}
                </button>
              ))
            )}
          </div>

          <div className="relative min-w-[200px] flex-1 sm:flex-initial">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar PDV, marca, producto..."
              aria-label="Buscar en comparativa de precios"
              className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={cadenaFilter}
            onChange={(e) => setCadenaFilter(e.target.value)}
            aria-label="Filtrar comparativa por cadena"
            className="min-h-[34px] px-2.5 py-1 rounded-xl bg-black border border-zinc-800 text-white"
          >
            <option value="TODAS">Todas las cadenas ({cadenaOptions.length})</option>
            {cadenaOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={zonaFilter}
            onChange={(e) => setZonaFilter(e.target.value)}
            aria-label="Filtrar comparativa por zona"
            className="min-h-[34px] px-2.5 py-1 rounded-xl bg-black border border-zinc-800 text-white"
          >
            <option value="TODAS">Todas las zonas ({zonaOptions.length})</option>
            {zonaOptions.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>

          <select
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value)}
            aria-label="Filtrar comparativa por producto"
            className="min-h-[34px] px-2.5 py-1 rounded-xl bg-black border border-zinc-800 text-white max-w-[220px]"
          >
            <option value="TODOS">Todos los productos ({productOptions.length})</option>
            {productOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Fecha desde comparativa"
              className="min-h-[34px] px-2.5 py-1 rounded-xl bg-black border border-zinc-800 font-mono text-white"
            />
            <span className="text-zinc-500">a</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="Fecha hasta comparativa"
              className="min-h-[34px] px-2.5 py-1 rounded-xl bg-black border border-zinc-800 font-mono text-white"
            />
          </div>
        </div>
      </div>

      {/* GRÁFICA HISTÓRICA DE EVOLUCIÓN DE PRECIOS */}
      <PriceEvolutionChart
        dates={evolution.dates}
        series={evolution.series}
        subtitle={`Filtros activos: ${cadenaFilter === 'TODAS' ? 'Todas las cadenas' : cadenaFilter} · ${zonaFilter === 'TODAS' ? 'Todas las zonas' : zonaFilter} · ${filteredRows.length} captura(s)`}
      />

      {/* TABLA DETALLADA BIMONETARIA */}
      <div className="rounded-2xl bg-[#121215] border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <h4 className="text-xs font-extrabold uppercase tracking-wider text-white">
            Historial Bimonetario de Comparativa ({filteredRows.length})
          </h4>
          <span className="text-[10px] font-mono text-zinc-400">
            Valores normalizados con tasa BCV snapshot del día de captura
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="table-price-comparisons">
            <thead>
              <tr className="border-b border-zinc-800 text-[10px] uppercase font-mono text-zinc-400 bg-black/50">
                <th className="px-3 py-2.5">Fecha & PDV</th>
                <th className="px-3 py-2.5">Producto Propio</th>
                <th className="px-3 py-2.5">Precio Propio</th>
                <th className="px-3 py-2.5">Competencia (USD Norm.)</th>
                <th className="px-3 py-2.5">Brecha</th>
                <th className="px-3 py-2.5">BCV Snapshot</th>
                <th className="px-3 py-2.5 text-right">Soporte</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-zinc-500">
                    No existen registros de comparativa de precios para los filtros seleccionados.
                  </td>
                </tr>
              ) : (
                filteredRows.slice(0, 150).map((row) => {
                  const gap = Number(row.gapPercent ?? 0);
                  const comps = (row.competitorsList ?? []).filter((c) => c.priceUsd > 0);
                  return (
                    <tr key={row.id} className="hover:bg-black/40">
                      <td className="px-3 py-2.5">
                        <div className="font-bold text-white">{row.storeName}</div>
                        <div className="text-[10px] font-mono text-zinc-400">
                          {row.date} · {row.cadena || row.zone} · {row.region || 'Occidente'}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-white">{row.ownProduct}</div>
                        <div className="text-[10px] text-zinc-400 inline-flex items-center gap-1.5">
                          <span>{row.promotora}</span>
                          {row.ocrAsistido && (
                            <span className="px-1.5 py-0.2 rounded bg-red-600/20 border border-red-500/40 text-red-300 text-[9px] font-mono inline-flex items-center gap-0.5">
                              <Sparkles className="w-2.5 h-2.5" />
                              IA
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono">
                        <div className="font-bold text-emerald-400">
                          ${row.ownPriceUsd.toFixed(2)} USD
                        </div>
                        <div className="text-[10px] text-zinc-400">
                          Orig: {row.ownCurrency === 'VES' ? 'Bs.' : '$'}{' '}
                          {(row.ownOriginalPrice ?? row.ownPriceUsd).toFixed(2)}{' '}
                          ({row.ownCurrency ?? 'USD'})
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {comps.length === 0 ? (
                          <span className="text-zinc-500">—</span>
                        ) : (
                          <div className="space-y-1">
                            {comps.map((c, idx) => (
                              <div key={idx} className="text-[11px] font-mono">
                                <span className="text-amber-300 font-bold">{c.brand}:</span>{' '}
                                <span className="text-white">${c.priceUsd.toFixed(2)}</span>
                                {c.currency === 'VES' && c.originalPrice ? (
                                  <span className="text-zinc-500 text-[10px] ml-1">
                                    (Bs.{c.originalPrice.toFixed(0)})
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono">
                        {comps.length > 0 ? (
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                              gap <= 0
                                ? 'bg-emerald-950/70 text-emerald-300 border-emerald-500/40'
                                : 'bg-rose-950/70 text-rose-300 border-rose-500/40'
                            }`}
                          >
                            {gap > 0 ? `+${gap.toFixed(1)}%` : `${gap.toFixed(1)}%`}
                          </span>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-zinc-300">
                        {row.bcvRate ? `${row.bcvRate.toFixed(2)} Bs` : '—'}
                        {row.bcvRateDate && (
                          <div className="text-[9px] text-zinc-500">{row.bcvRateDate}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {row.photoStoragePath ? (
                          <button
                            type="button"
                            disabled={loadingPhotoId === row.id}
                            onClick={() => void handleOpenPhotoPreview(row)}
                            className="px-2 py-1 rounded-lg bg-black hover:bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] font-bold inline-flex items-center gap-1 cursor-pointer"
                          >
                            {loadingPhotoId === row.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Camera className="w-3 h-3 text-red-400" />
                            )}
                            <span>Fleje</span>
                          </button>
                        ) : (
                          <span className="text-[10px] text-zinc-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal visor de foto de hablador */}
      {previewPhoto && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Fotografía del hablador de precio"
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4"
          onClick={() => setPreviewPhoto(null)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl bg-[#121215] border border-zinc-700 p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h5 className="text-xs font-extrabold text-white truncate">{previewPhoto.title}</h5>
              <button
                type="button"
                onClick={() => setPreviewPhoto(null)}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <img
              src={previewPhoto.url}
              alt={previewPhoto.title}
              className="w-full max-h-[70vh] object-contain rounded-xl bg-black border border-zinc-800"
            />
          </div>
        </div>
      )}
    </div>
  );
};
