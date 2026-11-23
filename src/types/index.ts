export type UserRole = 
  | 'promotora'
  | 'supervisor'
  | 'jefe_trade'
  | 'analista_contraloria'
  | 'gerente_admin';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  phone?: string;
  avatar?: string;
  assignedZone?: string;
}

export interface Store {
  id: string;
  name: string;
  clientCode: string;
  address: string;
  zone: string;
  city: string;
  /** null si el dato sincronizado no trae coordenadas (nunca se inventan) */
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusMeters: number; // 0 = sin geocerca definida
  sellerName: string;
  channel: 'Supermercado' | 'Mayorista' | 'Farmacia' | 'Minimarket' | '';
  cadenaId?: string | null;
  cadenaName?: string;
  zonaId?: string | null;
  sucursal?: 'ZULIA' | 'VALENCIA' | 'CENTRO' | 'ORIENTE' | 'CAPITAL' | 'GLOBAL' | null;
}

export type ShiftType = 'MAÑANA' | 'TARDE' | 'COMPLETO';

export interface OperationalSupplies {
  servilletas: number;
  palillos: number;
  envases: number;
  gramajeTotalG: number;
  estimatedPortions: number;
}

export interface ScheduledVisit {
  id: string;
  /** ID único de la fila sincronizada en public.cronograma_degustaciones */
  cronogramaId?: string;
  /** ID único de la solicitud de degustación de origen en Supabase (surveys.id) para sincronización idempotente Módulo 1 -> Módulo 2 */
  solicitudId?: string;
  /** Código correlativo canónico de la solicitud FDV (ej. deg-...) */
  degustacionId?: string;
  date: string; // YYYY-MM-DD
  dayLabel: string; // e.g., 'Jueves 08'
  shift: ShiftType;
  storeId: string;
  storeName: string;
  zone: string;
  productFocus: string; // 'MORTADELA', 'VENCAMPO', 'ESPALDA', o lista combinada de productos
  /** Lista explícita de productos seleccionados para degustar en esta activación */
  selectedProducts?: string[];
  promotoraId: string;
  promotoraName: string;
  sellerName: string;
  plannedUnits: number;
  standNumber?: number | string;
  mapsUrl?: string;
  rowHighlight?: 'green' | 'yellow' | 'none';
  // Product Breakdown columns (Imagen 3)
  espaldaQty: number;
  mortadelaQty: number;
  arrozQty: number;
  azucarGrams: number;
  lecheGrams: number;
  // Llenado por producto (Imagen 2)
  fillProductSelection?: string;
  fillQuantityInput?: string;
  additionalGoods?: {
    arrozKg?: number;
    azucarKg?: number;
    lecheKg?: number;
  };
  operationalSupplies?: OperationalSupplies;
  tastedUnits?: number;
  returnedUnits?: number;
  assistedSalesUnits?: number;
  notes?: string;
  status: 'PENDIENTE' | 'EN_CURSO' | 'COMPLETADA' | 'AUSENTE' | 'FUERA_GEOFENCE';
  enHistorial?: boolean;
  archivadoEn?: string | null;
  motivoArchivo?: string | null;
  checkInTime?: string;
  checkOutTime?: string;
  checkInLat?: number;
  checkInLng?: number;
  distanceFromStoreMeters?: number;
  isWithinGeofence?: boolean;
}

export interface GondolaAudit {
  visitId: string;
  outOfStock: boolean;
  oosProducts: string[];
  shareOfShelfPercent: number; // e.g. 45%
  competitorBrandsObserved: { name: string; estimatedPrice: number; facings: number }[];
  photoBeforeUrl?: string;
  photoAfterUrl?: string;
  photoMetadata?: {
    timestamp: string;
    latitude: number;
    longitude: number;
    deviceHash: string;
    compressionSizeKb: number;
  };
}

export interface TastingExecutionReport {
  id: string;
  visitId: string;
  storeName: string;
  promotoraName: string;
  date: string;
  productName: string;
  lotNumber: string;
  expirationDate: string;
  unitsOpenedForSampling: number;
  directContactsImpacts: number; // Personas que probaron
  assistedSalesUnits: number; // Personas que compraron de inmediato en PDV
  conversionRatePercent: number;
  costPerContactUsd: number;
  sampleSlicesPerUnit?: number;
  observations?: string;
  status: 'SINCRONIZADO' | 'PENDIENTE_OFFLINE';
}

export type RequisitionStatus =
  | 'BORRADOR'
  | 'VALIDACION_COMERCIAL'
  | 'REVISION_FINANCIERA'
  | 'APROBADO_CONTRALORIA'
  | 'DESPACHADO_ALMACEN'
  | 'EN_EJECUCION'
  | 'RENDICION_PENDIENTE'
  | 'CONCILIADO_CERRADO'
  | 'RECHAZADO'
  | 'AJUSTE_SOLICITADO';

export interface RequestItem {
  id: string;
  itemNumber: number;
  productName: string;
  category: 'PRODUCTO_DEGUSTACION' | 'MATERIAL_POP' | 'VIATICO_GASTO';
  quantityRequested: number;
  unitOfMeasure: string;
  unitCostUsd: number;
  totalCostUsd: number;
  lotNumber?: string;
}

export interface ControllerRequest {
  id: string;
  requestCode: string; // e.g., 'MP-07-0067'
  requestDate: string; // e.g. '06/10/2026'
  targetDepartment: string; // 'CONTRALORÍA'
  campaignOrPurpose: string; // 'DEGUSTACIONES MARACAIBO DEL 08 AL 10 DE OCTUBRE DE 2026'
  applicantDepartment: string; // 'MERCADEO Y PUBLICIDAD'
  applicantName: string; // 'Castillo / Supervisor Trade'
  targetRecipient: string; // 'Lisseth Chirinos en Facturación'
  deliveryDestination: string; // 'Comercasur San Francisco para el rebanado'
  notesAndObservations: string;
  budgetCategory: string; // 'BTL / Trade Marketing - Occidente'
  approvedBudgetCapUsd: number;
  status: RequisitionStatus;
  items: RequestItem[];
  totalUnits: number;
  estimatedCostUsd: number;
  commercialApprover?: { name: string; date: string; comments?: string };
  financialAuditor?: { name: string; date: string; comments?: string };
  finalApprover?: { name: string; date: string; comments?: string };
  rejectionReason?: string;
  pazYSalvoCertificateId?: string;
  campanaId?: string | null;
  presupuestoId?: string | null;
  solicitudOrigenId?: string | null;
  sucursal?: 'ZULIA' | 'VALENCIA' | 'CENTRO' | 'ORIENTE' | 'CAPITAL' | null;
}

export interface FiscalReceipt {
  id: string;
  invoiceNumber: string;
  supplierRif: string;
  supplierName: string;
  concept: string;
  subtotalUsd: number;
  taxAmountUsd: number;
  totalUsd: number;
  imageUrl: string;
  storagePath?: string | null;
  mimeType?: string | null;
  archivoSha256Hex?: string | null;
  sizeBytes?: number | null;
  isValidatedByContraloria: boolean;
  validationNotes?: string;
}

export interface InventoryReconciliation {
  id?: string;
  requestId: string;
  requestCode: string;
  productName: string;
  deliveredUnits: number; // e.g., 36
  degustatedUnitsReported: number; // e.g., 34
  returnedRemanentUnits: number; // e.g., 2
  discrepancyUnits: number; // Delivered - (Degustated + Returned)
  discrepancyStatus: 'CUADRADO' | 'DESVIACION_ACEPTABLE' | 'MERMA_NO_JUSTIFICADA';
  returnWarehouseReceiptNumber?: string;
  receipts: FiscalReceipt[];
  totalExpensesReportedUsd: number;
  approvedPettyCashUsd: number;
  balanceDueCompanyOrPromotorUsd: number;
  auditNotes: string;
  cerrada?: boolean;
  pazYSalvoIssued: boolean;
  pazYSalvoCertificateCode?: string;
  pazYSalvoIssueDate?: string;
  pazYSalvoHash?: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  entityType: 'REQUISITION' | 'STORE_VISIT' | 'RECONCILIATION' | 'GEOFENCE' | 'EXPENSE' | 'AUDITORIA' | 'CAMPO';
  entityId: string;
  action: string;
  userId: string;
  userName: string;
  userRole: UserRole;
  ipAddress: string;
  previousState?: string;
  newState?: string;
  justification?: string;
  metadata?: Record<string, any>;
  integrityHash: string;
}

export interface DiscrepancyAlert {
  id: string;
  severity: 'ALTA' | 'MEDIA' | 'CRITICA';
  title: string;
  description: string;
  entityCode: string;
  timestamp: string;
  detectedByRule: string;
  resolved: boolean;
  resolutionNotes?: string;
}

export interface OfflineQueueItem {
  id: string;
  type: 'CHECK_IN' | 'CHECK_OUT' | 'GONDOLA_AUDIT' | 'TASTING_REPORT';
  payload: any;
  createdAt: string;
  status?: 'PENDIENTE' | 'SINCRONIZANDO' | 'SINCRONIZADO' | 'FALLIDO';
}
export interface CompetitorBrandPrice {
  brand: string;
  product: string;
  priceUsd: number;
  priceBs: number | null;
  diffPercent: number; // Porcentaje de diferencia vs producto Codizulca (negativo = Codizulca es más económico)
}

export interface MultiBrandPriceComparison {
  id: string;
  date: string;
  storeName: string;
  zone: string;
  category: string;
  ownProduct: string;
  ownPriceUsd: number;
  ownPriceBs: number;
  competitor1: CompetitorBrandPrice;
  competitor2: CompetitorBrandPrice;
  competitor3: CompetitorBrandPrice;
  averageCompetitorPriceUsd: number;
  averageDiffPercent: number;
  marketPosition: 'LÍDER EN PRECIO' | 'COMPETITIVO' | 'PARIDAD' | 'SOBREPRECIO';
  promotora: string;
  status: 'AUDITADO' | 'VERIFICADO';
}
export interface CompetitorItem {
  brand: string;
  product: string;
  priceUsd: number;
  priceBs: number | null;
  diffPercent: number;
  originalPrice?: number;
  currency?: 'USD' | 'VES';
  gapUsd?: number;
}

export interface PriceComparisonThreeBrands {
  id: string;
  date: string;
  dateSlash?: string;
  storeName: string;
  cadena?: string;
  zone: string;
  region?: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' | string;
  promotora: string;
  origin?: string;
  category: string;
  ownProduct: string;
  codizulcaSku?: string;
  ownPriceUsd: number;
  ownPriceBs: number | null;
  ownOriginalPrice?: number;
  ownCurrency?: 'USD' | 'VES';
  bcvRate?: number;
  bcvRateDate?: string;
  competitorBrand?: string;
  competitorProduct?: string;
  competitorPriceUsd?: number;
  competitorPriceBs?: number | null;
  competitorOriginalPrice?: number;
  competitorCurrency?: 'USD' | 'VES';
  brechaUsd?: number;
  gapPercent?: number;
  competitorsList?: CompetitorItem[];
  observations?: string;
  photoStoragePath?: string | null;
  ocrAsistido?: boolean;
  ocrConfianza?: 'alta' | 'media' | 'baja' | null;
  competitor1: CompetitorItem;
  competitor2: CompetitorItem;
  competitor3: CompetitorItem;
  averageCompetitorPriceUsd: number;
  averageCompetitorPriceBs: number | null;
  overallDiffPercent: number;
  status: string;
}

export interface BcvRateSnapshot {
  fecha: string;
  tasaUsdVes: number;
  fuente: 'BCV_OFICIAL' | 'MANUAL_ADMIN' | 'RESPALDO';
  fetchedAt: string;
  isFallback: boolean;
  fromCache?: boolean;
}

export interface PriceOcrDetectionResult {
  marca_detectada: string | null;
  producto_detectado: string | null;
  presentacion_detectada: string | null;
  monto_detectado: number | null;
  moneda_detectada: 'USD' | 'VES' | null;
  confianza: 'alta' | 'media' | 'baja';
  notas_lectura: string | null;
}

export interface PriceDropAlertRecord {
  id: string;
  price_id: string;
  previous_price_id: string | null;
  region: string;
  cadena: string | null;
  zona: string | null;
  store: string;
  producto_propio: string;
  marca_competidor: string;
  precio_anterior_usd: number;
  precio_actual_usd: number;
  caida_porcentaje: number;
  umbral_aplicado: number;
  severidad: 'baja' | 'media' | 'alta' | 'critica';
  estado: 'pendiente' | 'revisada' | 'descartada';
  notas_revision: string | null;
  revisada_por: string | null;
  revisada_at: string | null;
  created_at: string;
}

export interface PriceAlertConfigRecord {
  id?: string;
  region: string;
  umbral_caida_porcentaje: number;
  ventana_dias: number;
  activo: boolean;
  updated_at?: string;
}

// =============================================================================
// SINCRONIZACIÓN EN TIEMPO REAL DE DEGUSTACIONES (VENDEDORES -> TRADE MARKETING)
// =============================================================================

export interface DegustacionResultadoReport {
  kilosDegustados?: number;
  personasAlcanzadas?: number;
  ventasGeneradas?: string;
  comentarios?: string;
}

export interface DegustacionNotificationItem {
  id: string;
  degustacionId: string;
  source: string;
  createdAt: string;
  date: string;
  dayLabel: string;
  shift: ShiftType;
  turnoRaw?: string;
  timeRange: string;
  storeName: string;
  clienteCodigo: string;
  zone: string;
  address: string;
  contactoPunto: string;
  telefonoContacto: string;
  sellerName: string;
  vendedorId?: string;
  promotoraAsignada: string;
  requierePromotora: boolean;
  promoterType: string;
  materialPop: string;
  productName: string;
  productsList: string[];
  requestedQty: number;
  targetSamples: number;
  estado: string;
  notes: string;
  notasTradeMarketing: string;
  resultado?: DegustacionResultadoReport | null;
  leidoTrade: boolean;
  vistoEnTradeAt: string | null;
  rawComments: Record<string, any>;
}

export interface DegustacionToastAlert {
  toastId: string;
  degustacionId: string;
  surveyId: string;
  sellerName: string;
  storeName: string;
  productName: string;
  requestedQty: number;
  date: string;
  shift: ShiftType;
  createdAt: string;
}

// =============================================================================
// FLUJO TRADE MARKETING <-> CONTRALORÍA INTERNA: "SOLICITUD DE PRODUCTOS"
// =============================================================================

export type SolicitudContraloriaEstado =
  | 'PENDIENTE_APROBACION'
  | 'APROBADA'
  | 'RECHAZADA';

export interface SolicitudProductoRowItem {
  itemNumber: number;
  producto: string;
  cantidad: number | '';
}

export interface SolicitudProductoValidItem {
  itemNumber: number;
  producto: string;
  cantidad: number;
}

export interface SolicitudProductoContraloria {
  id: string;
  codigoCorrelativo: string; // Ej: "MP-07-0072"
  fechaSolicitud: string; // Formato "DD/MM/YYYY"
  fechaIso: string; // Formato "YYYY-MM-DD"
  dirigidoA: string; // Por defecto "CONTRALORÍA"
  paraSerUtilizado: string; // En mayúsculas, ej. "DEGUSTACIONES MARACAIBO DEL 15 AL 17 DE OCTUBRE DE 2026"
  items: SolicitudProductoValidItem[];
  totalUnidades: number;
  observacion: string; // En mayúsculas
  solicitadoPor: string; // Nombre del solicitante autenticado
  firmaDigitalTexto?: string; // Firma estilizada / texto de firma del solicitante
  firmaDigitalImagen?: string; // Trazo opcional base64 de firma digital
  departamentoSolicitante: string; // Fijo: "MERCADEO Y PUBLICIDAD"
  estado: SolicitudContraloriaEstado;
  notaContraloria?: string; // Motivo de rechazo o nota opcional de Contraloría
  resueltoPor?: string;
  resueltoAt?: string;
  leidoContraloria?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateSolicitudContraloriaInput {
  codigoCorrelativo?: string;
  fechaSolicitud: string;
  fechaIso: string;
  dirigidoA: string;
  paraSerUtilizado: string;
  items: SolicitudProductoRowItem[];
  observacion: string;
  solicitadoPor: string;
  firmaDigitalTexto?: string;
  firmaDigitalImagen?: string;
  departamentoSolicitante?: string;
}
