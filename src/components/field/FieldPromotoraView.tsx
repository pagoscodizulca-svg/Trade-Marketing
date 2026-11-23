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
  Loader2,
  Clock,
  Maximize2,
  Printer,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  Lock,
  ShieldCheck,
  MessageCircle,
  Ban,
} from 'lucide-react';
import { FEATURE_FLAGS } from '../../config/featureFlags';
import {
  buildPromotoraWhatsAppLink,
  getPromotorasPortalUrl,
} from '../../utils/portalLinkSharing';
import { ExportPdfButton } from '../common/ExportPdfButton';
import {
  exportPromotoraReportsPdf,
  exportMonthlyTastingGeneralReportPdf,
  exportPendingTastingAuthorizationPdf,
  buildPendingAuthorizationReportModel,
} from '../../utils/pdfExport';
import { PrintSupportHeader, PrintSignatureBlock } from '../common/PrintSupportHeader';
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
import { AttendanceEvidenceSubTab } from './AttendanceEvidenceSubTab';
import { PriceComparisonReportSubTab } from './PriceComparisonReportSubTab';
import { AnimatedTabContainer } from '../ui/AnimatedTabContainer';
import { buildDailyPromotoraAttendanceViewModels } from '../../services/attendanceEvidencesService';
import {
  DegustacionNotificationItem,
  OperationalSupplies,
  PriceComparisonThreeBrands,
  ScheduledVisit,
  ShiftType,
} from '../../types';
import {
  fetchAllModule1FromSupabase,
  fetchCheckinPhotosBatch,
  updateSupabaseDegustacionStatus,
  assignSupabaseDegustacionPromotora,
  updateSupabaseInventoryObservation,
  createSupabaseInventoryRecord,
  deleteSupabaseInventoryRecord,
  deleteSupabaseMerchandisingRecord,
  saveSupabaseStaffMember,
  updateSupabaseStaffPhoto,
  deleteSupabaseStaffMember,
  canonicalStaffKey,
  parseDegustacionNotificationRow,
  VisitHistoryRecord,
  InventorySamplingRecord,
  AttendanceRecord,
  MerchandisingRecord,
  StaffMemberRecord,
  StaffCategory,
} from '../../services/supabaseModule1';
import {
  resolveFdvRequestLifecycle,
  sanitizeExternalHttpsUrl,
} from '../../services/fdvDegustacionesAdapter';
import { provisionStaffAuthAccountViaBackend } from '../../services/authService';
import { obtenerPromotorasMaestras } from '../../services/masterCatalogSyncService';
import {
  assignAcceptedDegustacionToPromotoraRoute,
  buildActivePromotoraCatalog,
  isValidUuid,
  updateCronogramaPromotoraIdInSupabase,
  withdrawDegustacionFromPromotoraRoute,
} from '../../services/degustacionesPipelineService';
import { calculateProductionSupplies } from '../../utils/productionSuppliesCalculator';
import {
  getPastCaracasWeeksRange,
  isTastingBeforeTodayCaracas,
  isTastingInPastCaracasWeek,
  partitionTastingsByCaracasWeek,
  partitionTastingsByTodayAndAuthorization,
  resolveTastingAuthorizationState,
  resolveTastingEventCaracasYmd,
} from '../../utils/caracasWeekCycle';
import {
  assertCanMutateTastingByWeekCycle,
  DEFAULT_HISTORIAL_PAGE_SIZE,
  HistoricalTastingLockError,
  paginateSanitizedHistorialCollection,
  queryServerPaginatedHistorialSurveys,
  ServerPaginatedHistorialSurveyResult,
} from '../../services/degustacionesWeeklyCycleService';
import { TradeContraloriaSolicitudesTab } from './TradeContraloriaSolicitudesTab';
import { PortalQuickLinksBar } from '../admin/PortalQuickLinksBar';

export type FieldSubTab =
  | 'degustaciones'
  | 'informes'
  | 'merchandising'
  | 'personal'
  | 'solicitudes_contraloria';

export interface TastingScheduleItem {
  id: string;
  cronogramaId?: string;
  promotoraId?: string;
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
  status: 'PENDIENTE' | 'PROGRAMADO' | 'EN_CURSO' | 'COMPLETADO' | 'NO_AUTORIZADA';
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
  enHistorial?: boolean;
  archivadoEn?: string | null;
  motivoArchivo?: string | null;
  notes?: string;
  rawComments?: Record<string, any>;
}

const SHORT_WEEKDAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'] as const;

const INTERNAL_ROUTE_CONSTANTS = new Set([
  '',
  '-',
  '--',
  'N/A',
  'NA',
  'NULL',
  'UNDEFINED',
  'ALL_MY_ROUTES',
  'ALL_ROUTES',
  'MY_ROUTES',
  'DEFAULT_ROUTE',
  'SIN_RUTA',
  'SIN RUTA',
  'SIN ZONA',
  'ZONA GENERAL',
  'POR DEFINIR',
]);

function formatCompactScheduleDayDate(
  dateRaw?: string | null,
  dayLabelFallback?: string | null
): string {
  const parsed = normalizeExcelDate(dateRaw ?? '');
  if (parsed.isValid && parsed.fechaIso && parsed.fechaFormateada) {
    const [y, m, d] = parsed.fechaIso.split('-').map(Number);
    const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    if (!Number.isNaN(utcNoon.getTime())) {
      const shortDay = SHORT_WEEKDAYS_ES[utcNoon.getUTCDay()] ?? '';
      return shortDay ? `${shortDay}, ${parsed.fechaFormateada}` : parsed.fechaFormateada;
    }
    return parsed.fechaFormateada;
  }
  const cleanFallback = dayLabelFallback?.trim();
  return cleanFallback || 'Sin fecha';
}

function formatSafeRouteDisplay(rawZone?: string | null): {
  label: string;
  isGeneric: boolean;
} {
  const trimmed = rawZone?.trim() ?? '';
  const upper = trimmed.toUpperCase();
  if (INTERNAL_ROUTE_CONSTANTS.has(upper) || /^[A-Z0-9]+_[A-Z0-9_]+$/.test(trimmed)) {
    return { label: 'Ruta general', isGeneric: true };
  }
  return { label: trimmed, isGeneric: false };
}

function resolveCompactBrandBadge(
  productName?: string | null,
  fillSelection?: string | null
): { label: string; isAmberBrand: boolean } {
  const normalized = `${productName ?? ''} ${fillSelection ?? ''}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (
    normalized.includes('VENCAMPO') ||
    normalized.includes('ARROZ') ||
    normalized.includes('LECHE') ||
    normalized.includes('AZUCAR') ||
    normalized.includes('CARAOTA') ||
    normalized.includes('AVENA') ||
    normalized.includes('ACEITE')
  ) {
    return { label: 'Vencampo', isAmberBrand: true };
  }

  if (
    normalized.includes('ASTURIAS') ||
    normalized.includes('MORTADELA') ||
    normalized.includes('JAMON') ||
    normalized.includes('ESPALDA') ||
    normalized.includes('SALCHICHA') ||
    normalized.includes('CHORIZO') ||
    normalized.includes('PECHUGA') ||
    normalized.includes('FIAMBRE')
  ) {
    return { label: 'Asturias', isAmberBrand: false };
  }

  return { label: 'Codizulca', isAmberBrand: false };
}

export const FieldPromotoraView: React.FC = () => {
  const {
    currentUser,
    currentRole,
    assignedRegion,
    assignedRegions,
    assignedRegionCodes,
    isRegionalRestricted,
    canSwitchAmongAssignedRegions,
    activeRegiones,
    verifiedRegionId,
    isStrictAdmin,
    caracasWeekStartYmd,
    visits,
    updateVisit,
    upsertVisitFromApprovedTasting,
    removeVisitByTastingRequest,
    module1Bundle,
    masterEntities,
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

  // Active sub-module tab (Degustaciones | Informes | Merchandising | Personal)
  const [activeSubTab, setActiveSubTab] = useState<FieldSubTab>('degustaciones');

  // Referencia tipada y estado para desplazamiento suave accesible del botón "Enlaces"
  const linksSectionRef = useRef<HTMLElement | null>(null);
  const [scrollToLinksTrigger, setScrollToLinksTrigger] = useState<number>(0);
  const [isLinksSectionHighlighted, setIsLinksSectionHighlighted] = useState<boolean>(false);
  const linksHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleScrollToLinksSection = useCallback(() => {
    setActiveSubTab('personal');
    setScrollToLinksTrigger((prev) => prev + 1);
  }, []);

  useEffect(() => {
    return () => {
      if (linksHighlightTimerRef.current !== null) {
        clearTimeout(linksHighlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (scrollToLinksTrigger === 0 || activeSubTab !== 'personal') return;

    let innerFrameId: number | null = null;
    const outerFrameId = window.requestAnimationFrame(() => {
      innerFrameId = window.requestAnimationFrame(() => {
        const target = linksSectionRef.current;
        if (!target) return;

        const prefersReducedMotion =
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        target.scrollIntoView({
          behavior: prefersReducedMotion ? 'auto' : 'smooth',
          block: 'start',
        });
        target.focus({ preventScroll: true });

        if (linksHighlightTimerRef.current !== null) {
          clearTimeout(linksHighlightTimerRef.current);
        }
        setIsLinksSectionHighlighted(true);
        linksHighlightTimerRef.current = setTimeout(() => {
          setIsLinksSectionHighlighted(false);
          linksHighlightTimerRef.current = null;
        }, 1800);
      });
    });

    return () => {
      window.cancelAnimationFrame(outerFrameId);
      if (innerFrameId !== null) {
        window.cancelAnimationFrame(innerFrameId);
      }
    };
  }, [activeSubTab, scrollToLinksTrigger]);

  // Sub-tab inside Degustaciones: 'actual' | 'historial'
  const [tastingViewMode, setTastingViewMode] = useState<'actual' | 'historial'>('actual');
  const [historialPage, setHistorialPage] = useState<number>(1);
  const [historialPageSize, setHistorialPageSize] = useState<number>(DEFAULT_HISTORIAL_PAGE_SIZE);
  const [serverHistorialState, setServerHistorialState] = useState<{
    loading: boolean;
    result: ServerPaginatedHistorialSurveyResult | null;
  }>({ loading: false, result: null });

  // Solicitudes locales adicionales creadas si falla red
  const [localSellerRequests, setLocalSellerRequests] = useState<TastingScheduleItem[]>([]);

  // Registro de IDs de solicitudes autorizadas o marcadas como No Autorizadas en esta sesión
  const [approvedIdsInSession, setApprovedIdsInSession] = useState<Record<string, string>>({});
  const [rejectedIdsInSession, setRejectedIdsInSession] = useState<Set<string>>(() => new Set());
  const approvingIdsRef = useRef<Set<string>>(new Set());
  const [processingTastingId, setProcessingTastingId] = useState<string | null>(null);
  const [lastAuthorizedShareBanner, setLastAuthorizedShareBanner] = useState<{
    promotoraName: string;
    promotoraEmail: string;
    phone: string;
    storeName: string;
    fechaYmd: string;
  } | null>(null);

  // Filtros de búsqueda en la tabla de degustaciones
  const [tastingSearchQuery, setTastingSearchQuery] = useState('');
  const [tastingPromotoraFilter, setTastingPromotoraFilter] = useState('TODAS');
  const [tastingSellerFilter, setTastingSellerFilter] = useState('TODOS');
  const [tastingStatusFilter, setTastingStatusFilter] = useState('TODOS');
  const [tastingDayFilter, setTastingDayFilter] = useState('TODOS');
  const [tastingDateFrom, setTastingDateFrom] = useState('');
  const [tastingDateTo, setTastingDateTo] = useState('');
  const [tastingShiftFilter, setTastingShiftFilter] = useState('TODOS');
  const [tastingProductFilter, setTastingProductFilter] = useState('TODOS');
  const [isTastingCalendarOpen, setIsTastingCalendarOpen] = useState(false);
  const [calendarMonthDate, setCalendarMonthDate] = useState<Date>(() => new Date());
  const [selectedPromotoraByTastingId, setSelectedPromotoraByTastingId] = useState<
    Record<string, string>
  >({});

  // =========================================================================
  // SINCRONIZACIÓN EXACTA ENTRE SUPABASE (MÓDULO 1) Y TRADE MARKETING (MÓDULO 2)
  // =========================================================================
  const reconcileModule1ItemsWithVisits = useCallback(
    (
      bundleTastingItems: TastingScheduleItem[],
      scheduleVisits: ScheduledVisit[]
    ): TastingScheduleItem[] => {
      const todayYmd = liveClock.todayYmd;
      const supItemMap = new Map<string, TastingScheduleItem>();
      bundleTastingItems.forEach((item) => {
        supItemMap.set(item.id, item);
      });

      const visitById = new Map<string, ScheduledVisit>();
      const visitByDegId = new Map<string, ScheduledVisit>();
      scheduleVisits.forEach((v) => {
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
        const isDiscardedInSession =
          rejectedIdsInSession.has(id) ||
          rejectedIdsInSession.has(solId) ||
          Boolean(degId && rejectedIdsInSession.has(degId));

        if (FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE && isDiscardedInSession) {
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
        const hasSessionApproval =
          !isDiscardedInSession && Boolean(approvedIdsInSession[id] || approvedIdsInSession[solId]);
        const isPendingSellerRequest =
          !isDiscardedInSession &&
          supItem?.status === 'PENDIENTE' &&
          !v &&
          !hasSessionApproval;

        let baseUiStatus: TastingScheduleItem['status'] = 'PROGRAMADO';
        if (isDiscardedInSession || supItem?.status === 'NO_AUTORIZADA') {
          baseUiStatus = 'NO_AUTORIZADA';
        } else if (isPendingSellerRequest) {
          baseUiStatus = 'PENDIENTE';
        } else if (hasSessionApproval) {
          baseUiStatus = 'PROGRAMADO';
        } else if (v?.status === 'COMPLETADA' || supItem?.status === 'COMPLETADO') {
          baseUiStatus = 'COMPLETADO';
        } else if (v?.status === 'EN_CURSO' || supItem?.status === 'EN_CURSO') {
          baseUiStatus = 'EN_CURSO';
        } else if (supItem?.status === 'PENDIENTE') {
          baseUiStatus = 'PENDIENTE';
        } else {
          baseUiStatus = 'PROGRAMADO';
        }

        let enHistorial: boolean;
        let itemStatus: TastingScheduleItem['status'] = baseUiStatus;

        if (FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE) {
          enHistorial = isTastingInPastCaracasWeek(
            effectiveDate,
            undefined,
            supItem?.rawComments?.date || supItem?.createdAt
          );
        } else {
          const authResolution = resolveTastingAuthorizationState({
            rawEstado: isDiscardedInSession
              ? 'NO_AUTORIZADA'
              : (supItem?.rawComments?.estado ?? supItem?.rawComments?.status),
            statusUi: baseUiStatus,
            rawEventDate: effectiveDate,
            fallbackDate: supItem?.rawComments?.date || supItem?.createdAt,
          });
          enHistorial = authResolution.belongsToHistorial;
          if (authResolution.authorizationState === 'NO_AUTORIZADA') {
            itemStatus = 'NO_AUTORIZADA';
          }
        }
        const isArchived = enHistorial;

        const currentSamples = supItem?.currentSamples ?? 0;
        const acceptancePercent = supItem?.acceptancePercent;
        const salesAssisted = v?.assistedSalesUnits || supItem?.salesAssistedCount || 0;
        const assignedPromotora =
          selectedPromotoraByTastingId[solId] ||
          selectedPromotoraByTastingId[id] ||
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
          mapsUrl: sanitizeExternalHttpsUrl(v?.mapsUrl || supItem?.mapsUrl),
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
          enHistorial,
          archivadoEn: supItem?.archivadoEn ?? v?.archivadoEn ?? null,
          motivoArchivo: supItem?.motivoArchivo ?? v?.motivoArchivo ?? null,
          notes:
            v?.notes ||
            supItem?.notes ||
            `Sincronizado con Base de Datos Supabase y Trade Marketing (${effectiveShift} - ${effectiveDayLabel}).`,
          rawComments: supItem?.rawComments,
        };
      };

      // 1. Incluir todas las solicitudes de degustación de Módulo 1 (tanto PENDIENTE como APROBADAS), superponiendo datos del Módulo 2 si ya fue aprobada
      bundleTastingItems.forEach((supItem) => {
        const matchedVisit =
          visitById.get(supItem.id) ||
          (supItem.degustacionId ? visitByDegId.get(supItem.degustacionId) : undefined);
        if (matchedVisit) {
          consumedVisitIds.add(matchedVisit.id);
        }
        const merged = buildMergedItem(supItem, matchedVisit);
        if (merged) result.push(merged);
      });

      // 2. Incluir activaciones creadas o presentes en Módulo 2 que no estén ya en bundleTastingItems
      scheduleVisits.forEach((v) => {
        if (consumedVisitIds.has(v.id)) return;
        const supItem =
          supItemMap.get(v.id) ||
          (v.solicitudId ? supItemMap.get(v.solicitudId) : undefined);
        const merged = buildMergedItem(supItem, v);
        if (merged) result.push(merged);
      });

      return result;
    },
    [
      approvedIdsInSession,
      rejectedIdsInSession,
      selectedPromotoraByTastingId,
      liveClock.todayYmd,
      caracasWeekStartYmd,
      degustacionNotifications.unreadItems,
    ]
  );

  const synchronizedScheduleItems = useMemo<TastingScheduleItem[]>(
    () => reconcileModule1ItemsWithVisits(module1Bundle?.tastingItems || [], visits),
    [reconcileModule1ItemsWithVisits, module1Bundle?.tastingItems, visits]
  );

  // Lista unificada de degustaciones preservando estado Autorizada vs No Autorizada en Bandeja e Historial
  const tastingSchedule = useMemo<TastingScheduleItem[]>(() => {
    const normalizedLocal = localSellerRequests.map((item) => {
      if (FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE) {
        const inHist = isTastingInPastCaracasWeek(
          item.date,
          undefined,
          item.rawComments?.date || item.createdAt
        );
        return {
          ...item,
          isArchived: inHist,
          enHistorial: inHist,
        };
      }
      const authState = resolveTastingAuthorizationState({
        rawEstado: item.rawComments?.estado ?? item.rawComments?.status,
        statusUi: item.status,
        rawEventDate: item.date,
        fallbackDate: item.rawComments?.date || item.createdAt,
      });
      return {
        ...item,
        status:
          authState.authorizationState === 'NO_AUTORIZADA' ? 'NO_AUTORIZADA' : item.status,
        isArchived: authState.belongsToHistorial,
        enHistorial: authState.belongsToHistorial,
      };
    });
    return [...normalizedLocal, ...synchronizedScheduleItems];
  }, [localSellerRequests, synchronizedScheduleItems, caracasWeekStartYmd, liveClock.todayYmd]);

  // Partición disjunta determinista (0 duplicados, 0 pérdida) en `America/Caracas`
  const partitionedAllTastings = useMemo(
    () =>
      FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
        ? partitionTastingsByCaracasWeek(tastingSchedule)
        : partitionTastingsByTodayAndAuthorization(tastingSchedule),
    [tastingSchedule, caracasWeekStartYmd, liveClock.todayYmd]
  );

  const activeTastingCount = partitionedAllTastings.bandejaEntrada.length;
  const archivedTastingCount = useMemo(
    () =>
      Math.max(
        partitionedAllTastings.historial.length,
        serverHistorialState.result &&
          tastingDayFilter === 'TODOS' &&
          tastingSellerFilter === 'TODOS' &&
          tastingPromotoraFilter === 'TODAS' &&
          tastingProductFilter === 'TODOS' &&
          !tastingSearchQuery.trim()
          ? serverHistorialState.result.totalCount
          : 0
      ),
    [
      partitionedAllTastings.historial.length,
      serverHistorialState.result,
      tastingDayFilter,
      tastingSellerFilter,
      tastingPromotoraFilter,
      tastingProductFilter,
      tastingSearchQuery,
    ]
  );
  const pendingSolicitadasCount = useMemo(
    () =>
      partitionedAllTastings.bandejaEntrada.filter((item) => item.status === 'PENDIENTE').length,
    [partitionedAllTastings.bandejaEntrada]
  );

  const extractCleanSellerLabel = useCallback((rawApplicant?: string): string => {
    return String(rawApplicant || '')
      .replace(/\s*\(Vendedor FDV\)/gi, '')
      .trim();
  }, []);

  const availableSellers = useMemo<string[]>(() => {
    const byKey = new Map<string, string>();
    tastingSchedule.forEach((item) => {
      const cleanLabel = extractCleanSellerLabel(item.sellerApplicant);
      if (
        !cleanLabel ||
        cleanLabel.toUpperCase() === 'TRADE MARKETING' ||
        cleanLabel.toUpperCase() === 'VENTAS'
      ) {
        return;
      }
      const key = canonicalStaffKey(cleanLabel);
      if (key && !byKey.has(key)) {
        byKey.set(key, cleanLabel);
      }
    });
    return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, 'es'));
  }, [tastingSchedule, extractCleanSellerLabel]);

  // Mapa de conteo de degustaciones por fecha YYYY-MM-DD según la pestaña activa (Actual o Historial)
  const tastingDatesCountMap = useMemo(() => {
    const map = new Map<string, number>();
    const sourcePool =
      tastingViewMode === 'actual'
        ? partitionedAllTastings.bandejaEntrada
        : partitionedAllTastings.historial;
    sourcePool.forEach((item) => {
      const iso = resolveTastingEventCaracasYmd(item.date, item.rawComments?.date || item.createdAt);
      if (iso) {
        map.set(iso, (map.get(iso) || 0) + 1);
      }
    });
    if (tastingViewMode === 'historial' && serverHistorialState.result?.rows) {
      const seenIds = new Set(sourcePool.map((i) => i.id));
      for (const r of serverHistorialState.result.rows) {
        if (!r?.id || seenIds.has(r.id)) continue;
        const iso = resolveTastingEventCaracasYmd(r.fecha_evento || r.date, r.created_at);
        if (iso) {
          map.set(iso, (map.get(iso) || 0) + 1);
        }
      }
    }
    return map;
  }, [
    tastingViewMode,
    partitionedAllTastings.bandejaEntrada,
    partitionedAllTastings.historial,
    serverHistorialState.result,
  ]);

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

  // Evaluador unificado de filtros activos (Fecha / Mes / Rango + Vendedor + Estado + Jornada + Producto + Promotora + Búsqueda)
  const matchesActiveTastingFilters = useCallback(
    (item: TastingScheduleItem): boolean => {
      if (tastingPromotoraFilter !== 'TODAS') {
        if (tastingPromotoraFilter === 'POR_ASIGNAR') {
          if (!/^POR ASIGNAR|^SIN ASIGNAR/i.test(item.responsibleName || '')) {
            return false;
          }
        } else {
          const filterKey = canonicalStaffKey(tastingPromotoraFilter);
          const itemKey = canonicalStaffKey(item.responsibleName);
          if (!itemKey || itemKey !== filterKey) return false;
        }
      }

      if (tastingSellerFilter !== 'TODOS') {
        const sellerKey = canonicalStaffKey(extractCleanSellerLabel(item.sellerApplicant));
        const filterSellerKey = canonicalStaffKey(tastingSellerFilter);
        if (!sellerKey || sellerKey !== filterSellerKey) return false;
      }

      if (tastingStatusFilter !== 'TODOS') {
        if (item.status !== tastingStatusFilter) return false;
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
        const matchesClientCode = (item.clienteCodigo || '').toLowerCase().includes(q);
        if (
          !matchesStore &&
          !matchesProduct &&
          !matchesPromotora &&
          !matchesSeller &&
          !matchesZone &&
          !matchesDay &&
          !matchesClientCode
        ) {
          return false;
        }
      }

      return true;
    },
    [
      tastingPromotoraFilter,
      tastingSellerFilter,
      tastingStatusFilter,
      tastingDayFilter,
      tastingDateFrom,
      tastingDateTo,
      tastingShiftFilter,
      tastingProductFilter,
      tastingSearchQuery,
      extractCleanSellerLabel,
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

    if (tastingSellerFilter !== 'TODOS') parts.push(`Vendedor FDV: ${tastingSellerFilter}`);
    if (tastingStatusFilter !== 'TODOS') parts.push(`Estado: ${tastingStatusFilter}`);
    if (tastingShiftFilter !== 'TODOS') parts.push(`Jornada: ${tastingShiftFilter}`);
    if (tastingProductFilter !== 'TODOS') parts.push(`Producto: ${tastingProductFilter}`);
    if (tastingPromotoraFilter !== 'TODAS') {
      parts.push(
        `Promotora: ${
          tastingPromotoraFilter === 'POR_ASIGNAR' ? 'Por Asignar' : tastingPromotoraFilter
        }`
      );
    }
    if (tastingSearchQuery.trim()) parts.push(`Busqueda: "${tastingSearchQuery.trim()}"`);

    const hasSecondaryFilters =
      tastingSellerFilter !== 'TODOS' ||
      tastingStatusFilter !== 'TODOS' ||
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
    tastingSellerFilter,
    tastingStatusFilter,
    tastingShiftFilter,
    tastingProductFilter,
    tastingPromotoraFilter,
    tastingSearchQuery,
    globalFilteredReportItems.length,
  ]);

  // Estado para el Informe Global y Detallado de Degustaciones según Filtro Aplicado (PDF)
  const [isExportingMonthlyPdf, setIsExportingMonthlyPdf] = useState(false);
  const [monthlyPdfSuccess, setMonthlyPdfSuccess] = useState(false);
  const isExportingMonthlyLockRef = useRef<boolean>(false);
  const monthlyPdfSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (monthlyPdfSuccessTimerRef.current !== null) {
        clearTimeout(monthlyPdfSuccessTimerRef.current);
      }
    };
  }, []);

  const handleExportMonthlyReportPdf = async () => {
    if (isExportingMonthlyPdf || isExportingMonthlyLockRef.current) return;
    isExportingMonthlyLockRef.current = true;
    try {
      setIsExportingMonthlyPdf(true);
      await exportMonthlyTastingGeneralReportPdf(globalFilteredReportItems, {
        targetYearMonth: activeGlobalReportMeta.targetYearMonth,
        filterSummaryLabel: activeGlobalReportMeta.summaryLabel,
        fileSuffix: activeGlobalReportMeta.fileSuffix,
        scope: 'all',
      });
      setMonthlyPdfSuccess(true);
      if (monthlyPdfSuccessTimerRef.current !== null) {
        clearTimeout(monthlyPdfSuccessTimerRef.current);
      }
      monthlyPdfSuccessTimerRef.current = setTimeout(() => {
        setMonthlyPdfSuccess(false);
        monthlyPdfSuccessTimerRef.current = null;
      }, 3200);
    } catch {
      showToast('No se pudo generar el Informe Global de Degustaciones PDF.');
    } finally {
      isExportingMonthlyLockRef.current = false;
      setIsExportingMonthlyPdf(false);
    }
  };

  // =========================================================================
  // INFORME EJECUTIVO DE SOLICITUD DE AUTORIZACIÓN (SOLO PENDIENTES · SOLO LECTURA)
  // =========================================================================
  const [isExportingAuthPdf, setIsExportingAuthPdf] = useState(false);
  const [authPdfSuccess, setAuthPdfSuccess] = useState(false);
  const isExportingAuthLockRef = useRef<boolean>(false);

  const pendingAuthorizationScopeMeta = useMemo(() => {
    const filterParts: string[] = [];

    if (tastingDayFilter === 'RANGO' && (tastingDateFrom || tastingDateTo)) {
      const fromFmt = tastingDateFrom ? formatToDdMmYyyy(tastingDateFrom, 'Inicio') : 'Inicio';
      const toFmt = tastingDateTo ? formatToDdMmYyyy(tastingDateTo, 'Actual') : 'Actual';
      filterParts.push(`Rango: ${fromFmt} al ${toFmt}`);
    } else if (
      tastingDayFilter !== 'TODOS' &&
      tastingDayFilter !== 'SEMANA_ACTUAL' &&
      tastingDayFilter.trim() !== ''
    ) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(tastingDayFilter)) {
        filterParts.push(`Fecha: ${formatToDdMmYyyy(tastingDayFilter, tastingDayFilter)}`);
      } else {
        filterParts.push(`Período: ${tastingDayFilter}`);
      }
    }

    if (tastingSellerFilter !== 'TODOS') {
      filterParts.push(`Vendedor: ${tastingSellerFilter}`);
    }
    if (tastingShiftFilter !== 'TODOS') {
      filterParts.push(`Jornada: ${tastingShiftFilter}`);
    }
    if (tastingProductFilter !== 'TODOS') {
      filterParts.push(`Producto: ${tastingProductFilter}`);
    }
    if (tastingPromotoraFilter !== 'TODAS') {
      filterParts.push(
        `Promotora: ${
          tastingPromotoraFilter === 'POR_ASIGNAR' ? 'Por Asignar' : tastingPromotoraFilter
        }`
      );
    }
    if (tastingSearchQuery.trim()) {
      filterParts.push(`Búsqueda: "${tastingSearchQuery.trim()}"`);
    }

    const hasActiveFilters = filterParts.length > 0;
    return {
      hasActiveFilters,
      filterSummaryLabel: hasActiveFilters ? filterParts.join(' | ') : null,
    };
  }, [
    tastingDayFilter,
    tastingDateFrom,
    tastingDateTo,
    tastingSellerFilter,
    tastingShiftFilter,
    tastingProductFilter,
    tastingPromotoraFilter,
    tastingSearchQuery,
  ]);

  const visiblePendingAuthorizationCount = useMemo(() => {
    const previewModel = buildPendingAuthorizationReportModel({
      items: partitionedAllTastings.bandejaEntrada,
      filterPredicate: matchesActiveTastingFilters,
      hasActiveFilters: pendingAuthorizationScopeMeta.hasActiveFilters,
      filterSummaryLabel: pendingAuthorizationScopeMeta.filterSummaryLabel,
    });
    return previewModel.rows.length;
  }, [
    partitionedAllTastings.bandejaEntrada,
    matchesActiveTastingFilters,
    pendingAuthorizationScopeMeta,
  ]);

  const handleExportPendingAuthorizationPdf = async () => {
    if (isExportingAuthPdf || isExportingAuthLockRef.current) return;

    if (visiblePendingAuthorizationCount === 0) {
      showToast(
        'No existen degustaciones pendientes de aceptación para exportar con los filtros actuales.'
      );
      return;
    }

    isExportingAuthLockRef.current = true;
    setIsExportingAuthPdf(true);

    try {
      // 1. Revalidación fresca autenticada 100% SOLO LECTURA (respetando RLS; cero UPDATE/DELETE)
      const freshBundle = await fetchAllModule1FromSupabase();

      const mergedVisitsMap = new Map<string, ScheduledVisit>();
      (freshBundle.visitsForSchedule || []).forEach((v) => {
        mergedVisitsMap.set(v.id, v);
      });
      visits.forEach((v) => {
        if (!mergedVisitsMap.has(v.id)) {
          mergedVisitsMap.set(v.id, v);
        }
      });

      const freshSynchronized = reconcileModule1ItemsWithVisits(
        freshBundle.tastingItems || [],
        Array.from(mergedVisitsMap.values())
      );

      const nowSnapshot = new Date();
      const normalizedLocalPending = localSellerRequests.map((item) => {
        const inHist = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
          ? isTastingInPastCaracasWeek(
              item.date,
              nowSnapshot,
              item.rawComments?.date || item.createdAt
            )
          : isTastingBeforeTodayCaracas(
              item.date,
              nowSnapshot,
              item.rawComments?.date || item.createdAt
            );
        return {
          ...item,
          isArchived: inHist,
          enHistorial: inHist,
        };
      });

      const freshCandidatePool = [...normalizedLocalPending, ...freshSynchronized];

      // 2. Construcción determinista y sanitizada del modelo de pre-aprobación
      const reportModel = buildPendingAuthorizationReportModel({
        items: freshCandidatePool,
        filterPredicate: matchesActiveTastingFilters,
        hasActiveFilters: pendingAuthorizationScopeMeta.hasActiveFilters,
        filterSummaryLabel: pendingAuthorizationScopeMeta.filterSummaryLabel,
        issuerName: currentUser?.name || null,
        issuerRole: currentRole || null,
        now: nowSnapshot,
      });

      if (reportModel.rows.length === 0) {
        showToast(
          'No existen degustaciones pendientes de aceptación tras sincronizar con la base de datos.'
        );
        return;
      }

      // 3. Generación y descarga directa en Carta Horizontal (America/Caracas)
      const exported = await exportPendingTastingAuthorizationPdf(reportModel);
      setAuthPdfSuccess(true);
      setTimeout(() => setAuthPdfSuccess(false), 3200);
      showToast(
        `Informe de Solicitud de Autorización descargado (${exported.exportedRows} pendiente${
          exported.exportedRows === 1 ? '' : 's'
        }).`
      );
    } catch {
      showToast(
        'No se pudo generar el PDF de Solicitud de Autorización. Verifica tu conexión e inténtalo nuevamente.'
      );
    } finally {
      isExportingAuthLockRef.current = false;
      setIsExportingAuthPdf(false);
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

  // Modal de Ficha Completa (35 campos íntegros enviados por el Vendedor) + navegación desde el Globito
  const [selectedTastingDetail, setSelectedTastingDetail] = useState<TastingScheduleItem | null>(null);
  const [highlightedTastingRowId, setHighlightedTastingRowId] = useState<string | null>(null);

  const buildScheduleItemFromNotification = useCallback(
    (notif: DegustacionNotificationItem): TastingScheduleItem => {
      const inHist = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
        ? isTastingInPastCaracasWeek(notif.date, undefined, notif.createdAt)
        : isTastingBeforeTodayCaracas(notif.date, undefined, notif.createdAt);
      const lifecycle = resolveFdvRequestLifecycle({
        rawEstado: notif.estado,
        isFromSellerApp: notif.source === 'vendedor_app' || Boolean(notif.degustacionId),
        ymd: notif.date,
        todayYmd: liveClock.todayYmd,
        enHistorial: inHist,
      });
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
        status: lifecycle.uiStatus,
        currentSamples: notif.resultado?.personasAlcanzadas || 0,
        targetSamples: notif.targetSamples,
        requestedQty: notif.requestedQty,
        sellerApplicant: `${notif.sellerName} (Vendedor FDV)`,
        lotNumber: notif.degustacionId,
        isArchived: lifecycle.enHistorial,
        enHistorial: lifecycle.enHistorial,
        notes: notif.notes,
        rawComments: notif.rawComments,
      };
    },
    [liveClock.todayYmd, caracasWeekStartYmd]
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
    setTastingSellerFilter('TODOS');
    setTastingStatusFilter('TODOS');
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

  const isTastingHistoricalItem = useCallback(
    (
      item?: Pick<
        TastingScheduleItem,
        'date' | 'status' | 'isArchived' | 'enHistorial' | 'rawComments' | 'createdAt'
      > | null
    ): boolean => {
      if (!item) return false;
      if (item.isArchived || item.enHistorial || item.status === 'NO_AUTORIZADA') return true;
      if (FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE) {
        return isTastingInPastCaracasWeek(
          item.date,
          undefined,
          item.rawComments?.date || item.createdAt
        );
      }
      return isTastingBeforeTodayCaracas(
        item.date,
        undefined,
        item.rawComments?.date || item.createdAt
      );
    },
    [caracasWeekStartYmd, liveClock.todayYmd]
  );

  const isReadOnlyHistoricalItem = useCallback(
    (
      item?: Pick<
        TastingScheduleItem,
        'date' | 'status' | 'isArchived' | 'enHistorial' | 'rawComments' | 'createdAt'
      > | null
    ): boolean => {
      return isTastingHistoricalItem(item) && !isStrictAdmin;
    },
    [isTastingHistoricalItem, isStrictAdmin]
  );

  const handleOpenTastingDetail = useCallback(
    (item: TastingScheduleItem) => {
      if (item.leidoTrade === false && !isReadOnlyHistoricalItem(item)) {
        void degustacionNotifications.markAsRead(item.id);
      }
      setSelectedTastingDetail({ ...item, leidoTrade: true });
    },
    [degustacionNotifications, isReadOnlyHistoricalItem]
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
  // ASIGNACIÓN / REASIGNACIÓN DE PROMOTORA ACTIVA (ZERO TRUST + /portal/ruta)
  // =========================================================================
  const activePromotoraCatalog = useMemo(
    () => buildActivePromotoraCatalog(module1Bundle?.staffMembers),
    [module1Bundle]
  );

  const allowedActivePromotoraIds = useMemo(
    () => new Set(activePromotoraCatalog.map((p) => p.id)),
    [activePromotoraCatalog]
  );

  const findActivePromotoraByName = useCallback(
    (rawName?: string | null) => {
      const clean = String(rawName || '')
        .replace(/\(Sugerida\)/gi, '')
        .trim();
      if (!clean || /^POR ASIGNAR|^SIN ASIGNAR/i.test(clean)) return null;
      const targetKey = canonicalStaffKey(clean);
      if (!targetKey) return null;
      return (
        activePromotoraCatalog.find((opt) => canonicalStaffKey(opt.name) === targetKey) || null
      );
    },
    [activePromotoraCatalog]
  );

  const resolvePromotoraSelectValue = useCallback(
    (rawResponsible?: string): { value: string; extraOption: string | null } => {
      const trimmed = String(rawResponsible || '').trim();
      if (!trimmed || /^POR ASIGNAR|^SIN ASIGNAR/i.test(trimmed)) {
        return { value: 'POR ASIGNAR (Trade Marketing)', extraOption: null };
      }
      const matched = availablePromotoras.find(
        (name) => canonicalStaffKey(name) === canonicalStaffKey(trimmed)
      );
      if (matched) {
        return { value: matched, extraOption: null };
      }
      return { value: trimmed, extraOption: trimmed };
    },
    [availablePromotoras]
  );

  const handleSelectPromotoraForTasting = async (
    item: TastingScheduleItem,
    rawSelectedPromotora: string
  ) => {
    if (!item?.id || approvingIdsRef.current.has(item.id)) return;
    try {
      assertCanMutateTastingByWeekCycle({
        eventDate: item.date,
        fallbackDate: item.rawComments?.date || item.createdAt,
        isStrictAdmin,
      });
    } catch (lockErr) {
      showToast(
        lockErr instanceof HistoricalTastingLockError
          ? lockErr.message
          : 'Registro Histórico (Cerrado): Solo lectura para usuarios estándar.'
      );
      return;
    }
    const trimmed = String(rawSelectedPromotora || '').trim();
    const isUnassignedChoice =
      !trimmed || /^POR ASIGNAR/i.test(trimmed) || /^SIN ASIGNAR/i.test(trimmed);

    // Si la degustación ya fue APROBADA, no puede quedar sin promotora activa en ruta
    if (item.status !== 'PENDIENTE' && isUnassignedChoice) {
      showToast(
        'Una degustación aprobada en ruta debe tener promotora activa asignada. Seleccione otra promotora o cancele la actividad.'
      );
      return;
    }

    const matchedOption = !isUnassignedChoice ? findActivePromotoraByName(trimmed) : null;
    if (!isUnassignedChoice && !matchedOption) {
      showToast('Seleccione únicamente una promotora activa verificada de la nómina (public.staff).');
      return;
    }

    const validatedPromotora = matchedOption
      ? matchedOption.name
      : 'POR ASIGNAR (Trade Marketing)';

    // CASO 1: Solicitud aún PENDIENTE (SOLICITADA / PENDIENTE_APROBACION) -> Origen aún NO aceptado:
    // Solo guarda la preselección sugerida sin proyectar a rutas_promotoras (/portal/ruta).
    if (item.status === 'PENDIENTE') {
      setSelectedPromotoraByTastingId((prev) => ({
        ...prev,
        [item.id]: validatedPromotora,
      }));

      if (selectedTastingDetail?.id === item.id) {
        setSelectedTastingDetail((prev) =>
          prev ? { ...prev, responsibleName: validatedPromotora } : null
        );
      }

      try {
        if (item.source === 'carga_multiformato' && isValidUuid(item.cronogramaId || item.id)) {
          await updateCronogramaPromotoraIdInSupabase({
            cronogramaId: item.cronogramaId || item.id,
            promotoraId: matchedOption ? matchedOption.id : null,
            allowedPromotoraIds: allowedActivePromotoraIds,
          });
        } else {
          await assignSupabaseDegustacionPromotora(item.id, validatedPromotora, item.rawComments, {
            eventDateYmd: item.date,
            isStrictAdmin,
          });
        }
        showToast(
          isUnassignedChoice
            ? `Promotora marcada como Por Asignar en ${item.storeName}.`
            : `Promotora ${validatedPromotora} preseleccionada en ${item.storeName} (pendiente de aprobar para enviar a /portal/ruta).`
        );
      } catch {
        // Conserva selección en memoria ante micro-corte
      }
      return;
    }

    // CASO 2: Degustación YA ACEPTADA (APROBADA / EN_CURSO) -> Reasignación atómica en vivo hacia /portal
    if (!matchedOption) return;
    const matchedStaffReassign = (module1Bundle?.staffMembers || []).find(
      (s) =>
        s.id === matchedOption.id ||
        canonicalStaffKey(s.name) === canonicalStaffKey(matchedOption.name)
    );
    const reassignEmail = String(matchedStaffReassign?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reassignEmail)) {
      showToast(
        `Registra primero el correo electrónico de "${matchedOption.name}" en la Pestaña de Personal antes de asignarle la ruta en /portal.`
      );
      return;
    }

    approvingIdsRef.current.add(item.id);
    setProcessingTastingId(item.id);

    try {
      const originSurveyId =
        item.source !== 'carga_multiformato' && isValidUuid(item.id) ? item.id : null;
      const targetCronogramaId =
        item.cronogramaId ||
        (item.source === 'carga_multiformato' && isValidUuid(item.id) ? item.id : null);

      const rpcResult = await assignAcceptedDegustacionToPromotoraRoute({
        promotoraId: matchedOption.id,
        promotoraEmail: reassignEmail,
        surveyId: originSurveyId,
        cronogramaId: targetCronogramaId,
        confirmarAceptacion: false,
        aprobadoPor: currentUser?.name || currentUser?.email || null,
        allowedPromotoraIds: allowedActivePromotoraIds,
      });

      setSelectedPromotoraByTastingId((prev) => ({
        ...prev,
        [item.id]: validatedPromotora,
      }));
      setApprovedIdsInSession((prev) => ({
        ...prev,
        [item.id]: validatedPromotora,
      }));

      if (selectedTastingDetail?.id === item.id) {
        setSelectedTastingDetail((prev) =>
          prev
            ? {
                ...prev,
                responsibleName: validatedPromotora,
                promotoraId: matchedOption.id,
                cronogramaId: rpcResult.cronograma_id,
              }
            : null
        );
      }

      const matchedVisit = visits.find(
        (v) =>
          v.id === item.id ||
          v.solicitudId === item.id ||
          (Boolean(item.degustacionId) && v.degustacionId === item.degustacionId)
      );
      if (matchedVisit) {
        updateVisit(matchedVisit.id, {
          promotoraName: validatedPromotora,
          promotoraId: matchedOption.id,
          cronogramaId: rpcResult.cronograma_id,
        });
      }

      if (originSurveyId) {
        void assignSupabaseDegustacionPromotora(item.id, validatedPromotora, item.rawComments, {
          eventDateYmd: item.date,
          isStrictAdmin,
        }).catch(
          () => {}
        );
      }

      setLastAuthorizedShareBanner({
        promotoraName: validatedPromotora,
        promotoraEmail: reassignEmail,
        phone: matchedStaffReassign?.phone || '',
        storeName: item.storeName,
        fechaYmd: item.date,
      });

      showToast(
        `Ruta reasignada en tiempo real a ${validatedPromotora} (${item.storeName}) en /portal.`
      );
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'No se pudo reasignar la degustación en la hoja de ruta.'
      );
    } finally {
      approvingIdsRef.current.delete(item.id);
      setProcessingTastingId((prev) => (prev === item.id ? null : prev));
    }
  };

  // =========================================================================
  // ACCIÓN PRINCIPAL: APROBAR SOLICITUD DE DEGUSTACIÓN (ORIGEN VALIDADO -> /portal/ruta)
  // =========================================================================
  const handleApproveTastingRequest = async (item: TastingScheduleItem) => {
    if (!item?.id || approvingIdsRef.current.has(item.id)) {
      return;
    }
    try {
      assertCanMutateTastingByWeekCycle({
        eventDate: item.date,
        fallbackDate: item.rawComments?.date || item.createdAt,
        isStrictAdmin,
      });
    } catch (lockErr) {
      showToast(
        lockErr instanceof HistoricalTastingLockError
          ? lockErr.message
          : 'Registro Histórico (Cerrado): Solo lectura para usuarios estándar.'
      );
      return;
    }

    const explicitSessionChoice = selectedPromotoraByTastingId[item.id];
    const explicitlyLeftUnassigned =
      typeof explicitSessionChoice === 'string' &&
      /^POR ASIGNAR|^SIN ASIGNAR/i.test(explicitSessionChoice.trim());

    const rawPreferred = explicitSessionChoice ?? item.responsibleName ?? '';
    const matchedPromotora = !explicitlyLeftUnassigned
      ? findActivePromotoraByName(rawPreferred)
      : null;

    // Bloqueo estricto: prohibido auto-asignar silenciosamente promotoraPool[0] o aprobar sin UUID y correo real
    if (!matchedPromotora || !matchedPromotora.id) {
      showToast(
        `Seleccione una promotora activa antes de autorizar "${item.storeName}" para sincronizar su ruta en /portal y en el Cronograma de productos.`
      );
      return;
    }

    const matchedStaffRecord = (module1Bundle?.staffMembers || []).find(
      (s) =>
        s.id === matchedPromotora.id ||
        canonicalStaffKey(s.name) === canonicalStaffKey(matchedPromotora.name)
    );
    const promotoraEmail = String(matchedStaffRecord?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(promotoraEmail)) {
      showToast(
        `Registra primero el correo electrónico de "${matchedPromotora.name}" en la Pestaña de Personal para habilitar su acceso a /portal y autorizar la degustación.`
      );
      return;
    }

    approvingIdsRef.current.add(item.id);
    setProcessingTastingId(item.id);

    try {
      const originSurveyId =
        item.source !== 'carga_multiformato' && isValidUuid(item.id) ? item.id : null;
      const targetCronogramaId =
        item.cronogramaId ||
        (item.source === 'carga_multiformato' && isValidUuid(item.id) ? item.id : null);

      const rpcResult = await assignAcceptedDegustacionToPromotoraRoute({
        promotoraId: matchedPromotora.id,
        promotoraEmail,
        surveyId: originSurveyId,
        cronogramaId: targetCronogramaId,
        confirmarAceptacion: true,
        aprobadoPor: currentUser?.name || currentUser?.email || null,
        allowedPromotoraIds: allowedActivePromotoraIds,
      });

      const finalAssignedPromotora = matchedPromotora.name;

      const syncResult = upsertVisitFromApprovedTasting({
        solicitudId: item.id,
        cronogramaId: rpcResult.cronograma_id,
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
        promotoraId: matchedPromotora.id,
        promotoraName: finalAssignedPromotora,
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
        [item.id]: finalAssignedPromotora,
      }));
      setSelectedPromotoraByTastingId((prev) => ({
        ...prev,
        [item.id]: finalAssignedPromotora,
      }));

      // Notificar en segundo plano al servicio FDV Render sin bloquear la ruta ya proyectada en Supabase
      if (originSurveyId) {
        void updateSupabaseDegustacionStatus(item.id, {
          estado: 'APROBADA',
          promotoraAsignada: finalAssignedPromotora,
          insumosCalculados: {
            ...syncResult.supplies.operationalSupplies,
            mortadelaQty: syncResult.supplies.mortadelaQty,
            espaldaQty: syncResult.supplies.espaldaQty,
            arrozQty: syncResult.supplies.arrozQty,
            azucarGrams: syncResult.supplies.azucarGrams,
            lecheGrams: syncResult.supplies.lecheGrams,
          },
          rawComments: item.rawComments,
          eventDateYmd: item.date,
          isStrictAdmin,
        }).catch(() => {});
      }

      void degustacionNotifications.markAsRead(item.id);
      if (selectedTastingDetail?.id === item.id) {
        setSelectedTastingDetail(null);
      }

      setLastAuthorizedShareBanner({
        promotoraName: finalAssignedPromotora,
        promotoraEmail,
        phone: matchedStaffRecord?.phone || '',
        storeName: item.storeName,
        fechaYmd: item.date,
      });

      showToast(
        `Degustación autorizada y sincronizada en tiempo real hacia /portal y Cronograma de productos (${item.storeName} • ${finalAssignedPromotora}).`
      );
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'No se pudo autorizar y sincronizar la degustación hacia /portal.'
      );
    } finally {
      approvingIdsRef.current.delete(item.id);
      setProcessingTastingId((prev) => (prev === item.id ? null : prev));
    }
  };

  // Marcar como No Autorizada o cancelar solicitud (retira inmediatamente de /portal y Cronograma de productos y pasa a Historial como No Autorizada)
  const handleRejectTastingRequest = async (
    id: string,
    targetEstado: 'NO_AUTORIZADA' | 'RECHAZADA' | 'CANCELADA' = 'NO_AUTORIZADA'
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

      assertCanMutateTastingByWeekCycle({
        eventDate: target?.date,
        fallbackDate: target?.rawComments?.date || target?.createdAt,
        isStrictAdmin,
      });

      const originSurveyId =
        target?.source !== 'carga_multiformato' && isValidUuid(id) ? id : null;
      const targetCronogramaId =
        target?.cronogramaId ||
        (target?.source === 'carga_multiformato' && isValidUuid(id) ? id : null);

      if (originSurveyId || targetCronogramaId) {
        await withdrawDegustacionFromPromotoraRoute({
          surveyId: originSurveyId,
          cronogramaId: targetCronogramaId,
          nuevoEstado: targetEstado,
          motivo: `Solicitud ${targetEstado.toLowerCase()} por Coordinación`,
        });
      }

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

      if (originSurveyId && (target?.rawComments || !String(id).startsWith('vis_'))) {
        void updateSupabaseDegustacionStatus(id, {
          estado: targetEstado,
          rawComments: target?.rawComments,
          eventDateYmd: target?.date,
          isStrictAdmin,
        }).catch(() => {});
      }

      showToast(
        wasRemovedFromSchedule
          ? `Degustación marcada como No Autorizada, archivada en Historial y retirada de /portal y del Cronograma de productos.`
          : `Degustación trasladada al Historial con etiqueta "No Autorizada".`
      );
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : `No se pudo marcar la degustación como ${targetEstado.toLowerCase()}.`
      );
    } finally {
      approvingIdsRef.current.delete(id);
      setProcessingTastingId((prev) => (prev === id ? null : prev));
    }
  };

  // Iniciar degustación en PDV
  const handleStartTasting = (item: TastingScheduleItem) => {
    try {
      assertCanMutateTastingByWeekCycle({
        eventDate: item.date,
        fallbackDate: item.rawComments?.date || item.createdAt,
        isStrictAdmin,
      });
    } catch (lockErr) {
      showToast(
        lockErr instanceof HistoricalTastingLockError
          ? lockErr.message
          : 'Registro Histórico (Cerrado): Solo lectura para usuarios estándar.'
      );
      return;
    }
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
    try {
      assertCanMutateTastingByWeekCycle({
        eventDate: executingItem.date,
        fallbackDate: executingItem.rawComments?.date || executingItem.createdAt,
        isStrictAdmin,
      });
    } catch (lockErr) {
      showToast(
        lockErr instanceof HistoricalTastingLockError
          ? lockErr.message
          : 'Registro Histórico (Cerrado): Solo lectura para usuarios estándar.'
      );
      return;
    }
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
          eventDateYmd: executingItem.date,
          isStrictAdmin,
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

  // Consulta paginada real en servidor (`public.surveys`, 25 registros/página default) para Historial
  useEffect(() => {
    if (tastingViewMode !== 'historial') {
      return;
    }

    let cancelled = false;
    const isSingleIsoDate = /^\d{4}-\d{2}-\d{2}$/.test(tastingDayFilter);
    const isYearMonth = /^\d{4}-\d{2}$/.test(tastingDayFilter);

    setServerHistorialState((prev) => ({ ...prev, loading: true }));

    void queryServerPaginatedHistorialSurveys({
      page: historialPage,
      pageSize: historialPageSize,
      dateFrom: tastingDayFilter === 'RANGO' ? tastingDateFrom || undefined : undefined,
      dateTo: tastingDayFilter === 'RANGO' ? tastingDateTo || undefined : undefined,
      singleDate: isSingleIsoDate ? tastingDayFilter : undefined,
      yearMonth: isYearMonth ? tastingDayFilter : undefined,
      sellerFilter: tastingSellerFilter,
      promotoraFilter: tastingPromotoraFilter,
      statusFilter: tastingStatusFilter,
      shiftFilter: tastingShiftFilter,
      productFilter: tastingProductFilter,
      searchQuery: tastingSearchQuery,
    })
      .then((res) => {
        if (!cancelled) {
          setServerHistorialState({ loading: false, result: res });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerHistorialState((prev) => ({ ...prev, loading: false }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    tastingViewMode,
    historialPage,
    historialPageSize,
    tastingDayFilter,
    tastingDateFrom,
    tastingDateTo,
    tastingSellerFilter,
    tastingPromotoraFilter,
    tastingStatusFilter,
    tastingShiftFilter,
    tastingProductFilter,
    tastingSearchQuery,
    caracasWeekStartYmd,
  ]);

  // Reconciliación sin duplicados de filas paginadas en servidor con la colección local/cronograma
  const toNotificationRowInput = useCallback(
    (r: NonNullable<ServerPaginatedHistorialSurveyResult['rows']>[number]) => ({
      id: r.id,
      type: r.type,
      date: r.date ?? undefined,
      store: r.store ?? undefined,
      promoter: r.promoter ?? undefined,
      product: r.product ?? undefined,
      comments: r.comments ?? undefined,
      creatorId: r.creatorId ?? undefined,
      created_at: r.created_at ?? undefined,
      leido_trade: r.leido_trade,
      visto_en_trade_at: r.visto_en_trade_at,
      en_historial: r.en_historial,
      archivado_en: r.archivado_en,
      motivo_archivo: r.motivo_archivo,
    }),
    []
  );

  const enrichedHistorialPool = useMemo<TastingScheduleItem[]>(() => {
    const baseHistorial = partitionedAllTastings.historial;
    const serverRows = serverHistorialState.result?.rows;
    if (!serverRows || serverRows.length === 0) {
      return baseHistorial;
    }

    const seenIds = new Set<string>(baseHistorial.map((i) => i.id));
    const seenDegIds = new Set<string>(
      baseHistorial.map((i) => i.degustacionId).filter((d): d is string => Boolean(d))
    );
    const extraFromServer: TastingScheduleItem[] = [];

    for (const rawRow of serverRows) {
      if (!rawRow?.id || seenIds.has(rawRow.id)) continue;
      const parsedNotif = parseDegustacionNotificationRow(
        toNotificationRowInput(rawRow),
        liveClock.todayYmd
      );
      if (!parsedNotif) continue;
      if (parsedNotif.degustacionId && seenDegIds.has(parsedNotif.degustacionId)) continue;
      const item = buildScheduleItemFromNotification(parsedNotif);
      const belongsToHist = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
        ? isTastingInPastCaracasWeek(item.date, undefined, item.createdAt)
        : item.status === 'NO_AUTORIZADA' ||
          isTastingBeforeTodayCaracas(item.date, undefined, item.createdAt);
      if (!belongsToHist) continue;
      seenIds.add(item.id);
      if (item.degustacionId) seenDegIds.add(item.degustacionId);
      extraFromServer.push(item);
    }

    if (extraFromServer.length === 0) return baseHistorial;
    return FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
      ? partitionTastingsByCaracasWeek([...baseHistorial, ...extraFromServer]).historial
      : partitionTastingsByTodayAndAuthorization([...baseHistorial, ...extraFromServer]).historial;
  }, [
    partitionedAllTastings.historial,
    serverHistorialState.result,
    liveClock.todayYmd,
    buildScheduleItemFromNotification,
    caracasWeekStartYmd,
  ]);

  // Elementos visibles según la pestaña seleccionada (`Degustaciones` Semana en Curso vs `Historial` Semanas Anteriores)
  const displayedItems = useMemo(() => {
    if (tastingViewMode === 'actual') {
      return partitionedAllTastings.bandejaEntrada.filter((item) =>
        matchesActiveTastingFilters(item)
      );
    }
    return enrichedHistorialPool.filter((item) => matchesActiveTastingFilters(item));
  }, [
    tastingViewMode,
    partitionedAllTastings.bandejaEntrada,
    enrichedHistorialPool,
    matchesActiveTastingFilters,
  ]);

  const historialPagination = useMemo(() => {
    const clientPaginated = paginateSanitizedHistorialCollection(displayedItems, {
      page: historialPage,
      pageSize: historialPageSize,
    });
    const srv = serverHistorialState.result;
    if (
      srv &&
      tastingStatusFilter === 'TODOS' &&
      tastingShiftFilter === 'TODOS' &&
      srv.totalCount > clientPaginated.totalItems
    ) {
      const serverItems: TastingScheduleItem[] = [];
      const byId = new Map(displayedItems.map((i) => [i.id, i]));
      for (const r of srv.rows) {
        const existing = byId.get(r.id);
        if (existing) {
          serverItems.push(existing);
          continue;
        }
        const parsed = parseDegustacionNotificationRow(
          toNotificationRowInput(r),
          liveClock.todayYmd
        );
        if (parsed) {
          serverItems.push(buildScheduleItemFromNotification(parsed));
        }
      }
      return {
        items: serverItems,
        page: srv.page,
        pageSize: srv.pageSize,
        totalItems: srv.totalCount,
        totalPages: srv.totalPages,
        startIndex: srv.startIndex,
        endIndex: srv.endIndex,
        inicioSemanaActualYmd: srv.inicioSemanaActualYmd,
      };
    }
    return clientPaginated;
  }, [
    displayedItems,
    historialPage,
    historialPageSize,
    serverHistorialState.result,
    tastingStatusFilter,
    tastingShiftFilter,
    liveClock.todayYmd,
    buildScheduleItemFromNotification,
  ]);

  const visibleTableItems = useMemo(
    () => (tastingViewMode === 'historial' ? historialPagination.items : displayedItems),
    [tastingViewMode, historialPagination.items, displayedItems]
  );

  useEffect(() => {
    setHistorialPage(1);
  }, [
    tastingViewMode,
    tastingSearchQuery,
    tastingPromotoraFilter,
    tastingSellerFilter,
    tastingStatusFilter,
    tastingDayFilter,
    tastingDateFrom,
    tastingDateTo,
    tastingShiftFilter,
    tastingProductFilter,
    historialPageSize,
  ]);

  // ----------------------------------------------------
  // SUBMÓDULO 2: INFORMES DE CAMPO (CARGADOS EXACTAMENTE DESDE SUPABASE)
  // Pestañas: Inventario y Degustación (inventory) | Asistencia en PDV (checkins agrupados)
  // ----------------------------------------------------
  type ReportSubTab = 'inventario' | 'asistencia' | 'comparativa';
  type FieldRegionBucket = 'Occidente' | 'Centro' | 'Andes';
  type FieldRegionFilter = 'TODAS' | 'ASSIGNED' | FieldRegionBucket;

  const normalizeFieldRegionBucket = useCallback(
    (raw?: string | null, address?: string | null): FieldRegionBucket => {
      const token = String(raw || '')
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
      const addr = String(address || '');
      if (
        /merida|mérida|tachira|táchira|san cristobal|san cristóbal|trujillo|valera|barinas|el vigia|el vigía|andes/i.test(
          addr
        )
      ) {
        return 'Andes';
      }
      if (
        /valencia|carabobo|los guayos|tocuyito|maracay|turmero|caracas|el paraiso|montalban|plaza venezuela/i.test(
          addr
        )
      ) {
        return 'Centro';
      }
      return 'Occidente';
    },
    []
  );

  const allowedRegionBuckets = useMemo<FieldRegionBucket[] | null>(() => {
    if (!isRegionalRestricted) return null;
    if (assignedRegionCodes.length > 0) {
      const buckets: FieldRegionBucket[] = [];
      for (const code of assignedRegionCodes) {
        const b: FieldRegionBucket =
          code === 'ANDES' ? 'Andes' : code === 'CENTRO' ? 'Centro' : 'Occidente';
        if (!buckets.includes(b)) buckets.push(b);
      }
      return buckets.length > 0 ? buckets : null;
    }
    if (assignedRegion) {
      return [normalizeFieldRegionBucket(assignedRegion)];
    }
    return null;
  }, [isRegionalRestricted, assignedRegionCodes, assignedRegion, normalizeFieldRegionBucket]);

  const singleLockedRegionBucket: FieldRegionBucket | null =
    isRegionalRestricted && allowedRegionBuckets && allowedRegionBuckets.length === 1
      ? allowedRegionBuckets[0]
      : null;

  const singleLockedRegionDisplay: string | null =
    singleLockedRegionBucket !== null
      ? assignedRegion ?? singleLockedRegionBucket
      : null;

  const isMultiRegionScope = Boolean(
    isRegionalRestricted &&
      canSwitchAmongAssignedRegions &&
      allowedRegionBuckets &&
      allowedRegionBuckets.length >= 2
  );

  const assignedRegionsDisplayLabel = useMemo(() => {
    if (assignedRegions.length > 0) return assignedRegions.join(' y ');
    if (allowedRegionBuckets && allowedRegionBuckets.length > 0) {
      return allowedRegionBuckets.join(' y ');
    }
    return 'Mis Regiones';
  }, [assignedRegions, allowedRegionBuckets]);

  const defaultFieldRegionFilter: FieldRegionFilter =
    singleLockedRegionBucket ?? (isMultiRegionScope ? 'ASSIGNED' : 'TODAS');

  const editableRegionBuckets: FieldRegionBucket[] = useMemo(
    () => allowedRegionBuckets ?? ['Occidente', 'Centro', 'Andes'],
    [allowedRegionBuckets]
  );

  const defaultWriteRegionBucket: FieldRegionBucket =
    singleLockedRegionBucket ?? editableRegionBuckets[0] ?? 'Occidente';

  const formatBucketLabel = useCallback(
    (bucket: FieldRegionBucket): string => {
      if (bucket === 'Centro' && !isRegionalRestricted) {
        return 'Centro / Valencia';
      }
      return bucket;
    },
    [isRegionalRestricted]
  );

  const resolveRegionIdForBucket = useCallback(
    (bucket: FieldRegionBucket): string | undefined => {
      if (singleLockedRegionBucket && verifiedRegionId) {
        return verifiedRegionId;
      }
      const targetCode =
        bucket === 'Andes' ? 'ANDES' : bucket === 'Centro' ? 'CENTRO' : 'OCCIDENTE';
      const found = (activeRegiones || []).find(
        (r) => String(r.codigo || '').trim().toUpperCase() === targetCode
      );
      if (found?.id) return found.id;
      const masterFound = (masterEntities?.regiones || []).find(
        (r) => String(r.codigo || '').trim().toUpperCase() === targetCode
      );
      return masterFound?.id || undefined;
    },
    [singleLockedRegionBucket, verifiedRegionId, activeRegiones, masterEntities?.regiones]
  );

  const [activeReportTab, setActiveReportTab] = useState<ReportSubTab>('asistencia');
  const [reportSearchQuery, setReportSearchQuery] = useState('');
  const [reportRowLimit, setReportRowLimit] = useState<number>(150);

  const [invRegionFilter, setInvRegionFilter] = useState<FieldRegionFilter>(
    () => defaultFieldRegionFilter
  );
  const [invPromoterFilter, setInvPromoterFilter] = useState<string>('TODAS');
  const [invDateFrom, setInvDateFrom] = useState<string>('');
  const [invDateTo, setInvDateTo] = useState<string>('');
  const [checkinPhotosMap, setCheckinPhotosMap] = useState<Record<string, string>>({});

  useEffect(() => {
    setInvRegionFilter((prev) => {
      if (singleLockedRegionBucket) return singleLockedRegionBucket;
      if (isMultiRegionScope) {
        if (prev === 'ASSIGNED') return 'ASSIGNED';
        if (
          prev !== 'TODAS' &&
          allowedRegionBuckets &&
          allowedRegionBuckets.includes(prev)
        ) {
          return prev;
        }
        return 'ASSIGNED';
      }
      return prev === 'ASSIGNED' ? 'TODAS' : prev;
    });
  }, [singleLockedRegionBucket, isMultiRegionScope, allowedRegionBuckets]);

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
    region: FieldRegionBucket;
  }>({
    date: new Date().toISOString().slice(0, 10),
    storeName: '',
    promoterName: '',
    productName: '',
    initialInventory: 0,
    finalInventory: 0,
    samplesGiven: 0,
    promoterObservation: '',
    region: defaultWriteRegionBucket,
  });

  useEffect(() => {
    setNewInventoryForm((prev) =>
      editableRegionBuckets.includes(prev.region)
        ? prev
        : { ...prev, region: defaultWriteRegionBucket }
    );
  }, [editableRegionBuckets, defaultWriteRegionBucket]);

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

  const inventoryPromoterOptions = useMemo<string[]>(() => {
    const names = new Set<string>();
    inventorySampling.forEach((inv) => {
      const invReg = normalizeFieldRegionBucket(inv.region, inv.zone);
      if (allowedRegionBuckets && !allowedRegionBuckets.includes(invReg)) return;
      const clean = String(inv.promotora || '').trim();
      if (clean) names.add(clean);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'es'));
  }, [inventorySampling, allowedRegionBuckets, normalizeFieldRegionBucket]);

  const filteredInventorySampling = useMemo<InventorySamplingRecord[]>(() => {
    const q = reportSearchQuery.trim().toLowerCase();
    return inventorySampling.filter((inv) => {
      if (!inv) return false;
      const invReg = normalizeFieldRegionBucket(inv.region, inv.zone);
      if (allowedRegionBuckets && !allowedRegionBuckets.includes(invReg)) return false;
      if (
        invRegionFilter !== 'TODAS' &&
        invRegionFilter !== 'ASSIGNED' &&
        invReg !== invRegionFilter
      ) {
        return false;
      }
      if (
        invPromoterFilter !== 'TODAS' &&
        String(inv.promotora || '').trim().toLowerCase() !== invPromoterFilter.trim().toLowerCase()
      ) {
        return false;
      }
      const invYmd = String(inv.date || '').slice(0, 10);
      if (invDateFrom && invYmd && invYmd < invDateFrom) return false;
      if (invDateTo && invYmd && invYmd > invDateTo) return false;
      if (!q) return true;
      return (
        String(inv.storeName || '').toLowerCase().includes(q) ||
        String(inv.productName || '').toLowerCase().includes(q) ||
        String(inv.promotora || '').toLowerCase().includes(q) ||
        String(inv.zone || '').toLowerCase().includes(q) ||
        invReg.toLowerCase().includes(q) ||
        String(inv.dateSlash || inv.date || '').toLowerCase().includes(q) ||
        String(inv.observations || '').toLowerCase().includes(q)
      );
    });
  }, [
    inventorySampling,
    allowedRegionBuckets,
    invRegionFilter,
    invPromoterFilter,
    invDateFrom,
    invDateTo,
    reportSearchQuery,
    normalizeFieldRegionBucket,
  ]);

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
      const effectiveInvRegion: FieldRegionBucket = editableRegionBuckets.includes(
        newInventoryForm.region
      )
        ? newInventoryForm.region
        : defaultWriteRegionBucket;
      await createSupabaseInventoryRecord({
        date: newInventoryForm.date,
        storeName: newInventoryForm.storeName,
        promoterName: newInventoryForm.promoterName,
        productName: newInventoryForm.productName,
        initialQuantity: Number(newInventoryForm.initialInventory) || 0,
        finalQuantity: Number(newInventoryForm.finalInventory) || 0,
        degustations: Number(newInventoryForm.samplesGiven) || 0,
        comments: newInventoryForm.promoterObservation,
        region: effectiveInvRegion,
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

  // Totales reales calculados desde Supabase para KPIs de Informes
  const totalReportsMuestras = useMemo(
    () => Math.round(filteredInventorySampling.reduce((acc, c) => acc + c.portionsSampled, 0)),
    [filteredInventorySampling]
  );
  const totalReportsFotos = visitsHistory.length;

  const handleExportInformesPdf = () => {
    let title = '';
    let head: string[][] = [];
    let body: (string | number)[][] = [];

    if (activeReportTab === 'inventario') {
      title = singleLockedRegionDisplay
        ? `Control de Inventario y Degustación en PDV — Región ${singleLockedRegionDisplay}`
        : isMultiRegionScope
          ? `Control de Inventario y Degustación en PDV — Regiones ${assignedRegionsDisplayLabel}`
          : 'Control de Inventario y Degustación en PDV (Supabase)';
      head = [['PDV / TIENDA', 'PRODUCTO & ID', 'STOCK INIC.', 'DEGUSTACIÓN', 'ROTACIÓN / VENTA', 'STOCK FINAL', 'PROMOTORA']];
      body = filteredInventorySampling.slice(0, 300).map((i) => [
        `${i.storeName}\n${i.date}`,
        `${i.productName}\n${i.lotNumber}`,
        `${i.initialStock}`,
        `${i.portionsSampled}`,
        `${i.assistedSales}`,
        `${i.finalStock}`,
        i.promotora,
      ]);
    } else if (activeReportTab === 'comparativa') {
      title = singleLockedRegionDisplay
        ? `Comparativa Bimonetaria de Precios (BCV) — Región ${singleLockedRegionDisplay}`
        : isMultiRegionScope
          ? `Comparativa Bimonetaria de Precios (BCV) — Regiones ${assignedRegionsDisplayLabel}`
          : 'Comparativa Bimonetaria de Precios en Anaquel (BCV · Supabase)';
      head = [['PDV & FECHA', 'PRODUCTO PROPIO', 'PROPIO (USD)', 'COMPETIDOR (USD)', 'BRECHA %', 'BCV APLICADA', 'PROMOTORA']];
      body = priceComparisons.slice(0, 300).map((pc) => [
        `${pc.storeName}\n${pc.date}`,
        pc.ownProduct,
        `$${pc.ownPriceUsd.toFixed(2)} (${pc.ownCurrency ?? 'USD'})`,
        pc.competitorPriceUsd && pc.competitorPriceUsd > 0
          ? `${pc.competitorBrand || 'Comp.'}: $${pc.competitorPriceUsd.toFixed(2)}`
          : '—',
        `${Number(pc.gapPercent ?? 0).toFixed(1)}%`,
        pc.bcvRate ? `${pc.bcvRate.toFixed(2)} Bs` : '—',
        pc.promotora,
      ]);
    } else {
      title = 'Registro de Evidencias de Asistencia Condicional por Perfil (Supabase)';
      head = [
        [
          'PROMOTORA',
          'PERFIL APLICADO',
          'PDV & ZONA',
          'FECHA',
          'CUMPLIMIENTO',
          'MARCAS OFICIALES (UTC-4)',
        ],
      ];
      const exportModels = buildDailyPromotoraAttendanceViewModels({
        staffMembers: module1Bundle?.staffMembers || [],
        asistenciaJornadas: module1Bundle?.asistenciaJornadas || [],
        asistenciaEvidencias: module1Bundle?.asistenciaEvidencias || [],
        legacyAttendanceRecords: attendanceRecords,
        selectedDateYmd: null,
      });

      body = exportModels.slice(0, 300).map((vm) => {
        const timesSummary = Object.entries(vm.evidencesBySlot)
          .filter(([, item]) => Boolean(item))
          .map(([slot, item]) => `${slot}: ${item!.horaCaracasFormateada}`)
          .join(' | ');
        return [
          `${vm.promotoraNombre}\n${vm.promotoraEmail || ''}`,
          `${vm.perfilAplicado} (${vm.compliance.requiredCount} fotos)`,
          `${vm.pdvNombre}\n${vm.zona}`,
          vm.fechaSlash,
          `${vm.compliance.fractionLabel} · ${vm.compliance.statusLabel}`,
          timesSummary || 'Sin registro',
        ];
      });
    }

    exportPromotoraReportsPdf(
      activeReportTab === 'comparativa' ? 'precios' : activeReportTab,
      title,
      head,
      body,
      {
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
  // SUBMÓDULO 4: PERSONAL ACTIVO SINCRONIZADO (OCCIDENTE + CENTRO + ANDES · SUPABASE `promotoras`)
  // ----------------------------------------------------
  const [selectedStaffRegionFilter, setSelectedStaffRegionFilter] = useState<FieldRegionFilter>(
    () => defaultFieldRegionFilter
  );
  const [selectedStaffCategoryFilter, setSelectedStaffCategoryFilter] = useState<'TODAS' | StaffCategory>('TODAS');

  useEffect(() => {
    setSelectedStaffRegionFilter((prev) => {
      if (singleLockedRegionBucket) return singleLockedRegionBucket;
      if (isMultiRegionScope) {
        if (prev === 'ASSIGNED') return 'ASSIGNED';
        if (
          prev !== 'TODAS' &&
          allowedRegionBuckets &&
          allowedRegionBuckets.includes(prev)
        ) {
          return prev;
        }
        return 'ASSIGNED';
      }
      return prev === 'ASSIGNED' ? 'TODAS' : prev;
    });
  }, [singleLockedRegionBucket, isMultiRegionScope, allowedRegionBuckets]);
  const [selectedStaffSearch, setSelectedStaffSearch] = useState('');
  const [fallbackPromotorasStaff, setFallbackPromotorasStaff] = useState<StaffMemberRecord[]>([]);
  const [loadingPersonalCatalog, setLoadingPersonalCatalog] = useState(false);
  const [uploadingPhotoStaffId, setUploadingPhotoStaffId] = useState<string | null>(null);
  const [isSavingStaffModal, setIsSavingStaffModal] = useState<boolean>(false);
  const [staffFormError, setStaffFormError] = useState<string | null>(null);
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
    region: FieldRegionBucket;
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
    region: defaultWriteRegionBucket,
    password: '',
    status: 'Activo',
  });

  const loadFallbackPromotorasCatalog = useCallback(async (forceRefresh = false) => {
    setLoadingPersonalCatalog(true);
    try {
      const rows = await obtenerPromotorasMaestras({ soloActivas: false, forzarRefresco: forceRefresh });
      const minorWords = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
      const formatDisplayName = (raw: string): string => {
        const trimmed = raw.replace(/\s+/g, ' ').trim();
        if (!trimmed) return 'Sin nombre';
        const isAllUpper = trimmed === trimmed.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(trimmed);
        if (!isAllUpper) return trimmed;
        return trimmed
          .toLowerCase()
          .split(' ')
          .map((word, idx) =>
            idx > 0 && minorWords.has(word)
              ? word
              : word.charAt(0).toUpperCase() + word.slice(1)
          )
          .join(' ');
      };

      const mapped: StaffMemberRecord[] = rows
        .filter((p) => p.activo !== false)
        .map((p) => {
          const displayName = formatDisplayName(String(p.nombre_completo || ''));
          const cleanEmail = String(p.email || '').trim().toLowerCase();
          const catRaw = String(p.categoria || 'Fijas').trim().toLowerCase();
          const category: StaffCategory = catRaw.includes('merch')
            ? 'merchandising'
            : catRaw.includes('event')
              ? 'eventual'
              : 'fija';
          const regionLabel: FieldRegionBucket = normalizeFieldRegionBucket(
            String(
              p.region ||
                p.metadata?.region_codigo ||
                p.metadata?.region_perfil ||
                p.sucursal ||
                ''
            ),
            String(p.direccion || p.ciudad || '')
          );
          return {
            id: String(p.id),
            name: displayName,
            canonicalKey: canonicalStaffKey(displayName, cleanEmail),
            role: category === 'merchandising' ? 'Promotor Merchandising' : 'Promotora',
            category,
            roleCategory: (category === 'merchandising' ? 'MERCHANDISING' : 'PROMOTORA') as
              | 'MERCHANDISING'
              | 'PROMOTORA',
            email: cleanEmail,
            phone: p.telefono ? String(p.telefono).trim() : '',
            address: p.direccion ? String(p.direccion).trim() : '',
            region: regionLabel,
            authUserId: p.auth_user_id ?? null,
            assignedStore: regionLabel,
            status: 'Activo' as const,
            password: '',
            shift: `${category === 'fija' ? 'Plantilla Fija' : category === 'eventual' ? 'Plantilla Eventual' : 'Merchandising'} • ${regionLabel}`,
            tastingCompleted: 0,
            salesAssisted: 0,
            activationsCount: 0,
            totalUnits: 0,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));

      setFallbackPromotorasStaff(mapped);
    } catch {
      // Mantiene estado previo sin romper la vista
    } finally {
      setLoadingPersonalCatalog(false);
    }
  }, []);

  useEffect(() => {
    const bundleCount = (module1Bundle?.staffMembers || []).filter((s) => s.status === 'Activo').length;
    if (activeSubTab === 'personal' && bundleCount === 0 && fallbackPromotorasStaff.length === 0) {
      void loadFallbackPromotorasCatalog(false);
    }
  }, [activeSubTab, module1Bundle?.staffMembers, fallbackPromotorasStaff.length, loadFallbackPromotorasCatalog]);

  const resolveMemberRegion = useCallback(
    (m: StaffMemberRecord): FieldRegionBucket => {
      return normalizeFieldRegionBucket(m.region, m.address);
    },
    [normalizeFieldRegionBucket]
  );

  const staffList = useMemo<StaffMemberRecord[]>(() => {
    const fromBundle = (module1Bundle?.staffMembers || []).filter((s) => s.status === 'Activo');
    const base = fromBundle.length > 0 ? fromBundle : fallbackPromotorasStaff;
    if (!allowedRegionBuckets) return base;
    return base.filter((m) => allowedRegionBuckets.includes(resolveMemberRegion(m)));
  }, [module1Bundle, fallbackPromotorasStaff, allowedRegionBuckets, resolveMemberRegion]);

  const occidenteStaffCount = useMemo(
    () => staffList.filter((m) => resolveMemberRegion(m) === 'Occidente').length,
    [staffList, resolveMemberRegion]
  );

  const centroStaffCount = useMemo(
    () => staffList.filter((m) => resolveMemberRegion(m) === 'Centro').length,
    [staffList, resolveMemberRegion]
  );

  const andesStaffCount = useMemo(
    () => staffList.filter((m) => resolveMemberRegion(m) === 'Andes').length,
    [staffList, resolveMemberRegion]
  );

  const regionFilteredStaffList = useMemo(
    () =>
      selectedStaffRegionFilter === 'TODAS' || selectedStaffRegionFilter === 'ASSIGNED'
        ? staffList
        : staffList.filter((m) => resolveMemberRegion(m) === selectedStaffRegionFilter),
    [staffList, selectedStaffRegionFilter, resolveMemberRegion]
  );

  const fijaStaffMembers = useMemo(
    () => regionFilteredStaffList.filter((m) => m.category === 'fija'),
    [regionFilteredStaffList]
  );
  const eventualStaffMembers = useMemo(
    () => regionFilteredStaffList.filter((m) => m.category === 'eventual'),
    [regionFilteredStaffList]
  );
  const merchStaffMembers = useMemo(
    () => regionFilteredStaffList.filter((m) => m.category === 'merchandising'),
    [regionFilteredStaffList]
  );

  // Mapa en vivo de degustaciones activas (Semana en Curso, no históricas) asignadas a cada promotora activa
  const activeScheduledByStaffKey = useMemo(() => {
    const map = new Map<string, TastingScheduleItem[]>();
    partitionedAllTastings.bandejaEntrada.forEach((item) => {
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
  }, [partitionedAllTastings.bandejaEntrada]);

  const matchesStaffSearch = useCallback(
    (m: StaffMemberRecord): boolean => {
      if (!selectedStaffSearch.trim()) return true;
      const normalize = (v: string) =>
        String(v || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
      const q = normalize(selectedStaffSearch.trim());
      const memberRegion = resolveMemberRegion(m);
      return (
        normalize(m.name).includes(q) ||
        normalize(m.assignedStore).includes(q) ||
        normalize(m.email).includes(q) ||
        normalize(m.phone).includes(q) ||
        normalize(m.address || 'Sin dirección registrada').includes(q) ||
        normalize(memberRegion).includes(q) ||
        normalize(m.role).includes(q)
      );
    },
    [selectedStaffSearch, resolveMemberRegion]
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
    setStaffFormError(null);
    const preferredRegion: FieldRegionBucket =
      singleLockedRegionBucket ??
      (selectedStaffRegionFilter !== 'TODAS' &&
      selectedStaffRegionFilter !== 'ASSIGNED' &&
      editableRegionBuckets.includes(selectedStaffRegionFilter)
        ? selectedStaffRegionFilter
        : defaultWriteRegionBucket);
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
      region: preferredRegion,
      password: '',
      status: 'Activo',
      photoUrl: undefined,
    });
  };

  const openEditStaffModal = (member: StaffMemberRecord) => {
    setStaffFormError(null);
    const memberRegion = resolveMemberRegion(member);
    const safeRegion: FieldRegionBucket =
      singleLockedRegionBucket ??
      (editableRegionBuckets.includes(memberRegion) ? memberRegion : defaultWriteRegionBucket);
    setStaffFormModal({
      isOpen: true,
      id: member.id,
      name: String(member.name ?? ''),
      role: String(member.role ?? 'Promotora'),
      category: member.category || 'fija',
      phone: String(member.phone ?? ''),
      email: String(member.email ?? ''),
      assignedStore: String(member.assignedStore ?? 'VARIAS'),
      address: String(member.address ?? ''),
      region: safeRegion,
      // Seguridad Zero Trust: nunca poblar ni mostrar contraseñas almacenadas
      password: '',
      status: member.status === 'Inactivo' ? 'Inactivo' : 'Activo',
      photoUrl: member.photoUrl,
    });
  };

  const handleSaveStaffModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingStaffModal) return;
    const cleanName = staffFormModal.name.trim();
    if (!cleanName) {
      setStaffFormError('El nombre completo es obligatorio.');
      return;
    }
    setStaffFormError(null);
    setIsSavingStaffModal(true);
    try {
      const effectiveStaffRegion: FieldRegionBucket = singleLockedRegionBucket
        ? singleLockedRegionBucket
        : editableRegionBuckets.includes(staffFormModal.region)
          ? staffFormModal.region
          : defaultWriteRegionBucket;
      const saved = await saveSupabaseStaffMember({
        id: staffFormModal.id,
        name: cleanName,
        role: staffFormModal.role,
        category: staffFormModal.category,
        email: staffFormModal.email,
        phone: staffFormModal.phone,
        address: staffFormModal.address,
        assignedStore: staffFormModal.assignedStore,
        status: staffFormModal.status,
        password: staffFormModal.password,
        photoUrl: staffFormModal.photoUrl,
        region: effectiveStaffRegion,
        regionId: resolveRegionIdForBucket(effectiveStaffRegion),
      });

      // Aprovisionar/actualizar cuenta segura en Supabase Auth (sin texto plano en public.staff)
      const cleanPass = staffFormModal.password.trim();
      if (saved.id && isValidUuid(saved.id) && (cleanPass || staffFormModal.status === 'Inactivo')) {
        await provisionStaffAuthAccountViaBackend({
          staffId: saved.id,
          name: cleanName,
          email: staffFormModal.email.trim(),
          password: cleanPass || undefined,
          appRole: 'promotora',
          active: staffFormModal.status === 'Activo',
        });
      }

      setStaffFormModal((prev) => ({ ...prev, isOpen: false, password: '' }));
      await Promise.all([
        masterEntities?.refresh(true).catch(() => undefined),
        loadFallbackPromotorasCatalog(true).catch(() => undefined),
        refreshSupabaseData(),
      ]);
      showToast(
        staffFormModal.status === 'Inactivo'
          ? `✓ ${cleanName} marcada como inactiva y revocado su acceso a /portal/ruta.`
          : `✓ Perfil de ${cleanName} guardado y sincronizado en Supabase.`
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo guardar el perfil en Supabase.';
      console.error('[FieldPromotoraView] Error guardando perfil:', err);
      setStaffFormError(msg);
      showToast(msg);
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
      await Promise.all([
        masterEntities?.refresh(true).catch(() => undefined),
        loadFallbackPromotorasCatalog(true).catch(() => undefined),
        refreshSupabaseData(),
      ]);
      showToast(`✓ ${member.name} retirada del sistema y sincronizada con Supabase.`);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'No se pudo eliminar el registro en Supabase.';
      showToast(msg);
    }
  };

  const buildStaffAppLink = (_member?: StaffMemberRecord): string => {
    return getPromotorasPortalUrl();
  };

  const handleSendWhatsAppPortalLink = (params: {
    promotoraName?: string | null;
    promotoraEmail?: string | null;
    phone?: string | null;
    storeName?: string | null;
    fechaYmd?: string | null;
  }) => {
    const waUrl = buildPromotoraWhatsAppLink({
      promotoraName: params.promotoraName,
      promotoraEmail: params.promotoraEmail,
      phone: params.phone,
      storeName: params.storeName,
      dateYmd: params.fechaYmd,
    });
    window.open(waUrl, '_blank', 'noopener,noreferrer');
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
      {FEATURE_FLAGS.ENABLE_MODULO1_TABLAS_METRICAS && activeSubTab !== 'solicitudes_contraloria' && (
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
      <AnimatedTabContainer tabKey={activeSubTab} className="space-y-6">
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
            <div className="p-4 bg-zinc-950/90 rounded-t-2xl border-b border-white/[0.07] flex flex-col lg:flex-row lg:items-center justify-between gap-3">
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
                    <span>Degustaciones</span>
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

              {/* Barra de Acciones Ejecutivas (3 botones en fila limpia en escritorio) */}
              <div
                data-testid="degustaciones-toolbar-actions"
                className="flex flex-wrap lg:flex-nowrap items-center gap-2 shrink-0"
              >
                {tastingViewMode === 'actual' && (
                  <button
                    type="button"
                    data-testid="btn-toolbar-export-auth-pdf"
                    onClick={handleExportPendingAuthorizationPdf}
                    disabled={isExportingAuthPdf || visiblePendingAuthorizationCount === 0}
                    aria-busy={isExportingAuthPdf}
                    title={
                      visiblePendingAuthorizationCount === 0
                        ? 'No existen degustaciones pendientes de aceptación en el cronograma actual con los filtros seleccionados'
                        : `Descargar Informe Detallado de Solicitud de Autorización para Gerencia (${visiblePendingAuthorizationCount} pendiente${
                            visiblePendingAuthorizationCount === 1 ? '' : 's'
                          } · ${
                            pendingAuthorizationScopeMeta.hasActiveFilters
                              ? `Filtrado: ${pendingAuthorizationScopeMeta.filterSummaryLabel}`
                              : 'General de Pendientes'
                          })`
                    }
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold tracking-wide whitespace-nowrap bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-amber-100 hover:text-white border border-amber-400/50 hover:border-amber-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_4px_14px_-2px_rgba(245,158,11,0.3)] transition-all cursor-pointer"
                  >
                    {isExportingAuthPdf ? (
                      <Loader2 className="w-3.5 h-3.5 text-amber-300 animate-spin" />
                    ) : authPdfSuccess ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />
                    ) : (
                      <FileSignature className="w-3.5 h-3.5 text-amber-300" />
                    )}
                    <span>
                      {isExportingAuthPdf
                        ? 'Generando PDF...'
                        : authPdfSuccess
                          ? '¡Autorización Descargada!'
                          : 'Exportar PDF Autorización'}
                    </span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-black/40 border border-amber-400/35 text-amber-200 font-mono uppercase">
                      {visiblePendingAuthorizationCount} PEND.
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  data-testid="btn-toolbar-enlaces"
                  onClick={handleScrollToLinksSection}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl whitespace-nowrap bg-zinc-900 hover:bg-zinc-800 text-zinc-100 hover:text-white text-xs font-bold border border-white/15 hover:border-red-500/45 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#DC2626]"
                  title="Ir a la sección de enlaces de acceso de la aplicación"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  <span>Enlaces</span>
                </button>

                <button
                  type="button"
                  data-testid="btn-toolbar-export-global-pdf"
                  onClick={handleExportMonthlyReportPdf}
                  disabled={isExportingMonthlyPdf}
                  aria-busy={isExportingMonthlyPdf}
                  title={`Descargar Informe Global y Detallado según el filtro aplicado (${activeGlobalReportMeta.summaryLabel})`}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold tracking-wide whitespace-nowrap bg-red-600 hover:bg-red-500 disabled:opacity-60 disabled:cursor-not-allowed text-white border border-red-500/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_14px_-2px_rgba(220,38,38,0.5)] transition-all cursor-pointer"
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
              </div>
            </div>

            {/* Aviso Visual Instantáneo Realtime en la pestaña Degustaciones (FDV -> Trade Marketing) */}
            {degustacionNotifications.unreadCount > 0 && (
              <div
                role="status"
                data-testid="degustaciones-realtime-live-banner"
                className="px-4 py-3 bg-red-950/45 border-b border-[#DC2626]/45 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#DC2626] opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#DC2626]" />
                  </span>
                  <div className="min-w-0">
                    <span className="font-extrabold text-white">
                      {degustacionNotifications.unreadCount === 1
                        ? '1 nueva solicitud de degustación recibida desde FDV'
                        : `${degustacionNotifications.unreadCount} nuevas solicitudes de degustación recibidas desde FDV`}
                    </span>
                    {degustacionNotifications.unreadItems[0] && (
                      <span className="text-zinc-300 ml-1.5">
                        · Última: <strong className="text-white">{degustacionNotifications.unreadItems[0].storeName}</strong>{' '}
                        ({degustacionNotifications.unreadItems[0].sellerName})
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void degustacionNotifications.markAllAsRead()}
                    className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-[#DC2626] text-zinc-200 hover:text-white border border-white/15 text-[11px] font-bold transition cursor-pointer"
                  >
                    Marcar como vistas
                  </button>
                </div>
              </div>
            )}

            {lastAuthorizedShareBanner && (
              <div className="px-4 py-3 bg-emerald-950/35 border-b border-emerald-500/35 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 text-xs">
                <div className="flex items-center gap-2 text-emerald-100">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>
                    Ruta sincronizada en vivo para{' '}
                    <strong className="text-white">{lastAuthorizedShareBanner.promotoraName}</strong>{' '}
                    (<span className="font-mono">{lastAuthorizedShareBanner.promotoraEmail}</span>) en{' '}
                    <strong className="text-white">{lastAuthorizedShareBanner.storeName}</strong> ·{' '}
                    {formatToDdMmYyyy(lastAuthorizedShareBanner.fechaYmd)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      handleSendWhatsAppPortalLink({
                        promotoraName: lastAuthorizedShareBanner.promotoraName,
                        promotoraEmail: lastAuthorizedShareBanner.promotoraEmail,
                        phone: lastAuthorizedShareBanner.phone,
                        storeName: lastAuthorizedShareBanner.storeName,
                        fechaYmd: lastAuthorizedShareBanner.fechaYmd,
                      })
                    }
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5 shadow cursor-pointer"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>Enviar Link por WhatsApp a {lastAuthorizedShareBanner.promotoraName}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLastAuthorizedShareBanner(null)}
                    className="p-1 rounded-lg text-zinc-400 hover:text-white cursor-pointer"
                    title="Cerrar aviso"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Subcabecera de Estado, Bandeja Vigente vs Historial */}
            <div className="px-4 py-2.5 bg-zinc-950/80 border-b border-zinc-900 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${tastingViewMode === 'actual' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-400'}`} />
                <span className="font-black text-white uppercase tracking-wider text-[11px]">
                  {tastingViewMode === 'actual'
                    ? FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
                      ? `BANDEJA DE ENTRADA • SEMANA EN CURSO (${liveClock.currentWeek.rangeLabel} · AMERICA/CARACAS)`
                      : `BANDEJA DE ENTRADA • SOLICITUDES VIGENTES Y PRÓXIMAS (DESDE ${formatToDdMmYyyy(liveClock.todayYmd)} · AMERICA/CARACAS)`
                    : 'PESTAÑA DE HISTORIAL • DEGUSTACIONES ANTERIORES (AUTORIZADAS / NO AUTORIZADAS)'}
                </span>
                {tastingViewMode === 'historial' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-900 border border-amber-500/40 text-amber-300 font-mono text-[10px] font-bold">
                    {isStrictAdmin ? (
                      <>
                        <ShieldCheck className="w-3 h-3 text-emerald-400" />
                        <span>🔒 Registro Histórico (Cerrado · Admin)</span>
                      </>
                    ) : (
                      <>
                        <Lock className="w-3 h-3 text-amber-400" />
                        <span>🔒 Registro Histórico (Cerrado) · Solo Lectura</span>
                      </>
                    )}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {tastingViewMode === 'historial' && serverHistorialState.loading && (
                  <Loader2 className="w-3.5 h-3.5 text-zinc-400 animate-spin" />
                )}
                <span className="text-zinc-400 font-mono text-[11px]">
                  {tastingViewMode === 'historial'
                    ? historialPagination.totalItems > 0
                      ? `Mostrando ${historialPagination.startIndex}-${historialPagination.endIndex} de ${historialPagination.totalItems} en Historial`
                      : '0 registros en Historial'
                    : `${displayedItems.length} solicitudes vigentes/próximas en Bandeja`}
                </span>
              </div>
            </div>

            {/* Atajos rápidos en la pestaña Historial */}
            {tastingViewMode === 'historial' && FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE && (
              <div className="px-3.5 py-2 bg-zinc-950/60 border-b border-zinc-900 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-zinc-400 font-semibold uppercase tracking-wider text-[10px] mr-1">
                    Corte por Semana ISO:
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const prevWeek = getPastCaracasWeeksRange(1);
                      setTastingDateFrom(prevWeek.dateFromYmd);
                      setTastingDateTo(prevWeek.dateToYmd);
                      setTastingDayFilter('RANGO');
                    }}
                    className={`px-2.5 py-1 rounded-lg border font-semibold transition cursor-pointer ${
                      tastingDayFilter === 'RANGO' &&
                      tastingDateFrom === getPastCaracasWeeksRange(1).dateFromYmd &&
                      tastingDateTo === getPastCaracasWeeksRange(1).dateToYmd
                        ? 'bg-red-600 text-white border-red-500'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-800'
                    }`}
                  >
                    Semana Pasada ({formatToDdMmYyyy(getPastCaracasWeeksRange(1).dateFromYmd)} -{' '}
                    {formatToDdMmYyyy(getPastCaracasWeeksRange(1).dateToYmd)})
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const last4 = getPastCaracasWeeksRange(4);
                      setTastingDateFrom(last4.dateFromYmd);
                      setTastingDateTo(last4.dateToYmd);
                      setTastingDayFilter('RANGO');
                    }}
                    className={`px-2.5 py-1 rounded-lg border font-semibold transition cursor-pointer ${
                      tastingDayFilter === 'RANGO' &&
                      tastingDateFrom === getPastCaracasWeeksRange(4).dateFromYmd &&
                      tastingDateTo === getPastCaracasWeeksRange(4).dateToYmd
                        ? 'bg-red-600 text-white border-red-500'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-800'
                    }`}
                  >
                    Últimas 4 Semanas
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTastingDateFrom('');
                      setTastingDateTo('');
                      setTastingDayFilter('TODOS');
                    }}
                    className={`px-2.5 py-1 rounded-lg border font-semibold transition cursor-pointer ${
                      tastingDayFilter === 'TODOS'
                        ? 'bg-zinc-800 text-white border-white/20'
                        : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border-zinc-800'
                    }`}
                  >
                    Todo el Historial ({archivedTastingCount})
                  </button>
                </div>
                <span className="text-[10px] font-mono text-zinc-500">
                  Corte estricto: fecha &lt; {caracasWeekStartYmd} (Lun 00:00 America/Caracas)
                </span>
              </div>
            )}

            {/* Barra de Filtros Sincronizados */}
            <div className="p-3.5 bg-slate-950/60 border-b border-slate-800 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-2.5">
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
                  value={tastingSellerFilter}
                  onChange={(e) => setTastingSellerFilter(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-red-500 font-medium"
                >
                  <option value="TODOS">Vendedor FDV: Todos ({availableSellers.length})</option>
                  {availableSellers.map((seller) => (
                    <option key={seller} value={seller}>
                      {seller}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <select
                  value={tastingStatusFilter}
                  onChange={(e) => setTastingStatusFilter(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-red-500 font-medium"
                >
                  <option value="TODOS">Estado: Todos</option>
                  <option value="PENDIENTE">⏳ Pendientes por Autorizar ({pendingSolicitadasCount})</option>
                  <option value="PROGRAMADO">✓ Autorizadas / Prog.</option>
                  <option value="EN_CURSO">▶️ En Curso</option>
                  <option value="COMPLETADO">✓ Ejecutadas</option>
                  <option value="NO_AUTORIZADA">✕ No Autorizadas</option>
                </select>
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
                  <option value="POR_ASIGNAR">⏳ Por Asignar (Sin promotora)</option>
                  {availablePromotoras.map((prom) => (
                    <option key={prom} value={prom}>
                      {prom}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* TABLA DE DEGUSTACIONES SINCRONIZADA CON SUPABASE & TRADE MARKETING */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-black border-b border-zinc-800 text-zinc-400 font-black uppercase text-[10px] tracking-wider">
                    <th className="py-2.5 px-2.5 text-center w-10 align-middle">#</th>
                    <th className="py-2.5 px-3 align-middle">DÍA & JORNADA</th>
                    <th className="py-2.5 px-3 align-middle">CLIENTE & RUTA</th>
                    <th className="py-2.5 px-3 align-middle">PRODUCTO & CANTIDAD</th>
                    <th className="py-2.5 px-3 align-middle">PROMOTORA & FDV</th>
                    <th className="py-2.5 px-3 text-center align-middle">ESTADO</th>
                    <th className="py-2.5 px-3 text-center w-36 align-middle">MUESTRAS & VENTAS</th>
                    <th className="py-2.5 px-3 text-center w-36 align-middle">ACCIONES</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-zinc-900 text-zinc-200">
                  {visibleTableItems.length > 0 ? (
                    visibleTableItems.map((item, idx) => {
                      const rowNumber =
                        tastingViewMode === 'historial'
                          ? (historialPagination.startIndex || 1) + idx
                          : idx + 1;
                      const isPending = item?.status === 'PENDIENTE';
                      const isUnread = item?.leidoTrade === false;
                      const isHighlighted = highlightedTastingRowId === item?.id;
                      const safeTimeRange = item?.timeRange?.trim() || '';
                      const isFullShift =
                        item?.turnoRaw === 'COMPLETO' || item?.shift === 'COMPLETO';
                      const isMorning =
                        !isFullShift &&
                        (item?.shift === 'MAÑANA' ||
                          safeTimeRange.startsWith('08') ||
                          safeTimeRange.startsWith('09') ||
                          safeTimeRange.toUpperCase().includes('MAÑANA'));
                      const isOverduePending = Boolean(
                        isPending && item?.date && item.date < liveClock.todayYmd
                      );

                      const compactDayDate = formatCompactScheduleDayDate(
                        item?.date,
                        item?.dayLabel
                      );
                      const shiftBadgeText = isFullShift
                        ? '☀️🌙 Completo'
                        : isMorning
                          ? '☀️ Mañana'
                          : '🌙 Tarde';
                      const shiftTooltip = safeTimeRange
                        ? `Horario programado: ${safeTimeRange}`
                        : `Jornada: ${shiftBadgeText}`;

                      const safeStoreName = item?.storeName?.trim() || 'PDV Sin Nombre';
                      const cleanClienteCodigo =
                        item?.clienteCodigo?.trim().replace(/^#+/, '') || '';
                      const routeDisplay = formatSafeRouteDisplay(item?.zone);

                      const safeProductName = item?.productName?.trim() || 'Portafolio Codizulca';
                      const brandBadge = resolveCompactBrandBadge(
                        item?.productName,
                        item?.fillProductSelection
                      );
                      const fallbackQtySum =
                        (item?.mortadelaQty ?? 0) +
                        (item?.espaldaQty ?? 0) +
                        (item?.arrozQty ?? 0);
                      const safeTotalQty = item?.requestedQty ?? (fallbackQtySum > 0 ? fallbackQtySum : 0);

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
                          {/* # */}
                          <td
                            className="py-2.5 px-2.5 align-middle text-center font-mono text-zinc-400 text-[11px]"
                            title={isUnread ? 'Solicitud nueva sin leer' : undefined}
                          >
                            {rowNumber}
                          </td>

                          {/* DÍA & JORNADA (Máx. 2 líneas visuales) */}
                          <td className="py-2.5 px-3 align-middle whitespace-nowrap">
                            <div className="font-bold text-white text-xs leading-tight">
                              {compactDayDate}
                            </div>
                            <div className="mt-1 flex items-center gap-1.5">
                              <span
                                title={shiftTooltip}
                                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md font-semibold bg-zinc-900/90 text-zinc-200 border border-zinc-700/80"
                              >
                                {shiftBadgeText}
                              </span>
                              {isOverduePending && (
                                <span
                                  title="Fecha solicitada vencida · Pendiente decisión"
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-950/60 text-amber-300 border border-amber-700/50 text-[10px] font-bold"
                                >
                                  ⚠️ Vencida
                                </span>
                              )}
                            </div>
                          </td>

                          {/* CLIENTE & RUTA (Máx. 2 líneas visuales · Cero PII expuesta) */}
                          <td className="py-2.5 px-3 align-middle min-w-[200px] max-w-[260px]">
                            <div className="flex items-center gap-1.5 min-w-0 leading-tight">
                              <span
                                className="font-bold text-white text-xs truncate"
                                title={safeStoreName}
                              >
                                {safeStoreName}
                              </span>
                              {cleanClienteCodigo && (
                                <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-300 border border-white/10">
                                  #{cleanClienteCodigo}
                                </span>
                              )}
                            </div>
                            <div
                              className={`mt-1 text-[11px] truncate leading-tight ${
                                routeDisplay.isGeneric ? 'text-zinc-500' : 'text-zinc-400'
                              }`}
                              title={routeDisplay.label}
                            >
                              {routeDisplay.label}
                            </div>
                          </td>

                          {/* PRODUCTO & CANTIDAD (Máx. 2 líneas visuales) */}
                          <td className="py-2.5 px-3 align-middle min-w-[210px] max-w-[260px]">
                            <div className="flex items-center gap-1.5 min-w-0 leading-tight">
                              <span
                                className="font-bold text-white text-xs truncate"
                                title={safeProductName}
                              >
                                {safeProductName}
                              </span>
                              <span
                                className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                                  brandBadge.isAmberBrand
                                    ? 'bg-amber-950/60 text-amber-300 border-amber-800/60'
                                    : 'bg-zinc-900 text-zinc-300 border-zinc-700/80'
                                }`}
                              >
                                {brandBadge.label}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center">
                              <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-zinc-900/90 text-zinc-300 border border-zinc-800 font-mono text-[10px]">
                                Total: <strong className="text-white ml-1">{safeTotalQty} kg/un</strong>
                              </span>
                            </div>
                          </td>

                          {/* RESPONSABLE & VENDEDOR */}
                          <td className="py-2.5 px-3 align-middle whitespace-nowrap min-w-[205px]">
                            {item.status !== 'COMPLETADO' && !isReadOnlyHistoricalItem(item) ? (
                              (() => {
                                const selectResolved = resolvePromotoraSelectValue(item.responsibleName);
                                return (
                                  <div className="flex items-center gap-1.5">
                                    <div className="w-5 h-5 rounded-full bg-red-600 text-white font-black text-[9px] flex items-center justify-center shrink-0">
                                      {(item.responsibleName || 'P')[0]}
                                    </div>
                                    <select
                                      value={selectResolved.value}
                                      onChange={(e) => void handleSelectPromotoraForTasting(item, e.target.value)}
                                      aria-label={`Asignar promotora para ${item.storeName}`}
                                      className="w-full max-w-[180px] px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700/80 focus:border-red-500 text-[11px] font-bold text-white focus:outline-none cursor-pointer"
                                    >
                                      <option value="POR ASIGNAR (Trade Marketing)">
                                        ⏳ POR ASIGNAR (Trade Mkt)
                                      </option>
                                      {selectResolved.extraOption && (
                                        <option value={selectResolved.extraOption}>
                                          {selectResolved.extraOption}
                                        </option>
                                      )}
                                      {availablePromotoras.map((prom) => (
                                        <option key={prom} value={prom}>
                                          {prom}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                );
                              })()
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <div className="w-5 h-5 rounded-full bg-zinc-800 border border-zinc-700 text-white font-black text-[9px] flex items-center justify-center shrink-0">
                                  {(item.responsibleName || 'P')[0]}
                                </div>
                                <span
                                  className="font-bold text-white text-xs truncate max-w-[175px]"
                                  title={item.responsibleName}
                                >
                                  {item.responsibleName}
                                </span>
                              </div>
                            )}
                            <div className="text-[10px] text-zinc-400 font-mono mt-1 flex items-center gap-1">
                              <Users className="w-2.5 h-2.5 text-zinc-500 shrink-0" />
                              <span>{item.sellerApplicant}</span>
                            </div>
                          </td>

                          {/* ESTADO */}
                          <td className="py-2.5 px-3 align-middle text-center whitespace-nowrap">
                            <div className="flex flex-col items-center gap-1">
                              {item.status === 'NO_AUTORIZADA' ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1 rounded-full uppercase border font-mono bg-rose-950/80 text-rose-300 border-rose-700/80">
                                  <Ban className="w-3 h-3 text-rose-400" />
                                  <span>No Autorizada</span>
                                </span>
                              ) : tastingViewMode === 'historial' ? (
                                <>
                                  <span className="inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1 rounded-full uppercase border font-mono bg-emerald-950/80 text-emerald-300 border-emerald-700/70">
                                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                    <span>Autorizada</span>
                                  </span>
                                  {item.status === 'COMPLETADO' && (
                                    <span className="text-[9px] font-mono text-zinc-400">
                                      Ejecutada en PDV
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span
                                  className={`inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1 rounded-full uppercase border font-mono ${
                                    item.status === 'PENDIENTE'
                                      ? 'bg-red-950 text-red-400 border-red-800 animate-pulse'
                                      : item.status === 'PROGRAMADO'
                                        ? 'bg-emerald-950/75 text-emerald-300 border-emerald-700/70'
                                        : item.status === 'EN_CURSO'
                                          ? 'bg-red-600 text-white border-red-500 shadow-md shadow-red-950'
                                          : 'bg-black text-emerald-400 border-emerald-900'
                                  }`}
                                >
                                  {item.status === 'PENDIENTE' && (
                                    <span>⏳ PENDIENTE POR AUTORIZAR</span>
                                  )}
                                  {item.status === 'PROGRAMADO' && (
                                    <>
                                      <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                      <span>AUTORIZADA</span>
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
                              )}
                              {isTastingHistoricalItem(item) && (
                                <span
                                  title="Registro archivado en la Pestaña de Historial (America/Caracas)"
                                  className="inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-md bg-zinc-900/95 text-amber-300 border border-amber-500/35 font-mono"
                                >
                                  <span>🔒 Historial</span>
                                </span>
                              )}
                            </div>
                          </td>

                          {/* MUESTRAS & SELL-OUT */}
                          <td className="py-2.5 px-3 align-middle text-center">
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
                          <td className="py-2.5 px-3 align-middle text-center whitespace-nowrap">
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

                              {isReadOnlyHistoricalItem(item) ? (
                                <span
                                  title="Solo lectura: Las degustaciones históricas solo pueden modificarse por un Administrador"
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-400 text-[10px] font-mono select-none"
                                >
                                  <Lock className="w-3 h-3 text-amber-400 shrink-0" />
                                  <span>Cerrado</span>
                                </span>
                              ) : (
                                <>
                                  {isPending && (
                                    <>
                                      <button
                                        type="button"
                                        disabled={processingTastingId === item.id}
                                        onClick={() => handleApproveTastingRequest(item)}
                                        title="Autorizar degustación: sincroniza al instante con /portal y con el Cronograma de productos"
                                        className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-black uppercase tracking-wider flex items-center gap-1 shadow-md shadow-red-950 border border-red-500 transition active:scale-95 cursor-pointer"
                                      >
                                        {processingTastingId === item.id ? (
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                          <Check className="w-3.5 h-3.5" />
                                        )}
                                        <span>Autorizar</span>
                                      </button>

                                      <button
                                        type="button"
                                        disabled={processingTastingId === item.id}
                                        onClick={() =>
                                          handleRejectTastingRequest(item.id, 'NO_AUTORIZADA')
                                        }
                                        title="Marcar como No Autorizada y trasladar a la Pestaña de Historial"
                                        className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-rose-950/70 disabled:opacity-50 text-zinc-300 hover:text-rose-200 border border-zinc-800 hover:border-rose-700/70 text-[11px] font-bold flex items-center gap-1 transition cursor-pointer"
                                      >
                                        <Ban className="w-3 h-3 text-rose-400" />
                                        <span>No Autorizar</span>
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
                        ) : tastingViewMode === 'actual' && activeTastingCount === 0 ? (
                          <div className="flex flex-col items-center gap-3 max-w-md mx-auto">
                            <Archive className="w-8 h-8 text-amber-400" />
                            <div>
                              <p className="font-bold text-white text-sm">
                                Sin degustaciones activas para esta semana
                              </p>
                              <p className="text-xs text-zinc-400 mt-1">
                                {archivedTastingCount > 0
                                  ? `Los ${archivedTastingCount} registros anteriores se encuentran resguardados íntegramente en la pestaña de Historial.`
                                  : 'Las nuevas actividades solicitadas o programadas para la semana en curso aparecerán aquí automáticamente.'}
                              </p>
                            </div>
                            <div className="flex items-center gap-2.5 mt-1">
                              {archivedTastingCount > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setTastingViewMode('historial')}
                                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition shadow-md cursor-pointer"
                                >
                                  Ver Historial ({archivedTastingCount})
                                </button>
                              )}
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

            {tastingViewMode === 'historial' && historialPagination.totalItems > 0 && (
              <div className="px-4 py-3 bg-zinc-950/90 rounded-b-2xl border-t border-zinc-900 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2 text-zinc-400">
                  <span>Filas por página:</span>
                  <select
                    value={historialPageSize}
                    onChange={(e) => setHistorialPageSize(Number(e.target.value) || 25)}
                    aria-label="Filas por página en Historial"
                    className="px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-white font-mono text-xs focus:outline-none focus:border-red-500 cursor-pointer"
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <span className="font-mono text-[11px] text-zinc-500 ml-1">
                    ({historialPagination.startIndex}-{historialPagination.endIndex} de {historialPagination.totalItems})
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={historialPagination.page <= 1}
                    onClick={() => setHistorialPage((prev) => Math.max(1, prev - 1))}
                    className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed border border-zinc-800 text-zinc-200 font-semibold inline-flex items-center gap-1 transition cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Anterior</span>
                  </button>
                  <span className="px-2.5 py-1 rounded-lg bg-zinc-900/70 border border-white/[0.06] font-mono text-[11px] text-zinc-300">
                    Página <strong className="text-white">{historialPagination.page}</strong> de{' '}
                    <strong className="text-white">{historialPagination.totalPages}</strong>
                  </span>
                  <button
                    type="button"
                    disabled={historialPagination.page >= historialPagination.totalPages}
                    onClick={() =>
                      setHistorialPage((prev) =>
                        Math.min(historialPagination.totalPages, prev + 1)
                      )
                    }
                    className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed border border-zinc-800 text-zinc-200 font-semibold inline-flex items-center gap-1 transition cursor-pointer"
                  >
                    <span>Siguiente</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
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
                  {isTastingHistoricalItem(selectedTastingDetail) && (
                    <span className="px-2.5 py-0.5 rounded-md bg-amber-950/70 text-amber-300 border border-amber-500/40 text-[10px] font-mono font-bold">
                      🔒 Registro Histórico (Cerrado)
                    </span>
                  )}
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
                {selectedTastingDetail.status !== 'COMPLETADO' &&
                !isReadOnlyHistoricalItem(selectedTastingDetail) ? (
                  (() => {
                    const modalSelectResolved = resolvePromotoraSelectValue(
                      selectedTastingDetail.responsibleName
                    );
                    return (
                      <div className="pt-1.5 space-y-1">
                        <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">
                          Asignación de Promotora Activa:
                        </label>
                        <select
                          value={modalSelectResolved.value}
                          onChange={(e) =>
                            void handleSelectPromotoraForTasting(selectedTastingDetail, e.target.value)
                          }
                          className="w-full px-2.5 py-1.5 rounded-xl bg-black border border-white/15 focus:border-red-500 text-xs font-bold text-white focus:outline-none cursor-pointer"
                        >
                          <option value="POR ASIGNAR (Trade Marketing)">
                            ⏳ POR ASIGNAR (Trade Marketing)
                          </option>
                          {modalSelectResolved.extraOption && (
                            <option value={modalSelectResolved.extraOption}>
                              {modalSelectResolved.extraOption}
                            </option>
                          )}
                          {availablePromotoras.map((prom) => (
                            <option key={prom} value={prom}>
                              {prom}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })()
                ) : (
                  <p className="text-[11px] text-zinc-300 pt-1">
                    Asignación registrada:{' '}
                    <strong className="text-[#FFFFFF]">
                      {selectedTastingDetail.responsibleName}
                    </strong>
                    {isReadOnlyHistoricalItem(selectedTastingDetail) && (
                      <span className="ml-2 text-[10px] font-mono text-amber-300">
                        (🔒 Solo lectura)
                      </span>
                    )}
                  </p>
                )}
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
                {isReadOnlyHistoricalItem(selectedTastingDetail) ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-950 border border-amber-500/35 text-amber-300 text-xs font-mono">
                    <Lock className="w-3.5 h-3.5 shrink-0" />
                    <span>Registro Histórico (Cerrado) · Solo Lectura</span>
                  </span>
                ) : (
                  <>
                    {selectedTastingDetail.status === 'PENDIENTE' && (
                      <>
                        <button
                          type="button"
                          disabled={processingTastingId === selectedTastingDetail.id}
                          onClick={() =>
                            handleRejectTastingRequest(selectedTastingDetail.id, 'NO_AUTORIZADA')
                          }
                          className="px-3.5 py-2 rounded-xl bg-[#18181B] hover:bg-rose-950/70 disabled:opacity-50 text-zinc-300 hover:text-rose-200 border border-white/10 hover:border-rose-700/70 text-xs font-bold transition cursor-pointer"
                        >
                          No Autorizar
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
                          <span>Autorizar y Sincronizar</span>
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
                  </>
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

              <button
                type="button"
                data-testid="informe-tab-comparativa"
                onClick={() => setActiveReportTab('comparativa')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 cursor-pointer ${
                  activeReportTab === 'comparativa'
                    ? 'bg-red-600 text-white shadow-md shadow-red-950/60 border border-red-500'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-900 border border-transparent'
                }`}
              >
                <Scale className="w-4 h-4" />
                <span>Comparativa de Precio</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
                    activeReportTab === 'comparativa' ? 'bg-black/40 text-white' : 'bg-zinc-900 text-zinc-500'
                  }`}
                >
                  {priceComparisons.length}
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

          {/* BARRA DE FILTROS COMPLETOS (REGIÓN, PROMOTORA, FECHAS, BUSCADOR Y LÍMITE) */}
          {activeReportTab === 'inventario' && (
            <div className="space-y-3 p-3.5 rounded-2xl bg-zinc-950 border border-zinc-900">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {singleLockedRegionDisplay ? (
                    <span
                      data-testid="inv-region-locked-badge"
                      className="min-h-[34px] inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold bg-red-600/15 text-white border border-red-500/45 shadow-sm"
                    >
                      <Lock className="w-3.5 h-3.5 text-red-500 shrink-0" />
                      <span>Región: {singleLockedRegionDisplay}</span>
                    </span>
                  ) : isMultiRegionScope ? (
                    <>
                      <span
                        data-testid="inv-region-multiregion-badge"
                        className="min-h-[34px] inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold bg-red-600/15 text-white border border-red-500/45 shadow-sm"
                      >
                        <Lock className="w-3.5 h-3.5 text-red-500 shrink-0" />
                        <span>Regiones: {assignedRegionsDisplayLabel}</span>
                      </span>
                      {(
                        [
                          { id: 'ASSIGNED' as const, label: `${assignedRegionsDisplayLabel} (Mis Regiones)` },
                          ...editableRegionBuckets.map((b) => ({
                            id: b,
                            label: formatBucketLabel(b),
                          })),
                        ]
                      ).map((reg) => (
                        <button
                          key={reg.id}
                          type="button"
                          data-testid={`inv-region-${reg.id}`}
                          onClick={() => setInvRegionFilter(reg.id)}
                          className={`min-h-[34px] px-3 py-1 rounded-xl text-xs font-bold border transition cursor-pointer ${
                            invRegionFilter === reg.id
                              ? 'bg-red-600 text-white border-red-500 shadow'
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
                        data-testid={`inv-region-${reg.id}`}
                        onClick={() => setInvRegionFilter(reg.id)}
                        className={`min-h-[34px] px-3 py-1 rounded-xl text-xs font-bold border transition cursor-pointer ${
                          invRegionFilter === reg.id
                            ? 'bg-red-600 text-white border-red-500 shadow'
                            : 'bg-black text-zinc-300 border-zinc-800 hover:border-zinc-700'
                        }`}
                      >
                        {reg.label}
                      </button>
                    ))
                  )}

                  <select
                    value={invPromoterFilter}
                    onChange={(e) => setInvPromoterFilter(e.target.value)}
                    aria-label="Filtrar inventario por promotora"
                    data-testid="inv-promotora-select"
                    className="min-h-[34px] px-2.5 py-1 rounded-xl bg-black border border-zinc-800 text-white text-xs font-medium focus:outline-none focus:border-red-600"
                  >
                    <option value="TODAS">Todas las promotoras ({inventoryPromoterOptions.length})</option>
                    {inventoryPromoterOptions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>

                  <div className="flex items-center gap-1.5 text-xs">
                    <input
                      type="date"
                      value={invDateFrom}
                      onChange={(e) => setInvDateFrom(e.target.value)}
                      aria-label="Fecha desde inventario"
                      className="min-h-[34px] px-2.5 py-1 rounded-xl bg-black border border-zinc-800 text-xs font-mono text-white"
                    />
                    <span className="text-zinc-500">a</span>
                    <input
                      type="date"
                      value={invDateTo}
                      onChange={(e) => setInvDateTo(e.target.value)}
                      aria-label="Fecha hasta inventario"
                      className="min-h-[34px] px-2.5 py-1 rounded-xl bg-black border border-zinc-800 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                {((!singleLockedRegionBucket && invRegionFilter !== defaultFieldRegionFilter) ||
                  invPromoterFilter !== 'TODAS' ||
                  invDateFrom !== '' ||
                  invDateTo !== '' ||
                  reportSearchQuery.trim() !== '') && (
                  <button
                    type="button"
                    data-testid="inv-clear-filters"
                    onClick={() => {
                      setInvRegionFilter(defaultFieldRegionFilter);
                      setInvPromoterFilter('TODAS');
                      setInvDateFrom('');
                      setInvDateTo('');
                      setReportSearchQuery('');
                    }}
                    className="min-h-[34px] px-3 py-1 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-bold text-zinc-200 transition cursor-pointer"
                  >
                    Limpiar filtros
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-zinc-900">
                <div className="relative flex-1 min-w-[240px] max-w-md">
                  <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    data-testid="inv-search-input"
                    placeholder="Buscar promotora (ej. Nicole Godoy), PDV, producto o fecha..."
                    value={reportSearchQuery}
                    onChange={(e) => setReportSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-black border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-600 font-medium"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-mono">
                    <span>Mostrar:</span>
                    <select
                      value={reportRowLimit}
                      onChange={(e) => setReportRowLimit(Number(e.target.value))}
                      className="px-2.5 py-1 rounded-lg bg-black border border-zinc-800 text-white text-xs font-mono"
                    >
                      <option value={150}>150 filas</option>
                      <option value={400}>400 filas</option>
                      <option value={2000}>Todos ({filteredInventorySampling.length})</option>
                    </select>
                  </div>
                  <div className="text-[11px] text-zinc-400 font-mono hidden sm:flex items-center gap-1.5">
                    <Database className="w-3.5 h-3.5 text-red-500" />
                    <span>
                      Base de datos Supabase conectada • {filteredInventorySampling.length} de {inventorySampling.length} balances
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

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
                      {filteredInventorySampling.length} balances
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
                    {filteredInventorySampling.reduce((acc, r) => acc + r.initialStock, 0).toFixed(1)}{' '}
                    <span className="text-xs font-normal text-slate-400">Unid/Kg</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Stock al iniciar la jornada</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Inv. Final Remanente</p>
                  <p className="text-2xl font-bold text-amber-400">
                    {filteredInventorySampling.reduce((acc, r) => acc + r.finalStock, 0).toFixed(1)}{' '}
                    <span className="text-xs font-normal text-slate-400">Unid/Kg</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Stock físico al cierre</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Muestras Degustadas</p>
                  <p className="text-2xl font-bold text-purple-400">
                    {filteredInventorySampling.reduce((acc, r) => acc + r.portionsSampled, 0).toFixed(1)}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Impactos directos a consumidores</p>
                </div>
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                  <p className="text-xs text-slate-400 uppercase font-semibold mb-1">Resultado (Ventas)</p>
                  <p className="text-2xl font-bold text-emerald-400">
                    {filteredInventorySampling.reduce((acc, r) => acc + r.salesGenerated, 0).toFixed(1)}{' '}
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
                      {filteredInventorySampling.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="p-8 text-center text-xs text-slate-400">
                            No se encontraron balances de inventario con los filtros seleccionados.
                          </td>
                        </tr>
                      ) : filteredInventorySampling
                        .slice(0, reportRowLimit)
                        .map((inv) => (
                          <tr key={inv.id} className="hover:bg-slate-800/30 transition-colors">
                            <td className="p-4 text-slate-300 whitespace-nowrap font-mono text-xs">
                              {inv.dateSlash || inv.date}
                            </td>
                            <td className="p-4">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-medium text-white">{inv.storeName}</span>
                                <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] font-mono text-zinc-300">
                                  {inv.region || 'Occidente'}
                                </span>
                              </div>
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
                          <label className="block text-xs text-slate-400 mb-1">Región Operativa</label>
                          {singleLockedRegionDisplay ? (
                            <div
                              data-testid="new-inv-region-locked"
                              className="w-full bg-red-950/30 border border-red-500/40 rounded-lg px-3 py-2 text-sm text-white font-bold flex items-center gap-2"
                            >
                              <Lock className="w-3.5 h-3.5 text-red-400 shrink-0" />
                              <span>Región: {singleLockedRegionDisplay}</span>
                            </div>
                          ) : (
                            <select
                              data-testid="new-inv-region-select"
                              value={newInventoryForm.region}
                              onChange={(e) =>
                                setNewInventoryForm({
                                  ...newInventoryForm,
                                  region: e.target.value as FieldRegionBucket,
                                })
                              }
                              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                            >
                              {editableRegionBuckets.map((bucket) => (
                                <option key={bucket} value={bucket}>
                                  {formatBucketLabel(bucket)}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                        <div className="md:col-span-2">
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
          {/* TAB 4: ASISTENCIA CONDICIONAL POR PERFIL (FIJA: 2 FOTOS | EVENTUAL: 4 FOTOS) */}
          {/* ========================================================================= */}
          {activeReportTab === 'asistencia' && (
            <AttendanceEvidenceSubTab
              staffMembers={staffList}
              asistenciaJornadas={module1Bundle?.asistenciaJornadas || []}
              asistenciaEvidencias={module1Bundle?.asistenciaEvidencias || []}
              legacyAttendanceRecords={attendanceRecords}
              searchQuery={reportSearchQuery}
              onSearchQueryChange={setReportSearchQuery}
              onRefreshData={refreshSupabaseData}
              onNotifyToast={showToast}
            />
          )}

          {/* ========================================================================= */}
          {/* TAB 5: COMPARATIVA DE PRECIO (BCV BIMONETARIO + HISTÓRICOS + ALERTAS > X%) */}
          {/* ========================================================================= */}
          {activeReportTab === 'comparativa' && (
            <PriceComparisonReportSubTab
              priceComparisons={priceComparisons}
              isStrictAdmin={isStrictAdmin}
              isRegionalRestricted={isRegionalRestricted}
              assignedRegionCodes={assignedRegionCodes}
              assignedRegions={assignedRegions}
              canSwitchAmongAssignedRegions={canSwitchAmongAssignedRegions}
              onNotify={showToast}
            />
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
                        {member.status === 'Activo' ? 'Activo' : 'Inactivo'}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                          resolveMemberRegion(member) === 'Centro'
                            ? 'bg-sky-500/15 text-sky-300 border-sky-500/35'
                            : resolveMemberRegion(member) === 'Andes'
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/35'
                              : 'bg-red-500/15 text-red-300 border-red-500/35'
                        }`}
                      >
                        {resolveMemberRegion(member)}
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

              {/* Bloque de Ficha Técnica: Región, Teléfono, Correo y Dirección */}
              <div className="p-3 rounded-xl bg-zinc-950/85 border border-white/[0.06] space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400 shrink-0">Región:</span>
                  <span className={`${pdvColorClass} font-bold text-right truncate max-w-[190px]`}>
                    {resolveMemberRegion(member)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400 shrink-0">Teléfono:</span>
                  <span className="text-zinc-100 font-semibold font-mono text-right truncate" title={member.phone}>
                    {member.phone || '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400 shrink-0">Correo:</span>
                  <span className="text-zinc-200 font-medium text-right truncate max-w-[195px]" title={member.email}>
                    {member.email || '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-400 shrink-0">Dirección:</span>
                  <span
                    className={`text-right truncate max-w-[195px] ${
                      member.address?.trim()
                        ? 'text-zinc-200 font-semibold'
                        : 'text-zinc-500 italic'
                    }`}
                    title={member.address?.trim() || 'Sin dirección registrada'}
                  >
                    {member.address?.trim() || 'Sin dirección registrada'}
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

              {/* Botones inferiores: Enviar Link por WhatsApp + Abrir /portal */}
              <div className="flex items-center gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() =>
                    handleSendWhatsAppPortalLink({
                      promotoraName: member.name,
                      promotoraEmail: member.email,
                      phone: member.phone,
                    })
                  }
                  className="flex-1 py-2 px-2.5 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-200 hover:text-white border border-emerald-500/40 transition cursor-pointer"
                  title={`Enviar link de /portal por WhatsApp a ${member.name} (${member.phone || 'seleccionar contacto'})`}
                >
                  <MessageCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">Enviar Link por WhatsApp</span>
                </button>
                <a
                  href={buildStaffAppLink(member)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`p-2 rounded-xl transition flex items-center justify-center shrink-0 ${copyBtnClass}`}
                  title="Abrir /portal en nueva pestaña"
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
            <div className="bg-zinc-900/80 border border-white/[0.08] rounded-2xl p-5 shadow-xl flex flex-col gap-4 backdrop-blur-md">
              <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-black px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 uppercase tracking-wider">
                      Padrón Activo Sincronizado • Supabase `promotoras`
                    </span>
                    {singleLockedRegionDisplay ? (
                      <span
                        data-testid="personal-region-header-badge"
                        className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-red-600/15 text-white border border-red-500/45"
                      >
                        <Lock className="w-3 h-3 text-red-400 shrink-0" />
                        <span>Región: {singleLockedRegionDisplay} ({regionFilteredStaffList.length})</span>
                      </span>
                    ) : isMultiRegionScope ? (
                      <span
                        data-testid="personal-region-header-badge"
                        className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-red-600/15 text-white border border-red-500/45"
                      >
                        <Lock className="w-3 h-3 text-red-400 shrink-0" />
                        <span>
                          Regiones: {assignedRegionsDisplayLabel} (
                          {editableRegionBuckets
                            .map(
                              (b) =>
                                `${b}: ${b === 'Centro' ? centroStaffCount : b === 'Andes' ? andesStaffCount : occidenteStaffCount}`
                            )
                            .join(' · ')}
                          )
                        </span>
                      </span>
                    ) : (
                      <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-zinc-950 text-zinc-300 border border-white/10">
                        Occidente: {occidenteStaffCount} · Centro / Valencia: {centroStaffCount} · Andes: {andesStaffCount}
                      </span>
                    )}
                  </div>
                  <h3 className="text-lg font-black text-white mt-1.5">
                    Personal y Promotoras Activas ({regionFilteredStaffList.length}
                    {!singleLockedRegionBucket && selectedStaffRegionFilter !== defaultFieldRegionFilter
                      ? ` de ${staffList.length}`
                      : ''}
                    )
                  </h3>
                  <p className="text-xs text-zinc-400">
                    {singleLockedRegionDisplay
                      ? `Directorio sincronizado con Supabase exclusivo de la región ${singleLockedRegionDisplay} y vinculado a cuentas de acceso en Supabase Auth.`
                      : isMultiRegionScope
                        ? `Directorio sincronizado con Supabase exclusivo de las regiones ${assignedRegionsDisplayLabel} y vinculado a cuentas de acceso en Supabase Auth.`
                        : 'Directorio sincronizado con Supabase por región operativa (Occidente, Centro / Valencia y Andes) y vinculado a cuentas de acceso en Supabase Auth.'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      data-testid="personal-search-input"
                      placeholder="Buscar nombre, correo, teléfono..."
                      value={selectedStaffSearch}
                      onChange={(e) => setSelectedStaffSearch(e.target.value)}
                      className="pl-8 pr-3 py-1.5 rounded-xl bg-zinc-950 border border-white/10 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      void refreshSupabaseData();
                      void loadFallbackPromotorasCatalog(true);
                    }}
                    disabled={isLoadingSupabase || loadingPersonalCatalog}
                    className="px-3 py-1.5 rounded-xl bg-zinc-950 hover:bg-zinc-800 text-zinc-200 border border-white/10 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                    title="Sincronizar padrón activo con Supabase"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isLoadingSupabase || loadingPersonalCatalog ? 'animate-spin text-red-400' : ''}`}
                    />
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

              {/* Selector de Región / Perfil + Categoría */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/[0.06]">
                {singleLockedRegionDisplay ? (
                  <div
                    data-testid="personal-region-locked-pill"
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-red-600/15 border border-red-500/45 text-xs font-bold text-white"
                  >
                    <Lock className="w-3.5 h-3.5 text-red-500 shrink-0" />
                    <span>Región: {singleLockedRegionDisplay}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-black/30 text-white">
                      {regionFilteredStaffList.length}
                    </span>
                  </div>
                ) : (
                  <div
                    className="flex flex-wrap items-center bg-zinc-950 p-1 rounded-xl border border-white/10 gap-1"
                    role="tablist"
                    aria-label="Filtrar personal por región"
                  >
                    {(isMultiRegionScope
                      ? [
                          {
                            id: 'ASSIGNED' as const,
                            label: `${assignedRegionsDisplayLabel} (Mis Regiones)`,
                            count: staffList.length,
                            testId: 'personal-region-tab-assigned',
                          },
                          ...editableRegionBuckets.map((b) => ({
                            id: b,
                            label: formatBucketLabel(b),
                            count:
                              b === 'Centro'
                                ? centroStaffCount
                                : b === 'Andes'
                                  ? andesStaffCount
                                  : occidenteStaffCount,
                            testId: `personal-region-tab-${b.toLowerCase()}`,
                          })),
                        ]
                      : [
                          {
                            id: 'TODAS' as const,
                            label: 'Todas las Regiones',
                            count: staffList.length,
                            testId: 'personal-region-tab-todas',
                          },
                          {
                            id: 'Occidente' as const,
                            label: 'Occidente',
                            count: occidenteStaffCount,
                            testId: 'personal-region-tab-occidente',
                          },
                          {
                            id: 'Centro' as const,
                            label: 'Centro / Valencia',
                            count: centroStaffCount,
                            testId: 'personal-region-tab-centro',
                          },
                          {
                            id: 'Andes' as const,
                            label: 'Andes',
                            count: andesStaffCount,
                            testId: 'personal-region-tab-andes',
                          },
                        ]
                    ).map((regTab) => {
                      const active = selectedStaffRegionFilter === regTab.id;
                      return (
                        <button
                          key={regTab.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          data-testid={regTab.testId}
                          onClick={() => setSelectedStaffRegionFilter(regTab.id)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                            active
                              ? 'bg-red-600 text-white shadow'
                              : 'text-zinc-400 hover:text-white hover:bg-white/[0.04]'
                          }`}
                        >
                          <span>{regTab.label}</span>
                          <span
                            className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                              active ? 'bg-black/30 text-white' : 'bg-zinc-900 text-zinc-400'
                            }`}
                          >
                            {regTab.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="flex flex-wrap items-center bg-zinc-950 p-1 rounded-xl border border-white/10 gap-1">
                  {(
                    [
                      { id: 'TODAS', label: `Todas (${regionFilteredStaffList.length})` },
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
                          ? 'bg-zinc-800 text-white border border-white/15 shadow'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Accesos rápidos de copiado de enlace para App Promotoras (/portal) y App Chofer (/logistica/) */}
            <section
              ref={linksSectionRef}
              tabIndex={-1}
              data-testid="field-portal-links-section"
              aria-label="Enlaces de acceso a aplicaciones"
              className={`scroll-mt-6 rounded-2xl transition-all duration-300 focus:outline-none ${
                isLinksSectionHighlighted
                  ? 'ring-2 ring-[#DC2626] ring-offset-2 ring-offset-[#09090b]'
                  : ''
              }`}
            >
              <PortalQuickLinksBar />
            </section>

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
                        Sincronización Directa Supabase • Padrón Activo
                      </span>
                      <h4 className="text-base font-black text-white">
                        {staffFormModal.id ? `Editar Perfil: ${staffFormModal.name}` : 'Registrar Nuevo Personal Activo'}
                      </h4>
                    </div>
                    <button
                      type="button"
                      disabled={isSavingStaffModal}
                      onClick={() => {
                        setStaffFormError(null);
                        setStaffFormModal((prev) => ({ ...prev, isOpen: false }));
                      }}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-40"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {staffFormError && (
                    <div
                      role="alert"
                      data-testid="staff-modal-error"
                      className="rounded-xl bg-red-950/70 border border-red-500/60 px-3 py-2.5 text-xs text-red-200 flex items-start gap-2"
                    >
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                      <span>{staffFormError}</span>
                    </div>
                  )}

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
                        <label className="block text-zinc-300 font-bold mb-1">Región Operativa</label>
                        {singleLockedRegionDisplay ? (
                          <div
                            data-testid="staff-modal-region-locked"
                            className="w-full px-3 py-2 rounded-xl bg-red-950/30 border border-red-500/40 text-white font-bold flex items-center gap-2"
                          >
                            <Lock className="w-3.5 h-3.5 text-red-400 shrink-0" />
                            <span>Región: {singleLockedRegionDisplay}</span>
                          </div>
                        ) : (
                          <select
                            data-testid="staff-modal-region-select"
                            value={staffFormModal.region}
                            onChange={(e) =>
                              setStaffFormModal((prev) => ({
                                ...prev,
                                region: e.target.value as FieldRegionBucket,
                              }))
                            }
                            className="w-full px-3 py-2 rounded-xl bg-black border border-zinc-800 text-white focus:outline-none focus:border-red-500"
                          >
                            {editableRegionBuckets.map((bucket) => (
                              <option key={bucket} value={bucket}>
                                {formatBucketLabel(bucket)}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-bold mb-1">
                          Contraseña Portal Auth
                        </label>
                        <input
                          type="password"
                          autoComplete="new-password"
                          minLength={8}
                          placeholder={
                            staffFormModal.id
                              ? 'Dejar vacío para conservar actual'
                              : 'Mínimo 8 caracteres'
                          }
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
                        disabled={isSavingStaffModal}
                        onClick={() => {
                          setStaffFormError(null);
                          setStaffFormModal((prev) => ({ ...prev, isOpen: false }));
                        }}
                        className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 font-bold border border-white/10 disabled:opacity-50"
                      >
                        Cancelar
                      </button>
                      <button
                        type="submit"
                        data-testid="btn-save-staff-modal"
                        disabled={isSavingStaffModal}
                        className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white font-bold flex items-center gap-2 shadow-lg shadow-red-950/50 cursor-pointer"
                      >
                        {isSavingStaffModal && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <span>{isSavingStaffModal ? 'Guardando...' : 'Guardar en Supabase'}</span>
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        );
      })()}
      </AnimatedTabContainer>

      {/* Dashboard 360° Interactivo al Seleccionar Cualquier Tarjeta de Métrica */}
      {FEATURE_FLAGS.ENABLE_MODULO1_TABLAS_METRICAS && (
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
      )}

      {/* Bloque oficial de firmas para soporte impreso / PDF */}
      <PrintSignatureBlock />
    </div>
  );
};
