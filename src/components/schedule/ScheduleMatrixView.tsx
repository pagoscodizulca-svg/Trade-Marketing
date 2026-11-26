import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../context/AppContext';
import { 
  Download, 
  Search, 
  FileSpreadsheet,
  Plus,
  Trash2,
  ExternalLink,
  Store as StoreIcon,
  Zap,
  Sun,
  Moon,
  CheckSquare,
  Square,
  Loader2,
  CheckCircle2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  BarChart3,
  RefreshCw,
  X,
} from 'lucide-react';
import { ShiftType } from '../../types';
import { ExportPdfButton } from '../common/ExportPdfButton';
import {
  exportScheduleMatrixPdf,
  exportMonthlyTastingGeneralReportPdf,
} from '../../utils/pdfExport';
import type { TastingScheduleItem } from '../field/FieldPromotoraView';
import { PrintSupportHeader, PrintSignatureBlock } from '../common/PrintSupportHeader';
import {
  SmartSearchCombobox,
  type SmartSearchComboboxOption,
} from '../common/SmartSearchCombobox';
import { OFFICIAL_TRADE_PRODUCTS_MAESTROS } from '../../data/officialTradeProductsCatalog';
import { AnimatedTabContainer } from '../ui/AnimatedTabContainer';
import {
  useLiveVenezuelaClock,
  getRollingWeekWindow,
  normalizeAnyDateToYmd,
} from '../../utils/weekCalendar';
import {
  formatToDdMmYyyy,
  matchesDateFilter,
  normalizeExcelDate,
} from '../../utils/excelDateNormalizer';
import {
  Metric360DashboardModal,
  Metric360Id,
  Metric360SwitcherItem,
} from '../common/Metric360DashboardModal';
import { canonicalStaffKey } from '../../services/supabaseModule1';
import {
  assignAcceptedDegustacionToPromotoraRoute,
  isValidUuid,
} from '../../services/degustacionesPipelineService';
import {
  MODULE2_PRODUCT_FILTER_OPTIONS,
  filterMatrixVisits,
  normalizeSearchText,
  resolveRealPromotoraForMatrix,
} from '../../services/scheduleMatrixService';

export const ScheduleMatrixView: React.FC = () => {
  const { 
    visits, 
    stores, 
    users,
    masterData,
    masterEntities,
    activeSucursal,
    activeSucursalLabel,
    activeRegionScope,
    assignedRegionCodes,
    isRegionalRestricted,
    module1Bundle,
    isCronogramaRealtimeConnected,
    updateVisitFromProductFill, 
    updateVisit, 
    addVisit, 
    deleteVisit,
    deleteVisitsByIds,
    batchFillClientsProductShift,
    clearVisitsBatch,
  } = useApp();

  const isCentroAndesOnlyCoordinator =
    isRegionalRestricted &&
    assignedRegionCodes.length > 0 &&
    !assignedRegionCodes.includes('OCCIDENTE');

  const liveClock = useLiveVenezuelaClock();
  const [selectedMetric360, setSelectedMetric360] = useState<Metric360Id | null>(null);

  const [isExportingMonthlyPdf, setIsExportingMonthlyPdf] = useState(false);
  const [monthlyPdfSuccess, setMonthlyPdfSuccess] = useState(false);

  const synchronizedMonthlyTastingItems = useMemo<TastingScheduleItem[]>(() => {
    const todayYmd = liveClock.todayYmd;
    const supMap = new Map<string, TastingScheduleItem>();
    (module1Bundle?.tastingItems || []).forEach((item) => supMap.set(item.id, item));

    const fromVisits: TastingScheduleItem[] = visits.map((v) => {
      const supItem = supMap.get(v.id);
      const isMorning = v.shift === 'MAÑANA';
      const totalUnits = v.plannedUnits || (v.mortadelaQty + v.espaldaQty + v.arrozQty) || supItem?.requestedQty || 1;
      const targetSamples = supItem?.targetSamples ?? 0;
      const enHistorial = Boolean(
        supItem?.enHistorial ??
          supItem?.isArchived ??
          v.enHistorial ??
          (!supItem && Boolean(v.date && v.date < todayYmd))
      );
      const isArchived = enHistorial;
      const status: TastingScheduleItem['status'] =
        v.status === 'COMPLETADA' || supItem?.status === 'COMPLETADO'
          ? 'COMPLETADO'
          : v.status === 'EN_CURSO' || supItem?.status === 'EN_CURSO'
            ? 'EN_CURSO'
            : supItem?.status === 'PENDIENTE' && v.status === 'PENDIENTE'
              ? 'PENDIENTE'
              : 'PROGRAMADO';

      return {
        id: v.id,
        date: v.date,
        dayLabel: v.dayLabel,
        shift: v.shift,
        timeRange: supItem?.timeRange || (isMorning ? '08:30 - 12:30' : '14:00 - 18:00'),
        activityTitle: supItem?.activityTitle || `Degustación ${v.productFocus}`,
        productName: v.productFocus || supItem?.productName || 'Portafolio Codizulca',
        responsibleName: v.promotoraName || supItem?.responsibleName || 'Sin Asignar',
        storeName: v.storeName,
        zone: v.zone,
        status,
        currentSamples: supItem?.currentSamples ?? 0,
        targetSamples,
        requestedQty: totalUnits,
        acceptancePercent: supItem?.acceptancePercent,
        sellerApplicant: supItem?.sellerApplicant || `${v.sellerName || 'SIN VENDEDOR'} (Vendedor FDV)`,
        isArchived,
        enHistorial,
        archivadoEn: supItem?.archivadoEn ?? v.archivadoEn ?? null,
        motivoArchivo: supItem?.motivoArchivo ?? v.motivoArchivo ?? null,
        notes: v.notes || supItem?.notes,
        rawComments: supItem?.rawComments,
      };
    });

    const visitIds = new Set(fromVisits.map((it) => it.id));
    const remainingSup = (module1Bundle?.tastingItems || []).filter((it) => !visitIds.has(it.id));
    return [...fromVisits, ...remainingSup];
  }, [visits, module1Bundle, liveClock.todayYmd]);

  // Filters for Table View + Motor de Semanas Automáticas
  const [selectedDay, setSelectedDay] = useState<string>('TODOS');
  const [matrixDateFrom, setMatrixDateFrom] = useState<string>('');
  const [matrixDateTo, setMatrixDateTo] = useState<string>('');
  const [tableWeekOffset, setTableWeekOffset] = useState<number>(0);
  const [selectedShift, setSelectedShift] = useState<string>('TODOS');
  const [selectedProduct, setSelectedProduct] = useState<string>('TODOS');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const tableRollingWeek = useMemo(
    () => getRollingWeekWindow(liveClock.todayYmd, tableWeekOffset),
    [liveClock.todayYmd, tableWeekOffset]
  );

  // Mapa rápido de conteo de registros por fecha YYYY-MM-DD para los chips semanales
  const visitsCountByYmd = useMemo(() => {
    const map = new Map<string, number>();
    visits.forEach((v) => {
      const ymd = normalizeAnyDateToYmd(v.date);
      if (ymd) map.set(ymd, (map.get(ymd) || 0) + 1);
    });
    return map;
  }, [visits]);

  const matchesSelectedDayFilter = (rawDate?: string, rawDayLabel?: string): boolean => {
    const parsedRecord = normalizeExcelDate(rawDate);

    if (matrixDateFrom.trim() || matrixDateTo.trim()) {
      return matchesDateFilter(
        rawDate,
        { desde: matrixDateFrom, hasta: matrixDateTo },
        parsedRecord.fechaTimestamp
      );
    }

    if (selectedDay === 'TODOS') return true;
    const ymd = parsedRecord.fechaIso;

    if (selectedDay === 'SEMANA_ACTUAL') {
      return matchesDateFilter(
        rawDate,
        {
          desde: liveClock.currentWeek.mondayYmd,
          hasta: liveClock.currentWeek.sundayYmd,
        },
        parsedRecord.fechaTimestamp
      );
    }
    if (selectedDay === 'SEMANA_NAV') {
      return matchesDateFilter(
        rawDate,
        {
          desde: tableRollingWeek.mondayYmd,
          hasta: tableRollingWeek.sundayYmd,
        },
        parsedRecord.fechaTimestamp
      );
    }
    if (selectedDay === 'MES_ACTUAL') {
      return Boolean(ymd && ymd.slice(0, 7) === liveClock.yearMonth);
    }
    if (/^\d{4}-\d{2}$/.test(selectedDay)) {
      return Boolean(ymd && ymd.slice(0, 7) === selectedDay);
    }
    const parsedSelectedSingle = normalizeExcelDate(selectedDay);
    if (parsedSelectedSingle.isValid) {
      return matchesDateFilter(
        rawDate,
        { fechaUnica: selectedDay },
        parsedRecord.fechaTimestamp
      );
    }
    return Boolean(
      rawDayLabel === selectedDay ||
        rawDate === selectedDay ||
        (rawDayLabel && rawDayLabel.includes(selectedDay))
    );
  };

  const filteredGlobalTastingItems = useMemo(() => {
    const q = normalizeSearchText(searchQuery);
    const prodFilter = normalizeSearchText(selectedProduct);
    return synchronizedMonthlyTastingItems.filter((item) => {
      if (!matchesSelectedDayFilter(item.date, item.dayLabel)) return false;
      if (selectedShift !== 'TODOS' && item.shift !== selectedShift) return false;
      if (selectedProduct !== 'TODOS' && prodFilter) {
        const pNorm = normalizeSearchText(item.productName || '');
        const matchesProd =
          prodFilter === 'vencampo'
            ? pNorm.includes('vencampo') || pNorm.includes('arroz')
            : pNorm.includes(prodFilter);
        if (!matchesProd) return false;
      }
      if (q) {
        const match =
          normalizeSearchText(item.storeName).includes(q) ||
          normalizeSearchText(item.zone).includes(q) ||
          normalizeSearchText(item.responsibleName).includes(q) ||
          normalizeSearchText(item.sellerApplicant).includes(q) ||
          normalizeSearchText(item.productName).includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [
    synchronizedMonthlyTastingItems,
    selectedDay,
    matrixDateFrom,
    matrixDateTo,
    tableRollingWeek,
    liveClock.currentWeek,
    liveClock.yearMonth,
    selectedShift,
    selectedProduct,
    searchQuery,
  ]);

  const activeMatrixFilterMeta = useMemo(() => {
    const parts: string[] = [];
    if (matrixDateFrom.trim() || matrixDateTo.trim()) {
      parts.push(`Rango: ${matrixDateFrom.trim() || 'Inicio'} a ${matrixDateTo.trim() || 'Hoy'}`);
    } else if (selectedDay === 'SEMANA_ACTUAL') {
      parts.push(`Semana Actual (${liveClock.currentWeek.rangeLabel})`);
    } else if (selectedDay === 'SEMANA_NAV') {
      parts.push(`Semana ${tableRollingWeek.isoWeekNumber} (${tableRollingWeek.rangeLabel})`);
    } else if (selectedDay === 'MES_ACTUAL') {
      parts.push(`Mes ${liveClock.yearMonth}`);
    } else if (selectedDay !== 'TODOS') {
      parts.push(`Dia: ${selectedDay}`);
    }
    if (selectedShift !== 'TODOS') parts.push(`Jornada: ${selectedShift}`);
    if (selectedProduct !== 'TODOS') parts.push(`Producto: ${selectedProduct}`);
    if (searchQuery.trim()) parts.push(`Busqueda: "${searchQuery.trim()}"`);

    const count = filteredGlobalTastingItems.length;
    return {
      badgeLabel: parts.length > 0 ? `FILTRADO • ${count} REG.` : `TODOS • ${count} REG.`,
      summaryLabel: parts.length > 0 ? parts.join(' | ') : 'Todos los Registros (Consolidado Global)',
      fileSuffix: parts.length > 0 ? 'Filtro_Matriz' : 'Global_Todos',
    };
  }, [
    selectedDay,
    matrixDateFrom,
    matrixDateTo,
    selectedShift,
    selectedProduct,
    searchQuery,
    filteredGlobalTastingItems.length,
    liveClock.currentWeek.rangeLabel,
    liveClock.yearMonth,
    tableRollingWeek,
  ]);

  const handleExportMonthlyReportPdf = async () => {
    if (isExportingMonthlyPdf) return;
    try {
      setIsExportingMonthlyPdf(true);
      await exportMonthlyTastingGeneralReportPdf(filteredGlobalTastingItems, {
        filterSummaryLabel: activeMatrixFilterMeta.summaryLabel,
        fileSuffix: activeMatrixFilterMeta.fileSuffix,
        scope: 'all',
      });
      setMonthlyPdfSuccess(true);
      setTimeout(() => setMonthlyPdfSuccess(false), 3200);
    } catch {
      showNotification('No se pudo exportar el Informe Global PDF.', 0);
    } finally {
      setIsExportingMonthlyPdf(false);
    }
  };

  const formatDayLabelFromYmd = (ymd: string): string => {
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return ymd;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    return `${days[d.getDay()]} ${m[3]}/${m[2]}`;
  };

  // ----------------------------------------------------
  // BATCH FILL ENGINE STATE (LLENADO POR LOTE INTELIGENTE CON SEMANA AUTOMÁTICA)
  // ----------------------------------------------------
  const [selectedBatchProductIds, setSelectedBatchProductIds] = useState<string[]>([]);
  const [productSearchInBatch, setProductSearchInBatch] = useState<string>('');
  const [debouncedProductSearchInBatch, setDebouncedProductSearchInBatch] = useState<string>('');
  const [productUnitFilter, setProductUnitFilter] = useState<string>('TODAS');
  const [visibleBatchProductsLimit, setVisibleBatchProductsLimit] = useState<number>(60);
  const [singleModalProduct, setSingleModalProduct] = useState<string>('MORTADELA ASTURIAS');
  const [batchQuantity, setBatchQuantity] = useState<string>('1');
  const [batchShift, setBatchShift] = useState<ShiftType>('MAÑANA');
  const [batchDate, setBatchDate] = useState<string>(() => liveClock.todayYmd);
  const [isBatchDateManual, setIsBatchDateManual] = useState<boolean>(false);
  const [batchWeekOffset, setBatchWeekOffset] = useState<number>(0);

  // Búsqueda inteligente instantánea (0 ms de espera al teclear) en catálogo de productos
  useEffect(() => {
    setDebouncedProductSearchInBatch(productSearchInBatch);
  }, [productSearchInBatch]);

  useEffect(() => {
    setVisibleBatchProductsLimit(60);
  }, [productUnitFilter, debouncedProductSearchInBatch]);

  // Avanza automáticamente la fecha de despliegue a medida que transcurren los días y semanas
  useEffect(() => {
    if (!isBatchDateManual && batchDate !== liveClock.todayYmd) {
      setBatchDate(liveClock.todayYmd);
      setBatchWeekOffset(0);
    }
  }, [liveClock.todayYmd, isBatchDateManual, batchDate]);

  const batchRollingWeek = useMemo(
    () => getRollingWeekWindow(liveClock.todayYmd, batchWeekOffset),
    [liveClock.todayYmd, batchWeekOffset]
  );

  const batchDay = useMemo(() => formatDayLabelFromYmd(batchDate), [batchDate]);
  const [batchPromotora, setBatchPromotora] = useState<string>('AUTO');
  const [batchNotes, setBatchNotes] = useState<string>('');

  const activePromotoraOptions = useMemo(() => {
    const byKey = new Map<string, { id: string; name: string; email: string }>();
    for (const u of users) {
      if (u.role !== 'promotora' || !u.name?.trim()) continue;
      const k = canonicalStaffKey(u.name, u.email);
      if (!k) continue;
      byKey.set(k, { id: u.id, name: u.name.trim(), email: String(u.email || '').trim().toLowerCase() });
    }
    for (const p of masterEntities?.promotoras ?? []) {
      if (p.activo === false) continue;
      const catLower = String(p.categoria || '').toLowerCase();
      if (catLower.includes('merch')) continue;
      const cleanName = String(p.nombre_completo || '').trim();
      if (!cleanName) continue;
      const cleanEmail = String(p.email || '').trim().toLowerCase();
      const k = canonicalStaffKey(cleanName, cleanEmail);
      if (!k || byKey.has(k)) continue;
      byKey.set(k, { id: String(p.id), name: cleanName, email: cleanEmail });
    }
    return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [users, masterEntities?.promotoras]);
  
  // Selected store IDs for batch (inicia vacío, sin selección prefabricada)
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [storeZoneFilter, setStoreZoneFilter] = useState<string>('TODAS');
  const [storeSearchInBatch, setStoreSearchInBatch] = useState<string>('');
  const [debouncedStoreSearchInBatch, setDebouncedStoreSearchInBatch] = useState<string>('');
  const [visibleBatchStoresLimit, setVisibleBatchStoresLimit] = useState<number>(150);

  // Debounce ligero (~180 ms) para mantener búsqueda fluida con miles de PDVs
  useEffect(() => {
    if (!storeSearchInBatch.trim()) {
      setDebouncedStoreSearchInBatch('');
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedStoreSearchInBatch(storeSearchInBatch);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [storeSearchInBatch]);

  // Al cambiar de sede operativa, limpiar selección previa y reiniciar filtro de zona
  useEffect(() => {
    setSelectedStoreIds([]);
    setStoreZoneFilter('TODAS');
    setStoreSearchInBatch('');
    setDebouncedStoreSearchInBatch('');
    setVisibleBatchStoresLimit(150);
  }, [activeSucursal]);

  useEffect(() => {
    setVisibleBatchStoresLimit(150);
  }, [storeZoneFilter, debouncedStoreSearchInBatch]);

  // Estados de carga para persistencia en Supabase y bloqueo de doble envío
  const [isPersistingMatrix, setIsPersistingMatrix] = useState<boolean>(false);
  const [savingVisitIds, setSavingVisitIds] = useState<Record<string, boolean>>({});

  const isVisitSaving = (visitId: string): boolean => Boolean(savingVisitIds[visitId]);

  const withVisitSaving = async <T,>(visitId: string, fn: () => Promise<T>): Promise<T> => {
    setSavingVisitIds((prev) => ({ ...prev, [visitId]: true }));
    try {
      return await fn();
    } finally {
      setSavingVisitIds((prev) => {
        const next = { ...prev };
        delete next[visitId];
        return next;
      });
    }
  };

  // Notification toast
  const [notificationMsg, setNotificationMsg] = useState<{
    text: string;
    count: number;
    subtitle?: string;
  } | null>(null);

  // Modal to add single row
  const [isAddModalOpen, setIsAddModalOpen] = useState<boolean>(false);
  const [newStoreName, setNewStoreName] = useState<string>('');
  const [newStoreId, setNewStoreId] = useState<string>('');
  const [newZone, setNewZone] = useState<string>('');
  const [newSellerNameInput, setNewSellerNameInput] = useState<string>('');
  const [newVisitNotes, setNewVisitNotes] = useState<string>('');

  const [newPromotoraName, setNewPromotoraName] = useState<string>(
    () => users.find((u) => u.role === 'promotora')?.name || 'POR ASIGNAR (Trade Marketing)'
  );

  const showNotification = (text: string, count: number, subtitle?: string) => {
    setNotificationMsg({ text, count, subtitle });
    setTimeout(() => setNotificationMsg(null), 4500);
  };

  // Helper de Validación: Comprueba si una promotora activa ya está agendada el mismo día en la misma jornada
  const isPromotoraBooked = (
    promotoraName: string,
    dayLabel: string,
    shift: ShiftType,
    excludeVisitId?: string,
    dateYmd?: string
  ) => {
    if (!promotoraName) return undefined;
    const upper = promotoraName.toUpperCase().trim();
    if (upper.startsWith('POR ASIGNAR') || upper.startsWith('SIN ASIGNAR')) return undefined;
    const targetKey = canonicalStaffKey(promotoraName);
    if (!targetKey) return undefined;
    return visits.find(
      (v) =>
        v.id !== excludeVisitId &&
        (dateYmd && v.date ? v.date === dateYmd : v.dayLabel === dayLabel) &&
        v.shift === shift &&
        !v.promotoraName.toUpperCase().trim().startsWith('POR ASIGNAR') &&
        !v.promotoraName.toUpperCase().trim().startsWith('SIN ASIGNAR') &&
        canonicalStaffKey(v.promotoraName) === targetKey
    );
  };

  // Unique zones for filtering clients in batch selector (ordenadas alfabéticamente)
  const availableZones = useMemo(
    () =>
      Array.from(new Set(stores.map((s) => s.zone)))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'es')),
    [stores]
  );

  // Pre-índice memoizado para búsqueda instantánea NFD insensible a tildes y ", C.A." con miles de PDVs
  const indexedStoresForBatch = useMemo(
    () =>
      stores.map((store) => {
        const normTokens = [store.name, store.zone, store.clientCode, store.sellerName, store.city].map(
          (field) => normalizeSearchText(field)
        );
        const compactTokens = normTokens.map((t) => t.replace(/[^a-z0-9]+/g, ''));
        return { store, normTokens, compactTokens };
      }),
    [stores]
  );

  // Stores filtered for the batch selection list (búsqueda NFD insensible a tildes y ", C.A.")
  const filteredStoresForBatch = useMemo(() => {
    const q = normalizeSearchText(debouncedStoreSearchInBatch);
    const qCompact = q.replace(/[^a-z0-9]+/g, '');
    const out: typeof stores = [];
    for (const item of indexedStoresForBatch) {
      if (storeZoneFilter !== 'TODAS' && item.store.zone !== storeZoneFilter) continue;
      if (!q) {
        out.push(item.store);
        continue;
      }
      const matched = item.normTokens.some(
        (norm, idx) =>
          norm.includes(q) || (qCompact.length >= 2 && item.compactTokens[idx]!.includes(qCompact))
      );
      if (matched) out.push(item.store);
    }
    return out;
  }, [indexedStoresForBatch, storeZoneFilter, debouncedStoreSearchInBatch]);

  const visibleStoresInBatch = useMemo(
    () => filteredStoresForBatch.slice(0, visibleBatchStoresLimit),
    [filteredStoresForBatch, visibleBatchStoresLimit]
  );

  const selectedStoreIdSet = useMemo(() => new Set(selectedStoreIds), [selectedStoreIds]);

  // Solo clientes marcados Y visibles dentro del filtro/zona actual
  const effectiveBatchStoreIds = useMemo(
    () => filteredStoresForBatch.filter((s) => selectedStoreIdSet.has(s.id)).map((s) => s.id),
    [filteredStoresForBatch, selectedStoreIdSet]
  );
  const hiddenSelectedCount = selectedStoreIds.length - effectiveBatchStoreIds.length;

  // Catálogo oficial vigente de productos (152 artículos sincronizados desde Supabase + respaldo oficial completo)
  const batchProductCatalog = useMemo(() => {
    const sourceList =
      (masterEntities?.productos?.length ?? 0) > 0
        ? masterEntities.productos
        : OFFICIAL_TRADE_PRODUCTS_MAESTROS;

    const activeRemote = sourceList
      .filter((p) => p.activo !== false && Boolean(p.nombre?.trim()))
      .map((p) => ({
        id: p.id || `${p.codigo || 'PROD'}-${p.nombre}`,
        codigo: p.codigo || '',
        nombre: p.nombre.trim(),
        marca: p.marca || null,
        categoria: p.categoria || null,
        unidad: (p.unidad_medida || 'UND').toUpperCase(),
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    if (activeRemote.length > 0) return activeRemote;

    return OFFICIAL_TRADE_PRODUCTS_MAESTROS.map((p) => ({
      id: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      marca: p.marca,
      categoria: p.categoria,
      unidad: (p.unidad_medida || 'UND').toUpperCase(),
    }));
  }, [masterEntities?.productos]);

  const productComboboxOptions = useMemo<SmartSearchComboboxOption[]>(
    () =>
      batchProductCatalog.map((prod) => {
        const unpaddedCode = prod.codigo.replace(/^0+/, '');
        return {
          value: prod.nombre,
          label: prod.nombre,
          sublabel: [prod.codigo, prod.categoria, prod.marca].filter(Boolean).join(' • '),
          badge: prod.unidad,
          keywords: `${prod.codigo} ${unpaddedCode} ${prod.marca ?? ''} ${prod.categoria ?? ''} ${prod.unidad}`,
        };
      }),
    [batchProductCatalog]
  );

  const availableProductUnits = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of batchProductCatalog) {
      counts.set(p.unidad, (counts.get(p.unidad) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [batchProductCatalog]);

  const indexedProductsForBatch = useMemo(
    () =>
      batchProductCatalog.map((product) => {
        const normName = normalizeSearchText(product.nombre);
        const normCode = normalizeSearchText(product.codigo);
        const unpaddedCode = normCode.replace(/^0+/, '');
        const normFull = normalizeSearchText(
          `${product.nombre} ${product.codigo} ${unpaddedCode} ${product.marca ?? ''} ${product.categoria ?? ''} ${product.unidad}`
        );
        const compactFull = normFull.replace(/[^a-z0-9]+/g, '');
        return { product, normName, normCode, unpaddedCode, normFull, compactFull };
      }),
    [batchProductCatalog]
  );

  // Búsqueda inteligente multi-término instantánea insensible a acentos (nombre, código SKU con/sin ceros, grupo, subgrupo, marca o presentación)
  const filteredProductsForBatch = useMemo(() => {
    const qNorm = normalizeSearchText(debouncedProductSearchInBatch);
    const tokens = qNorm ? qNorm.split(' ').filter(Boolean) : [];
    const qCompact = qNorm.replace(/[^a-z0-9]+/g, '');
    const qNumericUnpadded = /^\d+$/.test(qCompact) ? qCompact.replace(/^0+/, '') || '0' : '';

    const scored: Array<{ product: (typeof batchProductCatalog)[number]; score: number }> = [];
    for (const item of indexedProductsForBatch) {
      if (productUnitFilter !== 'TODAS' && item.product.unidad !== productUnitFilter) continue;
      if (tokens.length === 0) {
        scored.push({ product: item.product, score: 0 });
        continue;
      }

      const allTokensMatch = tokens.every((tok) => {
        if (item.normFull.includes(tok)) return true;
        if (/^\d+$/.test(tok)) {
          const cleanTok = tok.replace(/^0+/, '') || '0';
          return item.unpaddedCode === cleanTok || item.normCode.includes(cleanTok);
        }
        return false;
      });
      const compactMatch = qCompact.length >= 2 && item.compactFull.includes(qCompact);
      if (!allTokensMatch && !compactMatch) continue;

      let score = 10;
      if (
        (item.normCode && item.normCode === qNorm) ||
        (qNumericUnpadded && item.unpaddedCode === qNumericUnpadded)
      ) {
        score = 0;
      } else if (item.normName.startsWith(qNorm)) {
        score = 1;
      } else if (item.normCode && item.normCode.includes(qNorm)) {
        score = 2;
      } else if (item.normName.includes(qNorm)) {
        score = 3;
      } else if (allTokensMatch) {
        score = 4;
      }

      scored.push({ product: item.product, score });
    }

    if (tokens.length > 0) {
      scored.sort(
        (a, b) => a.score - b.score || a.product.nombre.localeCompare(b.product.nombre, 'es')
      );
    }
    return scored.map((s) => s.product);
  }, [indexedProductsForBatch, productUnitFilter, debouncedProductSearchInBatch]);

  const visibleProductsInBatch = useMemo(
    () => filteredProductsForBatch.slice(0, visibleBatchProductsLimit),
    [filteredProductsForBatch, visibleBatchProductsLimit]
  );

  const selectedBatchProductIdSet = useMemo(
    () => new Set(selectedBatchProductIds),
    [selectedBatchProductIds]
  );

  const productCatalogById = useMemo(() => {
    const map = new Map<string, (typeof batchProductCatalog)[number]>();
    for (const p of batchProductCatalog) map.set(p.id, p);
    return map;
  }, [batchProductCatalog]);

  const selectedBatchProducts = useMemo(
    () =>
      selectedBatchProductIds
        .map((id) => productCatalogById.get(id))
        .filter((p): p is (typeof batchProductCatalog)[number] => Boolean(p)),
    [selectedBatchProductIds, productCatalogById]
  );

  const selectedBatchProductNames = useMemo(
    () => selectedBatchProducts.map((p) => p.nombre),
    [selectedBatchProducts]
  );

  const batchProduct = useMemo(
    () =>
      selectedBatchProductNames.length > 0
        ? selectedBatchProductNames.join(' + ')
        : 'SIN PRODUCTOS',
    [selectedBatchProductNames]
  );

  const batchProductBadgeLabel = useMemo(() => {
    if (selectedBatchProductNames.length === 0) return '0 Productos';
    if (selectedBatchProductNames.length === 1) {
      const first = selectedBatchProductNames[0]!;
      return first.length > 26 ? `${first.slice(0, 24).trimEnd()}…` : first;
    }
    return `${selectedBatchProductNames.length} Productos`;
  }, [selectedBatchProductNames]);

  const hasVencampoSelected = useMemo(
    () =>
      selectedBatchProductNames.some((name) => {
        const norm = normalizeSearchText(name);
        return (
          norm.includes('vencampo') ||
          norm.includes('arroz') ||
          norm.includes('leche') ||
          norm.includes('avena')
        );
      }),
    [selectedBatchProductNames]
  );

  const toggleBatchProductSelection = (productId: string) => {
    setSelectedBatchProductIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    );
  };

  const handleSelectAllFilteredProducts = () => {
    const idsToSelect = filteredProductsForBatch.map((p) => p.id);
    setSelectedBatchProductIds((prev) => Array.from(new Set([...prev, ...idsToSelect])));
  };

  const handleDeselectAllProducts = () => {
    setSelectedBatchProductIds([]);
  };

  // Estado del modal LIMPIAR POR LOTE / NUEVA CARGA (cancelación lógica auditable)
  const [isClearModalOpen, setIsClearModalOpen] = useState<boolean>(false);
  const [clearMode, setClearMode] = useState<'FILTERED' | 'ALL'>('FILTERED');
  const [clearByClients, setClearByClients] = useState<boolean>(true);
  const [clearByProduct, setClearByProduct] = useState<boolean>(true);
  const [clearByShiftDate, setClearByShiftDate] = useState<boolean>(true);
  const [clearResetSteps, setClearResetSteps] = useState<boolean>(true);
  const [clearAllConfirmText, setClearAllConfirmText] = useState<string>('');

  const clearPreview = (() => {
    const matches = visits.filter((v) => {
      if (clearMode === 'ALL') return true;
      if (clearByClients && !effectiveBatchStoreIds.includes(v.storeId)) return false;
      if (clearByProduct && selectedBatchProductNames.length > 0) {
        const focusNorm = normalizeSearchText(v.productFocus);
        const anyMatched = selectedBatchProductNames.some((pName) =>
          focusNorm.includes(normalizeSearchText(pName))
        );
        if (!anyMatched) return false;
      }
      if (clearByShiftDate && (v.shift !== batchShift || v.date !== batchDate)) return false;
      return true;
    });
    const pending = matches.filter((v) => v.status === 'PENDIENTE' && !v.enHistorial).length;
    return { total: matches.length, pending, preserved: matches.length - pending };
  })();

  const handleConfirmClear = async () => {
    if (isPersistingMatrix) return;
    if (clearMode === 'FILTERED' && clearByClients && effectiveBatchStoreIds.length === 0) {
      showNotification(
        'No hay clientes seleccionados y visibles. Desactiva el criterio de clientes o selecciona clientes.',
        0
      );
      return;
    }

    setIsPersistingMatrix(true);
    try {
      const res = await clearVisitsBatch({
        mode: clearMode,
        storeIds: clearByClients ? effectiveBatchStoreIds : undefined,
        product:
          clearByProduct && selectedBatchProductNames.length > 0
            ? selectedBatchProductNames[0]
            : undefined,
        shift: clearByShiftDate ? batchShift : undefined,
        date: clearByShiftDate ? batchDate : undefined,
      });

      if (!res.ok) {
        showNotification(
          res.error || 'No se pudo completar la cancelación lógica en Supabase.',
          0,
          res.reverted
            ? 'Los cambios no persistidos fueron revertidos automáticamente.'
            : 'Verifica permisos y estado de los registros seleccionados.'
        );
        return;
      }

      if (clearResetSteps) {
        setSelectedStoreIds([]);
        setSelectedBatchProductIds([]);
        setProductSearchInBatch('');
        setDebouncedProductSearchInBatch('');
        setProductUnitFilter('TODAS');
        setBatchQuantity('1');
        setStoreSearchInBatch('');
        setStoreZoneFilter('TODAS');
      }
      setIsClearModalOpen(false);
      setClearAllConfirmText('');
      showNotification(
        res.removed === 0 && res.preservedNonPending === 0
          ? 'No había registros pendientes que cancelar con esos criterios.'
          : `Cancelación lógica por lote: ${res.removed} cancelados en Supabase` +
              (res.preservedNonPending > 0
                ? `, ${res.preservedNonPending} preservados (históricos/no pendientes).`
                : '.'),
        res.removed,
        'Los registros cancelados se archivan en Historial sin borrado físico.'
      );
    } finally {
      setIsPersistingMatrix(false);
    }
  };

  // Toggle store selection in batch list
  const toggleStoreSelection = (storeId: string) => {
    setSelectedStoreIds((prev) =>
      prev.includes(storeId) ? prev.filter((id) => id !== storeId) : [...prev, storeId]
    );
  };

  const handleSelectAllFilteredStores = () => {
    const idsToSelect = filteredStoresForBatch.map((s) => s.id);
    setSelectedStoreIds((prev) => Array.from(new Set([...prev, ...idsToSelect])));
  };

  const handleDeselectAllStores = () => {
    setSelectedStoreIds([]);
  };

  // ----------------------------------------------------
  // EXECUTE BATCH FILL (LLENADO POR LOTE PERSISTIDO EN SUPABASE)
  // ----------------------------------------------------
  const handleExecuteBatchFill = async (shiftOverride?: ShiftType) => {
    if (isPersistingMatrix) return;
    if (effectiveBatchStoreIds.length === 0) {
      showNotification(
        hiddenSelectedCount > 0
          ? 'Los clientes marcados están ocultos por el filtro/zona actual. Ajusta el filtro o marca clientes visibles.'
          : 'Por favor selecciona al menos un cliente / punto de venta para el lote.',
        0
      );
      return;
    }

    if (selectedBatchProductNames.length === 0) {
      showNotification(
        'Por favor selecciona al menos un producto a degustar en el paso 2.',
        0
      );
      return;
    }

    const shiftToUse = shiftOverride || batchShift;
    const promotoraToUse = batchPromotora === 'AUTO' ? undefined : batchPromotora;
    const matchedPromotoraOption = promotoraToUse
      ? activePromotoraOptions.find(
          (p) => canonicalStaffKey(p.name) === canonicalStaffKey(promotoraToUse)
        )
      : undefined;

    // Validación de regla de negocio: No duplicar la misma promotora en la misma jornada
    if (promotoraToUse) {
      if (effectiveBatchStoreIds.length > 1) {
        showNotification(
          `⛔ Conflicto de Jornada: No se puede agendar a la promotora ${promotoraToUse} en ${effectiveBatchStoreIds.length} tiendas simultáneamente el ${batchDay} en la jornada ${shiftToUse}. Usa asignación automática o selecciona 1 tienda.`,
          0,
          'Regla de asignación: No se permite agendar a la promotora el mismo día en la misma jornada.'
        );
        return;
      }
      const conflict = isPromotoraBooked(promotoraToUse, batchDay, shiftToUse, undefined, batchDate);
      if (conflict && !effectiveBatchStoreIds.includes(conflict.storeId)) {
        showNotification(
          `⛔ Conflicto de Jornada: ${promotoraToUse} ya está agendada en "${conflict.storeName}" para el ${batchDay} (${shiftToUse}). No se puede duplicar en la misma jornada.`,
          0,
          'Regla de asignación: No se permite agendar a la promotora el mismo día en la misma jornada.'
        );
        return;
      }
    }

    setIsPersistingMatrix(true);
    try {
      const result = await batchFillClientsProductShift({
        storeIds: effectiveBatchStoreIds,
        product: batchProduct,
        products: selectedBatchProductNames,
        quantityInput: batchQuantity,
        shift: shiftToUse,
        dayLabel: batchDay,
        date: batchDate,
        promotoraName: promotoraToUse,
        promotoraEmail: matchedPromotoraOption?.email || undefined,
        notes: batchNotes.trim() || undefined,
      });

      if (!result.ok) {
        showNotification(
          result.error || 'Error guardando el lote en Supabase.',
          0,
          result.reverted
            ? 'Los cambios optimistas fueron revertidos automáticamente.'
            : 'No se pudo persistir el llenado por lote.'
        );
        return;
      }

      setBatchNotes('');
      const totalProcessed = result.countUpdated + result.countCreated;
      showNotification(
        `¡Llenado por lote persistido en Supabase! Se cargó ${batchProductBadgeLabel} (${batchQuantity}) en ${totalProcessed} tiendas para la jornada ${shiftToUse}.` +
          (hiddenSelectedCount > 0 ? ` ${hiddenSelectedCount} marcados ocultos por filtro omitidos.` : ''),
        totalProcessed,
        'Sincronizado en cronograma_degustaciones, rutas_promotoras y entregas_degustacion.'
      );
    } finally {
      setIsPersistingMatrix(false);
    }
  };

  // Filter visits for Main Table (soporta rango de fechas, todos los productos y búsqueda NFD sin tildes)
  const filteredVisits = useMemo(
    () =>
      filterMatrixVisits(visits, {
        selectedDay,
        matrixDateFrom,
        matrixDateTo,
        selectedShift,
        selectedProduct,
        searchQuery,
        currentWeekBounds: liveClock.currentWeek,
        rollingWeekBounds: tableRollingWeek,
        currentYearMonth: liveClock.yearMonth,
      }),
    [
      visits,
      selectedDay,
      matrixDateFrom,
      matrixDateTo,
      selectedShift,
      selectedProduct,
      searchQuery,
      liveClock.currentWeek,
      tableRollingWeek,
      liveClock.yearMonth,
    ]
  );

  // Selección por fila y por lote en la Tabla General de Activaciones
  const [selectedTableVisitIds, setSelectedTableVisitIds] = useState<string[]>([]);
  const [isDeleteSelectedModalOpen, setIsDeleteSelectedModalOpen] = useState<boolean>(false);

  // Limpiar automáticamente IDs que ya no existan en visits
  useEffect(() => {
    const validIds = new Set(visits.map((v) => v.id));
    setSelectedTableVisitIds((prev) => {
      const next = prev.filter((id) => validIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [visits]);

  const visibleTableVisitIds = useMemo(() => filteredVisits.map((v) => v.id), [filteredVisits]);

  const allVisibleTableSelected =
    visibleTableVisitIds.length > 0 &&
    visibleTableVisitIds.every((id) => selectedTableVisitIds.includes(id));

  const toggleTableVisitSelection = (visitId: string) => {
    setSelectedTableVisitIds((prev) =>
      prev.includes(visitId) ? prev.filter((id) => id !== visitId) : [...prev, visitId]
    );
  };

  const handleToggleSelectAllVisibleVisits = () => {
    if (visibleTableVisitIds.length === 0) return;
    if (allVisibleTableSelected) {
      const visibleSet = new Set(visibleTableVisitIds);
      setSelectedTableVisitIds((prev) => prev.filter((id) => !visibleSet.has(id)));
    } else {
      setSelectedTableVisitIds((prev) => Array.from(new Set([...prev, ...visibleTableVisitIds])));
    }
  };

  const selectedTableVisits = useMemo(
    () => visits.filter((v) => selectedTableVisitIds.includes(v.id)),
    [visits, selectedTableVisitIds]
  );

  const selectedNonPendingCount = useMemo(
    () => selectedTableVisits.filter((v) => v.status !== 'PENDIENTE' || v.enHistorial).length,
    [selectedTableVisits]
  );

  const handleClickDeleteSelected = () => {
    if (selectedTableVisitIds.length === 0) {
      showNotification(
        '⚠️ Debes seleccionar al menos un cliente en la Tabla General para poder cancelar.',
        0
      );
      return;
    }
    setIsDeleteSelectedModalOpen(true);
  };

  const handleConfirmDeleteSelected = async () => {
    if (isPersistingMatrix) return;
    const countToRemove = selectedTableVisitIds.length;
    if (countToRemove === 0) {
      setIsDeleteSelectedModalOpen(false);
      return;
    }

    setIsPersistingMatrix(true);
    try {
      const res = await deleteVisitsByIds(selectedTableVisitIds, 'CANCELACION_LOTE_TABLA');
      if (!res.ok) {
        showNotification(
          res.error || 'No se pudo completar la cancelación lógica en Supabase.',
          0,
          res.reverted
            ? 'Los cambios no persistidos fueron revertidos automáticamente.'
            : 'Los registros históricos o completados permanecen protegidos.'
        );
        return;
      }

      setSelectedTableVisitIds([]);
      setIsDeleteSelectedModalOpen(false);
      showNotification(
        `✓ Cancelación lógica aplicada: ${res.removed} registro(s) archivados como CANCELADA` +
          (res.preservedHistorical > 0
            ? ` (${res.preservedHistorical} históricos/completados preservados).`
            : '.'),
        res.removed,
        'Sin borrado físico: los registros quedan trazables en Historial.'
      );
    } finally {
      setIsPersistingMatrix(false);
    }
  };

  const handleCancelSingleVisit = async (visitId: string) => {
    if (isVisitSaving(visitId)) return;
    const res = await withVisitSaving(visitId, () =>
      deleteVisit(visitId, 'CANCELACION_INDIVIDUAL_MATRIZ')
    );
    if (!res.ok) {
      showNotification(
        res.error || 'No se pudo cancelar el registro en Supabase.',
        0,
        res.reverted
          ? 'El registro fue restaurado automáticamente en la Tabla General.'
          : 'Los registros completados o en Historial están protegidos.'
      );
      return;
    }
    showNotification(
      '✓ Registro cancelado lógicamente y archivado en Historial.',
      1,
      'Sin borrado físico en Supabase.'
    );
  };

  const handleInlineProductFill = async (visitId: string, product: string, qty: string) => {
    const res = await withVisitSaving(visitId, () =>
      updateVisitFromProductFill(visitId, product, qty)
    );
    if (!res.ok) {
      showNotification(
        res.error || 'No se pudo guardar la modificación del producto en Supabase.',
        0,
        'El cambio en línea fue revertido automáticamente.'
      );
    }
  };

  const handleInlineVisitPatch = async (
    visitId: string,
    patch: Parameters<typeof updateVisit>[1]
  ) => {
    const res = await withVisitSaving(visitId, () =>
      updateVisit(visitId, patch, { persist: true })
    );
    if (!res.ok) {
      showNotification(
        res.error || 'No se pudo persistir el ajuste en línea en Supabase.',
        0,
        'El valor anterior fue restaurado automáticamente.'
      );
    }
  };

  // Calculate live totals across all visits in general table
  const totalMortadela = visits.reduce((acc, v) => acc + (v.mortadelaQty || 0), 0);
  const totalVencampoStands = visits.reduce((acc, v) => acc + (v.arrozQty > 0 || v.productFocus.includes('VENCAMPO') ? 1 : 0), 0);
  const totalEspalda = visits.reduce((acc, v) => acc + (v.espaldaQty || 0), 0);
  const totalAzucarGrams = visits.reduce((acc, v) => acc + (v.azucarGrams || 0), 0);
  const totalLecheGrams = visits.reduce((acc, v) => acc + (v.lecheGrams || 0), 0);

  const metric360SwitcherItems = useMemo<Metric360SwitcherItem[]>(
    () => [
      { id: 'mortadela', label: 'Mortadela Asturias', badgeValue: `${totalMortadela} un` },
      { id: 'vencampo', label: 'Stands Vencampo', badgeValue: `${totalVencampoStands} stands` },
      { id: 'azucar', label: 'Azúcar Insumo', badgeValue: `${totalAzucarGrams} g` },
      { id: 'leche', label: 'Leche en Polvo', badgeValue: `${totalLecheGrams} g` },
      { id: 'espalda', label: 'Espalda Ahumada', badgeValue: `${totalEspalda} un` },
      { id: 'matriz_pdv', label: 'Total PDVs Matriz', badgeValue: `${visits.length} filas` },
    ],
    [
      totalMortadela,
      totalVencampoStands,
      totalAzucarGrams,
      totalLecheGrams,
      totalEspalda,
      visits.length,
    ]
  );

  // Export CSV
  const handleExportCsv = () => {
    // Escapa comillas dobles y neutraliza inyección de fórmulas (=, +, -, @) al abrir en Excel
    const csvText = (value: string | number | undefined) => {
      let s = String(value ?? '');
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };

    const headers = 'FECHA,TURNO,CLIENTE,PRODUCTO_LLENADO,CANTIDAD_LLENADO,MORTADELA_UN,ESPALDA_UN,ARROZ_UN,AZUCAR_G,LECHE_G,VENDEDOR,PROMOTORA,UBICACION,ESTADO\r\n';
    const rows = filteredVisits
      .map((v) =>
        [
          csvText(v.dayLabel),
          csvText(v.shift),
          csvText(v.storeName),
          csvText(v.fillProductSelection || v.productFocus),
          csvText(v.fillQuantityInput || v.plannedUnits),
          v.mortadelaQty || 0,
          v.espaldaQty || 0,
          v.arrozQty || 0,
          v.azucarGrams || 0,
          v.lecheGrams || 0,
          csvText(v.sellerName),
          csvText(v.promotoraName),
          csvText(v.zone),
          csvText(v.status),
        ].join(',')
      )
      .join('\r\n');

    // BOM UTF-8 para que Excel muestre correctamente acentos y la "Ñ"
    const blob = new Blob(['\uFEFF' + headers + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `codizulca_tabla_general_degustaciones_${selectedDay.replace(/\s+/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      
      {/* Membrete oficial exclusivo para soporte impreso / PDF */}
      <PrintSupportHeader
        moduleTitle="MÓDULO 2: LLENADO POR PRODUCTOS & CRONOGRAMA DE PDVs"
        documentSubtitle="Matriz Oficial Consolidada de Degustaciones, Despacho y Registro de Insumos"
        documentCode="CZ-MOD2-MTZ"
      />

      {/* Real-time Notification Banner */}
      {notificationMsg && (
        <div className={`fixed top-20 right-6 z-50 text-white font-black text-xs px-5 py-3.5 rounded-2xl shadow-2xl border-2 flex items-center gap-3 animate-bounce ${
          notificationMsg.count === 0
            ? 'bg-amber-600 border-amber-300 shadow-amber-950/80'
            : 'bg-red-600 border-white shadow-red-950'
        }`}>
          <div className={`w-6 h-6 rounded-full flex items-center justify-center font-black text-xs ${
            notificationMsg.count === 0 ? 'bg-amber-100 text-amber-800' : 'bg-white text-red-600'
          }`}>
            {notificationMsg.count === 0 ? '!' : '✓'}
          </div>
          <div>
            <div className="font-extrabold text-sm">{notificationMsg.text}</div>
            <div className="text-[10px] text-white/90">
              {notificationMsg.subtitle ||
                (notificationMsg.count === 0
                  ? 'Los cambios no persistidos fueron revertidos automáticamente o requieren ajuste.'
                  : 'La Tabla General ha sido actualizada y persistida en tiempo real.')}
            </div>
          </div>
        </div>
      )}

      {/* Top Banner: Codizulca Corporate (Negro, Blanco y Rojo) */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden backdrop-blur-md">
        <div className="absolute top-0 right-0 w-96 h-96 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-red-600/20 text-red-400 uppercase tracking-wider border border-red-500/30">
                CODIZULCA C.A. · AUTOMATIZACIÓN DE TRADE
              </span>
              <span className="text-xs text-slate-400 font-mono">Sincronización Supabase · Llenado por Lote</span>
              <span
                className={`inline-flex items-center gap-1.5 text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full border ${
                  isCronogramaRealtimeConnected
                    ? 'bg-emerald-950/70 text-emerald-300 border-emerald-700/60'
                    : 'bg-zinc-900 text-zinc-400 border-white/10'
                }`}
                title="Sincronización automática con las autorizaciones del Módulo 1"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    isCronogramaRealtimeConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                  }`}
                />
                {isCronogramaRealtimeConnected
                  ? 'En Vivo · Realtime Módulo 1 ↔ Cronograma'
                  : 'Sincronizado con Módulo 1'}
              </span>
            </div>
            <h2 className="text-2xl font-black text-white tracking-tight flex items-center gap-2">
              <span>Llenado por Lote y Matriz General de Degustaciones</span>
            </h2>
            <p className="text-xs text-slate-300 mt-1 max-w-3xl leading-relaxed">
              Selecciona clientes, producto y jornada (<strong className="text-red-400 font-semibold">MAÑANA o TARDE</strong>) para poblar y recalcular la <strong className="text-white font-semibold">Tabla General</strong> en un solo clic, sin registro manual tienda por tienda.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Botón Exportar Informe Global y Detallado según Filtro Aplicado (PDF) */}
            <button
              type="button"
              onClick={handleExportMonthlyReportPdf}
              disabled={isExportingMonthlyPdf}
              title={`Descargar Informe Global y Detallado según el filtro aplicado (${activeMatrixFilterMeta.summaryLabel})`}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold tracking-wide bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white border border-red-500/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_14px_-2px_rgba(220,38,38,0.5)] transition-all cursor-pointer"
            >
              {isExportingMonthlyPdf ? (
                <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
              ) : monthlyPdfSuccess ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-white" />
              ) : (
                <Download className="w-3.5 h-3.5 text-white" />
              )}
              <span>
                {isExportingMonthlyPdf
                  ? 'Generando Informe...'
                  : monthlyPdfSuccess
                    ? '¡Informe Descargado!'
                    : 'Exportar Informe Global (PDF)'}
              </span>
              <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-black/35 border border-white/20 text-white font-mono uppercase">
                {activeMatrixFilterMeta.badgeLabel}
              </span>
            </button>

            {/* Botón Exportar PDF Matriz Actual */}
            <ExportPdfButton
              label="PDF Matriz Actual"
              variant="secondary"
              documentTitle="Matriz General de PDVs - Llenado de Productos"
              onExportPdf={() =>
                exportScheduleMatrixPdf(filteredVisits, selectedDay, {
                  mortadela: totalMortadela,
                  vencampo: totalVencampoStands,
                  azucar: totalAzucarGrams,
                  leche: totalLecheGrams,
                  espalda: totalEspalda,
                })
              }
            />

            <button
              onClick={() => setIsAddModalOpen(true)}
              className="px-3.5 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-white font-bold text-xs flex items-center gap-1.5 border border-slate-800 hover:border-red-500/50 transition-all shadow-sm"
            >
              <Plus className="w-3.5 h-3.5 text-red-500" />
              <span>Nueva Activación Manual</span>
            </button>

            <button
              onClick={handleExportCsv}
              className="px-3.5 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-white font-semibold text-xs flex items-center gap-1.5 border border-slate-700 hover:border-slate-600 transition-all shadow-sm"
            >
              <Download className="w-3.5 h-3.5 text-slate-300" />
              <span>Exportar CSV</span>
            </button>
          </div>
        </div>

        {/* Dynamic Interactive Metric Cards -> Selección abre Dashboard 360° */}
        <div className="mt-6 pt-5 border-t border-white/[0.08] relative z-10 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5 text-red-400" />
              <span>Métricas Interactivas · Selecciona cualquier tarjeta para abrir su <strong className="text-white">Dashboard 360°</strong></span>
            </span>
            <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-zinc-950/90 border border-white/10 text-zinc-300 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Semana {liveClock.isoWeekNumber} Auto · {liveClock.currentWeek.rangeLabel}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3.5">
            {/* Card 1: Mortadela Asturias */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('mortadela')}
              className={`text-left p-3.5 rounded-2xl bg-gradient-to-b from-red-950/25 via-zinc-900/90 to-zinc-950/95 border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] flex flex-col justify-between transition-all duration-200 hover:-translate-y-0.5 cursor-pointer group ${
                selectedMetric360 === 'mortadela'
                  ? 'border-red-500 ring-2 ring-red-500/50 shadow-[0_8px_24px_rgba(220,38,38,0.3)]'
                  : 'border-red-500/25 hover:border-red-500/60 hover:shadow-[0_8px_20px_rgba(220,38,38,0.2)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-red-300 font-semibold tracking-tight truncate">
                  Mortadela Asturias
                </span>
                <span className="inline-flex items-center gap-1 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-300 border border-red-500/30 group-hover:bg-red-600 group-hover:text-white transition-colors shrink-0">
                  360° ↗
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-red-400 font-mono tracking-tight leading-none">
                  {totalMortadela}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">unidades</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Marca</span>
                <span className="font-mono text-zinc-300">Línea Asturias</span>
              </div>
            </button>

            {/* Card 2: Stands Vencampo */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('vencampo')}
              className={`text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all duration-200 hover:-translate-y-0.5 cursor-pointer group ${
                selectedMetric360 === 'vencampo'
                  ? 'border-red-500 ring-2 ring-red-500/50 shadow-[0_8px_24px_rgba(220,38,38,0.3)]'
                  : 'border-white/[0.08] hover:border-red-500/50 hover:shadow-[0_8px_20px_rgba(0,0,0,0.6)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate transition-colors">
                  Stands Vencampo
                </span>
                <span className="inline-flex items-center gap-1 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-white/[0.06] text-zinc-400 group-hover:bg-red-600 group-hover:text-white transition-colors shrink-0">
                  <StoreIcon className="w-3 h-3" />
                  360°
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {totalVencampoStands}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">stands</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Modalidad</span>
                <span className="text-zinc-300 font-medium">Arroz + Stand</span>
              </div>
            </button>

            {/* Card 3: Azúcar Insumo */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('azucar')}
              className={`text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all duration-200 hover:-translate-y-0.5 cursor-pointer group ${
                selectedMetric360 === 'azucar'
                  ? 'border-red-500 ring-2 ring-red-500/50 shadow-[0_8px_24px_rgba(220,38,38,0.3)]'
                  : 'border-white/[0.08] hover:border-red-500/50 hover:shadow-[0_8px_20px_rgba(0,0,0,0.6)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate transition-colors">
                  Azúcar Insumo
                </span>
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-white/[0.06] text-zinc-400 group-hover:bg-red-600 group-hover:text-white transition-colors shrink-0">
                  g · 360°
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {totalAzucarGrams}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">gramos</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Equivalente</span>
                <span className="font-mono text-zinc-300">{(totalAzucarGrams / 1000).toFixed(2)} kg</span>
              </div>
            </button>

            {/* Card 4: Leche en Polvo */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('leche')}
              className={`text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all duration-200 hover:-translate-y-0.5 cursor-pointer group ${
                selectedMetric360 === 'leche'
                  ? 'border-red-500 ring-2 ring-red-500/50 shadow-[0_8px_24px_rgba(220,38,38,0.3)]'
                  : 'border-white/[0.08] hover:border-red-500/50 hover:shadow-[0_8px_20px_rgba(0,0,0,0.6)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate transition-colors">
                  Leche en Polvo
                </span>
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-white/[0.06] text-zinc-400 group-hover:bg-red-600 group-hover:text-white transition-colors shrink-0">
                  g · 360°
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {totalLecheGrams}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">gramos</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Equivalente</span>
                <span className="font-mono text-zinc-300">{(totalLecheGrams / 1000).toFixed(2)} kg</span>
              </div>
            </button>

            {/* Card 5: Espalda Ahumada */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('espalda')}
              className={`text-left p-3.5 rounded-2xl bg-gradient-to-b from-red-950/25 via-zinc-900/90 to-zinc-950/95 border shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] flex flex-col justify-between transition-all duration-200 hover:-translate-y-0.5 cursor-pointer group ${
                selectedMetric360 === 'espalda'
                  ? 'border-red-500 ring-2 ring-red-500/50 shadow-[0_8px_24px_rgba(220,38,38,0.3)]'
                  : 'border-red-500/25 hover:border-red-500/60 hover:shadow-[0_8px_20px_rgba(220,38,38,0.2)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-red-300 font-semibold tracking-tight truncate">
                  Espalda Ahumada
                </span>
                <span className="inline-flex items-center gap-1 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-300 border border-red-500/30 group-hover:bg-red-600 group-hover:text-white transition-colors shrink-0">
                  360° ↗
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-red-400 font-mono tracking-tight leading-none">
                  {totalEspalda}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">unidades</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Categoría</span>
                <span className="text-red-400 font-semibold">Línea Cocida</span>
              </div>
            </button>

            {/* Card 6: Total PDVs en Matriz */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('matriz_pdv')}
              className={`text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all duration-200 hover:-translate-y-0.5 cursor-pointer group ${
                selectedMetric360 === 'matriz_pdv'
                  ? 'border-red-500 ring-2 ring-red-500/50 shadow-[0_8px_24px_rgba(220,38,38,0.3)]'
                  : 'border-white/[0.08] hover:border-red-500/50 hover:shadow-[0_8px_20px_rgba(0,0,0,0.6)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate transition-colors">
                  Total PDVs Matriz
                </span>
                <span className="inline-flex items-center gap-1 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-white/[0.06] text-zinc-400 group-hover:bg-red-600 group-hover:text-white transition-colors shrink-0">
                  <FileSpreadsheet className="w-3 h-3" />
                  360°
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {visits.length}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">filas</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Cobertura</span>
                <span className="font-mono text-white font-semibold">Tabla General</span>
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 🚀 MÓDULO PRINCIPAL: MOTOR DE LLENADO POR LOTE (CLIENTES + PRODUCTO + JORNADA) */}
      {/* ========================================================================= */}
      <div className="bg-slate-900/80 border border-slate-800/90 rounded-2xl p-6 shadow-xl relative backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-800/80">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-red-500 to-red-700 text-white flex items-center justify-center font-black shadow-md shadow-red-950/60 border border-red-400/30">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-white tracking-tight">
                  Llenado por Lote Automático
                </h3>
                <span className="px-2 py-0.5 rounded-md bg-red-600/20 text-red-400 text-[10px] font-bold uppercase tracking-wider border border-red-500/30">
                  Operación Real
                </span>
              </div>
              <p className="text-xs text-slate-300 mt-0.5">
                Selecciona uno o más clientes reales, define el producto, la fecha y la jornada (Mañana o Tarde), y llena la Tabla General de inmediato.
              </p>
            </div>
          </div>
        </div>

        {/* 3 PASOS INTUITIVOS DE LLENADO POR LOTE */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
          
          {/* PASO 1: SELECCIONAR CLIENTE(S) (Columna 5/12) */}
          <div className="lg:col-span-5 bg-black border border-zinc-900 rounded-2xl p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-zinc-900 mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-red-600/20 text-red-500 font-black flex items-center justify-center text-xs border border-red-600/30">
                    1
                  </div>
                  <h4 className="text-xs font-black text-white uppercase tracking-wider">
                    Seleccionar Clientes / PDVs ({selectedStoreIds.length} elegidos)
                  </h4>
                </div>

                <div className="flex items-center gap-1 text-[11px]">
                  <button
                    onClick={handleSelectAllFilteredStores}
                    className="text-red-500 hover:text-red-400 font-bold px-1.5 py-0.5 rounded hover:bg-zinc-900 transition"
                  >
                    Todos
                  </button>
                  <span className="text-zinc-600">|</span>
                  <button
                    onClick={handleDeselectAllStores}
                    className="text-zinc-400 hover:text-white font-bold px-1.5 py-0.5 rounded hover:bg-zinc-900 transition"
                  >
                    Ninguno
                  </button>
                </div>
              </div>

              {/* Filtro rápido por zona y buscador de clientes */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Filtrar cliente..."
                    value={storeSearchInBatch}
                    onChange={(e) => setStoreSearchInBatch(e.target.value)}
                    className="w-full pl-8 pr-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600"
                  />
                </div>

                <select
                  value={storeZoneFilter}
                  onChange={(e) => setStoreZoneFilter(e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                >
                  <option value="TODAS">Todas las Zonas ({stores.length})</option>
                  {availableZones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </div>

              {/* Listado con Checkboxes de Tiendas (renderizado incremental para carteras > 3,000 clientes) */}
              <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1 divide-y divide-zinc-900/60">
                {masterData.error && stores.length > 0 && (
                  <div className="mb-2 p-2.5 rounded-xl bg-amber-950/30 border border-amber-700/40 text-[11px] text-amber-300 flex items-start justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <span className="inline-block font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-500/30 mr-1.5">
                        [Código: {masterData.errorCode ?? 'UNKNOWN_ERR'}]
                      </span>
                      <span className="break-words">{masterData.error}</span>
                    </div>
                    <button
                      type="button"
                      data-testid="retry-master-data-btn"
                      onClick={() => void masterData.refrescar()}
                      disabled={masterData.cargando}
                      className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-600/90 hover:bg-red-500 disabled:opacity-60 text-white text-[10px] font-bold transition"
                    >
                      {masterData.cargando ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3 h-3" />
                      )}
                      Reintentar carga
                    </button>
                  </div>
                )}

                {masterData.cargando && stores.length === 0 ? (
                  <div className="py-8 text-center text-xs text-zinc-400 flex flex-col items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                    <span>Cargando clientes de {activeSucursalLabel}...</span>
                  </div>
                ) : filteredStoresForBatch.length === 0 ? (
                  <div className="py-6 px-2 text-center text-xs text-zinc-500 space-y-2.5">
                    <p className="font-semibold text-zinc-400">
                      {stores.length === 0
                        ? `Sin clientes activos registrados para ${activeSucursalLabel}.`
                        : 'Ningún cliente coincide con el filtro actual.'}
                    </p>
                    {masterData.error && (
                      <div className="space-y-2 bg-zinc-950/90 border border-amber-700/40 rounded-xl p-3 text-left">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span
                            data-testid="master-data-error-code"
                            className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono text-[10px] font-bold"
                          >
                            [Código: {masterData.errorCode ?? 'UNKNOWN_ERR'}]
                          </span>
                          <button
                            type="button"
                            data-testid="retry-master-data-btn"
                            onClick={() => void masterData.refrescar()}
                            disabled={masterData.cargando}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-[11px] font-bold transition cursor-pointer"
                          >
                            {masterData.cargando ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3 h-3" />
                            )}
                            Reintentar carga
                          </button>
                        </div>
                        <p className="text-[11px] text-amber-300/95 leading-relaxed break-words">
                          {masterData.error}
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {visibleStoresInBatch.map((store) => {
                      const isSelected = selectedStoreIdSet.has(store.id);
                      return (
                        <label
                          key={store.id}
                          onClick={() => toggleStoreSelection(store.id)}
                          className={`flex items-center justify-between p-2 rounded-xl cursor-pointer text-xs transition border ${
                            isSelected
                              ? 'bg-red-950/30 border-red-700/60 text-white'
                              : 'bg-zinc-950/60 border-zinc-900 text-zinc-300 hover:bg-zinc-900 hover:border-zinc-800'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0 pr-2">
                            <div className="text-red-500">
                              {isSelected ? <CheckSquare className="w-4 h-4 text-red-500" /> : <Square className="w-4 h-4 text-zinc-600" />}
                            </div>
                            <div className="truncate">
                              <span className="font-bold text-white block truncate">{store.name}</span>
                              <span className="text-[10px] text-zinc-400 font-mono block">
                                {store.clientCode} • {store.zone}
                              </span>
                            </div>
                          </div>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-black text-zinc-400 border border-zinc-800 shrink-0 font-mono">
                            {store.sellerName}
                          </span>
                        </label>
                      );
                    })}
                    {filteredStoresForBatch.length > visibleStoresInBatch.length && (
                      <div className="pt-2 text-center">
                        <button
                          type="button"
                          onClick={() => setVisibleBatchStoresLimit((prev) => prev + 200)}
                          className="w-full py-1.5 px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-[11px] font-bold text-zinc-200 transition"
                        >
                          Mostrar más clientes ({visibleStoresInBatch.length} de {filteredStoresForBatch.length})
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-zinc-900 flex items-center justify-between text-xs text-zinc-400">
              <span>Total clientes seleccionados:</span>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-zinc-400">
                  {filteredStoresForBatch.length} visibles
                </span>
                <span
                  data-testid="batch-stores-selected-pill"
                  className="font-black text-white font-mono px-2 py-0.5 rounded bg-red-600 text-xs"
                >
                  {effectiveBatchStoreIds.length} elegidos
                  {hiddenSelectedCount > 0 ? ` · ${hiddenSelectedCount} ocultos` : ''}
                </span>
              </div>
            </div>
          </div>

          {/* PASO 2 & 3: PRODUCTO, JORNADA Y EJECUCIÓN (Columna 7/12) */}
          <div className="lg:col-span-7 flex flex-col justify-between space-y-4">
            
            {/* PASO 2: PRODUCTOS A DEGUSTAR (CATÁLOGO REAL + BÚSQUEDA INTELIGENTE + MULTISELECCIÓN) */}
            <div className="bg-black border border-zinc-900 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-6 h-6 rounded-lg bg-red-600/20 text-red-500 font-black flex items-center justify-center text-xs border border-red-600/30 shrink-0">
                    2
                  </div>
                  <h4 className="text-xs font-black text-white uppercase tracking-wider truncate">
                    Seleccionar Productos ({selectedBatchProducts.length} elegidos)
                  </h4>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    data-testid="select-all-batch-products-btn"
                    onClick={handleSelectAllFilteredProducts}
                    className="text-[11px] font-bold text-red-400 hover:text-red-300 transition cursor-pointer"
                  >
                    Todos
                  </button>
                  <span className="text-zinc-700 text-[10px]">|</span>
                  <button
                    type="button"
                    data-testid="clear-batch-products-btn"
                    onClick={handleDeselectAllProducts}
                    className="text-[11px] font-bold text-zinc-400 hover:text-white transition cursor-pointer"
                  >
                    Ninguno
                  </button>
                </div>
              </div>

              {/* Barra de búsqueda inteligente + filtro de presentación */}
              <div className="flex flex-col sm:flex-row gap-2 mb-3">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    data-testid="batch-product-search-input"
                    value={productSearchInBatch}
                    onChange={(e) => setProductSearchInBatch(e.target.value)}
                    placeholder="Buscar producto por nombre, código o presentación..."
                    className="w-full pl-8 pr-8 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600"
                  />
                  {productSearchInBatch && (
                    <button
                      type="button"
                      aria-label="Limpiar búsqueda de productos"
                      onClick={() => {
                        setProductSearchInBatch('');
                        setDebouncedProductSearchInBatch('');
                      }}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white transition cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {availableProductUnits.length > 1 && (
                  <select
                    data-testid="batch-product-unit-filter"
                    value={productUnitFilter}
                    onChange={(e) => setProductUnitFilter(e.target.value)}
                    className="sm:w-52 px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs font-bold text-zinc-200 focus:outline-none focus:border-red-600"
                  >
                    <option value="TODAS">
                      Todas las Presentaciones ({batchProductCatalog.length})
                    </option>
                    {availableProductUnits.map(([unit, count]) => (
                      <option key={unit} value={unit}>
                        {unit} ({count})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Etiquetas de productos seleccionados (siempre visibles al buscar otros productos) */}
              {selectedBatchProducts.length > 0 && (
                <div
                  data-testid="selected-batch-products-chips"
                  className="flex flex-wrap gap-1.5 mb-3 p-2 rounded-xl bg-zinc-950/80 border border-red-900/40 max-h-24 overflow-y-auto custom-scrollbar"
                >
                  {selectedBatchProducts.map((prod) => (
                    <span
                      key={prod.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-600/20 border border-red-500/40 text-[11px] font-bold text-red-100"
                    >
                      <span className="truncate max-w-[200px]">{prod.nombre}</span>
                      <button
                        type="button"
                        aria-label={`Quitar ${prod.nombre}`}
                        onClick={() => toggleBatchProductSelection(prod.id)}
                        className="text-red-300 hover:text-white transition cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Listado multiselección del catálogo real de productos */}
              <div
                data-testid="batch-product-list"
                className="max-h-[210px] overflow-y-auto pr-1 custom-scrollbar space-y-1.5 mb-3"
              >
                {masterEntities?.isLoading && (masterEntities?.productos?.length ?? 0) === 0 ? (
                  <div className="py-6 flex items-center justify-center gap-2 text-xs text-zinc-400">
                    <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                    <span>Cargando catálogo nacional de productos...</span>
                  </div>
                ) : masterEntities?.entityErrors?.productos &&
                  (masterEntities?.productos?.length ?? 0) === 0 ? (
                  <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-700/40 flex items-center justify-between gap-2 text-xs text-amber-300">
                    <span>{masterEntities.entityErrors.productos}</span>
                    <button
                      type="button"
                      onClick={() => void masterEntities.refresh(true)}
                      className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold shrink-0 cursor-pointer"
                    >
                      Reintentar
                    </button>
                  </div>
                ) : visibleProductsInBatch.length === 0 ? (
                  <div className="py-6 text-center text-xs text-zinc-500">
                    No se encontraron productos para &ldquo;{productSearchInBatch}&rdquo;.
                  </div>
                ) : (
                  <>
                    {visibleProductsInBatch.map((prod) => {
                      const isSelected = selectedBatchProductIdSet.has(prod.id);
                      return (
                        <button
                          key={prod.id}
                          type="button"
                          onClick={() => toggleBatchProductSelection(prod.id)}
                          className={`w-full px-3 py-2 rounded-xl border text-left flex items-center justify-between gap-2.5 transition cursor-pointer ${
                            isSelected
                              ? 'bg-red-600/20 border-red-500/70 text-white shadow-sm shadow-red-950/40'
                              : 'bg-zinc-950 border-zinc-800/90 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900/70'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            {isSelected ? (
                              <CheckSquare className="w-4 h-4 text-red-500 shrink-0" />
                            ) : (
                              <Square className="w-4 h-4 text-zinc-600 shrink-0" />
                            )}
                            <div className="min-w-0">
                              <div className="text-xs font-bold leading-snug truncate">
                                {prod.nombre}
                              </div>
                              <div className="text-[10px] text-zinc-500 font-mono truncate">
                                {prod.codigo || 'SIN CÓDIGO'}
                                {prod.marca ? ` • ${prod.marca}` : ''}
                                {prod.categoria ? ` • ${prod.categoria}` : ''}
                              </div>
                            </div>
                          </div>
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-bold shrink-0 border ${
                              isSelected
                                ? 'bg-red-600/30 border-red-500/50 text-red-100'
                                : 'bg-black border-zinc-800 text-zinc-400'
                            }`}
                          >
                            {prod.unidad}
                          </span>
                        </button>
                      );
                    })}

                    {filteredProductsForBatch.length > visibleProductsInBatch.length && (
                      <button
                        type="button"
                        onClick={() => setVisibleBatchProductsLimit((prev) => prev + 60)}
                        className="w-full py-2 rounded-xl bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 text-[11px] font-bold text-zinc-300 transition cursor-pointer"
                      >
                        Mostrar más productos ({visibleProductsInBatch.length} de{' '}
                        {filteredProductsForBatch.length})
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Cantidad, auto-insumos y contador de productos */}
              <div className="flex flex-col sm:flex-row items-center gap-3 pt-2 border-t border-zinc-900">
                <div className="w-full sm:w-1/2">
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">
                    Cantidad a Cargar por Cliente (por producto)
                  </label>
                  <input
                    type="text"
                    value={batchQuantity}
                    onChange={(e) => setBatchQuantity(e.target.value)}
                    placeholder="Ej: 1, 2, 0.9"
                    className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs font-mono font-bold text-white focus:outline-none focus:border-red-600"
                  />
                </div>

                {hasVencampoSelected ? (
                  <div className="w-full sm:w-1/2 p-2.5 rounded-xl bg-red-950/30 border border-red-800/50 text-[11px] text-zinc-200">
                    <span className="font-bold text-white block">✓ Insumos automáticos calculados:</span>
                    <span>600 g de Azúcar + 600 g de Leche en Polvo por stand.</span>
                  </div>
                ) : (
                  <div className="w-full sm:w-1/2 flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-zinc-950/70 border border-zinc-900 text-[11px] text-zinc-400">
                    <span className="truncate">
                      Catálogo:{' '}
                      <strong className="text-zinc-200 font-mono">{filteredProductsForBatch.length}</strong>{' '}
                      visibles
                    </span>
                    <span className="px-2.5 py-0.5 rounded-full bg-red-600/20 text-red-300 border border-red-600/30 font-mono font-bold text-[10px] whitespace-nowrap shrink-0">
                      {selectedBatchProducts.length} elegidos
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* PASO 3: JORNADA (MAÑANA O TARDE) Y DÍA */}
            <div className="bg-black border border-zinc-900 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-6 h-6 rounded-lg bg-red-600/20 text-red-500 font-black flex items-center justify-center text-xs border border-red-600/30">
                  3
                </div>
                <h4 className="text-xs font-black text-white uppercase tracking-wider">
                  Seleccionar Jornada y Día de Activación
                </h4>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                
                {/* SELECTOR DE JORNADA (MAÑANA O TARDE) */}
                <div>
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1.5">
                    Jornada Operativa
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setBatchShift('MAÑANA')}
                      className={`py-3 px-3 rounded-xl border text-xs font-black uppercase flex flex-col items-center justify-center gap-1 transition ${
                        batchShift === 'MAÑANA'
                          ? 'bg-red-600 text-white border-red-500 shadow-md shadow-red-950'
                          : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-white hover:border-zinc-700'
                      }`}
                    >
                      <Sun className="w-4 h-4 text-white" />
                      <span>☀️ MAÑANA</span>
                      <span className="text-[9px] font-mono opacity-80">08:00 - 13:00</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setBatchShift('TARDE')}
                      className={`py-3 px-3 rounded-xl border text-xs font-black uppercase flex flex-col items-center justify-center gap-1 transition ${
                        batchShift === 'TARDE'
                          ? 'bg-red-600 text-white border-red-500 shadow-md shadow-red-950'
                          : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-white hover:border-zinc-700'
                      }`}
                    >
                      <Moon className="w-4 h-4 text-white" />
                      <span>🌙 TARDE</span>
                      <span className="text-[9px] font-mono opacity-80">14:00 - 18:00</span>
                    </button>
                  </div>
                </div>

                {/* SELECTOR DE FECHA REAL CON SEMANA AUTOMÁTICA */}
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                      Fecha de Despliegue ({batchDay})
                    </label>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setBatchWeekOffset((w) => w - 1)}
                        className="p-1 rounded bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 cursor-pointer"
                        title="Semana anterior"
                      >
                        <ChevronLeft className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsBatchDateManual(false);
                          setBatchWeekOffset(0);
                          setBatchDate(liveClock.todayYmd);
                        }}
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border transition cursor-pointer ${
                          !isBatchDateManual && batchWeekOffset === 0
                            ? 'bg-red-600/20 text-red-300 border-red-500/40'
                            : 'bg-zinc-950 text-zinc-400 hover:text-white border-zinc-800'
                        }`}
                        title="Sincronizar automáticamente con la fecha y semana en curso"
                      >
                        Sem {batchRollingWeek.isoWeekNumber} {!isBatchDateManual && batchWeekOffset === 0 ? '· Auto' : ''}
                      </button>
                      <button
                        type="button"
                        onClick={() => setBatchWeekOffset((w) => w + 1)}
                        className="p-1 rounded bg-zinc-950 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 cursor-pointer"
                        title="Semana siguiente"
                      >
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Tira rápida de los 7 días de la semana activa (avanza automáticamente cada semana) */}
                  <div className="grid grid-cols-7 gap-1 mb-2">
                    {batchRollingWeek.days.map((d) => {
                      const isPicked = batchDate === d.ymd;
                      return (
                        <button
                          key={d.ymd}
                          type="button"
                          onClick={() => {
                            setBatchDate(d.ymd);
                            setIsBatchDateManual(d.ymd !== liveClock.todayYmd);
                          }}
                          className={`py-1 px-0.5 rounded-lg border text-center font-mono transition cursor-pointer ${
                            isPicked
                              ? 'bg-red-600 text-white border-red-400 font-black shadow-sm'
                              : d.isToday
                                ? 'bg-zinc-900 text-red-300 border-red-500/50 font-bold'
                                : 'bg-zinc-950 text-zinc-400 hover:text-white border-zinc-800'
                          }`}
                          title={`${d.dayLabel}${d.isToday ? ' (Hoy)' : ''}`}
                        >
                          <span className="text-[9px] block leading-tight">{d.shortDayName}</span>
                          <span className="text-[11px] block leading-tight">{d.dayNumber}</span>
                        </button>
                      );
                    })}
                  </div>

                  <input
                    type="date"
                    value={batchDate}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val) {
                        setBatchDate(val);
                        setIsBatchDateManual(val !== liveClock.todayYmd);
                      }
                    }}
                    className="w-full py-2 px-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs font-mono font-bold text-white focus:outline-none focus:border-red-600"
                  />
                </div>

              </div>

              {/* Promotora asignada y notas operativas del lote */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 pt-3 border-t border-zinc-900">
                <div>
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">
                    Promotora Asignada ({activePromotoraOptions.length} activas)
                  </label>
                  <SmartSearchCombobox
                    testId="batch-promotora-select"
                    searchTestId="batch-promotora-search"
                    ariaLabel="Seleccionar promotora asignada para el lote"
                    value={batchPromotora}
                    onChange={(nextVal) => setBatchPromotora(nextVal)}
                    searchPlaceholder="Buscar promotora por nombre..."
                    options={[
                      {
                        value: 'AUTO',
                        label: 'Asignación Automática (Disponible)',
                        sublabel: 'Selecciona automáticamente la promotora disponible',
                        badge: 'AUTO',
                        keywords: 'auto automatica disponible',
                        pinned: true,
                      },
                      ...activePromotoraOptions.map((p) => {
                        const conflict = isPromotoraBooked(p.name, batchDay, batchShift, undefined, batchDate);
                        return {
                          value: p.name,
                          label: p.name,
                          sublabel: conflict
                            ? `⛔ Ocupada en ${conflict.storeName}`
                            : '✓ Disponible en esta jornada',
                          badge: conflict ? 'OCUPADA' : '✓',
                          keywords: `${p.name} ${conflict ? 'ocupada' : 'disponible'}`,
                        };
                      }),
                    ]}
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">
                    Notas / Observaciones Operativas (Opcional)
                  </label>
                  <input
                    type="text"
                    data-testid="batch-notes-input"
                    value={batchNotes}
                    onChange={(e) => setBatchNotes(e.target.value)}
                    placeholder="Ej: Instrucciones de stand, horario especial..."
                    maxLength={500}
                    className="w-full py-2 px-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600"
                  />
                </div>
              </div>
            </div>

            {/* BOTÓN PRINCIPAL DE DISPARO DEL LOTE */}
            <div className="pt-2">
              <button
                type="button"
                disabled={isPersistingMatrix}
                onClick={() => void handleExecuteBatchFill()}
                className="w-full py-4 px-6 rounded-2xl bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-black text-sm uppercase tracking-wider border-2 border-red-400 shadow-2xl shadow-red-950 flex items-center justify-center gap-3 transition transform active:scale-[0.99]"
              >
                {isPersistingMatrix ? (
                  <Loader2 className="w-5 h-5 text-white animate-spin" />
                ) : (
                  <Zap className="w-5 h-5 text-white" />
                )}
                <span>
                  {isPersistingMatrix
                    ? 'PERSISTIENDO LOTE EN SUPABASE...'
                    : 'EJECUTAR LLENADO POR LOTE A LA TABLA GENERAL'}
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-black/40 text-white font-mono text-xs border border-white/20">
                  {effectiveBatchStoreIds.length} Clientes • {batchProductBadgeLabel} • {batchShift}
                </span>
              </button>
              <button
                type="button"
                disabled={isPersistingMatrix}
                onClick={() => setIsClearModalOpen(true)}
                className="mt-2 w-full py-2.5 px-4 rounded-xl bg-zinc-950 hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 hover:text-red-300 font-black text-xs uppercase tracking-wider border border-red-700/60 flex items-center justify-center gap-2 transition"
              >
                <Trash2 className="w-4 h-4" />
                <span>CANCELAR POR LOTE (LÓGICO) / NUEVA CARGA</span>
              </button>
            </div>

          </div>

        </div>
      </div>

      {isClearModalOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[90] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget && !isPersistingMatrix) {
              setIsClearModalOpen(false);
              setClearAllConfirmText('');
            }
          }}
        >
          <div className="w-full max-w-lg bg-zinc-950 border border-red-700/60 rounded-2xl p-5 shadow-2xl shadow-red-950/60 space-y-4">
            <div className="flex items-center justify-between gap-2 text-white font-black uppercase text-sm tracking-wider">
              <span className="flex items-center gap-2">
                <Trash2 className="w-5 h-5 text-red-500" /> Cancelación lógica por lote / Nueva carga
              </span>
              <button
                type="button"
                aria-label="Cerrar modal de cancelación"
                disabled={isPersistingMatrix}
                onClick={() => {
                  setIsClearModalOpen(false);
                  setClearAllConfirmText('');
                }}
                className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-900 cursor-pointer disabled:opacity-40"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs font-black uppercase">
              <button type="button" onClick={() => setClearMode('FILTERED')}
                className={`py-2 rounded-xl border transition ${clearMode === 'FILTERED' ? 'bg-red-600 text-white border-red-400' : 'bg-black text-zinc-400 border-zinc-800'}`}>
                Solo coincidencias
              </button>
              <button type="button" onClick={() => setClearMode('ALL')}
                className={`py-2 rounded-xl border transition ${clearMode === 'ALL' ? 'bg-red-600 text-white border-red-400' : 'bg-black text-zinc-400 border-zinc-800'}`}>
                Cancelar todos los pendientes
              </button>
            </div>

            {clearMode === 'FILTERED' ? (
              <div className="space-y-2 text-xs text-zinc-300">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={clearByClients} onChange={(e) => setClearByClients(e.target.checked)} className="accent-red-600" />
                  Clientes marcados y visibles ({effectiveBatchStoreIds.length})
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={clearByProduct} onChange={(e) => setClearByProduct(e.target.checked)} className="accent-red-600" />
                  Productos seleccionados ({batchProductBadgeLabel})
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={clearByShiftDate} onChange={(e) => setClearByShiftDate(e.target.checked)} className="accent-red-600" />
                  Jornada y fecha activas ({batchShift} · {batchDay})
                </label>
              </div>
            ) : (
              <div className="space-y-1.5 text-xs text-zinc-300">
                <p className="text-red-300 font-bold">Se marcarán como CANCELADA las filas PENDIENTE (se preservan históricas/completadas sin borrado físico). Escribe VACIAR para confirmar:</p>
                <input value={clearAllConfirmText} onChange={(e) => setClearAllConfirmText(e.target.value)} placeholder="VACIAR"
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs font-mono text-white focus:outline-none focus:border-red-600" />
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
              <input type="checkbox" checked={clearResetSteps} onChange={(e) => setClearResetSteps(e.target.checked)} className="accent-red-600" />
              Resetear pasos 1, 2 y 3 (clientes en Ninguno, cantidad 1)
            </label>

            <div className="p-3 rounded-xl bg-red-950/30 border border-red-800/50 text-xs text-zinc-200">
              Se cancelarán lógicamente <b className="text-white">{clearPreview.pending}</b> registros (archivados en Historial sin <span className="font-mono">DELETE</span>).
              {clearPreview.preserved > 0 && <> <b className="text-white">{clearPreview.preserved}</b> no están PENDIENTE o ya son históricos y se preservarán.</>}
            </div>

            <div className="flex justify-end gap-2">
              <button type="button" disabled={isPersistingMatrix} onClick={() => { setIsClearModalOpen(false); setClearAllConfirmText(''); }}
                className="px-4 py-2 rounded-xl bg-black border border-zinc-800 text-zinc-300 text-xs font-bold hover:text-white disabled:opacity-40">
                Cancelar
              </button>
              <button type="button" onClick={() => void handleConfirmClear()}
                disabled={isPersistingMatrix || (clearMode === 'ALL' && clearAllConfirmText.trim().toUpperCase() !== 'VACIAR')}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-black uppercase border border-red-400 inline-flex items-center gap-1.5">
                {isPersistingMatrix && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isPersistingMatrix ? 'Cancelando...' : 'Confirmar cancelación lógica'}</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Filter and Search Bar for Table + Navegador Automático de Semanas */}
      <div id="tabla-general-matriz" className="bg-zinc-950 border border-zinc-900 p-4 rounded-2xl space-y-3">
        {/* Fila 1: Navegador Automático de Semanas y Días */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-2.5 pb-3 border-b border-zinc-900">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedDay('TODOS')}
              className={`px-3 py-1.5 rounded-lg text-xs font-black tracking-wide uppercase transition cursor-pointer ${
                selectedDay === 'TODOS'
                  ? 'bg-red-600 text-white shadow-sm border border-red-500'
                  : 'bg-black text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              Todas ({visits.length})
            </button>

            <button
              type="button"
              onClick={() => {
                setTableWeekOffset(0);
                setSelectedDay('SEMANA_ACTUAL');
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
                selectedDay === 'SEMANA_ACTUAL'
                  ? 'bg-red-600 text-white border border-red-500 shadow-sm'
                  : 'bg-black text-zinc-300 hover:text-white border border-zinc-800 hover:border-red-500/40'
              }`}
              title="Filtra automáticamente los 7 días de la semana en curso (avanza solo cada lunes)"
            >
              <Calendar className="w-3.5 h-3.5 text-red-400" />
              <span>Semana Actual Auto ({liveClock.currentWeek.shortRangeLabel})</span>
            </button>

            {/* Controles Semana Anterior / Siguiente */}
            <div className="inline-flex items-center gap-1 bg-black p-1 rounded-lg border border-zinc-800">
              <button
                type="button"
                onClick={() => {
                  setTableWeekOffset((prev) => prev - 1);
                  setSelectedDay('SEMANA_NAV');
                }}
                className="p-1 rounded hover:bg-zinc-900 text-zinc-300 hover:text-white cursor-pointer"
                title="Ir a la semana anterior"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setSelectedDay('SEMANA_NAV')}
                className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold transition cursor-pointer ${
                  selectedDay === 'SEMANA_NAV'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-300 hover:text-white'
                }`}
              >
                Sem {tableRollingWeek.isoWeekNumber}: {tableRollingWeek.rangeLabel}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTableWeekOffset((prev) => prev + 1);
                  setSelectedDay('SEMANA_NAV');
                }}
                className="p-1 rounded hover:bg-zinc-900 text-zinc-300 hover:text-white cursor-pointer"
                title="Ir a la semana siguiente"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Píldoras de los 7 días de la semana visible */}
          <div className="flex flex-wrap items-center gap-1">
            {tableRollingWeek.days.map((d) => {
              const dayCount = visitsCountByYmd.get(d.ymd) || 0;
              const isDayActive = selectedDay === d.ymd;
              return (
                <button
                  key={d.ymd}
                  type="button"
                  onClick={() => setSelectedDay(isDayActive ? 'TODOS' : d.ymd)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition flex items-center gap-1.5 cursor-pointer ${
                    isDayActive
                      ? 'bg-red-600 text-white border-red-400 font-black'
                      : d.isToday
                        ? 'bg-zinc-900 text-white border-red-500/50 font-bold'
                        : 'bg-black text-zinc-400 hover:text-white border-zinc-800'
                  }`}
                  title={`${d.dayLabel}${d.isToday ? ' (Hoy)' : ''} · ${dayCount} registros`}
                >
                  <span>
                    {d.shortDayName} {d.ddMm}
                  </span>
                  {dayCount > 0 && (
                    <span
                      className={`text-[9px] px-1 rounded ${
                        isDayActive ? 'bg-black/40 text-white' : 'bg-red-500/20 text-red-300'
                      }`}
                    >
                      {dayCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Fila 2: Calendario puntual + Jornada + Producto + Búsqueda */}
        <div className="flex flex-col lg:flex-row items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
            {/* Filtro por fecha o rango (dd-mm-aaaa) */}
            <div className="flex flex-wrap items-center gap-1.5 bg-black px-2 py-1 rounded-lg border border-zinc-900">
              <Calendar className="w-3.5 h-3.5 text-red-500 shrink-0" />
              <div className="relative inline-flex items-center">
                <input
                  type="text"
                  value={matrixDateFrom}
                  placeholder="Desde dd-mm-aaaa"
                  onChange={(e) => {
                    setMatrixDateFrom(e.target.value);
                    if (e.target.value.trim()) setSelectedDay('TODOS');
                  }}
                  onBlur={() => {
                    if (!matrixDateFrom.trim()) return;
                    const formatted = formatToDdMmYyyy(matrixDateFrom);
                    if (formatted) setMatrixDateFrom(formatted);
                  }}
                  className="w-[126px] pl-2 pr-6 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-xs font-mono text-white placeholder-zinc-500 focus:outline-none focus:border-red-600"
                  title="Filtrar desde fecha (dd-mm-aaaa)"
                />
                <label
                  className="absolute right-1.5 inline-flex items-center text-zinc-400 hover:text-white cursor-pointer"
                  title="Elegir fecha inicial en calendario"
                >
                  <Calendar className="w-3 h-3 pointer-events-none" />
                  <input
                    type="date"
                    tabIndex={-1}
                    aria-hidden="true"
                    value={normalizeExcelDate(matrixDateFrom).fechaIso || ''}
                    onChange={(e) => {
                      const formatted = formatToDdMmYyyy(e.target.value);
                      setMatrixDateFrom(formatted);
                      if (formatted) setSelectedDay('TODOS');
                    }}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                </label>
              </div>
              <span className="text-zinc-600 text-xs">—</span>
              <div className="relative inline-flex items-center">
                <input
                  type="text"
                  value={matrixDateTo}
                  placeholder="Hasta dd-mm-aaaa"
                  onChange={(e) => {
                    setMatrixDateTo(e.target.value);
                    if (e.target.value.trim()) setSelectedDay('TODOS');
                  }}
                  onBlur={() => {
                    if (!matrixDateTo.trim()) return;
                    const formatted = formatToDdMmYyyy(matrixDateTo);
                    if (formatted) setMatrixDateTo(formatted);
                  }}
                  className="w-[126px] pl-2 pr-6 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-xs font-mono text-white placeholder-zinc-500 focus:outline-none focus:border-red-600"
                  title="Filtrar hasta fecha (dd-mm-aaaa)"
                />
                <label
                  className="absolute right-1.5 inline-flex items-center text-zinc-400 hover:text-white cursor-pointer"
                  title="Elegir fecha final en calendario"
                >
                  <Calendar className="w-3 h-3 pointer-events-none" />
                  <input
                    type="date"
                    tabIndex={-1}
                    aria-hidden="true"
                    value={normalizeExcelDate(matrixDateTo).fechaIso || ''}
                    onChange={(e) => {
                      const formatted = formatToDdMmYyyy(e.target.value);
                      setMatrixDateTo(formatted);
                      if (formatted) setSelectedDay('TODOS');
                    }}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                </label>
              </div>
              {(matrixDateFrom.trim() || matrixDateTo.trim()) && (
                <button
                  type="button"
                  onClick={() => {
                    setMatrixDateFrom('');
                    setMatrixDateTo('');
                  }}
                  title="Limpiar rango de fechas"
                  className="p-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-900 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Shift filter */}
            <div className="flex items-center gap-1 bg-black p-1 rounded-lg border border-zinc-900">
              {['TODOS', 'MAÑANA', 'TARDE'].map((shift) => (
                <button
                  key={shift}
                  onClick={() => setSelectedShift(shift)}
                  className={`px-3 py-1 rounded text-xs font-black tracking-wide uppercase transition ${
                    selectedShift === shift
                      ? 'bg-red-600 text-white shadow-sm border border-red-500'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {shift}
                </button>
              ))}
            </div>

            {/* Product filter — 5 opciones oficiales exactas */}
            <div
              className="flex flex-wrap items-center gap-1 bg-black p-1 rounded-lg border border-zinc-900"
              data-testid="module2-product-filter-bar"
            >
              {MODULE2_PRODUCT_FILTER_OPTIONS.map((prod) => (
                <button
                  key={prod}
                  type="button"
                  data-testid={`module2-product-filter-${prod}`}
                  onClick={() => setSelectedProduct(prod)}
                  className={`px-3 py-1 rounded text-xs font-black tracking-wide uppercase transition cursor-pointer ${
                    selectedProduct === prod
                      ? 'bg-red-600 text-white shadow-sm border border-red-500'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {prod}
                </button>
              ))}
            </div>
          </div>

          {/* Search */}
          <div className="relative w-full lg:w-72">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Buscar tienda, promotora, zona..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-black border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600"
            />
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 📊 TABLA GENERAL CONSOLIDADA (RESULTADO EN TIEMPO REAL) */}
      {/* ========================================================================= */}
      <div className="bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden shadow-2xl">
        <div className="p-4 bg-black border-b border-zinc-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-xl bg-red-600 text-white shadow-md shadow-red-950">
              <FileSpreadsheet className="w-5 h-5" />
            </span>
            <div>
              <h3 className="text-base font-black text-white uppercase tracking-wider flex items-center gap-2">
                <span>Tabla General de Activaciones</span>
                <span className="text-xs px-2 py-0.5 rounded bg-zinc-900 text-zinc-300 border border-zinc-800 font-mono">
                  {filteredVisits.length} Registros
                </span>
              </h3>
              <p className="text-[11px] text-zinc-400">
                Poblada automáticamente por el motor de lotes o modificable directamente en línea.
              </p>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-2">
            <ExportPdfButton
              variant="compact"
              label="Exportar a PDF"
              documentTitle="Tabla General Consolidada de PDVs"
              onExportPdf={() =>
                exportScheduleMatrixPdf(filteredVisits, selectedDay, {
                  mortadela: totalMortadela,
                  vencampo: totalVencampoStands,
                  azucar: totalAzucarGrams,
                  leche: totalLecheGrams,
                  espalda: totalEspalda,
                })
              }
            />

            <button
              type="button"
              onClick={handleToggleSelectAllVisibleVisits}
              disabled={visibleTableVisitIds.length === 0}
              title="Seleccionar o deseleccionar todos los registros visibles en la tabla"
              className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 border transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                allVisibleTableSelected
                  ? 'bg-red-950/60 text-red-300 border-red-600/60 hover:bg-red-950'
                  : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border-zinc-800'
              }`}
            >
              {allVisibleTableSelected ? (
                <CheckSquare className="w-3.5 h-3.5 text-red-500" />
              ) : (
                <Square className="w-3.5 h-3.5 text-zinc-400" />
              )}
              <span>
                {allVisibleTableSelected ? 'Deseleccionar Todo / Lote' : 'Seleccionar Todo / Lote'}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-black/60 text-red-400 border border-red-900/50 font-mono text-[10px]">
                Seleccionados: {selectedTableVisitIds.length}
              </span>
            </button>

            <button
              type="button"
              onClick={handleClickDeleteSelected}
              title={
                selectedTableVisitIds.length > 0
                  ? `Eliminar los ${selectedTableVisitIds.length} registros seleccionados`
                  : 'Selecciona al menos un registro en la tabla para limpiar'
              }
              className={`px-3 py-1.5 rounded-xl text-xs font-black uppercase tracking-wide flex items-center gap-1.5 border transition cursor-pointer ${
                selectedTableVisitIds.length > 0
                  ? 'bg-red-600 hover:bg-red-700 text-white border-red-400 shadow-lg shadow-red-950/60'
                  : 'bg-zinc-900/70 hover:bg-zinc-900 text-zinc-500 border-zinc-800'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Limpiar Seleccionados</span>
              {selectedTableVisitIds.length > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-black/40 text-white font-mono text-[10px]">
                  {selectedTableVisitIds.length}
                </span>
              )}
            </button>
          </div>
        </div>

        <AnimatedTabContainer tabKey={`${selectedDay}:${tableWeekOffset}`} className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-black border-b border-zinc-800 text-zinc-400 font-black uppercase text-[10px] tracking-wider">
                <th className="p-3 text-center w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleTableSelected}
                    onChange={handleToggleSelectAllVisibleVisits}
                    disabled={visibleTableVisitIds.length === 0}
                    title="Marcar o desmarcar todas las filas visibles"
                    className="w-4 h-4 rounded accent-red-600 cursor-pointer disabled:opacity-40"
                  />
                </th>
                <th className="p-3 text-center w-12">#</th>
                <th className="p-3">Día</th>
                <th className="p-3">Jornada</th>
                <th className="p-3">Cliente / Punto de Venta</th>
                
                {/* PRODUCT FILL INPUT COLUMN */}
                <th className="p-3 bg-red-950/30 border-l border-r border-red-900/60 text-red-300 text-center font-black">
                  Producto Llenado
                </th>
                <th className="p-3 bg-red-950/30 border-r border-red-900/60 text-red-300 text-center font-black w-24">
                  Cantidad
                </th>

                {/* GENERAL TABLE CALCULATED COLUMNS */}
                <th className="p-3 text-center bg-zinc-900/40 text-red-400 font-black">Mortadela (un)</th>
                <th className="p-3 text-center bg-zinc-900/40 text-white font-black">Espalda (un)</th>
                <th className="p-3 text-center bg-zinc-900/40 text-white font-black">Arroz (un)</th>
                <th className="p-3 text-center bg-zinc-900/40 text-zinc-300 font-mono">Azúcar (g)</th>
                <th className="p-3 text-center bg-zinc-900/40 text-zinc-300 font-mono">Leche (g)</th>

                {/* OPERATIONS */}
                <th className="p-3">Vendedor</th>
                <th className="p-3">Promotora</th>
                <th className="p-3">Ubicación / Sector</th>
                <th className="p-3 text-center">Estado</th>
                <th className="p-3 text-center w-10"></th>
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-900 text-zinc-200">
              {filteredVisits.length === 0 && (
                <tr>
                  <td colSpan={15} className="p-8 text-center text-zinc-500 font-mono text-xs">
                    0 REGISTROS — No hay activaciones cargadas para los filtros actuales.
                  </td>
                </tr>
              )}
              {filteredVisits.map((v, idx) => {
                const isRowSelected = selectedTableVisitIds.includes(v.id);
                const isGreenHighlight = v.rowHighlight === 'green' || v.arrozQty > 0 || v.productFocus.includes('VENCAMPO');
                const isYellowHighlight = v.rowHighlight === 'yellow';

                return (
                  <tr 
                    key={v.id} 
                    className={`transition ${
                      isRowSelected
                        ? 'bg-red-950/40 hover:bg-red-950/55 border-l-2 border-l-red-500'
                        : isGreenHighlight 
                        ? 'bg-red-950/15 hover:bg-red-950/30' 
                        : isYellowHighlight 
                        ? 'bg-zinc-900/40 hover:bg-zinc-900/70' 
                        : 'hover:bg-zinc-900/50'
                    }`}
                  >
                    {/* Checkbox de selección por fila */}
                    <td className="p-3 text-center">
                      <input
                        type="checkbox"
                        checked={isRowSelected}
                        onChange={() => toggleTableVisitSelection(v.id)}
                        title={`Seleccionar registro de ${v.storeName}`}
                        className="w-4 h-4 rounded accent-red-600 cursor-pointer"
                      />
                    </td>

                    {/* Index */}
                    <td className="p-3 text-center font-mono text-zinc-500 text-[10px]">
                      {idx + 1}
                    </td>

                    {/* Day */}
                    <td className="p-3 font-bold text-white whitespace-nowrap">
                      <div>{v.dayLabel || formatToDdMmYyyy(v.date, '-- -- ----')}</div>
                      {v.date && (
                        <div className="text-[10px] font-mono text-zinc-400 font-normal">
                          {formatToDdMmYyyy(v.date, '')}
                        </div>
                      )}
                    </td>

                    {/* Shift / Jornada */}
                    <td className="p-3 whitespace-nowrap">
                      <span className={`text-[10px] px-2 py-0.5 rounded font-black font-mono border ${
                        v.shift === 'MAÑANA'
                          ? 'bg-zinc-900 text-white border-zinc-700'
                          : 'bg-black text-red-400 border-red-900'
                      }`}>
                        {v.shift === 'MAÑANA' ? '☀️ MAÑANA' : '🌙 TARDE'}
                      </span>
                    </td>

                    {/* Store Name & Link */}
                    <td className="p-3 font-bold text-white min-w-[200px]">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <StoreIcon className="w-3.5 h-3.5 text-red-500 shrink-0" />
                        <span>{v.storeName}</span>
                        {(v.solicitudId || v.degustacionId) && (
                          <span
                            className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-red-950/70 text-red-300 border border-red-800/60 font-bold"
                            title={`Sincronizado automáticamente desde Promotoras y FDV (ID: ${v.degustacionId || v.solicitudId})`}
                          >
                            FDV Sinc.
                          </span>
                        )}
                      </div>
                      {v.operationalSupplies && (
                        <div className="text-[9px] font-mono text-zinc-400 mt-0.5">
                          Insumos: {v.operationalSupplies.servilletas} serv. · {v.operationalSupplies.palillos} palillos · {v.operationalSupplies.envases} envases
                        </div>
                      )}
                      {v.mapsUrl && (
                        <a 
                          href={v.mapsUrl} 
                          target="_blank" 
                          rel="noreferrer" 
                          className="text-[10px] text-red-400 hover:text-red-300 flex items-center gap-1 mt-0.5"
                        >
                          <ExternalLink className="w-2.5 h-2.5" />
                          <span>Google Maps</span>
                        </a>
                      )}
                    </td>

                    {/* INTERACTIVE COLUMN 1: Llenado - Selector Inteligente de Producto (152 artículos vigentes) */}
                    <td className="p-2 bg-red-950/20 border-l border-r border-red-900/40 min-w-[190px]">
                      {(() => {
                        const currentProductVal =
                          v.productFocus?.trim() ||
                          (v.fillProductSelection?.includes('ARROZ')
                            ? 'VENCAMPO'
                            : v.fillProductSelection || 'MORTADELA');
                        const rowProductOptions: SmartSearchComboboxOption[] = productComboboxOptions.some(
                          (opt) => opt.value.toUpperCase() === currentProductVal.toUpperCase()
                        )
                          ? productComboboxOptions
                          : [
                              {
                                value: currentProductVal,
                                label: currentProductVal,
                                sublabel: 'Producto actual en registro',
                                badge: 'ACTUAL',
                              },
                              ...productComboboxOptions,
                            ];
                        return (
                          <SmartSearchCombobox
                            compact
                            disabled={isVisitSaving(v.id)}
                            ariaLabel={`Seleccionar producto para ${v.storeName}`}
                            value={currentProductVal}
                            onChange={(newProd) => {
                              const currentQty = v.fillQuantityInput || String(v.plannedUnits || 1);
                              void handleInlineProductFill(v.id, newProd, currentQty);
                            }}
                            options={rowProductOptions}
                            searchPlaceholder="Buscar artículo por nombre o código..."
                            panelMinWidth={320}
                            triggerClassName="bg-black border-red-900/60"
                          />
                        );
                      })()}
                    </td>

                    {/* INTERACTIVE COLUMN 2: Llenado - Cantidad Input (Editable) */}
                    <td className="p-2 bg-red-950/20 border-r border-red-900/40">
                      <input
                        type="number"
                        min="1"
                        max="99"
                        value={
                          v.fillQuantityInput !== undefined && v.fillQuantityInput !== 'ARROZ' && v.fillQuantityInput !== ''
                            ? v.fillQuantityInput
                            : v.plannedUnits || 1
                        }
                        onChange={(e) => {
                          const newQty = e.target.value;
                          const currentProd = v.fillProductSelection || v.productFocus;
                          void handleInlineProductFill(v.id, currentProd, newQty);
                        }}
                        className="w-full px-2 py-1.5 rounded-lg bg-black border border-red-900/60 text-center font-mono font-bold text-white text-xs focus:outline-none focus:border-red-500 hover:border-red-600 transition"
                        placeholder="1"
                        title="Cantidad principal editable (persiste en Supabase)"
                      />
                    </td>

                    {/* CALCULATED & EDITABLE PRODUCT QUANTITY COLUMNS */}
                    {/* Mortadela */}
                    <td className="p-1.5 text-center font-mono bg-zinc-900/20">
                      <input
                        type="number"
                        min="0"
                        max="99"
                        value={v.mortadelaQty || 0}
                        onChange={(e) => {
                          const val = Math.max(0, parseInt(e.target.value, 10) || 0);
                          void handleInlineVisitPatch(v.id, {
                            mortadelaQty: val,
                            plannedUnits: val > 0 ? val : v.plannedUnits,
                            fillQuantityInput: val > 0 ? String(val) : v.fillQuantityInput,
                          });
                        }}
                        className={`w-14 px-1 py-1 rounded text-center font-mono text-xs focus:outline-none focus:ring-1 focus:ring-red-500 transition ${
                          v.mortadelaQty > 0
                            ? 'bg-red-600 text-white border border-red-400 font-black shadow'
                            : 'bg-black/50 text-zinc-500 border border-zinc-800 hover:border-zinc-700'
                        }`}
                        title="Cantidad Mortadela (editable)"
                      />
                    </td>

                    {/* Espalda */}
                    <td className="p-1.5 text-center font-mono bg-zinc-900/20">
                      <input
                        type="number"
                        min="0"
                        max="99"
                        value={v.espaldaQty || 0}
                        onChange={(e) => {
                          const val = Math.max(0, parseInt(e.target.value, 10) || 0);
                          void handleInlineVisitPatch(v.id, {
                            espaldaQty: val,
                            plannedUnits: val > 0 ? val : v.plannedUnits,
                            fillQuantityInput: val > 0 ? String(val) : v.fillQuantityInput,
                          });
                        }}
                        className={`w-14 px-1 py-1 rounded text-center font-mono text-xs focus:outline-none focus:ring-1 focus:ring-red-500 transition ${
                          v.espaldaQty > 0
                            ? 'bg-black text-red-400 border border-red-800 font-bold'
                            : 'bg-black/50 text-zinc-500 border border-zinc-800 hover:border-zinc-700'
                        }`}
                        title="Cantidad Espalda (editable)"
                      />
                    </td>

                    {/* Arroz */}
                    <td className="p-1.5 text-center font-mono bg-zinc-900/20">
                      <input
                        type="number"
                        min="0"
                        max="99"
                        value={v.arrozQty || 0}
                        onChange={(e) => {
                          const val = Math.max(0, parseInt(e.target.value, 10) || 0);
                          void handleInlineVisitPatch(v.id, {
                            arrozQty: val,
                            plannedUnits: val > 0 ? val : v.plannedUnits,
                            fillQuantityInput: val > 0 ? String(val) : v.fillQuantityInput,
                            additionalGoods: { ...v.additionalGoods, arrozKg: val },
                          });
                        }}
                        className={`w-14 px-1 py-1 rounded text-center font-mono text-xs focus:outline-none focus:ring-1 focus:ring-red-500 transition ${
                          v.arrozQty > 0
                            ? 'bg-zinc-900 text-white border border-zinc-700 font-bold'
                            : 'bg-black/50 text-zinc-500 border border-zinc-800 hover:border-zinc-700'
                        }`}
                        title="Cantidad Arroz (editable)"
                      />
                    </td>

                    {/* Azúcar (g) */}
                    <td className="p-1.5 text-center font-mono text-zinc-300 bg-zinc-900/20">
                      <input
                        type="number"
                        min="0"
                        step="50"
                        value={v.azucarGrams || 0}
                        onChange={(e) => {
                          const val = Math.max(0, parseInt(e.target.value, 10) || 0);
                          void handleInlineVisitPatch(v.id, {
                            azucarGrams: val,
                            additionalGoods: { ...v.additionalGoods, azucarKg: val / 1000 },
                          });
                        }}
                        className={`w-16 px-1 py-1 rounded text-center font-mono text-xs focus:outline-none focus:ring-1 focus:ring-red-500 transition ${
                          v.azucarGrams > 0
                            ? 'bg-zinc-900 text-white font-bold border border-zinc-700'
                            : 'bg-black/50 text-zinc-500 border border-zinc-800 hover:border-zinc-700'
                        }`}
                        title="Azúcar en gramos (editable)"
                      />
                    </td>

                    {/* Leche (g) */}
                    <td className="p-1.5 text-center font-mono text-zinc-300 bg-zinc-900/20">
                      <input
                        type="number"
                        min="0"
                        step="50"
                        value={v.lecheGrams || 0}
                        onChange={(e) => {
                          const val = Math.max(0, parseInt(e.target.value, 10) || 0);
                          void handleInlineVisitPatch(v.id, {
                            lecheGrams: val,
                            additionalGoods: { ...v.additionalGoods, lecheKg: val / 1000 },
                          });
                        }}
                        className={`w-16 px-1 py-1 rounded text-center font-mono text-xs focus:outline-none focus:ring-1 focus:ring-red-500 transition ${
                          v.lecheGrams > 0
                            ? 'bg-zinc-900 text-white font-bold border border-zinc-700'
                            : 'bg-black/50 text-zinc-500 border border-zinc-800 hover:border-zinc-700'
                        }`}
                        title="Leche en gramos (editable)"
                      />
                    </td>

                    {/* Vendedor */}
                    <td className="p-3 font-mono text-zinc-300 whitespace-nowrap">
                      {v.sellerName}
                    </td>

                    {/* Promotora (Selectable & Auto-loads Location - Validando conflicto en misma jornada) */}
                    <td className="p-2 whitespace-nowrap min-w-[190px]">
                      {(() => {
                        const activePromotoraUsers = users.filter((u) => u.role === 'promotora');
                        const currentKey = canonicalStaffKey(v.promotoraName);
                        const matchedActiveUser = activePromotoraUsers.find(
                          (u) => canonicalStaffKey(u.name) === currentKey
                        );
                        const selectedValue = matchedActiveUser
                          ? matchedActiveUser.name
                          : 'POR ASIGNAR (Trade Marketing)';
                        const currentConflict = isPromotoraBooked(
                          v.promotoraName,
                          v.dayLabel,
                          v.shift,
                          v.id,
                          v.date
                        );
                        const rowPromotoraOptions: SmartSearchComboboxOption[] = [
                          ...(!matchedActiveUser
                            ? [
                                {
                                  value: 'POR ASIGNAR (Trade Marketing)',
                                  label: 'POR ASIGNAR (Trade Marketing)',
                                  sublabel: 'Sin promotora asignada',
                                  badge: 'PEND.',
                                },
                              ]
                            : []),
                          ...activePromotoraUsers.map((u) => {
                            const fullName = u.name;
                            const conflictVisit = isPromotoraBooked(
                              fullName,
                              v.dayLabel,
                              v.shift,
                              v.id,
                              v.date
                            );
                            const isCurrent =
                              canonicalStaffKey(v.promotoraName) === canonicalStaffKey(fullName);
                            const isDisabled = Boolean(conflictVisit && !isCurrent);
                            return {
                              value: fullName,
                              label: fullName,
                              sublabel: isDisabled
                                ? `⛔ Ocupada en ${conflictVisit!.storeName}`
                                : '✓ Disponible en esta jornada',
                              badge: isDisabled ? 'OCUPADA' : '✓',
                              disabled: isDisabled,
                              keywords: `${fullName} ${isDisabled ? 'ocupada' : 'disponible'}`,
                            };
                          }),
                        ];
                        return (
                          <div>
                            <SmartSearchCombobox
                              compact
                              disabled={isVisitSaving(v.id)}
                              ariaLabel={`Seleccionar promotora activa para ${v.storeName}`}
                              value={selectedValue}
                              searchPlaceholder="Buscar promotora por nombre..."
                              panelMinWidth={270}
                              options={rowPromotoraOptions}
                              onChange={async (newPromotora) => {
                                const prevPromotoraName = v.promotoraName;
                                const prevPromotoraId = v.promotoraId;

                                // Validación estricta: No agendar a la promotora el mismo día en la misma jornada
                                const conflict = isPromotoraBooked(
                                  newPromotora,
                                  v.dayLabel,
                                  v.shift,
                                  v.id,
                                  v.date
                                );
                                if (conflict) {
                                  showNotification(
                                    `⛔ No permitido: ${newPromotora} ya está agendada en "${conflict.storeName}" para el ${v.dayLabel} en la jornada ${v.shift}. No se puede duplicar en la misma jornada.`,
                                    0,
                                    'Regla de asignación: No se permite agendar a la promotora el mismo día en la misma jornada.'
                                  );
                                  return;
                                }

                                const targetActiveUser = activePromotoraUsers.find(
                                  (u) => canonicalStaffKey(u.name) === canonicalStaffKey(newPromotora)
                                );
                                const allowedIds = new Set(
                                  activePromotoraUsers.map((u) => u.id).filter(Boolean)
                                );

                                await withVisitSaving(v.id, async () => {
                                  const candidateCronogramaId = isValidUuid(v.cronogramaId)
                                    ? v.cronogramaId!
                                    : isValidUuid(v.id) && !v.solicitudId
                                      ? v.id
                                      : null;
                                  const candidateSurveyId = isValidUuid(v.solicitudId)
                                    ? v.solicitudId!
                                    : isValidUuid(v.id)
                                      ? v.id
                                      : null;

                                  if (
                                    targetActiveUser?.id &&
                                    isValidUuid(targetActiveUser.id) &&
                                    (candidateCronogramaId || candidateSurveyId)
                                  ) {
                                    await updateVisit(
                                      v.id,
                                      {
                                        promotoraName: newPromotora,
                                        promotoraId: targetActiveUser.id,
                                      },
                                      { persist: false }
                                    );
                                    try {
                                      const rpcRes = await assignAcceptedDegustacionToPromotoraRoute({
                                        promotoraId: targetActiveUser.id,
                                        surveyId: candidateSurveyId,
                                        cronogramaId: candidateCronogramaId,
                                        confirmarAceptacion: true,
                                        allowedPromotoraIds: allowedIds,
                                      });
                                      await updateVisit(
                                        v.id,
                                        {
                                          cronogramaId: rpcRes.cronograma_id,
                                          promotoraId: targetActiveUser.id,
                                          promotoraName: newPromotora,
                                        },
                                        { persist: false }
                                      );
                                      showNotification(
                                        `✓ Promotora ${newPromotora} agendada en ${v.storeName} (${v.dayLabel} - ${v.shift}) y sincronizada con /portal/ruta.`,
                                        1
                                      );
                                    } catch (err) {
                                      await updateVisit(
                                        v.id,
                                        {
                                          promotoraName: prevPromotoraName,
                                          promotoraId: prevPromotoraId,
                                        },
                                        { persist: false }
                                      );
                                      showNotification(
                                        err instanceof Error
                                          ? err.message
                                          : 'No se pudo sincronizar la asignación con /portal/ruta.',
                                        0,
                                        'La asignación de promotora fue revertida automáticamente.'
                                      );
                                    }
                                    return;
                                  }

                                  const persistRes = await updateVisit(
                                    v.id,
                                    {
                                      promotoraName: newPromotora,
                                      promotoraId:
                                        targetActiveUser?.id && isValidUuid(targetActiveUser.id)
                                          ? targetActiveUser.id
                                          : '',
                                    },
                                    { persist: true }
                                  );
                                  if (!persistRes.ok) {
                                    showNotification(
                                      persistRes.error ||
                                        'No se pudo persistir el cambio de promotora en Supabase.',
                                      0,
                                      'La asignación anterior fue restaurada automáticamente.'
                                    );
                                    return;
                                  }
                                  showNotification(
                                    `✓ Promotora ${newPromotora} guardada en ${v.storeName} (${v.dayLabel} - ${v.shift}).`,
                                    1
                                  );
                                });
                              }}
                              triggerClassName={`bg-black ${
                                currentConflict
                                  ? 'border-2 border-amber-500 text-amber-300'
                                  : !matchedActiveUser
                                    ? 'border-amber-500/40 text-amber-300'
                                    : 'border-zinc-800'
                              }`}
                            />

                            {currentConflict && (
                              <div className="text-[10px] text-amber-400 font-bold flex items-center gap-1 mt-1 font-mono">
                                <span>⚠️ Conflicto: misma jornada</span>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    {/* Ubicación / Sector */}
                    <td className="p-3 text-zinc-400 text-xs max-w-[180px] truncate" title={v.zone}>
                      {v.zone}
                    </td>

                    {/* Estado */}
                    <td className="p-3 text-center whitespace-nowrap">
                      <span
                        className={`inline-block text-[10px] font-black px-2.5 py-0.5 rounded uppercase border ${
                          v.status === 'EN_CURSO'
                            ? 'bg-red-600 text-white border-red-500'
                            : v.status === 'COMPLETADA'
                            ? 'bg-zinc-900 text-white border-zinc-700'
                            : v.status === 'FUERA_GEOFENCE'
                            ? 'bg-black text-red-500 border-red-600 animate-pulse'
                            : 'bg-black text-zinc-500 border-zinc-800'
                        }`}
                      >
                        {v.status}
                      </span>
                    </td>

                    {/* Actions (Cancelación lógica auditable) */}
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        disabled={isVisitSaving(v.id) || v.status === 'COMPLETADA' || Boolean(v.enHistorial)}
                        onClick={() => void handleCancelSingleVisit(v.id)}
                        title={
                          v.status === 'COMPLETADA' || v.enHistorial
                            ? 'Registro histórico/completado protegido contra cancelación'
                            : 'Cancelar lógicamente (archiva en Historial sin borrado físico)'
                        }
                        className="p-1 rounded text-zinc-600 hover:text-red-500 hover:bg-black transition disabled:opacity-35 disabled:cursor-not-allowed"
                      >
                        {isVisitSaving(v.id) ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-red-400" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        </AnimatedTabContainer>
      </div>

      {/* Modal de Confirmación: Cancelación Lógica por Lote de la Tabla General */}
      {isDeleteSelectedModalOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md bg-zinc-950 border border-red-700/60 rounded-2xl p-6 shadow-2xl shadow-red-950/60 space-y-4">
            <div className="flex items-center gap-2.5 text-white font-black uppercase text-sm tracking-wider">
              <span className="p-2 rounded-xl bg-red-600/20 text-red-500 border border-red-600/30">
                <Trash2 className="w-5 h-5" />
              </span>
              <span>Confirmar Cancelación Lógica por Lote</span>
            </div>

            <p className="text-xs text-zinc-200 leading-relaxed">
              ¿Deseas cancelar lógicamente los{' '}
              <strong className="text-red-400 font-black font-mono">
                {selectedTableVisitIds.length}
              </strong>{' '}
              registros seleccionados en Supabase? Las filas activas se marcarán como{' '}
              <span className="font-mono text-white">CANCELADA</span> y quedarán archivadas en
              Historial (sin borrado físico <span className="font-mono">DELETE</span>).
            </p>

            {selectedNonPendingCount > 0 && (
              <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-600/50 text-xs text-amber-200 space-y-1">
                <div className="font-black text-amber-400 uppercase tracking-wide">
                  ⚠️ Protección de Historial y Completados
                </div>
                <p>
                  Entre los registros seleccionados hay{' '}
                  <strong className="text-white font-mono">{selectedNonPendingCount}</strong> con
                  estado distinto de <span className="font-mono">PENDIENTE</span> o ya archivados en
                  Historial. Los registros <span className="font-mono">COMPLETADA</span> / históricos
                  se preservarán intactos en base de datos.
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={isPersistingMatrix}
                onClick={() => setIsDeleteSelectedModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-black border border-zinc-800 text-zinc-300 hover:text-white text-xs font-bold transition cursor-pointer disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={isPersistingMatrix}
                onClick={() => void handleConfirmDeleteSelected()}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-black uppercase tracking-wider border border-red-400 shadow-lg shadow-red-950/60 transition cursor-pointer inline-flex items-center gap-1.5"
              >
                {isPersistingMatrix && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>
                  {isPersistingMatrix
                    ? 'Archivando...'
                    : `Sí, Cancelar (${selectedTableVisitIds.length})`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Agregar Nueva Activación Manual */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-900">
              <h3 className="text-base font-black text-white uppercase tracking-wider flex items-center gap-2">
                <Plus className="w-4 h-4 text-red-500" />
                <span>Nueva Activación Individual</span>
              </h3>
              <button
                type="button"
                disabled={isPersistingMatrix}
                onClick={() => setIsAddModalOpen(false)}
                className="text-zinc-500 hover:text-white disabled:opacity-40"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 py-4">
              <div>
                <label className="text-xs font-bold text-zinc-300 block mb-1">
                  Punto de Venta / Cliente (Catálogo Maestro)
                </label>
                <input
                  type="text"
                  list="matrix-master-stores-list"
                  placeholder="Selecciona del catálogo o escribe el PDV..."
                  value={newStoreName}
                  onChange={(e) => {
                    const val = e.target.value;
                    setNewStoreName(val);
                    const matched = stores.find(
                      (s) => normalizeSearchText(s.name) === normalizeSearchText(val)
                    );
                    if (matched) {
                      setNewStoreId(matched.id);
                      if (matched.zone) setNewZone(matched.zone);
                      if (matched.sellerName) setNewSellerNameInput(matched.sellerName);
                    } else {
                      setNewStoreId('');
                    }
                  }}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                />
                <datalist id="matrix-master-stores-list">
                  {stores.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.clientCode ? `${s.clientCode} · ${s.zone}` : s.zone}
                    </option>
                  ))}
                </datalist>
                {newStoreId && (
                  <p className="text-[10px] text-emerald-400 font-mono mt-1">
                    ✓ Vinculado al PDV maestro en Supabase ({newStoreId.slice(0, 8)}…)
                  </p>
                )}
              </div>

              <div>
                <label className="text-xs font-bold text-zinc-300 block mb-1">Zona / Sector / Ubicación</label>
                <input
                  type="text"
                  placeholder="Ej: MARACAIBO NORTE, AV. LA LIMPIA"
                  value={newZone}
                  onChange={(e) => setNewZone(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-zinc-300 block mb-1">Producto</label>
                  <SmartSearchCombobox
                    testId="single-visit-product-select"
                    searchTestId="single-visit-product-search"
                    ariaLabel="Seleccionar producto a degustar"
                    value={
                      batchProductCatalog.some((p) => p.nombre === singleModalProduct)
                        ? singleModalProduct
                        : (batchProductCatalog[0]?.nombre ?? singleModalProduct)
                    }
                    onChange={(nextVal) => setSingleModalProduct(nextVal)}
                    options={productComboboxOptions}
                    searchPlaceholder="Teclea nombre o código del producto..."
                    panelMinWidth={320}
                    triggerClassName="bg-black border-zinc-800"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-zinc-300 block mb-1">Cantidad a Llenar</label>
                  <input
                    type="text"
                    value={batchQuantity}
                    onChange={(e) => setBatchQuantity(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs font-mono text-white focus:outline-none focus:border-red-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-zinc-300 block mb-1">Fecha</label>
                  <input
                    type="date"
                    value={batchDate}
                    onChange={(e) => setBatchDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs font-mono text-white focus:outline-none focus:border-red-600"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-zinc-300 block mb-1">Jornada</label>
                  <select
                    value={batchShift}
                    onChange={(e) => setBatchShift(e.target.value as ShiftType)}
                    className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                  >
                    <option value="MAÑANA">MAÑANA</option>
                    <option value="TARDE">TARDE</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-zinc-300 block mb-1">Vendedor Solicitante (FDV)</label>
                <input
                  type="text"
                  placeholder="Nombre del vendedor"
                  value={newSellerNameInput}
                  onChange={(e) => setNewSellerNameInput(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-zinc-300 block mb-1">
                  Promotora Asignada (Validación de jornada)
                </label>
                <SmartSearchCombobox
                  testId="single-visit-promotora-select"
                  searchTestId="single-visit-promotora-search"
                  ariaLabel="Seleccionar promotora asignada"
                  value={newPromotoraName}
                  onChange={(nextVal) => setNewPromotoraName(nextVal)}
                  searchPlaceholder="Teclea el nombre de la promotora..."
                  triggerClassName="bg-black border-zinc-800"
                  options={[
                    {
                      value: 'POR ASIGNAR (Trade Marketing)',
                      label: 'POR ASIGNAR (Trade Marketing)',
                      sublabel: 'Queda pendiente por asignar promotora',
                      badge: 'PEND.',
                    },
                    ...activePromotoraOptions.map((u) => {
                      const fullName = u.name;
                      const conflict = isPromotoraBooked(fullName, batchDay, batchShift, undefined, batchDate);
                      return {
                        value: fullName,
                        label: fullName,
                        sublabel: conflict
                          ? `⛔ Ocupada en ${conflict.storeName}`
                          : '✓ Disponible en esta jornada',
                        badge: conflict ? 'OCUPADA' : '✓',
                        disabled: Boolean(conflict),
                        keywords: `${fullName} ${conflict ? 'ocupada' : 'disponible'}`,
                      };
                    }),
                  ]}
                />
              </div>

              <div>
                <label className="text-xs font-bold text-zinc-300 block mb-1">
                  Observaciones / Notas (Opcional)
                </label>
                <input
                  type="text"
                  data-testid="single-visit-notes-input"
                  placeholder="Ej: Nota operativa de degustación..."
                  value={newVisitNotes}
                  onChange={(e) => setNewVisitNotes(e.target.value)}
                  maxLength={500}
                  className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-900">
              <button
                type="button"
                disabled={isPersistingMatrix}
                onClick={() => setIsAddModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-black hover:bg-zinc-900 text-zinc-300 text-xs font-bold border border-zinc-800 transition disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={isPersistingMatrix}
                onClick={async () => {
                  if (isPersistingMatrix) return;
                  const cleanStoreName = newStoreName.trim();
                  if (cleanStoreName.length < 2) {
                    showNotification(
                      'El nombre del Punto de Venta / Cliente debe tener al menos 2 caracteres.',
                      0
                    );
                    return;
                  }
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(batchDate)) {
                    showNotification('Selecciona una fecha válida (YYYY-MM-DD).', 0);
                    return;
                  }

                  const cleanPromChoice = String(newPromotoraName || '').trim();
                  const isUnassignedPromChoice =
                    !cleanPromChoice ||
                    /^POR ASIGNAR|^SIN ASIGNAR/i.test(cleanPromChoice);
                  if (isCentroAndesOnlyCoordinator && isUnassignedPromChoice) {
                    showNotification(
                      'Selecciona una promotora activa asignada antes de guardar para despachar automáticamente a su Módulo de Ruta y a la App del Chofer de Valencia.',
                      0
                    );
                    return;
                  }

                  // Validación: Promotora no duplicada en misma fecha y jornada
                  const conflict = isPromotoraBooked(
                    newPromotoraName,
                    batchDay,
                    batchShift,
                    undefined,
                    batchDate
                  );
                  if (conflict) {
                    showNotification(
                      `⛔ Conflicto de Jornada: ${newPromotoraName} ya está agendada en "${conflict.storeName}" para el ${batchDay} en la jornada ${batchShift}. No se puede agendar el mismo día en la misma jornada.`,
                      0,
                      'Regla de asignación: No se permite agendar a la promotora el mismo día en la misma jornada.'
                    );
                    return;
                  }

                  const prodUpper = (singleModalProduct || batchProductCatalog[0]?.nombre || 'MORTADELA').toUpperCase();
                  const parsedNumericQty = parseFloat(String(batchQuantity).replace(',', '.'));
                  if (
                    !prodUpper.includes('VENCAMPO') &&
                    (!Number.isFinite(parsedNumericQty) || parsedNumericQty <= 0)
                  ) {
                    showNotification('Ingresa una cantidad positiva mayor a 0.', 0);
                    return;
                  }

                  let mortadelaQty = 0;
                  let espaldaQty = 0;
                  let arrozQty = 0;
                  let azucarGrams = 0;
                  let lecheGrams = 0;
                  let plannedUnits = Number.isFinite(parsedNumericQty) && parsedNumericQty > 0 ? Math.round(parsedNumericQty) : 1;

                  if (prodUpper.includes('MORTADELA')) {
                    mortadelaQty = plannedUnits;
                  } else if (prodUpper.includes('VENCAMPO')) {
                    arrozQty = 1;
                    azucarGrams = 600;
                    lecheGrams = 600;
                    plannedUnits = 1;
                  } else if (prodUpper.includes('ESPALDA')) {
                    espaldaQty = plannedUnits;
                  }

                  const matchedStore =
                    stores.find((s) => s.id === newStoreId) ||
                    stores.find(
                      (s) => normalizeSearchText(s.name) === normalizeSearchText(cleanStoreName)
                    );
                  const resolvedProm = resolveRealPromotoraForMatrix(users, newPromotoraName);

                  setIsPersistingMatrix(true);
                  try {
                    const res = await addVisit({
                      date: batchDate,
                      dayLabel: batchDay,
                      shift: batchShift,
                      storeId: matchedStore?.id || '',
                      storeName: matchedStore?.name || cleanStoreName,
                      zone:
                        newZone.trim() ||
                        matchedStore?.zone ||
                        (isCentroAndesOnlyCoordinator
                          ? activeRegionScope === 'ANDES'
                            ? 'ANDES'
                            : 'VALENCIA / CENTRO'
                          : 'MARACAIBO'),
                      productFocus: prodUpper,
                      fillProductSelection: prodUpper,
                      fillQuantityInput: batchQuantity,
                      promotoraId: resolvedProm.promotoraId,
                      promotoraName: resolvedProm.promotoraName,
                      sellerName:
                        newSellerNameInput.trim().toUpperCase() ||
                        matchedStore?.sellerName ||
                        'SIN VENDEDOR',
                      plannedUnits,
                      mortadelaQty,
                      espaldaQty,
                      arrozQty,
                      azucarGrams,
                      lecheGrams,
                      rowHighlight: prodUpper.includes('VENCAMPO') ? 'green' : 'none',
                      status: 'PENDIENTE',
                      ...(newVisitNotes.trim() ? { notes: newVisitNotes.trim() } : {}),
                      additionalGoods: {
                        arrozKg: arrozQty,
                        azucarKg: azucarGrams / 1000,
                        lecheKg: lecheGrams / 1000,
                      },
                    });

                    if (!res.ok) {
                      showNotification(
                        res.error || 'No se pudo guardar la activación en Supabase.',
                        0,
                        res.reverted
                          ? 'La fila optimista fue revertida automáticamente.'
                          : 'Corrige los datos e intenta nuevamente.'
                      );
                      return;
                    }

                    setIsAddModalOpen(false);
                    setNewStoreName('');
                    setNewStoreId('');
                    setNewZone('');
                    setNewSellerNameInput('');
                    setNewVisitNotes('');
                    showNotification(
                      '✓ Nueva activación persistida en Supabase y sincronizada en la Tabla General.',
                      1,
                      'Guardada en cronograma_degustaciones, rutas_promotoras y entregas_degustacion.'
                    );
                  } finally {
                    setIsPersistingMatrix(false);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-black uppercase tracking-wider border border-red-500 shadow-md transition inline-flex items-center gap-1.5"
              >
                {isPersistingMatrix && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isPersistingMatrix ? 'Guardando...' : 'Guardar en Tabla General'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dashboard 360° Interactivo al Seleccionar Cualquier Tarjeta de Métrica */}
      <Metric360DashboardModal
        isOpen={selectedMetric360 !== null}
        metricId={selectedMetric360}
        onSelectMetric={(id) => setSelectedMetric360(id)}
        onClose={() => setSelectedMetric360(null)}
        switcherItems={metric360SwitcherItems}
        visits={visits}
        tastingItems={synchronizedMonthlyTastingItems}
        module1Bundle={module1Bundle}
        liveClock={liveClock}
        onApplyTableFilter={({ productFilter, timeLens }) => {
          if (productFilter) {
            setSelectedProduct(productFilter);
          }
          if (timeLens === 'SEMANA_ACTUAL') {
            setTableWeekOffset(0);
            setSelectedDay('SEMANA_ACTUAL');
          } else if (timeLens === 'SEMANA_ANTERIOR') {
            setTableWeekOffset(-1);
            setSelectedDay('SEMANA_NAV');
          } else if (timeLens === 'MES_ACTUAL') {
            setSelectedDay('MES_ACTUAL');
          } else {
            setSelectedDay('TODOS');
          }
          document.getElementById('tabla-general-matriz')?.scrollIntoView({ behavior: 'smooth' });
        }}
      />

      {/* Bloque oficial de firmas para soporte impreso / PDF */}
      <PrintSignatureBlock />

    </div>
  );
};
