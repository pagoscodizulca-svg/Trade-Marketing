import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
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
  OfflineQueueItem,
  FiscalReceipt,
  ShiftType,
  DegustacionNotificationItem,
  SolicitudProductoContraloria,
} from '../types';
import {
  useDegustacionesNotifications,
  UseDegustacionesNotificationsResult,
} from '../hooks/useDegustacionesNotifications';
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
  calculateProductionSupplies,
  normalizeProductionShift,
  ProductionSuppliesResult,
} from '../utils/productionSuppliesCalculator';

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

interface AppContextType {
  currentUser: User | null;
  currentRole: UserRole;
  setCurrentRole: (role: UserRole) => void;
  users: User[];
  stores: Store[];
  visits: ScheduledVisit[];
  requests: ControllerRequest[];
  tastingReports: TastingExecutionReport[];
  reconciliation: InventoryReconciliation;
  auditLogs: AuditLogEntry[];
  discrepancyAlerts: DiscrepancyAlert[];

  // Datos sincronizados desde Supabase para el Módulo 1 y Módulo 2
  module1Bundle: Module1SupabaseBundle | null;
  isLoadingSupabase: boolean;
  supabaseError: string | null;
  refreshSupabaseData: () => Promise<void>;

  /** Estado global de sincronización (módulos 1-4 + notificaciones + solicitudes) */
  syncStatus: SyncStatus;
  /** Sincroniza manualmente TODAS las fuentes (Supabase, degustaciones y solicitudes de contraloría) */
  refreshAll: () => Promise<void>;

  // Notificaciones en tiempo real de Degustaciones enviadas por Vendedores (Globito + Detalle)
  degustacionNotifications: UseDegustacionesNotificationsResult;
  focusedTastingId: string | null;
  setFocusedTastingId: (id: string | null) => void;
  focusedTastingSnapshot: DegustacionNotificationItem | null;
  setFocusedTastingSnapshot: (item: DegustacionNotificationItem | null) => void;

  // Flujo en tiempo real Trade Marketing <-> Contraloría Interna ("SOLICITUD DE PRODUCTOS")
  solicitudesContraloria: UseSolicitudesContraloriaResult;

  // Actions
  advanceRequisitionWorkflow: (
    requestId: string,
    nextStatus: any,
    justification?: string,
    comments?: string
  ) => { success: boolean; message: string };
  createRequisition: (req: Partial<ControllerRequest>) => void;
  addFiscalReceipt: (
    receipt: Omit<FiscalReceipt, 'id' | 'isValidatedByContraloria'>
  ) => { success: boolean; message: string };
  validateFiscalReceipt: (receiptId: string, isValid: boolean, notes?: string) => void;
  updateReconciliation: (updates: Partial<InventoryReconciliation>) => void;
  closeReconciliationAndIssuePazYSalvo: (notes: string) => { success: boolean; message: string };
  updateVisit: (visitId: string, updates: Partial<ScheduledVisit>) => void;
  updateVisitFromProductFill: (visitId: string, product: string, quantityInput: string) => void;
  addVisit: (visit: Omit<ScheduledVisit, 'id'>) => void;
  deleteVisit: (visitId: string) => void;
  deleteVisitsByIds: (visitIds: string[]) => number;
  clearVisitsBatch: (criteria: ClearVisitsCriteria) => { removed: number; preservedNonPending: number };
  batchFillClientsProductShift: (params: {
    storeIds: string[];
    product: string;
    quantityInput: string;
    shift: ShiftType;
    dayLabel: string;
    date?: string;
    promotoraName?: string;
    sellerName?: string;
  }) => { countUpdated: number; countCreated: number };
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

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Todas las listas arrancan VACÍAS y solo se llenan con datos sincronizados (Supabase) o registrados por el usuario en la sesión.
  const [users, setUsers] = useState<User[]>([]);
  const [currentRole, setCurrentRole] = useState<UserRole>('promotora');
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  const [stores, setStores] = useState<Store[]>([]);
  const [visits, setVisits] = useState<ScheduledVisit[]>([]);
  const [requests, setRequests] = useState<ControllerRequest[]>([]);
  const [tastingReports, setTastingReports] = useState<TastingExecutionReport[]>([]);
  const [reconciliation, setReconciliation] = useState<InventoryReconciliation>(EMPTY_RECONCILIATION);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [discrepancyAlerts, setDiscrepancyAlerts] = useState<DiscrepancyAlert[]>([]);

  // Estado de sincronización con Supabase (Módulo 1 y Módulo 2)
  const [module1Bundle, setModule1Bundle] = useState<Module1SupabaseBundle | null>(null);
  const [isLoadingSupabase, setIsLoadingSupabase] = useState<boolean>(true);
  const [supabaseError, setSupabaseError] = useState<string | null>(null);
  const [focusedTastingId, setFocusedTastingId] = useState<string | null>(null);
  const [focusedTastingSnapshot, setFocusedTastingSnapshot] =
    useState<DegustacionNotificationItem | null>(null);

  const refreshSupabaseData = useCallback(async () => {
    setIsLoadingSupabase(true);
    setSupabaseError(null);
    try {
      const bundle = await fetchAllModule1FromSupabase();
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

      // Sincronizar catálogo real de PDVs registrados en Supabase
      setStores((prev) => {
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

  useEffect(() => {
    // Sin usuarios sincronizados no hay usuario actual (no se inventa ninguno).
    const user = users.find((u) => u.role === currentRole) || users[0] || null;
    setCurrentUser(user);
  }, [currentRole, users]);

  const addAuditLog = (
    entityType: AuditLogEntry['entityType'],
    entityId: string,
    action: string,
    previousState?: string,
    newState?: string,
    justification?: string
  ) => {
    const newEntry: AuditLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      entityType,
      entityId,
      action,
      userId: currentUser?.id ?? '',
      userName: currentUser?.name ?? '',
      userRole: currentUser?.role ?? currentRole,
      ipAddress: '',
      previousState,
      newState,
      justification,
      integrityHash: '',
    };
    setAuditLogs((prev) => [newEntry, ...prev]);
    // Hash SHA-256 real del contenido de la entrada (se completa de forma asíncrona).
    void sha256Hex(
      JSON.stringify({
        id: newEntry.id,
        timestamp: newEntry.timestamp,
        entityType,
        entityId,
        action,
        userId: newEntry.userId,
        previousState,
        newState,
        justification,
      })
    )
      .then((hex) => {
        setAuditLogs((prev) =>
          prev.map((e) => (e.id === newEntry.id ? { ...e, integrityHash: 'sha256:' + hex } : e))
        );
      })
      .catch(() => {
        // Sin crypto.subtle disponible: la entrada queda sin hash (nunca con uno falso)
      });
  };

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

  const advanceRequisitionWorkflow = (
    requestId: string,
    nextStatus: any,
    justification?: string,
    comments?: string
  ) => {
    const req = requests.find((r) => r.id === requestId);
    if (!req) return { success: false, message: 'Requisición no encontrada.' };

    const oldStatus = req.status;

    setRequests((prev) =>
      prev.map((r) => {
        if (r.id !== requestId) return r;
        const updated = { ...r, status: nextStatus };
        if (nextStatus === 'VALIDACION_COMERCIAL') {
          updated.commercialApprover = {
            name: currentUser?.name ?? '',
            date: new Date().toLocaleString('es-VE'),
            comments,
          };
        } else if (nextStatus === 'REVISION_FINANCIERA') {
          updated.financialAuditor = {
            name: currentUser?.name ?? '',
            date: new Date().toLocaleString('es-VE'),
            comments,
          };
        } else if (nextStatus === 'APROBADO_CONTRALORIA') {
          updated.finalApprover = {
            name: currentUser?.name ?? '',
            date: new Date().toLocaleString('es-VE'),
            comments,
          };
        } else if (nextStatus === 'RECHAZADO') {
          updated.rejectionReason = justification || comments || 'Rechazado por Contraloría.';
        }
        return updated;
      })
    );

    addAuditLog(
      'REQUISITION',
      req.requestCode,
      `WORKFLOW_TRANSICION_${nextStatus}`,
      oldStatus,
      nextStatus,
      justification || comments || 'Aprobado según perfil.'
    );
    return { success: true, message: `Estado actualizado a: ${nextStatus}.` };
  };

  const createRequisition = (req: Partial<ControllerRequest>) => {
    const items = req.items || [];
    const totalUnits = items.reduce((acc, it) => acc + it.quantityRequested, 0);
    const estimatedCostUsd = items.reduce((acc, it) => acc + it.totalCostUsd, 0);
    const nextNumber = String(requests.length + 1).padStart(4, '0');
    const newReq: ControllerRequest = {
      id: `req_${Date.now()}`,
      requestCode: req.requestCode || `MP-${new Date().getFullYear()}-${nextNumber}`,
      requestDate: req.requestDate || new Date().toLocaleDateString('es-VE'),
      targetDepartment: req.targetDepartment || 'CONTRALORÍA',
      campaignOrPurpose: req.campaignOrPurpose || 'Degustación y activación comercial',
      applicantDepartment: req.applicantDepartment || 'MERCADEO Y PUBLICIDAD',
      applicantName: req.applicantName || currentUser?.name || '',
      targetRecipient: req.targetRecipient || 'Facturación / Almacén Codizulca',
      deliveryDestination: req.deliveryDestination || 'Despacho Operativo Trade Marketing',
      notesAndObservations: req.notesAndObservations || '',
      budgetCategory: req.budgetCategory || 'Activación BTL - Trade Marketing',
      approvedBudgetCapUsd: req.approvedBudgetCapUsd ?? estimatedCostUsd,
      status: req.status || 'VALIDACION_COMERCIAL',
      items,
      totalUnits,
      estimatedCostUsd,
    };

    setRequests((prev) => [newReq, ...prev]);

    setReconciliation((prev) => {
      if (prev.requestCode) return prev;
      return {
        ...prev,
        requestId: newReq.id,
        requestCode: newReq.requestCode,
        productName: items[0]?.productName || newReq.campaignOrPurpose,
        deliveredUnits: totalUnits,
        degustatedUnitsReported: 0,
        returnedRemanentUnits: 0,
        discrepancyUnits: totalUnits,
        discrepancyStatus: totalUnits === 0 ? 'CUADRADO' : 'MERMA_NO_JUSTIFICADA',
        pazYSalvoIssued: false,
      };
    });

    addAuditLog(
      'REQUISITION',
      newReq.requestCode,
      'CREACION_NUEVA_REQUISICION',
      'N/A',
      newReq.status,
      'Nueva solicitud radicada.'
    );
  };

  const addFiscalReceipt = (receipt: Omit<FiscalReceipt, 'id' | 'isValidatedByContraloria'>) => {
    const exists = reconciliation.receipts.some(
      (r) =>
        r.supplierRif.trim().toUpperCase() === receipt.supplierRif.trim().toUpperCase() &&
        r.invoiceNumber.trim().toLowerCase() === receipt.invoiceNumber.trim().toLowerCase()
    );

    if (exists) {
      const alert: DiscrepancyAlert = {
        id: `alert_${Date.now()}`,
        severity: 'CRITICA',
        title: 'Intento de Factura Fiscal Duplicada',
        description: `Se intentó cargar la factura ${receipt.invoiceNumber} del proveedor ${receipt.supplierRif} que ya fue rendida previamente.`,
        entityCode: receipt.invoiceNumber,
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        detectedByRule: 'RULE_ANTIFRAUD_DUPLICATE_INVOICE',
        resolved: false,
      };
      setDiscrepancyAlerts((prev) => [alert, ...prev]);
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

    const newRec: FiscalReceipt = {
      ...receipt,
      id: `rec_${Date.now()}`,
      isValidatedByContraloria: false,
    };

    setReconciliation((prev) => ({
      ...prev,
      receipts: [newRec, ...prev.receipts],
      totalExpensesReportedUsd: prev.totalExpensesReportedUsd + newRec.totalUsd,
      balanceDueCompanyOrPromotorUsd:
        prev.approvedPettyCashUsd - (prev.totalExpensesReportedUsd + newRec.totalUsd),
    }));

    addAuditLog(
      'EXPENSE',
      newRec.invoiceNumber,
      'COMPROBANTE_FISCAL_SUBIDO',
      undefined,
      'PENDIENTE_VALIDACION',
      `Factura por $${newRec.totalUsd} cargada a rendición.`
    );
    return {
      success: true,
      message: 'Factura registrada con éxito. En cola de validación fiscal.',
    };
  };

  const validateFiscalReceipt = (receiptId: string, isValid: boolean, notes?: string) => {
    setReconciliation((prev) => ({
      ...prev,
      receipts: prev.receipts.map((r) =>
        r.id === receiptId
          ? {
              ...r,
              isValidatedByContraloria: isValid,
              validationNotes:
                notes || (isValid ? 'Conforme fiscalmente.' : 'Rechazada por inconformidad.'),
            }
          : r
      ),
    }));

    addAuditLog(
      'EXPENSE',
      receiptId,
      isValid ? 'FACTURA_CONTRALORIA_CONFORME' : 'FACTURA_CONTRALORIA_RECHAZADA',
      undefined,
      isValid ? 'VALIDADO' : 'OBSERVADO',
      notes
    );
  };

  const updateReconciliation = (updates: Partial<InventoryReconciliation>) => {
    setReconciliation((prev) => {
      const next = { ...prev, ...updates };
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
      next.balanceDueCompanyOrPromotorUsd =
        (Number(next.approvedPettyCashUsd) || 0) - (Number(next.totalExpensesReportedUsd) || 0);
      return next;
    });
  };

  const closeReconciliationAndIssuePazYSalvo = (notes: string) => {
    const variance =
      reconciliation.deliveredUnits -
      (reconciliation.degustatedUnitsReported + reconciliation.returnedRemanentUnits);

    if (variance !== 0) {
      return {
        success: false,
        message: `BLOQUEO DE CONTRALORÍA: No se puede emitir Paz y Salvo con una diferencia de ${variance} unidades sin justificar.`,
      };
    }

    const certHash =
      'SHA256:' +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    const targetCode = reconciliation.requestCode || requests[0]?.requestCode || 'GENERAL';

    setReconciliation((prev) => ({
      ...prev,
      requestCode: targetCode,
      discrepancyStatus: 'CUADRADO',
      pazYSalvoIssued: true,
      pazYSalvoIssueDate: new Date().toISOString(),
      pazYSalvoHash: certHash,
      auditNotes: notes,
    }));

    setRequests((prev) =>
      prev.map((r) => (r.requestCode === targetCode ? { ...r, status: 'CONCILIADO_CERRADO' } : r))
    );

    addAuditLog(
      'RECONCILIATION',
      targetCode,
      'EMISION_PAZ_Y_SALVO_DIGITAL',
      'RENDICION_PENDIENTE',
      'CONCILIADO_CERRADO',
      notes
    );
    return {
      success: true,
      message: 'Conciliación cerrada exitosamente. Certificado digital de Paz y Salvo emitido!',
    };
  };

  const updateVisit = (visitId: string, updates: Partial<ScheduledVisit>) => {
    setVisits((prev) => prev.map((v) => (v.id === visitId ? { ...v, ...updates } : v)));
  };

  const updateVisitFromProductFill = (visitId: string, product: string, quantityInput: string) => {
    const fields = buildProductFields(product, quantityInput);
    setVisits((prev) => prev.map((v) => (v.id === visitId ? { ...v, ...fields } : v)));
  };

  const addVisit = (visit: Omit<ScheduledVisit, 'id'>) => {
    const promotoraPool = users
      .filter((u) => u.role === 'promotora')
      .map((u) => u.name.trim());
    const requestedKey = canonicalStaffKey(visit.promotoraName || '');
    const matchedActiveName =
      promotoraPool.find((p) => canonicalStaffKey(p) === requestedKey) ||
      promotoraPool[0] ||
      'POR ASIGNAR (Trade Marketing)';
    const matchedKey = canonicalStaffKey(matchedActiveName);

    let finalPromotora = matchedActiveName;
    const hasConflict =
      Boolean(matchedKey) &&
      !matchedActiveName.toUpperCase().startsWith('POR ASIGNAR') &&
      visits.some(
        (v) =>
          v.dayLabel === visit.dayLabel &&
          v.shift === visit.shift &&
          canonicalStaffKey(v.promotoraName) === matchedKey
      );
    if (hasConflict) {
      const occupiedKeys = new Set(
        visits
          .filter((v) => v.dayLabel === visit.dayLabel && v.shift === visit.shift)
          .map((v) => canonicalStaffKey(v.promotoraName))
          .filter(Boolean)
      );
      const available = promotoraPool.find((p) => !occupiedKeys.has(canonicalStaffKey(p)));
      if (available) finalPromotora = available;
    }

    const newVisit: ScheduledVisit = {
      ...visit,
      promotoraName: finalPromotora,
      id: `vis_${Date.now()}_${Math.floor(Math.random() * 900 + 100)}`,
    };
    setVisits((prev) => [newVisit, ...prev]);
    addAuditLog(
      'CAMPO',
      newVisit.id,
      'NUEVA_ACTIVACION_AGREGADA',
      'N/A',
      newVisit.status,
      `Tienda: ${newVisit.storeName}, Producto: ${newVisit.productFocus}`
    );
  };

  const deleteVisit = (visitId: string) => {
    recordDeletedVisitIds([visitId]);
    setVisits((prev) => {
      const next = prev.filter((v) => v.id !== visitId);
      if (next.length === 0) {
        markVisitsCleared();
      }
      return next;
    });
    addAuditLog(
      'CAMPO',
      visitId,
      'ACTIVACION_ELIMINADA',
      'ACTIVO',
      'ELIMINADO',
      'Registro retirado de la matriz'
    );
  };

  const deleteVisitsByIds = (visitIds: string[]): number => {
    const idSet = new Set(visitIds.filter(Boolean));
    if (idSet.size === 0) return 0;

    recordDeletedVisitIds(idSet);
    let removedCount = 0;

    setVisits((prev) => {
      const next = prev.filter((v) => !idSet.has(v.id));
      removedCount = prev.length - next.length;
      if (next.length === 0) {
        markVisitsCleared();
        if (module1Bundle?.visitsForSchedule) {
          recordDeletedVisitIds(module1Bundle.visitsForSchedule.map((sv) => sv.id));
        }
      }
      return next;
    });

    addAuditLog(
      'CAMPO',
      'BATCH_DELETE_SELECTED',
      'ELIMINACION_SELECCIONADOS_TABLA',
      'ACTIVO',
      'ELIMINADO',
      `Se eliminaron ${idSet.size} registros seleccionados de la Tabla General de Activaciones`
    );

    return removedCount || idSet.size;
  };

  const batchFillClientsProductShift = (params: {
    storeIds: string[];
    product: string;
    quantityInput: string;
    shift: ShiftType;
    dayLabel: string;
    date?: string;
    promotoraName?: string;
    sellerName?: string;
  }): { countUpdated: number; countCreated: number } => {
    const {
      storeIds,
      product,
      quantityInput,
      shift,
      dayLabel,
      date,
      promotoraName,
      sellerName,
    } = params;
    const effectiveDate = date || getTodayVeYmd();
    const calc = calculateProductionSupplies(product, quantityInput);
    const {
      productFocus: prodUpper,
      mortadelaQty,
      espaldaQty,
      arrozQty,
      azucarGrams,
      lecheGrams,
      rowHighlight,
      plannedUnits,
      additionalGoods,
      operationalSupplies,
    } = calc;

    const uniqueStoreIds = Array.from(new Set(storeIds));
    // Coincidencia por fecha ISO real (respaldo: dayLabel si la fila no tiene fecha)
    const sameSlot = (v: ScheduledVisit) =>
      v.shift === shift && (v.date ? v.date === effectiveDate : v.dayLabel === dayLabel);
    const countUpdated = visits.filter(
      (v) => uniqueStoreIds.includes(v.storeId) && sameSlot(v)
    ).length;
    const storesWithVisit = new Set(visits.filter(sameSlot).map((v) => v.storeId));
    const countCreated = uniqueStoreIds.filter(
      (id) => !storesWithVisit.has(id) && stores.some((s) => s.id === id)
    ).length;

    setVisits((prev) => {
      const nextVisits = [...prev];
      const visitedStoreIds = new Set<string>();

      for (let i = 0; i < nextVisits.length; i++) {
        const v = nextVisits[i];
        if (uniqueStoreIds.includes(v.storeId) && sameSlot(v)) {
          visitedStoreIds.add(v.storeId);
          nextVisits[i] = {
            ...v,
            date: effectiveDate,
            productFocus: prodUpper,
            fillProductSelection: prodUpper,
            fillQuantityInput: calc.fillQuantityInput,
            mortadelaQty,
            espaldaQty,
            arrozQty,
            azucarGrams,
            lecheGrams,
            plannedUnits,
            rowHighlight,
            promotoraName: promotoraName || v.promotoraName,
            sellerName: sellerName || v.sellerName,
            additionalGoods,
            operationalSupplies,
          };
        }
      }

      const promotoraPool = users
        .filter((u) => u.role === 'promotora')
        .map((u) => u.name.trim());

      const occupiedPromotoraKeys = new Set<string>();
      nextVisits.forEach((v) => {
        if (
          v.dayLabel === dayLabel &&
          v.shift === shift &&
          v.promotoraName &&
          !v.promotoraName.toUpperCase().startsWith('POR ASIGNAR') &&
          !v.promotoraName.toUpperCase().startsWith('SIN ASIGNAR')
        ) {
          occupiedPromotoraKeys.add(canonicalStaffKey(v.promotoraName));
        }
      });

      for (const storeId of uniqueStoreIds) {
        if (!visitedStoreIds.has(storeId)) {
          const storeObj = stores.find((s) => s.id === storeId);
          if (!storeObj) continue;

          let assignedPromotora = '';
          const requestedKey = promotoraName ? canonicalStaffKey(promotoraName) : '';
          const requestedMatch = requestedKey
            ? promotoraPool.find((p) => canonicalStaffKey(p) === requestedKey)
            : undefined;

          if (requestedMatch && !occupiedPromotoraKeys.has(requestedKey)) {
            assignedPromotora = requestedMatch;
            occupiedPromotoraKeys.add(requestedKey);
          } else {
            const freePromotora = promotoraPool.find(
              (p) => !occupiedPromotoraKeys.has(canonicalStaffKey(p))
            );
            assignedPromotora =
              freePromotora || promotoraPool[0] || 'POR ASIGNAR (Trade Marketing)';
            if (!assignedPromotora.toUpperCase().startsWith('POR ASIGNAR')) {
              occupiedPromotoraKeys.add(canonicalStaffKey(assignedPromotora));
            }
          }

          const newVisit: ScheduledVisit = {
            id: `vis_${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}_${storeId}`,
            date: effectiveDate,
            dayLabel,
            shift,
            storeId: storeObj.id,
            storeName: storeObj.name,
            zone: storeObj.zone,
            productFocus: prodUpper,
            fillProductSelection: prodUpper,
            fillQuantityInput: calc.fillQuantityInput,
            promotoraId: 'usr_prom_01',
            promotoraName: assignedPromotora,
            sellerName: sellerName || storeObj.sellerName || 'FDV Codizulca',
            plannedUnits,
            mortadelaQty,
            espaldaQty,
            arrozQty,
            azucarGrams,
            lecheGrams,
            rowHighlight,
            status: 'PENDIENTE',
            additionalGoods,
            operationalSupplies,
          };
          nextVisits.unshift(newVisit);
        }
      }

      return nextVisits;
    });

    addAuditLog(
      'CAMPO',
      'BATCH_FILL',
      'LLENADO_POR_LOTE_EXITOSO',
      'VARIOS',
      prodUpper,
      `Llenado en lote: ${storeIds.length} clientes, producto: ${prodUpper}, jornada: ${shift}, fecha: ${effectiveDate}`
    );

    return { countUpdated, countCreated };
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
      setStores((prev) => {
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
      promotoraId: matchedUser?.id || existingVisit?.promotoraId || 'usr_prom_sync',
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

  const clearVisitsBatch = (criteria: ClearVisitsCriteria): { removed: number; preservedNonPending: number } => {
    const matches = (v: ScheduledVisit) => {
      if (criteria.mode === 'ALL') return true;
      if (criteria.storeIds && !criteria.storeIds.includes(v.storeId)) return false;
      if (criteria.product && !(v.productFocus || '').toUpperCase().includes(criteria.product.toUpperCase())) return false;
      if (criteria.shift && v.shift !== criteria.shift) return false;
      if (criteria.date && v.date !== criteria.date) return false;
      return true;
    };
    const targets = visits.filter(matches);
    const removable = targets.filter((v) => v.status === 'PENDIENTE');
    const removeIds = new Set(removable.map((v) => v.id));
    if (removeIds.size > 0) {
      recordDeletedVisitIds(removeIds);
      setVisits((prev) => {
        const next = prev.filter((v) => !removeIds.has(v.id));
        if (next.length === 0 || criteria.mode === 'ALL') {
          markVisitsCleared();
          if (module1Bundle?.visitsForSchedule) {
            recordDeletedVisitIds(module1Bundle.visitsForSchedule.map((sv) => sv.id));
          }
        }
        return next;
      });
    }
    addAuditLog(
      'CAMPO',
      'BATCH_CLEAR',
      'LIMPIEZA_POR_LOTE',
      'ACTIVO',
      'ELIMINADO',
      `Modo ${criteria.mode}: ${removeIds.size} filas eliminadas, ${targets.length - removeIds.size} preservadas (no PENDIENTE)`
    );
    return { removed: removeIds.size, preservedNonPending: targets.length - removeIds.size };
  };

  // ---- Estado de sincronización agregado (única fuente: servidor) ----
  const syncErrorMessage =
    supabaseError || solicitudesContraloria.error || degustacionNotifications.syncError || null;
  const isAnySyncing =
    isLoadingSupabase ||
    solicitudesContraloria.isLoading ||
    degustacionNotifications.isLoadingNotifications;
  const syncState: SyncState = isAnySyncing
    ? 'sincronizando'
    : syncErrorMessage
      ? 'error'
      : degustacionNotifications.isRealtimeConnected
        ? 'tiempo_real'
        : 'sincronizado';
  const syncStatus: SyncStatus = {
    state: syncState,
    errorMessage: syncErrorMessage,
    lastSyncAt: module1Bundle?.fetchedAt ?? null,
  };

  const refreshAll = async () => {
    await Promise.all([
      refreshSupabaseData(),
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
        users,
        stores,
        visits,
        requests,
        tastingReports,
        reconciliation,
        auditLogs,
        discrepancyAlerts,
        module1Bundle,
        isLoadingSupabase,
        supabaseError,
        refreshSupabaseData,
        syncStatus,
        refreshAll,
        degustacionNotifications,
        focusedTastingId,
        setFocusedTastingId,
        focusedTastingSnapshot,
        setFocusedTastingSnapshot,
        solicitudesContraloria,
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

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
