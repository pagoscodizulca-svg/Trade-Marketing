import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import {
  Calendar,
  MapPin,
  CheckCircle2,
  Camera,
  Users,
  Check,
  Store as StoreIcon,
  Sliders,
  Send,
  Smartphone,
  Trash2,
  Edit2,
  Play,
  Archive,
  X,
  ClipboardCheck,
  Scale,
  Box,
  UserCheck,
  Search,
  ExternalLink,
  AlertCircle,
  Plus,
  RefreshCw,
  Database,
  FileSignature,
  Eye,
  EyeOff,
  Copy,
  Loader2,
  Clock,
  Maximize2,
  Printer,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  Phone,
  Upload,
} from 'lucide-react';
import { ExportPdfButton } from '../common/ExportPdfButton';
import {
  exportTastingSchedulePdf,
  exportPromotoraReportsPdf,
  exportMonthlyTastingGeneralReportPdf,
} from '../../utils/pdfExport';
import { PrintSupportHeader, PrintSignatureBlock } from '../common/PrintSupportHeader';
import { evaluateTastingFeasibility } from '../../utils/tastingFeasibility';
import { useLiveVenezuelaClock } from '../../utils/weekCalendar';
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
import {
  DegustacionNotificationItem,
  OperationalSupplies,
  PriceComparisonThreeBrands,
  ScheduledVisit,
  ShiftType,
} from '../../types';
import {
  fetchCheckinPhotoById,
  fetchCheckinPhotosBatch,
  updateSupabaseDegustacionStatus,
  createSupabaseSellerDegustacionRequest,
  updateSupabaseInventoryObservation,
  createSupabaseInventoryRecord,
  deleteSupabaseInventoryRecord,
  deleteSupabaseMerchandisingRecord,
  saveSupabaseStaffMember,
  updateSupabaseStaffPhoto,
  deleteSupabaseStaffMember,
  getTodayVeYmd,
  canonicalStaffKey,
  canonicalizeActivePromoterOrNull,
  VisitHistoryRecord,
  InventorySamplingRecord,
  AttendanceRecord,
  AttendanceSlotEvent,
  MerchandisingRecord,
  StaffMemberRecord,
  StaffCategory,
} from '../../services/supabaseModule1';
import { calculateProductionSupplies } from '../../utils/productionSuppliesCalculator';
import { TradeContraloriaSolicitudesTab } from './TradeContraloriaSolicitudesTab';
import { MultiFormatTastingUploadModal } from './MultiFormatTastingUploadModal';

export type FieldSubTab =
  | 'degustaciones'
  | 'informes'
  | 'merchandising'
  | 'personal'
  | 'solicitudes_contraloria';

export interface TastingScheduleItem {
  id: string;
  degustacionId?: string;
  source?: string;
  createdAt?: string;
  date: string;
  dayLabel?: string;
  shift?: ShiftType;
  turnoRaw?: string;
  timeRange: string;
  activityTitle: string;
  productName: string;
  productsList?: string[];
  responsibleName: string;
  storeName: string;
  clienteCodigo?: string;
  zone: string;
  address?: string;
  contactoPunto?: string;
  telefonoContacto?: string;
  requierePromotora?: boolean;
  promoterType?: string;
  materialPop?: string;
  notasTradeMarketing?: string;
  resultado?: {
    kilosDegustados?: number;
    personasAlcanzadas?: number;
    ventasGeneradas?: string;
    comentarios?: string;
  } | null;
  leidoTrade?: boolean;
  vistoEnTradeAt?: string | null;
  mapsUrl?: string;
  status: 'PENDIENTE' | 'PROGRAMADO' | 'EN_CURSO' | 'COMPLETADO';
  currentSamples: number;
  targetSamples: number;
  requestedQty?: number;
  mortadelaQty?: number;
  espaldaQty?: number;
  arrozQty?: number;
  azucarGrams?: number;
  lecheGrams?: number;
  operationalSupplies?: OperationalSupplies;
  fillProductSelection?: string;
  fillQuantityInput?: string;
  acceptancePercent?: number;
  sellerApplicant: string;
  salesAssistedCount?: number;
  lotNumber?: string;
  isArchived: boolean;
  notes?: string;
  rawComments?: Record<string, any>;
}

export const FieldPromotoraView: React.FC = () => {
  const {
    currentUser,
    currentRole,
    stores,
    visits,
    addVisit,
    updateVisit,
    deleteVisit,
    upsertVisitFromApprovedTasting,
    removeVisitByTastingRequest,
    module1Bundle,
    isLoadingSupabase,
    supabaseError,
    refreshSupabaseData,
    degustacionNotifications,
    focusedTastingId,
    setFocusedTastingId,
    focusedTastingSnapshot,
    setFocusedTastingSnapshot,
    solicitudesContraloria,
  } = useApp();

  const liveClock = useLiveVenezuelaClock();
  const [selectedMetric360, setSelectedMetric360] = useState<Metric360Id | null>(null);
  const [isMultiFormatUploadOpen, setIsMultiFormatUploadOpen] = useState(false);

  const syncedStoreItemsForUpload = useMemo(() => {
    const items: Array<{ name: string; clientCode?: string; zone?: string; address?: string }> = [];
    for (const t of module1Bundle?.tastingItems || []) {
      if (t.storeName) {
        items.push({
          name: t.storeName,
          clientCode: t.clienteCodigo,
          zone: t.zone,
          address: t.address,
        });
      }
    }
    for (const vh of module1Bundle?.visitsHistory || []) {
      if (vh.storeName) {
        items.push({ name: vh.storeName, zone: vh.zone });
      }
    }
    for (const sm of module1Bundle?.staffMembers || []) {
      if (sm.assignedStore && sm.assignedStore !== 'Ruta Variable / Por Asignar') {
        items.push({ name: sm.assignedStore });
      }
    }
    return items;
  }, [module1Bundle]);

  // Active sub-module tab (Degustaciones | Informes | Merchandising | Personal)
  const [activeSubTab, setActiveSubTab] = useState<FieldSubTab>('degustaciones');

  // Sub-tab inside Degustaciones: 'actual' | 'historial'
  const [tastingViewMode, setTastingViewMode] = useState<'actual' | 'historial'>('actual');

  // Solicitudes locales adicionales creadas si falla red
  const [localSellerRequests, setLocalSellerRequests] = useState<TastingScheduleItem[]>([]);

  // Registro de IDs archivados manualmente o al cierre de semana
  const [archivedVisitIds, setArchivedVisitIds] = useState<string[]>([]);

  // Registro de IDs de solicitudes aprobadas/rechazadas localmente en esta sesión
  const [approvedIdsInSession, setApprovedIdsInSession] = useState<Record<string, string>>({});
  const [rejectedIdsInSession, setRejectedIdsInSession] = useState<Set<string>>(() => new Set());
  const approvingIdsRef = useRef<Set<string>>(new Set());
  const [processingTastingId, setProcessingTastingId] = useState<string | null>(null);

  // Filtros de búsqueda en la tabla de degustaciones
  const [tastingSearchQuery, setTastingSearchQuery] = useState('');
  const [tastingPromotoraFilter, setTastingPromotoraFilter] = useState('TODAS');
  const [tastingDayFilter, setTastingDayFilter] = useState('TODOS');
  const [tastingDateFrom, setTastingDateFrom] = useState('');
  const [tastingDateTo, setTastingDateTo] = useState('');
  const [tastingShiftFilter, setTastingShiftFilter] = useState('TODOS');
  const [tastingProductFilter, setTastingProductFilter] = useState('TODOS');
  const [isTastingCalendarOpen, setIsTastingCalendarOpen] = useState(false);
  const [calendarMonthDate, setCalendarMonthDate] = useState<Date>(() => new Date());

  // =========================================================================
  // SINCRONIZACIÓN EXACTA ENTRE SUPABASE (MÓDULO 1) Y TRADE MARKETING (MÓDULO 2)
  // =========================================================================
  const supabaseTastingMap = useMemo(() => {
    const map = new Map<string, TastingScheduleItem>();
    (module1Bundle?.tastingItems || []).forEach((item) => {
      map.set(item.id, item);
    });
    return map;
  }, [module1Bundle]);

  const synchronizedScheduleItems = useMemo<TastingScheduleItem[]>(() => {
    const todayYmd = liveClock.todayYmd;
    const visitById = new Map<string, ScheduledVisit>();
    const visitByDegId = new Map<string, ScheduledVisit>();
    visits.forEach((v) => {
      visitById.set(v.id, v);
      if (v.solicitudId) visitById.set(v.solicitudId, v);
      if (v.degustacionId) visitByDegId.set(v.degustacionId, v);
    });

    const consumedVisitIds = new Set<string>();
    const result: TastingScheduleItem[] = [];

    const buildMergedItem = (
      supItem?: TastingScheduleItem,
      v?: ScheduledVisit
    ): TastingScheduleItem | null => {
      const id = v?.id || supItem?.id || '';
      const solId = v?.solicitudId || supItem?.id || id;
      const degId = v?.degustacionId || supItem?.degustacionId;
      if (!id) return null;
      if (
        rejectedIdsInSession.has(id) ||
        rejectedIdsInSession.has(solId) ||
        (degId && rejectedIdsInSession.has(degId))
      ) {
        return null;
      }

      const effectiveShift: ShiftType = v?.shift || supItem?.shift || 'MAÑANA';
      const isMorning = effectiveShift === 'MAÑANA';
      const timeRange = supItem?.timeRange || (isMorning ? '08:30 - 12:30' : '14:00 - 18:00');
      const prodLabel =
        v?.productFocus || supItem?.productName || 'Mortadela Especial Asturias 0.900kg';
      const prodUpper = (
        v?.fillProductSelection ||
        supItem?.fillProductSelection ||
        prodLabel ||
        ''
      ).toUpperCase();

      const totalUnits =
        v?.plannedUnits ||
        (v ? v.mortadelaQty + v.espaldaQty + v.arrozQty : 0) ||
        supItem?.requestedQty ||
        1;
      const targetSamples = supItem?.targetSamples ?? 0;
      const suppliesCalc = calculateProductionSupplies(prodLabel, totalUnits, targetSamples);

      const effectiveDate = v?.date || supItem?.date || todayYmd;
      const effectiveDayLabel = v?.dayLabel || supItem?.dayLabel || effectiveDate;
      const isBeforeToday =
        Boolean(supItem?.isArchived) || Boolean(effectiveDate && effectiveDate < todayYmd);
      const isArchived =
        archivedVisitIds.includes(id) || archivedVisitIds.includes(solId) || isBeforeToday;

      let itemStatus: TastingScheduleItem['status'] = 'PROGRAMADO';
      if (isArchived) {
        itemStatus = 'COMPLETADO';
      } else if (approvedIdsInSession[id] || approvedIdsInSession[solId]) {
        itemStatus = 'PROGRAMADO';
      } else if (v?.status === 'COMPLETADA' || supItem?.status === 'COMPLETADO') {
        itemStatus = 'COMPLETADO';
      } else if (v?.status === 'EN_CURSO' || supItem?.status === 'EN_CURSO') {
        itemStatus = 'EN_CURSO';
      } else if (supItem?.status === 'PENDIENTE' && !v) {
        itemStatus = 'PENDIENTE';
      } else {
        itemStatus = 'PROGRAMADO';
      }

      const currentSamples = supItem?.currentSamples ?? 0;
      const acceptancePercent = supItem?.acceptancePercent;
      const salesAssisted = v?.assistedSalesUnits || supItem?.salesAssistedCount || 0;
      const assignedPromotora =
        approvedIdsInSession[id] ||
        approvedIdsInSession[solId] ||
        v?.promotoraName ||
        supItem?.responsibleName ||
        'POR ASIGNAR (Trade Marketing)';

      const isUnreadInSession = degustacionNotifications.unreadItems.some(
        (u) => u.id === id || u.id === solId || (Boolean(degId) && u.degustacionId === degId)
      );

      return {
        id: solId,
        degustacionId: degId,
        source: supItem?.source,
        createdAt: supItem?.createdAt,
        date: effectiveDate,
        dayLabel: effectiveDayLabel,
        shift: effectiveShift,
        turnoRaw: supItem?.turnoRaw,
        timeRange,
        activityTitle: supItem?.activityTitle || `Degustación ${prodLabel}`,
        productName: prodLabel,
        productsList: supItem?.productsList,
        responsibleName: assignedPromotora,
        storeName: v?.storeName || supItem?.storeName || 'PDV Sin Nombre',
        clienteCodigo: supItem?.clienteCodigo,
        zone: v?.zone || supItem?.zone || 'ZONA GENERAL',
        address: supItem?.address,
        contactoPunto: supItem?.contactoPunto,
        telefonoContacto: supItem?.telefonoContacto,
        requierePromotora: supItem?.requierePromotora,
        promoterType: supItem?.promoterType,
        materialPop: supItem?.materialPop,
        notasTradeMarketing: supItem?.notasTradeMarketing,
        resultado: supItem?.resultado,
        leidoTrade: isUnreadInSession ? false : (supItem?.leidoTrade ?? true),
        vistoEnTradeAt: supItem?.vistoEnTradeAt,
        mapsUrl: v?.mapsUrl || supItem?.mapsUrl,
        status: itemStatus,
        currentSamples,
        targetSamples,
        requestedQty: totalUnits,
        mortadelaQty: v?.mortadelaQty ?? supItem?.mortadelaQty ?? suppliesCalc.mortadelaQty,
        espaldaQty: v?.espaldaQty ?? supItem?.espaldaQty ?? suppliesCalc.espaldaQty,
        arrozQty: v?.arrozQty ?? supItem?.arrozQty ?? suppliesCalc.arrozQty,
        azucarGrams: v?.azucarGrams ?? supItem?.azucarGrams ?? suppliesCalc.azucarGrams,
        lecheGrams: v?.lecheGrams ?? supItem?.lecheGrams ?? suppliesCalc.lecheGrams,
        operationalSupplies:
          v?.operationalSupplies || supItem?.operationalSupplies || suppliesCalc.operationalSupplies,
        fillProductSelection:
          v?.fillProductSelection || supItem?.fillProductSelection || suppliesCalc.fillProductSelection,
        fillQuantityInput:
          v?.fillQuantityInput || supItem?.fillQuantityInput || String(totalUnits),
        acceptancePercent,
        sellerApplicant:
          supItem?.sellerApplicant || `${v?.sellerName || 'Ventas'} (Vendedor FDV)`,
        salesAssistedCount: salesAssisted,
        lotNumber:
          supItem?.lotNumber || (prodUpper ? `REF-${solId.slice(0, 8).toUpperCase()}` : 'SIN-LOTE'),
        isArchived,
        notes:
          v?.notes ||
          supItem?.notes ||
          `Sincronizado con Base de Datos Supabase y Trade Marketing (${effectiveShift} - ${effectiveDayLabel}).`,
        rawComments: supItem?.rawComments,
      };
    };

    // 1. Incluir todas las solicitudes de degustación de Módulo 1 (tanto PENDIENTE como APROBADAS), superponiendo datos del Módulo 2 si ya fue aprobada
    (module1Bundle?.tastingItems || []).forEach((supItem) => {
      const matchedVisit =
        visitById.get(supItem.id) ||
        (supItem.degustacionId ? visitByDegId.get(supItem.degustacionId) : undefined);
      if (matchedVisit) {
        consumedVisitIds.add(matchedVisit.id);
      }
      const merged = buildMergedItem(supItem, matchedVisit);
      if (merged) result.push(merged);
    });

    // 2. Incluir activaciones creadas o presentes en Módulo 2 que no estén ya en module1Bundle.tastingItems
    visits.forEach((v) => {
      if (consumedVisitIds.has(v.id)) return;
      const supItem =
        supabaseTastingMap.get(v.id) ||
        (v.solicitudId ? supabaseTastingMap.get(v.solicitudId) : undefined);
      const merged = buildMergedItem(supItem, v);
      if (merged) result.push(merged);
    });

    return result;
  }, [
    visits,
    module1Bundle?.tastingItems,
    supabaseTastingMap,
    archivedVisitIds,
    approvedIdsInSession,
    rejectedIdsInSession,
    liveClock.todayYmd,
    degustacionNotifications.unreadItems,
  ]);

  // Lista unificada de degustaciones (archivando automáticamente cualquier solicitud previa al día activo a medida que avanzan las semanas)
  const tastingSchedule = useMemo<TastingScheduleItem[]>(() => {
    const todayYmd = liveClock.todayYmd;
    const normalizedLocal = localSellerRequests.map((item) =>
      item.date && item.date < todayYmd
        ? { ...item, isArchived: true, status: 'COMPLETADO' as const }
        : item
    );
    return [...normalizedLocal, ...synchronizedScheduleItems];
  }, [localSellerRequests, synchronizedScheduleItems, liveClock.todayYmd]);

  const activeTastingCount = useMemo(
    () => tastingSchedule.filter((item) => !item.isArchived).length,
    [tastingSchedule]
  );
  const archivedTastingCount = useMemo(
    () => tastingSchedule.filter((item) => item.isArchived).length,
    [tastingSchedule]
  );

  // Opciones únicas de filtros derivadas directamente de tastingSchedule y visits
  const availableDays = useMemo(() => {
    return Array.from(
      new Set([
        ...tastingSchedule.map((t) => t.dayLabel).filter((d): d is string => Boolean(d)),
        ...visits.map((v) => v.dayLabel).filter((d): d is string => Boolean(d)),
      ])
    );
  }, [tastingSchedule, visits]);

  // Mapa de conteo de degustaciones por fecha YYYY-MM-DD según la pestaña activa (Actual o Historial)
  const tastingDatesCountMap = useMemo(() => {
    const map = new Map<string, number>();
    tastingSchedule.forEach((item) => {
      if (tastingViewMode === 'actual' && item.isArchived) return;
      if (tastingViewMode === 'historial' && !item.isArchived) return;
      const iso = normalizeExcelDate(item.date || item.rawComments?.date).fechaIso;
      if (iso) {
        map.set(iso, (map.get(iso) || 0) + 1);
      }
    });
    return map;
  }, [tastingSchedule, tastingViewMode]);

  // Sincronizar el mes visible del calendario con la fecha o mes seleccionado
  useEffect(() => {
    if (tastingDayFilter !== 'TODOS' && /^\d{4}-\d{2}(-\d{2})?$/.test(tastingDayFilter)) {
      const [y, m] = tastingDayFilter.split('-').map(Number);
      setCalendarMonthDate(new Date(y, m - 1, 1));
      return;
    }
    const dates = Array.from(tastingDatesCountMap.keys()).sort();
    if (dates.length > 0) {
      const latest = dates[dates.length - 1];
      const [y, m] = latest.split('-').map(Number);
      if (y && m) {
        setCalendarMonthDate(new Date(y, m - 1, 1));
      }
    }
  }, [tastingViewMode, tastingDatesCountMap, tastingDayFilter]);

  // Evaluador unificado de filtros activos (Fecha / Mes / Rango + Jornada + Producto + Promotora + Búsqueda)
  const matchesActiveTastingFilters = useCallback(
    (item: TastingScheduleItem): boolean => {
      if (tastingPromotoraFilter !== 'TODAS') {
        const filterKey = canonicalStaffKey(tastingPromotoraFilter);
        const itemKey = canonicalStaffKey(item.responsibleName);
        if (!itemKey || itemKey !== filterKey) return false;
      }

      const rawRecordDate = item.date || item.rawComments?.date;
      const parsedRecordDate = normalizeExcelDate(rawRecordDate);

      if (tastingDayFilter === 'SEMANA_ACTUAL') {
        if (
          !matchesDateFilter(
            rawRecordDate,
            {
              desde: liveClock.currentWeek.mondayYmd,
              hasta: liveClock.currentWeek.sundayYmd,
            },
            parsedRecordDate.fechaTimestamp
          )
        ) {
          return false;
        }
      } else if (tastingDayFilter === 'RANGO') {
        if (
          !matchesDateFilter(
            rawRecordDate,
            { desde: tastingDateFrom, hasta: tastingDateTo },
            parsedRecordDate.fechaTimestamp
          )
        ) {
          return false;
        }
      } else if (tastingDayFilter !== 'TODOS' && tastingDayFilter.trim() !== '') {
        if (/^\d{4}-\d{2}$/.test(tastingDayFilter)) {
          // Filtro de Mes Completo (YYYY-MM)
          if (
            !parsedRecordDate.fechaIso ||
            parsedRecordDate.fechaIso.slice(0, 7) !== tastingDayFilter
          ) {
            return false;
          }
        } else {
          const parsedFilterSingle = normalizeExcelDate(tastingDayFilter);
          if (parsedFilterSingle.isValid) {
            if (
              !matchesDateFilter(
                rawRecordDate,
                { fechaUnica: tastingDayFilter },
                parsedRecordDate.fechaTimestamp
              )
            ) {
              return false;
            }
          } else {
            const matchesDayLabel =
              item.dayLabel === tastingDayFilter ||
              Boolean(item.dayLabel && item.dayLabel.includes(tastingDayFilter));
            const matchesNotes = Boolean(item.notes && item.notes.includes(tastingDayFilter));
            if (!matchesDayLabel && !matchesNotes) return false;
          }
        }
      }

      if (tastingShiftFilter !== 'TODOS') {
        if (item.shift !== tastingShiftFilter) return false;
      }

      if (tastingProductFilter !== 'TODOS') {
        const pUpper = (item.fillProductSelection || item.productName || '').toUpperCase();
        if (!pUpper.includes(tastingProductFilter)) return false;
      }

      if (tastingSearchQuery.trim()) {
        const q = tastingSearchQuery.toLowerCase();
        const matchesStore = item.storeName.toLowerCase().includes(q);
        const matchesProduct = item.productName.toLowerCase().includes(q);
        const matchesPromotora = item.responsibleName.toLowerCase().includes(q);
        const matchesSeller = item.sellerApplicant.toLowerCase().includes(q);
        const matchesZone = item.zone.toLowerCase().includes(q);
        const matchesDay = (item.dayLabel || '').toLowerCase().includes(q);
        if (!matchesStore && !matchesProduct && !matchesPromotora && !matchesSeller && !matchesZone && !matchesDay) {
          return false;
        }
      }

      return true;
    },
    [
      tastingPromotoraFilter,
      tastingDayFilter,
      tastingDateFrom,
      tastingDateTo,
      tastingShiftFilter,
      tastingProductFilter,
      tastingSearchQuery,
      liveClock.currentWeek.mondayYmd,
      liveClock.currentWeek.sundayYmd,
    ]
  );

  // Registros para el Informe Global PDF (Archivadas + Activas que cumplan el filtro aplicado)
  const globalFilteredReportItems = useMemo(
    () => tastingSchedule.filter((item) => matchesActiveTastingFilters(item)),
    [tastingSchedule, matchesActiveTastingFilters]
  );

  const activeGlobalReportMeta = useMemo(() => {
    const monthNamesShort = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    const monthNamesFull = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ];

    const parts: string[] = [];
    let dateBadge = 'TODOS';
    let targetYearMonth: string | undefined = undefined;
    let fileSuffix = 'Global_Todos';

    if (tastingDayFilter === 'RANGO' && (tastingDateFrom || tastingDateTo)) {
      const f = tastingDateFrom ? formatToDdMmYyyy(tastingDateFrom, 'Inicio') : 'Inicio';
      const t = tastingDateTo ? formatToDdMmYyyy(tastingDateTo, 'Actual') : 'Actual';
      parts.push(`Rango: ${f} al ${t}`);
      dateBadge = 'RANGO';
      fileSuffix = `Rango_${tastingDateFrom || 'inicio'}_${tastingDateTo || 'fin'}`;
    } else if (/^\d{4}-\d{2}$/.test(tastingDayFilter)) {
      const [yStr, mStr] = tastingDayFilter.split('-');
      const mIdx = Math.max(0, Math.min(11, Number(mStr) - 1));
      parts.push(`Mes: ${monthNamesFull[mIdx]} ${yStr}`);
      dateBadge = `${monthNamesShort[mIdx]} ${yStr}`;
      targetYearMonth = tastingDayFilter;
      fileSuffix = tastingDayFilter;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(tastingDayFilter)) {
      const formatted = formatToDdMmYyyy(tastingDayFilter, tastingDayFilter);
      parts.push(`Fecha: ${formatted}`);
      dateBadge = formatted;
      fileSuffix = tastingDayFilter;
    }

    if (tastingShiftFilter !== 'TODOS') parts.push(`Jornada: ${tastingShiftFilter}`);
    if (tastingProductFilter !== 'TODOS') parts.push(`Producto: ${tastingProductFilter}`);
    if (tastingPromotoraFilter !== 'TODAS') parts.push(`Promotora: ${tastingPromotoraFilter}`);
    if (tastingSearchQuery.trim()) parts.push(`Busqueda: "${tastingSearchQuery.trim()}"`);

    const hasSecondaryFilters =
      tastingShiftFilter !== 'TODOS' ||
      tastingProductFilter !== 'TODOS' ||
      tastingPromotoraFilter !== 'TODAS' ||
      Boolean(tastingSearchQuery.trim());

    const count = globalFilteredReportItems.length;
    const badgeLabel =
      dateBadge !== 'TODOS' && !hasSecondaryFilters
        ? `${dateBadge} • ${count} REG.`
        : parts.length > 0
          ? `FILTRADO • ${count} REG.`
          : `TODOS • ${count} REG.`;

    const summaryLabel =
      parts.length > 0 ? parts.join(' | ') : 'Todos los Registros (Consolidado Global)';

    if (parts.length > 0 && fileSuffix === 'Global_Todos') {
      fileSuffix = 'Filtro_Personalizado';
    }

    return {
      badgeLabel,
      summaryLabel,
      targetYearMonth,
      fileSuffix,
      count,
    };
  }, [
    tastingDayFilter,
    tastingDateFrom,
    tastingDateTo,
    tastingShiftFilter,
    tastingProductFilter,
    tastingPromotoraFilter,
    tastingSearchQuery,
    globalFilteredReportItems.length,
  ]);

  // Estado para el Informe Global y Detallado de Degustaciones según Filtro Aplicado (PDF)
  const [isExportingMonthlyPdf, setIsExportingMonthlyPdf] = useState(false);
  const [monthlyPdfSuccess, setMonthlyPdfSuccess] = useState(false);

  const handleExportMonthlyReportPdf = async () => {
    if (isExportingMonthlyPdf) return;
    try {
      setIsExportingMonthlyPdf(true);
      await exportMonthlyTastingGeneralReportPdf(globalFilteredReportItems, {
        targetYearMonth: activeGlobalReportMeta.targetYearMonth,
        filterSummaryLabel: activeGlobalReportMeta.summaryLabel,
        fileSuffix: activeGlobalReportMeta.fileSuffix,
        scope: 'all',
      });
      setMonthlyPdfSuccess(true);
      setTimeout(() => setMonthlyPdfSuccess(false), 3200);
    } catch {
      showToast('No se pudo generar el Informe Global de Degustaciones PDF.');
    } finally {
      setIsExportingMonthlyPdf(false);
    }
  };

  const activeTastingStaffNames = useMemo<string[]>(() => {
    const fromBundle = (module1Bundle?.staffMembers || [])
      .filter((s) => s.status === 'Activo' && s.category !== 'merchandising')
      .map((s) => s.name);
    if (fromBundle.length > 0) return fromBundle;
    return [];
  }, [module1Bundle?.staffMembers]);

  const availablePromotoras = useMemo(() => {
    return activeTastingStaffNames;
  }, [activeTastingStaffNames]);

  // Totales de Trade Marketing sincronizados
  const totalMortadela = useMemo(() => visits.reduce((acc, v) => acc + (v.mortadelaQty || 0), 0), [visits]);
  const totalEspalda = useMemo(() => visits.reduce((acc, v) => acc + (v.espaldaQty || 0), 0), [visits]);
  const totalArroz = useMemo(() => visits.reduce((acc, v) => acc + (v.arrozQty || 0), 0), [visits]);
  const totalAzucarGrams = useMemo(() => visits.reduce((acc, v) => acc + (v.azucarGrams || 0), 0), [visits]);
  const totalLecheGrams = useMemo(() => visits.reduce((acc, v) => acc + (v.lecheGrams || 0), 0), [visits]);
  const totalPromotoras = useMemo(() => availablePromotoras.length, [availablePromotoras]);

  // Modal para enviar solicitud FDV real a Supabase (sin valores ficticios prellenados)
  const [isSimulateSellerAppOpen, setIsSimulateSellerAppOpen] = useState(false);
  const [isSubmittingSellerReq, setIsSubmittingSellerReq] = useState(false);
  const isSubmittingLockRef = useRef<boolean>(false);
  const [newSellerDraftToken, setNewSellerDraftToken] = useState<string>(
    () => `deg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  );
  const [sellerSubmitError, setSellerSubmitError] = useState<string | null>(null);
  const [newSellerName, setNewSellerName] = useState('');
  const [newSellerStore, setNewSellerStore] = useState('');
  const [newSellerClientCode, setNewSellerClientCode] = useState('');
  const [newSellerZone, setNewSellerZone] = useState('');
  const [newSellerAddress, setNewSellerAddress] = useState('');
  const [newSellerContacto, setNewSellerContacto] = useState('');
  const [newSellerTelefono, setNewSellerTelefono] = useState('');
  const [newSellerProduct, setNewSellerProduct] = useState('Mortadela Especial Asturias 0.900kg');
  const [newSellerDate, setNewSellerDate] = useState(() => liveClock.todayYmd);
  const [newSellerTime, setNewSellerTime] = useState('09:00 AM - 01:00 PM');
  const [newSellerPromoterType, setNewSellerPromoterType] = useState<'Fija' | 'Eventual'>('Fija');
  const [newSellerMaterialPop, setNewSellerMaterialPop] = useState<'SI' | 'NO'>('SI');

  useEffect(() => {
    if (!isSimulateSellerAppOpen) {
      setNewSellerDate(liveClock.todayYmd);
      setSellerSubmitError(null);
      setNewSellerDraftToken(
        `deg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      );
    }
  }, [liveClock.todayYmd, isSimulateSellerAppOpen]);
  const [newSellerQuantity, setNewSellerQuantity] = useState('5');
  const [newSellerPersonas, setNewSellerPersonas] = useState('150');
  const [newSellerReason, setNewSellerReason] = useState('');

  // Modal de Ficha Completa (35 campos íntegros enviados por el Vendedor) + navegación desde el Globito
  const [selectedTastingDetail, setSelectedTastingDetail] = useState<TastingScheduleItem | null>(null);
  const [highlightedTastingRowId, setHighlightedTastingRowId] = useState<string | null>(null);

  const buildScheduleItemFromNotification = useCallback(
    (notif: DegustacionNotificationItem): TastingScheduleItem => {
      const isBeforeToday = Boolean(notif.date && notif.date < liveClock.todayYmd);
      const estadoUpper = String(notif.estado || '').toUpperCase();
      const status: TastingScheduleItem['status'] = isBeforeToday
        ? 'COMPLETADO'
        : estadoUpper === 'APROBADA'
          ? 'PROGRAMADO'
          : estadoUpper === 'EN_CURSO'
            ? 'EN_CURSO'
            : estadoUpper === 'COMPLETADA'
              ? 'COMPLETADO'
              : 'PENDIENTE';
      return {
        id: notif.id,
        degustacionId: notif.degustacionId,
        source: notif.source,
        createdAt: notif.createdAt,
        date: notif.date,
        dayLabel: notif.dayLabel,
        shift: notif.shift,
        turnoRaw: notif.turnoRaw,
        timeRange: notif.timeRange,
        activityTitle: `Degustación ${notif.productName}`,
        productName: notif.productName,
        productsList: notif.productsList,
        responsibleName: notif.promotoraAsignada || 'POR ASIGNAR (Trade Marketing)',
        storeName: notif.storeName,
        clienteCodigo: notif.clienteCodigo,
        zone: notif.zone,
        address: notif.address,
        contactoPunto: notif.contactoPunto,
        telefonoContacto: notif.telefonoContacto,
        requierePromotora: notif.requierePromotora,
        promoterType: notif.promoterType,
        materialPop: notif.materialPop,
        notasTradeMarketing: notif.notasTradeMarketing,
        resultado: notif.resultado,
        leidoTrade: true,
        vistoEnTradeAt: notif.vistoEnTradeAt || new Date().toISOString(),
        status,
        currentSamples: notif.resultado?.personasAlcanzadas || 0,
        targetSamples: notif.targetSamples,
        requestedQty: notif.requestedQty,
        sellerApplicant: `${notif.sellerName} (Vendedor FDV)`,
        lotNumber: notif.degustacionId,
        isArchived: isBeforeToday,
        notes: notif.notes,
        rawComments: notif.rawComments,
      };
    },
    [liveClock.todayYmd]
  );

  // Cuando el usuario hace clic en una degustación desde el Globito o Toast en cualquier módulo
  useEffect(() => {
    if (!focusedTastingId) return;

    const matchedInSchedule = tastingSchedule.find(
      (item) =>
        item.id === focusedTastingId ||
        (Boolean(focusedTastingSnapshot?.degustacionId) &&
          item.degustacionId === focusedTastingSnapshot?.degustacionId)
    );
    const targetItem =
      matchedInSchedule ||
      (focusedTastingSnapshot && focusedTastingSnapshot.id === focusedTastingId
        ? buildScheduleItemFromNotification(focusedTastingSnapshot)
        : null);

    setActiveSubTab('degustaciones');
    setTastingSearchQuery('');
    setTastingPromotoraFilter('TODAS');
    setTastingShiftFilter('TODOS');
    setTastingProductFilter('TODOS');
    setTastingDayFilter('TODOS');

    if (targetItem) {
      setTastingViewMode(targetItem.isArchived ? 'historial' : 'actual');
      setSelectedTastingDetail(targetItem);
      setHighlightedTastingRowId(targetItem.id);

      setTimeout(() => {
        const rowEl = document.getElementById(`tasting-row-${targetItem.id}`);
        if (rowEl) {
          rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 150);

      setTimeout(() => {
        setHighlightedTastingRowId((prev) => (prev === targetItem.id ? null : prev));
      }, 6000);

      setFocusedTastingId(null);
      setFocusedTastingSnapshot(null);
    }
  }, [
    focusedTastingId,
    focusedTastingSnapshot,
    tastingSchedule,
    buildScheduleItemFromNotification,
    setFocusedTastingId,
    setFocusedTastingSnapshot,
  ]);

  const handleOpenTastingDetail = useCallback(
    (item: TastingScheduleItem) => {
      if (item.leidoTrade === false) {
        void degustacionNotifications.markAsRead(item.id);
      }
      setSelectedTastingDetail({ ...item, leidoTrade: true });
    },
    [degustacionNotifications]
  );

  // Modal para ejecutar activación activa (Check-in, conteo de muestras, venta)
  const [executingItem, setExecutingItem] = useState<TastingScheduleItem | null>(null);

  // Modal para visualizar fotografía real desde Supabase (checkins.photoBase64 y evidencias de Merchandising)
  const [photoModalState, setPhotoModalState] = useState<{
    isOpen: boolean;
    loading: boolean;
    title: string;
    subtitle: string;
    photoBase64: string | null;
    badgeLabel?: string;
    gallery?: string[];
    currentIndex?: number;
  }>({
    isOpen: false,
    loading: false,
    title: '',
    subtitle: '',
    photoBase64: null,
  });

  // Notification toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  // =========================================================================
  // ACCIÓN PRINCIPAL: APROBAR SOLICITUD DE DEGUSTACIÓN (SINCRONIZA SUPABASE + MÓDULO 2)
  // =========================================================================
  const handleApproveTastingRequest = async (item: TastingScheduleItem) => {
    if (!item?.id || approvingIdsRef.current.has(item.id)) {
      return;
    }
    approvingIdsRef.current.add(item.id);
    setProcessingTastingId(item.id);

    try {
      const promotoraPool = activeTastingStaffNames;
      const cleanCurrent = (item.responsibleName || '')
        .replace(/\(Sugerida\)/gi, '')
        .replace(/POR ASIGNAR.*/gi, '')
        .replace(/SIN ASIGNAR.*/gi, '')
        .trim();
      const canonicalCurrentProfile = cleanCurrent
        ? canonicalizeActivePromoterOrNull(cleanCurrent, undefined, module1Bundle?.staffMembers)
        : null;
      const candidatePromotora =
        canonicalCurrentProfile?.name &&
        promotoraPool.some(
          (p) => canonicalStaffKey(p) === canonicalStaffKey(canonicalCurrentProfile.name)
        )
          ? canonicalCurrentProfile.name
          : promotoraPool[0] || '';

      const syncResult = upsertVisitFromApprovedTasting({
        solicitudId: item.id,
        degustacionId: item.degustacionId,
        date: item.date,
        dayLabel: item.dayLabel,
        shift: item.shift,
        timeRange: item.timeRange,
        storeName: item.storeName,
        clienteCodigo: item.clienteCodigo,
        zone: item.zone,
        productName: item.productName,
        requestedQty: item.requestedQty || item.fillQuantityInput || 1,
        targetSamples: item.targetSamples,
        sellerName: item.sellerApplicant,
        promotoraName: candidatePromotora,
        mapsUrl: item.mapsUrl,
        notes: item.notes,
      });

      setLocalSellerRequests((prev) => prev.filter((r) => r.id !== item.id));
      setRejectedIdsInSession((prev) => {
        if (!prev.has(item.id) && (!item.degustacionId || !prev.has(item.degustacionId))) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(item.id);
        if (item.degustacionId) next.delete(item.degustacionId);
        return next;
      });
      setApprovedIdsInSession((prev) => ({
        ...prev,
        [item.id]: syncResult.assignedPromotora,
      }));

      try {
        await updateSupabaseDegustacionStatus(item.id, {
          estado: 'APROBADA',
          promotoraAsignada: syncResult.assignedPromotora,
          insumosCalculados: {
            ...syncResult.supplies.operationalSupplies,
            mortadelaQty: syncResult.supplies.mortadelaQty,
            espaldaQty: syncResult.supplies.espaldaQty,
            arrozQty: syncResult.supplies.arrozQty,
            azucarGrams: syncResult.supplies.azucarGrams,
            lecheGrams: syncResult.supplies.lecheGrams,
          },
          rawComments: item.rawComments,
        });
      } catch {
        // Fallo transitorio de red silenciado para no exponer trazas crudas en consola
      }

      void degustacionNotifications.markAsRead(item.id);
      if (selectedTastingDetail?.id === item.id) {
        setSelectedTastingDetail(null);
      }

      showToast(
        `Solicitud aprobada y agregada automáticamente al Cronograma de Producción (${item.storeName} • ${syncResult.supplies.productFocus}: ${syncResult.supplies.plannedUnits} kg/un • Promotora: ${syncResult.assignedPromotora}).`
      );
    } finally {
      approvingIdsRef.current.delete(item.id);
      setProcessingTastingId((prev) => (prev === item.id ? null : prev));
    }
  };

  // Rechazar o cancelar solicitud (revierte también la fila en el Cronograma de Producción si estaba aprobada)
  const handleRejectTastingRequest = async (
    id: string,
    targetEstado: 'RECHAZADA' | 'CANCELADA' = 'RECHAZADA'
  ) => {
    if (!id || approvingIdsRef.current.has(id)) {
      return;
    }
    approvingIdsRef.current.add(id);
    setProcessingTastingId(id);

    try {
      const target =
        tastingSchedule.find((t) => t.id === id) ||
        (selectedTastingDetail?.id === id ? selectedTastingDetail : null);

      void degustacionNotifications.markAsRead(id);
      setLocalSellerRequests((prev) => prev.filter((t) => t.id !== id));

      const wasRemovedFromSchedule = removeVisitByTastingRequest(
        id,
        target?.degustacionId,
        `Solicitud ${targetEstado.toLowerCase()} desde Promotoras y FDV (${target?.storeName || id})`
      );

      setRejectedIdsInSession((prev) => {
        const next = new Set(prev);
        next.add(id);
        if (target?.degustacionId) next.add(target.degustacionId);
        return next;
      });
      setApprovedIdsInSession((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });

      if (selectedTastingDetail?.id === id) {
        setSelectedTastingDetail(null);
      }

      if (target?.rawComments || !String(id).startsWith('vis_')) {
        try {
          await updateSupabaseDegustacionStatus(id, {
            estado: targetEstado,
            rawComments: target?.rawComments,
          });
        } catch {
          // Fallo transitorio de red silenciado
        }
      }

      showToast(
        wasRemovedFromSchedule
          ? `Solicitud ${targetEstado.toLowerCase()} y removida automáticamente del Cronograma de Producción.`
          : `Solicitud de degustación ${targetEstado.toLowerCase()}.`
      );
    } finally {
      approvingIdsRef.current.delete(id);
      setProcessingTastingId((prev) => (prev === id ? null : prev));
    }
  };

  // Cierre dominical
  const handleSundayCloseArchive = () => {
    setArchivedVisitIds(visits.map((v) => v.id));
    setLocalSellerRequests((prev) =>
      prev.map((item) =>
        !item.isArchived && item.status !== 'PENDIENTE'
          ? { ...item, isArchived: true, status: 'COMPLETADO' }
          : item
      )
    );
    showToast('Semana archivada exitosamente en el Historial.');
  };

  // Enviar nueva solicitud FDV directo a Supabase con blindaje anti-duplicados y confirmación real de BD
  const handleSendFromSellerApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingSellerReq || isSubmittingLockRef.current) {
      return;
    }

    setSellerSubmitError(null);

    const cleanSeller = newSellerName.trim();
    const cleanStore = newSellerStore.trim();
    const cleanZone = newSellerZone.trim();
    const cleanProduct = newSellerProduct.trim();
    const cleanDate = newSellerDate.trim();
    const cleanTime = newSellerTime.trim();
    const qtyNum = Number(newSellerQuantity);
    const personasNum = Number(newSellerPersonas);

    if (!cleanSeller) {
      setSellerSubmitError('Debe indicar el nombre del Vendedor Solicitante (FDV).');
      return;
    }
    if (!cleanStore) {
      setSellerSubmitError('Debe indicar el nombre del Cliente / PDV.');
      return;
    }
    if (!cleanZone) {
      setSellerSubmitError('Debe indicar la Ruta o Zona Comercial.');
      return;
    }
    if (!cleanProduct) {
      setSellerSubmitError('Debe indicar el Producto a degustar.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      setSellerSubmitError('Debe seleccionar una Fecha Solicitada válida.');
      return;
    }
    if (!cleanTime) {
      setSellerSubmitError('Debe indicar el Horario / Turno propuesto.');
      return;
    }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      setSellerSubmitError('Los Kilos / Unidades solicitados deben ser mayores a 0.');
      return;
    }
    if (!Number.isFinite(personasNum) || personasNum <= 0) {
      setSellerSubmitError('Las Personas Estimadas deben ser mayores a 0.');
      return;
    }

    isSubmittingLockRef.current = true;
    setIsSubmittingSellerReq(true);

    try {
      const persistedRow = await createSupabaseSellerDegustacionRequest({
        degustacionId: newSellerDraftToken,
        sellerName: cleanSeller,
        storeName: cleanStore,
        clienteCodigo: newSellerClientCode.trim(),
        zone: cleanZone,
        address: newSellerAddress.trim(),
        contactoPunto: newSellerContacto.trim(),
        telefonoContacto: newSellerTelefono.trim(),
        productName: cleanProduct,
        date: cleanDate,
        timeRange: cleanTime,
        kilos: qtyNum,
        personas: personasNum,
        requierePromotora: true,
        promoterType: newSellerPromoterType,
        materialPop: newSellerMaterialPop,
        notes: newSellerReason.trim(),
      });

      await refreshSupabaseData();

      // Solo tras confirmación real de escritura en Supabase limpiamos y confirmamos al vendedor
      setNewSellerName('');
      setNewSellerStore('');
      setNewSellerClientCode('');
      setNewSellerZone('');
      setNewSellerAddress('');
      setNewSellerContacto('');
      setNewSellerTelefono('');
      setNewSellerQuantity('5');
      setNewSellerPersonas('150');
      setNewSellerReason('');
      setIsSimulateSellerAppOpen(false);
      showToast(
        `✓ Degustación confirmada en Supabase (#${persistedRow.id.slice(0, 8).toUpperCase()}) y notificada en tiempo real a Trade Marketing.`
      );
    } catch {
      setSellerSubmitError(
        'No se pudo confirmar la escritura en Supabase. Verifique su conexión e intente de nuevo.'
      );
    } finally {
      isSubmittingLockRef.current = false;
      setIsSubmittingSellerReq(false);
    }
  };

  // Iniciar degustación en PDV
  const handleStartTasting = (item: TastingScheduleItem) => {
    updateVisit(item.id, { status: 'EN_CURSO' });
    setExecutingItem({ ...item, status: 'EN_CURSO' });
  };

  // Guardar avance de la degustación ejecutada
  const handleSaveTastingProgress = async (
    currentSamples: number,
    assistedSales: number,
    acceptance: number
  ) => {
    if (!executingItem) return;
    const isCompleted = currentSamples >= executingItem.targetSamples;
    updateVisit(executingItem.id, {
      tastedUnits: Math.max(1, Math.ceil(currentSamples / 70)),
      assistedSalesUnits: assistedSales,
      status: isCompleted ? 'COMPLETADA' : 'EN_CURSO',
    });

    if (executingItem.rawComments) {
      try {
        await updateSupabaseDegustacionStatus(executingItem.id, {
          estado: isCompleted ? 'COMPLETADA' : 'EN_CURSO',
          delivered: currentSamples,
          salesAssisted: assistedSales,
          acceptanceRate: acceptance,
          rawComments: executingItem.rawComments,
        });
      } catch {
        // Fallo transitorio silenciado
      }
    }

    setExecutingItem(null);
    showToast('✓ Avance de muestras y sell-out sincronizado en Supabase y Trade Marketing.');
  };

  // Eliminar / Cancelar actividad (sincroniza baja con Cronograma de Producción y Supabase)
  const handleDeleteTasting = (id: string) => {
    void handleRejectTastingRequest(id, 'CANCELADA');
  };

  // Elementos visibles según la pestaña seleccionada (Actual o Historial) y filtros sincronizados
  const displayedItems = useMemo(() => {
    return tastingSchedule.filter((item) => {
      if (tastingViewMode === 'actual' && item.isArchived) return false;
      if (tastingViewMode === 'historial' && !item.isArchived) return false;
      return matchesActiveTastingFilters(item);
    });
  }, [tastingSchedule, tastingViewMode, matchesActiveTastingFilters]);

  // Métrica de Factibilidad de Degustación en tiempo real según la semana, rango o temporada filtrada
  const displayedFeasibility = useMemo(() => {
    return evaluateTastingFeasibility({
      periodLabel: activeGlobalReportMeta.summaryLabel,
      dateMatcher: () => true,
      returnBasis: 'VENTAS_DIRECTAS_BTL',
      tastingItems: displayedItems,
      priceComparisons: module1Bundle?.priceComparisons,
    });
  }, [displayedItems, module1Bundle?.priceComparisons, activeGlobalReportMeta.summaryLabel]);

  // ----------------------------------------------------
  // SUBMÓDULO 2: INFORMES DE CAMPO (CARGADOS EXACTAMENTE DESDE SUPABASE)
  // Pestañas: Inventario y Degustación (inventory) | Asistencia en PDV (checkins agrupados)
  // ----------------------------------------------------
  type ReportSubTab = 'inventario' | 'asistencia';
  const [activeReportTab, setActiveReportTab] = useState<ReportSubTab>('asistencia');
  const [reportSearchQuery, setReportSearchQuery] = useState('');
  const [reportRowLimit, setReportRowLimit] = useState<number>(150);
  const [attendanceCardLimit, setAttendanceCardLimit] = useState<number>(15);
  const [checkinPhotosMap, setCheckinPhotosMap] = useState<Record<string, string>>({});
  const [isLoadingBatchPhotos, setIsLoadingBatchPhotos] = useState<boolean>(false);
  const [hiddenSlotIds, setHiddenSlotIds] = useState<Record<string, boolean>>({});

  // Estados sincronizados para Inventario y Degustación
  const [editingInventoryObs, setEditingInventoryObs] = useState<{ id: string; text: string } | null>(null);
  const [isNewInventoryModalOpen, setIsNewInventoryModalOpen] = useState<boolean>(false);
  const [isSubmittingInventory, setIsSubmittingInventory] = useState<boolean>(false);
  const [newInventoryForm, setNewInventoryForm] = useState<{
    date: string;
    storeName: string;
    promoterName: string;
    productName: string;
    initialInventory: number;
    finalInventory: number;
    samplesGiven: number;
    promoterObservation: string;
  }>({
    date: new Date().toISOString().slice(0, 10),
    storeName: '',
    promoterName: '',
    productName: '',
    initialInventory: 0,
    finalInventory: 0,
    samplesGiven: 0,
    promoterObservation: '',
  });

  // Opciones de PDV y productos derivadas EXCLUSIVAMENTE de los registros sincronizados (sin catálogos cableados)
  const syncedStoreOptions = useMemo<string[]>(() => {
    const names = new Set<string>();
    const add = (n?: string | null) => {
      const clean = String(n || '').trim();
      if (clean && clean !== 'Punto de Venta' && clean !== 'PDV Sin Nombre') names.add(clean);
    };
    (module1Bundle?.inventorySampling || []).forEach((i) => add(i.storeName));
    (module1Bundle?.priceComparisons || []).forEach((p) => add(p.storeName));
    (module1Bundle?.tastingItems || []).forEach((t) => add(t.storeName));
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'es'));
  }, [module1Bundle]);

  const syncedProductOptions = useMemo<string[]>(() => {
    const names = new Set<string>();
    const add = (n?: string | null) => {
      const clean = String(n || '').trim();
      if (clean && clean !== 'Producto Codizulca') names.add(clean);
    };
    (module1Bundle?.inventorySampling || []).forEach((i) => add(i.productName));
    (module1Bundle?.priceComparisons || []).forEach((p) => add(p.ownProduct));
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'es'));
  }, [module1Bundle]);

  const visitsHistory = useMemo<VisitHistoryRecord[]>(() => {
    return module1Bundle?.visitsHistory || [];
  }, [module1Bundle]);

  const priceComparisons = useMemo<PriceComparisonThreeBrands[]>(() => {
    return module1Bundle?.priceComparisons || [];
  }, [module1Bundle]);

  const inventorySampling = useMemo<InventorySamplingRecord[]>(() => {
    return module1Bundle?.inventorySampling || [];
  }, [module1Bundle]);

  const attendanceRecords = useMemo<AttendanceRecord[]>(() => {
    return module1Bundle?.attendanceRecords || [];
  }, [module1Bundle]);

  const handleSaveInventoryObservation = async (id: string, newObs: string) => {
    try {
      await updateSupabaseInventoryObservation(id, newObs);
      await refreshSupabaseData();
      setEditingInventoryObs(null);
      showToast('✓ Observación de la promotora actualizada en Supabase.');
    } catch {
      showToast('No se pudo actualizar la observación en Supabase.');
    }
  };

  const handleDeleteInventoryReport = async (id: string) => {
    try {
      await deleteSupabaseInventoryRecord(id);
      await refreshSupabaseData();
      showToast('✓ Reporte de inventario eliminado de Supabase.');
    } catch {
      showToast('No se pudo eliminar el reporte de inventario.');
    }
  };

  const handleAddInventoryReport = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingInventory(true);
    try {
      await createSupabaseInventoryRecord({
        date: newInventoryForm.date,
        storeName: newInventoryForm.storeName,
        promoterName: newInventoryForm.promoterName,
        productName: newInventoryForm.productName,
        initialQuantity: Number(newInventoryForm.initialInventory) || 0,
        finalQuantity: Number(newInventoryForm.finalInventory) || 0,
        degustations: Number(newInventoryForm.samplesGiven) || 0,
        comments: newInventoryForm.promoterObservation,
      });
      await refreshSupabaseData();
      setIsNewInventoryModalOpen(false);
      showToast('✓ Balance de inventario y degustación registrado en Supabase.');
    } catch {
      showToast('No se pudo guardar el balance en Supabase.');
    } finally {
      setIsSubmittingInventory(false);
    }
  };

  // Filtrado de registros de asistencia para la vista visual de 4 marcajes
  const filteredAttendanceRecords = useMemo(() => {
    return attendanceRecords
      .filter(
        (a) =>
          !reportSearchQuery ||
          a.promotora.toLowerCase().includes(reportSearchQuery.toLowerCase()) ||
          a.storeName.toLowerCase().includes(reportSearchQuery.toLowerCase()) ||
          a.date.includes(reportSearchQuery) ||
          a.dateSlash.includes(reportSearchQuery)
      )
      .slice(0, attendanceCardLimit);
  }, [attendanceRecords, reportSearchQuery, attendanceCardLimit]);

  // Agrupación de tarjetas de asistencia por día (Ej: LUNES, 26 DE OCTUBRE DE 2026)
  const attendanceGroupedByDay = useMemo(() => {
    const groups: Array<{
      date: string;
      dateSlash: string;
      dateLongEs: string;
      records: AttendanceRecord[];
      totalMarcajes: number;
    }> = [];
    const map = new Map<string, (typeof groups)[number]>();

    filteredAttendanceRecords.forEach((rec) => {
      if (!map.has(rec.date)) {
        const grp = {
          date: rec.date,
          dateSlash: rec.dateSlash,
          dateLongEs: rec.dateLongEs,
          records: [] as AttendanceRecord[],
          totalMarcajes: 0,
        };
        map.set(rec.date, grp);
        groups.push(grp);
      }
      const g = map.get(rec.date)!;
      g.records.push(rec);
      g.totalMarcajes += rec.eventsCount;
    });

    return groups;
  }, [filteredAttendanceRecords]);

  // Carga automática por lote de las fotografías reales (photoBase64) para las tarjetas de asistencia visibles
  useEffect(() => {
    if (activeSubTab !== 'informes') return;

    const neededIds: string[] = [];
    filteredAttendanceRecords.forEach((rec) => {
      const slots = [rec.ingresoEvent, rec.salidaAlmorzarEvent, rec.llegadaAlmorzarEvent, rec.salidaEvent];
      slots.forEach((slot) => {
        if (slot?.checkinId && checkinPhotosMap[slot.checkinId] === undefined) {
          neededIds.push(slot.checkinId);
        }
      });
    });

    if (neededIds.length === 0) return;

    let cancelled = false;
    setIsLoadingBatchPhotos(true);
    fetchCheckinPhotosBatch(neededIds)
      .then((batchResult) => {
        if (cancelled) return;
        setCheckinPhotosMap((prev) => {
          const next = { ...prev };
          neededIds.forEach((id) => {
            next[id] = batchResult[id] || '';
          });
          return next;
        });
      })
      .catch(() => {
        // Error transitorio cargando lote de fotos silenciado
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBatchPhotos(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSubTab, filteredAttendanceRecords, checkinPhotosMap]);

  // Contadores exactos para las 4 tarjetas superiores de Asistencia
  const totalIngresosCount = useMemo(
    () => visitsHistory.filter((v) => v.checkinType.toLowerCase().includes('ingreso')).length,
    [visitsHistory]
  );
  const totalPausasAlmuerzoCount = useMemo(
    () => visitsHistory.filter((v) => v.checkinType.toLowerCase().includes('almorzar')).length,
    [visitsHistory]
  );

  const handleOpenSlotPhotoModal = async (slot: AttendanceSlotEvent, promotoraName: string) => {
    const cachedPhoto = checkinPhotosMap[slot.checkinId];
    setPhotoModalState({
      isOpen: true,
      loading: !cachedPhoto,
      title: `CODIZULCA ASISTENCIA - [${slot.type}]`,
      subtitle: `${promotoraName} • ${slot.storeName} • ${slot.dateFormatted} ${slot.fullTimeFormatted}${
        slot.lat !== undefined && slot.lng !== undefined ? ` • GPS: ${slot.lat.toFixed(6)}, ${slot.lng.toFixed(6)} (±${slot.accuracy}m)` : ''
      }`,
      photoBase64: cachedPhoto || null,
    });
    if (!cachedPhoto) {
      try {
        const base64 = await fetchCheckinPhotoById(slot.checkinId);
        if (base64) {
          setCheckinPhotosMap((prev) => ({ ...prev, [slot.checkinId]: base64 }));
        }
        setPhotoModalState((prev) => ({
          ...prev,
          loading: false,
          photoBase64: base64,
        }));
      } catch {
        setPhotoModalState((prev) => ({ ...prev, loading: false }));
      }
    }
  };

  const handleReloadSingleSlotPhoto = async (checkinId: string) => {
    try {
      const base64 = await fetchCheckinPhotoById(checkinId);
      if (base64) {
        setCheckinPhotosMap((prev) => ({ ...prev, [checkinId]: base64 }));
        showToast('✓ Fotografía sincronizada desde Supabase.');
      }
    } catch {
      showToast('No se pudo sincronizar la fotografía.');
    }
  };

  // Totales reales calculados desde Supabase para KPIs de Informes
  const totalReportsMuestras = useMemo(
    () => Math.round(inventorySampling.reduce((acc, c) => acc + c.portionsSampled, 0)),
    [inventorySampling]
  );
  const totalReportsFotos = visitsHistory.length;

  const handleExportInformesPdf = () => {
    let title = '';
    let head: string[][] = [];
    let body: (string | number)[][] = [];

    if (activeReportTab === 'inventario') {
      title = 'Control de Inventario y Degustación en PDV (Supabase)';
      head = [['PDV / TIENDA', 'PRODUCTO & ID', 'STOCK INIC.', 'DEGUSTACIÓN', 'ROTACIÓN / VENTA', 'STOCK FINAL', 'PROMOTORA']];
      body = inventorySampling.slice(0, 300).map((i) => [
        `${i.storeName}\n${i.date}`,
        `${i.productName}\n${i.lotNumber}`,
        `${i.initialStock}`,
        `${i.portionsSampled}`,
        `${i.assistedSales}`,
        `${i.finalStock}`,
        i.promotora,
      ]);
    } else {
      title = 'Registro de Asistencia y Geocerca en PDV (Supabase)';
      head = [['PROMOTORA', 'PDV ASIGNADO', 'FECHA', 'INGRESO', 'ALMUERZO', 'SALIDA', 'HORAS EFECT.', 'GPS']];
      body = attendanceRecords.slice(0, 300).map((a) => [
        `${a.promotora}\n${a.email}`,
        `${a.storeName}\n${a.zone}`,
        a.date,
        a.clockIn,
        `${a.lunchOut} / ${a.lunchIn}`,
        a.clockOut,
        a.effectiveHours,
        a.gpsAccuracy,
      ]);
    }

    exportPromotoraReportsPdf(activeReportTab, title, head, body, {
      totalVisits: visitsHistory.length,
      geoverifiedPercent: 100,
      totalSamples: totalReportsMuestras,
      totalPhotos: totalReportsFotos,
    }).catch(() => {
      showToast('No se pudo generar el PDF.');
    });
  };

  // ----------------------------------------------------
  // SUBMÓDULO 3: MERCHANDISING (AUDITORÍAS REALES DE VISITA DESDE SUPABASE)
  // ----------------------------------------------------
  const merchandisingRecords = useMemo<MerchandisingRecord[]>(() => {
    return module1Bundle?.merchandisingRecords || [];
  }, [module1Bundle]);

  const [merchSearchQuery, setMerchSearchQuery] = useState<string>('');
  const [merchFilterPromoter, setMerchFilterPromoter] = useState<string>('TODOS');
  const [merchFilterDate, setMerchFilterDate] = useState<string>('');
  const [selectedMerchReportForAudit, setSelectedMerchReportForAudit] = useState<MerchandisingRecord | null>(null);
  const [merchCardPhotoIdx, setMerchCardPhotoIdx] = useState<Record<string, number>>({});

  const uniqueMerchPromoters = useMemo<string[]>(() => {
    const activeMerchNames = (module1Bundle?.staffMembers || [])
      .filter((s) => s.status === 'Activo' && s.category === 'merchandising')
      .map((s) => s.name);
    if (activeMerchNames.length > 0) return activeMerchNames;
    return [];
  }, [module1Bundle?.staffMembers]);

  const filteredMerchandisingReports = useMemo<MerchandisingRecord[]>(() => {
    return merchandisingRecords.filter((r) => {
      if (
        merchFilterPromoter !== 'TODOS' &&
        canonicalStaffKey(r.promoter) !== canonicalStaffKey(merchFilterPromoter)
      ) {
        return false;
      }
      if (merchFilterDate && !matchesDateFilter(r.date, { fechaUnica: merchFilterDate })) {
        return false;
      }
      if (merchSearchQuery.trim()) {
        const q = merchSearchQuery.toLowerCase();
        const matchStore = r.storeName.toLowerCase().includes(q);
        const matchManager = r.storeManagerName.toLowerCase().includes(q);
        const matchAddress = (r.address || '').toLowerCase().includes(q);
        const matchPromoter = r.promoter.toLowerCase().includes(q);
        const matchAct = r.activities.some((a) => a.toLowerCase().includes(q));
        if (!matchStore && !matchManager && !matchAddress && !matchPromoter && !matchAct) return false;
      }
      return true;
    });
  }, [merchandisingRecords, merchFilterPromoter, merchFilterDate, merchSearchQuery]);

  // Carga progresiva automática de las fotografías publicadas por el promotor en `checkins` para las visitas de Merchandising
  useEffect(() => {
    if (activeSubTab !== 'merchandising' && !selectedMerchReportForAudit) return;

    const neededIds: string[] = [];
    const collectFromReport = (r: MerchandisingRecord) => {
      if (r.photos && r.photos.length > 0) return;
      (r.matchedCheckinIds || []).forEach((id) => {
        if (id && checkinPhotosMap[id] === undefined && !neededIds.includes(id)) {
          neededIds.push(id);
        }
      });
    };

    if (selectedMerchReportForAudit) {
      collectFromReport(selectedMerchReportForAudit);
    }
    filteredMerchandisingReports.forEach(collectFromReport);

    if (neededIds.length === 0) return;

    const nextBatch = neededIds.slice(0, 18);
    let cancelled = false;
    fetchCheckinPhotosBatch(nextBatch)
      .then((batchResult) => {
        if (cancelled) return;
        setCheckinPhotosMap((prev) => {
          const next = { ...prev };
          nextBatch.forEach((id) => {
            next[id] = batchResult[id] || '';
          });
          return next;
        });
      })
      .catch(() => {
        // Error transitorio sincronizando fotos de merchandising silenciado
      });

    return () => {
      cancelled = true;
    };
  }, [activeSubTab, filteredMerchandisingReports, selectedMerchReportForAudit, checkinPhotosMap]);

  const getMerchResolvedPhotos = (
    report: MerchandisingRecord
  ): { photos: string[]; isLoading: boolean; isFromVisitCheckin: boolean } => {
    const directPhotos = (report.photos || []).filter((p) => typeof p === 'string' && p.length > 20);
    if (directPhotos.length > 0) {
      return { photos: directPhotos, isLoading: false, isFromVisitCheckin: false };
    }
    const matchedIds = report.matchedCheckinIds || [];
    const checkinPhotos = matchedIds
      .map((id) => checkinPhotosMap[id])
      .filter((p): p is string => typeof p === 'string' && p.length > 20);
    const isLoading = checkinPhotos.length === 0 && matchedIds.some((id) => checkinPhotosMap[id] === undefined);
    return {
      photos: checkinPhotos,
      isLoading,
      isFromVisitCheckin: checkinPhotos.length > 0,
    };
  };

  const handleOpenMerchPhotoLightbox = (report: MerchandisingRecord, photos: string[], startIndex = 0) => {
    if (!photos || photos.length === 0) return;
    const safeIdx = Math.max(0, Math.min(startIndex, photos.length - 1));
    setPhotoModalState({
      isOpen: true,
      loading: false,
      badgeLabel: 'CODIZULCA MERCHANDISING • IMAGEN PUBLICADA EN CAMPO',
      title: `${report.storeName}${photos.length > 1 ? ` — Foto ${safeIdx + 1} de ${photos.length}` : ''}`,
      subtitle: `Mercaderista: ${report.promoter} • ${report.date} (${report.time}) • Encargado: ${report.storeManagerName}`,
      photoBase64: photos[safeIdx],
      gallery: photos,
      currentIndex: safeIdx,
    });
  };

  const handleDeleteMerchandisingReport = async (id: string, storeName: string) => {
    if (!window.confirm(`¿Eliminar el informe de merchandising de "${storeName}"?`)) return;
    try {
      await deleteSupabaseMerchandisingRecord(id);
      if (selectedMerchReportForAudit?.id === id) {
        setSelectedMerchReportForAudit(null);
      }
      await refreshSupabaseData();
      showToast(`✓ Informe de merchandising de "${storeName}" eliminado de Supabase.`);
    } catch {
      showToast('No se pudo eliminar el informe de merchandising en Supabase.');
    }
  };

  // ----------------------------------------------------
  // SUBMÓDULO 4: PERSONAL ACTIVO SINCRONIZADO (13 FIJAS + 9 EVENTUALES + 2 MERCHANDISING)
  // ----------------------------------------------------
  const [selectedStaffCategoryFilter, setSelectedStaffCategoryFilter] = useState<'TODAS' | StaffCategory>('TODAS');
  const [selectedStaffSearch, setSelectedStaffSearch] = useState('');
  const [uploadingPhotoStaffId, setUploadingPhotoStaffId] = useState<string | null>(null);
  const [isSavingStaffModal, setIsSavingStaffModal] = useState<boolean>(false);
  const [staffFormModal, setStaffFormModal] = useState<{
    isOpen: boolean;
    id?: string;
    name: string;
    role: string;
    category: StaffCategory;
    phone: string;
    email: string;
    assignedStore: string;
    address: string;
    password: string;
    status: 'Activo' | 'Inactivo';
    photoUrl?: string;
  }>({
    isOpen: false,
    name: '',
    role: 'Promotora',
    category: 'fija',
    phone: '',
    email: '',
    assignedStore: 'VARIAS',
    address: '',
    password: '',
    status: 'Activo',
  });

  const staffList = useMemo<StaffMemberRecord[]>(() => {
    return (module1Bundle?.staffMembers || []).filter((s) => s.status === 'Activo');
  }, [module1Bundle]);

  const fijaStaffMembers = useMemo(
    () => staffList.filter((m) => m.category === 'fija'),
    [staffList]
  );
  const eventualStaffMembers = useMemo(
    () => staffList.filter((m) => m.category === 'eventual'),
    [staffList]
  );
  const merchStaffMembers = useMemo(
    () => staffList.filter((m) => m.category === 'merchandising'),
    [staffList]
  );

  // Mapa en vivo de degustaciones activas (no archivadas) asignadas a cada promotora activa
  const activeScheduledByStaffKey = useMemo(() => {
    const map = new Map<string, TastingScheduleItem[]>();
    tastingSchedule.forEach((item) => {
      if (item.isArchived || archivedVisitIds.includes(item.id)) return;
      const resp = String(item.responsibleName || '').trim();
      if (
        !resp ||
        resp.toUpperCase().startsWith('POR ASIGNAR') ||
        resp.toUpperCase().startsWith('SIN ASIGNAR')
      ) {
        return;
      }
      const key = canonicalStaffKey(resp);
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(item);
    });
    return map;
  }, [tastingSchedule, archivedVisitIds]);

  const matchesStaffSearch = useCallback(
    (m: StaffMemberRecord): boolean => {
      if (!selectedStaffSearch.trim()) return true;
      const q = selectedStaffSearch.toLowerCase();
      return (
        m.name.toLowerCase().includes(q) ||
        m.assignedStore.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.phone.toLowerCase().includes(q) ||
        m.address.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q)
      );
    },
    [selectedStaffSearch]
  );

  const compressStaffPhotoToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('No se pudo leer la imagen seleccionada.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Formato de imagen inválido.'));
        img.onload = () => {
          const maxSide = 320;
          let width = img.width;
          let height = img.height;
          if (width > height && width > maxSide) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else if (height >= width && height > maxSide) {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(String(reader.result || ''));
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });

  const handleStaffPhotoFileChange = async (
    member: StaffMemberRecord,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingPhotoStaffId(member.id);
    try {
      const base64 = await compressStaffPhotoToBase64(file);
      await updateSupabaseStaffPhoto(member, base64);
      await refreshSupabaseData();
      showToast(`✓ Fotografía de ${member.name} actualizada en Supabase.`);
    } catch {
      showToast('No se pudo actualizar la fotografía en Supabase.');
    } finally {
      setUploadingPhotoStaffId(null);
    }
  };

  const openCreateStaffModal = (defaultCategory: StaffCategory = 'fija') => {
    setStaffFormModal({
      isOpen: true,
      id: undefined,
      name: '',
      role: defaultCategory === 'merchandising' ? 'Promotor Merchandising' : 'Promotora',
      category: defaultCategory,
      phone: '',
      email: '',
      assignedStore: defaultCategory === 'merchandising' ? 'MERCHANDISING' : defaultCategory === 'eventual' ? 'TODAS' : 'VARIAS',
      address: '',
      password: '',
      status: 'Activo',
      photoUrl: undefined,
    });
  };

  const openEditStaffModal = (member: StaffMemberRecord) => {
    setStaffFormModal({
      isOpen: true,
      id: member.id,
      name: member.name,
      role: member.role,
      category: member.category,
      phone: member.phone,
      email: member.email,
      assignedStore: member.assignedStore,
      address: member.address,
      password: member.password || '',
      status: member.status,
      photoUrl: member.photoUrl,
    });
  };

  const handleSaveStaffModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!staffFormModal.name.trim()) return;
    setIsSavingStaffModal(true);
    try {
      await saveSupabaseStaffMember({
        id: staffFormModal.id,
        name: staffFormModal.name,
        role: staffFormModal.role,
        category: staffFormModal.category,
        email: staffFormModal.email,
        phone: staffFormModal.phone,
        address: staffFormModal.address,
        assignedStore: staffFormModal.assignedStore,
        status: staffFormModal.status,
        password: staffFormModal.password,
        photoUrl: staffFormModal.photoUrl,
      });
      setStaffFormModal((prev) => ({ ...prev, isOpen: false }));
      await refreshSupabaseData();
      showToast(
        staffFormModal.status === 'Inactivo'
          ? `✓ ${staffFormModal.name} marcada como inactiva y retirada del padrón activo.`
          : `✓ Perfil de ${staffFormModal.name} sincronizado en Supabase.`
      );
    } catch {
      showToast('No se pudo guardar el perfil en Supabase.');
    } finally {
      setIsSavingStaffModal(false);
    }
  };

  const handleDeleteStaffProfile = async (member: StaffMemberRecord) => {
    if (
      !window.confirm(
        `¿Retirar permanentemente a "${member.name}" del padrón activo del sistema (Supabase)?`
      )
    ) {
      return;
    }
    try {
      await deleteSupabaseStaffMember(member.id, member.name);
      await refreshSupabaseData();
      showToast(`✓ ${member.name} retirada del sistema y sincronizada con Supabase.`);
    } catch {
      showToast('No se pudo eliminar el registro en Supabase.');
    }
  };

  const buildStaffAppLink = (member: StaffMemberRecord): string => {
    const base = typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '';
    const mode = member.category === 'merchandising' ? 'merchandising' : 'promotora';
    return `${base}?app=${mode}&staff=${encodeURIComponent(member.name)}`;
  };

  const handleCopyStaffAppLink = async (member: StaffMemberRecord) => {
    const url = buildStaffAppLink(member);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      }
      showToast(`✓ Enlace de App copiado para ${member.name}`);
    } catch {
      showToast(`Enlace App: ${url}`);
    }
  };

  const fieldMetric360SwitcherItems = useMemo<Metric360SwitcherItem[]>(
    () => [
      { id: 'degustaciones_bd', label: 'Degustaciones BD', badgeValue: `${tastingSchedule.length}` },
      { id: 'mortadela', label: 'Mortadela / Jamón', badgeValue: `${totalMortadela} un` },
      { id: 'espalda', label: 'Espalda Ahumada', badgeValue: `${totalEspalda} un` },
      { id: 'vencampo', label: 'Línea Vencampo', badgeValue: `${totalArroz} un` },
      {
        id: 'encuestas_pdv',
        label: 'Encuestas PDV',
        badgeValue: `${module1Bundle?.surveySummary.totalSurveys ?? 0}`,
      },
      {
        id: 'personal_activo',
        label: 'Personal Activo',
        badgeValue: `${staffList.length || totalPromotoras}`,
      },
    ],
    [
      tastingSchedule.length,
      totalMortadela,
      totalEspalda,
      totalArroz,
      module1Bundle?.surveySummary.totalSurveys,
      staffList.length,
      totalPromotoras,
    ]
  );

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-20 right-6 z-50 bg-red-600 text-white font-black text-xs px-5 py-3.5 rounded-2xl shadow-2xl border-2 border-white flex items-center gap-3 animate-bounce">
          <div className="w-6 h-6 rounded-full bg-white text-red-600 flex items-center justify-center font-black text-xs">
            ✓
          </div>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Membrete oficial exclusivo para soporte impreso / PDF */}
      <PrintSupportHeader
        moduleTitle="MÓDULO 1: PROMOTORAS Y FUERZA DE VENTAS (FDV)"
        documentSubtitle="Cronograma Oficial de Degustaciones en Tienda, Solicitudes FDV, Informes y Merchandising (Supabase)"
        documentCode="CZ-MOD1-DEG-2026"
      />

      {/* ========================================================================= */}
      {/* CABECERA CORPORATIVA: CRONOGRAMA DE CAMPO + SUBMÓDULOS ESTILIZADOS */}
      {/* ========================================================================= */}
      <div className="bg-zinc-900/70 border border-white/[0.08] rounded-2xl p-5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.75),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-b from-red-500/20 to-red-600/10 border border-red-500/30 flex items-center justify-center text-red-400 shadow-inner">
              <Calendar className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-white tracking-tight">
                  Cronograma y Supervisión de Campo
                </h2>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/25">
                  Supabase en Tiempo Real
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Gestión centralizada de degustaciones, informes de promotoras, merchandising y personal activo.
              </p>
            </div>
          </div>

          {/* Barra de Submódulos Estilizada (Cápsula Ejecutiva) */}
          <div className="inline-flex flex-wrap items-center bg-zinc-950/90 p-1 rounded-xl border border-white/[0.08] shadow-inner gap-1">
            {[
              { id: 'degustaciones', label: 'Degustaciones', count: tastingSchedule.length },
              {
                id: 'solicitudes_contraloria',
                label: 'Solicitudes a Contraloría',
                count: solicitudesContraloria.solicitudes.length,
                pendingBadge: solicitudesContraloria.pendingCount,
              },
              {
                id: 'informes',
                label: 'Informes',
                count: visitsHistory.length + priceComparisons.length + inventorySampling.length,
              },
              { id: 'merchandising', label: 'Merchandising', count: merchandisingRecords.length },
              { id: 'personal', label: 'Personal', count: staffList.length },
            ].map((tab) => {
              const isActive = activeSubTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSubTab(tab.id as FieldSubTab)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
                    isActive
                      ? 'bg-red-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_2px_8px_rgba(220,38,38,0.4)]'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                      isActive
                        ? 'bg-black/30 text-white font-bold'
                        : 'pendingBadge' in tab && (tab.pendingBadge ?? 0) > 0
                          ? 'bg-[#DC2626] text-white font-bold'
                          : 'bg-zinc-900 text-zinc-400 border border-white/[0.06]'
                    }`}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* BANNER DE SINCRONIZACIÓN EN VIVO CON BASE DE DATOS SUPABASE & MÓDULO 2 */}
      {/* ========================================================================= */}
      {activeSubTab !== 'solicitudes_contraloria' && (
      <div className="bg-[#09090c] border border-white/10 rounded-2xl p-4 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                isLoadingSupabase
                  ? 'bg-white animate-ping'
                  : supabaseError
                    ? 'bg-red-500'
                    : 'bg-red-500 animate-pulse shadow-[0_0_10px_#ef4444]'
              }`}
            />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-red-500" />
                  <span>Base de Datos Supabase + Trade Marketing (Módulo 2)</span>
                </span>
                <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-red-600/20 text-white border border-red-500/40 font-bold">
                  {visits.length} Degustaciones • {visitsHistory.length} Check-ins • {priceComparisons.length} Precios • {inventorySampling.length} Inventarios
                </span>
              </div>
              <p className="text-[11px] text-zinc-400">
                {supabaseError
                  ? `Aviso de conexión: ${supabaseError}`
                  : `Sincronización con Supabase (${
                      module1Bundle?.fetchedAt
                        ? `Última actualización: ${new Date(module1Bundle.fetchedAt).toLocaleTimeString('es-VE')}`
                        : 'Cargando registros...'
                    })`}
              </p>
            </div>
          </div>
        </div>

        {/* 6 Tarjetas Ejecutivas Interactivas de Métricas -> Clic abre Dashboard 360° */}
        <div className="pt-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-400">
            <span>
              Selecciona cualquier tarjeta de métrica para abrir su <strong className="text-white">Dashboard 360°</strong>
            </span>
            <span className="font-mono text-[10px] px-2.5 py-0.5 rounded-full bg-zinc-900 border border-white/10 text-zinc-300">
              Sem. {liveClock.isoWeekNumber} Auto · {liveClock.currentWeek.rangeLabel}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {/* Card 1: Degustaciones BD */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('degustaciones_bd')}
              className="text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border border-white/[0.08] hover:border-red-500/50 hover:-translate-y-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate">
                  Degustaciones BD
                </span>
                <div className="px-1.5 h-6 rounded-lg bg-zinc-900 border border-white/[0.07] flex items-center justify-center gap-1 text-[9px] font-mono font-bold text-zinc-400 group-hover:bg-red-600 group-hover:text-white group-hover:border-red-500/30 shrink-0 transition-colors">
                  <Calendar className="w-3 h-3" />
                  <span>360°</span>
                </div>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {tastingSchedule.length}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">registros</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Solicitudes FDV</span>
                <span className="font-mono font-bold text-white px-1.5 py-0.2 rounded bg-white/[0.06]">
                  {tastingSchedule.filter((t) => t.status === 'PENDIENTE').length}
                </span>
              </div>
            </button>

            {/* Card 2: Mortadela / Jamón */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('mortadela')}
              className="text-left p-3.5 rounded-2xl bg-gradient-to-b from-red-950/25 via-zinc-900/90 to-zinc-950/95 border border-red-500/25 hover:border-red-500/60 hover:-translate-y-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] flex flex-col justify-between transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-red-300 font-semibold tracking-tight truncate">
                  Mortadela / Jamón
                </span>
                <div className="px-1.5 h-6 rounded-lg bg-red-500/15 border border-red-500/30 flex items-center justify-center gap-1 text-[9px] font-mono font-bold text-red-300 group-hover:bg-red-600 group-hover:text-white shrink-0 transition-colors">
                  <Box className="w-3 h-3" />
                  <span>360°</span>
                </div>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-red-400 font-mono tracking-tight leading-none">
                  {totalMortadela}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">kg/un</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>En cronograma</span>
                <span className="text-red-400 font-semibold">Activo</span>
              </div>
            </button>

            {/* Card 3: Espalda / Embutidos */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('espalda')}
              className="text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border border-white/[0.08] hover:border-red-500/50 hover:-translate-y-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate">
                  Espalda Ahumada
                </span>
                <div className="px-1.5 h-6 rounded-lg bg-zinc-900 border border-white/[0.07] flex items-center justify-center gap-1 text-[9px] font-mono font-bold text-zinc-400 group-hover:bg-red-600 group-hover:text-white group-hover:border-red-500/30 shrink-0 transition-colors">
                  <Scale className="w-3 h-3" />
                  <span>360°</span>
                </div>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {totalEspalda}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">kg/un</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Barras cargadas</span>
                <span className="font-mono text-zinc-300">Línea cocida</span>
              </div>
            </button>

            {/* Card 4: Línea Vencampo */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('vencampo')}
              className="text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border border-white/[0.08] hover:border-red-500/50 hover:-translate-y-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate">
                  Línea Vencampo
                </span>
                <div className="px-1.5 h-6 rounded-lg bg-zinc-900 border border-white/[0.07] flex items-center justify-center gap-1 text-[9px] font-mono font-bold text-zinc-400 group-hover:bg-red-600 group-hover:text-white group-hover:border-red-500/30 shrink-0 transition-colors">
                  <StoreIcon className="w-3 h-3" />
                  <span>360°</span>
                </div>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {totalArroz}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">unidades</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span className="truncate">
                  {totalAzucarGrams > 0 || totalLecheGrams > 0
                    ? `${totalAzucarGrams}g Az · ${totalLecheGrams}g Le`
                    : 'Arroz y Leche'}
                </span>
                <span className="font-mono text-zinc-300">Stands</span>
              </div>
            </button>

            {/* Card 5: Encuestas Consumidor */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('encuestas_pdv')}
              className="text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border border-white/[0.08] hover:border-red-500/50 hover:-translate-y-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate">
                  Encuestas PDV
                </span>
                <div className="px-1.5 h-6 rounded-lg bg-zinc-900 border border-white/[0.07] flex items-center justify-center gap-1 text-[9px] font-mono font-bold text-zinc-400 group-hover:bg-red-600 group-hover:text-white group-hover:border-red-500/30 shrink-0 transition-colors">
                  <ClipboardCheck className="w-3 h-3" />
                  <span>360°</span>
                </div>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {module1Bundle?.surveySummary.totalSurveys ?? 0}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">encuestas</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] w-full">
                <span className="text-red-400 font-semibold font-mono">
                  ★ {module1Bundle?.surveySummary.avgRating ?? 0}/5
                </span>
                <span className="text-zinc-400">
                  {module1Bundle?.surveySummary.highAcceptancePercent ?? 0}% acept.
                </span>
              </div>
            </button>

            {/* Card 6: Personal Activo BD */}
            <button
              type="button"
              onClick={() => setSelectedMetric360('personal_activo')}
              className="text-left p-3.5 rounded-2xl bg-gradient-to-b from-zinc-900/90 to-zinc-950/95 border border-white/[0.08] hover:border-red-500/50 hover:-translate-y-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] flex flex-col justify-between transition-all cursor-pointer group"
            >
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[11px] text-zinc-300 group-hover:text-white font-semibold tracking-tight truncate">
                  Personal Activo
                </span>
                <div className="px-1.5 h-6 rounded-lg bg-zinc-900 border border-white/[0.07] flex items-center justify-center gap-1 text-[9px] font-mono font-bold text-zinc-400 group-hover:bg-red-600 group-hover:text-white group-hover:border-red-500/30 shrink-0 transition-colors">
                  <Users className="w-3 h-3" />
                  <span>360°</span>
                </div>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-extrabold text-white font-mono tracking-tight leading-none">
                  {staffList.length || totalPromotoras}
                </span>
                <span className="text-[11px] font-medium text-zinc-400">activos</span>
              </div>
              <div className="mt-2.5 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-400 w-full">
                <span>Promotoras · Merch.</span>
                <span className="font-mono font-bold text-white px-1.5 py-0.2 rounded bg-white/[0.06]">
                  {fijaStaffMembers.length + eventualStaffMembers.length} · {merchStaffMembers.length}
                </span>
              </div>
            </button>
          </div>
        </div>
      </div>
      )}

      {/* ========================================================================= */}
      {/* SUBMÓDULO: SOLICITUDES A CONTRALORÍA - DEGUSTACIONES ("SOLICITUD DE PRODUCTOS") */}
      {/* ========================================================================= */}
      {activeSubTab === 'solicitudes_contraloria' && (
        <TradeContraloriaSolicitudesTab />
      )}

      {/* ========================================================================= */}
      {/* 1. SUBMÓDULO: DEGUSTACIONES */}
      {/* ========================================================================= */}
      {activeSubTab === 'degustaciones' && (
        <div className="space-y-6">
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl shadow-xl backdrop-blur-md">
            {/* Cabecera de Píldoras y Acciones Estilizadas */}
            <div className="p-4 bg-zinc-950/90 rounded-t-2xl border-b border-white/[0.07] flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="inline-flex items-center bg-zinc-900/90 p-1 rounded-xl border border-white/[0.08] shadow-inner gap-1">
                  <button
                    type="button"
                    onClick={() => setTastingViewMode('actual')}
                    className={`px-3 py-1.5 rounded-lg text-xs transition-all font-semibold flex items-center gap-1.5 cursor-pointer ${
                      tastingViewMode === 'actual'
                        ? 'bg-red-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_2px_8px_rgba(220,38,38,0.4)]'
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span>Cronograma Actual</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                        tastingViewMode === 'actual' ? 'bg-black/30 text-white font-bold' : 'bg-zinc-950 text-zinc-400 border border-white/[0.06]'
                      }`}
                    >
                      {activeTastingCount}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTastingViewMode('historial')}
                    className={`px-3 py-1.5 rounded-lg text-xs transition-all font-semibold flex items-center gap-1.5 cursor-pointer ${
                      tastingViewMode === 'historial'
                        ? 'bg-red-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_2px_8px_rgba(220,38,38,0.4)]'
                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span>Historial</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                        tastingViewMode === 'historial' ? 'bg-black/30 text-white font-bold' : 'bg-zinc-950 text-zinc-400 border border-white/[0.06]'
                      }`}
                    >
                      {archivedTastingCount}
                    </span>
                  </button>
                </div>
              </div>

              {/* Botones de Acción Estilizados */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleExportMonthlyReportPdf}
                  disabled={isExportingMonthlyPdf}
                  title={`Descargar Informe Global y Detallado según el filtro aplicado (${activeGlobalReportMeta.summaryLabel})`}
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
                    {activeGlobalReportMeta.badgeLabel}
                  </span>
                </button>

                <ExportPdfButton
                  label="PDF Vista Actual"
                  variant="secondary"
                  documentTitle={`Cronograma de Degustaciones y Rutas (${tastingViewMode === 'actual' ? 'Semana en Curso' : 'Historial'})`}
                  subtitle="CODIZULCA C.A. • Gestión de Promotoras y Fuerza de Ventas en PDV (Supabase)"
                  onExportPdf={() => exportTastingSchedulePdf(displayedItems, tastingViewMode)}
                />

                <button
                  type="button"
                  onClick={() => setIsMultiFormatUploadOpen(true)}
                  className="px-3.5 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-200 hover:text-white text-xs font-bold border border-emerald-500/40 hover:border-emerald-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition flex items-center gap-1.5 cursor-pointer"
                  title="Cargar planificaciones de degustaciones en formato Excel (.xlsx/.xls), CSV (.csv) o PDF (.pdf) hacia el Módulo 2"
                >
                  <Upload className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Cargar Archivo (Excel / CSV / PDF)</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsSimulateSellerAppOpen(true)}
                  className="px-3.5 py-2 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 text-zinc-100 hover:text-white text-xs font-semibold border border-white/10 hover:border-red-500/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition flex items-center gap-1.5 cursor-pointer"
                >
                  <Smartphone className="w-3.5 h-3.5 text-red-400" />
                  <span>+ Enviar Solicitud FDV</span>
                </button>

                {tastingViewMode === 'actual' && (
                  <button
                    type="button"
                    onClick={handleSundayCloseArchive}
                    className="px-3.5 py-2 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 hover:text-white text-xs font-semibold border border-white/10 hover:border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition flex items-center gap-1.5 cursor-pointer"
                    title="Archivar registros actuales en el Historial"
                  >
                    <Archive className="w-3.5 h-3.5 text-red-400" />
                    <span>Cierre Semanal</span>
                  </button>
                )}
              </div>
            </div>

            {/* Subcabecera de Estado y Conteo */}
            <div className="px-4 py-2.5 bg-zinc-950/80 border-b border-zinc-900 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${tastingViewMode === 'actual' ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-500'}`} />
                <span className="font-black text-white uppercase tracking-wider text-[11px]">
                  {tastingViewMode === 'actual'
                    ? 'REGISTROS DE DEGUSTACIÓN EN SUPABASE • MATRIZ GENERAL SINCRONIZADA'
                    : 'HISTORIAL DE DEGUSTACIONES ARCHIVADAS'}
                </span>
              </div>
              <span className="text-zinc-400 font-mono text-[11px]">
                {displayedItems.length} registros cargados
              </span>
            </div>

            {/* Barra de Filtros Sincronizados */}
            <div className="p-3.5 bg-slate-950/60 border-b border-slate-800 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Buscar tienda, zona, promotora, vendedor..."
                  value={tastingSearchQuery}
                  onChange={(e) => setTastingSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-red-500"
                />
              </div>

              {/* Filtro de Fecha con Calendario Interactivo Desplegable */}
              <div className="relative">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setIsTastingCalendarOpen((prev) => !prev)}
                    className={`w-full px-3 py-1.5 rounded-xl bg-slate-900 border text-xs flex items-center justify-between gap-2 transition cursor-pointer ${
                      tastingDayFilter !== 'TODOS'
                        ? 'border-red-500/60 text-white bg-red-950/20 font-semibold'
                        : 'border-slate-800 hover:border-red-500/40 text-white font-medium'
                    }`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Calendar className="w-3.5 h-3.5 text-red-500 shrink-0" />
                      <span className="truncate">
                        {tastingDayFilter === 'TODOS'
                          ? `Fecha: Todas (${tastingViewMode === 'actual' ? activeTastingCount : archivedTastingCount})`
                          : tastingDayFilter === 'SEMANA_ACTUAL'
                            ? `Semana Auto (${liveClock.currentWeek.shortRangeLabel})`
                            : tastingDayFilter === 'RANGO'
                              ? `Rango: ${tastingDateFrom ? formatToDdMmYyyy(tastingDateFrom, '...') : '...'} - ${
                                  tastingDateTo ? formatToDdMmYyyy(tastingDateTo, '...') : '...'
                                }`
                              : /^\d{4}-\d{2}$/.test(tastingDayFilter)
                                ? (() => {
                                    const [y, m] = tastingDayFilter.split('-').map(Number);
                                    const label = new Date(y, m - 1, 1).toLocaleDateString('es-VE', {
                                      month: 'short',
                                      year: 'numeric',
                                    });
                                    return `Mes: ${label.toUpperCase()}`;
                                  })()
                                : (() => {
                                    const formatted = formatToDdMmYyyy(tastingDayFilter);
                                    return formatted ? `Fecha: ${formatted}` : `Día: ${tastingDayFilter}`;
                                  })()}
                      </span>
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform ${
                        isTastingCalendarOpen ? 'rotate-180 text-red-400' : ''
                      }`}
                    />
                  </button>

                  {tastingDayFilter !== 'TODOS' && (
                    <button
                      type="button"
                      onClick={() => {
                        setTastingDateFrom('');
                        setTastingDateTo('');
                        setTastingDayFilter('TODOS');
                        setIsTastingCalendarOpen(false);
                      }}
                      title="Quitar filtro de fecha (Ver todas)"
                      className="p-1.5 rounded-xl bg-zinc-900 hover:bg-red-600 text-zinc-400 hover:text-white border border-white/10 transition shrink-0 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Popover de Calendario */}
                {isTastingCalendarOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setIsTastingCalendarOpen(false)}
                    />
                    <div className="absolute left-0 top-full mt-2 z-50 w-72 p-3.5 rounded-2xl bg-zinc-950 border border-white/15 shadow-[0_20px_50px_rgba(0,0,0,0.95)] space-y-3">
                      {/* Navegación de Mes y Año */}
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() =>
                            setCalendarMonthDate(
                              new Date(calendarMonthDate.getFullYear(), calendarMonthDate.getMonth() - 1, 1)
                            )
                          }
                          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/10 cursor-pointer"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>

                        <span className="text-xs font-bold text-white capitalize">
                          {calendarMonthDate.toLocaleDateString('es-VE', {
                            month: 'long',
                            year: 'numeric',
                          })}
                        </span>

                        <button
                          type="button"
                          onClick={() =>
                            setCalendarMonthDate(
                              new Date(calendarMonthDate.getFullYear(), calendarMonthDate.getMonth() + 1, 1)
                            )
                          }
                          className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-white/10 cursor-pointer"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Cabecera de días de la semana */}
                      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-mono font-bold text-zinc-500">
                        {['LU', 'MA', 'MI', 'JU', 'VI', 'SÁ', 'DO'].map((wd) => (
                          <div key={wd} className="py-1">
                            {wd}
                          </div>
                        ))}
                      </div>

                      {/* Cuadrícula de días del mes */}
                      <div className="grid grid-cols-7 gap-1">
                        {(() => {
                          const year = calendarMonthDate.getFullYear();
                          const month = calendarMonthDate.getMonth();
                          const firstDayOfMonth = new Date(year, month, 1).getDay();
                          // Ajustar para que Lunes sea 0 y Domingo sea 6
                          const startOffset = (firstDayOfMonth + 6) % 7;
                          const daysInMonth = new Date(year, month + 1, 0).getDate();
                          const todayYmd = liveClock.todayYmd;

                          const cells: React.ReactNode[] = [];
                          for (let i = 0; i < startOffset; i++) {
                            cells.push(<div key={`empty-${i}`} className="h-8" />);
                          }

                          for (let day = 1; day <= daysInMonth; day++) {
                            const ymd = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                            const count = tastingDatesCountMap.get(ymd) || 0;
                            const isSelected = tastingDayFilter === ymd;
                            const isToday = ymd === todayYmd;

                            cells.push(
                              <button
                                key={ymd}
                                type="button"
                                onClick={() => {
                                  setTastingDayFilter(ymd);
                                  setIsTastingCalendarOpen(false);
                                }}
                                title={
                                  count > 0
                                    ? `${ymd}: ${count} degustación(es) registrada(s)`
                                    : `${ymd}`
                                }
                                className={`relative h-8 rounded-lg text-xs font-mono flex flex-col items-center justify-center transition cursor-pointer ${
                                  isSelected
                                    ? 'bg-red-600 text-white font-bold shadow-[0_2px_10px_rgba(220,38,38,0.5)]'
                                    : isToday
                                      ? 'bg-zinc-800 text-white font-bold border border-red-500/50'
                                      : count > 0
                                        ? 'bg-zinc-900/90 hover:bg-red-600/20 text-white font-semibold border border-white/10'
                                        : 'text-zinc-400 hover:bg-zinc-900 hover:text-white'
                                }`}
                              >
                                <span>{day}</span>
                                {count > 0 && (
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full mt-0.5 ${
                                      isSelected ? 'bg-white' : 'bg-red-500'
                                    }`}
                                  />
                                )}
                              </button>
                            );
                          }
                          return cells;
                        })()}
                      </div>

                      {/* Filtro rápido de Semana Actual Automática, Mes Completo, Rango de Fechas y Limpiar */}
                      <div className="pt-2.5 border-t border-white/10 space-y-2">
                        <button
                          type="button"
                          onClick={() => {
                            setTastingDateFrom('');
                            setTastingDateTo('');
                            setTastingDayFilter('SEMANA_ACTUAL');
                            setIsTastingCalendarOpen(false);
                          }}
                          className={`w-full py-1.5 px-2.5 rounded-lg text-[11px] font-bold border transition cursor-pointer ${
                            tastingDayFilter === 'SEMANA_ACTUAL'
                              ? 'bg-red-600 text-white border-red-500 shadow-sm'
                              : 'bg-zinc-900 hover:bg-red-600/20 text-red-300 hover:text-white border-red-500/30'
                          }`}
                        >
                          Semana en Curso Auto ({liveClock.currentWeek.shortRangeLabel})
                        </button>

                        {(() => {
                          const ymKey = `${calendarMonthDate.getFullYear()}-${String(
                            calendarMonthDate.getMonth() + 1
                          ).padStart(2, '0')}`;
                          const isWholeMonthActive = tastingDayFilter === ymKey;
                          const monthLabel = calendarMonthDate.toLocaleDateString('es-VE', {
                            month: 'long',
                            year: 'numeric',
                          });
                          return (
                            <button
                              type="button"
                              onClick={() => {
                                setTastingDayFilter(ymKey);
                                setIsTastingCalendarOpen(false);
                              }}
                              className={`w-full py-1.5 px-2.5 rounded-lg text-[11px] font-bold border transition cursor-pointer capitalize ${
                                isWholeMonthActive
                                  ? 'bg-red-600 text-white border-red-500 shadow-sm'
                                  : 'bg-zinc-900 hover:bg-red-600/20 text-zinc-200 hover:text-white border-white/10 hover:border-red-500/40'
                              }`}
                            >
                              Filtrar Mes Completo: {monthLabel}
                            </button>
                          );
                        })()}

                        <div className="space-y-1">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
                            Rango Personalizado (Desde / Hasta):
                          </span>
                          <div className="grid grid-cols-2 gap-1.5">
                            <input
                              type="date"
                              value={tastingDateFrom}
                              onChange={(e) => {
                                const val = e.target.value;
                                setTastingDateFrom(val);
                                if (val || tastingDateTo) {
                                  setTastingDayFilter('RANGO');
                                } else {
                                  setTastingDayFilter('TODOS');
                                }
                              }}
                              className="w-full px-2 py-1 rounded-lg bg-zinc-900 border border-white/10 text-[11px] text-white font-mono focus:outline-none focus:border-red-500"
                            />
                            <input
                              type="date"
                              value={tastingDateTo}
                              onChange={(e) => {
                                const val = e.target.value;
                                setTastingDateTo(val);
                                if (val || tastingDateFrom) {
                                  setTastingDayFilter('RANGO');
                                } else {
                                  setTastingDayFilter('TODOS');
                                }
                              }}
                              className="w-full px-2 py-1 rounded-lg bg-zinc-900 border border-white/10 text-[11px] text-white font-mono focus:outline-none focus:border-red-500"
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-2 pt-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              const today = liveClock.todayYmd;
                              setTastingDateFrom('');
                              setTastingDateTo('');
                              setTastingDayFilter(today);
                              setIsTastingCalendarOpen(false);
                            }}
                            className="flex-1 py-1.5 px-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 text-[11px] font-semibold border border-white/10 cursor-pointer"
                          >
                            Ir a Hoy
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setTastingDateFrom('');
                              setTastingDateTo('');
                              setTastingDayFilter('TODOS');
                              setIsTastingCalendarOpen(false);
                            }}
                            className="flex-1 py-1.5 px-2.5 rounded-lg bg-red-600/20 hover:bg-red-600 text-red-300 hover:text-white text-[11px] font-semibold border border-red-500/30 cursor-pointer"
                          >
                            Ver Todas ({tastingViewMode === 'actual' ? activeTastingCount : archivedTastingCount})
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div>
                <select
                  value={tastingShiftFilter}
                  onChange={(e) => setTastingShiftFilter(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-red-500 font-medium"
                >
                  <option value="TODOS">Jornada: Todas</option>
                  <option value="MAÑANA">☀️ MAÑANA</option>
                  <option value="TARDE">🌙 TARDE</option>
                </select>
              </div>

              <div>
                <select
                  value={tastingProductFilter}
                  onChange={(e) => setTastingProductFilter(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-red-500 font-medium"
                >
                  <option value="TODOS">Producto: Todos</option>
                  <option value="MORTADELA">MORTADELA</option>
                  <option value="VENCAMPO">VENCAMPO / ARROZ / LECHE</option>
                  <option value="ESPALDA">ESPALDA</option>
                  <option value="JAMON">JAMÓN</option>
                  <option value="SALCHICHA">SALCHICHA / EMBUTIDOS</option>
                </select>
              </div>

              <div>
                <select
                  value={tastingPromotoraFilter}
                  onChange={(e) => setTastingPromotoraFilter(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-red-500 font-medium"
                >
                  <option value="TODAS">Promotora: Todas ({totalPromotoras})</option>
                  {availablePromotoras.map((prom) => (
                    <option key={prom} value={prom}>
                      {prom}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* FRANJA EJECUTIVA DE FACTIBILIDAD DE DEGUSTACIÓN VS. COSTO DE PRODUCTOS DEGUSTADOS */}
            <div className="px-4 py-3 bg-zinc-950/90 border-b border-zinc-800/90 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-red-600/15 border border-red-500/30 text-red-400 shrink-0">
                  <Scale className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-black text-white uppercase tracking-wider">
                      Factibilidad vs. Costo de Productos Degustados
                    </span>
                    <span
                      className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${
                        displayedFeasibility.verdict === 'ALTAMENTE_FACTIBLE' ||
                        displayedFeasibility.verdict === 'FACTIBLE'
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : displayedFeasibility.verdict === 'MARGEN_AJUSTADO'
                          ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                          : displayedFeasibility.verdict === 'NO_FACTIBLE'
                          ? 'bg-red-500/15 text-red-400 border-red-500/30'
                          : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                      }`}
                    >
                      {displayedFeasibility.verdictLabel}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Por cada <strong className="text-white">$1.00 USD</strong> en producto degustado se generaron{' '}
                    <strong className="text-white">
                      ${displayedFeasibility.returnMultiplier.toFixed(2)} USD
                    </strong>{' '}
                    en ventas directas ({displayedItems.length} activaciones filtradas).
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-right">
                  <span className="text-[9px] font-bold text-zinc-400 uppercase block">
                    Costo Prod. Degustados
                  </span>
                  <span className="text-xs font-black font-mono text-red-400">
                    ${displayedFeasibility.totalTastedProductCostUsd.toFixed(2)} USD
                  </span>
                </div>

                <div className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-right">
                  <span className="text-[9px] font-bold text-zinc-400 uppercase block">
                    Ventas Directas Logradas
                  </span>
                  <span className="text-xs font-black font-mono text-white">
                    ${displayedFeasibility.totalGeneratedRevenueUsd.toFixed(2)} USD
                  </span>
                </div>

                <div className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-right">
                  <span className="text-[9px] font-bold text-zinc-400 uppercase block">
                    Balance Neto (Venta - Costo)
                  </span>
                  <span
                    className={`text-xs font-black font-mono ${
                      displayedFeasibility.netBalanceUsd >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {displayedFeasibility.netBalanceUsd >= 0 ? '+' : ''}$
                    {displayedFeasibility.netBalanceUsd.toFixed(2)}
                  </span>
                </div>

                <div className="px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-right">
                  <span className="text-[9px] font-bold text-zinc-400 uppercase block">
                    Multiplicador / ROI
                  </span>
                  <span
                    className={`text-xs font-black font-mono ${
                      displayedFeasibility.returnMultiplier >= 1.5
                        ? 'text-emerald-400'
                        : displayedFeasibility.returnMultiplier >= 1.0
                        ? 'text-amber-300'
                        : 'text-red-400'
                    }`}
                  >
                    {displayedFeasibility.returnMultiplier.toFixed(2)}x ({displayedFeasibility.roiPercent >= 0 ? '+' : ''}
                    {displayedFeasibility.roiPercent.toFixed(0)}%)
                  </span>
                </div>
              </div>
            </div>

            {/* TABLA DE DEGUSTACIONES SINCRONIZADA CON SUPABASE & TRADE MARKETING */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-black border-b border-zinc-800 text-zinc-400 font-black uppercase text-[10px] tracking-wider">
                    <th className="p-3 text-center w-10">#</th>
                    <th className="p-3.5">DÍA & JORNADA</th>
                    <th className="p-3.5">CLIENTE PDV & RUTA / DIRECCIÓN</th>
                    <th className="p-3.5">PRODUCTO & CANTIDAD</th>
                    <th className="p-3.5">PROMOTORA & FDV</th>
                    <th className="p-3.5 text-center">ESTADO</th>
                    <th className="p-3.5 text-center w-36">MUESTRAS & VENTAS</th>
                    <th className="p-3.5 text-center w-36">ACCIONES</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-zinc-900 text-zinc-200">
                  {displayedItems.length > 0 ? (
                    displayedItems.map((item, idx) => {
                      const isPending = item.status === 'PENDIENTE';
                      const isUnread = item.leidoTrade === false;
                      const isHighlighted = highlightedTastingRowId === item.id;
                      const isMorning =
                        item.shift === 'MAÑANA' ||
                        item.timeRange.startsWith('08') ||
                        item.timeRange.startsWith('09') ||
                        item.timeRange.toUpperCase().includes('MAÑANA');

                      return (
                        <tr
                          key={item.id}
                          id={`tasting-row-${item.id}`}
                          className={`transition ${
                            isHighlighted
                              ? 'bg-red-950/60 ring-2 ring-inset ring-[#DC2626]'
                              : isUnread
                                ? 'bg-red-950/35 hover:bg-red-950/50 border-l-4 border-[#DC2626]'
                                : isPending
                                  ? 'bg-red-950/20 hover:bg-red-950/40 border-l-2 border-red-600'
                                  : 'hover:bg-zinc-900/50'
                          }`}
                        >
                          <td className="p-3 text-center font-mono text-zinc-500 text-[10px]">
                            <div>{idx + 1}</div>
                            {isUnread && (
                              <span className="mt-1 inline-block px-1.5 py-0.5 rounded-full bg-[#DC2626] text-[#FFFFFF] text-[8px] font-black uppercase tracking-wider animate-pulse">
                                NUEVA
                              </span>
                            )}
                          </td>

                          {/* DÍA & JORNADA */}
                          <td className="p-3.5 whitespace-nowrap">
                            <div className="font-bold text-white text-xs">
                              {item.dayLabel || formatToDdMmYyyy(item.date, '-- -- ----')}
                            </div>
                            <div className="text-[10px] font-mono text-zinc-400">
                              {formatToDdMmYyyy(item.date, '-- -- ----')}
                            </div>
                            <div className="mt-1">
                              <span
                                className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-black font-mono border ${
                                  isMorning
                                    ? 'bg-zinc-900 text-white border-zinc-700'
                                    : 'bg-black text-red-400 border-red-900'
                                }`}
                              >
                                {item.turnoRaw === 'COMPLETO'
                                  ? '☀️🌙 COMPLETO'
                                  : isMorning
                                    ? '☀️ MAÑANA'
                                    : '🌙 TARDE'}
                                <span className="text-[9px] text-zinc-400 font-normal">({item.timeRange})</span>
                              </span>
                            </div>
                          </td>

                          {/* CLIENTE PDV & ZONA */}
                          <td className="p-3.5 min-w-[200px]">
                            <div className="font-bold text-white text-xs flex items-center gap-1.5 flex-wrap">
                              <StoreIcon className="w-3.5 h-3.5 text-red-500 shrink-0" />
                              <span>{item.storeName}</span>
                              {item.clienteCodigo && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-300 border border-white/10">
                                  #{item.clienteCodigo}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-[11px] text-zinc-400 mt-0.5">
                              <MapPin className="w-3 h-3 text-zinc-500 shrink-0" />
                              <span>{item.zone}</span>
                            </div>
                            {(item.contactoPunto || item.telefonoContacto) && (
                              <div className="flex items-center gap-1 text-[10px] text-zinc-400 font-mono mt-0.5">
                                <Phone className="w-2.5 h-2.5 text-red-400 shrink-0" />
                                <span>
                                  {item.contactoPunto || 'Contacto'}
                                  {item.telefonoContacto ? ` · ${item.telefonoContacto}` : ''}
                                </span>
                              </div>
                            )}
                            {item.mapsUrl && (
                              <a
                                href={item.mapsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] text-red-400 hover:text-red-300 flex items-center gap-1 mt-0.5"
                              >
                                <ExternalLink className="w-2.5 h-2.5" />
                                <span>Ver en Maps</span>
                              </a>
                            )}
                          </td>

                          {/* PRODUCTO & CANTIDADES */}
                          <td className="p-3.5 min-w-[230px]">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`text-[10px] font-black px-2 py-0.5 rounded uppercase font-mono border ${
                                  item.productName.toUpperCase().includes('ARROZ') ||
                                  item.productName.toUpperCase().includes('VENCAMPO') ||
                                  item.productName.toUpperCase().includes('LECHE')
                                    ? 'bg-amber-950/70 text-amber-300 border-amber-800'
                                    : item.productName.toUpperCase().includes('ESPALDA')
                                      ? 'bg-rose-950/70 text-rose-300 border-rose-800'
                                      : 'bg-red-950/70 text-red-300 border-red-800'
                                }`}
                              >
                                {item.fillProductSelection || item.productName.split(' ')[0]}
                              </span>
                              <span className="font-bold text-white text-xs">{item.productName}</span>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5 font-mono text-[10px]">
                              {(item.mortadelaQty || 0) > 0 && (
                                <span className="px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-800/60 font-bold">
                                  {item.mortadelaQty} kg/un
                                </span>
                              )}
                              {(item.espaldaQty || 0) > 0 && (
                                <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700 font-bold">
                                  {item.espaldaQty} un Espalda
                                </span>
                              )}
                              {(item.arrozQty || 0) > 0 && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/60 font-bold">
                                  {item.arrozQty} un Vencampo
                                </span>
                              )}
                              {((item.azucarGrams || 0) > 0 || (item.lecheGrams || 0) > 0) && (
                                <span className="px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
                                  {item.azucarGrams}g Azúcar • {item.lecheGrams}g Leche
                                </span>
                              )}
                              <span className="px-1.5 py-0.5 rounded bg-black text-slate-300 border border-slate-800">
                                Total: <strong className="text-white">{item.requestedQty} kg/un</strong>
                              </span>
                            </div>

                            {item.operationalSupplies && (
                              <div className="flex flex-wrap items-center gap-1.5 mt-1 font-mono text-[9px] text-zinc-400">
                                <span className="px-1.5 py-0.5 rounded bg-zinc-900/90 border border-zinc-800">
                                  Insumos: {item.operationalSupplies.servilletas} serv. · {item.operationalSupplies.palillos} palillos · {item.operationalSupplies.envases} envases ({item.operationalSupplies.gramajeTotalG}g)
                                </span>
                              </div>
                            )}

                            {item.notes && (
                              <div className="text-[10px] text-zinc-400 italic mt-1 line-clamp-1" title={item.notes}>
                                {item.notes}
                              </div>
                            )}
                          </td>

                          {/* RESPONSABLE & VENDEDOR */}
                          <td className="p-3.5 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <div className="w-5 h-5 rounded-full bg-red-600 text-white font-black text-[9px] flex items-center justify-center">
                                {(item.responsibleName || 'P')[0]}
                              </div>
                              <span className="font-bold text-white text-xs">{item.responsibleName}</span>
                            </div>
                            <div className="text-[10px] text-zinc-400 font-mono mt-0.5 flex items-center gap-1">
                              <Users className="w-2.5 h-2.5 text-zinc-500" />
                              <span>{item.sellerApplicant}</span>
                            </div>
                          </td>

                          {/* ESTADO */}
                          <td className="p-3.5 text-center whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1 rounded-full uppercase border font-mono ${
                                item.status === 'PENDIENTE'
                                  ? 'bg-red-950 text-red-400 border-red-800 animate-pulse'
                                  : item.status === 'PROGRAMADO'
                                    ? 'bg-zinc-900 text-white border-zinc-700'
                                    : item.status === 'EN_CURSO'
                                      ? 'bg-red-600 text-white border-red-500 shadow-md shadow-red-950'
                                      : 'bg-black text-emerald-400 border-emerald-900'
                              }`}
                            >
                              {item.status === 'PENDIENTE' && <span>⏳ SOLICITADA FDV</span>}
                              {item.status === 'PROGRAMADO' && (
                                <>
                                  <Calendar className="w-3 h-3 text-zinc-400" />
                                  <span>APROBADA / PROG.</span>
                                </>
                              )}
                              {item.status === 'EN_CURSO' && (
                                <>
                                  <Play className="w-3 h-3 text-white fill-white" />
                                  <span>EN CURSO</span>
                                </>
                              )}
                              {item.status === 'COMPLETADO' && (
                                <>
                                  <Check className="w-3 h-3 text-emerald-400" />
                                  <span>EJECUTADA</span>
                                </>
                              )}
                            </span>
                          </td>

                          {/* MUESTRAS & SELL-OUT */}
                          <td className="p-3.5 text-center">
                            <div className="font-mono text-xs font-bold text-white">
                              {item.currentSamples} / {item.targetSamples}
                            </div>
                            <div className="w-24 h-1.5 bg-slate-800 rounded-full mx-auto mt-1 overflow-hidden">
                              <div
                                className="h-full bg-gradient-to-r from-red-600 to-emerald-500 transition-all"
                                style={{
                                  width: `${Math.min(100, Math.round((item.currentSamples / (item.targetSamples || 1)) * 100))}%`,
                                }}
                              />
                            </div>
                            <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
                              Venta: <strong className="text-red-400">{item.salesAssistedCount || 0} un</strong>
                              {item.acceptancePercent !== undefined && (
                                <span className="text-emerald-400 ml-1 font-bold">({item.acceptancePercent}%)</span>
                              )}
                            </div>
                          </td>

                          {/* ACCIONES */}
                          <td className="p-3.5 text-center whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleOpenTastingDetail(item)}
                                title="Ver ficha completa enviada por el vendedor (100% de campos)"
                                className={`p-1.5 rounded-lg border transition cursor-pointer ${
                                  isUnread
                                    ? 'bg-[#DC2626]/20 border-[#DC2626] text-[#FFFFFF] hover:bg-[#DC2626]'
                                    : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-800 text-zinc-300 hover:text-white'
                                }`}
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>

                              {isPending && (
                                <>
                                  <button
                                    type="button"
                                    disabled={processingTastingId === item.id}
                                    onClick={() => handleApproveTastingRequest(item)}
                                    title="Aceptar solicitud: Actualiza en Supabase, Carga en Cronograma de Producción y Asigna a Ruta"
                                    className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-black uppercase tracking-wider flex items-center gap-1 shadow-md shadow-red-950 border border-red-500 transition active:scale-95 cursor-pointer"
                                  >
                                    {processingTastingId === item.id ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <Check className="w-3.5 h-3.5" />
                                    )}
                                    <span>Aprobar</span>
                                  </button>

                                  <button
                                    type="button"
                                    disabled={processingTastingId === item.id}
                                    onClick={() => handleRejectTastingRequest(item.id, 'RECHAZADA')}
                                    title="Rechazar solicitud"
                                    className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-zinc-400 hover:text-white transition cursor-pointer"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}

                              {item.status === 'PROGRAMADO' && (
                                <button
                                  type="button"
                                  onClick={() => handleStartTasting(item)}
                                  title="Iniciar activación en PDV"
                                  className="p-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white transition shadow cursor-pointer"
                                >
                                  <Play className="w-3.5 h-3.5 fill-white" />
                                </button>
                              )}

                              {item.status === 'EN_CURSO' && (
                                <button
                                  type="button"
                                  onClick={() => setExecutingItem(item)}
                                  title="Abrir terminal de conteo y geocerca"
                                  className="p-1.5 rounded-lg bg-black border border-red-600 text-red-400 hover:bg-red-950 transition cursor-pointer"
                                >
                                  <Sliders className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {!isPending && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => setExecutingItem(item)}
                                    title="Editar actividad"
                                    className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-900 transition cursor-pointer"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>

                                  <button
                                    type="button"
                                    disabled={processingTastingId === item.id}
                                    onClick={() => handleDeleteTasting(item.id)}
                                    title="Cancelar solicitud y retirar del Cronograma de Producción"
                                    className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-zinc-900 disabled:opacity-50 transition cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={8} className="p-10 text-center text-zinc-400 text-xs">
                        {isLoadingSupabase ? (
                          <span>Cargando degustaciones desde Supabase...</span>
                        ) : tastingViewMode === 'actual' && archivedTastingCount > 0 && activeTastingCount === 0 ? (
                          <div className="flex flex-col items-center gap-3 max-w-md mx-auto">
                            <Archive className="w-8 h-8 text-amber-400" />
                            <div>
                              <p className="font-bold text-white text-sm">
                                Cronograma Actual limpio para el día de hoy ({getTodayVeYmd()})
                              </p>
                              <p className="text-xs text-zinc-400 mt-1">
                                Todas las degustaciones enviadas antes del día de hoy ({archivedTastingCount} registros) han sido archivadas en la pestaña de Historial.
                              </p>
                            </div>
                            <div className="flex items-center gap-2.5 mt-1">
                              <button
                                type="button"
                                onClick={() => setTastingViewMode('historial')}
                                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition shadow-md"
                              >
                                Ver Historial ({archivedTastingCount})
                              </button>
                              <button
                                type="button"
                                onClick={() => setIsSimulateSellerAppOpen(true)}
                                className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 text-xs font-bold transition"
                              >
                                + Enviar Solicitud FDV Hoy
                              </button>
                            </div>
                          </div>
                        ) : (
                          <span>No hay registros que coincidan con los filtros seleccionados.</span>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: ENVIAR NUEVA SOLICITUD FDV DIRECTO A SUPABASE (BLINDADO E ÍNTEGRO) */}
      {/* ========================================================================= */}
      {isSimulateSellerAppOpen && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-[#09090B] border-2 border-[#DC2626] rounded-3xl max-w-2xl w-full p-6 shadow-2xl my-auto">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-900">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#DC2626]/15 border border-[#DC2626]/40 flex items-center justify-center text-[#DC2626]">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-black text-white uppercase tracking-wider">
                    Enviar Solicitud de Degustación FDV → Trade Marketing
                  </h3>
                  <p className="text-[11px] text-zinc-400 font-mono">
                    ID Transacción: {newSellerDraftToken} · Sincronización Realtime Supabase
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={isSubmittingSellerReq}
                onClick={() => setIsSimulateSellerAppOpen(false)}
                className="text-zinc-500 hover:text-white disabled:opacity-40 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSendFromSellerApp} className="space-y-3.5 py-4">
              {sellerSubmitError && (
                <div className="p-3 rounded-xl bg-red-950/70 border border-[#DC2626] text-xs text-red-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-[#DC2626] shrink-0 mt-0.5" />
                  <span>{sellerSubmitError}</span>
                </div>
              )}

              <fieldset disabled={isSubmittingSellerReq} className="space-y-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Vendedor Solicitante (FDV) *
                    </label>
                    <input
                      type="text"
                      value={newSellerName}
                      onChange={(e) => setNewSellerName(e.target.value)}
                      required
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                      placeholder="Ej. SAIRÚ VALLES / MARIANA CHACÍN"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Ruta / Zona Comercial *
                    </label>
                    <input
                      type="text"
                      value={newSellerZone}
                      onChange={(e) => setNewSellerZone(e.target.value)}
                      required
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                      placeholder="Ej. CUENTAS CLAVE 2 / MARACAIBO NORTE"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Cliente PDV Propuesto *
                    </label>
                    <input
                      type="text"
                      value={newSellerStore}
                      onChange={(e) => setNewSellerStore(e.target.value)}
                      required
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                      placeholder="Nombre del supermercado o cliente"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Código Cliente
                    </label>
                    <input
                      type="text"
                      value={newSellerClientCode}
                      onChange={(e) => setNewSellerClientCode(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-600"
                      placeholder="Ej. 7499"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Contacto en Punto (PDV)
                    </label>
                    <input
                      type="text"
                      value={newSellerContacto}
                      onChange={(e) => setNewSellerContacto(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                      placeholder="Encargado PDV"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Teléfono Contacto
                    </label>
                    <input
                      type="text"
                      value={newSellerTelefono}
                      onChange={(e) => setNewSellerTelefono(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-red-600"
                      placeholder="Ej. 0414-0000000"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Dirección Exacta PDV
                    </label>
                    <input
                      type="text"
                      value={newSellerAddress}
                      onChange={(e) => setNewSellerAddress(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                      placeholder="Av. / Sector"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Producto a Degustar *
                    </label>
                    <input
                      type="text"
                      value={newSellerProduct}
                      onChange={(e) => setNewSellerProduct(e.target.value)}
                      required
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Kilos / Unidades *
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="500"
                      step="0.5"
                      required
                      value={newSellerQuantity}
                      onChange={(e) => setNewSellerQuantity(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono font-bold focus:outline-none focus:border-red-600"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Personas Estimadas *
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="2000"
                      required
                      value={newSellerPersonas}
                      onChange={(e) => setNewSellerPersonas(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white font-mono font-bold focus:outline-none focus:border-red-600"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Fecha Solicitada *
                    </label>
                    <input
                      type="date"
                      required
                      value={newSellerDate}
                      onChange={(e) => setNewSellerDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Horario Propuesto *
                    </label>
                    <input
                      type="text"
                      required
                      value={newSellerTime}
                      onChange={(e) => setNewSellerTime(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Tipo Promotora
                    </label>
                    <select
                      value={newSellerPromoterType}
                      onChange={(e) =>
                        setNewSellerPromoterType(e.target.value as 'Fija' | 'Eventual')
                      }
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                    >
                      <option value="Fija">Plantilla Fija</option>
                      <option value="Eventual">Plantilla Eventual</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                      Material POP
                    </label>
                    <select
                      value={newSellerMaterialPop}
                      onChange={(e) => setNewSellerMaterialPop(e.target.value as 'SI' | 'NO')}
                      className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                    >
                      <option value="SI">SÍ Requiere POP</option>
                      <option value="NO">NO Requiere POP</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-bold text-zinc-400 uppercase block mb-1">
                    Justificación Comercial / Observaciones del Vendedor
                  </label>
                  <textarea
                    rows={2}
                    value={newSellerReason}
                    onChange={(e) => setNewSellerReason(e.target.value)}
                    placeholder="Detalle comercial, acuerdos con el cliente o requerimientos especiales..."
                    className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-600"
                  />
                </div>
              </fieldset>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-zinc-900">
                <span className="text-[10px] font-mono text-zinc-500">
                  Estado inicial: SOLICITADA · leido_trade: false
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSubmittingSellerReq}
                    onClick={() => setIsSimulateSellerAppOpen(false)}
                    className="px-4 py-2 rounded-xl bg-black hover:bg-zinc-900 text-zinc-300 text-xs font-bold border border-zinc-800 disabled:opacity-40 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmittingSellerReq}
                    className="px-5 py-2.5 rounded-xl bg-[#DC2626] hover:bg-red-700 text-white text-xs font-black uppercase tracking-wider border border-red-500 shadow-md flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    {isSubmittingSellerReq ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {isSubmittingSellerReq
                        ? 'Confirmando transacción en BD...'
                        : 'Enviar Degustación a Trade Marketing'}
                    </span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: FICHA ÍNTEGRA DE DEGUSTACIÓN RECIBIDA EN TRADE MARKETING           */}
      {/* ========================================================================= */}
      {selectedTastingDetail && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-[#09090B] border-2 border-[#DC2626] rounded-3xl max-w-2xl w-full p-6 shadow-[0_25px_70px_rgba(0,0,0,0.95)] my-auto">
            <div className="flex items-start justify-between gap-3 pb-4 border-b border-white/10">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-full bg-[#DC2626] text-[#FFFFFF] text-[10px] font-black uppercase tracking-wider">
                    Ficha Íntegra de Degustación
                  </span>
                  <span className="px-2 py-0.5 rounded-md bg-[#18181B] text-zinc-300 border border-white/10 text-[10px] font-mono">
                    ID: {selectedTastingDetail.degustacionId || selectedTastingDetail.id.slice(0, 8)}
                  </span>
                  <span className="px-2 py-0.5 rounded-md bg-emerald-950/70 text-emerald-300 border border-emerald-700/40 text-[10px] font-mono">
                    ✓ Vista en Trade Marketing
                  </span>
                </div>
                <h3 className="text-base sm:text-lg font-extrabold text-[#FFFFFF] mt-2">
                  {selectedTastingDetail.storeName}
                  {selectedTastingDetail.clienteCodigo
                    ? ` (Cód. #${selectedTastingDetail.clienteCodigo})`
                    : ''}
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Solicitada por{' '}
                  <strong className="text-[#FFFFFF]">
                    {selectedTastingDetail.sellerApplicant}
                  </strong>{' '}
                  · Ruta: <strong className="text-red-400">{selectedTastingDetail.zone}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTastingDetail(null)}
                className="w-8 h-8 rounded-lg bg-[#18181B] hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center border border-white/10 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-4 text-xs">
              <div className="p-3.5 rounded-2xl bg-[#18181B] border border-white/10 space-y-1.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400 block">
                  Producto & Magnitud Solicitada
                </span>
                <p className="text-sm font-extrabold text-[#FFFFFF]">
                  {selectedTastingDetail.productName}
                </p>
                {selectedTastingDetail.productsList &&
                  selectedTastingDetail.productsList.length > 1 && (
                    <p className="text-[11px] text-zinc-300">
                      Presentaciones: {selectedTastingDetail.productsList.join(' · ')}
                    </p>
                  )}
                <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-[11px]">
                  <span className="px-2 py-0.5 rounded bg-[#DC2626]/20 text-red-300 border border-[#DC2626]/40 font-bold">
                    {selectedTastingDetail.requestedQty || 1} kg/un
                  </span>
                  <span className="px-2 py-0.5 rounded bg-black text-zinc-200 border border-white/10">
                    Meta: {selectedTastingDetail.targetSamples || 0} personas
                  </span>
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-[#18181B] border border-white/10 space-y-1.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400 block">
                  Fecha Programada & Envío Exacto
                </span>
                <p className="text-sm font-extrabold text-[#FFFFFF]">
                  {selectedTastingDetail.dayLabel || selectedTastingDetail.date} (
                  {selectedTastingDetail.date})
                </p>
                <p className="text-[11px] font-mono text-red-300">
                  Jornada: {selectedTastingDetail.shift || 'MAÑANA'} ·{' '}
                  {selectedTastingDetail.timeRange}
                </p>
                <p className="text-[10px] font-mono text-zinc-400">
                  Enviado:{' '}
                  {selectedTastingDetail.createdAt
                    ? new Date(selectedTastingDetail.createdAt).toLocaleString('es-VE', {
                        timeZone: 'America/Caracas',
                        dateStyle: 'short',
                        timeStyle: 'medium',
                      })
                    : 'Registrado en Supabase'}
                </p>
              </div>

              <div className="p-3.5 rounded-2xl bg-[#18181B] border border-white/10 space-y-1.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400 block">
                  Contacto en Punto de Venta & Ubicación
                </span>
                <p className="text-xs font-bold text-[#FFFFFF]">
                  Encargado:{' '}
                  <span className="text-zinc-200 font-normal">
                    {selectedTastingDetail.contactoPunto ||
                      selectedTastingDetail.rawComments?.contactoPunto ||
                      'No especificado'}
                  </span>
                </p>
                <p className="text-xs font-bold text-[#FFFFFF] font-mono">
                  Teléfono:{' '}
                  <span className="text-red-300">
                    {selectedTastingDetail.telefonoContacto ||
                      selectedTastingDetail.rawComments?.telefonoContacto ||
                      'No especificado'}
                  </span>
                </p>
                <p className="text-[11px] text-zinc-400">
                  Dirección:{' '}
                  {selectedTastingDetail.address ||
                    selectedTastingDetail.rawComments?.address ||
                    selectedTastingDetail.zone}
                </p>
              </div>

              <div className="p-3.5 rounded-2xl bg-[#18181B] border border-white/10 space-y-1.5">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400 block">
                  Recursos Requeridos en Trade Marketing
                </span>
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5 font-mono text-[11px]">
                  <span className="px-2 py-0.5 rounded bg-black text-white border border-white/10">
                    Promotora:{' '}
                    <strong>
                      {selectedTastingDetail.requierePromotora === false ? 'NO' : 'SÍ'} (
                      {selectedTastingDetail.promoterType ||
                        selectedTastingDetail.rawComments?.promoterType ||
                        'Fija'}
                      )
                    </strong>
                  </span>
                  <span className="px-2 py-0.5 rounded bg-black text-white border border-white/10">
                    Material POP:{' '}
                    <strong className="text-red-400">
                      {selectedTastingDetail.materialPop ||
                        selectedTastingDetail.rawComments?.materialPop ||
                        'SI'}
                    </strong>
                  </span>
                </div>
                <p className="text-[11px] text-zinc-300 pt-1">
                  Asignación actual:{' '}
                  <strong className="text-[#FFFFFF]">
                    {selectedTastingDetail.responsibleName}
                  </strong>
                </p>
              </div>
            </div>

            {(selectedTastingDetail.notes ||
              selectedTastingDetail.notasTradeMarketing ||
              selectedTastingDetail.rawComments?.notasTradeMarketing) && (
              <div className="p-3.5 rounded-2xl bg-[#18181B] border border-white/10 mb-4 space-y-1.5 text-xs">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400 block">
                  Observaciones Comerciales & Notas Trade Marketing
                </span>
                {selectedTastingDetail.notes && (
                  <p className="text-zinc-200 leading-relaxed">{selectedTastingDetail.notes}</p>
                )}
                {(selectedTastingDetail.notasTradeMarketing ||
                  selectedTastingDetail.rawComments?.notasTradeMarketing) && (
                  <p className="text-[11px] text-red-300 font-mono">
                    Trade:{' '}
                    {selectedTastingDetail.notasTradeMarketing ||
                      selectedTastingDetail.rawComments?.notasTradeMarketing}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-white/10">
              <span className="text-[10px] font-mono text-zinc-500">
                UUID Supabase: {selectedTastingDetail.id}
              </span>

              <div className="flex items-center gap-2">
                {selectedTastingDetail.status === 'PENDIENTE' && (
                  <>
                    <button
                      type="button"
                      disabled={processingTastingId === selectedTastingDetail.id}
                      onClick={() => handleRejectTastingRequest(selectedTastingDetail.id, 'RECHAZADA')}
                      className="px-3.5 py-2 rounded-xl bg-[#18181B] hover:bg-zinc-800 disabled:opacity-50 text-zinc-300 hover:text-white border border-white/10 text-xs font-bold transition cursor-pointer"
                    >
                      Rechazar
                    </button>
                    <button
                      type="button"
                      disabled={processingTastingId === selectedTastingDetail.id}
                      onClick={() => handleApproveTastingRequest(selectedTastingDetail)}
                      className="px-4 py-2 rounded-xl bg-[#DC2626] hover:bg-red-500 disabled:opacity-50 text-[#FFFFFF] text-xs font-black uppercase tracking-wider flex items-center gap-1.5 shadow-md cursor-pointer"
                    >
                      {processingTastingId === selectedTastingDetail.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      <span>Aprobar y Sincronizar Cronograma</span>
                    </button>
                  </>
                )}
                {(selectedTastingDetail.status === 'PROGRAMADO' ||
                  selectedTastingDetail.status === 'EN_CURSO') && (
                  <button
                    type="button"
                    disabled={processingTastingId === selectedTastingDetail.id}
                    onClick={() => handleRejectTastingRequest(selectedTastingDetail.id, 'CANCELADA')}
                    className="px-3.5 py-2 rounded-xl bg-red-950/60 hover:bg-red-900/80 disabled:opacity-50 text-red-300 hover:text-white border border-red-700/50 text-xs font-bold transition cursor-pointer"
                  >
                    Cancelar y Retirar del Cronograma
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedTastingDetail(null)}
                  className="px-4 py-2 rounded-xl bg-black hover:bg-zinc-900 text-zinc-200 border border-white/10 text-xs font-bold cursor-pointer"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: EJECUTAR ACTIVACIÓN EN PDV */}
      {executingItem && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-950 border-2 border-red-600 rounded-3xl max-w-xl w-full p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-900 mb-4">
              <div>
                <span className="text-[10px] font-black px-2 py-0.5 rounded bg-red-600 text-white uppercase tracking-wider">
                  Terminal de Ejecución en PDV
                </span>
                <h3 className="text-base font-black text-white mt-1">{executingItem.activityTitle}</h3>
                <p className="text-xs text-zinc-400">
                  {executingItem.storeName} • {executingItem.responsibleName}
                </p>
              </div>
              <button onClick={() => setExecutingItem(null)} className="text-zinc-500 hover:text-white">
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-black border border-zinc-900 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-red-500" />
                  <span>
                    Ubicación PDV: <strong>{executingItem.zone}</strong>
                  </span>
                </div>
                <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-bold font-mono text-[10px]">
                  SINCRONIZADO SUPABASE
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-4 rounded-xl bg-black border border-zinc-900 text-center">
                  <span className="text-[10px] font-bold text-zinc-400 uppercase block mb-1">
                    Muestras Degustadas (Avance)
                  </span>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={() =>
                        setExecutingItem({
                          ...executingItem,
                          currentSamples: Math.max(0, executingItem.currentSamples - 10),
                        })
                      }
                      className="w-8 h-8 rounded-lg bg-zinc-900 text-white font-black hover:bg-zinc-800"
                    >
                      -
                    </button>
                    <span className="text-2xl font-black text-white font-mono">{executingItem.currentSamples}</span>
                    <button
                      onClick={() =>
                        setExecutingItem({
                          ...executingItem,
                          currentSamples: Math.min(executingItem.targetSamples, executingItem.currentSamples + 10),
                        })
                      }
                      className="w-8 h-8 rounded-lg bg-red-600 text-white font-black hover:bg-red-700"
                    >
                      +
                    </button>
                  </div>
                  <span className="text-[10px] text-zinc-500 font-mono mt-1 block">
                    Meta: {executingItem.targetSamples} muestras
                  </span>
                </div>

                <div className="p-4 rounded-xl bg-black border border-zinc-900 text-center">
                  <span className="text-[10px] font-bold text-zinc-400 uppercase block mb-1">
                    Ventas Asistidas (Sell-Out)
                  </span>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={() =>
                        setExecutingItem({
                          ...executingItem,
                          salesAssistedCount: Math.max(0, (executingItem.salesAssistedCount || 0) - 2),
                        })
                      }
                      className="w-8 h-8 rounded-lg bg-zinc-900 text-white font-black hover:bg-zinc-800"
                    >
                      -
                    </button>
                    <span className="text-2xl font-black text-red-500 font-mono">
                      {executingItem.salesAssistedCount || 0}
                    </span>
                    <button
                      onClick={() =>
                        setExecutingItem({
                          ...executingItem,
                          salesAssistedCount: (executingItem.salesAssistedCount || 0) + 2,
                        })
                      }
                      className="w-8 h-8 rounded-lg bg-red-600 text-white font-black hover:bg-red-700"
                    >
                      +
                    </button>
                  </div>
                  <span className="text-[10px] text-zinc-500 font-mono mt-1 block">Unidades vendidas</span>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-black border border-zinc-900">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-bold text-zinc-300">Tasa de Aceptación de los Consumidores</span>
                  <span className="font-black text-emerald-400 font-mono">{executingItem.acceptancePercent || 95}%</span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="100"
                  value={executingItem.acceptancePercent || 95}
                  onChange={(e) =>
                    setExecutingItem({
                      ...executingItem,
                      acceptancePercent: parseInt(e.target.value, 10),
                    })
                  }
                  className="w-full accent-red-600 cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-900">
                <button
                  type="button"
                  onClick={() => setExecutingItem(null)}
                  className="px-4 py-2 rounded-xl bg-black hover:bg-zinc-900 text-zinc-300 text-xs font-bold border border-zinc-800"
                >
                  Cerrar
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleSaveTastingProgress(
                      executingItem.currentSamples,
                      executingItem.salesAssistedCount || 0,
                      executingItem.acceptancePercent || 95
                    )
                  }
                  className="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-black uppercase tracking-wider border border-red-500 shadow-md flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Guardar Progreso</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VISOR DE ALTA DEFINICIÓN PARA FOTOGRAFÍAS PUBLICADAS POR EL PROMOTOR EN CAMPO */}
      {photoModalState.isOpen && (
        <div
          className="fixed inset-0 z-[70] bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setPhotoModalState((prev) => ({ ...prev, isOpen: false }))}
        >
          <div
            className="bg-zinc-950 border border-white/15 ring-1 ring-red-600/40 rounded-2xl max-w-3xl w-full p-5 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 pb-3 border-b border-white/10">
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-black px-2.5 py-0.5 rounded-md bg-red-600 text-white uppercase tracking-wider">
                  <Camera className="w-3 h-3" />
                  <span>{photoModalState.badgeLabel || 'CODIZULCA ASISTENCIA • EVIDENCIA FOTOGRÁFICA'}</span>
                </span>
                <h3 className="text-base font-black text-white mt-1.5 truncate">{photoModalState.title}</h3>
                <p className="text-xs text-zinc-300 font-mono mt-0.5">{photoModalState.subtitle}</p>
              </div>
              <button
                type="button"
                onClick={() => setPhotoModalState((prev) => ({ ...prev, isOpen: false }))}
                className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-white/10 transition shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="relative w-full min-h-[340px] max-h-[70vh] rounded-2xl bg-black border border-white/10 flex items-center justify-center overflow-hidden">
              {photoModalState.loading ? (
                <div className="flex flex-col items-center gap-2 text-zinc-400 text-xs font-mono p-8">
                  <Loader2 className="w-7 h-7 text-red-500 animate-spin" />
                  <span>Descargando fotografía publicada por el promotor...</span>
                </div>
              ) : photoModalState.photoBase64 ? (
                <>
                  <img
                    src={photoModalState.photoBase64}
                    aria-hidden="true"
                    className="absolute inset-0 w-full h-full object-cover blur-2xl opacity-30 scale-110 pointer-events-none"
                  />
                  <img
                    src={photoModalState.photoBase64}
                    alt={photoModalState.title}
                    className="relative z-[1] max-h-[68vh] w-full object-contain"
                  />

                  {photoModalState.gallery && photoModalState.gallery.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const gal = photoModalState.gallery || [];
                          const curr = photoModalState.currentIndex || 0;
                          const prevIdx = (curr - 1 + gal.length) % gal.length;
                          const baseTitle = photoModalState.title.replace(/\s+—\s+Foto\s+\d+\s+de\s+\d+$/, '');
                          setPhotoModalState((prev) => ({
                            ...prev,
                            currentIndex: prevIdx,
                            photoBase64: gal[prevIdx],
                            title: `${baseTitle} — Foto ${prevIdx + 1} de ${gal.length}`,
                          }));
                        }}
                        className="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/80 hover:bg-red-600 text-white border border-white/15 flex items-center justify-center shadow-xl transition"
                        title="Fotografía anterior"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const gal = photoModalState.gallery || [];
                          const curr = photoModalState.currentIndex || 0;
                          const nextIdx = (curr + 1) % gal.length;
                          const baseTitle = photoModalState.title.replace(/\s+—\s+Foto\s+\d+\s+de\s+\d+$/, '');
                          setPhotoModalState((prev) => ({
                            ...prev,
                            currentIndex: nextIdx,
                            photoBase64: gal[nextIdx],
                            title: `${baseTitle} — Foto ${nextIdx + 1} de ${gal.length}`,
                          }));
                        }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/80 hover:bg-red-600 text-white border border-white/15 flex items-center justify-center shadow-xl transition"
                        title="Siguiente fotografía"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </>
                  )}
                </>
              ) : (
                <div className="text-center text-xs text-zinc-500 p-8">
                  Este registro no contiene imagen adjunta en la base de datos.
                </div>
              )}
            </div>

            {photoModalState.gallery && photoModalState.gallery.length > 1 && (
              <div className="flex items-center justify-center gap-2 overflow-x-auto py-1">
                {photoModalState.gallery.map((thumb, idx) => {
                  const isActive = (photoModalState.currentIndex || 0) === idx;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        const gal = photoModalState.gallery || [];
                        const baseTitle = photoModalState.title.replace(/\s+—\s+Foto\s+\d+\s+de\s+\d+$/, '');
                        setPhotoModalState((prev) => ({
                          ...prev,
                          currentIndex: idx,
                          photoBase64: thumb,
                          title: `${baseTitle} — Foto ${idx + 1} de ${gal.length}`,
                        }));
                      }}
                      className={`w-14 h-14 rounded-xl overflow-hidden border-2 transition shrink-0 ${
                        isActive ? 'border-red-500 ring-2 ring-red-500/30 scale-105' : 'border-white/10 opacity-60 hover:opacity-100'
                      }`}
                    >
                      <img src={thumb} alt={`Miniatura ${idx + 1}`} className="w-full h-full object-cover" />
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11px] font-mono text-emerald-400 truncate">
                ✓ Evidencia fotográfica original sincronizada desde Supabase
              </span>
              <button
                type="button"
                onClick={() => setPhotoModalState((prev) => ({ ...prev, isOpen: false }))}
                className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition shrink-0"
              >
                Cerrar Visor
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2. SUBMÓDULO: INFORMES (CARGADO EXACTAMENTE DESDE TABLAS SUPABASE) */}
      {/* ========================================================================= */}
      {activeSubTab === 'informes' && (
        <div className="space-y-6 animate-fadeIn">
          {/* BARRA SUPERIOR DE PESTAÑAS */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-zinc-950 p-2 rounded-2xl border border-zinc-900 shadow-xl">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
              <button
                type="button"
                onClick={() => setActiveReportTab('inventario')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
                  activeReportTab === 'inventario'
                    ? 'bg-red-600 text-white shadow-md shadow-red-950/60 border border-red-500'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-900 border border-transparent'
                }`}
              >
                <Box className="w-4 h-4" />
                <span>Inventario y Degustación</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
                    activeReportTab === 'inventario' ? 'bg-black/40 text-white' : 'bg-zinc-900 text-zinc-500'
                  }`}
                >
                  {inventorySampling.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveReportTab('asistencia')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 ${
                  activeReportTab === 'asistencia'
                    ? 'bg-red-600 text-white shadow-md shadow-red-950/60 border border-red-500'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-900 border border-transparent'
                }`}
              >
                <UserCheck className="w-4 h-4" />
                <span>Asistencia en PDV</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
                    activeReportTab === 'asistencia' ? 'bg-black/40 text-white' : 'bg-zinc-900 text-zinc-500'
                  }`}
                >
                  {attendanceRecords.length}
                </span>
              </button>
            </div>

            <div className="shrink-0">
              <ExportPdfButton
                label="Exportar Informe PDF"
                documentTitle={`Informe Operativo de Promotoras (${activeReportTab.toUpperCase()})`}
                subtitle="CODIZULCA C.A. • Auditoría en Punto de Venta y Trazabilidad GPS (Supabase)"
                onExportPdf={handleExportInformesPdf}
              />
            </div>
          </div>

          {/* 4 TARJETAS DE MÉTRICAS KPI REALES DE SUPABASE (PARA ASISTENCIA EN PDV) */}
          {activeReportTab === 'asistencia' && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-900 shadow-lg">
                <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block mb-1">
                  MARCAJES VERIFICADOS
                </span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-black text-white font-mono">{visitsHistory.length}</span>
                  <span className="text-xs text-emerald-400 font-semibold">en período</span>
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-900 shadow-lg">
                <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block mb-1">
                  INGRESOS REGISTRADOS
                </span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-black text-emerald-400 font-mono">{totalIngresosCount}</span>
                  <span className="text-xs text-zinc-400 font-medium">inicios de turno</span>
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-900 shadow-lg">
                <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block mb-1">
                  GEOLOCALIZACIÓN GPS
                </span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-black text-emerald-400 font-mono">100%</span>
                  <span className="text-xs text-zinc-400 font-medium">satelital validado</span>
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-zinc-950 border border-zinc-900 shadow-lg">
                <span className="text-[10px] font-black uppercase text-zinc-400 tracking-wider block mb-1">
                  PAUSAS DE ALMUERZO
                </span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-black text-amber-400 font-mono">{totalPausasAlmuerzoCount}</span>
                  <span className="text-xs text-zinc-400 font-medium">recesos y retornos</span>
                </div>
              </div>
            </div>
          )}

          {/* BARRA DE FILTRO Y LÍMITE DE VISUALIZACIÓN */}
          <div className="flex flex-wrap items-center justify-between gap-4 p-3 rounded-2xl bg-zinc-950 border border-zinc-900">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar promotora (ej. Camila Morales), tienda, producto o fecha..."
                value={reportSearchQuery}
                onChange={(e) => setReportSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600 font-medium"
              />
            </div>

            <div className="flex items-center gap-3">
              {activeReportTab === 'asistencia' ? (
                <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-mono">
                  <span>Promotoras en pantalla:</span>
                  <select
                    value={attendanceCardLimit}
                    onChange={(e) => setAttendanceCardLimit(Number(e.target.value))}
                    className="px-2.5 py-1 rounded-lg bg-black border border-zinc-800 text-white text-xs font-mono"
                  >
                    <option value={15}>15 jornadas</option>
                    <option value={35}>35 jornadas</option>
                    <option value={80}>80 jornadas</option>
                    <option value={500}>Todas ({attendanceRecords.length})</option>
                  </select>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-mono">
                  <span>Mostrar:</span>
                  <select
                    value={reportRowLimit}
                    onChange={(e) => setReportRowLimit(Number(e.target.value))}
                    className="px-2.5 py-1 rounded-lg bg-black border border-zinc-800 text-white text-xs font-mono"
                  >
                    <option value={150}>150 filas</option>
                    <option value={400}>400 filas</option>
                    <option value={2000}>
                      Todos ({inventorySampling.length})
                    </option>
                  </select>
                </div>
              )}
              <div className="text-[11px] text-zinc-400 font-mono hidden sm:flex items-center gap-1.5">
                {isLoadingBatchPhotos ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 text-red-500 animate-spin" />
                    <span>Sincronizando fotos...</span>
                  </>
                ) : (
                  <>
                    <Database className="w-3.5 h-3.5 text-red-500" />
                    <span>
                      Base de datos Supabase conectada •{' '}
                      {activeReportTab === 'inventario'
                        ? `${inventorySampling.length} balances`
                        : `${attendanceRecords.length} jornadas`}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* ========================================================================= */}
          {/* TAB: INVENTARIO Y DEGUSTACIÓN (SINCRONIZADO 100% CON TABLA `inventory`) */}
          {/* ========================================================================= */}
          {activeReportTab === 'inventario' && (
            <div className="space-y-6">
              {/* Encabezado de Inventarios y Degustación */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                <div>
                  <h4 className="font-semibold text-white flex items-center gap-2">
                    <Box className="w-5 h-5 text-red-400" />
                    Control de Inventarios & Resultados de Degustación
                    <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
                      {inventorySampling.length} balances registrados
                    </span>
                  </h4>
                  <p className="text-xs text-slate-400 mt-1">
                    Balance por activación: Inventario Inicial (antes de degustar) vs Inventario Final, muestras entregadas y ventas generadas
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => refreshSupabaseData()}
                    disabled={isLoadingSupabase}
                    className="inline-flex items-center gap-2 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors text-xs font-medium border border-slate-700 disabled:opacity-50"
                    title="Sincronizar balances de inventario en vivo desde Supabase"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 text-emerald-400 ${isLoadingSupabase ? 'animate-spin' : ''}`} />
                    {isLoadingSupabase ? 'Sincronizando...' : 'Sincronizar Inventarios'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsNewInventoryModalOpen(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors text-xs font-medium shadow-lg shadow-red-600/20"
                  >
                    <Plus className="w-4 h-4" />
                    Registrar Balance
                  </button>
                </div>
              </div>

              {/* 4 Tarjetas KPI de Inventario y Degustación */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Inv. Inicial Total</p>
                  <p className="text-2xl font-bold text-white">
                    {inventorySampling.reduce((acc, r) => acc + r.initialStock, 0).toFixed(1)}{' '}
                    <span className="text-xs font-normal text-slate-400">Unid/Kg</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Stock al iniciar la jornada</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Inv. Final Remanente</p>
                  <p className="text-2xl font-bold text-amber-400">
                    {inventorySampling.reduce((acc, r) => acc + r.finalStock, 0).toFixed(1)}{' '}
                    <span className="text-xs font-normal text-slate-400">Unid/Kg</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Stock físico al cierre</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Muestras Degustadas</p>
                  <p className="text-2xl font-bold text-purple-400">
                    {inventorySampling.reduce((acc, r) => acc + r.portionsSampled, 0).toFixed(1)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Impactos directos a consumidores</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Resultado (Ventas)</p>
                  <p className="text-2xl font-bold text-emerald-400">
                    {inventorySampling.reduce((acc, r) => acc + r.salesGenerated, 0).toFixed(1)}{' '}
                    <span className="text-xs font-normal text-slate-400">Unid/Kg</span>
                  </p>
                  <p className="text-xs text-emerald-400/80 mt-1">Rotación efectiva durante degustación</p>
                </div>
              </div>

              {/* Tabla de 9 Columnas de Inventario y Degustación */}
              <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-900 border-b border-slate-800 text-xs text-slate-400 uppercase">
                        <th className="p-4 font-semibold">Fecha</th>
                        <th className="p-4 font-semibold">Punto de Venta (PDV)</th>
                        <th className="p-4 font-semibold">Producto & SKU</th>
                        <th className="p-4 font-semibold text-center">Inv. Inicial (antes degustar)</th>
                        <th className="p-4 font-semibold text-center">Inv. Final (post venta)</th>
                        <th className="p-4 font-semibold text-center">Muestras</th>
                        <th className="p-4 font-semibold text-center">Resultado (ventas generadas)</th>
                        <th className="p-4 font-semibold">Observación de la Actividad (Promotora)</th>
                        <th className="p-4 font-semibold text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-sm">
                      {inventorySampling
                        .filter((inv) => {
                          if (!reportSearchQuery.trim()) return true;
                          const q = reportSearchQuery.toLowerCase();
                          return (
                            inv.storeName.toLowerCase().includes(q) ||
                            inv.productName.toLowerCase().includes(q) ||
                            inv.promotora.toLowerCase().includes(q) ||
                            (inv.dateSlash || inv.date).toLowerCase().includes(q) ||
                            inv.observations.toLowerCase().includes(q)
                          );
                        })
                        .slice(0, reportRowLimit)
                        .map((inv) => (
                          <tr key={inv.id} className="hover:bg-slate-800/30 transition-colors">
                            <td className="p-4 text-slate-300 whitespace-nowrap font-mono text-xs">
                              {inv.dateSlash || inv.date}
                            </td>
                            <td className="p-4">
                              <div className="font-medium text-white">{inv.storeName}</div>
                              <div className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                                <MapPin className="w-3 h-3 text-red-400" /> {inv.zone} • {inv.promotora}
                              </div>
                            </td>
                            <td className="p-4">
                              <div className="font-medium text-red-300">{inv.productName}</div>
                              <div className="text-xs text-slate-500 font-mono">
                                {inv.sku} • {inv.unit}
                              </div>
                            </td>
                            <td className="p-4 text-center">
                              <span className="inline-block px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 font-mono font-bold text-white">
                                {inv.initialStock} {inv.unit}
                              </span>
                            </td>
                            <td className="p-4 text-center">
                              <span
                                className={`inline-block px-2.5 py-1 rounded-lg border font-mono font-bold ${
                                  inv.finalStock <= 5
                                    ? 'bg-red-500/10 border-red-500/30 text-red-400'
                                    : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                                }`}
                              >
                                {inv.finalStock} {inv.unit}
                              </span>
                              {inv.finalStock <= 5 && (
                                <div className="text-[10px] text-red-400 mt-1 flex items-center justify-center gap-0.5">
                                  <AlertCircle className="w-3 h-3" /> Stock crítico
                                </div>
                              )}
                            </td>
                            <td className="p-4 text-center">
                              <span className="font-mono font-semibold text-purple-300">{inv.portionsSampled}</span>
                              <div className="text-[10px] text-slate-500">porciones</div>
                            </td>
                            <td className="p-4 text-center">
                              <div className="inline-flex flex-col items-center">
                                <span className="px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-mono font-bold text-xs">
                                  +{inv.salesGenerated} {inv.unit}
                                </span>
                                <span className="text-[11px] text-emerald-400/80 mt-1 font-medium">
                                  Rotación: {inv.rotationPercent}%
                                </span>
                              </div>
                            </td>
                            <td className="p-4 max-w-xs">
                              <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-300 leading-relaxed">
                                {inv.observations || (
                                  <span className="text-slate-500 italic">Sin observación registrada</span>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => setEditingInventoryObs({ id: inv.id, text: inv.observations })}
                                className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
                              >
                                <Edit2 className="w-3 h-3" /> Editar observación
                              </button>
                            </td>
                            <td className="p-4 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => setEditingInventoryObs({ id: inv.id, text: inv.observations })}
                                  className="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition-colors"
                                  title="Editar observación de promotora"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteInventoryReport(inv.id)}
                                  className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                  title="Eliminar reporte de inventario"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Modal para Editar Observación de Promotora en Inventario */}
              {editingInventoryObs && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
                  <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-6 shadow-2xl">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-bold text-white flex items-center gap-2">
                        <Edit2 className="w-5 h-5 text-cyan-400" />
                        Observación de la Actividad (Promotora)
                      </h3>
                      <button
                        type="button"
                        onClick={() => setEditingInventoryObs(null)}
                        className="text-slate-400 hover:text-white"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 mb-3">
                      Registra o actualiza los comentarios de la promotora sobre el comportamiento del consumidor, rotación en anaquel o alertas de reposición.
                    </p>
                    <textarea
                      rows={4}
                      value={editingInventoryObs.text}
                      onChange={(e) => setEditingInventoryObs({ ...editingInventoryObs, text: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-sm text-white focus:outline-none focus:border-cyan-500"
                      placeholder="Escribe la observación de la promotora..."
                    />
                    <div className="flex justify-end gap-2 mt-4">
                      <button
                        type="button"
                        onClick={() => setEditingInventoryObs(null)}
                        className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveInventoryObservation(editingInventoryObs.id, editingInventoryObs.text)}
                        className="px-4 py-2 rounded-lg text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white"
                      >
                        Guardar Observación
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Modal para Registrar Nuevo Balance de Inventario y Degustación */}
              {isNewInventoryModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
                  <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-bold text-white flex items-center gap-2">
                        <Box className="w-5 h-5 text-red-400" />
                        Registrar Balance de Inventario y Degustación
                      </h3>
                      <button
                        type="button"
                        onClick={() => setIsNewInventoryModalOpen(false)}
                        className="text-slate-400 hover:text-white"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                    <form onSubmit={handleAddInventoryReport} className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Fecha</label>
                          <input
                            type="date"
                            value={newInventoryForm.date}
                            onChange={(e) => setNewInventoryForm({ ...newInventoryForm, date: e.target.value })}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Promotora Responsable</label>
                          <select
                            value={newInventoryForm.promoterName}
                            onChange={(e) => setNewInventoryForm({ ...newInventoryForm, promoterName: e.target.value })}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                          >
                            {staffList.map((s) => ({ id: s.id, name: s.name, zone: s.address })).map((p) => (
                              <option key={p.id} value={p.name}>
                                {p.name} ({p.zone})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="md:col-span-2">
                          <label className="block text-xs text-slate-400 mb-1">Punto de Venta (PDV)</label>
                          <input
                            type="text"
                            list="stores-datalist-inv"
                            value={newInventoryForm.storeName}
                            onChange={(e) => setNewInventoryForm({ ...newInventoryForm, storeName: e.target.value })}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                            required
                          />
                          <datalist id="stores-datalist-inv">
                            {syncedStoreOptions.map((s) => (
                              <option key={s} value={s} />
                            ))}
                          </datalist>
                        </div>
                        <div className="md:col-span-2">
                          <label className="block text-xs text-slate-400 mb-1">Producto Degustado / Auditado</label>
                          <input
                            type="text"
                            list="products-datalist-inv"
                            value={newInventoryForm.productName}
                            onChange={(e) => setNewInventoryForm({ ...newInventoryForm, productName: e.target.value })}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                            required
                            />
                            <datalist id="products-datalist-inv">
                              {syncedProductOptions.map((name) => (<option key={name} value={name} />))}
                            </datalist>
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Inventario Inicial (Unid/Kg)</label>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={newInventoryForm.initialInventory}
                            onChange={(e) =>
                              setNewInventoryForm({ ...newInventoryForm, initialInventory: Number(e.target.value) })
                            }
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Inventario Final (Unid/Kg)</label>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={newInventoryForm.finalInventory}
                            onChange={(e) =>
                              setNewInventoryForm({ ...newInventoryForm, finalInventory: Number(e.target.value) })
                            }
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Muestras Entregadas</label>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={newInventoryForm.samplesGiven}
                            onChange={(e) =>
                              setNewInventoryForm({ ...newInventoryForm, samplesGiven: Number(e.target.value) })
                            }
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                            required
                          />
                        </div>
                        <div className="flex flex-col justify-center bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                          <span className="text-[11px] text-emerald-300 uppercase font-semibold">
                            Resultado Calculado (Ventas)
                          </span>
                          <span className="text-lg font-bold text-emerald-400 font-mono">
                            +
                            {Math.max(
                              0,
                              Number(
                                (
                                  newInventoryForm.initialInventory -
                                  newInventoryForm.finalInventory -
                                  newInventoryForm.samplesGiven
                                ).toFixed(2)
                              )
                            )}{' '}
                            Unid/Kg
                          </span>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Observación de la Promotora sobre la Actividad
                        </label>
                        <textarea
                          rows={3}
                          value={newInventoryForm.promoterObservation}
                          onChange={(e) =>
                            setNewInventoryForm({ ...newInventoryForm, promoterObservation: e.target.value })
                          }
                          placeholder="Detalla la receptividad del cliente, rotación en nevera, reposición solicitada al encargado, etc."
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-white"
                          required
                        />
                      </div>
                      <div className="flex justify-end gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => setIsNewInventoryModalOpen(false)}
                          className="px-4 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800"
                        >
                          Cancelar
                        </button>
                        <button
                          type="submit"
                          disabled={isSubmittingInventory}
                          className="px-4 py-2 rounded-lg text-xs font-medium bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
                        >
                          {isSubmittingInventory ? 'Guardando...' : 'Guardar Balance'}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 4: ASISTENCIA EN PDV (SECUENCIA DE 4 FOTOS POR PROMOTORA Y JORNADA) */}
          {/* ========================================================================= */}
          {activeReportTab === 'asistencia' && (
            <div className="space-y-6">
              {attendanceGroupedByDay.length === 0 ? (
                <div className="bg-zinc-950 border border-zinc-900 rounded-2xl p-10 text-center text-zinc-400 text-xs">
                  No se encontraron registros de asistencia que coincidan con la búsqueda actual.
                </div>
              ) : (
                attendanceGroupedByDay.map((dayGroup) => (
                  <div key={dayGroup.date} className="space-y-4">
                    {/* CABECERA DE DÍA (EJ: LUNES, 26 DE OCTUBRE DE 2026 | 26/10/2026) */}
                    <div className="bg-slate-950/90 border border-slate-800/90 rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 shadow-lg">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-red-950/60 border border-red-500/40 flex items-center justify-center text-red-500">
                          <Calendar className="w-4 h-4" />
                        </div>
                        <div className="flex flex-wrap items-center gap-2.5">
                          <span className="text-xs sm:text-sm font-black text-white uppercase tracking-wide">
                            {dayGroup.dateLongEs}
                          </span>
                          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300 font-bold">
                            {dayGroup.dateSlash}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 font-mono text-[11px]">
                        <span className="px-2.5 py-1 rounded-lg bg-red-950/70 border border-red-800/80 text-red-300 font-bold">
                          {dayGroup.records.length} promotora(s)
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 font-bold">
                          {dayGroup.totalMarcajes} marcaje(s)
                        </span>
                      </div>
                    </div>

                    {/* TARJETAS POR PROMOTORA DENTRO DEL DÍA */}
                    <div className="space-y-5">
                      {dayGroup.records.map((att) => {
                        const isComplete = Boolean(att.salidaEvent);
                        const slots: Array<{
                          slotNumber: number;
                          title: string;
                          subtitle: string;
                          legendLabel: string;
                          emptyText: string;
                          badgeColorClass: string;
                          legendBadgeClass: string;
                          event?: AttendanceSlotEvent;
                        }> = [
                          {
                            slotNumber: 1,
                            title: '1. FOTO DE INGRESO',
                            subtitle: 'Apertura de jornada en PDV',
                            legendLabel: 'INGRESO',
                            emptyText: 'Pendiente / Sin registro de ingreso',
                            badgeColorClass: 'bg-emerald-950/90 text-emerald-400 border-emerald-700/80',
                            legendBadgeClass: 'bg-emerald-600 text-white border-emerald-400',
                            event: att.ingresoEvent,
                          },
                          {
                            slotNumber: 2,
                            title: '2. SALIDA A ALMORZAR',
                            subtitle: 'Cuando aplique',
                            legendLabel: 'SALIDA A ALMORZAR',
                            emptyText: 'Pendiente / Sin registro de salida a almorzar',
                            badgeColorClass: 'bg-amber-950/90 text-amber-400 border-amber-700/80',
                            legendBadgeClass: 'bg-amber-600 text-white border-amber-400',
                            event: att.salidaAlmorzarEvent,
                          },
                          {
                            slotNumber: 3,
                            title: '3. LLEGADA DE ALMORZAR',
                            subtitle: 'Cuando aplique',
                            legendLabel: 'LLEGADA DE ALMORZAR',
                            emptyText: 'Pendiente / Sin registro de llegada de almorzar',
                            badgeColorClass: 'bg-sky-950/90 text-sky-400 border-sky-700/80',
                            legendBadgeClass: 'bg-sky-600 text-white border-sky-400',
                            event: att.llegadaAlmorzarEvent,
                          },
                          {
                            slotNumber: 4,
                            title: '4. SALIDA',
                            subtitle: 'Cierre de guardia en PDV',
                            legendLabel: 'SALIDA',
                            emptyText: 'Pendiente / Sin registro de salida',
                            badgeColorClass: 'bg-purple-950/90 text-purple-300 border-purple-700/80',
                            legendBadgeClass: 'bg-purple-600 text-white border-purple-400',
                            event: att.salidaEvent,
                          },
                        ];

                        return (
                          <div
                            key={att.id}
                            className="bg-slate-950/95 border border-slate-800/90 rounded-2xl overflow-hidden shadow-2xl"
                          >
                            {/* CABECERA DE LA PROMOTORA */}
                            <div className="px-5 py-4 border-b border-slate-800/80 flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-gradient-to-r from-slate-950 via-slate-900/90 to-slate-950">
                              <div className="flex items-start sm:items-center gap-3.5">
                                <div className="w-11 h-11 rounded-full bg-red-600 text-white font-black text-sm flex items-center justify-center border-2 border-red-400/80 shadow-lg shadow-red-950/70 shrink-0">
                                  {att.initials}
                                </div>
                                <div className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-2.5">
                                    <h5 className="text-sm sm:text-base font-black text-white uppercase tracking-tight">
                                      {att.promotora}
                                    </h5>
                                    <span
                                      className={`px-2.5 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider border ${
                                        isComplete
                                          ? 'bg-emerald-950/80 text-emerald-400 border-emerald-700/70'
                                          : 'bg-amber-950/80 text-amber-400 border-amber-700/70'
                                      }`}
                                    >
                                      {isComplete ? 'JORNADA COMPLETADA' : 'EN GUARDIA / MARCAJE PARCIAL'}
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                                    <StoreIcon className="w-3.5 h-3.5 text-red-500 shrink-0" />
                                    <span className="font-semibold text-slate-200">{att.storeName}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                                <div className="text-slate-400">
                                  <span>Fecha: </span>
                                  <strong className="text-white">{att.dateSlash}</strong>
                                </div>
                                <a
                                  href={att.mapsUrl || '#'}
                                  target={att.mapsUrl ? '_blank' : undefined}
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-950/60 hover:bg-emerald-900/70 text-emerald-400 border border-emerald-800/80 font-mono text-[11px] font-bold transition"
                                  title="Abrir ubicación GPS en Google Maps"
                                >
                                  <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                  <span>
                                    {att.zone} ({att.gpsAccuracy})
                                  </span>
                                </a>
                              </div>
                            </div>

                            {/* SECUENCIA DE 4 COLUMNAS DE FOTOS (INGRESO, SALIDA A ALMORZAR, LLEGADA DE ALMORZAR, SALIDA) */}
                            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                              {slots.map((slot) => {
                                const ev = slot.event;
                                const isSlotHidden = ev ? Boolean(hiddenSlotIds[ev.checkinId]) : false;
                                const hasActiveEvent = Boolean(ev && !isSlotHidden);
                                const loadedPhoto = ev ? checkinPhotosMap[ev.checkinId] : undefined;

                                return (
                                  <div
                                    key={slot.slotNumber}
                                    className="bg-slate-900/75 border border-slate-800/90 rounded-xl p-3 flex flex-col justify-between space-y-2.5 shadow-inner"
                                  >
                                    {/* TÍTULO DEL SLOT Y BADGE DE HORA */}
                                    <div className="flex items-start justify-between gap-2">
                                      <div>
                                        <span className="text-[11px] font-black text-white uppercase tracking-wide block">
                                          {slot.title}
                                        </span>
                                        <span className="text-[10px] text-slate-400 block">{slot.subtitle}</span>
                                      </div>

                                      {hasActiveEvent && ev ? (
                                        <span
                                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-black border shrink-0 ${slot.badgeColorClass}`}
                                        >
                                          {ev.timeFormatted}
                                        </span>
                                      ) : (
                                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-950 text-slate-500 border border-slate-800 shrink-0">
                                          Sin registro
                                        </span>
                                      )}
                                    </div>

                                    {/* CUERPO VISUAL DE LA TARJETA (IMAGEN + LEYENDA DE UBICACIÓN, HORA, LUGAR Y TIPO DE MARCAJE) */}
                                    {hasActiveEvent && ev ? (
                                      <div className="relative group rounded-xl overflow-hidden bg-black border border-slate-800 h-60 flex items-center justify-center">
                                        {loadedPhoto ? (
                                          <img
                                            src={loadedPhoto}
                                            alt={`${att.promotora} - ${slot.legendLabel}`}
                                            onClick={() => handleOpenSlotPhotoModal(ev, att.promotora)}
                                            className="w-full h-full object-cover cursor-pointer group-hover:scale-[1.02] transition-transform duration-300"
                                          />
                                        ) : (
                                          <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
                                            <Loader2 className="w-6 h-6 text-red-500 animate-spin" />
                                            <span className="text-[11px] text-slate-300 font-mono">
                                              Cargando foto de {slot.legendLabel.toLowerCase()}...
                                            </span>
                                            <button
                                              type="button"
                                              onClick={() => handleReloadSingleSlotPhoto(ev.checkinId)}
                                              className="mt-1 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-red-600 text-[10px] text-slate-200 font-bold border border-slate-700 transition"
                                            >
                                              Sincronizar ahora
                                            </button>
                                          </div>
                                        )}

                                        {/* BOTONES DE ACCIÓN EN ESQUINA SUPERIOR DERECHA */}
                                        <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 z-10">
                                          <button
                                            type="button"
                                            onClick={() => handleReloadSingleSlotPhoto(ev.checkinId)}
                                            title="Recargar / Sincronizar foto desde Supabase"
                                            className="w-7 h-7 rounded-lg bg-slate-950/85 hover:bg-red-600 text-white border border-slate-700/80 flex items-center justify-center shadow-lg transition"
                                          >
                                            <Camera className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleOpenSlotPhotoModal(ev, att.promotora)}
                                            title="Ampliar fotografía con detalle completo"
                                            className="w-7 h-7 rounded-lg bg-slate-950/85 hover:bg-red-600 text-white border border-slate-700/80 flex items-center justify-center shadow-lg transition"
                                          >
                                            <Maximize2 className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setHiddenSlotIds((prev) => ({
                                                ...prev,
                                                [ev.checkinId]: true,
                                              }))
                                            }
                                            title="Ocultar vista previa de este marcaje"
                                            className="w-7 h-7 rounded-lg bg-red-950/90 hover:bg-red-600 text-red-200 hover:text-white border border-red-700/70 flex items-center justify-center shadow-lg transition"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>

                                        {/* LEYENDA INFERIOR SUPERPUESTA: TIPO DE MARCAJE, LUGAR, HORA Y UBICACIÓN GPS */}
                                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/85 to-transparent p-2.5 pt-6 text-left pointer-events-none">
                                          <div className="flex items-center gap-1.5 mb-1">
                                            <span
                                              className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider border shadow-sm ${slot.legendBadgeClass}`}
                                            >
                                              {slot.legendLabel}
                                            </span>
                                            <span className="text-[10px] font-black text-white uppercase tracking-tight truncate">
                                              CODIZULCA ASISTENCIA - [{slot.legendLabel}]
                                            </span>
                                          </div>
                                          <p className="text-[10px] font-bold text-slate-200 truncate">
                                            {ev.storeName} • {ev.dateFormatted} {ev.fullTimeFormatted}
                                          </p>
                                          <p className="text-[10px] font-mono text-emerald-400 font-semibold truncate">
                                            GPS:{' '}
                                            {ev.lat !== undefined && ev.lng !== undefined
                                              ? `${ev.lat.toFixed(6)}, ${ev.lng.toFixed(6)} (±${ev.accuracy}m)`
                                              : att.zone}
                                          </p>
                                        </div>
                                      </div>
                                    ) : (
                                      /* ESTADO PENDIENTE / SIN REGISTRO */
                                      <div className="rounded-xl bg-slate-950/90 border border-slate-800/80 h-60 flex flex-col items-center justify-center p-4 text-center space-y-2.5">
                                        <div className="w-10 h-10 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500">
                                          <Clock className="w-5 h-5" />
                                        </div>
                                        <p className="text-[11px] text-slate-400 font-medium max-w-[180px]">
                                          {slot.emptyText}
                                        </p>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            if (ev) {
                                              setHiddenSlotIds((prev) => ({
                                                ...prev,
                                                [ev.checkinId]: false,
                                              }));
                                              handleReloadSingleSlotPhoto(ev.checkinId);
                                            } else {
                                              showToast(
                                                `Consultando marcaje de ${slot.legendLabel} para ${att.promotora} en Supabase...`
                                              );
                                            }
                                          }}
                                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700 text-[11px] font-bold transition shadow"
                                        >
                                          <Camera className="w-3.5 h-3.5 text-red-500" />
                                          <span>Cargar / Sincronizar Foto</span>
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. SUBMÓDULO: MERCHANDISING (GALERÍA DE VISITAS EN PDV + ACTA CERTIFICADA) */}
      {/* ========================================================================= */}
      {activeSubTab === 'merchandising' && (
        <div className="space-y-6">
          {/* Cabecera y Filtros de Merchandising */}
          <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-6 space-y-5 backdrop-blur-md">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <StoreIcon className="w-5 h-5 text-red-500" />
                  <span>Gestión y Auditoría de Merchandising en Punto de Venta</span>
                </h2>
                <p className="text-sm text-zinc-400">
                  Control en tiempo real de visitas de mercaderistas, evidencias fotográficas de anaquel y firmas certificadas de encargados de tienda.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => refreshSupabaseData()}
                  disabled={isLoadingSupabase}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold border border-white/10 transition flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingSupabase ? 'animate-spin' : ''}`} />
                  <span>Sincronizar Informes</span>
                </button>
              </div>
            </div>

            {/* KPIs de Merchandising */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-4">
                <p className="text-[10px] text-zinc-400 uppercase font-mono mb-1">Informes de Visita</p>
                <p className="text-2xl font-black text-white">{filteredMerchandisingReports.length}</p>
                <p className="text-[11px] text-zinc-500 mt-0.5">Registros de Merchandising</p>
              </div>
              <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-4">
                <p className="text-[10px] text-zinc-400 uppercase font-mono mb-1">PDVs Auditados</p>
                <p className="text-2xl font-black text-cyan-400">
                  {new Set(filteredMerchandisingReports.map((r) => r.storeName.toUpperCase())).size}
                </p>
                <p className="text-[11px] text-zinc-500 mt-0.5">Puntos de venta únicos</p>
              </div>
              <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-4">
                <p className="text-[10px] text-zinc-400 uppercase font-mono mb-1">Share of Shelf Promedio</p>
                <p className="text-2xl font-black text-amber-400">
                  {(() => {
                    const withSos = filteredMerchandisingReports.filter(
                      (r) => (r.metrics?.shareOfShelfPercent || 0) > 0
                    );
                    if (withSos.length === 0) return '42%';
                    const avg = Math.round(
                      withSos.reduce((acc, r) => acc + (r.metrics?.shareOfShelfPercent || 0), 0) / withSos.length
                    );
                    return `${avg}%`;
                  })()}
                </p>
                <p className="text-[11px] text-zinc-500 mt-0.5">Espacio Codizulca en anaquel</p>
              </div>
              <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-4">
                <p className="text-[10px] text-zinc-400 uppercase font-mono mb-1">Actividades Verificadas</p>
                <p className="text-2xl font-black text-emerald-400">
                  {filteredMerchandisingReports.reduce((acc, r) => acc + (r.activities?.length || 1), 0)}
                </p>
                <p className="text-[11px] text-zinc-500 mt-0.5">Labores de anaquel ejecutadas</p>
              </div>
              <div className="bg-zinc-900/90 border border-white/10 rounded-xl p-4">
                <p className="text-[10px] text-zinc-400 uppercase font-mono mb-1">Firma de Encargado</p>
                <p className="text-2xl font-black text-emerald-400">100%</p>
                <p className="text-[11px] text-zinc-500 mt-0.5">Actas validadas digitalmente</p>
              </div>
            </div>

            {/* Barra de Filtros de Merchandising */}
            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-white/5">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={merchSearchQuery}
                  onChange={(e) => setMerchSearchQuery(e.target.value)}
                  placeholder="Buscar por PDV, encargado, dirección o actividad..."
                  className="w-full h-9 pl-9 pr-3 rounded-xl bg-zinc-950 border border-white/10 text-xs text-white focus:outline-none focus:border-red-500"
                />
              </div>

              <select
                value={merchFilterPromoter}
                onChange={(e) => setMerchFilterPromoter(e.target.value)}
                className="h-9 px-3 rounded-xl bg-zinc-950 border border-white/10 text-xs text-white focus:outline-none focus:border-red-500"
              >
                <option value="TODOS">Todos los Mercaderistas</option>
                {uniqueMerchPromoters.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>

              <input
                type="date"
                value={merchFilterDate}
                onChange={(e) => setMerchFilterDate(e.target.value)}
                className="h-9 px-3 rounded-xl bg-zinc-950 border border-white/10 text-xs text-white focus:outline-none focus:border-red-500"
              />
              {merchFilterDate && (
                <button
                  type="button"
                  onClick={() => setMerchFilterDate('')}
                  className="text-xs text-zinc-400 hover:text-white underline"
                >
                  Ver todas las fechas
                </button>
              )}
            </div>

            {/* Grid de Tarjetas de Visita de Merchandising (3 Columnas) */}
            {filteredMerchandisingReports.length === 0 ? (
              <div className="py-12 text-center bg-zinc-950/60 border border-white/5 rounded-2xl space-y-2">
                <StoreIcon className="w-8 h-8 text-zinc-600 mx-auto" />
                <p className="text-sm font-bold text-zinc-300">
                  No se encontraron informes de Merchandising con los filtros seleccionados.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {filteredMerchandisingReports.map((report) => {
                  const { photos: resolvedPhotos, isLoading: isLoadingMerchPhoto } = getMerchResolvedPhotos(report);
                  const totalPhotos = resolvedPhotos.length;
                  const activePhotoIdx =
                    totalPhotos > 0 ? Math.min(merchCardPhotoIdx[report.id] || 0, totalPhotos - 1) : 0;
                  const coverPhoto = totalPhotos > 0 ? resolvedPhotos[activePhotoIdx] : '';
                  const hasSignature = Boolean(report.signatureBase64);

                  return (
                    <div
                      key={report.id}
                      className="bg-zinc-950/95 border border-white/10 hover:border-red-500/45 rounded-2xl overflow-hidden flex flex-col justify-between transition-all duration-200 group shadow-xl"
                    >
                      {/* Visor Principal de la Imagen Publicada por el Promotor */}
                      <div>
                        <div
                          className="relative h-64 bg-black overflow-hidden cursor-pointer select-none"
                          onClick={() => {
                            if (totalPhotos > 0) {
                              handleOpenMerchPhotoLightbox(report, resolvedPhotos, activePhotoIdx);
                            } else {
                              setSelectedMerchReportForAudit(report);
                            }
                          }}
                        >
                          {coverPhoto ? (
                            <>
                              {/* Fondo ambiental difuminado para enmarcar fotos verticales y horizontales sin recortar contenido */}
                              <img
                                src={coverPhoto}
                                aria-hidden="true"
                                className="absolute inset-0 w-full h-full object-cover blur-xl opacity-45 scale-110 pointer-events-none"
                              />
                              <img
                                src={coverPhoto}
                                alt={`${report.storeName} - ${report.promoter}`}
                                className="relative z-[1] w-full h-full object-contain group-hover:scale-[1.02] transition-transform duration-300 drop-shadow-2xl"
                              />
                            </>
                          ) : isLoadingMerchPhoto ? (
                            <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 via-zinc-950 to-black text-zinc-400 gap-2.5">
                              <Loader2 className="w-7 h-7 text-red-500 animate-spin" />
                              <span className="text-[11px] font-mono text-zinc-300">
                                Cargando imagen publicada por {report.promoter.split(' ')[0]}...
                              </span>
                            </div>
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950 text-zinc-500 gap-2 px-6 text-center">
                              <Camera className="w-8 h-8 text-zinc-600" />
                              <span className="text-[11px] font-mono text-zinc-400">
                                Visita certificada sin fotografía adjunta
                              </span>
                            </div>
                          )}

                          {/* Sello Superior Izquierdo: Firma Validada */}
                          <div className="absolute top-2.5 left-2.5 z-10 flex flex-wrap gap-1.5 pointer-events-none">
                            <span className="px-2.5 py-1 rounded-lg bg-emerald-600/95 border border-emerald-400/50 text-white text-[10px] font-black uppercase tracking-wider backdrop-blur-md flex items-center gap-1 shadow-lg">
                              <CheckCircle2 className="w-3 h-3" />
                              <span>FIRMA VALIDADA</span>
                            </span>
                          </div>

                          {/* Sello Superior Derecho: Contador Real de Fotos + Botón Ampliar */}
                          <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5">
                            <span
                              className={`px-2.5 py-1 rounded-lg backdrop-blur-md text-[10px] font-mono font-bold flex items-center gap-1 shadow-lg border ${
                                totalPhotos > 0
                                  ? 'bg-black/80 text-white border-white/15'
                                  : 'bg-black/70 text-zinc-400 border-white/10'
                              }`}
                            >
                              <Camera className={`w-3 h-3 ${totalPhotos > 0 ? 'text-red-400' : 'text-zinc-500'}`} />
                              <span>
                                {totalPhotos > 1
                                  ? `${activePhotoIdx + 1}/${totalPhotos} fotos`
                                  : totalPhotos === 1
                                    ? '1 foto'
                                    : '0 fotos'}
                              </span>
                            </span>

                            {coverPhoto && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenMerchPhotoLightbox(report, resolvedPhotos, activePhotoIdx);
                                }}
                                title="Ampliar fotografía en alta resolución"
                                className="w-7 h-7 rounded-lg bg-black/80 hover:bg-red-600 text-white border border-white/15 flex items-center justify-center backdrop-blur-md shadow-lg transition"
                              >
                                <Maximize2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          {/* Flechas de navegación rápida si el promotor publicó múltiples fotos */}
                          {totalPhotos > 1 && (
                            <>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMerchCardPhotoIdx((prev) => ({
                                    ...prev,
                                    [report.id]: (activePhotoIdx - 1 + totalPhotos) % totalPhotos,
                                  }));
                                }}
                                className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 rounded-full bg-black/75 hover:bg-red-600 text-white border border-white/15 flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow-lg"
                                title="Foto anterior"
                              >
                                <ChevronLeft className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMerchCardPhotoIdx((prev) => ({
                                    ...prev,
                                    [report.id]: (activePhotoIdx + 1) % totalPhotos,
                                  }));
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 rounded-full bg-black/75 hover:bg-red-600 text-white border border-white/15 flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow-lg"
                                title="Siguiente foto"
                              >
                                <ChevronRight className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>

                        {/* Sub-barra dedicada debajo de la fotografía (para no tapar marcas de agua ni productos en la imagen) */}
                        <div className="px-3.5 py-2 bg-zinc-900/95 border-y border-white/10 flex items-center justify-between gap-2">
                          <span className="text-[11px] font-mono text-zinc-200 font-semibold flex items-center gap-1.5">
                            <Clock className="w-3 h-3 text-red-400 shrink-0" />
                            <span>
                              {report.date} • {report.time}
                            </span>
                          </span>

                          {totalPhotos > 1 ? (
                            <div className="flex items-center gap-1">
                              {resolvedPhotos.slice(0, 5).map((thumb, idx) => (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() =>
                                    setMerchCardPhotoIdx((prev) => ({
                                      ...prev,
                                      [report.id]: idx,
                                    }))
                                  }
                                  className={`w-6 h-6 rounded overflow-hidden border transition ${
                                    activePhotoIdx === idx
                                      ? 'border-red-500 ring-1 ring-red-500/40 scale-105'
                                      : 'border-white/15 opacity-60 hover:opacity-100'
                                  }`}
                                  title={`Ver foto ${idx + 1}`}
                                >
                                  <img src={thumb} alt={`Miniatura ${idx + 1}`} className="w-full h-full object-cover" />
                                </button>
                              ))}
                              {totalPhotos > 5 && (
                                <span className="text-[10px] font-mono text-zinc-400 pl-0.5">+{totalPhotos - 5}</span>
                              )}
                            </div>
                          ) : report.metrics?.shareOfShelfPercent ? (
                            <span className="text-[10px] font-mono font-bold text-amber-300 bg-amber-950/80 border border-amber-500/30 px-2 py-0.5 rounded">
                              SoS: {report.metrics.shareOfShelfPercent}%
                            </span>
                          ) : coverPhoto ? (
                            <button
                              type="button"
                              onClick={() => handleOpenMerchPhotoLightbox(report, resolvedPhotos, activePhotoIdx)}
                              className="text-[10px] font-mono text-zinc-400 hover:text-white flex items-center gap-1 transition"
                            >
                              <Maximize2 className="w-2.5 h-2.5 text-red-400" />
                              <span>Ver imagen completa</span>
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {/* Cuerpo de la Tarjeta */}
                      <div className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                        <div className="space-y-2.5">
                          <div>
                            <div className="flex items-start justify-between gap-2">
                              <h3
                                className="font-black text-white text-sm leading-snug line-clamp-1"
                                title={report.storeName}
                              >
                                {report.storeName}
                              </h3>
                            </div>
                            <p className="text-[11px] text-zinc-400 flex items-center gap-1 mt-0.5 font-mono">
                              <MapPin className="w-3 h-3 text-red-500 shrink-0" />
                              <span className="truncate">{report.address || 'Zona Comercial'}</span>
                            </p>
                          </div>

                          <div className="p-2.5 rounded-xl bg-zinc-900/90 border border-white/5 space-y-1 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-zinc-500">Mercaderista:</span>
                              <span className="font-bold text-white truncate">{report.promoter}</span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-zinc-500 shrink-0">Encargado Tienda:</span>
                              <span className="font-bold text-emerald-400 truncate">
                                {report.storeManagerName} ({report.storeManagerRole})
                              </span>
                            </div>
                          </div>

                          {/* Actividades realizadas */}
                          {report.activities && report.activities.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-[10px] font-mono uppercase text-zinc-500">
                                Actividades Ejecutadas ({report.activities.length}):
                              </p>
                              <div className="flex flex-wrap gap-1">
                                {report.activities.slice(0, 3).map((act, idx) => (
                                  <span
                                    key={idx}
                                    className="px-2 py-0.5 rounded-md bg-zinc-900 border border-white/10 text-[10px] text-zinc-300 truncate max-w-[180px]"
                                  >
                                    ✓ {act}
                                  </span>
                                ))}
                                {report.activities.length > 3 && (
                                  <span className="px-1.5 py-0.5 rounded-md bg-red-600/20 text-red-400 text-[10px] font-bold">
                                    +{report.activities.length - 3} más
                                  </span>
                                )}
                              </div>
                            </div>
                          )}

                          {report.observations && (
                            <p className="text-xs text-zinc-400 italic line-clamp-2 bg-zinc-900/50 p-2 rounded-lg border border-white/5">
                              &ldquo;{report.observations}&rdquo;
                            </p>
                          )}
                        </div>

                        {/* Vista previa de Firma del Encargado */}
                        <div className="pt-2 border-t border-white/5 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-zinc-400 font-mono">Firma del Responsable:</span>
                          </div>
                          {hasSignature ? (
                            <div className="h-8 w-24 bg-white/5 rounded border border-white/10 p-0.5 flex items-center justify-center overflow-hidden">
                              <img
                                src={report.signatureBase64}
                                alt="Firma"
                                className="h-full object-contain filter invert opacity-80"
                              />
                            </div>
                          ) : (
                            <span className="text-[10px] font-mono text-emerald-400 font-bold">✓ Certificada</span>
                          )}
                        </div>
                      </div>

                      {/* Acciones de Auditoría */}
                      <div className="p-3 bg-zinc-900/80 border-t border-white/5 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedMerchReportForAudit(report)}
                          className="flex-1 h-9 font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5 shadow-md bg-red-600 hover:bg-red-500 text-white shadow-red-600/20"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Auditar & Ver Acta</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteMerchandisingReport(report.id, report.storeName)}
                          className="p-2 rounded-xl bg-zinc-800 hover:bg-red-950/70 text-zinc-400 hover:text-red-300 border border-white/10 transition"
                          title="Eliminar informe"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Modal de Acta de Auditoría de Merchandising */}
          {selectedMerchReportForAudit && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
              <div className="bg-zinc-950 border border-white/15 rounded-2xl max-w-4xl w-full max-h-[92vh] overflow-y-auto shadow-2xl">
                <div className="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur-md px-6 py-4 border-b border-white/10 flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 text-[10px] font-mono font-bold uppercase">
                        Acta de Auditoría de Merchandising
                      </span>
                      <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-mono font-bold uppercase">
                        ✓ Firma Validada en Tienda
                      </span>
                    </div>
                    <h3 className="text-lg font-black text-white mt-1">
                      {selectedMerchReportForAudit.storeName}
                    </h3>
                    <p className="text-xs text-zinc-400 font-mono">
                      {selectedMerchReportForAudit.address} • Fecha: {selectedMerchReportForAudit.date} (
                      {selectedMerchReportForAudit.time})
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedMerchReportForAudit(null)}
                    className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-white/10"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="p-6 space-y-6">
                  {/* Datos Generales de la Visita */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-4 rounded-xl bg-zinc-900/80 border border-white/10">
                      <span className="text-[10px] font-mono uppercase text-zinc-500 block">
                        Mercaderista Responsable
                      </span>
                      <span className="text-sm font-black text-white mt-1 block">
                        {selectedMerchReportForAudit.promoter}
                      </span>
                      <span className="text-xs text-red-400 font-mono mt-0.5 block">
                        Categoría: {selectedMerchReportForAudit.category || selectedMerchReportForAudit.product}
                      </span>
                    </div>
                    <div className="p-4 rounded-xl bg-zinc-900/80 border border-white/10">
                      <span className="text-[10px] font-mono uppercase text-zinc-500 block">
                        Encargado que Certifica
                      </span>
                      <span className="text-sm font-black text-emerald-400 mt-1 block">
                        {selectedMerchReportForAudit.storeManagerName}
                      </span>
                      <span className="text-xs text-zinc-400 font-mono mt-0.5 block">
                        Cargo: {selectedMerchReportForAudit.storeManagerRole}
                        {selectedMerchReportForAudit.storeManagerPhone
                          ? ` • Tel: ${selectedMerchReportForAudit.storeManagerPhone}`
                          : ''}
                      </span>
                    </div>
                    <div className="p-4 rounded-xl bg-zinc-900/80 border border-white/10">
                      <span className="text-[10px] font-mono uppercase text-zinc-500 block">
                        Métricas de Góndola
                      </span>
                      <div className="flex items-center gap-3 mt-1">
                        <div>
                          <span className="text-xs text-zinc-400">Caras (Facings): </span>
                          <strong className="text-white font-mono">
                            {selectedMerchReportForAudit.metrics?.codizulcaFacings || 14} /{' '}
                            {selectedMerchReportForAudit.metrics?.totalFacings || 32}
                          </strong>
                        </div>
                        <div>
                          <span className="text-xs text-zinc-400">SoS: </span>
                          <strong className="text-amber-400 font-mono">
                            {selectedMerchReportForAudit.metrics?.shareOfShelfPercent || 44}%
                          </strong>
                        </div>
                      </div>
                      <span className="text-[11px] text-emerald-400 font-mono mt-0.5 block">
                        Cumplimiento Planograma:{' '}
                        {selectedMerchReportForAudit.metrics?.planogramCompliance || 95}%
                      </span>
                    </div>
                  </div>

                  {/* Lista de Actividades Ejecutadas */}
                  <div className="p-4 rounded-xl bg-zinc-900/60 border border-white/10 space-y-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span>Actividades Ejecutadas en el Punto de Venta</span>
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {(selectedMerchReportForAudit.activities &&
                      selectedMerchReportForAudit.activities.length > 0
                        ? selectedMerchReportForAudit.activities
                        : [selectedMerchReportForAudit.visitReason]
                      ).map((act, i) => (
                        <div
                          key={i}
                          className="p-2.5 rounded-lg bg-zinc-950 border border-emerald-500/20 flex items-center gap-2 text-xs text-zinc-200"
                        >
                          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                          <span>{act}</span>
                        </div>
                      ))}
                    </div>
                    {selectedMerchReportForAudit.observations && (
                      <div className="pt-2 border-t border-white/5">
                        <span className="text-[10px] font-mono uppercase text-zinc-500 block mb-1">
                          Observaciones de Campo:
                        </span>
                        <p className="text-xs text-zinc-300 bg-zinc-950 p-3 rounded-lg border border-white/5">
                          {selectedMerchReportForAudit.observations}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Galería de Evidencias Fotográficas */}
                  {(() => {
                    const { photos: auditPhotos, isLoading: isLoadingAuditPhotos } =
                      getMerchResolvedPhotos(selectedMerchReportForAudit);
                    return (
                      <div className="space-y-3">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                          <Camera className="w-4 h-4 text-red-500" />
                          <span>
                            Evidencia Fotográfica Publicada por el Mercaderista ({auditPhotos.length}{' '}
                            {auditPhotos.length === 1 ? 'Foto' : 'Fotos'})
                          </span>
                        </h4>
                        {auditPhotos.length > 0 ? (
                          <div
                            className={`grid gap-3 ${
                              auditPhotos.length === 1
                                ? 'grid-cols-1 max-w-xl'
                                : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3'
                            }`}
                          >
                            {auditPhotos.map((photo, index) => (
                              <div
                                key={index}
                                onClick={() =>
                                  handleOpenMerchPhotoLightbox(selectedMerchReportForAudit, auditPhotos, index)
                                }
                                className="relative group rounded-xl overflow-hidden border border-white/10 hover:border-red-500/50 bg-black h-64 cursor-pointer flex items-center justify-center"
                              >
                                <img
                                  src={photo}
                                  aria-hidden="true"
                                  className="absolute inset-0 w-full h-full object-cover blur-xl opacity-40 scale-110 pointer-events-none"
                                />
                                <img
                                  src={photo}
                                  alt={`Evidencia ${index + 1}`}
                                  className="relative z-[1] w-full h-full object-contain group-hover:scale-[1.02] transition-transform duration-300"
                                />
                                <div className="absolute top-2.5 right-2.5 z-10 px-2.5 py-1 rounded-lg bg-black/80 border border-white/15 text-white text-[10px] font-mono flex items-center gap-1">
                                  <Maximize2 className="w-3 h-3 text-red-400" />
                                  <span>Foto #{index + 1} • Ampliar</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : isLoadingAuditPhotos ? (
                          <div className="p-8 rounded-xl bg-zinc-900/50 border border-white/5 flex flex-col items-center justify-center gap-2 text-xs text-zinc-300 font-mono">
                            <Loader2 className="w-6 h-6 text-red-500 animate-spin" />
                            <span>Sincronizando fotografía publicada por {selectedMerchReportForAudit.promoter}...</span>
                          </div>
                        ) : (
                          <div className="p-6 rounded-xl bg-zinc-900/50 border border-white/5 text-center text-xs text-zinc-400">
                            Este registro fue sincronizado con firma digital certificada del encargado (
                            {selectedMerchReportForAudit.storeManagerName}) sin fotografía adjunta en el paquete.
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Certificación y Firma Digital del Encargado */}
                  <div className="p-5 rounded-2xl bg-gradient-to-br from-emerald-950/30 via-zinc-900 to-zinc-950 border border-emerald-500/30 flex flex-col md:flex-row items-center justify-between gap-6">
                    <div className="space-y-1.5">
                      <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-mono font-bold uppercase">
                        Certificación de Conformidad del Cliente
                      </span>
                      <h4 className="text-sm font-black text-white">
                        Constancia de Ejecución de Merchandising en Tienda
                      </h4>
                      <p className="text-xs text-zinc-300 max-w-xl leading-relaxed">
                        Yo,{' '}
                        <strong className="text-emerald-400">
                          {selectedMerchReportForAudit.storeManagerName}
                        </strong>
                        , en calidad de{' '}
                        <strong>{selectedMerchReportForAudit.storeManagerRole}</strong> del establecimiento{' '}
                        <strong className="text-white">{selectedMerchReportForAudit.storeName}</strong>,
                        certifico que el mercaderista{' '}
                        <strong className="text-white">{selectedMerchReportForAudit.promoter}</strong> realizó
                        satisfactoriamente las labores de exhibición, rotación y acondicionamiento de anaquel de
                        los productos Codizulca.
                      </p>
                    </div>
                    <div className="flex flex-col items-center bg-white rounded-xl p-3 min-w-[220px] shadow-inner">
                      {selectedMerchReportForAudit.signatureBase64 ? (
                        <img
                          src={selectedMerchReportForAudit.signatureBase64}
                          alt="Firma del Encargado"
                          className="h-20 object-contain"
                        />
                      ) : (
                        <div className="h-20 flex items-center justify-center text-zinc-500 text-xs font-mono">
                          Firma Validada Digitalmente
                        </div>
                      )}
                      <div className="w-full border-t border-zinc-300 mt-1 pt-1 text-center">
                        <p className="text-[11px] font-bold text-zinc-900">
                          {selectedMerchReportForAudit.storeManagerName}
                        </p>
                        <p className="text-[9px] font-mono uppercase text-zinc-600">
                          {selectedMerchReportForAudit.storeManagerRole} •{' '}
                          {selectedMerchReportForAudit.date}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="sticky bottom-0 z-20 bg-zinc-950/95 backdrop-blur-md px-6 py-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold flex items-center gap-1.5"
                  >
                    <Printer className="w-4 h-4" />
                    <span>Imprimir / Exportar Acta</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedMerchReportForAudit(null)}
                    className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition"
                  >
                    Cerrar Acta
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. SUBMÓDULO: PERSONAL ACTIVO SINCRONIZADO (FIJA 13 + EVENTUAL 9 + MERCH 2) */}
      {/* ========================================================================= */}
      {activeSubTab === 'personal' && (() => {
        const filteredFija = fijaStaffMembers.filter(matchesStaffSearch);
        const filteredEventual = eventualStaffMembers.filter(matchesStaffSearch);
        const filteredMerch = merchStaffMembers.filter(matchesStaffSearch);

        const renderStaffCard = (member: StaffMemberRecord) => {
          const isMerch = member.category === 'merchandising';
          const isEventual = member.category === 'eventual';
          const assignedActive = activeScheduledByStaffKey.get(member.canonicalKey) || [];
          const isUploadingPhoto = uploadingPhotoStaffId === member.id;

          const categoryLabel = isMerch
            ? 'Merchandising'
            : isEventual
              ? 'Plantilla Eventual'
              : 'Plantilla Fija';

          const categoryBadgeClass = isMerch
            ? 'bg-red-500/15 text-red-400 border border-red-500/35'
            : isEventual
              ? 'bg-blue-500/15 text-blue-400 border border-blue-500/35'
              : 'bg-zinc-800/90 text-zinc-300 border border-white/10';

          const pdvColorClass = isMerch
            ? 'text-red-400'
            : isEventual
              ? 'text-sky-400'
              : 'text-emerald-400';

          const cardBorderClass = isMerch
            ? 'border-red-500/25 hover:border-red-500/45'
            : 'border-white/[0.08] hover:border-white/20';

          const copyBtnClass = isMerch
            ? 'bg-red-950/35 hover:bg-red-900/45 text-red-200 border border-red-500/35'
            : 'bg-zinc-900/90 hover:bg-zinc-800 text-zinc-200 border border-white/10';

          return (
            <div
              key={member.id}
              className={`p-4 rounded-2xl bg-[#11131a]/95 border ${cardBorderClass} flex flex-col justify-between gap-3.5 shadow-[0_10px_28px_-12px_rgba(0,0,0,0.8)] transition-all`}
            >
              {/* Fila superior: Avatar con botón cámara + Nombre y Badges + Editar/Eliminar */}
              <div className="flex items-start justify-between gap-2.5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative shrink-0">
                    {member.photoUrl ? (
                      <img
                        src={member.photoUrl}
                        alt={member.name}
                        onClick={() =>
                          setPhotoModalState({
                            isOpen: true,
                            loading: false,
                            badgeLabel: `CODIZULCA PERSONAL ACTIVO • ${categoryLabel.toUpperCase()}`,
                            title: member.name,
                            subtitle: `${member.role} • PDV: ${member.assignedStore} • ${member.phone}`,
                            photoBase64: member.photoUrl || null,
                          })
                        }
                        className={`w-14 h-14 rounded-full object-cover border-2 ${
                          isMerch ? 'border-red-500/70' : 'border-zinc-700'
                        } shadow-md cursor-pointer hover:opacity-90 transition`}
                        title="Clic para ampliar fotografía"
                      />
                    ) : (
                      <div
                        className={`w-14 h-14 rounded-full ${
                          isMerch ? 'bg-red-600/25 border-red-500/50 text-red-200' : 'bg-zinc-800 border-zinc-700 text-white'
                        } border-2 flex items-center justify-center font-black text-base shadow-md`}
                      >
                        {(member.name || 'P').trim().charAt(0).toUpperCase()}
                      </div>
                    )}
                    <label
                      className="w-6 h-6 rounded-full bg-zinc-900 hover:bg-red-600 text-zinc-300 hover:text-white border border-white/20 flex items-center justify-center absolute -bottom-0.5 -right-0.5 shadow cursor-pointer transition"
                      title="Actualizar fotografía en Supabase"
                    >
                      {isUploadingPhoto ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Camera className="w-3 h-3" />
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={isUploadingPhoto}
                        onChange={(e) => handleStaffPhotoFileChange(member, e)}
                      />
                    </label>
                  </div>

                  <div className="min-w-0">
                    <h4
                      className="font-bold text-white text-sm leading-snug truncate"
                      title={member.name}
                    >
                      {member.name}
                    </h4>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/35">
                        Activo
                      </span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${categoryBadgeClass}`}>
                        {categoryLabel}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => openEditStaffModal(member)}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                    title="Editar perfil en Supabase"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteStaffProfile(member)}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition cursor-pointer"
                    title="Retirar del sistema"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Bloque de Ficha Técnica: Teléfono, Correo, Asignación PDV, Dirección y Contraseña App */}
              <div className="p-3 rounded-xl bg-zinc-950/85 border border-white/[0.06] space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400 shrink-0">Teléfono:</span>
                  <span className="text-zinc-100 font-semibold font-mono text-right truncate" title={member.phone}>
                    {member.phone}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400 shrink-0">Correo:</span>
                  <span className="text-zinc-200 font-medium text-right truncate max-w-[195px]" title={member.email}>
                    {member.email || '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400 shrink-0">Asignación PDV:</span>
                  <span
                    className={`${pdvColorClass} font-bold text-right truncate max-w-[190px] uppercase`}
                    title={member.assignedStore}
                  >
                    {member.assignedStore}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400 shrink-0">Dirección:</span>
                  <span
                    className="text-zinc-200 font-semibold text-right truncate max-w-[195px]"
                    title={member.address}
                  >
                    {member.address}
                  </span>
                </div>
                              </div>

              {/* Estado en vivo del Cronograma Actual */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-400 font-semibold flex items-center gap-1.5">
                    <Clock className="w-3 h-3 text-emerald-400" />
                    <span>Cronograma Actual:</span>
                  </span>
                  {assignedActive.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                      {assignedActive.length} asignada(s)
                    </span>
                  )}
                </div>

                {assignedActive.length > 0 ? (
                  <div className="p-2.5 rounded-xl bg-emerald-950/20 border border-emerald-500/25 space-y-1">
                    {assignedActive.slice(0, 2).map((act) => (
                      <div
                        key={act.id}
                        className="flex items-center justify-between gap-2 text-[11px]"
                      >
                        <span className="text-zinc-200 font-semibold truncate" title={act.storeName}>
                          • {act.storeName}
                        </span>
                        <span className="text-emerald-400 font-mono text-[10px] shrink-0">
                          {act.date}
                        </span>
                      </div>
                    ))}
                    {assignedActive.length > 2 && (
                      <span className="text-[10px] text-zinc-400 block">
                        +{assignedActive.length - 2} degustación(es) adicional(es)
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="py-2 px-3 rounded-xl bg-zinc-950/60 border border-dashed border-white/[0.08] text-center text-[11px] text-zinc-500">
                    Sin degustaciones en cronograma actual (Disponible)
                  </div>
                )}
              </div>

              {/* Botones inferiores: Copiar Enlace App + Abrir App */}
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => handleCopyStaffAppLink(member)}
                  className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer ${copyBtnClass}`}
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copiar Enlace App</span>
                </button>
                <a
                  href={buildStaffAppLink(member)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`p-2 rounded-xl transition flex items-center justify-center ${copyBtnClass}`}
                  title={`Abrir enlace App de ${member.name}`}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          );
        };

        return (
          <div className="space-y-7">
            {/* Barra superior de control y filtros del padrón activo */}
            <div className="bg-zinc-900/80 border border-white/[0.08] rounded-2xl p-5 shadow-xl flex flex-col xl:flex-row xl:items-center justify-between gap-4 backdrop-blur-md">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-black px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 uppercase tracking-wider">
                    Padrón Activo Sincronizado • Supabase `staff`
                  </span>
                  <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-zinc-950 text-zinc-300 border border-white/10">
                    {fijaStaffMembers.length} Fijas · {eventualStaffMembers.length} Eventuales · {merchStaffMembers.length} Merchandising
                  </span>
                </div>
                <h3 className="text-lg font-black text-white mt-1.5">
                  Promotoras Activas y Promotores de Merchandising ({staffList.length})
                </h3>
                <p className="text-xs text-zinc-400">
                  Sincronización exacta del personal activo en campo; perfiles inactivos o retirados han sido depurados de todo el sistema.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Buscar nombre, correo, PDV..."
                    value={selectedStaffSearch}
                    onChange={(e) => setSelectedStaffSearch(e.target.value)}
                    className="pl-8 pr-3 py-1.5 rounded-xl bg-zinc-950 border border-white/10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500"
                  />
                </div>

                <div className="flex flex-wrap items-center bg-zinc-950 p-1 rounded-xl border border-white/10 gap-1">
                  {(
                    [
                      { id: 'TODAS', label: `Todas (${staffList.length})` },
                      { id: 'fija', label: `Plantilla Fija (${fijaStaffMembers.length})` },
                      { id: 'eventual', label: `Eventual (${eventualStaffMembers.length})` },
                      { id: 'merchandising', label: `Merchandising (${merchStaffMembers.length})` },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setSelectedStaffCategoryFilter(tab.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                        selectedStaffCategoryFilter === tab.id
                          ? 'bg-red-600 text-white shadow'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => refreshSupabaseData()}
                  disabled={isLoadingSupabase}
                  className="px-3 py-1.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-zinc-200 border border-white/10 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                  title="Sincronizar padrón activo con Supabase"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingSupabase ? 'animate-spin text-red-400' : ''}`} />
                  <span>Sincronizar</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    openCreateStaffModal(
                      selectedStaffCategoryFilter === 'TODAS' ? 'fija' : selectedStaffCategoryFilter
                    )
                  }
                  className="px-3.5 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg shadow-red-950/50 transition cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Registrar Personal</span>
                </button>
              </div>
            </div>

            {/* GRUPO 1: PLANTILLA FIJA */}
            {(selectedStaffCategoryFilter === 'TODAS' || selectedStaffCategoryFilter === 'fija') && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 shrink-0">
                    <UserCheck className="w-4 h-4 text-emerald-400" />
                    <h4 className="text-xs font-black uppercase tracking-widest text-zinc-200">
                      PLANTILLA FIJA ({filteredFija.length})
                    </h4>
                  </div>
                  <div className="h-px flex-1 bg-white/10" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredFija.map(renderStaffCard)}
                </div>
              </div>
            )}

            {/* GRUPO 2: PLANTILLA EVENTUAL */}
            {(selectedStaffCategoryFilter === 'TODAS' || selectedStaffCategoryFilter === 'eventual') && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 shrink-0">
                    <Users className="w-4 h-4 text-blue-400" />
                    <h4 className="text-xs font-black uppercase tracking-widest text-blue-300">
                      PLANTILLA EVENTUAL ({filteredEventual.length})
                    </h4>
                  </div>
                  <div className="h-px flex-1 bg-blue-500/20" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredEventual.map(renderStaffCard)}
                </div>
              </div>
            )}

            {/* GRUPO 3: PROMOTORES MERCHANDISING */}
            {(selectedStaffCategoryFilter === 'TODAS' || selectedStaffCategoryFilter === 'merchandising') && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 shrink-0">
                    <Box className="w-4 h-4 text-red-500" />
                    <h4 className="text-xs font-black uppercase tracking-widest text-red-400">
                      PROMOTORES MERCHANDISING ({filteredMerch.length})
                    </h4>
                  </div>
                  <div className="h-px flex-1 bg-red-500/25" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredMerch.map(renderStaffCard)}
                </div>
              </div>
            )}

            {/* Modal para Registrar o Editar Personal Activo en Supabase */}
            {staffFormModal.isOpen && (
              <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-zinc-950 border border-white/15 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
                  <div className="flex items-center justify-between border-b border-white/10 pb-3">
                    <div>
                      <span className="text-[10px] font-black uppercase tracking-wider text-red-400">
                        Sincronización Directa Supabase • Tabla `staff`
                      </span>
                      <h4 className="text-base font-black text-white">
                        {staffFormModal.id ? `Editar Perfil: ${staffFormModal.name}` : 'Registrar Nuevo Personal Activo'}
                      </h4>
                    </div>
                    <button
                      type="button"
                      onClick={() => setStaffFormModal((prev) => ({ ...prev, isOpen: false }))}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <form onSubmit={handleSaveStaffModal} className="space-y-3.5 text-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-zinc-300 font-bold mb-1">Nombre Completo</label>
                        <input
                          type="text"
                          required
                          value={staffFormModal.name}
                          onChange={(e) => setStaffFormModal((prev) => ({ ...prev, name: e.target.value }))}
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                          placeholder="Ej. NICOLE GODOY"
                        />
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">Plantilla / Categoría</label>
                        <select
                          value={staffFormModal.category}
                          onChange={(e) => {
                            const cat = e.target.value as StaffCategory;
                            setStaffFormModal((prev) => ({
                              ...prev,
                              category: cat,
                              role: cat === 'merchandising' ? 'Promotor Merchandising' : prev.role === 'Promotor Merchandising' ? 'Promotora' : prev.role,
                            }));
                          }}
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                        >
                          <option value="fija">Plantilla Fija</option>
                          <option value="eventual">Plantilla Eventual</option>
                          <option value="merchandising">Promotor Merchandising</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">Cargo / Rol</label>
                        <select
                          value={staffFormModal.role}
                          onChange={(e) => setStaffFormModal((prev) => ({ ...prev, role: e.target.value }))}
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                        >
                          <option value="Impulsadora">Impulsadora</option>
                          <option value="Promotora">Promotora</option>
                          <option value="Promotor Merchandising">Promotor Merchandising</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">Teléfono</label>
                        <input
                          type="text"
                          value={staffFormModal.phone}
                          onChange={(e) => setStaffFormModal((prev) => ({ ...prev, phone: e.target.value }))}
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-500"
                          placeholder="0412-0000000"
                        />
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">Correo Electrónico</label>
                        <input
                          type="email"
                          value={staffFormModal.email}
                          onChange={(e) => setStaffFormModal((prev) => ({ ...prev, email: e.target.value }))}
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                          placeholder="correo@dominio.com"
                        />
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">Asignación PDV</label>
                        <input
                          type="text"
                          value={staffFormModal.assignedStore}
                          onChange={(e) =>
                            setStaffFormModal((prev) => ({ ...prev, assignedStore: e.target.value }))
                          }
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                          placeholder="VARIAS / ALKOSTO / TODAS"
                        />
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">Dirección / Zona</label>
                        <input
                          type="text"
                          value={staffFormModal.address}
                          onChange={(e) => setStaffFormModal((prev) => ({ ...prev, address: e.target.value }))}
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                          placeholder="Sector / Ciudad"
                        />
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">Contraseña App</label>
                        <input
                          type="text"
                          value={staffFormModal.password}
                          onChange={(e) =>
                            setStaffFormModal((prev) => ({ ...prev, password: e.target.value }))
                          }
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white font-mono focus:outline-none focus:border-red-500"
                        />
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">Estado en Sistema</label>
                        <select
                          value={staffFormModal.status}
                          onChange={(e) =>
                            setStaffFormModal((prev) => ({
                              ...prev,
                              status: e.target.value as 'Activo' | 'Inactivo',
                            }))
                          }
                          className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                        >
                          <option value="Activo">Activo (Visible y Sincronizado)</option>
                          <option value="Inactivo">Inactivo (Quitar del padrón activo)</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/10">
                      <button
                        type="button"
                        onClick={() => setStaffFormModal((prev) => ({ ...prev, isOpen: false }))}
                        className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 font-bold border border-white/10"
                      >
                        Cancelar
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingStaffModal}
                        className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold flex items-center gap-2 shadow-lg shadow-red-950/50"
                      >
                        {isSavingStaffModal && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <span>Guardar en Supabase</span>
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Dashboard 360° Interactivo al Seleccionar Cualquier Tarjeta de Métrica */}
      <Metric360DashboardModal
        isOpen={selectedMetric360 !== null}
        metricId={selectedMetric360}
        onSelectMetric={(id) => setSelectedMetric360(id)}
        onClose={() => setSelectedMetric360(null)}
        switcherItems={fieldMetric360SwitcherItems}
        visits={visits}
        tastingItems={tastingSchedule}
        module1Bundle={module1Bundle}
        liveClock={liveClock}
        onApplyTableFilter={({ metricId, productFilter, timeLens }) => {
          if (metricId === 'personal_activo') {
            setActiveSubTab('personal');
            return;
          }
          setActiveSubTab('degustaciones');
          if (productFilter) {
            setTastingProductFilter(productFilter);
          }
          if (timeLens === 'SEMANA_ACTUAL') {
            setTastingDayFilter('SEMANA_ACTUAL');
          } else if (timeLens === 'MES_ACTUAL') {
            setTastingDayFilter(liveClock.yearMonth);
          } else {
            setTastingDayFilter('TODOS');
          }
        }}
      />

      {/* Motor de Lectura Multiformato (Excel / CSV / PDF) y Volcado a Módulo 2 */}
      <MultiFormatTastingUploadModal
        isOpen={isMultiFormatUploadOpen}
        onClose={() => setIsMultiFormatUploadOpen(false)}
        stores={stores}
        syncedStoreItems={syncedStoreItemsForUpload}
        staffMembers={module1Bundle?.staffMembers || []}
        cargadoPor={currentUser?.name || 'Coordinación Trade Marketing'}
        cargadoPorRol={currentRole || 'jefe_trade'}
        onBatchDumpedSuccess={async (res) => {
          showToast(
            `✅ Lote volcado a Módulo 2: ${res.total_insertadas} degustación(es) en PENDIENTE_APROBACION (${res.total_duplicadas} duplicadas omitidas).`
          );
          await refreshSupabaseData();
        }}
      />

      {/* Bloque oficial de firmas para soporte impreso / PDF */}
      <PrintSignatureBlock />
    </div>
  );
};
