import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  User,
  UserRole,
  Store,
  ScheduledVisit,
  ControllerRequest,
  TastingExecutionReport,
  InventoryReconciliation,
  AuditLogEntry,
  DiscrepancyAlert,
  FiscalReceipt,
  ShiftType,
  DegustacionNotificationItem,
  SolicitudProductoContraloria,
} from '../types';
import {
  useDegustacionesNotifications,
  UseDegustacionesNotificationsResult,
} from '../hooks/useDegustacionesNotifications';
import { useCronogramaRealtimeSync } from '../hooks/useCronogramaRealtimeSync';
import { useMasterData, type UseMasterDataResult } from '../hooks/useMasterData';
import {
  useMasterEntitiesSync,
  type UseMasterEntitiesSyncResult,
} from '../hooks/useMasterEntitiesSync';
import { clearMasterCatalogCaches } from '../services/masterCatalogSyncService';
import {
  purgeAllSessionCaches,
  sanitizeLegacyRegionalStorage,
} from '../services/sessionCacheHygiene';
import {
  normalizeRegionName,
  type AllowedRegionCode,
} from '../utils/regionalSyncClassifier';
import { FEATURE_FLAGS } from '../config/featureFlags';
import {
  useSolicitudesContraloria,
  UseSolicitudesContraloriaResult,
} from '../hooks/useSolicitudesContraloria';
import {
  fetchAllModule1FromSupabase,
  formatDayLabelEs,
  getTodayVeYmd,
  Module1SupabaseBundle,
  StaffMemberRecord,
  canonicalStaffKey,
  canonicalizeActivePromoterOrNull,
  isRemovedOrInactivePromoterToken,
} from '../services/supabaseModule1';
import {
  buildBatchFillPlan,
  buildMatrixUpsertRowFromVisit,
  classifyVisitsForLogicalCancel,
  isRealUuid,
  mergeMasterStoresWithFallback,
  persistMatrixLogicalCancel,
  persistMatrixUpsertBatch,
  resolveRealPromotoraForMatrix,
} from '../services/scheduleMatrixService';
import { isSupabaseConfigured, setActiveClientSucursalHeader } from '../services/supabaseClient';
import { clearMasterDataCaches } from '../services/masterDataSyncService';
import {
  DEFAULT_OFFICIAL_REGIONES,
  fetchActiveRegiones,
  type ActiveRegionItem,
} from '../services/regionesService';
import {
  calculateProductionSupplies,
  normalizeProductionShift,
  ProductionSuppliesResult,
} from '../utils/productionSuppliesCalculator';
import {
  getCaracasTodayYmd,
  getCaracasWeekCycleBounds,
  getMsUntilNextCaracasMidnight,
  MAX_SAFE_TIMEOUT_MS,
} from '../utils/caracasWeekCycle';
import { isStrictAdminRole } from '../services/degustacionesWeeklyCycleService';
import {
  SUCURSAL_LABELS,
  isOperativeSucursal,
  normalizeSucursalCodigo,
  type ManagedUserRole,
  type OperativeSucursal,
  type SucursalCodigo,
} from '../services/userManagementService';
import type {
  CampanaTrade,
  CampanaTradeInput,
  CertificadoPazYSalvo,
  PazYSalvoVerificationResult,
  PresupuestoTrade,
  PresupuestoTradeInput,
  TarifarioCostoTrade,
  TarifarioCostoTradeInput,
} from '../types/contraloriaFinancial';
import {
  DEFAULT_AUDIT_LOG_PAGE_SIZE,
  DEFAULT_DISCREPANCY_ALERT_PAGE_SIZE,
  computeAuditIntegrityHash,
  executeOptimisticAppendWithRollback,
  executeOptimisticUpdateWithRollback,
  fetchAuditLogsPage,
  fetchDiscrepancyAlertsPage,
  persistAuditLogEntry,
  persistDiscrepancyAlert,
  resolveActiveRegionContext,
  resolveDiscrepancyAlertInSupabase,
  type PersistDiscrepancyAlertInput,
} from '../services/auditAndAlertsService';
import {
  createFiscalReceiptMetadataInSupabase,
  createRequisitionInSupabase,
  fetchContraloriaFinancialBundle,
  fetchFiscalReceiptSignedUrls,
  issuePazYSalvoInSupabase,
  transitionRequisitionInSupabase,
  updateReconciliationInSupabase,
  uploadFiscalReceiptWithBinary,
  upsertCampanaTrade,
  upsertPresupuestoTrade,
  upsertTarifarioCostoTrade,
  validateFiscalReceiptInSupabase,
  verifyPazYSalvoInSupabase,
} from '../services/contraloriaFinancialService';

export type SyncState = 'sincronizando' | 'sincronizado' | 'tiempo_real' | 'error';

export interface SyncStatus {
  state: SyncState;
  errorMessage: string | null;
  /** ISO de la última sincronización correcta del paquete de datos principal */
  lastSyncAt: string | null;
}

export interface ClearVisitsCriteria {
  mode: 'FILTERED' | 'ALL';
  storeIds?: string[];
  product?: string;
  shift?: ShiftType;
  date?: string;
}

export interface UpsertVisitFromTastingParams {
  solicitudId: string;
  cronogramaId?: string;
  degustacionId?: string;
  date: string;
  dayLabel?: string;
  shift?: ShiftType;
  timeRange?: string;
  storeName: string;
  clienteCodigo?: string;
  zone: string;
  productName: string;
  requestedQty: number | string;
  targetSamples?: number;
  sellerName: string;
  promotoraId?: string;
  promotoraName?: string;
  mapsUrl?: string;
  notes?: string;
}

export interface UpsertVisitFromTastingResult {
  visit: ScheduledVisit;
  isUpdate: boolean;
  assignedPromotora: string;
  supplies: ProductionSuppliesResult;
}

export interface MatrixMutationResult {
  ok: boolean;
  error?: string;
  reverted?: boolean;
}

export interface ClearVisitsBatchResult extends MatrixMutationResult {
  removed: number;
  preservedNonPending: number;
}

export interface BatchFillClientsResult extends MatrixMutationResult {
  countUpdated: number;
  countCreated: number;
}

export interface AppContextType {
  currentUser: User | null;
  currentRole: UserRole;
  setCurrentRole: (role: UserRole) => void;
  /** Rol autorizado del usuario autenticado (ej. `'coordinador_trade'`, `'super_admin'`, `'promotora'`) */
  role: string | null;
  /** Región operativa singular cuando el usuario está acotado a una sola región (`'Occidente' | 'Centro' | 'Andes' | null`) */
  assignedRegion: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' | null;
  /** Etiquetas legibles de TODAS las regiones asignadas (`['Centro', 'Andes']`, `['Occidente']`, o `[]` para Admin Global) */
  assignedRegions: string[];
  /** Códigos oficiales normalizados de las regiones asignadas (`['CENTRO', 'ANDES']`, `['OCCIDENTE']`, o `[]` para Admin Global) */
  assignedRegionCodes: AllowedRegionCode[];
  /** Verdadero cuando la sesión está restringida estrictamente a 1 o más regiones (ej. Grecia -> Occidente, María -> Centro y Andes) */
  isRegionalRestricted: boolean;
  /** Verdadero cuando un usuario regional tiene >= 2 regiones asignadas y puede alternar exclusivamente entre ellas (ej. María -> Centro y Andes) */
  canSwitchAmongAssignedRegions: boolean;
  /** Rol IAM verificado en public.profiles ('super_admin' | 'contraloria' | 'coordinacion' | 'vendedor' | 'promotora' | 'cliente' | 'chofer' | null) */
  verifiedIamRole: ManagedUserRole | null;
  /** Sede verificada en public.profiles ('ZULIA' | 'VALENCIA' | 'CENTRO' | 'ORIENTE' | 'CAPITAL' | 'GLOBAL' | null) */
  verifiedSucursal: SucursalCodigo | null;
  /** UUID de `public.regiones` asignado al usuario en BD (null para `super_admin` o usuario regional pendiente) */
  verifiedRegionId: string | null;
  /** Catálogo dinámico de regiones autorizadas (`public."Regiones"`: OCCIDENTE, CENTRO, ANDES) */
  activeRegiones: ActiveRegionItem[];
  /** Alcance regional oficial activo (`ALL` | `ASSIGNED` | `OCCIDENTE` | `CENTRO` | `ANDES` | null) */
  activeRegionScope: AllowedRegionCode | 'ALL' | 'ASSIGNED' | null;
  /** Selecciona una región oficial permitida (`ALL` solo Global, `ASSIGNED` multi-región, o una región autorizada), purga caché y recarga */
  setActiveRegionScope: (region: AllowedRegionCode | 'ALL' | 'ASSIGNED') => void;
  /** Sucursal operativa compatible en sesión (traducida desde la región oficial) */
  activeSucursal: OperativeSucursal | null;
  /** Etiqueta corporativa legible de la región activa */
  activeSucursalLabel: string;
  /** Verdadero únicamente para `super_admin` y `contraloria` (`GLOBAL`) */
  canSwitchSucursal: boolean;
  /** Verdadero cuando un perfil nacional (`super_admin` / `contraloria` GLOBAL) aún no ha elegido una Sucursal Activa */
  requiresSucursalSelection: boolean;
  /** Selecciona una Sucursal Activa, inyecta `x-sucursal-activa`, purga la caché operativa y recarga en limpio */
  setActiveSucursal: (sucursal: OperativeSucursal) => void;
  /** Purga de forma inmediata toda caché operativa en memoria al cambiar de sucursal o sesión */
  purgeRegionalStateCache: () => void;
  /** Verdadero únicamente para usuarios con rol estricto de Administrador (`super_admin` / `admin`) */
  isStrictAdmin: boolean;
  /** Verdadero para usuarios con autoridad de Contraloría Interna o Super Admin (Segregación de Funciones) */
  isContraloriaOrAdmin: boolean;
  /** Verdadero para usuarios de operación Trade Marketing (Super Admin, Coordinación, Supervisión) */
  isTradeOpsRole: boolean;
  /** Lunes `YYYY-MM-DD` de inicio de la semana ISO en curso evaluada en `America/Caracas` */
  caracasWeekStartYmd: string;
  users: User[];
  stores: Store[];
  /** Fuente Única de Verdad de Maestros (`public.clientes`, `public.vendedores`, `public.cadenas_comerciales`, `public.zonas`) */
  masterData: UseMasterDataResult;
  /** Sincronización Realtime BD <-> Pantallas de las 5 entidades maestras (`regiones`, `productos`, `supervisores`, `promotoras`, cuarentena) */
  masterEntities: UseMasterEntitiesSyncResult;
  visits: ScheduledVisit[];
  requests: ControllerRequest[];
  tastingReports: TastingExecutionReport[];
  reconciliation: InventoryReconciliation;
  auditLogs: AuditLogEntry[];
  isLoadingAuditLogs: boolean;
  auditLogsError: string | null;
  hasMoreAuditLogs: boolean;
  refreshAuditLogs: () => Promise<void>;
  loadMoreAuditLogs: () => Promise<void>;
  discrepancyAlerts: DiscrepancyAlert[];
  isLoadingDiscrepancyAlerts: boolean;
  discrepancyAlertsError: string | null;
  hasMoreDiscrepancyAlerts: boolean;
  refreshDiscrepancyAlerts: () => Promise<void>;
  loadMoreDiscrepancyAlerts: () => Promise<void>;
  createDiscrepancyAlert: (
    input: Omit<PersistDiscrepancyAlertInput, 'regionId' | 'regionCode' | 'sucursal'>
  ) => Promise<{ success: boolean; data?: DiscrepancyAlert; error?: string }>;
  resolveDiscrepancyAlert: (
    alertId: string,
    resolutionNotes?: string
  ) => Promise<{ success: boolean; data?: DiscrepancyAlert; error?: string }>;

  // Datos sincronizados desde Supabase para el Módulo 1 y Módulo 2
  module1Bundle: Module1SupabaseBundle | null;
  isLoadingSupabase: boolean;
  supabaseError: string | null;
  refreshSupabaseData: () => Promise<void>;

  /** Estado global de sincronización (módulos 1-4 + notificaciones + solicitudes) */
  syncStatus: SyncStatus;
  /** Verdadero cuando el canal Realtime de `cronograma_degustaciones` está suscrito en vivo */
  isCronogramaRealtimeConnected: boolean;
  /** Sincroniza manualmente TODAS las fuentes (Supabase, maestros, degustaciones y solicitudes de contraloría) */
  refreshAll: () => Promise<void>;

  // Notificaciones en tiempo real de Degustaciones enviadas por Vendedores (Globito + Detalle)
  degustacionNotifications: UseDegustacionesNotificationsResult;
  focusedTastingId: string | null;
  setFocusedTastingId: (id: string | null) => void;
  focusedTastingSnapshot: DegustacionNotificationItem | null;
  setFocusedTastingSnapshot: (item: DegustacionNotificationItem | null) => void;

  // Flujo en tiempo real Trade Marketing <-> Contraloría Interna ("SOLICITUD DE PRODUCTOS")
  solicitudesContraloria: UseSolicitudesContraloriaResult;

  // Datos financieros persistidos en Supabase (Hito 4: Campañas, Presupuestos, Tarifario, Conciliaciones, Paz y Salvo)
  campanasTrade: CampanaTrade[];
  presupuestosTrade: PresupuestoTrade[];
  tarifarioCostos: TarifarioCostoTrade[];
  conciliacionesByReqId: Record<string, InventoryReconciliation>;
  certificadosPazYSalvo: Record<string, CertificadoPazYSalvo>;
  isLoadingFinancial: boolean;
  refreshFinancialData: () => Promise<void>;
  selectReconciliationForRequest: (reqId: string) => void;
  saveCampanaTrade: (
    input: CampanaTradeInput
  ) => Promise<{ success: boolean; message: string; data?: CampanaTrade }>;
  savePresupuestoTrade: (
    input: PresupuestoTradeInput
  ) => Promise<{ success: boolean; message: string; data?: PresupuestoTrade }>;
  saveTarifarioCosto: (
    input: TarifarioCostoTradeInput
  ) => Promise<{ success: boolean; message: string; data?: TarifarioCostoTrade }>;
  verifyPazYSalvoCertificate: (code: string) => Promise<PazYSalvoVerificationResult>;

  // Actions
  advanceRequisitionWorkflow: (
    requestId: string,
    nextStatus: any,
    justification?: string,
    comments?: string
  ) => Promise<{ success: boolean; message: string }>;
  createRequisition: (
    req: Partial<ControllerRequest>
  ) => Promise<{ success: boolean; message: string; requisicion?: ControllerRequest }>;
  addFiscalReceipt: (
    receipt: Omit<FiscalReceipt, 'id' | 'isValidatedByContraloria'>,
    file?: File | Blob | null
  ) => Promise<{ success: boolean; message: string }>;
  validateFiscalReceipt: (
    receiptId: string,
    isValid: boolean,
    notes?: string
  ) => Promise<{ success: boolean; message: string }>;
  updateReconciliation: (
    updates: Partial<InventoryReconciliation>,
    options?: { persist?: boolean }
  ) => Promise<{ success: boolean; message: string }>;
  closeReconciliationAndIssuePazYSalvo: (
    notes: string
  ) => Promise<{ success: boolean; message: string; certificado?: CertificadoPazYSalvo }>;
  updateVisit: (
    visitId: string,
    updates: Partial<ScheduledVisit>,
    options?: { persist?: boolean }
  ) => Promise<MatrixMutationResult>;
  updateVisitFromProductFill: (
    visitId: string,
    product: string,
    quantityInput: string
  ) => Promise<MatrixMutationResult>;
  addVisit: (visit: Omit<ScheduledVisit, 'id'>) => Promise<MatrixMutationResult & { visit?: ScheduledVisit }>;
  deleteVisit: (visitId: string, motivo?: string) => Promise<MatrixMutationResult>;
  deleteVisitsByIds: (
    visitIds: string[],
    motivo?: string
  ) => Promise<MatrixMutationResult & { removed: number; preservedHistorical: number }>;
  clearVisitsBatch: (criteria: ClearVisitsCriteria) => Promise<ClearVisitsBatchResult>;
  batchFillClientsProductShift: (params: {
    storeIds: string[];
    product: string;
    products?: string[];
    quantityInput: string;
    shift: ShiftType;
    dayLabel: string;
    date?: string;
    promotoraName?: string;
    promotoraEmail?: string;
    sellerName?: string;
    notes?: string;
  }) => Promise<BatchFillClientsResult>;
  upsertVisitFromApprovedTasting: (
    params: UpsertVisitFromTastingParams
  ) => UpsertVisitFromTastingResult;
  removeVisitByTastingRequest: (
    solicitudId: string,
    degustacionId?: string,
    justification?: string
  ) => boolean;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Estado SOLO de sesión (memoria): el cronograma sincronizado se re-lee de Supabase; aquí solo se recuerda,
// mientras la página siga abierta, qué filas retiró el usuario para que un refresco no las reintroduzca.
// No se guarda nada en localStorage/sessionStorage (ver services/cleanSync.ts).
const sessionDeletedVisitIds = new Set<string>();
let sessionVisitsCleared = false;

function getDeletedVisitIds(): Set<string> {
  return sessionDeletedVisitIds;
}

function recordDeletedVisitIds(ids: Iterable<string>) {
  for (const id of ids) {
    if (id) sessionDeletedVisitIds.add(String(id));
  }
}

function unrecordDeletedVisitIds(ids: Iterable<string | undefined>) {
  for (const id of ids) {
    if (id) sessionDeletedVisitIds.delete(String(id));
  }
  sessionVisitsCleared = false;
}

function markVisitsCleared() {
  sessionVisitsCleared = true;
}

function isVisitsCleared(): boolean {
  return sessionVisitsCleared;
}

/** Hash SHA-256 real (hex) del contenido de una entrada de bitácora. */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Estructura de conciliación vacía (sin datos): se completa únicamente con lo que el usuario registre. */
const EMPTY_RECONCILIATION: InventoryReconciliation = {
  requestId: '',
  requestCode: '',
  productName: '',
  deliveredUnits: 0,
  degustatedUnitsReported: 0,
  returnedRemanentUnits: 0,
  discrepancyUnits: 0,
  discrepancyStatus: 'CUADRADO',
  returnWarehouseReceiptNumber: '',
  receipts: [],
  totalExpensesReportedUsd: 0,
  approvedPettyCashUsd: 0,
  balanceDueCompanyOrPromotorUsd: 0,
  auditNotes: '',
  pazYSalvoIssued: false,
};

function buildProductFields(product: string, quantityInput: string, targetSamples?: number) {
  const calc = calculateProductionSupplies(product, quantityInput, targetSamples);
  return {
    productFocus: calc.productFocus,
    fillProductSelection: calc.fillProductSelection,
    fillQuantityInput: calc.fillQuantityInput,
    mortadelaQty: calc.mortadelaQty,
    espaldaQty: calc.espaldaQty,
    arrozQty: calc.arrozQty,
    azucarGrams: calc.azucarGrams,
    lecheGrams: calc.lecheGrams,
    plannedUnits: calc.plannedUnits,
    rowHighlight: calc.rowHighlight,
    additionalGoods: calc.additionalGoods,
    operationalSupplies: calc.operationalSupplies,
  };
}

function sanitizeVisitsAgainstActiveStaff(
  rawVisits: ScheduledVisit[],
  activeStaff?: StaffMemberRecord[]
): ScheduledVisit[] {
  if (!Array.isArray(rawVisits)) return [];
  const activeMerchKeys = new Set(
    (activeStaff || []).filter((s) => s.category === 'merchandising').map((s) => s.canonicalKey)
  );
  const result: ScheduledVisit[] = [];

  for (const v of rawVisits) {
    if (!v || typeof v !== 'object') continue;
    const rawProm = String(v.promotoraName || '').trim();
    const upperProm = rawProm.toUpperCase();

    if (
      !rawProm ||
      upperProm.startsWith('POR ASIGNAR') ||
      upperProm.startsWith('SIN ASIGNAR')
    ) {
      result.push({
        ...v,
        promotoraName: 'POR ASIGNAR (Trade Marketing)',
      });
      continue;
    }

    if (isRemovedOrInactivePromoterToken(rawProm)) {
      // Descartar registros de sesión antiguos asociados a personal retirado/inactivo
      continue;
    }

    const canonicalActive = canonicalizeActivePromoterOrNull(rawProm, undefined, activeStaff);
    if (!canonicalActive) {
      // Preservar degustaciones ya persistidas en BD (`cronograma_degustaciones`) para evitar pérdida tras F5
      if (v.cronogramaId) {
        result.push(v);
      }
      continue;
    }

    if (
      canonicalActive.category === 'merchandising' ||
      activeMerchKeys.has(canonicalStaffKey(canonicalActive.name))
    ) {
      result.push({
        ...v,
        promotoraName: 'POR ASIGNAR (Trade Marketing)',
      });
      continue;
    }

    result.push({
      ...v,
      promotoraName: canonicalActive.name,
    });
  }

  return result;
}

export const AppProvider: React.FC<{
  children: React.ReactNode;
  verifiedProfile?: {
    userId: string;
    email: string;
    displayName: string;
    appRole?: string | null;
    rawAppRole?: string | null;
    iamRole?: ManagedUserRole | null;
    sucursal?: SucursalCodigo | null;
    regionId?: string | null;
    regionLabel?: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' | null;
    assignedRegions?: AllowedRegionCode[];
    assignedRegionLabels?: string[];
    legacyRole: UserRole;
  } | null;
}> = ({ children, verifiedProfile = null }) => {
  // Todas las listas arrancan VACÍAS y solo se llenan con datos sincronizados (Supabase) o registrados por el usuario en la sesión.
  const [users, setUsers] = useState<User[]>([]);
  const [currentRole, setCurrentRole] = useState<UserRole>(
    verifiedProfile?.legacyRole || 'jefe_trade'
  );
  const [caracasWeekStartYmd, setCaracasWeekStartYmd] = useState<string>(
    () => getCaracasWeekCycleBounds().inicioSemanaActualYmd
  );
  const lastFocusRevalidationMsRef = useRef<number>(Date.now());
  const verifiedIamRole: ManagedUserRole | null = verifiedProfile?.iamRole ?? null;
  const verifiedSucursal: SucursalCodigo | null = verifiedProfile?.sucursal ?? null;
  const verifiedRegionId: string | null = verifiedProfile?.regionId ?? null;
  const [activeRegiones, setActiveRegiones] = useState<ActiveRegionItem[]>(() =>
    DEFAULT_OFFICIAL_REGIONES.map((item) => ({ ...item }))
  );
  const [selectedNationalSucursal, setSelectedNationalSucursal] =
    useState<OperativeSucursal | null>(null);
  const [selectedNationalRegionScope, setSelectedNationalRegionScope] = useState<
    AllowedRegionCode | 'ALL' | null
  >(() =>
    verifiedProfile &&
    (verifiedProfile.iamRole === 'super_admin' ||
      (verifiedProfile.iamRole === 'contraloria' &&
        (verifiedProfile.sucursal === 'GLOBAL' || verifiedProfile.sucursal === null)))
      ? 'ALL'
      : null
  );
  const [selectedAssignedRegionScope, setSelectedAssignedRegionScope] = useState<
    AllowedRegionCode | 'ASSIGNED'
  >('ASSIGNED');
  const [isMasterCachePurged, setIsMasterCachePurged] = useState<boolean>(false);

  // Higiene automática de `localStorage`/`sessionStorage` legado (ZULIA / 5 sedes / cachés vacíos)
  useEffect(() => {
    sanitizeLegacyRegionalStorage();
  }, []);

  const canSwitchSucursal = Boolean(
    verifiedProfile &&
      (verifiedIamRole === 'super_admin' ||
        (verifiedIamRole === 'contraloria' &&
          (verifiedSucursal === 'GLOBAL' || verifiedSucursal === null)))
  );

  const isRegionalRestricted = Boolean(verifiedProfile && !canSwitchSucursal);

  const role: string | null = verifiedProfile
    ? (verifiedProfile.rawAppRole || verifiedIamRole || verifiedProfile.appRole || null)
    : null;

  const assignedRegionCodes: AllowedRegionCode[] = useMemo(() => {
    if (!isRegionalRestricted) return [];
    const list: AllowedRegionCode[] = [];
    const pushCode = (raw: unknown) => {
      const code = normalizeRegionName(raw);
      if (code && !list.includes(code)) list.push(code);
    };
    if (Array.isArray(verifiedProfile?.assignedRegions)) {
      for (const r of verifiedProfile!.assignedRegions!) pushCode(r);
    }
    if (list.length === 0 && verifiedRegionId) {
      const hit = activeRegiones.find((r) => r.id === verifiedRegionId);
      if (hit) pushCode(hit.codigo);
    }
    if (list.length === 0 && verifiedProfile?.regionLabel) {
      pushCode(verifiedProfile.regionLabel);
    }
    if (list.length === 0 && verifiedSucursal) {
      pushCode(verifiedSucursal);
    }
    return list;
  }, [
    isRegionalRestricted,
    verifiedProfile?.assignedRegions,
    verifiedRegionId,
    activeRegiones,
    verifiedProfile?.regionLabel,
    verifiedSucursal,
  ]);

  const assignedRegions: string[] = useMemo(() => {
    if (!isRegionalRestricted) return [];
    return assignedRegionCodes.map((code) =>
      code === 'CENTRO' ? 'Centro' : code === 'ANDES' ? 'Andes' : 'Occidente'
    );
  }, [isRegionalRestricted, assignedRegionCodes]);

  const canSwitchAmongAssignedRegions = Boolean(
    isRegionalRestricted && assignedRegionCodes.length >= 2
  );

  const lockedRegionalSucursal: OperativeSucursal | null =
    !canSwitchSucursal &&
    !canSwitchAmongAssignedRegions &&
    verifiedSucursal &&
    isOperativeSucursal(verifiedSucursal)
      ? verifiedSucursal
      : null;

  const lockedRegionalOfficial: AllowedRegionCode | null = useMemo(() => {
    if (canSwitchSucursal) return null;
    if (assignedRegionCodes.length === 1) return assignedRegionCodes[0]!;
    if (assignedRegionCodes.length > 1) return null;
    if (verifiedRegionId) {
      const hit = activeRegiones.find((r) => r.id === verifiedRegionId);
      const norm = hit ? normalizeRegionName(hit.codigo) : null;
      if (norm) return norm;
    }
    if (verifiedProfile?.regionLabel) {
      const norm = normalizeRegionName(verifiedProfile.regionLabel);
      if (norm) return norm;
    }
    return normalizeRegionName(verifiedSucursal);
  }, [
    canSwitchSucursal,
    assignedRegionCodes,
    verifiedRegionId,
    activeRegiones,
    verifiedProfile?.regionLabel,
    verifiedSucursal,
  ]);

  const assignedRegion: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' | null = useMemo(() => {
    if (!isRegionalRestricted || assignedRegionCodes.length !== 1) return null;
    const onlyCode = assignedRegionCodes[0]!;
    if (onlyCode === 'OCCIDENTE') return 'Occidente';
    if (onlyCode === 'ANDES') return 'Andes';
    return verifiedProfile?.regionLabel === 'Valencia' ? 'Valencia' : 'Centro';
  }, [isRegionalRestricted, assignedRegionCodes, verifiedProfile?.regionLabel]);

  const scopedActiveRegiones: ActiveRegionItem[] = useMemo(() => {
    if (!isRegionalRestricted || assignedRegionCodes.length === 0) return activeRegiones;
    const matched = activeRegiones.filter((r) => {
      const code = normalizeRegionName(r.codigo);
      return Boolean(code && assignedRegionCodes.includes(code));
    });
    return matched.length > 0 ? matched : activeRegiones;
  }, [activeRegiones, isRegionalRestricted, assignedRegionCodes]);

  const activeRegionScope: AllowedRegionCode | 'ALL' | 'ASSIGNED' | null = canSwitchSucursal
    ? selectedNationalRegionScope
    : canSwitchAmongAssignedRegions
      ? selectedAssignedRegionScope === 'ASSIGNED' ||
        assignedRegionCodes.includes(selectedAssignedRegionScope)
        ? selectedAssignedRegionScope
        : 'ASSIGNED'
      : lockedRegionalOfficial;

  const activeSucursal: OperativeSucursal | null = canSwitchSucursal
    ? selectedNationalSucursal
    : canSwitchAmongAssignedRegions
      ? activeRegionScope === 'CENTRO'
        ? 'CENTRO'
        : activeRegionScope === 'OCCIDENTE'
          ? 'ZULIA'
          : null
      : lockedRegionalSucursal;

  const requiresSucursalSelection: boolean =
    canSwitchSucursal && activeRegionScope === null && activeSucursal === null;

  const activeSucursalLabel: string = useMemo(() => {
    if (activeRegionScope === 'ALL') {
      return 'Todas las Regiones';
    }
    if (activeRegionScope === 'ASSIGNED') {
      return assignedRegions.length > 0 ? assignedRegions.join(' y ') : 'Mis Regiones';
    }
    if (activeRegionScope) {
      return `Región ${activeRegionScope}`;
    }
    if (activeSucursal) {
      const mapped = normalizeRegionName(activeSucursal);
      if (mapped) return `Región ${mapped}`;
      if (isOperativeSucursal(activeSucursal)) {
        return SUCURSAL_LABELS[activeSucursal];
      }
      const matched = activeRegiones.find((r) => r.codigo === activeSucursal);
      return matched?.label || `Región ${activeSucursal}`;
    }
    return requiresSucursalSelection ? 'Selección de Región Pendiente' : 'Todas las Regiones';
  }, [activeRegionScope, assignedRegions, activeSucursal, activeRegiones, requiresSucursalSelection]);

  const activeSucursalRef = useRef<OperativeSucursal | null>(activeSucursal);
  activeSucursalRef.current = activeSucursal;
  const assignedRegionRef = useRef<'Occidente' | 'Valencia' | 'Centro' | 'Andes' | null>(assignedRegion);
  assignedRegionRef.current = assignedRegion;
  const assignedRegionCodesRef = useRef<AllowedRegionCode[]>(assignedRegionCodes);
  assignedRegionCodesRef.current = assignedRegionCodes;
  const requiresSucursalSelectionRef = useRef<boolean>(requiresSucursalSelection);
  requiresSucursalSelectionRef.current = requiresSucursalSelection;

  // Sincronizar cabecera `x-sucursal-activa` antes de cualquier carga de datos hija
  useEffect(() => {
    setActiveClientSucursalHeader(activeSucursal);
  }, [activeSucursal]);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let cancelled = false;
    void fetchActiveRegiones()
      .then((rows) => {
        if (!cancelled && rows.length > 0) {
          setActiveRegiones(rows);
        }
      })
      .catch(() => {
        // Conserva DEFAULT_FIVE_REGIONES si está sin conexión
      });
    return () => {
      cancelled = true;
    };
  }, [verifiedProfile?.userId]);

  const isStrictAdmin = verifiedProfile
    ? verifiedIamRole === 'super_admin' || isStrictAdminRole(verifiedProfile.appRole)
    : isStrictAdminRole(currentRole);
  const isContraloriaOrAdmin = verifiedProfile
    ? verifiedIamRole === 'super_admin' || verifiedIamRole === 'contraloria'
    : currentRole === 'analista_contraloria' || currentRole === 'gerente_admin';
  const isTradeOpsRole = verifiedProfile
    ? verifiedIamRole === 'super_admin' || verifiedIamRole === 'coordinacion'
    : true;
  const [currentUser, setCurrentUser] = useState<User | null>(
    verifiedProfile
      ? {
          id: verifiedProfile.userId,
          name: verifiedProfile.displayName,
          email: verifiedProfile.email,
          role: verifiedProfile.legacyRole,
        }
      : null
  );

  useEffect(() => {
    if (verifiedProfile) {
      setCurrentRole(verifiedProfile.legacyRole);
      setCurrentUser({
        id: verifiedProfile.userId,
        name: verifiedProfile.displayName,
        email: verifiedProfile.email,
        role: verifiedProfile.legacyRole,
      });
    } else {
      setCurrentUser(null);
    }
  }, [verifiedProfile]);

  const [fallbackStores, setFallbackStores] = useState<Store[]>([]);
  const [visits, setVisits] = useState<ScheduledVisit[]>([]);
  const [requests, setRequests] = useState<ControllerRequest[]>([]);
  const [tastingReports] = useState<TastingExecutionReport[]>([]);
  const [reconciliation, setReconciliation] = useState<InventoryReconciliation>(EMPTY_RECONCILIATION);
  const [conciliacionesByReqId, setConciliacionesByReqId] = useState<
    Record<string, InventoryReconciliation>
  >({});
  const [certificadosPazYSalvo, setCertificadosPazYSalvo] = useState<
    Record<string, CertificadoPazYSalvo>
  >({});
  const [campanasTrade, setCampanasTrade] = useState<CampanaTrade[]>([]);
  const [presupuestosTrade, setPresupuestosTrade] = useState<PresupuestoTrade[]>([]);
  const [tarifarioCostos, setTarifarioCostos] = useState<TarifarioCostoTrade[]>([]);
  const [isLoadingFinancial, setIsLoadingFinancial] = useState<boolean>(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [isLoadingAuditLogs, setIsLoadingAuditLogs] = useState<boolean>(false);
  const [auditLogsError, setAuditLogsError] = useState<string | null>(null);
  const [hasMoreAuditLogs, setHasMoreAuditLogs] = useState<boolean>(false);
  const auditLogsOffsetRef = useRef<number>(0);

  const [discrepancyAlerts, setDiscrepancyAlerts] = useState<DiscrepancyAlert[]>([]);
  const [isLoadingDiscrepancyAlerts, setIsLoadingDiscrepancyAlerts] = useState<boolean>(false);
  const [discrepancyAlertsError, setDiscrepancyAlertsError] = useState<string | null>(null);
  const [hasMoreDiscrepancyAlerts, setHasMoreDiscrepancyAlerts] = useState<boolean>(false);
  const discrepancyAlertsOffsetRef = useRef<number>(0);

  const resolveCurrentAuditRegion = useCallback(async () => {
    return resolveActiveRegionContext({
      activeSucursal: activeSucursalRef.current,
      verifiedRegionId,
    });
  }, [verifiedRegionId]);

  const refreshAuditLogs = useCallback(async () => {
    if (!isSupabaseConfigured || requiresSucursalSelectionRef.current) {
      setIsLoadingAuditLogs(false);
      return;
    }
    setIsLoadingAuditLogs(true);
    setAuditLogsError(null);
    try {
      const { regionId } = await resolveCurrentAuditRegion();
      const page = await fetchAuditLogsPage({
        regionId,
        limit: DEFAULT_AUDIT_LOG_PAGE_SIZE,
        offset: 0,
      });
      setAuditLogs(page.items);
      auditLogsOffsetRef.current = page.nextOffset;
      setHasMoreAuditLogs(page.hasMore);
    } catch (err) {
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : 'No se pudo cargar la bitácora de auditoría desde Supabase.';
      setAuditLogsError(msg);
    } finally {
      setIsLoadingAuditLogs(false);
    }
  }, [resolveCurrentAuditRegion]);

  const loadMoreAuditLogs = useCallback(async () => {
    if (!isSupabaseConfigured || requiresSucursalSelectionRef.current || isLoadingAuditLogs || !hasMoreAuditLogs) {
      return;
    }
    setIsLoadingAuditLogs(true);
    setAuditLogsError(null);
    try {
      const { regionId } = await resolveCurrentAuditRegion();
      const page = await fetchAuditLogsPage({
        regionId,
        limit: DEFAULT_AUDIT_LOG_PAGE_SIZE,
        offset: auditLogsOffsetRef.current,
      });
      setAuditLogs((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const appended = page.items.filter((item) => !seen.has(item.id));
        return [...prev, ...appended];
      });
      auditLogsOffsetRef.current = page.nextOffset;
      setHasMoreAuditLogs(page.hasMore);
    } catch (err) {
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : 'No se pudieron cargar más registros de auditoría.';
      setAuditLogsError(msg);
    } finally {
      setIsLoadingAuditLogs(false);
    }
  }, [hasMoreAuditLogs, isLoadingAuditLogs, resolveCurrentAuditRegion]);

  const refreshDiscrepancyAlerts = useCallback(async () => {
    if (!isSupabaseConfigured || requiresSucursalSelectionRef.current) {
      setIsLoadingDiscrepancyAlerts(false);
      return;
    }
    setIsLoadingDiscrepancyAlerts(true);
    setDiscrepancyAlertsError(null);
    try {
      const { regionId } = await resolveCurrentAuditRegion();
      const page = await fetchDiscrepancyAlertsPage({
        regionId,
        limit: DEFAULT_DISCREPANCY_ALERT_PAGE_SIZE,
        offset: 0,
      });
      setDiscrepancyAlerts(page.items);
      discrepancyAlertsOffsetRef.current = page.nextOffset;
      setHasMoreDiscrepancyAlerts(page.hasMore);
    } catch (err) {
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : 'No se pudieron cargar las alertas de discrepancia desde Supabase.';
      setDiscrepancyAlertsError(msg);
    } finally {
      setIsLoadingDiscrepancyAlerts(false);
    }
  }, [resolveCurrentAuditRegion]);

  const loadMoreDiscrepancyAlerts = useCallback(async () => {
    if (
      !isSupabaseConfigured ||
      requiresSucursalSelectionRef.current ||
      isLoadingDiscrepancyAlerts ||
      !hasMoreDiscrepancyAlerts
    ) {
      return;
    }
    setIsLoadingDiscrepancyAlerts(true);
    setDiscrepancyAlertsError(null);
    try {
      const { regionId } = await resolveCurrentAuditRegion();
      const page = await fetchDiscrepancyAlertsPage({
        regionId,
        limit: DEFAULT_DISCREPANCY_ALERT_PAGE_SIZE,
        offset: discrepancyAlertsOffsetRef.current,
      });
      setDiscrepancyAlerts((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const appended = page.items.filter((item) => !seen.has(item.id));
        return [...prev, ...appended];
      });
      discrepancyAlertsOffsetRef.current = page.nextOffset;
      setHasMoreDiscrepancyAlerts(page.hasMore);
    } catch (err) {
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : 'No se pudieron cargar más alertas de discrepancia.';
      setDiscrepancyAlertsError(msg);
    } finally {
      setIsLoadingDiscrepancyAlerts(false);
    }
  }, [hasMoreDiscrepancyAlerts, isLoadingDiscrepancyAlerts, resolveCurrentAuditRegion]);

  useEffect(() => {
    void refreshAuditLogs();
    void refreshDiscrepancyAlerts();
  }, [refreshAuditLogs, refreshDiscrepancyAlerts, activeSucursal, verifiedProfile?.userId]);

  const reconciliationRef = useRef<InventoryReconciliation>(reconciliation);
  useEffect(() => {
    reconciliationRef.current = reconciliation;
  }, [reconciliation]);

  const refreshFinancialData = useCallback(async () => {
    if (!isSupabaseConfigured || requiresSucursalSelectionRef.current) {
      setIsLoadingFinancial(false);
      return;
    }
    setIsLoadingFinancial(true);
    try {
      const bundle = await fetchContraloriaFinancialBundle();
      setCampanasTrade(bundle.campanas);
      setPresupuestosTrade(bundle.presupuestos);
      setTarifarioCostos(bundle.tarifario);
      setCertificadosPazYSalvo(bundle.certificadosByReqId);
      setRequests(bundle.requisiciones);

      // Resolver URLs firmadas de corta duración para facturas con archivo privado
      const allFacturaIdsWithFile: string[] = [];
      Object.values(bundle.conciliacionesByReqId).forEach((conc) => {
        conc.receipts.forEach((r) => {
          if (r.storagePath && isRealUuid(r.id)) {
            allFacturaIdsWithFile.push(r.id);
          }
        });
      });

      let signedUrlMap: Record<string, string> = {};
      if (allFacturaIdsWithFile.length > 0) {
        signedUrlMap = await fetchFiscalReceiptSignedUrls(allFacturaIdsWithFile.slice(0, 50)).catch(
          () => ({})
        );
      }

      const hydratedConcMap: Record<string, InventoryReconciliation> = {};
      for (const [reqId, conc] of Object.entries(bundle.conciliacionesByReqId)) {
        hydratedConcMap[reqId] = {
          ...conc,
          receipts: conc.receipts.map((r) => ({
            ...r,
            imageUrl: signedUrlMap[r.id] || r.imageUrl || '',
          })),
        };
      }
      setConciliacionesByReqId(hydratedConcMap);

      const currentReqId = reconciliationRef.current.requestId;
      const targetReq =
        (currentReqId && hydratedConcMap[currentReqId]) ||
        (bundle.requisiciones[0]?.id ? hydratedConcMap[bundle.requisiciones[0].id] : undefined);
      if (targetReq) {
        setReconciliation(targetReq);
      }
    } catch {
      // Si las tablas de Hito 4 aún no se aplican en remoto, conserva el estado actual sin romper la sesión
    } finally {
      setIsLoadingFinancial(false);
    }
  }, []);

  useEffect(() => {
    void refreshFinancialData();
  }, [refreshFinancialData]);

  const selectReconciliationForRequest = useCallback(
    (reqId: string) => {
      const found = conciliacionesByReqId[reqId];
      if (found) {
        setReconciliation(found);
        return;
      }
      const reqObj = requests.find((r) => r.id === reqId);
      if (reqObj) {
        setReconciliation({
          ...EMPTY_RECONCILIATION,
          requestId: reqObj.id,
          requestCode: reqObj.requestCode,
          productName: reqObj.items[0]?.productName || reqObj.campaignOrPurpose,
          deliveredUnits: reqObj.totalUnits,
          discrepancyUnits: reqObj.totalUnits,
          discrepancyStatus: reqObj.totalUnits === 0 ? 'CUADRADO' : 'MERMA_NO_JUSTIFICADA',
        });
      }
    },
    [conciliacionesByReqId, requests]
  );

  // Fuente Única de Verdad de Maestros (`public."Clientes"`, vendedores, cadenas, zonas)
  // Acotada automáticamente a las regiones permitidas (`ALL`, `ASSIGNED` -> `regions[]`, o región puntual)
  const filtrosClientesPorSede = useMemo(() => {
    if (activeRegionScope === 'ALL') return undefined;
    if (activeRegionScope === 'ASSIGNED') {
      return assignedRegionCodes.length > 0 ? { regions: assignedRegionCodes } : undefined;
    }
    if (activeRegionScope) return { region: activeRegionScope };
    return activeSucursal ? { sucursal: activeSucursal } : undefined;
  }, [activeRegionScope, assignedRegionCodes, activeSucursal]);
  const filtrosVendedoresPorSede = useMemo(() => {
    if (activeRegionScope === 'ALL') return undefined;
    if (activeRegionScope === 'ASSIGNED') {
      return assignedRegionCodes.length > 0 ? { regions: assignedRegionCodes } : undefined;
    }
    if (activeRegionScope) return { region: activeRegionScope };
    return activeSucursal ? { sucursal: activeSucursal } : undefined;
  }, [activeRegionScope, assignedRegionCodes, activeSucursal]);

  const rawMasterData = useMasterData({
    filtrosClientes: filtrosClientesPorSede,
    filtrosVendedores: filtrosVendedoresPorSede,
    cargarVendedores: true,
    cargarClientes: true,
    cargarCadenas: true,
    cargarZonas: true,
    suscribirCambiosRealtime: true,
    deshabilitado: requiresSucursalSelection,
  });

  const isRegionalUserWithoutRegion = Boolean(
    verifiedProfile &&
      !canSwitchSucursal &&
      assignedRegionCodes.length === 0 &&
      !lockedRegionalSucursal &&
      !verifiedRegionId &&
      !lockedRegionalOfficial
  );

  const masterEntities = useMasterEntitiesSync({
    disabled: isRegionalUserWithoutRegion || (requiresSucursalSelection && verifiedIamRole !== 'super_admin'),
    enableRealtime: true,
    scopeKey: `${verifiedProfile?.userId ?? 'local'}:${activeRegionScope ?? activeSucursal ?? 'ALL'}`,
    clientesSnapshot: rawMasterData.clientes,
  });

  // Sincronizar catálogo real de promotoras (`public.promotoras`) hacia `users` para Módulo 2
  useEffect(() => {
    const activeProms = (masterEntities.promotoras || []).filter((p) => {
      if (p.activo === false) return false;
      const catLower = String(p.categoria || '').toLowerCase();
      return !catLower.includes('merch');
    });
    if (activeProms.length === 0) return;

    setUsers((prev) => {
      const nonPromotoras = prev.filter((u) => u.role !== 'promotora');
      const byKey = new Map<string, User>();
      for (const existing of prev) {
        if (existing.role !== 'promotora') continue;
        const k = canonicalStaffKey(existing.name, existing.email);
        if (k) byKey.set(k, existing);
      }
      for (const p of activeProms) {
        const cleanName = String(p.nombre_completo || '').trim();
        if (!cleanName) continue;
        const cleanEmail = String(p.email || '').trim().toLowerCase();
        const k = canonicalStaffKey(cleanName, cleanEmail);
        if (!k) continue;
        const existing = byKey.get(k);
        byKey.set(k, {
          id: existing?.id || String(p.id),
          name: cleanName,
          email: cleanEmail || existing?.email || '',
          role: 'promotora',
          assignedZone: String(p.direccion || p.ciudad || p.region || existing?.assignedZone || ''),
        });
      }
      return [...Array.from(byKey.values()), ...nonPromotoras];
    });
  }, [masterEntities.promotoras]);

  useEffect(() => {
    if (rawMasterData.ultimaActualizacionIso && !requiresSucursalSelection) {
      setIsMasterCachePurged(false);
    }
  }, [rawMasterData.ultimaActualizacionIso, requiresSucursalSelection]);

  const masterData: UseMasterDataResult = useMemo(() => {
    if (requiresSucursalSelection || isMasterCachePurged) {
      return {
        ...rawMasterData,
        vendedores: [],
        clientes: [],
        cadenas: [],
        zonas: [],
        stores: [],
      };
    }
    return rawMasterData;
  }, [rawMasterData, requiresSucursalSelection, isMasterCachePurged]);

  const stores = useMemo(
    () =>
      requiresSucursalSelection || isMasterCachePurged
        ? []
        : mergeMasterStoresWithFallback(masterData.stores, fallbackStores),
    [masterData.stores, fallbackStores, requiresSucursalSelection, isMasterCachePurged]
  );

  const visitsRef = useRef<ScheduledVisit[]>(visits);
  useEffect(() => {
    visitsRef.current = visits;
  }, [visits]);

  // Estado de sincronización con Supabase (Módulo 1 y Módulo 2)
  const [module1Bundle, setModule1Bundle] = useState<Module1SupabaseBundle | null>(null);
  const [isLoadingSupabase, setIsLoadingSupabase] = useState<boolean>(
    () => !requiresSucursalSelection
  );
  const [supabaseError, setSupabaseError] = useState<string | null>(null);
  const [focusedTastingId, setFocusedTastingId] = useState<string | null>(null);
  const [focusedTastingSnapshot, setFocusedTastingSnapshot] =
    useState<DegustacionNotificationItem | null>(null);

  const refreshSupabaseData = useCallback(async () => {
    if (requiresSucursalSelectionRef.current) {
      setIsLoadingSupabase(false);
      return;
    }
    setIsLoadingSupabase(true);
    setSupabaseError(null);
    try {
      const bundle = await fetchAllModule1FromSupabase(undefined, {
        assignedRegion: assignedRegionRef.current,
        assignedRegions:
          assignedRegionCodesRef.current.length > 0 ? assignedRegionCodesRef.current : null,
      });
      setModule1Bundle(bundle);

      // Sincronizar exclusivamente promotoras activas reales (Plantilla Fija + Eventual) desde Supabase
      if (bundle.staffMembers) {
        setUsers((prev) => {
          const nonPromotoras = prev.filter((u) => u.role !== 'promotora');
          const seen = new Set<string>();
          const realPromotoras: User[] = [];
          bundle.staffMembers
            .filter((sm) => sm.status === 'Activo' && sm.category !== 'merchandising')
            .forEach((sm, idx) => {
              const key = sm.canonicalKey || canonicalStaffKey(sm.name);
              if (!key || seen.has(key)) return;
              seen.add(key);
              realPromotoras.push({
                id: sm.id || `usr_sup_prom_${idx + 1}`,
                name: sm.name.trim(),
                email: sm.email || '',
                role: 'promotora',
                assignedZone: sm.address || '',
              });
            });
          return [...realPromotoras, ...nonPromotoras];
        });
      }

      // Complementar catálogo con PDVs descubiertos en operaciones que aún no existan en `public.clientes`
      setFallbackStores((prev) => {
        const existingNames = new Set(prev.map((s) => s.name.trim().toUpperCase()));
        const extraStores: Store[] = [];
        const registerCandidate = (name?: string, zone?: string, seller?: string) => {
          const clean = String(name || '').trim();
          if (!clean || clean === 'PDV Sin Nombre') return;
          const upper = clean.toUpperCase();
          if (existingNames.has(upper)) return;
          existingNames.add(upper);
          extraStores.push({
            id: `st_sup_${prev.length + extraStores.length + 1}`,
            name: clean,
            clientCode: '',
            address: String(zone || '').trim(),
            zone: String(zone || '').trim(),
            city: '',
            // Sin coordenadas inventadas: la geolocalización solo existe si el dato sincronizado la trae.
            latitude: null,
            longitude: null,
            geofenceRadiusMeters: 0,
            sellerName: String(seller || '')
              .replace(/\s*\(Vendedor FDV\)/i, '')
              .trim(),
            channel: '',
          });
        };

        bundle.tastingItems.forEach((t) =>
          registerCandidate(t.storeName, t.zone, t.sellerApplicant)
        );
        bundle.inventorySampling.forEach((inv) => registerCandidate(inv.storeName, inv.zone));
        return extraStores.length > 0 ? [...prev, ...extraStores] : prev;
      });

      setVisits((prev) => {
        const deletedIds = getDeletedVisitIds();
        const isCleared = isVisitsCleared();
        const activeTastingIds = new Set(bundle.tastingItems.map((t) => t.id));
        const activeDegustacionIds = new Set(
          bundle.tastingItems
            .map((t) => t.degustacionId)
            .filter((d): d is string => Boolean(d))
        );

        const sanitizedPrev = sanitizeVisitsAgainstActiveStaff(prev, bundle.staffMembers).filter(
          (v) => {
            if (deletedIds.has(v.id)) return false;
            if (v.solicitudId && deletedIds.has(v.solicitudId)) return false;
            // Si la fila proviene de una solicitud de degustación de Supabase y ya no está en tastingItems (fue rechazada/cancelada), retirarla
            const isSupabaseLinked = Boolean(v.solicitudId) || !String(v.id).startsWith('vis_');
            if (isSupabaseLinked) {
              const solKey = v.solicitudId || v.id;
              const stillActiveById = activeTastingIds.has(solKey);
              const stillActiveByDeg =
                Boolean(v.degustacionId) && activeDegustacionIds.has(v.degustacionId!);
              if (!stillActiveById && !stillActiveByDeg) {
                return false;
              }
            }
            return true;
          }
        );

        if (isCleared) {
          return sanitizedPrev;
        }

        const merged = [...sanitizedPrev];
        for (const sv of bundle.visitsForSchedule) {
          if (deletedIds.has(sv.id) || (sv.solicitudId && deletedIds.has(sv.solicitudId))) {
            continue;
          }
          const matchIdx = merged.findIndex(
            (v) =>
              v.id === sv.id ||
              (sv.solicitudId && (v.solicitudId === sv.solicitudId || v.id === sv.solicitudId)) ||
              (sv.degustacionId && v.degustacionId && v.degustacionId === sv.degustacionId)
          );
          if (matchIdx >= 0) {
            const current = merged[matchIdx];
            merged[matchIdx] = {
              ...sv,
              ...current,
              id: current.id,
              solicitudId: current.solicitudId || sv.solicitudId || sv.id,
              degustacionId: current.degustacionId || sv.degustacionId,
              enHistorial: Boolean(sv.enHistorial ?? current.enHistorial ?? false),
              archivadoEn: sv.archivadoEn ?? current.archivadoEn ?? null,
              motivoArchivo: sv.motivoArchivo ?? current.motivoArchivo ?? null,
              operationalSupplies: current.operationalSupplies || sv.operationalSupplies,
            };
          } else {
            merged.push(sv);
          }
        }
        return merged;
      });
    } catch {
      setSupabaseError('Error de conexión con Supabase');
    } finally {
      setIsLoadingSupabase(false);
    }
  }, []);

  useEffect(() => {
    refreshSupabaseData();
  }, [refreshSupabaseData]);

  // Hook reactivo de notificaciones en tiempo real de Degustaciones (Vendedores -> Trade Marketing)
  const degustacionNotifications = useDegustacionesNotifications({
    onRealtimeChange: () => {
      void refreshSupabaseData();
    },
  });

  // Suscripción Realtime directa a `cronograma_degustaciones` y `rutas_promotoras` (Módulo 1 <-> Módulo 2 <-> /portal)
  const cronogramaRealtime = useCronogramaRealtimeSync({
    onRealtimeChange: () => {
      void refreshSupabaseData();
    },
  });

  // Revalidación automática en sesión activa en `America/Caracas` (`UTC-4`):
  // - Al cruzar medianoche Caracas (`00:00:00.000` diario) para trasladar solicitudes vencidas a Historial (`No Autorizada`).
  // - Y al recuperar foco/visibilidad de la ventana.
  useEffect(() => {
    let rolloverTimerId: number | undefined;
    let lastCaracasDayYmd = getCaracasTodayYmd();

    const triggerActiveSessionRolloverSync = (forceRefresh: boolean) => {
      const bounds = getCaracasWeekCycleBounds();
      const currentDayYmd = bounds.todayCaracasYmd;
      let periodChanged = false;

      if (currentDayYmd !== lastCaracasDayYmd) {
        lastCaracasDayYmd = currentDayYmd;
        periodChanged = true;
      }

      setCaracasWeekStartYmd((prev) => {
        if (prev !== bounds.inicioSemanaActualYmd) {
          periodChanged = true;
          return bounds.inicioSemanaActualYmd;
        }
        return prev;
      });

      const nowMs = Date.now();
      const cooldownElapsed = nowMs - lastFocusRevalidationMsRef.current >= 20_000;
      if (periodChanged || forceRefresh || cooldownElapsed) {
        lastFocusRevalidationMsRef.current = nowMs;
        void refreshSupabaseData();
        void degustacionNotifications.reloadNotifications();
      }
    };

    const scheduleNextCaracasRollover = () => {
      if (rolloverTimerId !== undefined) {
        window.clearTimeout(rolloverTimerId);
      }
      const bounds = getCaracasWeekCycleBounds();
      setCaracasWeekStartYmd((prev) =>
        prev !== bounds.inicioSemanaActualYmd ? bounds.inicioSemanaActualYmd : prev
      );
      const msUntilNextBoundary = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
        ? bounds.msUntilNextRollover
        : getMsUntilNextCaracasMidnight();
      const waitMs = Math.min(MAX_SAFE_TIMEOUT_MS, Math.max(100, msUntilNextBoundary + 50));
      rolloverTimerId = window.setTimeout(() => {
        triggerActiveSessionRolloverSync(true);
        scheduleNextCaracasRollover();
      }, waitMs);
    };

    scheduleNextCaracasRollover();

    const handleWindowFocus = () => {
      triggerActiveSessionRolloverSync(false);
      scheduleNextCaracasRollover();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerActiveSessionRolloverSync(false);
        scheduleNextCaracasRollover();
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (rolloverTimerId !== undefined) {
        window.clearTimeout(rolloverTimerId);
      }
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshSupabaseData, degustacionNotifications.reloadNotifications]);

  useEffect(() => {
    if (verifiedProfile) {
      setCurrentRole(verifiedProfile.legacyRole);
      setCurrentUser({
        id: verifiedProfile.userId,
        name: verifiedProfile.displayName,
        email: verifiedProfile.email,
        role: verifiedProfile.legacyRole,
      });
      return;
    }
    // Sin usuarios sincronizados no hay usuario actual (no se inventa ninguno).
    const user = users.find((u) => u.role === currentRole) || users[0] || null;
    setCurrentUser(user);
  }, [currentRole, users, verifiedProfile]);

  const addAuditLog = (
    entityType: AuditLogEntry['entityType'],
    entityId: string,
    action: string,
    previousState?: string,
    newState?: string,
    justification?: string
  ) => {
    const tempId = `log_tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const nowIso = new Date().toISOString();
    const actorId = currentUser?.id ?? '';
    const actorName = currentUser?.name ?? '';
    const actorRole = currentUser?.role ?? currentRole;

    const optimisticEntry: AuditLogEntry = {
      id: tempId,
      timestamp: nowIso,
      entityType,
      entityId,
      action,
      userId: actorId,
      userName: actorName,
      userRole: actorRole,
      ipAddress: '',
      previousState,
      newState,
      justification,
      integrityHash: '',
    };

    if (!isSupabaseConfigured) {
      // Sin backend Supabase configurado: conserva trazabilidad local con hash SHA-256 real
      setAuditLogs((prev) => [optimisticEntry, ...prev]);
      void computeAuditIntegrityHash({
        id: tempId,
        timestamp: nowIso,
        entityType,
        entityId,
        action,
        userId: actorId,
        previousState,
        newState,
        justification,
      }).then((hash) => {
        if (!hash) return;
        setAuditLogs((prev) =>
          prev.map((e) => (e.id === tempId ? { ...e, integrityHash: hash } : e))
        );
      });
      return;
    }

    setAuditLogsError(null);
    void executeOptimisticAppendWithRollback<AuditLogEntry>({
      tempItem: optimisticEntry,
      updateState: setAuditLogs,
      persist: async () => {
        const { regionId, regionCode } = await resolveCurrentAuditRegion();
        const persisted = await persistAuditLogEntry({
          entityType,
          entityId,
          action,
          actorId: actorId || null,
          actorName,
          actorRole,
          previousState,
          newState,
          justification,
          regionId,
          regionCode,
          sucursal: activeSucursalRef.current,
        });
        auditLogsOffsetRef.current += 1;
        return persisted;
      },
      onError: (msg) => {
        setAuditLogsError(msg);
        console.error('[AppContext] Rollback al persistir audit_logs:', msg);
      },
    });
  };

  const createDiscrepancyAlert = useCallback(
    async (
      input: Omit<PersistDiscrepancyAlertInput, 'regionId' | 'regionCode' | 'sucursal'>
    ): Promise<{ success: boolean; data?: DiscrepancyAlert; error?: string }> => {
      const tempId = `alert_tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const optimisticAlert: DiscrepancyAlert = {
        id: tempId,
        severity: input.severity,
        title: input.title,
        description: input.description,
        entityCode: input.entityCode,
        timestamp: new Date().toISOString(),
        detectedByRule: input.detectedByRule,
        resolved: false,
      };

      if (!isSupabaseConfigured) {
        setDiscrepancyAlerts((prev) => [optimisticAlert, ...prev]);
        return { success: true, data: optimisticAlert };
      }

      setDiscrepancyAlertsError(null);
      const outcome = await executeOptimisticAppendWithRollback<DiscrepancyAlert>({
        tempItem: optimisticAlert,
        updateState: setDiscrepancyAlerts,
        persist: async () => {
          const { regionId, regionCode } = await resolveCurrentAuditRegion();
          const persisted = await persistDiscrepancyAlert({
            ...input,
            regionId,
            regionCode,
            sucursal: activeSucursalRef.current,
          });
          discrepancyAlertsOffsetRef.current += 1;
          return persisted;
        },
        onError: (msg) => {
          setDiscrepancyAlertsError(msg);
          console.error('[AppContext] Rollback al persistir discrepancy_alerts:', msg);
        },
      });

      return outcome.ok
        ? { success: true, data: outcome.data }
        : { success: false, error: outcome.error };
    },
    [resolveCurrentAuditRegion]
  );

  const resolveDiscrepancyAlert = useCallback(
    async (
      alertId: string,
      resolutionNotes = ''
    ): Promise<{ success: boolean; data?: DiscrepancyAlert; error?: string }> => {
      if (!isSupabaseConfigured) {
        let updated: DiscrepancyAlert | undefined;
        setDiscrepancyAlerts((prev) =>
          prev.map((a) => {
            if (a.id !== alertId) return a;
            updated = { ...a, resolved: true, resolutionNotes };
            return updated;
          })
        );
        return updated
          ? { success: true, data: updated }
          : { success: false, error: 'Alerta no encontrada.' };
      }

      setDiscrepancyAlertsError(null);
      const outcome = await executeOptimisticUpdateWithRollback<DiscrepancyAlert>({
        targetId: alertId,
        optimisticUpdate: (current) => ({
          ...current,
          resolved: true,
          resolutionNotes: resolutionNotes || current.resolutionNotes,
        }),
        updateState: setDiscrepancyAlerts,
        persist: (previous) =>
          resolveDiscrepancyAlertInSupabase({
            alertId,
            resolutionNotes,
            resolvedBy: currentUser?.id ?? null,
            status: 'RESOLVED',
            existingMetadata: { detectedByRule: previous.detectedByRule },
          }),
        onError: (msg) => {
          setDiscrepancyAlertsError(msg);
          console.error('[AppContext] Rollback al resolver discrepancy_alerts:', msg);
        },
      });

      return outcome.ok
        ? { success: true, data: outcome.data }
        : { success: false, error: outcome.error };
    },
    [currentUser?.id]
  );

  // Sincronización automática con la matriz de Requisiciones de Contraloría al aprobar/rechazar una Solicitud de Productos
  const syncApprovedOrRejectedSolicitudToControllerRequests = (
    sol: SolicitudProductoContraloria
  ) => {
    const mappedItems = sol.items.map((it, idx) => {
      // Costo unitario: último precio sincronizado (tabla prices) del producto; 0 si aún no existe precio real.
      const matchedPrice = (module1Bundle?.priceComparisons || []).find(
        (p) => String(p.ownProduct || '').trim().toUpperCase() === it.producto.trim().toUpperCase()
      );
      const unitCost = matchedPrice?.ownPriceUsd ?? 0;
      const totalCost = +(unitCost * it.cantidad).toFixed(2);
      return {
        id: `item_${sol.id}_${idx + 1}`,
        itemNumber: it.itemNumber || idx + 1,
        productName: it.producto,
        category: 'PRODUCTO_DEGUSTACION' as const,
        quantityRequested: it.cantidad,
        unitOfMeasure: 'Unid',
        unitCostUsd: unitCost,
        totalCostUsd: totalCost,
      };
    });

    const totalUnits = sol.totalUnidades;
    const estimatedCostUsd = +mappedItems
      .reduce((acc, it) => acc + it.totalCostUsd, 0)
      .toFixed(2);

    const nextReqStatus =
      sol.estado === 'APROBADA' ? 'APROBADO_CONTRALORIA' : 'RECHAZADO';

    setRequests((prev) => {
      const existeIdx = prev.findIndex(
        (r) => r.requestCode.toUpperCase() === sol.codigoCorrelativo.toUpperCase()
      );
      const builtReq: ControllerRequest = {
        id: existeIdx >= 0 ? prev[existeIdx].id : `req_${sol.id}`,
        requestCode: sol.codigoCorrelativo,
        requestDate: sol.fechaSolicitud,
        targetDepartment: sol.dirigidoA || 'CONTRALORÍA',
        campaignOrPurpose: sol.paraSerUtilizado,
        applicantDepartment: sol.departamentoSolicitante || 'MERCADEO Y PUBLICIDAD',
        applicantName: sol.solicitadoPor,
        targetRecipient: 'Despacho Mercadeo y Publicidad',
        deliveryDestination: sol.paraSerUtilizado,
        notesAndObservations: sol.observacion,
        budgetCategory: 'Degustaciones - Trade Marketing',
        approvedBudgetCapUsd: estimatedCostUsd,
        status: nextReqStatus,
        items: mappedItems,
        totalUnits,
        estimatedCostUsd,
        finalApprover:
          sol.estado === 'APROBADA'
            ? {
                name: sol.resueltoPor || 'Contraloría Interna',
                date: sol.resueltoAt
                  ? new Date(sol.resueltoAt).toLocaleString('es-VE')
                  : new Date().toLocaleString('es-VE'),
                comments: sol.notaContraloria,
              }
            : undefined,
        rejectionReason:
          sol.estado === 'RECHAZADA'
            ? sol.notaContraloria || 'Rechazada por Contraloría Interna.'
            : undefined,
      };

      if (existeIdx >= 0) {
        return prev.map((r, i) => (i === existeIdx ? builtReq : r));
      }
      return [builtReq, ...prev];
    });

    if (sol.estado === 'APROBADA') {
      setReconciliation((prev) => {
        if (prev.requestCode) return prev;
        return {
          ...prev,
          requestId: `req_${sol.id}`,
          requestCode: sol.codigoCorrelativo,
          productName: sol.items[0]?.producto || sol.paraSerUtilizado,
          deliveredUnits: totalUnits,
          degustatedUnitsReported: 0,
          returnedRemanentUnits: 0,
          discrepancyUnits: totalUnits,
          discrepancyStatus: totalUnits === 0 ? 'CUADRADO' : 'MERMA_NO_JUSTIFICADA',
          pazYSalvoIssued: false,
        };
      });
    }
  };

  // Hook reactivo en tiempo real de "SOLICITUD DE PRODUCTOS" (Trade Marketing <-> Contraloría Interna)
  const solicitudesContraloria = useSolicitudesContraloria({
    onSolicitudCreated: (sol) => {
      addAuditLog(
        'REQUISITION',
        sol.codigoCorrelativo,
        'SOLICITUD_PRODUCTOS_ENVIADA_CONTRALORIA',
        'BORRADOR',
        'PENDIENTE_APROBACION',
        `${sol.paraSerUtilizado} (${sol.items.length} ítems / ${sol.totalUnidades} un)`
      );
    },
    onSolicitudResolved: (sol) => {
      syncApprovedOrRejectedSolicitudToControllerRequests(sol);
      addAuditLog(
        'REQUISITION',
        sol.codigoCorrelativo,
        sol.estado === 'APROBADA'
          ? 'SOLICITUD_PRODUCTOS_APROBADA_CONTRALORIA'
          : 'SOLICITUD_PRODUCTOS_RECHAZADA_CONTRALORIA',
        'PENDIENTE_APROBACION',
        sol.estado,
        sol.notaContraloria || `Decisión procesada por ${sol.resueltoPor || 'Contraloría Interna'}.`
      );
    },
  });

  const purgeRegionalStateCache = useCallback(() => {
    sessionDeletedVisitIds.clear();
    sessionVisitsCleared = false;
    clearMasterDataCaches();
    clearMasterCatalogCaches();
    void purgeAllSessionCaches({
      reason: 'region_switch',
      preserveAuthSession: true,
    });
    setIsMasterCachePurged(true);
    visitsRef.current = [];
    reconciliationRef.current = EMPTY_RECONCILIATION;
    setVisits([]);
    setModule1Bundle(null);
    setRequests([]);
    setReconciliation(EMPTY_RECONCILIATION);
    setConciliacionesByReqId({});
    setCertificadosPazYSalvo({});
    setCampanasTrade([]);
    setPresupuestosTrade([]);
    setTarifarioCostos([]);
    setFallbackStores([]);
    setAuditLogs([]);
    setAuditLogsError(null);
    setHasMoreAuditLogs(false);
    auditLogsOffsetRef.current = 0;
    setDiscrepancyAlerts([]);
    setDiscrepancyAlertsError(null);
    setHasMoreDiscrepancyAlerts(false);
    discrepancyAlertsOffsetRef.current = 0;
    setUsers([]);
    setFocusedTastingId(null);
    setFocusedTastingSnapshot(null);
    setSupabaseError(null);
  }, []);

  const prevVerifiedUserIdRef = useRef<string | null>(verifiedProfile?.userId ?? null);
  useEffect(() => {
    const nextUserId = verifiedProfile?.userId ?? null;
    if (prevVerifiedUserIdRef.current !== nextUserId) {
      prevVerifiedUserIdRef.current = nextUserId;
      setSelectedNationalSucursal(null);
      setSelectedNationalRegionScope(canSwitchSucursal ? 'ALL' : null);
      setSelectedAssignedRegionScope('ASSIGNED');
      setActiveClientSucursalHeader(canSwitchSucursal ? null : lockedRegionalSucursal);
      purgeRegionalStateCache();
    }
  }, [verifiedProfile?.userId, canSwitchSucursal, lockedRegionalSucursal, purgeRegionalStateCache]);

  const setActiveRegionScope = useCallback(
    (nextRegion: AllowedRegionCode | 'ALL' | 'ASSIGNED') => {
      if (!canSwitchSucursal) {
        // Usuario multi-región (ej. María -> ['CENTRO', 'ANDES']): solo puede elegir 'ASSIGNED' o una de sus regiones asignadas.
        if (!canSwitchAmongAssignedRegions) {
          return;
        }
        if (nextRegion === 'ALL') {
          return;
        }
        if (nextRegion !== 'ASSIGNED' && !assignedRegionCodes.includes(nextRegion)) {
          return;
        }
        const compatSucursal: OperativeSucursal | null =
          nextRegion === 'CENTRO' ? 'CENTRO' : nextRegion === 'OCCIDENTE' ? 'ZULIA' : null;
        setActiveClientSucursalHeader(compatSucursal);
        activeSucursalRef.current = compatSucursal;
        const isSameChoice = selectedAssignedRegionScope === nextRegion;
        setSelectedAssignedRegionScope(nextRegion);

        purgeRegionalStateCache();
        void refreshSupabaseData();
        void refreshFinancialData();
        void refreshAuditLogs();
        void refreshDiscrepancyAlerts();
        if (isSameChoice) {
          void rawMasterData.refrescar().finally(() => {
            setIsMasterCachePurged(false);
          });
        }
        void masterEntities.refresh(true);
        void solicitudesContraloria.refreshSolicitudes();
        void degustacionNotifications.reloadNotifications();
        return;
      }

      const effectiveNext: AllowedRegionCode | 'ALL' = nextRegion === 'ASSIGNED' ? 'ALL' : nextRegion;
      const compatSucursal: OperativeSucursal | null =
        effectiveNext === 'OCCIDENTE'
          ? 'ZULIA'
          : effectiveNext === 'CENTRO'
            ? 'CENTRO'
            : null;

      setActiveClientSucursalHeader(compatSucursal);
      activeSucursalRef.current = compatSucursal;
      requiresSucursalSelectionRef.current = false;
      const isSameRegion = selectedNationalRegionScope === effectiveNext;
      setSelectedNationalSucursal(compatSucursal);
      setSelectedNationalRegionScope(effectiveNext);

      purgeRegionalStateCache();

      void refreshSupabaseData();
      void refreshFinancialData();
      void refreshAuditLogs();
      void refreshDiscrepancyAlerts();
      if (isSameRegion) {
        void rawMasterData.refrescar().finally(() => {
          setIsMasterCachePurged(false);
        });
      }
      void masterEntities.refresh(true);
      void solicitudesContraloria.refreshSolicitudes();
      void degustacionNotifications.reloadNotifications();
    },
    [
      canSwitchSucursal,
      canSwitchAmongAssignedRegions,
      assignedRegionCodes,
      selectedAssignedRegionScope,
      selectedNationalRegionScope,
      purgeRegionalStateCache,
      refreshSupabaseData,
      refreshFinancialData,
      refreshAuditLogs,
      refreshDiscrepancyAlerts,
      rawMasterData,
      masterEntities,
      solicitudesContraloria,
      degustacionNotifications,
    ]
  );

  const setActiveSucursal = useCallback(
    (nextSucursal: OperativeSucursal) => {
      if (!canSwitchSucursal) {
        return;
      }
      const normalized = normalizeSucursalCodigo(nextSucursal);
      if (!normalized || !isOperativeSucursal(normalized)) {
        return;
      }
      const officialRegion = normalizeRegionName(normalized) ?? 'ALL';

      // 1. Inyectar cabecera activa `x-sucursal-activa` en el cliente Supabase
      setActiveClientSucursalHeader(normalized);
      activeSucursalRef.current = normalized;
      requiresSucursalSelectionRef.current = false;
      setSelectedNationalSucursal(normalized);
      setSelectedNationalRegionScope(officialRegion);

      // 2. Purgar inmediatamente toda caché operativa en memoria (cero mezcla entre regiones)
      purgeRegionalStateCache();

      // 3. Recargar en limpio exclusivamente para la región seleccionada
      void refreshSupabaseData();
      void refreshFinancialData();
      void refreshAuditLogs();
      void refreshDiscrepancyAlerts();
      void rawMasterData.refrescar().finally(() => {
        setIsMasterCachePurged(false);
      });
      void masterEntities.refresh(true);
      void solicitudesContraloria.refreshSolicitudes();
      void degustacionNotifications.reloadNotifications();
    },
    [
      canSwitchSucursal,
      purgeRegionalStateCache,
      refreshSupabaseData,
      refreshFinancialData,
      refreshAuditLogs,
      refreshDiscrepancyAlerts,
      rawMasterData,
      masterEntities,
      solicitudesContraloria,
      degustacionNotifications,
    ]
  );

  const syncReconciliationToState = (next: InventoryReconciliation) => {
    setReconciliation(next);
    if (next.requestId) {
      setConciliacionesByReqId((prev) => ({
        ...prev,
        [next.requestId]: next,
      }));
    }
  };

  const saveCampanaTrade = async (
    input: CampanaTradeInput
  ): Promise<{ success: boolean; message: string; data?: CampanaTrade }> => {
    try {
      const saved = await upsertCampanaTrade({
        ...input,
        sucursal:
          input.sucursal ??
          activeSucursal ??
          (verifiedSucursal && verifiedSucursal !== 'GLOBAL'
            ? verifiedSucursal
            : 'ZULIA'),
      });
      setCampanasTrade((prev) => {
        const exists = prev.some((c) => c.id === saved.id);
        return exists ? prev.map((c) => (c.id === saved.id ? saved : c)) : [saved, ...prev];
      });
      return { success: true, message: `Campaña ${saved.codigo} guardada en Supabase.`, data: saved };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Error guardando campaña Trade.',
      };
    }
  };

  const savePresupuestoTrade = async (
    input: PresupuestoTradeInput
  ): Promise<{ success: boolean; message: string; data?: PresupuestoTrade }> => {
    try {
      const saved = await upsertPresupuestoTrade({
        ...input,
        sucursal:
          input.sucursal ??
          activeSucursal ??
          (verifiedSucursal && verifiedSucursal !== 'GLOBAL'
            ? verifiedSucursal
            : 'ZULIA'),
      });
      setPresupuestosTrade((prev) => {
        const exists = prev.some((p) => p.id === saved.id);
        return exists ? prev.map((p) => (p.id === saved.id ? saved : p)) : [saved, ...prev];
      });
      return { success: true, message: `Presupuesto ${saved.categoria} guardado en Supabase.`, data: saved };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Error guardando presupuesto Trade.',
      };
    }
  };

  const saveTarifarioCosto = async (
    input: TarifarioCostoTradeInput
  ): Promise<{ success: boolean; message: string; data?: TarifarioCostoTrade }> => {
    try {
      const saved = await upsertTarifarioCostoTrade({
        ...input,
        sucursal:
          input.sucursal ??
          activeSucursal ??
          (verifiedSucursal && verifiedSucursal !== 'GLOBAL'
            ? verifiedSucursal
            : 'ZULIA'),
      });
      setTarifarioCostos((prev) => {
        const exists = prev.some((t) => t.id === saved.id);
        return exists ? prev.map((t) => (t.id === saved.id ? saved : t)) : [saved, ...prev];
      });
      return { success: true, message: `Tarifa ${saved.etiqueta} actualizada en BD.`, data: saved };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Error guardando tarifario de costos.',
      };
    }
  };

  const verifyPazYSalvoCertificate = async (code: string): Promise<PazYSalvoVerificationResult> => {
    return verifyPazYSalvoInSupabase(code);
  };

  const advanceRequisitionWorkflow = async (
    requestId: string,
    nextStatus: any,
    justification?: string,
    comments?: string
  ): Promise<{ success: boolean; message: string }> => {
    const req = requests.find((r) => r.id === requestId);
    if (!req) return { success: false, message: 'Requisición no encontrada.' };
    const oldStatus = req.status;

    if (isSupabaseConfigured && isRealUuid(requestId)) {
      try {
        const updatedReq = await transitionRequisitionInSupabase({
          requisicionId: requestId,
          nextStatus,
          justification,
          comments,
        });
        setRequests((prev) => prev.map((r) => (r.id === requestId ? updatedReq : r)));
        addAuditLog(
          'REQUISITION',
          updatedReq.requestCode,
          `WORKFLOW_TRANSICION_${updatedReq.status}`,
          oldStatus,
          updatedReq.status,
          justification || comments || 'Transición autorizada por PostgreSQL RPC.'
        );
        return {
          success: true,
          message: `Estado actualizado y persistido en BD: ${updatedReq.status}.`,
        };
      } catch (err) {
        return {
          success: false,
          message:
            err instanceof Error
              ? err.message
              : 'Transición denegada por las reglas de Contraloría en base de datos.',
        };
      }
    }

    return {
      success: false,
      message: 'Supabase no está configurado o la requisición no tiene un UUID persistido.',
    };
  };

  const createRequisition = async (
    req: Partial<ControllerRequest>
  ): Promise<{ success: boolean; message: string; requisicion?: ControllerRequest }> => {
    if (!isSupabaseConfigured) {
      return {
        success: false,
        message: 'Supabase no está configurado: no se pueden radicar requisiciones en memoria.',
      };
    }

    try {
      const targetSucursal =
        req.sucursal ??
        activeSucursal ??
        (verifiedSucursal && verifiedSucursal !== 'GLOBAL'
          ? verifiedSucursal
          : 'ZULIA');
      const { requisicion, conciliacion } = await createRequisitionInSupabase({
        ...req,
        applicantName: req.applicantName || currentUser?.name || 'Trade Marketing',
        sucursal: targetSucursal,
      });

      setRequests((prev) => [requisicion, ...prev.filter((r) => r.id !== requisicion.id)]);
      syncReconciliationToState(conciliacion);
      addAuditLog(
        'REQUISITION',
        requisicion.requestCode,
        'CREACION_NUEVA_REQUISICION',
        'N/A',
        requisicion.status,
        'Requisición radicada en Supabase con correlativo secuencial.'
      );
      return {
        success: true,
        message: `Requisición ${requisicion.requestCode} radicada en Supabase.`,
        requisicion,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'No se pudo radicar la requisición.',
      };
    }
  };

  const addFiscalReceipt = async (
    receipt: Omit<FiscalReceipt, 'id' | 'isValidatedByContraloria'>,
    file?: File | Blob | null
  ): Promise<{ success: boolean; message: string }> => {
    const activeConc = reconciliationRef.current;
    if (activeConc.cerrada || activeConc.pazYSalvoIssued) {
      return {
        success: false,
        message: 'BLOQUEO INMUTABLE: La conciliación ya posee Paz y Salvo y no admite nuevas facturas.',
      };
    }

    const existsLocally = activeConc.receipts.some(
      (r) =>
        r.supplierRif.trim().toUpperCase() === receipt.supplierRif.trim().toUpperCase() &&
        r.invoiceNumber.trim().toLowerCase() === receipt.invoiceNumber.trim().toLowerCase()
    );

    if (existsLocally) {
      void createDiscrepancyAlert({
        severity: 'CRITICA',
        title: 'Intento de Factura Fiscal Duplicada',
        description: `Se intentó cargar la factura ${receipt.invoiceNumber} del proveedor ${receipt.supplierRif} que ya fue rendida previamente.`,
        entityCode: receipt.invoiceNumber,
        entityType: 'EXPENSE',
        detectedByRule: 'RULE_ANTIFRAUD_DUPLICATE_INVOICE',
        metadata: {
          supplierRif: receipt.supplierRif,
          invoiceNumber: receipt.invoiceNumber,
        },
      });
      addAuditLog(
        'EXPENSE',
        receipt.invoiceNumber,
        'BLOQUEO_FACTURA_DUPLICADA',
        undefined,
        'RECHAZADO',
        'Bloqueo automático: Número de comprobante duplicado.'
      );
      return {
        success: false,
        message: 'ERROR CRÍTICO: La factura ya existe en el sistema. Prohibida la doble rendición.',
      };
    }

    if (!isSupabaseConfigured || !isRealUuid(activeConc.id) || !isRealUuid(activeConc.requestId)) {
      return {
        success: false,
        message:
          'Seleccione una requisición persistida en Supabase para cargar comprobantes fiscales.',
      };
    }

    try {
      let savedReceipt: FiscalReceipt;
      if (file) {
        const uploaded = await uploadFiscalReceiptWithBinary({
          conciliacionId: activeConc.id,
          requisicionId: activeConc.requestId,
          receipt,
          file,
        });
        savedReceipt = uploaded.receipt;
      } else {
        savedReceipt = await createFiscalReceiptMetadataInSupabase({
          conciliacionId: activeConc.id,
          requisicionId: activeConc.requestId,
          receipt,
        });
      }

      const nextReceipts = [savedReceipt, ...activeConc.receipts];
      const nextTotalExpenses = Number(
        nextReceipts.reduce((s, r) => s + r.totalUsd, 0).toFixed(2)
      );
      syncReconciliationToState({
        ...activeConc,
        receipts: nextReceipts,
        totalExpensesReportedUsd: nextTotalExpenses,
        balanceDueCompanyOrPromotorUsd: Number(
          (activeConc.approvedPettyCashUsd - nextTotalExpenses).toFixed(2)
        ),
      });

      addAuditLog(
        'EXPENSE',
        savedReceipt.invoiceNumber,
        'COMPROBANTE_FISCAL_SUBIDO',
        undefined,
        'PENDIENTE_VALIDACION',
        `Factura por $${savedReceipt.totalUsd} persistida en Supabase${
          savedReceipt.storagePath ? ' con soporte privado verificado' : ''
        }.`
      );
      return {
        success: true,
        message: savedReceipt.storagePath
          ? 'Factura y documento binario validados y guardados en Storage privado.'
          : 'Factura registrada en Supabase. En cola de validación fiscal.',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error registrando factura fiscal.';
      if (/ANTIFRAUDE|duplicad/i.test(msg)) {
        void createDiscrepancyAlert({
          severity: 'CRITICA',
          title: 'Bloqueo Antifraude BD: Factura Duplicada',
          description: msg,
          entityCode: receipt.invoiceNumber,
          entityType: 'EXPENSE',
          detectedByRule: 'DB_UNIQUE_RIF_INVOICE',
          metadata: {
            supplierRif: receipt.supplierRif,
            invoiceNumber: receipt.invoiceNumber,
          },
        });
      }
      return { success: false, message: msg };
    }
  };

  const validateFiscalReceipt = async (
    receiptId: string,
    isValid: boolean,
    notes?: string
  ): Promise<{ success: boolean; message: string }> => {
    const activeConc = reconciliationRef.current;
    if (activeConc.cerrada || activeConc.pazYSalvoIssued) {
      return {
        success: false,
        message: 'La conciliación ya está cerrada con Paz y Salvo inmutable.',
      };
    }

    if (!isSupabaseConfigured || !isRealUuid(receiptId)) {
      return { success: false, message: 'Factura no persistida o Supabase no configurado.' };
    }

    try {
      const updated = await validateFiscalReceiptInSupabase(
        receiptId,
        isValid,
        notes,
        currentUser?.name || 'Contraloría Interna'
      );
      syncReconciliationToState({
        ...activeConc,
        receipts: activeConc.receipts.map((r) =>
          r.id === receiptId ? { ...updated, imageUrl: r.imageUrl || updated.imageUrl } : r
        ),
      });
      addAuditLog(
        'EXPENSE',
        receiptId,
        isValid ? 'FACTURA_CONTRALORIA_CONFORME' : 'FACTURA_CONTRALORIA_RECHAZADA',
        undefined,
        isValid ? 'VALIDADO' : 'OBSERVADO',
        notes
      );
      return {
        success: true,
        message: isValid
          ? 'Factura marcada como CONFORME FISCAL en Supabase.'
          : 'Factura observada por Contraloría en Supabase.',
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Error validando comprobante fiscal.',
      };
    }
  };

  const updateReconciliation = async (
    updates: Partial<InventoryReconciliation>,
    options?: { persist?: boolean }
  ): Promise<{ success: boolean; message: string }> => {
    const snapshot = reconciliationRef.current;
    if (snapshot.cerrada || snapshot.pazYSalvoIssued) {
      return {
        success: false,
        message: 'BLOQUEO INMUTABLE: La conciliación está sellada con Paz y Salvo.',
      };
    }

    const next: InventoryReconciliation = { ...snapshot, ...updates };
    const discrepancy =
      (Number(next.deliveredUnits) || 0) -
      ((Number(next.degustatedUnitsReported) || 0) + (Number(next.returnedRemanentUnits) || 0));
    next.discrepancyUnits = discrepancy;
    next.discrepancyStatus =
      discrepancy === 0
        ? 'CUADRADO'
        : Math.abs(discrepancy) <= 1
        ? 'DESVIACION_ACEPTABLE'
        : 'MERMA_NO_JUSTIFICADA';
    next.balanceDueCompanyOrPromotorUsd = Number(
      ((Number(next.approvedPettyCashUsd) || 0) - (Number(next.totalExpensesReportedUsd) || 0)).toFixed(2)
    );

    syncReconciliationToState(next);

    if (options?.persist === false || !isSupabaseConfigured || !isRealUuid(next.id)) {
      return { success: true, message: 'Conciliación actualizada.' };
    }

    try {
      await updateReconciliationInSupabase(next.id, updates);
      return { success: true, message: 'Conciliación guardada en Supabase.' };
    } catch (err) {
      syncReconciliationToState(snapshot);
      return {
        success: false,
        message:
          err instanceof Error
            ? err.message
            : 'No se pudo persistir la conciliación; se revirtió el cambio.',
      };
    }
  };

  const closeReconciliationAndIssuePazYSalvo = async (
    notes: string
  ): Promise<{ success: boolean; message: string; certificado?: CertificadoPazYSalvo }> => {
    const activeConc = reconciliationRef.current;
    const variance =
      activeConc.deliveredUnits -
      (activeConc.degustatedUnitsReported + activeConc.returnedRemanentUnits);

    if (variance !== 0) {
      return {
        success: false,
        message: `BLOQUEO DE CONTRALORÍA: No se puede emitir Paz y Salvo con una diferencia de ${variance} unidades sin justificar.`,
      };
    }

    if (!isSupabaseConfigured || !isRealUuid(activeConc.requestId)) {
      return {
        success: false,
        message:
          'Solo el servidor PostgreSQL (`rpc_emitir_paz_y_salvo`) puede emitir y firmar criptográficamente un Paz y Salvo oficial.',
      };
    }

    try {
      const { certificado, requisicion, conciliacion } = await issuePazYSalvoInSupabase(
        activeConc.requestId,
        notes
      );

      const certSha256 = String(
        certificado.sha256_hash || certificado.firma_sha256_hex || ''
      ).trim();

      const sealedConc: InventoryReconciliation = {
        ...conciliacion,
        receipts: activeConc.receipts,
        pazYSalvoIssued: true,
        cerrada: true,
        pazYSalvoCertificateCode: certificado.codigo_certificado,
        pazYSalvoIssueDate: certificado.emitido_en,
        pazYSalvoHash: certSha256 ? `SHA256:${certSha256}` : conciliacion.pazYSalvoHash,
      };

      syncReconciliationToState(sealedConc);
      setCertificadosPazYSalvo((prev) => ({
        ...prev,
        [requisicion.id]: { ...certificado, sha256_hash: certSha256 },
      }));
      setRequests((prev) => prev.map((r) => (r.id === requisicion.id ? requisicion : r)));

      addAuditLog(
        'RECONCILIATION',
        requisicion.requestCode,
        'EMISION_PAZ_Y_SALVO_DIGITAL',
        'RENDICION_PENDIENTE',
        'CONCILIADO_CERRADO',
        `${certificado.codigo_certificado} · SHA256:${String(certSha256 || '').slice(0, 16) || 'PENDIENTE'}… · ${notes}`
      );

      return {
        success: true,
        message: `Paz y Salvo ${certificado.codigo_certificado} emitido y sellado con SHA-256 real en PostgreSQL.`,
        certificado,
      };
    } catch (err) {
      return {
        success: false,
        message:
          err instanceof Error
            ? err.message
            : 'No se pudo emitir el certificado de Paz y Salvo en servidor.',
      };
    }
  };

  const lookupClientCode = (storeId: string, storeName: string): string => {
    const byId = stores.find((s) => s.id === storeId);
    if (byId?.clientCode) return byId.clientCode;
    const norm = storeName.trim().toUpperCase();
    const byName = stores.find((s) => s.name.trim().toUpperCase() === norm);
    return byName?.clientCode || '';
  };

  const applySavedRowsToState = (
    savedRows: Array<{
      id: string;
      client_temp_id?: string | null;
      promotora_id?: string | null;
      promotora_nombre?: string | null;
    }>
  ) => {
    if (savedRows.length === 0) return;
    setVisits((prev) =>
      prev.map((v) => {
        const matched = savedRows.find(
          (r) =>
            (r.client_temp_id && r.client_temp_id === v.id) ||
            r.id === v.id ||
            (v.cronogramaId && r.id === v.cronogramaId)
        );
        if (!matched) return v;
        return {
          ...v,
          id: isRealUuid(v.id) ? v.id : matched.id,
          cronogramaId: matched.id,
          promotoraId: matched.promotora_id ?? v.promotoraId,
          promotoraName: matched.promotora_nombre ?? v.promotoraName,
        };
      })
    );
  };

  const updateVisit = async (
    visitId: string,
    updates: Partial<ScheduledVisit>,
    options?: { persist?: boolean }
  ): Promise<MatrixMutationResult> => {
    const snapshot = visitsRef.current;
    const target = snapshot.find((v) => v.id === visitId);
    if (!target) return { ok: false, error: 'Registro no encontrado en la matriz.' };

    const mergedVisit: ScheduledVisit = { ...target, ...updates };
    setVisits((prev) => prev.map((v) => (v.id === visitId ? mergedVisit : v)));

    if (!options?.persist || !isSupabaseConfigured) {
      return { ok: true };
    }

    try {
      const resolvedPromEmail = (() => {
        const key = canonicalStaffKey(mergedVisit.promotoraName);
        if (!key) return '';
        const u = users.find((x) => x.role === 'promotora' && canonicalStaffKey(x.name, x.email) === key);
        if (u?.email) return u.email;
        const p = (masterEntities.promotoras || []).find(
          (x) => canonicalStaffKey(x.nombre_completo, x.email || undefined) === key
        );
        return p?.email || '';
      })();
      const resolvedSucursal =
        activeSucursal ||
        (verifiedSucursal && verifiedSucursal !== 'GLOBAL'
          ? verifiedSucursal
          : activeRegionScope === 'CENTRO'
            ? 'VALENCIA'
            : 'ZULIA');
      const payload = buildMatrixUpsertRowFromVisit(mergedVisit, {
        clientCode: lookupClientCode(mergedVisit.storeId, mergedVisit.storeName),
        clientTempId: mergedVisit.id,
        promotoraEmail: resolvedPromEmail,
        sucursal: resolvedSucursal,
      });
      const res = await persistMatrixUpsertBatch([payload]);
      applySavedRowsToState(res.filas);
      return { ok: true };
    } catch (err) {
      setVisits(snapshot);
      return {
        ok: false,
        reverted: true,
        error:
          err instanceof Error
            ? err.message
            : 'No se pudo guardar el cambio en Supabase; se revirtió el estado anterior.',
      };
    }
  };

  const updateVisitFromProductFill = async (
    visitId: string,
    product: string,
    quantityInput: string
  ): Promise<MatrixMutationResult> => {
    const fields = buildProductFields(product, quantityInput);
    return updateVisit(visitId, fields, { persist: true });
  };

  const addVisit = async (
    visit: Omit<ScheduledVisit, 'id'>
  ): Promise<MatrixMutationResult & { visit?: ScheduledVisit }> => {
    const snapshot = visitsRef.current;
    const occupiedKeys = new Set(
      snapshot
        .filter(
          (v) =>
            v.shift === visit.shift &&
            (v.date ? v.date === visit.date : v.dayLabel === visit.dayLabel) &&
            v.promotoraName &&
            !v.promotoraName.toUpperCase().startsWith('POR ASIGNAR') &&
            !v.promotoraName.toUpperCase().startsWith('SIN ASIGNAR')
        )
        .map((v) => canonicalStaffKey(v.promotoraName))
        .filter(Boolean)
    );

    const resolvedProm = resolveRealPromotoraForMatrix(users, visit.promotoraName, occupiedKeys);
    const tempId = `vis_pending_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`;
    const newVisit: ScheduledVisit = {
      ...visit,
      promotoraId: resolvedProm.promotoraId,
      promotoraName: resolvedProm.promotoraName,
      id: tempId,
    };

    setVisits((prev) => [newVisit, ...prev]);

    if (!isSupabaseConfigured) {
      addAuditLog(
        'CAMPO',
        newVisit.id,
        'NUEVA_ACTIVACION_AGREGADA',
        'N/A',
        newVisit.status,
        `Tienda: ${newVisit.storeName}, Producto: ${newVisit.productFocus}`
      );
      return { ok: true, visit: newVisit };
    }

    try {
      const resolvedPromEmail = (() => {
        const key = canonicalStaffKey(newVisit.promotoraName);
        if (!key) return '';
        const u = users.find((x) => x.role === 'promotora' && canonicalStaffKey(x.name, x.email) === key);
        if (u?.email) return u.email;
        const p = (masterEntities.promotoras || []).find(
          (x) => canonicalStaffKey(x.nombre_completo, x.email || undefined) === key
        );
        return p?.email || '';
      })();
      const resolvedSucursal =
        activeSucursal ||
        (verifiedSucursal && verifiedSucursal !== 'GLOBAL'
          ? verifiedSucursal
          : activeRegionScope === 'CENTRO'
            ? 'VALENCIA'
            : 'ZULIA');
      const payload = buildMatrixUpsertRowFromVisit(newVisit, {
        clientCode: lookupClientCode(newVisit.storeId, newVisit.storeName),
        clientTempId: tempId,
        promotoraEmail: resolvedPromEmail,
        sucursal: resolvedSucursal,
      });
      const res = await persistMatrixUpsertBatch([payload]);
      applySavedRowsToState(res.filas);
      const savedId = res.filas[0]?.id || tempId;
      addAuditLog(
        'CAMPO',
        savedId,
        'NUEVA_ACTIVACION_AGREGADA',
        'N/A',
        newVisit.status,
        `Tienda: ${newVisit.storeName}, Producto: ${newVisit.productFocus} (persistido en cronograma_degustaciones)`
      );
      return { ok: true, visit: { ...newVisit, id: savedId, cronogramaId: savedId } };
    } catch (err) {
      setVisits(snapshot);
      return {
        ok: false,
        reverted: true,
        error:
          err instanceof Error
            ? err.message
            : 'No se pudo guardar la activación en Supabase; la fila fue revertida.',
      };
    }
  };

  const deleteVisit = async (
    visitId: string,
    motivo = 'CANCELADO_DESDE_MATRIZ'
  ): Promise<MatrixMutationResult> => {
    const res = await deleteVisitsByIds([visitId], motivo);
    return { ok: res.ok, error: res.error, reverted: res.reverted };
  };

  const deleteVisitsByIds = async (
    visitIds: string[],
    motivo = 'CANCELADO_DESDE_MATRIZ'
  ): Promise<MatrixMutationResult & { removed: number; preservedHistorical: number }> => {
    const idSet = new Set(visitIds.filter(Boolean));
    if (idSet.size === 0) return { ok: true, removed: 0, preservedHistorical: 0 };

    const snapshot = visitsRef.current;
    const classified = classifyVisitsForLogicalCancel(snapshot, Array.from(idSet));
    const removableIdSet = new Set(
      snapshot
        .filter((v) => idSet.has(v.id) && !classified.preservedHistoricalIds.includes(v.id))
        .map((v) => v.id)
    );

    if (removableIdSet.size === 0) {
      return {
        ok: false,
        removed: 0,
        preservedHistorical: classified.preservedHistoricalIds.length,
        error:
          'Los registros seleccionados están completados o archivados en Historial y no pueden cancelarse.',
      };
    }

    // Actualización optimista (retira de la vista activa las filas cancelables)
    setVisits((prev) => prev.filter((v) => !removableIdSet.has(v.id)));

    if (classified.cancelableCronogramaIds.length > 0 && isSupabaseConfigured) {
      try {
        const rpcRes = await persistMatrixLogicalCancel(classified.cancelableCronogramaIds, motivo);
        recordDeletedVisitIds(removableIdSet);
        addAuditLog(
          'CAMPO',
          'BATCH_CANCEL_LOGICO',
          'CANCELACION_LOGICA_MATRIZ',
          'ACTIVO',
          'CANCELADA_HISTORIAL',
          `Cancelación lógica en BD: ${rpcRes.canceladas} registro(s) archivados como CANCELADA (${rpcRes.preservadas_historicas} históricos preservados)`
        );
        return {
          ok: true,
          removed: rpcRes.canceladas + classified.localOnlyIds.length,
          preservedHistorical:
            classified.preservedHistoricalIds.length + rpcRes.preservadas_historicas,
        };
      } catch (err) {
        setVisits(snapshot);
        return {
          ok: false,
          reverted: true,
          removed: 0,
          preservedHistorical: classified.preservedHistoricalIds.length,
          error:
            err instanceof Error
              ? err.message
              : 'Error ejecutando cancelación lógica en Supabase; se revirtieron los cambios.',
        };
      }
    }

    recordDeletedVisitIds(removableIdSet);
    addAuditLog(
      'CAMPO',
      'BATCH_CANCEL_LOGICO',
      'CANCELACION_LOGICA_MATRIZ',
      'ACTIVO',
      'CANCELADA',
      `Se cancelaron ${removableIdSet.size} registro(s) de la matriz`
    );
    return {
      ok: true,
      removed: removableIdSet.size,
      preservedHistorical: classified.preservedHistoricalIds.length,
    };
  };

  const batchFillClientsProductShift = async (params: {
    storeIds: string[];
    product: string;
    products?: string[];
    quantityInput: string;
    shift: ShiftType;
    dayLabel: string;
    date?: string;
    promotoraName?: string;
    promotoraEmail?: string;
    sellerName?: string;
    notes?: string;
  }): Promise<BatchFillClientsResult> => {
    const snapshot = visitsRef.current;
    const plan = buildBatchFillPlan({
      existingVisits: snapshot,
      stores,
      users,
      ...params,
    });

    if (plan.affectedVisits.length === 0) {
      return {
        ok: false,
        countUpdated: 0,
        countCreated: 0,
        error: 'No se encontraron tiendas válidas para el llenado por lote.',
      };
    }

    setVisits(plan.nextVisits);

    if (!isSupabaseConfigured) {
      addAuditLog(
        'CAMPO',
        'BATCH_FILL',
        'LLENADO_POR_LOTE_EXITOSO',
        'VARIOS',
        params.product.toUpperCase(),
        `Llenado en lote local: ${params.storeIds.length} clientes, jornada: ${params.shift}`
      );
      return {
        ok: true,
        countUpdated: plan.countUpdated,
        countCreated: plan.countCreated,
      };
    }

    try {
      const resolvedSucursal =
        activeSucursal ||
        (verifiedSucursal && verifiedSucursal !== 'GLOBAL'
          ? verifiedSucursal
          : activeRegionScope === 'CENTRO'
            ? 'VALENCIA'
            : 'ZULIA');
      const resolveEmailForVisit = (promName: string): string => {
        if (params.promotoraEmail && params.promotoraName && canonicalStaffKey(promName) === canonicalStaffKey(params.promotoraName)) {
          return params.promotoraEmail;
        }
        const key = canonicalStaffKey(promName);
        if (!key) return '';
        const u = users.find((x) => x.role === 'promotora' && canonicalStaffKey(x.name, x.email) === key);
        if (u?.email) return u.email;
        const p = (masterEntities.promotoras || []).find(
          (x) => canonicalStaffKey(x.nombre_completo, x.email || undefined) === key
        );
        return p?.email || '';
      };
      const rowsPayload = plan.affectedVisits.map((v) =>
        buildMatrixUpsertRowFromVisit(v, {
          clientCode: lookupClientCode(v.storeId, v.storeName),
          clientTempId: v.id,
          promotoraEmail: resolveEmailForVisit(v.promotoraName),
          sucursal: resolvedSucursal,
        })
      );
      const rpcRes = await persistMatrixUpsertBatch(rowsPayload);
      applySavedRowsToState(rpcRes.filas);
      addAuditLog(
        'CAMPO',
        'BATCH_FILL',
        'LLENADO_POR_LOTE_EXITOSO',
        'VARIOS',
        params.product.toUpperCase(),
        `Llenado en lote persistido en Supabase: ${rpcRes.insertadas} creadas, ${rpcRes.actualizadas} actualizadas (jornada ${params.shift})`
      );
      return {
        ok: true,
        countUpdated: plan.countUpdated,
        countCreated: plan.countCreated,
      };
    } catch (err) {
      setVisits(snapshot);
      return {
        ok: false,
        reverted: true,
        countUpdated: 0,
        countCreated: 0,
        error:
          err instanceof Error
            ? err.message
            : 'No se pudo guardar el lote en Supabase; la tabla fue revertida.',
      };
    }
  };

  const upsertVisitFromApprovedTasting = (
    params: UpsertVisitFromTastingParams
  ): UpsertVisitFromTastingResult => {
    const solicitudId = String(params.solicitudId || '').trim();
    const degustacionId = params.degustacionId ? String(params.degustacionId).trim() : undefined;

    unrecordDeletedVisitIds([solicitudId, degustacionId]);

    const supplies = calculateProductionSupplies(
      params.productName,
      params.requestedQty,
      params.targetSamples
    );
    const effectiveShift = normalizeProductionShift(params.shift, params.timeRange);
    const effectiveDate = params.date || getTodayVeYmd();
    const effectiveDayLabel = params.dayLabel || formatDayLabelEs(effectiveDate);
    const cleanStoreName = String(params.storeName || '').trim() || 'PDV Sin Nombre';
    const cleanZone = String(params.zone || '').trim() || 'ZONA GENERAL';
    const cleanSellerName =
      String(params.sellerName || '')
        .replace(/\s*\(Vendedor FDV\)/i, '')
        .trim() || 'FDV Codizulca';

    // Resolver promotora activa válida de la nómina sincronizada (nunca nombres ficticios)
    const promotoraPool = users
      .filter((u) => u.role === 'promotora')
      .map((u) => u.name.trim())
      .filter(Boolean);
    const fallbackStaffPool = (module1Bundle?.staffMembers || [])
      .filter((sm) => sm.status === 'Activo' && sm.category !== 'merchandising')
      .map((sm) => sm.name.trim())
      .filter(Boolean);
    const activePromotoras = promotoraPool.length > 0 ? promotoraPool : fallbackStaffPool;

    const rawPromotora = String(params.promotoraName || '').trim();
    const isUnassignedToken =
      !rawPromotora ||
      rawPromotora.toUpperCase().startsWith('POR ASIGNAR') ||
      rawPromotora.toUpperCase().startsWith('SIN ASIGNAR');
    const requestedKey = !isUnassignedToken ? canonicalStaffKey(rawPromotora) : '';
    const matchedRequested = requestedKey
      ? activePromotoras.find((p) => canonicalStaffKey(p) === requestedKey)
      : undefined;

    const occupiedInSlot = new Set(
      visits
        .filter(
          (v) =>
            v.id !== solicitudId &&
            v.solicitudId !== solicitudId &&
            (!degustacionId || v.degustacionId !== degustacionId) &&
            v.shift === effectiveShift &&
            (v.date ? v.date === effectiveDate : v.dayLabel === effectiveDayLabel) &&
            v.promotoraName &&
            !v.promotoraName.toUpperCase().startsWith('POR ASIGNAR') &&
            !v.promotoraName.toUpperCase().startsWith('SIN ASIGNAR')
        )
        .map((v) => canonicalStaffKey(v.promotoraName))
        .filter(Boolean)
    );

    let assignedPromotora = matchedRequested || '';
    if (!assignedPromotora || occupiedInSlot.has(canonicalStaffKey(assignedPromotora))) {
      const availablePromotora = activePromotoras.find(
        (p) => !occupiedInSlot.has(canonicalStaffKey(p))
      );
      assignedPromotora =
        availablePromotora ||
        matchedRequested ||
        activePromotoras[0] ||
        'POR ASIGNAR (Trade Marketing)';
    }

    // Asegurar que la tienda exista en el catálogo sincronizado de stores para el módulo 2
    const existingStore = stores.find(
      (s) => s.name.trim().toUpperCase() === cleanStoreName.toUpperCase()
    );
    const resolvedStoreId = existingStore?.id || `st_sup_sync_${solicitudId}`;
    if (!existingStore && cleanStoreName !== 'PDV Sin Nombre') {
      setFallbackStores((prev) => {
        if (prev.some((s) => s.name.trim().toUpperCase() === cleanStoreName.toUpperCase())) {
          return prev;
        }
        return [
          ...prev,
          {
            id: resolvedStoreId,
            name: cleanStoreName,
            clientCode: params.clienteCodigo || '',
            address: cleanZone,
            zone: cleanZone,
            city: '',
            latitude: null,
            longitude: null,
            geofenceRadiusMeters: 0,
            sellerName: cleanSellerName,
            channel: '',
          },
        ];
      });
    }

    const matchesRequest = (v: ScheduledVisit) =>
      v.id === solicitudId ||
      (Boolean(v.solicitudId) && v.solicitudId === solicitudId) ||
      (Boolean(degustacionId) && Boolean(v.degustacionId) && v.degustacionId === degustacionId);

    const existingVisit = visits.find(matchesRequest);
    const isUpdate = Boolean(existingVisit);
    const matchedUser = users.find(
      (u) => u.role === 'promotora' && canonicalStaffKey(u.name) === canonicalStaffKey(assignedPromotora)
    );

    const upsertedVisit: ScheduledVisit = {
      id: existingVisit?.id || solicitudId,
      cronogramaId: params.cronogramaId || existingVisit?.cronogramaId,
      solicitudId,
      degustacionId: degustacionId || existingVisit?.degustacionId,
      date: effectiveDate,
      dayLabel: effectiveDayLabel,
      shift: effectiveShift,
      storeId: existingVisit?.storeId || resolvedStoreId,
      storeName: cleanStoreName,
      zone: cleanZone,
      productFocus: supplies.productFocus,
      fillProductSelection: supplies.fillProductSelection,
      fillQuantityInput: supplies.fillQuantityInput,
      promotoraId: params.promotoraId || matchedUser?.id || existingVisit?.promotoraId || '',
      promotoraName: assignedPromotora,
      sellerName: cleanSellerName,
      plannedUnits: supplies.plannedUnits,
      mortadelaQty: supplies.mortadelaQty,
      espaldaQty: supplies.espaldaQty,
      arrozQty: supplies.arrozQty,
      azucarGrams: supplies.azucarGrams,
      lecheGrams: supplies.lecheGrams,
      rowHighlight: supplies.rowHighlight,
      status: existingVisit?.status === 'COMPLETADA' ? 'COMPLETADA' : 'PENDIENTE',
      additionalGoods: supplies.additionalGoods,
      operationalSupplies: supplies.operationalSupplies,
    };

    setVisits((prev) => {
      const idx = prev.findIndex(matchesRequest);
      if (idx >= 0) {
        // Actualizar en sitio y eliminar cualquier duplicado residual
        return prev
          .map((v, i) => (i === idx ? { ...v, ...upsertedVisit, id: v.id } : v))
          .filter((v, i) => i === idx || !matchesRequest(v));
      }
      return [upsertedVisit, ...prev];
    });

    // Sincronizar también en memoria el bundle de Módulo 1 para consistencia inmediata
    setModule1Bundle((prev) => {
      if (!prev) return prev;
      const nextTastingItems = prev.tastingItems.map((t) =>
        t.id === solicitudId || (degustacionId && t.degustacionId === degustacionId)
          ? {
              ...t,
              status: 'PROGRAMADO' as const,
              assignedPromoter: assignedPromotora,
              mortadelaQty: supplies.mortadelaQty,
              espaldaQty: supplies.espaldaQty,
              arrozQty: supplies.arrozQty,
              azucarGrams: supplies.azucarGrams,
              lecheGrams: supplies.lecheGrams,
              rowHighlight: supplies.rowHighlight,
              additionalGoods: supplies.additionalGoods,
            }
          : t
      );
      const existsInSchedule = prev.visitsForSchedule.some(matchesRequest);
      const nextVisitsForSchedule = existsInSchedule
        ? prev.visitsForSchedule.map((sv) => (matchesRequest(sv) ? upsertedVisit : sv))
        : [upsertedVisit, ...prev.visitsForSchedule];
      return {
        ...prev,
        tastingItems: nextTastingItems,
        visitsForSchedule: nextVisitsForSchedule,
      };
    });

    addAuditLog(
      'CAMPO',
      degustacionId || solicitudId,
      isUpdate ? 'SINCRONIZACION_AUTO_MOD1_MOD2_UPDATE' : 'SINCRONIZACION_AUTO_MOD1_MOD2_INSERT',
      isUpdate ? 'APROBADA_EXISTENTE' : 'SOLICITADA_FDV',
      'PROGRAMADO_EN_CRONOGRAMA',
      `PDV: ${cleanStoreName} | Prod: ${supplies.productFocus} (${supplies.plannedUnits} un) | Promotora: ${assignedPromotora} | Insumos: ${supplies.operationalSupplies.servilletas} serv., ${supplies.operationalSupplies.palillos} palillos, ${supplies.operationalSupplies.envases} envases`
    );

    return {
      visit: upsertedVisit,
      isUpdate,
      assignedPromotora,
      supplies,
    };
  };

  const removeVisitByTastingRequest = (
    solicitudId: string,
    degustacionId?: string,
    justification?: string
  ): boolean => {
    const cleanSolId = String(solicitudId || '').trim();
    const cleanDegId = degustacionId ? String(degustacionId).trim() : undefined;
    if (!cleanSolId && !cleanDegId) return false;

    const matchesRequest = (v: ScheduledVisit) =>
      (Boolean(cleanSolId) && (v.id === cleanSolId || v.solicitudId === cleanSolId)) ||
      (Boolean(cleanDegId) && Boolean(v.degustacionId) && v.degustacionId === cleanDegId);

    const matchingIds = visits.filter(matchesRequest).map((v) => v.id);
    recordDeletedVisitIds([cleanSolId, cleanDegId || '', ...matchingIds].filter(Boolean));

    let hadMatch = matchingIds.length > 0;
    setVisits((prev) => {
      const next = prev.filter((v) => !matchesRequest(v));
      if (next.length < prev.length) hadMatch = true;
      return next;
    });

    setModule1Bundle((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tastingItems: prev.tastingItems.filter(
          (t) =>
            t.id !== cleanSolId &&
            (!cleanDegId || !t.degustacionId || t.degustacionId !== cleanDegId)
        ),
        visitsForSchedule: prev.visitsForSchedule.filter((sv) => !matchesRequest(sv)),
      };
    });

    addAuditLog(
      'CAMPO',
      cleanDegId || cleanSolId,
      'REVERSION_AUTO_MOD1_MOD2',
      'PROGRAMADO_EN_CRONOGRAMA',
      'RETIRADO_DE_MATRIZ',
      justification || 'Solicitud rechazada/cancelada en Módulo 1 y removida del Cronograma de Producción'
    );

    return hadMatch;
  };

  const clearVisitsBatch = async (
    criteria: ClearVisitsCriteria
  ): Promise<ClearVisitsBatchResult> => {
    const snapshot = visitsRef.current;
    const matches = (v: ScheduledVisit) => {
      if (criteria.mode === 'ALL') return true;
      if (criteria.storeIds && !criteria.storeIds.includes(v.storeId)) return false;
      if (criteria.product && !(v.productFocus || '').toUpperCase().includes(criteria.product.toUpperCase())) return false;
      if (criteria.shift && v.shift !== criteria.shift) return false;
      if (criteria.date && v.date !== criteria.date) return false;
      return true;
    };
    const targets = snapshot.filter(matches);
    const removable = targets.filter((v) => v.status === 'PENDIENTE' && !v.enHistorial);
    const preservedNonPending = targets.length - removable.length;
    if (removable.length === 0) {
      return { ok: true, removed: 0, preservedNonPending };
    }

    const cancelRes = await deleteVisitsByIds(
      removable.map((v) => v.id),
      `LIMPIEZA_LOTE_${criteria.mode}`
    );

    return {
      ok: cancelRes.ok,
      error: cancelRes.error,
      reverted: cancelRes.reverted,
      removed: cancelRes.removed,
      preservedNonPending: preservedNonPending + cancelRes.preservedHistorical,
    };
  };

  // ---- Estado de sincronización agregado (única fuente: servidor) ----
  const syncErrorMessage =
    supabaseError ||
    masterData.error ||
    solicitudesContraloria.error ||
    degustacionNotifications.syncError ||
    null;
  const isAnySyncing =
    isLoadingSupabase ||
    masterData.cargando ||
    solicitudesContraloria.isLoading ||
    degustacionNotifications.isLoadingNotifications;
  const syncState: SyncState = isAnySyncing
    ? 'sincronizando'
    : syncErrorMessage
      ? 'error'
      : degustacionNotifications.isRealtimeConnected || cronogramaRealtime.isRealtimeConnected
        ? 'tiempo_real'
        : 'sincronizado';
  const syncStatus: SyncStatus = {
    state: syncState,
    errorMessage: syncErrorMessage,
    lastSyncAt: module1Bundle?.fetchedAt ?? masterData.ultimaActualizacionIso ?? null,
  };

  const refreshAll = async () => {
    if (requiresSucursalSelectionRef.current) {
      return;
    }
    await Promise.all([
      refreshSupabaseData(),
      refreshFinancialData(),
      refreshAuditLogs(),
      refreshDiscrepancyAlerts(),
      rawMasterData.refrescar().finally(() => {
        setIsMasterCachePurged(false);
      }),
      masterEntities.refresh(true),
      degustacionNotifications.reloadNotifications(),
      solicitudesContraloria.refreshSolicitudes(),
    ]);
  };

  return (
    <AppContext.Provider
      value={{
        currentUser,
        currentRole,
        setCurrentRole,
        role,
        assignedRegion,
        assignedRegions,
        assignedRegionCodes,
        isRegionalRestricted,
        canSwitchAmongAssignedRegions,
        verifiedIamRole,
        verifiedSucursal,
        verifiedRegionId,
        activeRegiones: scopedActiveRegiones,
        activeRegionScope,
        setActiveRegionScope,
        activeSucursal,
        activeSucursalLabel,
        canSwitchSucursal,
        requiresSucursalSelection,
        setActiveSucursal,
        purgeRegionalStateCache,
        isStrictAdmin,
        isContraloriaOrAdmin,
        isTradeOpsRole,
        caracasWeekStartYmd,
        users,
        stores,
        masterData,
        masterEntities,
        visits,
        requests,
        tastingReports,
        reconciliation,
        auditLogs,
        isLoadingAuditLogs,
        auditLogsError,
        hasMoreAuditLogs,
        refreshAuditLogs,
        loadMoreAuditLogs,
        discrepancyAlerts,
        isLoadingDiscrepancyAlerts,
        discrepancyAlertsError,
        hasMoreDiscrepancyAlerts,
        refreshDiscrepancyAlerts,
        loadMoreDiscrepancyAlerts,
        createDiscrepancyAlert,
        resolveDiscrepancyAlert,
        module1Bundle,
        isLoadingSupabase,
        supabaseError,
        refreshSupabaseData,
        syncStatus,
        isCronogramaRealtimeConnected: cronogramaRealtime.isRealtimeConnected,
        refreshAll,
        degustacionNotifications,
        focusedTastingId,
        setFocusedTastingId,
        focusedTastingSnapshot,
        setFocusedTastingSnapshot,
        solicitudesContraloria,
        campanasTrade,
        presupuestosTrade,
        tarifarioCostos,
        conciliacionesByReqId,
        certificadosPazYSalvo,
        isLoadingFinancial,
        refreshFinancialData,
        selectReconciliationForRequest,
        saveCampanaTrade,
        savePresupuestoTrade,
        saveTarifarioCosto,
        verifyPazYSalvoCertificate,
        advanceRequisitionWorkflow,
        createRequisition,
        addFiscalReceipt,
        validateFiscalReceipt,
        updateReconciliation,
        closeReconciliationAndIssuePazYSalvo,
        updateVisit,
        updateVisitFromProductFill,
        addVisit,
        deleteVisit,
        deleteVisitsByIds,
        clearVisitsBatch,
        batchFillClientsProductShift,
        upsertVisitFromApprovedTasting,
        removeVisitByTastingRequest,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useOptionalApp = (): AppContextType | undefined => {
  return useContext(AppContext);
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
