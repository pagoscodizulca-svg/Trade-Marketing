import {
  DegustacionNotificationItem,
  DegustacionResultadoReport,
  OperationalSupplies,
  PriceComparisonThreeBrands,
  ScheduledVisit,
  ShiftType,
} from '../types';
import type { TastingScheduleItem } from '../components/field/FieldPromotoraView';
import type {
  AsistenciaEvidenciaDbRow,
  AsistenciaJornadaDbRow,
} from '../types/attendanceEvidences';
import type { CronogramaDegustacionRecord } from '../types/degustacionesPipeline';
import { calculateProductionSupplies } from '../utils/productionSuppliesCalculator';
import { formatToDdMmYyyy } from '../utils/excelDateNormalizer';
import { FEATURE_FLAGS } from '../config/featureFlags';
import {
  extractCaracasWallClockParts,
  isTastingBeforeTodayCaracas,
  isTastingInPastCaracasWeek,
} from '../utils/caracasWeekCycle';
import { assertCanMutateTastingByWeekCycle } from './degustacionesWeeklyCycleService';
import {
  SUPABASE_ANON_KEY as CLIENT_SUPABASE_ANON_KEY,
  SUPABASE_REST_URL as CLIENT_SUPABASE_REST_URL,
  assertSupabaseConfigured,
  getCachedAccessToken,
  getSupabaseRealtimeClient,
} from './supabaseClient';
import {
  cambiarEstadoPromotoraMaestra,
  guardarPromotoraMaestra,
  obtenerPromotorasMaestras,
} from './masterCatalogSyncService';
import {
  DEFAULT_FDV_RENDER_API_URL,
  fetchDegustacionSurveysViaSdk,
  fetchFdvPlanificadorRenderDegustaciones,
  fetchNonDegustacionSurveysViaSdk,
  getCronogramaTableSupport,
  getSurveysArchiveColumnsSupport,
  getSurveysLeidoTradeSupport,
  isMissingColumnPostgrestError,
  isMissingTablePostgrestError,
  isVirtualFdvRenderSurveyId,
  mergeSupabaseAndRenderDegustacionRows,
  normalizeCanonicalFdvId,
  normalizeFdvCalendarDateYmd,
  resolveFdvRequestLifecycle,
  safeJsonParseObject,
  sanitizeExternalHttpsUrl,
  sanitizeFdvText,
  setCronogramaTableSupport,
  setSurveysArchiveColumnsSupport,
  setSurveysLeidoTradeSupport,
  syncDecisionToFdvPlanificadorRender,
  validateFdvRenderEndpoint,
} from './fdvDegustacionesAdapter';

export const SUPABASE_REST_URL = CLIENT_SUPABASE_REST_URL;
export const SUPABASE_ANON_KEY = CLIENT_SUPABASE_ANON_KEY;

/** `fetch` hacia Supabase que falla con un mensaje claro si no hay credenciales configuradas. */
function supabaseFetch(input: string, init?: RequestInit): Promise<Response> {
  assertSupabaseConfigured();
  return fetch(input, init);
}

export const FDV_PLANIFICADOR_RENDER_API_URL =
  validateFdvRenderEndpoint(
    (import.meta as unknown as { env?: Record<string, string | undefined> })?.env
      ?.VITE_FDV_PLANIFICADOR_API_URL
  ) || DEFAULT_FDV_RENDER_API_URL;

const supabaseHeaders = (extra?: Record<string, string>): Record<string, string> => {
  const activeJwt = getCachedAccessToken();
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${activeJwt || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
};

const PROGRESSIVE_RETRY_DELAYS_MS = [600, 1400] as const;

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ejecuta `fetch` con resiliencia para entorno móvil/ruta y enlaces inestables:
 * hasta 2 reintentos automáticos con espera progresiva (600ms -> 1400ms) ante
 * micro-cortes de señal, timeouts o errores HTTP transitorios (408/429/5xx).
 */
export async function fetchWithProgressiveRetry(
  url: string,
  init: RequestInit,
  options?: { maxRetries?: number; timeoutMs?: number }
): Promise<Response> {
  assertSupabaseConfigured();
  const maxRetries = options?.maxRetries ?? 2;
  const timeoutMs = options?.timeoutMs ?? 12000;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: init.signal ?? controller.signal,
      });
      clearTimeout(timer);

      if (isTransientHttpStatus(res.status) && attempt < maxRetries) {
        const delay = PROGRESSIVE_RETRY_DELAYS_MS[attempt] ?? 1800;
        await waitMs(delay);
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < maxRetries) {
        const delay = PROGRESSIVE_RETRY_DELAYS_MS[attempt] ?? 1800;
        await waitMs(delay);
        continue;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Fallo de conexión tras agotar los reintentos automáticos con Supabase.');
}

async function supabaseGet<T>(pathAndQuery: string): Promise<T> {
  const res = await fetchWithProgressiveRetry(`${SUPABASE_REST_URL}/${pathAndQuery}`, {
    method: 'GET',
    headers: supabaseHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase GET ${pathAndQuery} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

// ============================================================================
// TIPOS CRUDOS DE LA BASE DE DATOS SUPABASE
// ============================================================================

export interface RawSupabaseStaff {
  id: string;
  name: string;
  role: string;
  email: string;
  status: string | Record<string, any> | null;
  creatorId?: string | null;
  uploaderEmail?: string | null;
  created_at?: string;
}

export interface RawSupabaseCheckin {
  id: string;
  date: string;
  store: string;
  type: string; // 'Ingreso' | 'Salida a almorzar' | 'Vuelta a almorzar' | 'Salida'
  location?: { lat?: number; lng?: number; accuracy?: number } | string | null;
  creatorId?: string | null;
  promoter?: string | null;
  created_at?: string;
  photoBase64?: string | null;
}

export interface RawSupabasePrice {
  id: string;
  date: string;
  store: string;
  cadena?: string | null;
  zona?: string | null;
  region?: string | null;
  ourProduct: string;
  ourPrice: number | string | null;
  competitor1Brand?: string | null;
  competitor1Price?: number | string | null;
  competitor2Brand?: string | null;
  competitor2Price?: number | string | null;
  competitor3Brand?: string | null;
  competitor3Price?: number | string | null;
  competitorBrand?: string | null;
  competitorPrice?: number | string | null;
  bcv_rate?: number | string | null;
  moneda_propia?: 'USD' | 'VES' | string | null;
  moneda_competencia?: 'USD' | 'VES' | string | null;
  tasa_bcv_aplicada?: number | string | null;
  tasa_bcv_fecha?: string | null;
  precio_propio_usd?: number | string | null;
  precio_competencia_usd?: number | string | null;
  brecha_usd?: number | string | null;
  brecha_porcentaje?: number | string | null;
  competitors_meta?: unknown;
  photo_storage_path?: string | null;
  ocr_asistido?: boolean | null;
  ocr_confianza?: 'alta' | 'media' | 'baja' | string | null;
  comments?: string | null;
  creatorId?: string | null;
  promoter?: string | null;
  promotora_id?: string | null;
  auth_user_id?: string | null;
  created_at?: string;
}

export interface RawSupabaseInventory {
  id: string;
  date: string;
  store: string;
  product: string;
  initialQuantity: number | string | null;
  finalQuantity: number | string | null;
  degustations: number | string | null;
  sales_generated?: number | string | null;
  comments?: string | null;
  creatorId?: string | null;
  promoter?: string | null;
  promotora_id?: string | null;
  auth_user_id?: string | null;
  region?: string | null;
  zona?: string | null;
  cronograma_id?: string | null;
  created_at?: string;
}

export interface RawSupabaseSurvey {
  id: string;
  type: string; // 'Degustacion' | 'Merchandising' | 'Breve' | 'Profunda' | 'Pedido Alkosto'
  date: string;
  store: string;
  promoter: string;
  product: string;
  rating?: number | null;
  intent?: string | null;
  purchase?: string | null;
  email?: string | null;
  competitor?: string | null;
  comments?: string | Record<string, any> | null;
  creatorId?: string | null;
  created_at?: string;
  leido_trade?: boolean | null;
  visto_en_trade_at?: string | null;
  en_historial?: boolean | null;
  archivado_en?: string | null;
  motivo_archivo?: string | null;
}

// ============================================================================
// TIPOS TRANSFORMADOS PARA EL MÓDULO 1
// ============================================================================

export interface VisitHistoryRecord {
  id: string;
  rawCheckinId: string;
  date: string;
  isoDate: string;
  timeIn: string;
  timeOut: string;
  checkinType: string;
  storeName: string;
  zone: string;
  promotora: string;
  creatorEmail: string;
  shift: ShiftType;
  gpsDistanceMeters: number;
  gpsStatus: string;
  lat?: number;
  lng?: number;
  mapsUrl?: string;
  auditStatus: 'COMPLETADA' | 'EN_CURSO' | 'PROGRAMADA';
  photosCount: number;
  summary: string;
}

export interface InventorySamplingRecord {
  id: string;
  date: string;
  dateSlash: string;
  isoDate: string;
  storeName: string;
  zone: string;
  region?: 'Occidente' | 'Valencia' | 'Centro' | 'Andes';
  promotoraId?: string;
  promotora: string;
  creatorEmail: string;
  productName: string;
  sku: string;
  unit: string;
  lotNumber: string;
  initialStock: number;
  openedUnits: number;
  portionsPrepared: number;
  portionsSampled: number;
  assistedSales: number;
  salesGenerated: number;
  rotationPercent: number;
  conversionRate: number;
  finalStock: number;
  observations: string;
  status: string;
}

export interface AttendanceSlotEvent {
  checkinId: string;
  type: 'INGRESO' | 'SALIDA A ALMORZAR' | 'LLEGADA DE ALMORZAR' | 'SALIDA';
  rawType: string;
  storeName: string;
  dateFormatted: string; // DD/MM/YYYY
  timeFormatted: string; // 09:51 a. m.
  fullTimeFormatted: string; // 09:51:28 a. m.
  isoDate: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  mapsUrl?: string;
}

export interface AttendanceRecord {
  id: string;
  promotoraId?: string;
  masterCategory?: StaffCategory;
  promotora: string;
  initials: string;
  email: string;
  dni: string;
  storeName: string;
  zone: string;
  date: string;
  dateSlash: string;
  dateLongEs: string;
  shift: string;
  clockIn: string;
  lunchOut: string;
  lunchIn: string;
  clockOut: string;
  punctuality: string;
  gpsAccuracy: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  mapsUrl?: string;
  effectiveHours: string;
  status: 'COMPLETADO' | 'EN_CURSO' | 'PROGRAMADO';
  eventsCount: number;
  ingresoEvent?: AttendanceSlotEvent;
  salidaAlmorzarEvent?: AttendanceSlotEvent;
  llegadaAlmorzarEvent?: AttendanceSlotEvent;
  salidaEvent?: AttendanceSlotEvent;
}

export interface MerchandisingRecord {
  id: string;
  date: string;
  time: string;
  storeName: string;
  address: string;
  promoter: string;
  product: string;
  category?: string;
  storeManagerName: string;
  storeManagerRole: string;
  storeManagerPhone: string;
  visitReason: string;
  activities: string[];
  observations: string;
  signatureBase64?: string;
  signedAt?: string;
  certified: boolean;
  photos: string[];
  matchedCheckinIds?: string[];
  metrics?: {
    totalFacings?: number;
    codizulcaFacings?: number;
    competitorFacings?: number;
    shareOfShelfPercent?: number;
    outOfStockDetected?: boolean;
    outOfStockProducts?: string[];
    planogramCompliance?: number;
    popInstalled?: string[];
  };
  alerts?: string[];
  aiRecommendations?: {
    generatedAt?: string;
    overallScore?: number;
    executiveSummary?: string;
    shelfLayoutSuggestion?: string;
    stockActionPlan?: string;
    popPlacementAdvice?: string;
    nextVisitPriority?: 'ALTA' | 'MEDIA' | 'BAJA';
    actionItems?: string[];
  };
  rawComments: Record<string, any>;
}

export type StaffCategory = 'fija' | 'eventual' | 'merchandising';

export interface StaffMemberRecord {
  id: string;
  name: string;
  canonicalKey: string;
  role: string;
  category: StaffCategory;
  roleCategory: 'PROMOTORA' | 'MERCHANDISING';
  email: string;
  phone: string;
  address: string;
  region?: 'Occidente' | 'Valencia' | string | null;
  authUserId?: string | null;
  assignedStore: string;
  status: 'Activo' | 'Inactivo';
  password: string;
  creatorId?: string;
  photoUrl?: string;
  shift: string;
  tastingCompleted: number;
  salesAssisted: number;
  activationsCount: number;
  totalUnits: number;
}

export interface ConsumerSurveyRecord {
  id: string;
  surveyType: 'Breve' | 'Profunda';
  date: string; // YYYY-MM-DD en America/Caracas (UTC-4)
  dayLabel: string;
  shift: ShiftType;
  storeName: string;
  zone: string;
  promotora: string;
  productName: string;
  rating: number | null; // Acotado en [0, 5] o null si sin calificación
  highAcceptance: boolean;
  acceptanceLabel: string;
  purchaseIntent: string;
  createdAt?: string;
}

export interface ConsumerSurveySummary {
  totalSurveys: number;
  breveCount: number;
  profundaCount: number;
  avgRating: number;
  highAcceptancePercent: number;
}

export interface Module1SupabaseBundle {
  tastingItems: TastingScheduleItem[];
  visitsForSchedule: ScheduledVisit[];
  visitsHistory: VisitHistoryRecord[];
  priceComparisons: PriceComparisonThreeBrands[];
  inventorySampling: InventorySamplingRecord[];
  attendanceRecords: AttendanceRecord[];
  asistenciaJornadas?: AsistenciaJornadaDbRow[];
  asistenciaEvidencias?: AsistenciaEvidenciaDbRow[];
  merchandisingRecords: MerchandisingRecord[];
  staffMembers: StaffMemberRecord[];
  consumerSurveys: ConsumerSurveyRecord[];
  surveySummary: ConsumerSurveySummary;
  fetchedAt: string;
}

// ============================================================================
// HELPERS DE PARSEO Y FORMATO
// ============================================================================

function safeParseJson<T extends Record<string, any> = Record<string, any>>(input: unknown): T {
  return safeJsonParseObject<T>(input);
}

function toNum(val: unknown, fallback = 0): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const cleaned = val.replace(/[^0-9.-]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function getTodayVeYmd(): string {
  return extractCaracasWallClockParts().ymd;
}

function formatDateYmd(dateStr: string | undefined | null): string {
  return normalizeFdvCalendarDateYmd(dateStr);
}

function formatTimeVe(dateStr: string | undefined | null): string {
  if (!dateStr) return '--:--';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleTimeString('es-VE', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatFullTimeVe(dateStr: string | undefined | null): string {
  if (!dateStr) return '--:--:--';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleTimeString('es-VE', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

const DAY_NAMES_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTH_NAMES_ES = [
  'ENERO',
  'FEBRERO',
  'MARZO',
  'ABRIL',
  'MAYO',
  'JUNIO',
  'JULIO',
  'AGOSTO',
  'SEPTIEMBRE',
  'OCTUBRE',
  'NOVIEMBRE',
  'DICIEMBRE',
];

export function formatDateSlash(ymd: string): string {
  const normalized = formatToDdMmYyyy(ymd);
  return normalized || '-- -- ----';
}

export function formatDateLongEs(ymd: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return (ymd || 'SIN FECHA').toUpperCase();
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (isNaN(dt.getTime())) return ymd.toUpperCase();
  const dayName = DAY_NAMES_ES[dt.getUTCDay()].toUpperCase();
  const monthName = MONTH_NAMES_ES[m - 1] || 'MES';
  return `${dayName}, ${d} DE ${monthName} DE ${y}`;
}

function getInitials(name: string): string {
  const clean = (name || 'PR').trim().toUpperCase();
  return clean.slice(0, 2);
}

export function formatDayLabelEs(ymd: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd || 'Sin Fecha';
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (isNaN(dt.getTime())) return ymd;
  const dayName = DAY_NAMES_ES[dt.getUTCDay()];
  const dayNum = String(d).padStart(2, '0');
  return `${dayName} ${dayNum}`;
}

function inferCategory(productName: string): string {
  const u = (productName || '').toUpperCase();
  if (u.includes('MORTADELA')) return 'MORTADELAS';
  if (u.includes('JAMON') || u.includes('JAMÓN') || u.includes('PECHUGA')) return 'JAMONES / PAVO';
  if (u.includes('ESPALDA') || u.includes('FIAMBRE')) return 'ESPALDA / FIAMBRE';
  if (u.includes('SALCHICHA') || u.includes('CHORIZO') || u.includes('TOCINETA') || u.includes(' BOLOGNA')) return 'EMBUTIDOS / SALCHICHAS';
  if (u.includes('ARROZ') || u.includes('LECHE') || u.includes('ACEITE') || u.includes('VENCAMPO') || u.includes('AVENA')) return 'LÍNEA VENCAMPO';
  return 'PORTAFOLIO CODIZULCA';
}

function inferShiftFromTime(timeOrShift?: string | null, isoDate?: string | null): ShiftType {
  const s = (timeOrShift || '').toUpperCase();
  if (s.includes('TARDE')) return 'TARDE';
  if (s.includes('MAÑANA') || s.includes('MANANA')) return 'MAÑANA';
  if (s.includes('PM') && !s.startsWith('12')) return 'TARDE';
  if (s.includes('AM')) return 'MAÑANA';
  const hourMatch = s.match(/(\d{1,2}):(\d{2})/);
  if (hourMatch) {
    const h = parseInt(hourMatch[1], 10);
    if (h >= 13) return 'TARDE';
    return 'MAÑANA';
  }
  if (isoDate && isoDate.includes('T')) {
    const d = new Date(isoDate);
    if (!isNaN(d.getTime())) {
      const veHour = (d.getUTCHours() + 20) % 24; // UTC-4
      return veHour >= 13 ? 'TARDE' : 'MAÑANA';
    }
  }
  return 'MAÑANA';
}

// ============================================================================
// TASA BCV EN VIVO (SIN VALOR DE RESPALDO · TIMEOUT CON AbortController)
// ============================================================================

export const DEFAULT_BCV_FETCH_TIMEOUT_MS = 10_000;
const MAX_BCV_FETCH_TIMEOUT_MS = 60_000;

export function resolveBcvFetchTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined) {
    if (Number.isFinite(overrideMs) && overrideMs > 0) {
      return Math.min(MAX_BCV_FETCH_TIMEOUT_MS, Math.max(1, Math.trunc(overrideMs)));
    }
    return DEFAULT_BCV_FETCH_TIMEOUT_MS;
  }

  const nodeRaw =
    typeof process !== 'undefined' && process?.env ? process.env.BCV_FETCH_TIMEOUT_MS : undefined;
  const viteRaw =
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BCV_FETCH_TIMEOUT_MS
      : undefined;
  const raw = nodeRaw ?? viteRaw;

  if (raw !== undefined && String(raw).trim() !== '') {
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_BCV_FETCH_TIMEOUT_MS, parsed);
    }
  }
  return DEFAULT_BCV_FETCH_TIMEOUT_MS;
}

/**
 * Obtiene la tasa oficial en vivo con timeout estricto vía `AbortController`.
 * No existe tasa de respaldo ni caché local: si falla o expira el tiempo de espera,
 * devuelve `null` de forma controlada sin colgar el event loop.
 */
export async function fetchLiveBcvRate(options?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<number | null> {
  const timeoutMs = resolveBcvFetchTimeoutMs(options?.timeoutMs);
  const fetchFn = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetchFn('https://ve.dolarapi.com/v1/dolares/oficial', {
      signal: controller.signal,
    });
    if (res.ok) {
      const data = await res.json();
      const candidate = Number(data?.promedio);
      if (Number.isFinite(candidate) && candidate > 50) {
        return Number(candidate.toFixed(2));
      }
    }
  } catch (err) {
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));
    if (isAbort) {
      console.warn(`[BCV] Consulta de tasa oficial abortada por timeout (${timeoutMs} ms).`);
    }
    // Sin conexión o timeout con el servicio de tasa: se devuelve null de forma segura
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}

export function normalizeStaffTextKey(input?: string | null): string {
  if (!input) return '';
  return String(input)
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u0302\u0304-\u036f]/g, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

const SYNTHETIC_SEED_IDS = new Set([
  'ef235819-47b1-4523-ac24-3c39bea18ad5',
  '2842e4ec-f1a5-4a1f-917b-41a3e22692b8',
  'f66d88fa-cf5b-4809-88ab-a16407fd50bf',
  '2d84d199-70e6-4466-acb1-c158873068d3',
  'a3569c63-dd0c-4f92-a5fd-738be016ecc0',
  'a98ddc9d-afe9-4041-abef-d808b8ce1a7e',
  'd12385d7-5c4a-48a5-adc2-81f2226be449',
  'b8c153f9-0b47-462a-a0e8-01043d4eea2d',
  'f19ac9d4-4687-4083-9c67-2297b592141c',
  'e9cde11f-03fc-43ba-a995-c404bb42a7ac',
  // Registros semilla sintéticos en surveys y checkins
  '9df910b0-fd38-4915-90ff-79fe06d7da01',
  'cf21d018-6d73-4181-87a1-71c68e1370aa',
  '6def9fce-3812-4b72-bbf0-247d21d641d8',
  'f88384e6-3c74-4f0e-8a2f-8166e3c4f562',
  'f1c9f040-3a7d-42ec-9987-cdba2be33158',
  'c0212950-e945-41bc-951f-2fde464f4ceb',
  'a7ddc38e-0afc-4f21-965e-5da64e069f68',
  '404071f6-0d7d-4611-8aa0-87d07677428d',
  '4bde7d5a-7bef-4b94-a429-48bfe2090818',
  '95791c9e-6f61-478e-8a96-be88f0da4ce6',
  'd4b554c2-0bbd-4fec-9e20-ef3aac33f8ce',
]);

// Promotoras inactivas, dadas de baja o de prueba que deben excluirse por completo del sistema
const INACTIVE_OR_REMOVED_PROMOTERS = new Set([
  'maria gonzalez',
  'ana silva',
  'ana perez',
  'grecia castillo',
  'ana rojas',
  'abmjyjm3rsfomc940zpp96ookqi1',
]);

export function isRemovedOrInactivePromoterToken(raw?: string | null): boolean {
  if (!raw) return false;
  const clean = normalizeStaffTextKey(raw).toLowerCase();
  return INACTIVE_OR_REMOVED_PROMOTERS.has(clean);
}

/**
 * Devuelve una llave canónica única para comparar nombres de promotoras/mercaderistas
 * sin duplicados por tildes, mayúsculas/minúsculas o nombres recortados (ej. "JULIANNYS" === "JULIANNYS GIL").
 */
export function canonicalStaffKey(rawNameOrEmail?: string | null, creatorId?: string | null): string {
  return normalizeStaffTextKey(String(rawNameOrEmail || '').trim() || String(creatorId || '').trim());
}

export function isSyntheticSurveyOrCheckinRow(row: any): boolean {
  if (!row || !row.id) return true;
  const idStr = String(row.id).trim();
  if (SYNTHETIC_SEED_IDS.has(idStr)) return true;
  if (/^(PRICE|INV|SURV|SCAN)-TEST-/i.test(idStr)) return true;
  const rawCreator = String(row.creatorId || '').trim().toLowerCase();
  if (rawCreator === 'admin' || INACTIVE_OR_REMOVED_PROMOTERS.has(rawCreator)) return true;
  const rawPromoter = normalizeStaffTextKey(row.promoter).toLowerCase();
  if (INACTIVE_OR_REMOVED_PROMOTERS.has(rawPromoter)) return true;
  const rawStore = String(row.store || '').trim().toLowerCase();
  if (rawStore === 'supermercado a' || rawStore === 'abasto b') return true;
  return false;
}

export function isSyntheticPriceOrInventoryRow(row: any): boolean {
  if (isSyntheticSurveyOrCheckinRow(row)) return true;
  const rawPromoter = String(row.promoter || '').trim().toLowerCase();
  if (!rawPromoter && !String(row.creatorId || '').trim()) return true;
  return false;
}

/**
 * Índice de búsqueda construido EXCLUSIVAMENTE con el personal sincronizado desde Supabase:
 * nombre canónico, correo, id, creatorId y nombre de pila (solo si es único entre el personal activo).
 */
export function buildActiveStaffLookup(list: StaffMemberRecord[]): Map<string, StaffMemberRecord> {
  const map = new Map<string, StaffMemberRecord>();
  const active = (list || []).filter((s) => String(s.status).toLowerCase() !== 'inactivo');
  const firstNameOf = (s: StaffMemberRecord) => normalizeStaffTextKey(s.name).split(' ')[0] || '';
  const firstNameCount = new Map<string, number>();
  active.forEach((s) => {
    const first = firstNameOf(s);
    if (first) firstNameCount.set(first, (firstNameCount.get(first) ?? 0) + 1);
  });
  active.forEach((s) => map.set(s.canonicalKey, s));
  active.forEach((s) => {
    [s.email, s.id, s.creatorId].forEach((token) => {
      const k = normalizeStaffTextKey(token);
      if (k && !map.has(k)) map.set(k, s);
    });
  });
  active.forEach((s) => {
    const first = firstNameOf(s);
    if (first && firstNameCount.get(first) === 1 && !map.has(first)) map.set(first, s);
  });
  return map;
}

export function resolvePromoterNameFromRaw(
  rawPromoter?: string | null,
  creatorId?: string | null,
  activeStaffByKey?: Map<string, StaffMemberRecord>
): string {
  const cleanRaw = String(rawPromoter || '').trim().replace(/\s+/g, ' ');
  const cleanCreator = String(creatorId || '').trim();

  const tryLookup = (token: string): string | null => {
    if (!token || !activeStaffByKey) return null;
    const hit = activeStaffByKey.get(normalizeStaffTextKey(token));
    return hit ? hit.name : null;
  };

  if (cleanRaw) {
    const resolved = tryLookup(cleanRaw);
    if (resolved) return resolved;
  }

  if (cleanCreator) {
    const resolved = tryLookup(cleanCreator);
    if (resolved) return resolved;
  }

  return cleanRaw || 'SIN ASIGNAR';
}

export function canonicalizeActivePromoterOrNull(
  rawPromoter?: string | null,
  creatorId?: string | null,
  activeStaffList?: StaffMemberRecord[]
): StaffMemberRecord | null {
  if (isRemovedOrInactivePromoterToken(rawPromoter) || isRemovedOrInactivePromoterToken(creatorId)) {
    return null;
  }
  // Sin personal sincronizado no existe ninguna promotora "conocida": no hay padrón de respaldo.
  if (!activeStaffList || activeStaffList.length === 0) return null;
  const map = buildActiveStaffLookup(activeStaffList);
  const resolvedName = resolvePromoterNameFromRaw(rawPromoter, creatorId, map);
  return map.get(normalizeStaffTextKey(resolvedName)) || null;
}

/** Zona de una promotora según el personal sincronizado; vacío si no se conoce. */
export function resolvePromoterZone(promoterName: string, staffList?: StaffMemberRecord[]): string {
  if (!staffList || staffList.length === 0) return '';
  const key = canonicalStaffKey(promoterName);
  return staffList.find((s) => s.canonicalKey === key)?.address || '';
}
export function toSortableTimestamp(dateVal?: string | null, createdAtVal?: string | null): number {
  const parseStr = (s?: string | null): number => {
    if (!s) return 0;
    const trimmed = String(s).trim();
    if (!trimmed) return 0;
    // Fechas calendario puras YYYY-MM-DD (o T00:00:00Z sintético): fijar al mediodía Venezuela (16:00 UTC) para evitar desfase -1 día en UTC-4
    const ymdCalendarMatch = trimmed.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/i
    );
    if (ymdCalendarMatch) {
      const yyyy = Number(ymdCalendarMatch[1]);
      const mm = Number(ymdCalendarMatch[2]);
      const dd = Number(ymdCalendarMatch[3]);
      const dt = Date.UTC(yyyy, mm - 1, dd, 16, 0, 0);
      if (!Number.isNaN(dt)) return dt;
    }
    const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmyMatch) {
      const dd = Number(dmyMatch[1]);
      const mm = Number(dmyMatch[2]);
      const yyyy = Number(dmyMatch[3]);
      const dt = Date.UTC(yyyy, mm - 1, dd, 16, 0, 0);
      if (!Number.isNaN(dt)) return dt;
    }
    const parsed = new Date(trimmed).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  const tsCreated = parseStr(createdAtVal);
  const tsDate = parseStr(dateVal);
  if (tsCreated > 0 && tsDate > 0 && dateVal && !String(dateVal).includes('T') && Math.abs(tsCreated - tsDate) < 86400000 * 2) {
    return tsCreated;
  }
  return tsDate || tsCreated || 0;
}

function formatDateFromField(dateIso?: string | null): string {
  if (!dateIso) return formatToDdMmYyyy(getTodayVeYmd());
  const normalized = formatToDdMmYyyy(dateIso);
  return normalized || '-- -- ----';
}

// ============================================================================
// CARGA Y TRANSFORMACIÓN EXACTA DESDE SUPABASE
// ============================================================================

const TRADE_READ_LEDGER_STORAGE_KEY = 'codizulca_trade_read_degustaciones_v1';
const inMemoryReadLedger = new Map<string, string>();

function readPersistedReadLedger(): Record<string, string> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return Object.fromEntries(inMemoryReadLedger.entries());
  }
  try {
    const raw = window.localStorage.getItem(TRADE_READ_LEDGER_STORAGE_KEY);
    if (!raw) return Object.fromEntries(inMemoryReadLedger.entries());
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { ...Object.fromEntries(inMemoryReadLedger.entries()), ...parsed };
    }
  } catch {
    // ignore storage quota/privacy errors
  }
  return Object.fromEntries(inMemoryReadLedger.entries());
}

export function normalizeCanonicalDegustacionId(rawId?: unknown, fallbackSurveyId?: string): string {
  return normalizeCanonicalFdvId(rawId, fallbackSurveyId);
}

export function recordLocalDegustacionReadLedger(
  surveyId?: string | null,
  degustacionId?: string | null,
  isoAt?: string
): void {
  const stamp = isoAt || new Date().toISOString();
  const sId = String(surveyId || '').trim();
  const dId = normalizeCanonicalDegustacionId(degustacionId);
  if (sId) inMemoryReadLedger.set(sId, stamp);
  if (dId) inMemoryReadLedger.set(dId, stamp);

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const current = readPersistedReadLedger();
      if (sId) current[sId] = stamp;
      if (dId) current[dId] = stamp;
      const entries = Object.entries(current);
      const bounded = entries.length > 600 ? Object.fromEntries(entries.slice(entries.length - 600)) : current;
      window.localStorage.setItem(TRADE_READ_LEDGER_STORAGE_KEY, JSON.stringify(bounded));
    } catch {
      // ignore storage errors
    }
  }
}

function getLocalDegustacionReadStamp(surveyId?: string | null, degustacionId?: string | null): string | null {
  const sId = String(surveyId || '').trim();
  const dId = normalizeCanonicalDegustacionId(degustacionId);
  const memHit = (sId && inMemoryReadLedger.get(sId)) || (dId && inMemoryReadLedger.get(dId));
  if (memHit) return memHit;
  const persisted = readPersistedReadLedger();
  return (sId && persisted[sId]) || (dId && persisted[dId]) || null;
}

/**
 * Extrae `ruta`, `contactoPunto` y `telefonoContacto` cuando el backend de FDV Planificador
 * (`server.ts` / `degustacionesService.ts`) los envía empaquetados en `address` con formato:
 * `Ruta: <ruta> | Contacto: <nombre> (<telefono>)`
 */
function extractAddressEmbeddedMetadata(rawAddress: string): {
  rutaFromAddress: string;
  contactoFromAddress: string;
  telefonoFromAddress: string;
} {
  const clean = String(rawAddress || '').trim();
  if (!clean) {
    return { rutaFromAddress: '', contactoFromAddress: '', telefonoFromAddress: '' };
  }

  let rutaFromAddress = '';
  let contactoFromAddress = '';
  let telefonoFromAddress = '';

  const rutaMatch = clean.match(/Ruta:\s*([^|•]+)/i);
  if (rutaMatch?.[1]) {
    rutaFromAddress = rutaMatch[1].trim();
  }

  const contactoSectionMatch = clean.match(/Contacto:\s*([^|•]+)/i);
  if (contactoSectionMatch?.[1]) {
    const rawContactSegment = contactoSectionMatch[1].trim();
    const phoneInParens = rawContactSegment.match(/^(.*?)\(([^)]*)\)\s*$/);
    if (phoneInParens) {
      contactoFromAddress = phoneInParens[1].trim();
      telefonoFromAddress = phoneInParens[2].trim();
    } else {
      contactoFromAddress = rawContactSegment;
    }
  }

  return { rutaFromAddress, contactoFromAddress, telefonoFromAddress };
}

function parseResultadoReport(rawResultado: unknown): DegustacionResultadoReport | null {
  if (!rawResultado || typeof rawResultado !== 'object') return null;
  const r = rawResultado as Record<string, unknown>;
  const kilosDegustados = r.kilosDegustados !== undefined ? toNum(r.kilosDegustados, 0) : undefined;
  const personasAlcanzadas =
    r.personasAlcanzadas !== undefined ? Math.round(toNum(r.personasAlcanzadas, 0)) : undefined;
  const ventasGeneradas = r.ventasGeneradas ? String(r.ventasGeneradas).trim() : undefined;
  const comentarios = r.comentarios ? String(r.comentarios).trim() : undefined;

  if (
    kilosDegustados === undefined &&
    personasAlcanzadas === undefined &&
    !ventasGeneradas &&
    !comentarios
  ) {
    return null;
  }

  return {
    kilosDegustados,
    personasAlcanzadas,
    ventasGeneradas,
    comentarios,
  };
}

function isSellerOriginComments(c: Record<string, any>): boolean {
  return (
    c.source === 'vendedor_app' ||
    Boolean(c.degustacionId) ||
    Boolean(c.vendedor) ||
    Boolean(c.salesRep)
  );
}

function isTerminalDegustacionEstado(estadoUpper: string): boolean {
  return (
    estadoUpper === 'APROBADA' ||
    estadoUpper === 'PROGRAMADA' ||
    estadoUpper === 'CONFIRMADA' ||
    estadoUpper === 'COMPLETADA' ||
    estadoUpper === 'REALIZADA' ||
    estadoUpper === 'EJECUTADA' ||
    estadoUpper === 'RECHAZADA' ||
    estadoUpper === 'CANCELADA'
  );
}

async function fetchCronogramaDegustacionesSafe(): Promise<CronogramaDegustacionRecord[]> {
  if (getCronogramaTableSupport() === false) {
    return [];
  }
  try {
    const client = getSupabaseRealtimeClient();
    if (!client) return [];

    const { data, error, status } = await client
      .from('cronograma_degustaciones')
      .select('*')
      .not('estado', 'in', '(RECHAZADA,CANCELADA)')
      .order('fecha', { ascending: true })
      .order('hora_inicio', { ascending: true })
      .limit(1000);

    if (error) {
      if (isMissingTablePostgrestError(status || error.code || '', error.message)) {
        setCronogramaTableSupport(false);
      }
      return [];
    }

    setCronogramaTableSupport(true);
    return Array.isArray(data) ? (data as CronogramaDegustacionRecord[]) : [];
  } catch {
    return [];
  }
}

async function fetchAsistenciaEvidenciasSafe(): Promise<{
  jornadas: AsistenciaJornadaDbRow[];
  evidencias: AsistenciaEvidenciaDbRow[];
}> {
  try {
    const client = getSupabaseRealtimeClient();
    if (!client) return { jornadas: [], evidencias: [] };

    const [jornadasRes, evidenciasRes] = await Promise.all([
      client
        .from('asistencias_jornada')
        .select('*')
        .order('fecha_jornada', { ascending: false })
        .limit(1000),
      client
        .from('asistencia_evidencias')
        .select('*')
        .order('capturado_en_servidor', { ascending: false })
        .limit(3000),
    ]);

    if (jornadasRes.error) {
      return { jornadas: [], evidencias: [] };
    }

    if (evidenciasRes.error) {
      return {
        jornadas: Array.isArray(jornadasRes.data)
          ? (jornadasRes.data as AsistenciaJornadaDbRow[])
          : [],
        evidencias: [],
      };
    }

    return {
      jornadas: Array.isArray(jornadasRes.data)
        ? (jornadasRes.data as AsistenciaJornadaDbRow[])
        : [],
      evidencias: Array.isArray(evidenciasRes.data)
        ? (evidenciasRes.data as AsistenciaEvidenciaDbRow[])
        : [],
    };
  } catch {
    return { jornadas: [], evidencias: [] };
  }
}

function matchesAssignedRegionsForExternalFdvRow(
  row: RawSupabaseSurvey,
  assignedRegions?: readonly string[] | null
): boolean {
  if (!assignedRegions || assignedRegions.length === 0) return true;
  const allowedNorm = new Set(
    assignedRegions
      .map((r) =>
        String(r || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim()
          .toUpperCase()
      )
      .map((token) => (token === 'VALENCIA' || token === 'CAPITAL' ? 'CENTRO' : token === 'ZULIA' ? 'OCCIDENTE' : token))
      .filter(Boolean)
  );
  if (allowedNorm.size === 0) return true;

  const parsed = safeParseJson<Record<string, unknown>>(row.comments);
  const rawTokens = [
    (row as unknown as Record<string, unknown>).region,
    (row as unknown as Record<string, unknown>).sucursal,
    parsed.region,
    parsed.sucursal,
    parsed.sede,
    parsed.estado,
    parsed.ciudad,
    parsed.zona,
    parsed.route,
    parsed.ruta,
    row.store,
  ]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const isExplicitCentro =
    /\b(valencia|carabobo|tocuyito|los guayos|naguanagua|san diego|guacara|maracay|turmero|aragua|caracas|distrito capital|miranda|centro)\b/.test(
      rawTokens
    );
  const isExplicitAndes =
    /\b(andes|tachira|san cristobal|merida|barinas|el vigia)\b/.test(rawTokens);
  const isExplicitOccidente =
    /\b(occidente|zulia|maracaibo|san francisco|cabimas|coro|punto fijo|falcon|trujillo|valera|la villa|mara|ciudad ojeda|lagunillas)\b/.test(
      rawTokens
    );

  if (isExplicitOccidente && !allowedNorm.has('OCCIDENTE')) return false;
  if (isExplicitCentro && !allowedNorm.has('CENTRO')) return false;
  if (isExplicitAndes && !allowedNorm.has('ANDES')) return false;

  // Si el registro externo no tiene etiqueta regional explícita y el usuario NO tiene acceso a Occidente
  // (ej. María: solo Centro y Andes), aplicar criterio fail-closed para no filtrar degustaciones legacy de Occidente.
  if (!isExplicitCentro && !isExplicitAndes && !isExplicitOccidente && !allowedNorm.has('OCCIDENTE')) {
    return false;
  }

  return true;
}

export async function fetchAllModule1FromSupabase(
  explicitExchangeRateBs?: number,
  options?: {
    assignedRegion?: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' | null;
    assignedRegions?: readonly string[] | null;
  }
): Promise<Module1SupabaseBundle> {
  const effectiveAssignedRegions: string[] | null =
    Array.isArray(options?.assignedRegions) && options!.assignedRegions!.length > 0
      ? [...options!.assignedRegions!]
      : options?.assignedRegion
        ? [options.assignedRegion]
        : null;
  // Sin tasa de respaldo: si no se puede obtener en vivo, es null y los importes en Bs no se calculan.
  const liveBcvRate: number | null =
    explicitExchangeRateBs && explicitExchangeRateBs > 50 ? explicitExchangeRateBs : await fetchLiveBcvRate();

  const renderReconciliationPromise = fetchFdvPlanificadorRenderDegustaciones({
    endpointUrl: FDV_PLANIFICADOR_RENDER_API_URL,
    timeoutMs: 14000,
  });

  const [
    rawStaff,
    promotorasMaestrasCatalog,
    rawCheckinsPage1,
    rawCheckinsPage2,
    rawPrices,
    rawInventory,
    rawDegustacionRowsFromDb,
    rawOtherSurveyRowsFromDb,
    rawRenderDegustacionRowsFast,
    rawCronogramaRows,
    asistenciaRelationalBundle,
  ] = await Promise.all([
    supabaseGet<RawSupabaseStaff[]>(
      'staff?select=id,name,role,email,status,creatorId,uploaderEmail,created_at&order=created_at.desc&limit=1000'
    ).catch(() => [] as RawSupabaseStaff[]),
    obtenerPromotorasMaestras({ soloActivas: false }).catch(() => []),
    supabaseGet<RawSupabaseCheckin[]>(
      'checkins?select=id,date,store,type,location,creatorId,promoter,created_at&order=date.desc&limit=1000&offset=0'
    ).catch(() => [] as RawSupabaseCheckin[]),
    supabaseGet<RawSupabaseCheckin[]>(
      'checkins?select=id,date,store,type,location,creatorId,promoter,created_at&order=date.desc&limit=1000&offset=1000'
    ).catch(() => [] as RawSupabaseCheckin[]),
    supabaseGet<RawSupabasePrice[]>('prices?select=*&order=date.desc&limit=1000').catch(
      () => [] as RawSupabasePrice[]
    ),
    supabaseGet<RawSupabaseInventory[]>('inventory?select=*&order=date.desc&limit=1000').catch(
      () => [] as RawSupabaseInventory[]
    ),
    fetchDegustacionSurveysViaSdk().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      if (isMissingTablePostgrestError('', msg)) {
        return [] as RawSupabaseSurvey[];
      }
      throw err;
    }),
    fetchNonDegustacionSurveysViaSdk(undefined, {
      includeConsumerSurveys: FEATURE_FLAGS.ENABLE_MODULO1_TABLAS_METRICAS,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      if (isMissingTablePostgrestError('', msg)) {
        return [] as RawSupabaseSurvey[];
      }
      throw err;
    }),
    Promise.race([
      renderReconciliationPromise,
      waitMs(3200).then(() => null),
    ]),
    fetchCronogramaDegustacionesSafe(),
    fetchAsistenciaEvidenciasSafe(),
  ]);

  // --------------------------------------------------------------------------
  // 0. PADRON EXACTO DE PERSONAL ACTIVO (SOLO PROMOTORAS Y MERCHANDISING ACTIVOS)
  // --------------------------------------------------------------------------
  const staffMembers: StaffMemberRecord[] = [];
  const seenStaffCanonicalKeys = new Set<string>();

  rawStaff.forEach((s) => {
    const rawName = (s.name || '').trim();
    if (!rawName) return;
    if (isRemovedOrInactivePromoterToken(rawName) || isRemovedOrInactivePromoterToken(s.email)) {
      return;
    }

    const statusObj = safeParseJson<{
      status?: string;
      category?: string;
      phone?: string;
      address?: string;
      assignedLocation?: string;
      password?: string;
      photoUrl?: string;
    }>(s.status);

    const memberStatus = String(statusObj.status || 'Activo').trim();
    // Excluir cualquier promotora o mercaderista inactivo del sistema
    if (memberStatus.toLowerCase() === 'inactivo') return;

    const cKey = canonicalStaffKey(rawName, s.email);
    if (!cKey || seenStaffCanonicalKeys.has(cKey)) return;
    seenStaffCanonicalKeys.add(cKey);

    const rawCat = String(statusObj.category || '').trim().toLowerCase();
    const rawRoleLower = String(s.role || '').trim().toLowerCase();
    let category: StaffCategory = 'fija';
    if (rawCat === 'merchandising' || rawRoleLower.includes('merchandising')) {
      category = 'merchandising';
    } else if (rawCat === 'eventual' || rawRoleLower.includes('eventual')) {
      category = 'eventual';
    } else if (rawCat === 'fija' || rawRoleLower.includes('fija')) {
      category = 'fija';
    }

    const cleanRole =
      category === 'merchandising'
        ? 'Promotor Merchandising'
        : String(s.role || '').trim();

    const assignedLoc = String(statusObj.assignedLocation || '').trim();
    const cleanAddress = String(statusObj.address || '').trim();
    const cleanPhone = String(statusObj.phone || '').trim();
    const cleanEmail = String(s.email || '').trim();
    const validPhoto =
      typeof statusObj.photoUrl === 'string' &&
      (statusObj.photoUrl.startsWith('data:image') ||
        statusObj.photoUrl.startsWith('http') ||
        statusObj.photoUrl.startsWith('/'))
        ? statusObj.photoUrl
        : undefined;

    staffMembers.push({
      id: s.id,
      name: rawName,
      canonicalKey: cKey,
      role: cleanRole,
      category,
      roleCategory: category === 'merchandising' ? 'MERCHANDISING' : 'PROMOTORA',
      email: cleanEmail,
      phone: cleanPhone,
      address: cleanAddress,
      region:
        String(statusObj.address || '').match(/merida|mérida|tachira|táchira|san cristobal|san cristóbal|trujillo|valera|barinas|el vigia|el vigía|andes/i)
          ? 'Andes'
          : String(statusObj.address || '').match(/valencia|carabobo|maracay|turmero|caracas/i)
            ? 'Valencia'
            : 'Occidente',
      assignedStore: assignedLoc,
      status: 'Activo',
      // Seguridad Zero Trust: jamás hidratar contraseñas de base de datos en memoria del cliente
      password: '',
      creatorId: s.creatorId ? String(s.creatorId) : undefined,
      photoUrl: validPhoto,
      shift: `${category === 'fija' ? 'Plantilla Fija' : category === 'eventual' ? 'Plantilla Eventual' : 'Merchandising'} • ${cleanAddress || 'Sin dirección registrada'}`,
      tastingCompleted: 0,
      salesAssisted: 0,
      activationsCount: 0,
      totalUnits: 0,
    });
  });

  // Hidratar y complementar desde la tabla real `public.promotoras` (vía BFF/RLS `/api/maestros/promotoras`)
  const formatPromotoraDisplayName = (value: string): string => {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!trimmed) return 'Sin nombre';
    // Solo convertir a Title Case limpio si el registro viene íntegramente en MAYÚSCULAS
    const isAllUpper = trimmed === trimmed.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(trimmed);
    if (!isAllUpper) return trimmed;
    const minorWords = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
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

  for (const p of promotorasMaestrasCatalog) {
    if (p.activo === false) continue;
    const cleanEmail = String(p.email || '').trim().toLowerCase();
    const displayName = formatPromotoraDisplayName(String(p.nombre_completo || ''));
    const cKey = canonicalStaffKey(displayName, cleanEmail);
    if (!cKey || seenStaffCanonicalKeys.has(cKey)) continue;
    seenStaffCanonicalKeys.add(cKey);

    const catRaw = String(p.categoria || 'Fijas').trim().toLowerCase();
    const category: StaffCategory =
      catRaw.includes('merch')
        ? 'merchandising'
        : catRaw.includes('event')
          ? 'eventual'
          : 'fija';

    const cleanAddress = p.direccion ? String(p.direccion).trim() : '';
    const cleanPhone = p.telefono ? String(p.telefono).trim() : '';
    const rawMetaReg = String(p.metadata?.region_codigo || p.metadata?.region_perfil || '').trim().toUpperCase();
    const rawDirectReg = String(p.region || '').trim().toUpperCase();
    const regionLabel: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' =
      rawDirectReg === 'ANDES' || rawMetaReg === 'ANDES'
        ? 'Andes'
        : rawDirectReg === 'CENTRO'
          ? 'Centro'
          : rawDirectReg === 'VALENCIA' ||
              rawMetaReg === 'VALENCIA' ||
              rawMetaReg === 'CENTRO' ||
              p.sucursal === 'VALENCIA' ||
              p.sucursal === 'CENTRO'
            ? 'Valencia'
            : 'Occidente';

    staffMembers.push({
      id: String(p.id),
      name: displayName,
      canonicalKey: cKey,
      role: category === 'merchandising' ? 'Promotor Merchandising' : 'Promotora',
      category,
      roleCategory: category === 'merchandising' ? 'MERCHANDISING' : 'PROMOTORA',
      email: cleanEmail,
      phone: cleanPhone,
      address: cleanAddress,
      region: regionLabel,
      authUserId: p.auth_user_id ?? null,
      assignedStore: regionLabel,
      status: 'Activo',
      password: '',
      shift: `${category === 'fija' ? 'Plantilla Fija' : category === 'eventual' ? 'Plantilla Eventual' : 'Merchandising'} • ${regionLabel}`,
      tastingCompleted: 0,
      salesAssisted: 0,
      activationsCount: 0,
      totalUnits: 0,
    });
  }

  // Orden: categoría (Plantilla Fija -> Eventual -> Merchandising) y luego nombre. Sin padrón de respaldo: si la tabla está vacía, la lista queda vacía.
  const categoryRank: Record<StaffCategory, number> = { fija: 1, eventual: 2, merchandising: 3 };
  staffMembers.sort((a, b) => {
    if (categoryRank[a.category] !== categoryRank[b.category]) {
      return categoryRank[a.category] - categoryRank[b.category];
    }
    return a.name.localeCompare(b.name, 'es');
  });

  const activeStaffByKey = new Map<string, StaffMemberRecord>();
  const activeMerchByKey = new Map<string, StaffMemberRecord>();
  staffMembers.forEach((sm) => {
    activeStaffByKey.set(sm.canonicalKey, sm);
    if (sm.category === 'merchandising') {
      activeMerchByKey.set(sm.canonicalKey, sm);
    }
  });

  const resolveActiveMember = (
    rawPromoter?: string | null,
    creatorId?: string | null
  ): StaffMemberRecord | null => {
    if (isRemovedOrInactivePromoterToken(rawPromoter) || isRemovedOrInactivePromoterToken(creatorId)) {
      return null;
    }
    const resolvedName = resolvePromoterNameFromRaw(rawPromoter, creatorId, activeStaffByKey);
    return activeStaffByKey.get(normalizeStaffTextKey(resolvedName)) || null;
  };

  // Filtrar checkins estrictamente al personal activo sincronizado
  const rawCheckins: RawSupabaseCheckin[] = [...rawCheckinsPage1, ...rawCheckinsPage2].filter((r) => {
    if (isSyntheticSurveyOrCheckinRow(r)) return false;
    return resolveActiveMember(r.promoter, r.creatorId) !== null;
  });

  const cleanDegustacionSurveys: RawSupabaseSurvey[] = rawDegustacionRowsFromDb.filter(
    (r) => !isSyntheticSurveyOrCheckinRow(r)
  );
  const cleanOtherSurveys: RawSupabaseSurvey[] = rawOtherSurveyRowsFromDb.filter(
    (r) => !isSyntheticSurveyOrCheckinRow(r)
  );
  const rawSurveys: RawSupabaseSurvey[] = [...cleanDegustacionSurveys, ...cleanOtherSurveys];

  // Si Render respondió después del umbral rápido (ej. cold-start), reconciliar en segundo plano y avisar localmente si hay registros nuevos
  if (rawRenderDegustacionRowsFast === null) {
    void renderReconciliationPromise
      .then((lateRenderRows) => {
        if (!Array.isArray(lateRenderRows) || lateRenderRows.length === 0) return;
        const scopedLateRows = lateRenderRows.filter((r) =>
          matchesAssignedRegionsForExternalFdvRow(r, effectiveAssignedRegions)
        );
        if (scopedLateRows.length === 0) return;
        const { renderOnlyRows } = mergeSupabaseAndRenderDegustacionRows(
          cleanDegustacionSurveys,
          scopedLateRows
        );
        for (const newRow of renderOnlyRows) {
          emitLocalDegustacionSurveyEvent('INSERT', newRow);
        }
      })
      .catch(() => {
        // Silenciar latencia de cold-start en Render
      });
  }

  // --------------------------------------------------------------------------
  // 1. DEGUSTACIONES (surveys where type = 'Degustacion' + reconciliación Render FDV) + VISITS PARA MÓDULO 2
  // --------------------------------------------------------------------------
  const scopedRenderDegustacionRows = (rawRenderDegustacionRowsFast ?? []).filter((r) =>
    matchesAssignedRegionsForExternalFdvRow(r, effectiveAssignedRegions)
  );
  const { mergedRows: degustacionSurveys } = mergeSupabaseAndRenderDegustacionRows(
    cleanDegustacionSurveys,
    scopedRenderDegustacionRows
  );
  const tastingItems: TastingScheduleItem[] = [];
  const visitsForSchedule: ScheduledVisit[] = [];
  const todayYmd = getTodayVeYmd();

  degustacionSurveys.forEach((row, idx) => {
    const c = safeParseJson<Record<string, any>>(row.comments);
    const isFromSellerApp = isSellerOriginComments(c);
    const canonicalDegId = normalizeCanonicalDegustacionId(c.degustacionId || c.id, row.id);
    const rawCandidatePromoter =
      (c.promotoraAsignada && sanitizeFdvText(c.promotoraAsignada, 140)) ||
      (isFromSellerApp
        ? sanitizeFdvText(c.promoter || 'POR ASIGNAR (Trade Marketing)', 140)
        : sanitizeFdvText(row.promoter, 140));

    const isUnassignedPlaceholder =
      !rawCandidatePromoter ||
      /^POR ASIGNAR/i.test(rawCandidatePromoter) ||
      /^SIN ASIGNAR/i.test(rawCandidatePromoter);

    let assignedPromoter = 'POR ASIGNAR (Trade Marketing)';
    if (!isUnassignedPlaceholder) {
      const matchedActive = resolveActiveMember(
        rawCandidatePromoter,
        isFromSellerApp ? undefined : row.creatorId
      );
      if (matchedActive && matchedActive.category !== 'merchandising') {
        assignedPromoter = matchedActive.name;
      } else if (isFromSellerApp) {
        // Si la solicitud de vendedor tenía una promotora dada de baja, queda disponible por asignar
        assignedPromoter = 'POR ASIGNAR (Trade Marketing)';
      } else {
        // Excluir registros antiguos de promotoras retiradas / inactivas
        return;
      }
    } else if (!isFromSellerApp) {
      return;
    }

    const ymd = formatDateYmd(c.date || row.date);
    const aprobadoYmd = formatDateYmd(c.aprobadoEnTradeAt);
    const isPastDateOrCycle = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
      ? isTastingInPastCaracasWeek(ymd, undefined, row.created_at || c.created_at)
      : isTastingBeforeTodayCaracas(ymd, undefined, row.created_at || c.created_at);

    const lifecycle = resolveFdvRequestLifecycle({
      rawEstado: c.estado || c.status,
      isFromSellerApp,
      ymd,
      todayYmd,
      aprobadoYmd,
      enHistorial: Boolean(row.en_historial) || isPastDateOrCycle,
    });
    const itemStatus = lifecycle.uiStatus;
    const resolvedEnHistorial =
      Boolean(row.en_historial) ||
      isPastDateOrCycle ||
      lifecycle.enHistorial ||
      itemStatus === 'NO_AUTORIZADA';
    const resolvedArchivadoEn =
      (row.archivado_en ? String(row.archivado_en) : null) ||
      (c.archivado_en ? String(c.archivado_en) : null) ||
      null;
    const resolvedMotivoArchivo =
      (row.motivo_archivo ? String(row.motivo_archivo) : null) ||
      (c.motivo_archivo ? String(c.motivo_archivo) : null) ||
      (itemStatus === 'NO_AUTORIZADA'
        ? 'NO_AUTORIZADA'
        : resolvedEnHistorial
          ? 'CORTE_DIARIO_CARACAS'
          : null);
    const dayLabel = formatDayLabelEs(ymd);

    const rawTurnoToken = sanitizeFdvText(c.turno, 30).toUpperCase();
    const normalizedTurnoRaw =
      rawTurnoToken === 'MANANA'
        ? 'MAÑANA'
        : rawTurnoToken === 'COMPLETO'
          ? 'COMPLETO'
          : rawTurnoToken || undefined;
    const rawTurno = String(normalizedTurnoRaw || c.shift || c.time || '');
    const shift: ShiftType =
      normalizedTurnoRaw === 'COMPLETO' ? 'MAÑANA' : inferShiftFromTime(rawTurno, row.date);
    const timeRange = sanitizeFdvText(
      c.time ||
        c.shift ||
        (normalizedTurnoRaw === 'COMPLETO'
          ? 'Día Completo (09:00 AM - 07:00 PM)'
          : shift === 'MAÑANA'
            ? '09:00 AM - 01:00 PM'
            : '02:00 PM - 07:00 PM'),
      80
    );

    const address = sanitizeFdvText(c.address, 260);
    const { rutaFromAddress, contactoFromAddress, telefonoFromAddress } =
      extractAddressEmbeddedMetadata(address);

    const storeName =
      sanitizeFdvText(c.client || c.cliente || c.store || row.store, 180) || 'PDV Sin Nombre';
    const zone =
      sanitizeFdvText(c.ruta || c.zone || rutaFromAddress || address, 180) || 'Maracaibo / Zulia';
    const productsList: string[] = Array.isArray(c.products)
      ? c.products.map((p: unknown) => sanitizeFdvText(p, 120)).filter(Boolean)
      : sanitizeFdvText(c.products || c.product || row.product, 300)
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
    const productName =
      sanitizeFdvText(
        productsList.join(', ') || c.product || row.product || 'Portafolio Codizulca',
        220
      ) || 'Portafolio Codizulca';

    const resultadoObj = parseResultadoReport(c.resultado);
    const rawKilos = toNum(c.kilos ?? c.kg ?? c.quantity ?? resultadoObj?.kilosDegustados, 1);
    const qty = Math.max(0.5, Math.round(rawKilos * 100) / 100);
    const targetSamples = Math.max(0, Math.round(toNum(c.personas ?? c.personasEstimadas, 0)));
    const deliveredSamples = Math.round(
      toNum(
        c.delivered ?? c.muestrasEntregadas ?? c.samplesDelivered ?? resultadoObj?.personasAlcanzadas,
        0
      )
    );
    const acceptance = c.acceptanceRate !== undefined ? toNum(c.acceptanceRate, 0) : undefined;

    const supplies = calculateProductionSupplies(productName, qty, targetSamples);
    const normProd = supplies.normalizedProduct;
    const mortadelaQty = supplies.mortadelaQty;
    const espaldaQty = supplies.espaldaQty;
    const arrozQty = supplies.arrozQty;
    const azucarGrams = supplies.azucarGrams;
    const lecheGrams = supplies.lecheGrams;

    const sellerName = isFromSellerApp
      ? sanitizeFdvText(c.vendedor || c.salesRep || row.promoter || 'Fuerza de Ventas', 140) ||
        'Fuerza de Ventas'
      : sanitizeFdvText(c.vendedor || 'Trade Marketing', 140) || 'Trade Marketing';

    const clienteCodigo = sanitizeFdvText(c.clienteCodigo, 60);
    const contactoPunto = sanitizeFdvText(c.contactoPunto || contactoFromAddress, 140);
    const telefonoContacto = sanitizeFdvText(c.telefonoContacto || telefonoFromAddress, 60);
    const promoterType = sanitizeFdvText(
      c.promoterType || (c.requierePromotora === false ? 'Vendedor / Impulso' : 'Fija'),
      60
    );
    const materialPop = sanitizeFdvText(
      typeof c.materialPop === 'boolean' ? (c.materialPop ? 'SI' : 'NO') : c.materialPop || 'SI',
      30
    );
    const requierePromotora = c.requierePromotora !== undefined ? Boolean(c.requierePromotora) : true;
    const notasTradeMarketing = sanitizeFdvText(c.notasTradeMarketing, 500);
    const createdAtIso = sanitizeFdvText(row.created_at || c.created_at, 60);
    const createdYmd = createdAtIso ? formatDateYmd(createdAtIso) : ymd;
    const estadoUpper = lifecycle.canonicalEstado;
    const isTerminalEstado = isTerminalDegustacionEstado(estadoUpper);
    const localLedgerStamp = getLocalDegustacionReadStamp(row.id, canonicalDegId);
    const resolvedLeidoTrade =
      resolvedEnHistorial || Boolean(localLedgerStamp) || row.leido_trade === true || c.leido_trade === true
        ? true
        : typeof row.leido_trade === 'boolean'
          ? !isFromSellerApp || isTerminalEstado || (ymd < todayYmd && createdYmd < todayYmd)
            ? true
            : row.leido_trade
          : typeof c.leido_trade === 'boolean'
            ? c.leido_trade
            : !(isFromSellerApp && !isTerminalEstado && (ymd >= todayYmd || createdYmd >= todayYmd));
    const resolvedVistoAt =
      (row.visto_en_trade_at ? String(row.visto_en_trade_at) : null) ||
      (c.visto_en_trade_at ? String(c.visto_en_trade_at) : null) ||
      localLedgerStamp;

    const contactInfo = contactoPunto
      ? `Contacto PDV: ${contactoPunto}${telefonoContacto ? ` (${telefonoContacto})` : ''}`
      : '';
    const resultadoSummary = resultadoObj
      ? [
          resultadoObj.kilosDegustados ? `Degustado: ${resultadoObj.kilosDegustados} kg` : '',
          resultadoObj.personasAlcanzadas ? `Impactos: ${resultadoObj.personasAlcanzadas}` : '',
          resultadoObj.ventasGeneradas ? `Ventas: ${resultadoObj.ventasGeneradas}` : '',
          resultadoObj.comentarios || '',
        ]
          .filter(Boolean)
          .join(' / ')
      : '';
    const cleanVendorObs = sanitizeFdvText(
      c.observaciones || c.notes || c.originalComments,
      500
    );
    const notesParts = [
      cleanVendorObs,
      contactInfo,
      notasTradeMarketing,
      resultadoSummary ? `Resultado: ${resultadoSummary}` : '',
    ]
      .filter(Boolean)
      .join(' • ');

    const parsedResultadoSales = resultadoObj?.ventasGeneradas
      ? toNum(String(resultadoObj.ventasGeneradas).replace(/[^\d.,]/g, '').replace(',', '.'), 0)
      : 0;
    const salesAssistedCount = Math.round(
      toNum(c.salesAssisted ?? c.ventas ?? c.resultadoVentas, parsedResultadoSales)
    );
    const safeMapsUrl = sanitizeExternalHttpsUrl(c.mapsUrl);

    // Todas las degustaciones ingresan a `tastingItems`:
    // - `fecha >= hoy_caracas` y no descartadas -> Bandeja de Entrada
    // - `fecha < hoy_caracas` o `NO_AUTORIZADA` -> Pestaña de Historial (conservando Autorizada vs No Autorizada)
    tastingItems.push({
      id: row.id,
      degustacionId: canonicalDegId,
      source: isFromSellerApp ? 'vendedor_app' : sanitizeFdvText(c.source || 'trade_marketing', 60),
      createdAt: createdAtIso,
      date: ymd,
      dayLabel,
      shift,
      turnoRaw: normalizedTurnoRaw,
      timeRange: String(timeRange),
      activityTitle: `Degustación ${productName}`,
      productName,
      productsList,
      responsibleName: assignedPromoter,
      storeName,
      clienteCodigo,
      zone,
      address,
      contactoPunto,
      telefonoContacto,
      requierePromotora,
      promoterType,
      materialPop,
      notasTradeMarketing,
      resultado: resultadoObj,
      leidoTrade: resolvedLeidoTrade,
      vistoEnTradeAt: resolvedVistoAt,
      mapsUrl: safeMapsUrl,
      status: itemStatus,
      currentSamples: deliveredSamples,
      targetSamples,
      requestedQty: qty,
      mortadelaQty,
      espaldaQty,
      arrozQty,
      azucarGrams,
      lecheGrams,
      operationalSupplies: supplies.operationalSupplies,
      fillProductSelection: normProd,
      fillQuantityInput: String(qty),
      acceptancePercent: acceptance,
      sellerApplicant: isFromSellerApp ? `${sellerName} (Vendedor FDV)` : sellerName,
      salesAssistedCount,
      lotNumber: canonicalDegId || `SUP-${row.id.slice(0, 8).toUpperCase()}`,
      isArchived: resolvedEnHistorial,
      enHistorial: resolvedEnHistorial,
      archivadoEn: resolvedArchivadoEn,
      motivoArchivo: resolvedMotivoArchivo,
      notes: notesParts || `Registro en Supabase (${row.type}) • ${promoterType || 'Promotora'}`,
      rawComments: c,
    });

    // Regla de Negocio Estricta (Módulo 1 -> Módulo 2):
    // Al Cronograma de Producción (Matriz de Llenado e Insumos) SOLO ingresan las solicitudes
    // que ya están aprobadas/programadas/ejecutadas y NO están en SOLICITADA/PENDIENTE ni rechazadas/canceladas.
    if (lifecycle.isEligibleForModule2) {
      visitsForSchedule.push({
        id: row.id,
        solicitudId: row.id,
        degustacionId: canonicalDegId,
        date: ymd,
        dayLabel,
        shift,
        storeId: c.clienteCodigo ? `st_${c.clienteCodigo}` : `st_sup_${idx + 1}`,
        storeName,
        zone,
        productFocus: productName,
        fillProductSelection: normProd,
        fillQuantityInput: String(qty),
        promotoraId: `prom_${idx + 1}`,
        promotoraName: assignedPromoter,
        sellerName,
        plannedUnits: qty,
        mortadelaQty,
        espaldaQty,
        arrozQty,
        azucarGrams,
        lecheGrams,
        rowHighlight: supplies.rowHighlight,
        tastedUnits: itemStatus === 'COMPLETADO' ? qty : 0,
        assistedSalesUnits: Math.round(toNum(c.salesAssisted ?? c.ventas, 0)),
        notes: notesParts,
        status:
          itemStatus === 'COMPLETADO'
            ? 'COMPLETADA'
            : itemStatus === 'EN_CURSO'
              ? 'EN_CURSO'
              : 'PENDIENTE',
        enHistorial: resolvedEnHistorial,
        archivadoEn: resolvedArchivadoEn,
        motivoArchivo: resolvedMotivoArchivo,
        additionalGoods: supplies.additionalGoods,
        operationalSupplies: supplies.operationalSupplies,
      });
    }
  });

  // --------------------------------------------------------------------------
  // 1.B. LOTE MULTIFORMATO VOLCADO A `public.cronograma_degustaciones` (MÓDULO 1 -> MÓDULO 2)
  // Incluye filas en `PENDIENTE_APROBACION` con `promotora_id: null` ("POR ASIGNAR")
  // para que aparezcan automáticamente en la bandeja de coordinación de Módulo 2.
  // --------------------------------------------------------------------------
  const activePromotoraById = new Map<string, StaffMemberRecord>();
  staffMembers.forEach((sm) => {
    if (sm.status === 'Activo' && sm.roleCategory === 'PROMOTORA') {
      activePromotoraById.set(sm.id, sm);
    }
  });

  const existingTastingIds = new Set(tastingItems.map((t) => t.id));
  const existingScheduleIds = new Set(visitsForSchedule.map((v) => v.id));

  rawCronogramaRows.forEach((cd, idx) => {
    if (!cd || !cd.id) return;

    const ymd = formatDateYmd(cd.fecha);
    const dayLabel = formatDayLabelEs(ymd);
    const shift: ShiftType =
      cd.turno === 'TARDE' ? 'TARDE' : cd.turno === 'COMPLETO' ? 'COMPLETO' : 'MAÑANA';
    const timeRange = `${cd.hora_inicio || '09:00'} - ${cd.hora_fin || '13:00'}`;
    const productName = String(cd.producto_resumen || 'MORTADELA').trim();
    const qty = Math.max(0.1, Number(cd.cantidad_kilos) || 1);
    const targetSamples = Math.max(0, Number(cd.personas_estimadas) || 0);
    const supplies = calculateProductionSupplies(productName, qty, targetSamples);

    const matchedProm =
      cd.promotora_id && activePromotoraById.has(cd.promotora_id)
        ? activePromotoraById.get(cd.promotora_id)!
        : null;
    const assignedPromoter = matchedProm
      ? matchedProm.name
      : cd.promotora_nombre?.trim() || 'POR ASIGNAR (Trade Marketing)';
    const resolvedPromotoraId = matchedProm ? matchedProm.id : cd.promotora_id || '';

    const storeName = String(cd.cliente_nombre || 'PDV Sin Nombre').trim();
    const zone = String(cd.zona_direccion || 'Maracaibo / Zulia').trim();
    const sellerName = String(cd.vendedor_fdv || 'Trade Marketing').trim();

    const isPastCronograma = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
      ? isTastingInPastCaracasWeek(ymd, undefined, cd.created_at)
      : isTastingBeforeTodayCaracas(ymd, undefined, cd.created_at);

    const isDiscardedEstado =
      cd.estado === 'NO_AUTORIZADA' ||
      cd.estado === 'RECHAZADA' ||
      cd.estado === 'CANCELADA';
    const isUnapprovedPast = cd.estado === 'PENDIENTE_APROBACION' && isPastCronograma;

    const itemStatus: TastingScheduleItem['status'] =
      isDiscardedEstado || isUnapprovedPast
        ? 'NO_AUTORIZADA'
        : cd.estado === 'COMPLETADA'
          ? 'COMPLETADO'
          : cd.estado === 'EN_CURSO'
            ? 'EN_CURSO'
            : cd.estado === 'PENDIENTE_APROBACION'
              ? 'PENDIENTE'
              : 'PROGRAMADO';

    const isAuthorizedForModule2 =
      cd.estado === 'APROBADA' || cd.estado === 'EN_CURSO' || cd.estado === 'COMPLETADA';

    const cronEnHistorial =
      Boolean(cd.en_historial) || isPastCronograma || itemStatus === 'NO_AUTORIZADA';
    const cronArchivadoEn = cd.archivado_en ?? null;
    const cronMotivoArchivo =
      cd.motivo_archivo ??
      (itemStatus === 'NO_AUTORIZADA'
        ? 'NO_AUTORIZADA'
        : cronEnHistorial
          ? 'CORTE_DIARIO_CARACAS'
          : null);

    // Si esta fila de cronograma proviene de una solicitud FDV (survey_origen_id),
    // enriquecer el registro existente en lugar de duplicarlo.
    if (cd.survey_origen_id) {
      const originSurveyId = String(cd.survey_origen_id).trim();
      const existingTastingIdx = tastingItems.findIndex((t) => t.id === originSurveyId);
      if (existingTastingIdx >= 0) {
        const prevTasting = tastingItems[existingTastingIdx]!;
        const mergedEnHistorial = cronEnHistorial || Boolean(prevTasting.enHistorial);
        tastingItems[existingTastingIdx] = {
          ...prevTasting,
          cronogramaId: cd.id,
          promotoraId: resolvedPromotoraId || undefined,
          responsibleName: assignedPromoter,
          status: itemStatus,
          isArchived: mergedEnHistorial,
          enHistorial: mergedEnHistorial,
          archivadoEn: cronArchivadoEn || prevTasting.archivadoEn || null,
          motivoArchivo: cronMotivoArchivo || prevTasting.motivoArchivo || null,
          rawComments: {
            ...(prevTasting.rawComments || {}),
            estado: itemStatus === 'NO_AUTORIZADA' ? 'NO_AUTORIZADA' : cd.estado,
            promotoraEmail: cd.promotora_email || prevTasting.rawComments?.promotoraEmail,
          },
        };
      }
      const existingVisitIdx = visitsForSchedule.findIndex(
        (v) => v.id === originSurveyId || v.solicitudId === originSurveyId
      );
      if (existingVisitIdx >= 0) {
        if (!isAuthorizedForModule2) {
          visitsForSchedule.splice(existingVisitIdx, 1);
        } else {
          const prevVisit = visitsForSchedule[existingVisitIdx]!;
          visitsForSchedule[existingVisitIdx] = {
            ...prevVisit,
            cronogramaId: cd.id,
            promotoraId: resolvedPromotoraId || prevVisit.promotoraId,
            promotoraName: assignedPromoter,
            enHistorial: cronEnHistorial,
            archivadoEn: cronArchivadoEn || prevVisit.archivadoEn || null,
            motivoArchivo: cronMotivoArchivo || prevVisit.motivoArchivo || null,
            status:
              cd.estado === 'COMPLETADA'
                ? 'COMPLETADA'
                : cd.estado === 'EN_CURSO'
                  ? 'EN_CURSO'
                  : 'PENDIENTE',
          };
        }
      } else if (isAuthorizedForModule2 && !existingScheduleIds.has(originSurveyId)) {
        existingScheduleIds.add(originSurveyId);
        visitsForSchedule.push({
          id: originSurveyId,
          cronogramaId: cd.id,
          solicitudId: originSurveyId,
          date: ymd,
          dayLabel,
          shift,
          storeId: cd.cliente_codigo ? `st_${cd.cliente_codigo}` : `st_cron_${idx + 1}`,
          storeName,
          zone,
          productFocus: productName,
          selectedProducts:
            Array.isArray(cd.productos) && cd.productos.length > 0 ? cd.productos : [productName],
          fillProductSelection: supplies.fillProductSelection,
          fillQuantityInput: String(qty),
          promotoraId: resolvedPromotoraId,
          promotoraName: assignedPromoter,
          sellerName,
          plannedUnits: qty,
          mortadelaQty: supplies.mortadelaQty,
          espaldaQty: supplies.espaldaQty,
          arrozQty: supplies.arrozQty,
          azucarGrams: supplies.azucarGrams,
          lecheGrams: supplies.lecheGrams,
          rowHighlight: supplies.rowHighlight,
          tastedUnits: cd.estado === 'COMPLETADA' ? qty : 0,
          assistedSalesUnits: 0,
          notes: cd.observaciones || `Estado: ${cd.estado}`,
          status:
            cd.estado === 'COMPLETADA'
              ? 'COMPLETADA'
              : cd.estado === 'EN_CURSO'
                ? 'EN_CURSO'
                : 'PENDIENTE',
          enHistorial: cronEnHistorial,
          archivadoEn: cronArchivadoEn,
          motivoArchivo: cronMotivoArchivo,
          additionalGoods: supplies.additionalGoods,
          operationalSupplies: supplies.operationalSupplies,
        });
      }
      if (existingTastingIdx >= 0 || existingVisitIdx >= 0 || isAuthorizedForModule2) {
        return;
      }
    }

    if (!existingTastingIds.has(cd.id)) {
      existingTastingIds.add(cd.id);
      tastingItems.push({
        id: cd.id,
        cronogramaId: cd.id,
        promotoraId: resolvedPromotoraId || undefined,
        source: 'carga_multiformato',
        createdAt: cd.created_at,
        date: ymd,
        dayLabel,
        shift,
        turnoRaw: cd.turno,
        timeRange,
        activityTitle: `Degustación ${productName}`,
        productName,
        productsList: Array.isArray(cd.productos) ? cd.productos : [productName],
        responsibleName: assignedPromoter,
        storeName,
        clienteCodigo: cd.cliente_codigo || undefined,
        zone,
        address: cd.zona_direccion || undefined,
        requierePromotora: true,
        status: itemStatus,
        currentSamples: 0,
        targetSamples,
        requestedQty: qty,
        mortadelaQty: supplies.mortadelaQty,
        espaldaQty: supplies.espaldaQty,
        arrozQty: supplies.arrozQty,
        azucarGrams: supplies.azucarGrams,
        lecheGrams: supplies.lecheGrams,
        operationalSupplies: supplies.operationalSupplies,
        fillProductSelection: supplies.fillProductSelection,
        fillQuantityInput: String(qty),
        sellerApplicant: sellerName,
        lotNumber: cd.carga_id ? `LOTE-${cd.carga_id.slice(0, 8).toUpperCase()}` : `CRON-${cd.id.slice(0, 8).toUpperCase()}`,
        isArchived: cronEnHistorial,
        enHistorial: cronEnHistorial,
        archivadoEn: cronArchivadoEn,
        motivoArchivo: cronMotivoArchivo,
        notes:
          cd.observaciones ||
          (itemStatus === 'NO_AUTORIZADA'
            ? 'No Autorizada en Coordinación de Trade Marketing'
            : cd.estado === 'PENDIENTE_APROBACION'
              ? 'Pendiente de Autorización'
              : 'Autorizada en Trade Marketing'),
        rawComments: {
          estado: itemStatus === 'NO_AUTORIZADA' ? 'NO_AUTORIZADA' : cd.estado,
          promotoraEmail: cd.promotora_email || undefined,
        },
      });
    }

    if (isAuthorizedForModule2 && !existingScheduleIds.has(cd.id)) {
      existingScheduleIds.add(cd.id);
      visitsForSchedule.push({
        id: cd.id,
        cronogramaId: cd.id,
        solicitudId: cd.id,
        date: ymd,
        dayLabel,
        shift,
        storeId: cd.cliente_codigo ? `st_${cd.cliente_codigo}` : `st_cron_${idx + 1}`,
        storeName,
        zone,
        productFocus: productName,
        selectedProducts:
          Array.isArray(cd.productos) && cd.productos.length > 0 ? cd.productos : [productName],
        fillProductSelection: supplies.fillProductSelection,
        fillQuantityInput: String(qty),
        promotoraId: resolvedPromotoraId,
        promotoraName: assignedPromoter,
        sellerName,
        plannedUnits: qty,
        mortadelaQty: supplies.mortadelaQty,
        espaldaQty: supplies.espaldaQty,
        arrozQty: supplies.arrozQty,
        azucarGrams: supplies.azucarGrams,
        lecheGrams: supplies.lecheGrams,
        rowHighlight: supplies.rowHighlight,
        tastedUnits: cd.estado === 'COMPLETADA' ? qty : 0,
        assistedSalesUnits: 0,
        notes: cd.observaciones || `Estado: ${cd.estado}`,
        status:
          cd.estado === 'COMPLETADA'
            ? 'COMPLETADA'
            : cd.estado === 'EN_CURSO'
              ? 'EN_CURSO'
              : 'PENDIENTE',
        enHistorial: cronEnHistorial,
        archivadoEn: cronArchivadoEn,
        motivoArchivo: cronMotivoArchivo,
        additionalGoods: supplies.additionalGoods,
        operationalSupplies: supplies.operationalSupplies,
      });
    }
  });

  // Orden determinista: solicitudes PENDIENTE (SOLICITADA FDV) primero, luego fecha programada descendente y fecha de envío descendente
  tastingItems.sort((a, b) => {
    const aPending = a.status === 'PENDIENTE' ? 0 : 1;
    const bPending = b.status === 'PENDIENTE' ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    const dateCmp = (b.date || '').localeCompare(a.date || '');
    if (dateCmp !== 0) return dateCmp;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });

  // --------------------------------------------------------------------------
  // 2. HISTORIAL DE VISITAS Y ASISTENCIA EN PDV (desde tabla `checkins` - SOLO PERSONAL ACTIVO)
  // --------------------------------------------------------------------------
  const visitsHistory: VisitHistoryRecord[] = rawCheckins.map((chk) => {
    const activeMember = resolveActiveMember(chk.promoter, chk.creatorId);
    const promoterDisplay = activeMember ? activeMember.name : resolvePromoterNameFromRaw(chk.promoter, chk.creatorId, activeStaffByKey);
    const loc = safeParseJson<{ lat?: number; lng?: number; accuracy?: number }>(chk.location);
    const lat = typeof loc.lat === 'number' ? loc.lat : undefined;
    const lng = typeof loc.lng === 'number' ? loc.lng : undefined;
    const accuracy = Math.round(toNum(loc.accuracy, 15));
    const ymd = formatDateYmd(chk.date || chk.created_at);
    const timeFormatted = formatTimeVe(chk.date || chk.created_at);
    const shift = inferShiftFromTime(chk.type, chk.date || chk.created_at);
    const mapsUrl =
      lat !== undefined && lng !== undefined
        ? `https://www.google.com/maps?q=${lat},${lng}`
        : undefined;

    const typeNorm = (chk.type || 'Ingreso').trim();
    const isExit = typeNorm.toLowerCase().includes('salida') && !typeNorm.toLowerCase().includes('almorzar');

    return {
      id: `CHK-${chk.id.slice(0, 8).toUpperCase()}`,
      rawCheckinId: chk.id,
      date: ymd,
      isoDate: chk.date || chk.created_at || '',
      timeIn: isExit ? '--:--' : timeFormatted,
      timeOut: isExit ? timeFormatted : '--:--',
      checkinType: typeNorm,
      storeName: (chk.store || 'PDV').trim(),
      zone:
        lat !== undefined && lng !== undefined
          ? `GPS ${lat.toFixed(4)}, ${lng.toFixed(4)}`
          : activeMember?.address || 'Zulia / Falcón',
      promotora: promoterDisplay,
      creatorEmail: activeMember?.email || (chk.creatorId || '').trim(),
      shift,
      gpsDistanceMeters: accuracy,
      gpsStatus:
        lat !== undefined && lng !== undefined
          ? `GPS Verificado (±${accuracy}m)`
          : 'Registro en Tienda',
      lat,
      lng,
      mapsUrl,
      auditStatus: isExit ? 'COMPLETADA' : 'EN_CURSO',
      photosCount: 1,
      summary: `Marcaje de "${typeNorm}" registrado por ${promoterDisplay} en ${(chk.store || 'PDV').trim()}.`,
    };
  });

  // Agrupación de `checkins` por (Fecha + Promotora Canónica Activa) para secuencia diaria de 4 marcajes
  const attendanceGroupMap = new Map<
    string,
    {
      id: string;
      promotoraId: string;
      masterCategory: StaffCategory;
      promotora: string;
      email: string;
      stores: Set<string>;
      date: string;
      ingreso?: string;
      ingresoIso?: string;
      salidaAlmorzar?: string;
      vueltaAlmorzar?: string;
      salida?: string;
      salidaIso?: string;
      bestAccuracy: number;
      lat?: number;
      lng?: number;
      eventsCount: number;
      ingresoEvent?: AttendanceSlotEvent;
      salidaAlmorzarEvent?: AttendanceSlotEvent;
      llegadaAlmorzarEvent?: AttendanceSlotEvent;
      salidaEvent?: AttendanceSlotEvent;
    }
  >();

  // Recorremos en orden cronológico ascendente para capturar primer ingreso y secuencia exacta del día
  [...rawCheckins].reverse().forEach((chk) => {
    const activeMember = resolveActiveMember(chk.promoter, chk.creatorId);
    if (!activeMember) return;
    const promoter = activeMember.name;
    const storeName = (chk.store || 'PDV').trim().toUpperCase();
    const ymd = formatDateYmd(chk.date || chk.created_at);
    const key = `${ymd}__${activeMember.canonicalKey}`;
    const timeStr = formatTimeVe(chk.date || chk.created_at);
    const fullTimeStr = formatFullTimeVe(chk.date || chk.created_at);
    const dateSlash = formatDateSlash(ymd);
    const loc = safeParseJson<{ lat?: number; lng?: number; accuracy?: number }>(chk.location);
    const acc = Math.round(toNum(loc.accuracy, 20));
    const lat = typeof loc.lat === 'number' ? loc.lat : undefined;
    const lng = typeof loc.lng === 'number' ? loc.lng : undefined;
    const mapsUrl = lat !== undefined && lng !== undefined ? `https://www.google.com/maps?q=${lat},${lng}` : undefined;

    if (!attendanceGroupMap.has(key)) {
      attendanceGroupMap.set(key, {
        id: chk.id,
        promotoraId: activeMember.id,
        masterCategory: activeMember.category,
        promotora: promoter,
        email: activeMember.email || (chk.creatorId || '').trim(),
        stores: new Set<string>(),
        date: ymd,
        bestAccuracy: acc,
        lat,
        lng,
        eventsCount: 0,
      });
    }

    const entry = attendanceGroupMap.get(key)!;
    if (storeName) entry.stores.add(storeName);
    entry.eventsCount += 1;
    if (acc > 0 && acc < entry.bestAccuracy) entry.bestAccuracy = acc;
    if (lat !== undefined && lng !== undefined) {
      entry.lat = lat;
      entry.lng = lng;
    }

    const t = (chk.type || '').toLowerCase();
    if (t.includes('ingreso')) {
      if (!entry.ingreso) {
        entry.ingreso = timeStr;
        entry.ingresoIso = chk.date;
      }
      entry.ingresoEvent = {
        checkinId: chk.id,
        type: 'INGRESO',
        rawType: chk.type || 'Ingreso',
        storeName,
        dateFormatted: dateSlash,
        timeFormatted: timeStr,
        fullTimeFormatted: fullTimeStr,
        isoDate: chk.date || chk.created_at || '',
        lat,
        lng,
        accuracy: acc,
        mapsUrl,
      };
    } else if (t.includes('salida a almorzar')) {
      entry.salidaAlmorzar = timeStr;
      entry.salidaAlmorzarEvent = {
        checkinId: chk.id,
        type: 'SALIDA A ALMORZAR',
        rawType: chk.type || 'Salida a almorzar',
        storeName,
        dateFormatted: dateSlash,
        timeFormatted: timeStr,
        fullTimeFormatted: fullTimeStr,
        isoDate: chk.date || chk.created_at || '',
        lat,
        lng,
        accuracy: acc,
        mapsUrl,
      };
    } else if (t.includes('vuelta a almorzar') || t.includes('llegada de almorzar')) {
      entry.vueltaAlmorzar = timeStr;
      entry.llegadaAlmorzarEvent = {
        checkinId: chk.id,
        type: 'LLEGADA DE ALMORZAR',
        rawType: chk.type || 'Vuelta a almorzar',
        storeName,
        dateFormatted: dateSlash,
        timeFormatted: timeStr,
        fullTimeFormatted: fullTimeStr,
        isoDate: chk.date || chk.created_at || '',
        lat,
        lng,
        accuracy: acc,
        mapsUrl,
      };
    } else if (t.includes('salida')) {
      entry.salida = timeStr;
      entry.salidaIso = chk.date;
      entry.salidaEvent = {
        checkinId: chk.id,
        type: 'SALIDA',
        rawType: chk.type || 'Salida',
        storeName,
        dateFormatted: dateSlash,
        timeFormatted: timeStr,
        fullTimeFormatted: fullTimeStr,
        isoDate: chk.date || chk.created_at || '',
        lat,
        lng,
        accuracy: acc,
        mapsUrl,
      };
    }
  });

  const attendanceRecords: AttendanceRecord[] = Array.from(attendanceGroupMap.values())
    .reverse()
    .map((g) => {
      let effectiveHours = 'En jornada';
      if (g.ingresoIso && g.salidaIso) {
        const diffMs = new Date(g.salidaIso).getTime() - new Date(g.ingresoIso).getTime();
        if (diffMs > 0) {
          const totalMin = Math.round(diffMs / 60000);
          const h = Math.floor(totalMin / 60);
          const m = totalMin % 60;
          effectiveHours = `${h}h ${String(m).padStart(2, '0')}m`;
        }
      }
      const mapsUrl =
        g.lat !== undefined && g.lng !== undefined
          ? `https://www.google.com/maps?q=${g.lat},${g.lng}`
          : undefined;
      // Mostrar tiendas del día en orden inverso (última visitada primero, como en el sistema corporativo)
      const combinedStores = Array.from(g.stores).reverse().join(' / ') || 'PDV';

      return {
        id: `ATT-${g.id.slice(0, 8).toUpperCase()}`,
        promotoraId: g.promotoraId,
        masterCategory: g.masterCategory,
        promotora: g.promotora,
        initials: getInitials(g.promotora),
        email: g.email,
        dni: g.email || 'Personal Verificado',
        storeName: combinedStores,
        zone:
          g.lat !== undefined && g.lng !== undefined
            ? `${g.lat.toFixed(4)}, ${g.lng.toFixed(4)} (±${g.bestAccuracy}m)`
            : 'PDV Verificado',
        date: g.date,
        dateSlash: formatDateSlash(g.date),
        dateLongEs: formatDateLongEs(g.date),
        shift: g.salidaAlmorzar || g.vueltaAlmorzar ? 'JORNADA COMPLETA' : 'TURNO PDV',
        clockIn: g.ingreso || g.vueltaAlmorzar || '--:--',
        lunchOut: g.salidaAlmorzar || '--:--',
        lunchIn: g.vueltaAlmorzar || '--:--',
        clockOut: g.salida || g.salidaAlmorzar || '--:--',
        punctuality: g.salida ? 'JORNADA COMPLETADA' : 'EN GUARDIA / MARCAJE PARCIAL',
        gpsAccuracy: `±${g.bestAccuracy}m GPS`,
        lat: g.lat,
        lng: g.lng,
        accuracy: g.bestAccuracy,
        mapsUrl,
        effectiveHours,
        status: g.salida ? 'COMPLETADO' : 'EN_CURSO',
        eventsCount: g.eventsCount,
        ingresoEvent: g.ingresoEvent,
        salidaAlmorzarEvent: g.salidaAlmorzarEvent,
        llegadaAlmorzarEvent: g.llegadaAlmorzarEvent,
        salidaEvent: g.salidaEvent,
      };
    });

  // --------------------------------------------------------------------------
  // 3. COMPARATIVA DE PRECIOS (desde tabla `prices` - SOLO PERSONAL ACTIVO)
  // --------------------------------------------------------------------------
  const cleanRawPrices = [...rawPrices]
    .filter((row) => !isSyntheticPriceOrInventoryRow(row) && resolveActiveMember(row.promoter, row.creatorId) !== null)
    .sort((a, b) => toSortableTimestamp(b.date, b.created_at) - toSortableTimestamp(a.date, a.created_at));

  const priceComparisons: PriceComparisonThreeBrands[] = cleanRawPrices.map((p) => {
    // Inmutabilidad histórica: priorizar siempre la tasa snapshot guardada al momento de captura
    const snapshotRateRaw = Number(p.tasa_bcv_aplicada ?? p.bcv_rate ?? 0);
    const rate =
      Number.isFinite(snapshotRateRaw) && snapshotRateRaw > 10 ? snapshotRateRaw : liveBcvRate;
    const ownCurrency: 'USD' | 'VES' =
      String(p.moneda_propia || 'USD').trim().toUpperCase() === 'VES' ? 'VES' : 'USD';
    const ownOriginalPrice = Number(p.ourPrice) || 0;
    const storedOwnUsd = Number(p.precio_propio_usd ?? 0);
    const ownUsd =
      Number.isFinite(storedOwnUsd) && storedOwnUsd > 0
        ? Number(storedOwnUsd.toFixed(4))
        : ownCurrency === 'VES' && rate && rate > 0
          ? Number((ownOriginalPrice / rate).toFixed(4))
          : ownOriginalPrice;
    const ownBs =
      ownCurrency === 'VES'
        ? Number(ownOriginalPrice.toFixed(2))
        : rate !== null
          ? Number((ownUsd * rate).toFixed(2))
          : null;

    const activeMember = resolveActiveMember(p.promoter, p.creatorId);
    const promoterName = activeMember ? activeMember.name : resolvePromoterNameFromRaw(p.promoter, p.creatorId, activeStaffByKey);
    const promoterZone =
      String(p.zona || '').trim() ||
      activeMember?.address ||
      resolvePromoterZone(promoterName, staffMembers);
    const resolvedRegion = String(p.region || activeMember?.region || 'Occidente').trim();

    const metaList = Array.isArray(p.competitors_meta)
      ? (p.competitors_meta as Array<Record<string, unknown>>)
      : [];

    const validComps =
      metaList.length > 0
        ? metaList
            .filter(
              (m) =>
                String(m.brand || '').trim() !== '' &&
                (Number(m.priceUsd ?? 0) > 0 || Number(m.originalPrice ?? 0) > 0)
            )
            .map((m) => {
              const brand = String(m.brand || 'Competidor').trim();
              const currency: 'USD' | 'VES' =
                String(m.currency || 'USD').trim().toUpperCase() === 'VES' ? 'VES' : 'USD';
              const originalPrice = Number(m.originalPrice ?? m.priceUsd ?? 0) || 0;
              const priceUsd =
                Number(m.priceUsd ?? 0) > 0
                  ? Number(Number(m.priceUsd).toFixed(4))
                  : currency === 'VES' && rate && rate > 0
                    ? Number((originalPrice / rate).toFixed(4))
                    : originalPrice;
              const priceBs =
                m.priceBs !== null && m.priceBs !== undefined && Number.isFinite(Number(m.priceBs))
                  ? Number(Number(m.priceBs).toFixed(2))
                  : currency === 'VES'
                    ? Number(originalPrice.toFixed(2))
                    : rate !== null
                      ? Number((priceUsd * rate).toFixed(2))
                      : null;
              const gapUsd =
                ownUsd > 0 && priceUsd > 0 ? Number((ownUsd - priceUsd).toFixed(4)) : 0;
              const diffPercent =
                ownUsd > 0 && priceUsd > 0
                  ? Number((((ownUsd - priceUsd) / priceUsd) * 100).toFixed(2))
                  : 0;
              return {
                brand,
                product: 'Producto Competidor',
                priceUsd,
                priceBs,
                diffPercent,
                originalPrice,
                currency,
                gapUsd,
              };
            })
        : (() => {
            const compCurrency: 'USD' | 'VES' =
              String(p.moneda_competencia || 'USD').trim().toUpperCase() === 'VES' ? 'VES' : 'USD';
            const rawPairs: Array<{ brand: any; price: any; idx: number }> = [
              { brand: p.competitor1Brand, price: p.competitor1Price, idx: 0 },
              { brand: p.competitor2Brand, price: p.competitor2Price, idx: 1 },
              { brand: p.competitor3Brand, price: p.competitor3Price, idx: 2 },
            ];
            if (
              rawPairs.every(
                (pair) =>
                  !pair.brand && (pair.price === null || pair.price === undefined || pair.price === '')
              ) &&
              (p.competitorBrand || p.competitorPrice)
            ) {
              rawPairs.push({ brand: p.competitorBrand, price: p.competitorPrice, idx: 0 });
            }
            return rawPairs
              .filter(
                (pair) =>
                  (pair.brand && String(pair.brand).trim() !== '') ||
                  (pair.price !== null && pair.price !== undefined && Number(pair.price) > 0)
              )
              .map((pair) => {
                const brand = String(pair.brand || 'Competidor').trim();
                const originalPrice = Number(pair.price) || 0;
                const storedPrimaryUsd = pair.idx === 0 ? Number(p.precio_competencia_usd ?? 0) : 0;
                const priceUsd =
                  Number.isFinite(storedPrimaryUsd) && storedPrimaryUsd > 0
                    ? Number(storedPrimaryUsd.toFixed(4))
                    : compCurrency === 'VES' && rate && rate > 0
                      ? Number((originalPrice / rate).toFixed(4))
                      : originalPrice;
                const priceBs =
                  compCurrency === 'VES'
                    ? Number(originalPrice.toFixed(2))
                    : rate !== null
                      ? Number((priceUsd * rate).toFixed(2))
                      : null;
                const gapUsd =
                  ownUsd > 0 && priceUsd > 0 ? Number((ownUsd - priceUsd).toFixed(4)) : 0;
                const diffPercent =
                  ownUsd > 0 && priceUsd > 0
                    ? Number((((ownUsd - priceUsd) / priceUsd) * 100).toFixed(2))
                    : 0;
                return {
                  brand,
                  product: 'Producto Competidor',
                  priceUsd,
                  priceBs,
                  diffPercent,
                  originalPrice,
                  currency: compCurrency,
                  gapUsd,
                };
              });
          })();

    const firstComp = validComps[0] || {
      brand: '—',
      product: '—',
      priceUsd: 0,
      priceBs: rate !== null ? 0 : null,
      diffPercent: 0,
      originalPrice: 0,
      currency: 'USD' as const,
      gapUsd: 0,
    };

    const secondComp = validComps[1] || {
      brand: '—',
      product: '—',
      priceUsd: 0,
      priceBs: rate !== null ? 0 : null,
      diffPercent: 0,
      originalPrice: 0,
      currency: 'USD' as const,
      gapUsd: 0,
    };

    const thirdComp = validComps[2] || {
      brand: '—',
      product: '—',
      priceUsd: 0,
      priceBs: rate !== null ? 0 : null,
      diffPercent: 0,
      originalPrice: 0,
      currency: 'USD' as const,
      gapUsd: 0,
    };

    const brechaUsd =
      p.brecha_usd !== null && p.brecha_usd !== undefined && Number.isFinite(Number(p.brecha_usd))
        ? Number(Number(p.brecha_usd).toFixed(4))
        : ownUsd > 0 && firstComp.priceUsd > 0
          ? Number((ownUsd - firstComp.priceUsd).toFixed(4))
          : 0;

    const gapPercent =
      p.brecha_porcentaje !== null &&
      p.brecha_porcentaje !== undefined &&
      Number.isFinite(Number(p.brecha_porcentaje))
        ? Number(Number(p.brecha_porcentaje).toFixed(2))
        : ownUsd > 0 && firstComp.priceUsd > 0
          ? Number((((ownUsd - firstComp.priceUsd) / firstComp.priceUsd) * 100).toFixed(2))
          : 0;

    const activeCompPrices = validComps.map((c) => c.priceUsd).filter((v) => v > 0);
    const avgCompUsd =
      activeCompPrices.length > 0
        ? Number((activeCompPrices.reduce((a, b) => a + b, 0) / activeCompPrices.length).toFixed(2))
        : 0;
    const avgCompBs = rate !== null ? Number((avgCompUsd * rate).toFixed(2)) : null;
    const overallDiffPercent = gapPercent;

    const rawComments = String(p.comments ?? '').trim();
    const cleanObs =
      rawComments === 'AI_SCANNED' ? 'Escaneo de etiqueta en anaquel (App Promotora)' : rawComments;

    const dateIso = p.date || p.created_at || '';

    return {
      id: String(p.id),
      date: formatDateYmd(dateIso),
      dateSlash: formatDateFromField(dateIso),
      storeName: String(p.store || 'Punto de Venta').trim(),
      cadena: p.cadena ? String(p.cadena).trim() : undefined,
      zone: promoterZone,
      region: resolvedRegion,
      promotora: promoterName,
      origin: promoterName,
      category: inferCategory(p.ourProduct || ''),
      ownProduct: String(p.ourProduct || 'Producto Codizulca').trim(),
      codizulcaSku: '',
      ownPriceUsd: ownUsd,
      ownPriceBs: ownBs,
      ownOriginalPrice,
      ownCurrency,
      bcvRate: rate ?? undefined,
      bcvRateDate: p.tasa_bcv_fecha ? String(p.tasa_bcv_fecha).slice(0, 10) : formatDateYmd(dateIso),
      competitorBrand: firstComp.brand,
      competitorProduct: firstComp.product,
      competitorPriceUsd: firstComp.priceUsd,
      competitorPriceBs: firstComp.priceBs,
      competitorOriginalPrice: firstComp.originalPrice,
      competitorCurrency: firstComp.currency,
      brechaUsd,
      gapPercent,
      competitorsList: validComps,
      observations: cleanObs,
      photoStoragePath: p.photo_storage_path ? String(p.photo_storage_path).trim() : null,
      ocrAsistido: Boolean(p.ocr_asistido),
      ocrConfianza:
        p.ocr_confianza === 'alta' || p.ocr_confianza === 'media' || p.ocr_confianza === 'baja'
          ? p.ocr_confianza
          : null,
      competitor1: firstComp,
      competitor2: secondComp,
      competitor3: thirdComp,
      averageCompetitorPriceUsd: avgCompUsd,
      averageCompetitorPriceBs: avgCompBs,
      overallDiffPercent,
      status: 'SINCRONIZADO',
    };
  });

  // --------------------------------------------------------------------------
  // 4. INVENTARIO Y DEGUSTACIÓN (desde tabla `inventory` - PERSONAL ACTIVO + PORTAL)
  // --------------------------------------------------------------------------
  const staffByIdMap = new Map<string, StaffMemberRecord>();
  staffMembers.forEach((sm) => {
    staffByIdMap.set(String(sm.id), sm);
    if (sm.authUserId) staffByIdMap.set(String(sm.authUserId), sm);
  });

  const cleanRawInventory = [...rawInventory]
    .filter((row) => {
      if (isSyntheticPriceOrInventoryRow(row)) return false;
      if (resolveActiveMember(row.promoter, row.creatorId) !== null) return true;
      if (row.promotora_id && staffByIdMap.has(String(row.promotora_id))) return true;
      if (row.auth_user_id && String(row.promoter || '').trim().length > 0) return true;
      return false;
    })
    .sort((a, b) => toSortableTimestamp(b.date, b.created_at) - toSortableTimestamp(a.date, a.created_at));

  const inventorySampling: InventorySamplingRecord[] = cleanRawInventory.map((inv, idx) => {
    const init = Number(inv.initialQuantity) || 0;
    const samples = Number(inv.degustations) || 0;
    const rawFinProvided = inv.finalQuantity;
    const parsedRawFin =
      rawFinProvided !== undefined && rawFinProvided !== null ? Number(rawFinProvided) : null;

    // Si el inventario final no fue provisto o quedó igual al inicial habiendo degustación, calcularlo automáticamente
    const fin =
      parsedRawFin === null ||
      Number.isNaN(parsedRawFin) ||
      (parsedRawFin === init && init > 0 && samples > 0)
        ? Number(Math.max(0, init - samples).toFixed(2))
        : Number(Math.max(0, parsedRawFin).toFixed(2));

    const rawDiff = Number(Math.max(0, init - fin).toFixed(2));
    const explicitSales =
      inv.sales_generated !== undefined && inv.sales_generated !== null && inv.sales_generated !== ''
        ? Number(inv.sales_generated)
        : null;
    // Resultado (ventas generadas / rotación neta) = sales_generated explícito o Inicial - Final - Muestras degustadas
    const salesGenerated =
      explicitSales !== null && Number.isFinite(explicitSales) && explicitSales >= 0
        ? Number(explicitSales.toFixed(2))
        : samples > 0 && rawDiff >= samples
          ? Number((rawDiff - samples).toFixed(2))
          : Math.max(0, rawDiff);

    const rotationPercent = init > 0 ? Math.round(((init - fin) / init) * 100) : 0;
    const conversionRate =
      samples > 0
        ? Math.min(100, Number(((salesGenerated / samples) * 100).toFixed(1)))
        : salesGenerated > 0
          ? 100
          : 0;

    const productName = String(inv.product || 'Producto Codizulca').trim();
    const prodLower = productName.toLowerCase();
    const unit =
      /\b(kg|1kg|x\s*kg)\b/i.test(prodLower) &&
      !prodLower.includes('paquete') &&
      !prodLower.includes('pieza') &&
      !prodLower.includes('unidad')
        ? 'Kg'
        : 'Unid/Kg';

    const activeMember =
      resolveActiveMember(inv.promoter, inv.creatorId) ||
      (inv.promotora_id ? staffByIdMap.get(String(inv.promotora_id)) || null : null) ||
      (inv.auth_user_id ? staffByIdMap.get(String(inv.auth_user_id)) || null : null);
    const promoterName = activeMember
      ? activeMember.name
      : resolvePromoterNameFromRaw(inv.promoter, inv.creatorId, activeStaffByKey);
    const promoterZone =
      String(inv.zona || '').trim() ||
      activeMember?.address ||
      resolvePromoterZone(promoterName, staffMembers);
    const rawRegion = String(inv.region || '').trim().toLowerCase();
    const resolvedRegion: 'Occidente' | 'Valencia' | 'Centro' | 'Andes' =
      rawRegion === 'andes' || rawRegion === 'los andes'
        ? 'Andes'
        : rawRegion === 'centro'
          ? 'Centro'
          : rawRegion === 'valencia'
            ? 'Valencia'
            : rawRegion === 'occidente' || rawRegion === 'zulia'
              ? 'Occidente'
              : activeMember?.region === 'Andes'
                ? 'Andes'
                : activeMember?.region === 'Centro'
                  ? 'Centro'
                  : activeMember?.region === 'Valencia'
                    ? 'Valencia'
                    : 'Occidente';
    const dateIso = inv.date || inv.created_at || '';

    return {
      id: String(inv.id),
      date: formatDateYmd(dateIso),
      dateSlash: formatDateFromField(dateIso),
      isoDate: dateIso,
      storeName: String(inv.store || 'Punto de Venta').trim(),
      zone: promoterZone,
      region: resolvedRegion,
      promotoraId: activeMember?.id || (inv.promotora_id ? String(inv.promotora_id) : undefined),
      promotora: promoterName,
      creatorEmail: activeMember?.email || String(inv.creatorId || '').trim(),
      productName,
      sku: `SKU-INV-${String(idx + 1).padStart(2, '0')}`,
      unit,
      lotNumber: `ID-${String(inv.id).slice(0, 8).toUpperCase()}`,
      initialStock: Number(init.toFixed(2)),
      openedUnits: samples > 0 ? Math.max(1, Math.ceil(samples / 50)) : 0,
      portionsPrepared: Number(samples.toFixed(2)),
      portionsSampled: Number(samples.toFixed(2)),
      assistedSales: salesGenerated,
      salesGenerated,
      rotationPercent,
      conversionRate,
      finalStock: Number(fin.toFixed(2)),
      observations: String(inv.comments ?? '').trim(),
      status: 'SINCRONIZADO',
    };
  });

  // --------------------------------------------------------------------------
  // 5. MERCHANDISING (SOLO PROMOTORES MERCHANDISING ACTIVOS + CRUCE EXACTO CON FOTOS DE `checkins`)
  // --------------------------------------------------------------------------
  const normalizeMerchStoreText = (val: string): string =>
    val
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/farma\s+express/g, 'farmaexpress')
      .replace(/farma\s+venezuela/g, 'farmavenezuela')
      .replace(/la\s+mega/g, 'lamega')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const MERCH_CHAIN_TOKENS = [
    'farmaexpress',
    'farmavenezuela',
    'familia',
    'fiorella',
    'mercasa',
    'alkosto',
    'lamega',
    'maraplus',
    'olimpica',
    'viviana',
    'baik',
    'cosecha',
    'comercasur',
    'panaderia',
  ];

  const MERCH_BRANCH_TOKENS = [
    'lago',
    'picola',
    'macau',
    'quintero',
    'delicias',
    'limpia',
    '72',
    'julio',
    'fuerzas',
    'armadas',
    'jacinto',
    'milagro',
    'curva',
    'cumbre',
    'olivos',
    'amparo',
    'c2',
    '6',
    '24',
    'bella',
    'vista',
  ];

  const scoreMerchCheckinMatch = (
    surveyStore: string,
    surveyTs: number,
    chkStore: string,
    chkTs: number
  ): { total: number; storeScore: number } => {
    const isDefaultAlkosto = chkStore.toUpperCase().includes('ALKOSTO DONDE COMPRAR ES GANAR');
    const sNorm = normalizeMerchStoreText(surveyStore);
    const cNorm = normalizeMerchStoreText(chkStore);
    const sWords = new Set(sNorm.split(/\s+/).filter(Boolean));
    const cWords = new Set(cNorm.split(/\s+/).filter(Boolean));

    const diffMin = surveyTs > 0 && chkTs > 0 ? (surveyTs - chkTs) / 60000 : 0;
    let timeScore = 10;
    if (surveyTs > 0 && chkTs > 0) {
      if (diffMin >= -15 && diffMin <= 180) {
        timeScore = 60 - Math.min(50, Math.abs(diffMin) * 0.3);
      } else if (Math.abs(diffMin) <= 360) {
        timeScore = 15 - Math.min(14, Math.abs(diffMin) * 0.04);
      } else {
        timeScore = -25;
      }
    }

    let storeScore = 0;
    if (!isDefaultAlkosto) {
      const sChains = MERCH_CHAIN_TOKENS.filter((t) => sWords.has(t) || sNorm.includes(t));
      const cChains = MERCH_CHAIN_TOKENS.filter((t) => cWords.has(t) || cNorm.includes(t));
      const sharesChain =
        sChains.length > 0 && cChains.length > 0
          ? sChains.some((ch) => cChains.includes(ch))
          : sNorm.length >= 4 && cNorm.length >= 4 && (cNorm.includes(sNorm) || sNorm.includes(cNorm));

      if (!sharesChain) {
        return { total: -1, storeScore: -1 };
      }

      const sBranches = MERCH_BRANCH_TOKENS.filter((b) => sWords.has(b));
      const cBranches = MERCH_BRANCH_TOKENS.filter((b) => cWords.has(b));
      if (sBranches.length > 0 && cBranches.length > 0) {
        const sharesBranch = sBranches.some((b) => cBranches.includes(b));
        if (sharesBranch) {
          storeScore = 120;
        } else if (!chkStore.includes('/')) {
          return { total: -1, storeScore: -1 };
        } else {
          storeScore = 70;
        }
      } else {
        storeScore = 85;
      }
    } else {
      if (sNorm.includes('alkosto')) {
        storeScore = 90;
      } else {
        if (surveyTs > 0 && chkTs > 0 && (diffMin < -30 || diffMin > 240)) {
          return { total: -1, storeScore: -1 };
        }
        storeScore = 30;
      }
    }

    return { total: storeScore + timeScore, storeScore };
  };

  interface IndexedPromoterCheckin {
    id: string;
    store: string;
    ts: number;
  }

  const checkinsByPromoterDay = new Map<string, IndexedPromoterCheckin[]>();
  rawCheckins.forEach((chk) => {
    const id = String(chk.id || '').trim();
    if (!id) return;
    const activeMember = resolveActiveMember(chk.promoter, chk.creatorId);
    if (!activeMember || !activeMerchByKey.has(activeMember.canonicalKey)) return;
    const dateVe = formatDateYmd(chk.created_at || chk.date);
    if (!dateVe) return;
    const tsRaw = new Date(chk.created_at || chk.date || '').getTime();
    const key = `${activeMember.canonicalKey}|${dateVe}`;
    if (!checkinsByPromoterDay.has(key)) {
      checkinsByPromoterDay.set(key, []);
    }
    checkinsByPromoterDay.get(key)!.push({
      id,
      store: String(chk.store || '').trim(),
      ts: Number.isNaN(tsRaw) ? 0 : tsRaw,
    });
  });

  const merchIntermediate = rawSurveys
    .filter((s) => {
      if (s.type !== 'Merchandising') return false;
      const c = safeParseJson<Record<string, any>>(s.comments);
      const member = resolveActiveMember(s.promoter || c.promoter, s.creatorId);
      // Restringir estrictamente a Promotores de Merchandising activos (ej. JOSE BARROSO y ZIORELI GRANGGER)
      return Boolean(member && activeMerchByKey.has(member.canonicalKey));
    })
    .sort((a, b) => toSortableTimestamp(b.date, b.created_at) - toSortableTimestamp(a.date, a.created_at))
    .map((m) => {
      const c = safeParseJson<Record<string, any>>(m.comments);
      const activities = Array.isArray(c.activities)
        ? c.activities.map(String)
        : typeof c.activities === 'string' && c.activities
          ? [c.activities]
          : [];

      const rawPhotoCandidates: unknown[] = [
        ...(Array.isArray(c.photos) ? c.photos : []),
        ...(Array.isArray(c.images) ? c.images : []),
        ...(Array.isArray(c.evidencePhotos) ? c.evidencePhotos : []),
        c.photo,
        c.photoBase64,
        c.image,
        c.imageUrl,
        c.beforePhoto,
        c.afterPhoto,
      ];
      const photos = Array.from(
        new Set(
          rawPhotoCandidates.filter(
            (p): p is string =>
              typeof p === 'string' &&
              p.trim().length > 20 &&
              (p.trim().startsWith('data:image') || p.trim().startsWith('http'))
          )
        )
      );

      const rawDate = String(m.date || c.date || m.created_at || '').trim();
      const isoTimestampSource = [rawDate, String(m.created_at || ''), String(c.signedAt || '')].find((s) =>
        s.includes('T')
      );
      let datePart = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
        ? rawDate
        : formatDateYmd(isoTimestampSource || rawDate);
      let timePart = String(c.time || '').trim();

      if (isoTimestampSource) {
        try {
          const dt = new Date(isoTimestampSource);
          if (!Number.isNaN(dt.getTime())) {
            const formatter = new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/Caracas',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            });
            const parts = formatter.formatToParts(dt);
            const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '';
            const y = getPart('year');
            const mo = getPart('month');
            const d = getPart('day');
            const h = getPart('hour');
            const min = getPart('minute');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) && y && mo && d) {
              datePart = `${y}-${mo}-${d}`;
            }
            if (!timePart && h && min) {
              timePart = `${h === '24' ? '00' : h}:${min}`;
            }
          }
        } catch {
          // Fallback al formato estándar
        }
      }

      if (!timePart) {
        timePart = formatTimeVe(m.created_at || m.date);
      }

      const activeMerchMember = resolveActiveMember(m.promoter || c.promoter, m.creatorId);
      const resolvedPromoter = activeMerchMember
        ? activeMerchMember.name
        : resolvePromoterNameFromRaw(m.promoter || c.promoter, m.creatorId, activeStaffByKey);
      const canonicalPromoterKey = activeMerchMember
        ? activeMerchMember.canonicalKey
        : normalizeStaffTextKey(resolvedPromoter);

      const rawSignature =
        typeof c.signatureBase64 === 'string' && c.signatureBase64.startsWith('data:image')
          ? c.signatureBase64
          : typeof c.signature === 'string' && c.signature.startsWith('data:image')
            ? c.signature
            : undefined;

      const parsedCreatedTs = isoTimestampSource ? new Date(isoTimestampSource).getTime() : NaN;
      const fallbackLocalTs =
        datePart && /^\d{2}:\d{2}/.test(timePart)
          ? new Date(`${datePart}T${timePart.slice(0, 5)}:00-04:00`).getTime()
          : NaN;
      const surveyTs = !Number.isNaN(parsedCreatedTs)
        ? parsedCreatedTs
        : !Number.isNaN(fallbackLocalTs)
          ? fallbackLocalTs
          : 0;

      const record: MerchandisingRecord = {
        id: String(m.id),
        date: datePart,
        time: timePart,
        storeName: String(m.store || c.storeName || 'PDV').trim(),
        address: String(c.address || 'Piso de Venta').trim(),
        promoter: resolvedPromoter,
        product: String(m.product || c.category || 'Línea Codizulca').trim(),
        category: String(c.category || m.product || 'Portafolio General Codizulca').trim(),
        storeManagerName: String(c.storeManagerName || 'Encargado').trim(),
        storeManagerRole: String(c.storeManagerRole || 'Encargado de Tienda').trim(),
        storeManagerPhone: String(c.storeManagerPhone || '').trim(),
        visitReason: String(c.visitReason || 'Certificación de Labores de Merchandising en Anaquel').trim(),
        activities,
        observations: String(c.observations || '').trim(),
        signatureBase64: rawSignature,
        signedAt: c.signedAt ? formatTimeVe(c.signedAt) : undefined,
        certified: Boolean(c.certified ?? Boolean(rawSignature)),
        photos,
        matchedCheckinIds: [],
        metrics: c.metrics && typeof c.metrics === 'object' ? c.metrics : undefined,
        alerts: Array.isArray(c.alerts) ? c.alerts.map(String) : undefined,
        aiRecommendations:
          c.aiRecommendations && typeof c.aiRecommendations === 'object' ? c.aiRecommendations : undefined,
        rawComments: c,
      };

      return { record, surveyTs, canonicalPromoterKey };
    });

  // Asignación 1-a-1 por día y mercaderista entre visitas de Merchandising y fotografías reales en `checkins`
  const merchIndexesByPromoterDay = new Map<string, number[]>();
  merchIntermediate.forEach((item, idx) => {
    const key = `${item.canonicalPromoterKey}|${item.record.date}`;
    if (!merchIndexesByPromoterDay.has(key)) {
      merchIndexesByPromoterDay.set(key, []);
    }
    merchIndexesByPromoterDay.get(key)!.push(idx);
  });

  merchIndexesByPromoterDay.forEach((surveyIndices, key) => {
    const dayCheckins = checkinsByPromoterDay.get(key);
    if (!dayCheckins || dayCheckins.length === 0) return;

    const candidates: Array<{
      surveyIdx: number;
      checkinId: string;
      total: number;
      storeScore: number;
    }> = [];

    surveyIndices.forEach((sIdx) => {
      const { record, surveyTs } = merchIntermediate[sIdx];
      dayCheckins.forEach((chk) => {
        const { total, storeScore } = scoreMerchCheckinMatch(record.storeName, surveyTs, chk.store, chk.ts);
        if (total > 0) {
          candidates.push({ surveyIdx: sIdx, checkinId: chk.id, total, storeScore });
        }
      });
    });

    candidates.sort((a, b) => b.total - a.total);

    const assignedSurveys = new Set<number>();
    const usedCheckins = new Set<string>();

    // Pasada 1: Emparejamiento exclusivo 1-a-1 de mayor puntaje (tienda + cercanía temporal)
    candidates.forEach((cand) => {
      if (assignedSurveys.has(cand.surveyIdx) || usedCheckins.has(cand.checkinId)) return;
      assignedSurveys.add(cand.surveyIdx);
      usedCheckins.add(cand.checkinId);
      merchIntermediate[cand.surveyIdx].record.matchedCheckinIds = [cand.checkinId];
    });

    // Pasada 2: Si un mismo PDV tuvo 2 reportes en la misma visita con coincidencia explícita de tienda
    candidates.forEach((cand) => {
      if (assignedSurveys.has(cand.surveyIdx)) return;
      if (cand.storeScore >= 85) {
        assignedSurveys.add(cand.surveyIdx);
        merchIntermediate[cand.surveyIdx].record.matchedCheckinIds = [cand.checkinId];
      }
    });
  });

  const merchandisingRecords: MerchandisingRecord[] = merchIntermediate.map((item) => item.record);

  // --------------------------------------------------------------------------
  // 6. MÉTRICAS REALES POR PROMOTORA / MERCADERISTA ACTIVO EN `staffMembers`
  // --------------------------------------------------------------------------
  const checkinsStatsByKey = new Map<string, number>();
  rawCheckins.forEach((c) => {
    const member = resolveActiveMember(c.promoter, c.creatorId);
    if (!member) return;
    checkinsStatsByKey.set(member.canonicalKey, (checkinsStatsByKey.get(member.canonicalKey) || 0) + 1);
  });

  const invStatsByKey = new Map<string, { degustations: number; rotation: number; count: number }>();
  cleanRawInventory.forEach((inv) => {
    const member = resolveActiveMember(inv.promoter, inv.creatorId);
    if (!member) return;
    if (!invStatsByKey.has(member.canonicalKey)) {
      invStatsByKey.set(member.canonicalKey, { degustations: 0, rotation: 0, count: 0 });
    }
    const item = invStatsByKey.get(member.canonicalKey)!;
    const ini = toNum(inv.initialQuantity, 0);
    const fin = toNum(inv.finalQuantity, 0);
    const deg = toNum(inv.degustations, 0);
    item.degustations += deg;
    item.rotation += Math.max(0, ini - fin);
    item.count += 1;
  });

  const merchStatsByKey = new Map<string, number>();
  merchIntermediate.forEach((m) => {
    merchStatsByKey.set(
      m.canonicalPromoterKey,
      (merchStatsByKey.get(m.canonicalPromoterKey) || 0) + 1
    );
  });

  staffMembers.forEach((sm) => {
    const chkCount = checkinsStatsByKey.get(sm.canonicalKey) || 0;
    const invStats = invStatsByKey.get(sm.canonicalKey);
    const merchCount = merchStatsByKey.get(sm.canonicalKey) || 0;
    sm.tastingCompleted = Math.round(invStats?.degustations || 0);
    sm.salesAssisted = Math.round(invStats?.rotation || 0);
    sm.activationsCount = chkCount + (invStats?.count || 0) + merchCount;
    sm.totalUnits = (invStats?.count || 0) + merchCount;
  });

  // --------------------------------------------------------------------------
  // 7. RESUMEN Y FILAS DE ENCUESTAS DE CONSUMIDORES (Breve + Profunda)
  //    Omitido cuando `ENABLE_MODULO1_TABLAS_METRICAS === false`.
  // --------------------------------------------------------------------------
  const rawConsumerSurveys = FEATURE_FLAGS.ENABLE_MODULO1_TABLAS_METRICAS
    ? rawSurveys
        .filter((s) => s.type === 'Breve' || s.type === 'Profunda')
        .sort(
          (a, b) =>
            toSortableTimestamp(b.date, b.created_at) - toSortableTimestamp(a.date, a.created_at)
        )
    : [];

  const consumerSurveys: ConsumerSurveyRecord[] = rawConsumerSurveys.map((s, idx) => {
    const c = safeParseJson<Record<string, any>>(s.comments);
    const activeMember = resolveActiveMember(s.promoter || c.promoter, s.creatorId);
    const promoterName = activeMember
      ? activeMember.name
      : resolvePromoterNameFromRaw(s.promoter || c.promoter, s.creatorId, activeStaffByKey);
    const rawDateSource = String(s.date || c.date || s.created_at || '').trim();
    const ymd = formatDateYmd(rawDateSource) || formatDateYmd(s.created_at) || '';
    const storeName = String(s.store || c.store || c.cliente || 'PDV Sin Nombre').trim() || 'PDV Sin Nombre';
    const zone =
      String(c.zone || c.zona || activeMember?.address || resolvePromoterZone(promoterName, staffMembers) || 'Zulia').trim() ||
      'Zulia';
    const productName =
      String(s.product || c.product || c.producto || 'Portafolio Codizulca').trim() ||
      'Portafolio Codizulca';

    const parsedRating = toNum(s.rating ?? c.rating, NaN);
    const cleanRating =
      Number.isFinite(parsedRating) && parsedRating > 0
        ? +Math.min(5, Math.max(0, parsedRating)).toFixed(2)
        : null;

    const accRaw = String(c.acceptance || c.aceptacion || '').trim();
    const accLower = accRaw.toLowerCase();
    const isHighAcceptance = accLower.includes('alta') || (cleanRating !== null && cleanRating >= 4);
    const acceptanceLabel = isHighAcceptance
      ? 'ALTA'
      : accRaw
        ? accRaw.toUpperCase()
        : cleanRating !== null
          ? cleanRating >= 3
            ? 'MEDIA'
            : 'BAJA'
          : 'REGISTRADA';

    return {
      id: String(s.id || `srv_cons_${idx + 1}`),
      surveyType: s.type === 'Profunda' ? 'Profunda' : 'Breve',
      date: ymd,
      dayLabel: ymd ? formatDayLabelEs(ymd) : 'Sin Fecha',
      shift: inferShiftFromTime(String(c.shift || c.turno || c.time || ''), s.created_at || s.date),
      storeName,
      zone,
      promotora: promoterName || 'SIN ASIGNAR',
      productName,
      rating: cleanRating,
      highAcceptance: isHighAcceptance,
      acceptanceLabel,
      purchaseIntent: String(s.intent || s.purchase || c.intent || '').trim(),
      createdAt: s.created_at || undefined,
    };
  });

  const breveCount = consumerSurveys.filter((s) => s.surveyType === 'Breve').length;
  const profundaCount = consumerSurveys.filter((s) => s.surveyType === 'Profunda').length;
  const rated = consumerSurveys.filter((s): s is ConsumerSurveyRecord & { rating: number } => s.rating !== null && s.rating > 0);
  const avgRating =
    rated.length > 0
      ? +Math.min(5, Math.max(0, rated.reduce((acc, s) => acc + s.rating, 0) / rated.length)).toFixed(2)
      : 0;

  const highAcceptanceCount = consumerSurveys.filter((s) => s.highAcceptance).length;
  const highAcceptancePercent =
    consumerSurveys.length > 0
      ? Math.min(100, Math.max(0, Math.round((highAcceptanceCount / consumerSurveys.length) * 100)))
      : 0;

  return {
    tastingItems,
    visitsForSchedule,
    visitsHistory,
    priceComparisons,
    inventorySampling,
    attendanceRecords,
    asistenciaJornadas: asistenciaRelationalBundle.jornadas,
    asistenciaEvidencias: asistenciaRelationalBundle.evidencias,
    merchandisingRecords,
    staffMembers,
    consumerSurveys,
    surveySummary: {
      totalSurveys: consumerSurveys.length,
      breveCount,
      profundaCount,
      avgRating,
      highAcceptancePercent,
    },
    fetchedAt: new Date().toISOString(),
  };
}

// ============================================================================
// OPERACIONES EN TIEMPO REAL CONTRA SUPABASE (FOTO BAJO DEMANDA Y ACTUALIZACIONES)
// ============================================================================

export async function fetchCheckinPhotoById(checkinId: string): Promise<string | null> {
  const rows = await supabaseGet<Array<{ photoBase64?: string | null }>>(
    `checkins?id=eq.${encodeURIComponent(checkinId)}&select=photoBase64&limit=1`
  );
  return rows[0]?.photoBase64 || null;
}

export async function fetchCheckinPhotosBatch(checkinIds: string[]): Promise<Record<string, string>> {
  const uniqueIds = Array.from(new Set(checkinIds.filter(Boolean)));
  if (uniqueIds.length === 0) return {};
  const result: Record<string, string> = {};
  const chunkSize = 18;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const inList = chunk.map((id) => encodeURIComponent(id)).join(',');
    const rows = await supabaseGet<Array<{ id: string; photoBase64?: string | null }>>(
      `checkins?id=in.(${inList})&select=id,photoBase64`
    );
    rows.forEach((r) => {
      if (r.id && r.photoBase64) {
        result[r.id] = r.photoBase64;
      }
    });
  }
  return result;
}

// Evento local para puente instantáneo entre escrituras REST y hook Realtime (deduplicado por UUID)
export const DEGUSTACION_SURVEY_LOCAL_EVENT = 'codizulca:degustacion-survey-event';

function emitLocalDegustacionSurveyEvent(
  eventType: 'INSERT' | 'UPDATE',
  row: Partial<RawSupabaseSurvey> & { id: string }
): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(DEGUSTACION_SURVEY_LOCAL_EVENT, {
        detail: { eventType, row },
      })
    );
  }
}

/**
 * Parser determinístico que transforma cualquier fila de `public.surveys` (`type = 'Degustacion'`)
 * —ya provenga del fetch inicial REST o de un payload Realtime `INSERT` / `UPDATE`—
 * conservando el 100% de los campos enviados por el vendedor desde FDV Planificador sin pérdida ni truncamiento.
 */
export function parseDegustacionNotificationRow(
  row: Partial<RawSupabaseSurvey> | null | undefined,
  todayYmdOverride?: string
): DegustacionNotificationItem | null {
  if (!row || !row.id) return null;
  if (row.type && row.type !== 'Degustacion') return null;
  if (isSyntheticSurveyOrCheckinRow(row as RawSupabaseSurvey)) return null;

  const todayYmd = todayYmdOverride || getTodayVeYmd();
  const c = safeParseJson<Record<string, any>>(row.comments ?? {});
  const isFromSellerApp = isSellerOriginComments(c);
  const source = isFromSellerApp
    ? 'vendedor_app'
    : String(c.source || 'trade_marketing').trim();
  const canonicalDegId = normalizeCanonicalDegustacionId(c.degustacionId || c.id, String(row.id));

  const ymd = formatDateYmd(c.date || row.date || todayYmd);
  const createdAt = String(row.created_at || c.created_at || new Date().toISOString()).trim();
  const createdYmd = formatDateYmd(createdAt);
  const dayLabel = formatDayLabelEs(ymd);

  const rawTurnoToken = String(c.turno || '').trim().toUpperCase();
  const normalizedTurnoRaw =
    rawTurnoToken === 'MANANA'
      ? 'MAÑANA'
      : rawTurnoToken === 'COMPLETO'
        ? 'COMPLETO'
        : rawTurnoToken || undefined;
  const rawTurno = String(normalizedTurnoRaw || c.shift || c.time || '');
  const shift: ShiftType =
    normalizedTurnoRaw === 'COMPLETO' ? 'MAÑANA' : inferShiftFromTime(rawTurno, ymd);
  const timeRange = String(
    c.time ||
      c.shift ||
      (normalizedTurnoRaw === 'COMPLETO'
        ? 'Día Completo (09:00 AM - 07:00 PM)'
        : shift === 'MAÑANA'
          ? '09:00 AM - 01:00 PM'
          : '02:00 PM - 07:00 PM')
  ).trim();

  const address = String(c.address || '').trim();
  const { rutaFromAddress, contactoFromAddress, telefonoFromAddress } =
    extractAddressEmbeddedMetadata(address);

  const storeName = String(c.client || c.cliente || c.store || row.store || 'Cliente PDV').trim();
  const clienteCodigo = String(c.clienteCodigo || '').trim();
  const zone = String(c.ruta || c.zone || rutaFromAddress || address || 'Maracaibo / Zulia').trim();
  const contactoPunto = String(c.contactoPunto || contactoFromAddress || '').trim();
  const telefonoContacto = String(c.telefonoContacto || telefonoFromAddress || '').trim();

  const sellerName = String(
    c.vendedor || c.salesRep || row.promoter || row.creatorId || 'Vendedor FDV'
  ).trim();
  const vendedorId = c.vendedorId ? String(c.vendedorId).trim() : undefined;
  const promotoraAsignada = String(
    c.promotoraAsignada ||
      (!isFromSellerApp ? row.promoter : c.promoter) ||
      'POR ASIGNAR (Trade Marketing)'
  ).trim();

  const productsList: string[] = Array.isArray(c.products)
    ? c.products.map((p: unknown) => String(p || '').trim()).filter(Boolean)
    : String(c.products || c.product || row.product || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
  const productName = (
    productsList.join(', ') ||
    String(c.product || row.product || 'Portafolio Codizulca')
  ).trim();

  const resultadoObj = parseResultadoReport(c.resultado);
  const rawKilos = toNum(c.kilos ?? c.kg ?? c.quantity ?? resultadoObj?.kilosDegustados, 1);
  const requestedQty = Math.max(0.5, Math.round(rawKilos * 100) / 100);
  const targetSamples = Math.max(0, Math.round(toNum(c.personas ?? c.personasEstimadas, 0)));
  const estado = String(c.estado || c.status || 'SOLICITADA').trim().toUpperCase();

  const isTerminalEstado = isTerminalDegustacionEstado(estado);
  const localLedgerStamp = getLocalDegustacionReadStamp(String(row.id), canonicalDegId);

  // Evaluación exacta de leido_trade (ledger anti-resurrección + ciclo semanal < inicio_semana_actual + columna nativa SQL + respaldo JSON)
  const isArchivedInHistorial = isTastingInPastCaracasWeek(
    ymd,
    undefined,
    row.created_at || c.created_at
  );
  let leidoTrade: boolean;
  if (isArchivedInHistorial || localLedgerStamp || row.leido_trade === true || c.leido_trade === true) {
    leidoTrade = true;
  } else if (!isFromSellerApp || isTerminalEstado) {
    leidoTrade = true;
  } else if (typeof c.leido_trade === 'boolean') {
    leidoTrade = ymd < todayYmd && createdYmd < todayYmd ? true : c.leido_trade;
  } else if (typeof row.leido_trade === 'boolean') {
    leidoTrade = ymd < todayYmd && createdYmd < todayYmd ? true : row.leido_trade;
  } else {
    // Modo previo a ejecutar migración SQL: no leído solo si es solicitud FDV pendiente vigente o enviada hoy
    leidoTrade = !(ymd >= todayYmd || createdYmd >= todayYmd);
  }

  const vistoEnTradeAt =
    (row.visto_en_trade_at ? String(row.visto_en_trade_at) : null) ||
    (c.visto_en_trade_at ? String(c.visto_en_trade_at) : null) ||
    localLedgerStamp;

  return {
    id: String(row.id),
    degustacionId: canonicalDegId,
    source,
    createdAt,
    date: ymd,
    dayLabel,
    shift,
    turnoRaw: normalizedTurnoRaw,
    timeRange,
    storeName,
    clienteCodigo,
    zone,
    address,
    contactoPunto,
    telefonoContacto,
    sellerName,
    vendedorId,
    promotoraAsignada,
    requierePromotora: c.requierePromotora !== undefined ? Boolean(c.requierePromotora) : true,
    promoterType: String(
      c.promoterType || (c.requierePromotora === false ? 'Vendedor / Impulso' : 'Fija')
    ).trim(),
    materialPop: String(
      typeof c.materialPop === 'boolean' ? (c.materialPop ? 'SI' : 'NO') : c.materialPop || 'SI'
    ).trim(),
    productName,
    productsList: productsList.length > 0 ? productsList : [productName],
    requestedQty,
    targetSamples,
    estado,
    notes: String(c.observaciones || c.notes || c.originalComments || '').trim(),
    notasTradeMarketing: String(c.notasTradeMarketing || '').trim(),
    resultado: resultadoObj,
    leidoTrade,
    vistoEnTradeAt,
    rawComments: c,
  };
}

/**
 * Carga inicial exacta de todas las degustaciones sin leer (`leido_trade = false`),
 * ordenadas por `created_at` descendente. Usa el filtro SQL indexado cuando la columna
 * existe y cae automáticamente a filtrado JSON si la migración SQL aún no se ha aplicado.
 * Deduplica estrictamente por `id` y `degustacionId` canónico.
 */
export async function fetchUnreadDegustacionNotifications(options?: {
  signal?: AbortSignal;
}): Promise<DegustacionNotificationItem[]> {
  const signal = options?.signal;
  if (signal?.aborted) {
    const abortErr = new Error('Consulta de notificaciones cancelada.');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  assertSupabaseConfigured();
  const todayYmd = getTodayVeYmd();
  const client = getSupabaseRealtimeClient();
  if (!client) {
    throw new Error('Cliente oficial de Supabase no disponible.');
  }

  const renderFallbackRace = new Promise<RawSupabaseSurvey[]>((resolve, reject) => {
    const timer = setTimeout(() => resolve([]), 3000);
    const onAbort = () => {
      clearTimeout(timer);
      const abortErr = new Error('Consulta de notificaciones cancelada.');
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    fetchFdvPlanificadorRenderDegustaciones({
      endpointUrl: FDV_PLANIFICADOR_RENDER_API_URL,
      timeoutMs: 3000,
      signal,
    })
      .then((rows) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(rows);
      })
      .catch((err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          reject(err);
        } else {
          resolve([]);
        }
      });
  });

  const [allDegustacionRows, renderRows] = await Promise.all([
    fetchDegustacionSurveysViaSdk(client, { signal }),
    renderFallbackRace,
  ]);
  if (signal?.aborted) {
    const abortErr = new Error('Consulta de notificaciones cancelada.');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  const { mergedRows } = mergeSupabaseAndRenderDegustacionRows(allDegustacionRows, renderRows);

  // Si alguna fila gemela por el mismo `degustacionId` ya fue marcada como leída, excluir duplicados
  const readCanonicalIdsInBatch = new Set<string>();
  const parsedBatch: DegustacionNotificationItem[] = [];

  for (const row of mergedRows) {
    const parsed = parseDegustacionNotificationRow(row, todayYmd);
    if (!parsed) continue;
    if (parsed.leidoTrade) {
      if (parsed.degustacionId) readCanonicalIdsInBatch.add(parsed.degustacionId);
    } else {
      parsedBatch.push(parsed);
    }
  }

  const unreadByCanonicalKey = new Map<string, DegustacionNotificationItem>();
  for (const parsed of parsedBatch) {
    const canonicalKey = parsed.degustacionId || parsed.id;
    if (readCanonicalIdsInBatch.has(canonicalKey)) continue;
    if (!unreadByCanonicalKey.has(canonicalKey)) {
      unreadByCanonicalKey.set(canonicalKey, parsed);
    }
  }

  return Array.from(unreadByCanonicalKey.values()).sort((a, b) =>
    (b.createdAt || b.date).localeCompare(a.createdAt || a.date)
  );
}

async function resolveOrMaterializeDegustacionSurveyRow(
  surveyId: string,
  canonicalDegId: string,
  fallbackComments: Record<string, any>
): Promise<{ targetId: string | null; existingRow?: RawSupabaseSurvey }> {
  const client = getSupabaseRealtimeClient();
  if (!client) return { targetId: null };

  if (!isVirtualFdvRenderSurveyId(surveyId)) {
    return { targetId: surveyId };
  }

  if (canonicalDegId && /^[a-zA-Z0-9._-]+$/.test(canonicalDegId)) {
    const { data } = await client
      .from('surveys')
      .select('id,type,date,store,promoter,product,comments,creatorId,created_at')
      .eq('type', 'Degustacion')
      .ilike('comments', `%${canonicalDegId}%`)
      .limit(1);
    const matched = (data as unknown as RawSupabaseSurvey[] | null)?.[0];
    if (matched?.id) {
      return { targetId: matched.id, existingRow: matched };
    }
  }

  // Materializar en `public.surveys` si el registro existía solo en Render
  const dateYmd = formatDateYmd(fallbackComments.date) || getTodayVeYmd();
  const storeName = sanitizeFdvText(fallbackComments.client || fallbackComments.store, 180) || 'Cliente PDV';
  const promoterName =
    sanitizeFdvText(
      fallbackComments.promotoraAsignada || fallbackComments.vendedor || fallbackComments.promoter,
      140
    ) || 'Fuerza de Ventas';
  const productSummary =
    sanitizeFdvText(fallbackComments.product, 220) || 'Portafolio Codizulca';
  const createdAt = sanitizeFdvText(fallbackComments.created_at, 60) || new Date().toISOString();

  const insertBody: Record<string, unknown> = {
    type: 'Degustacion',
    date: dateYmd,
    store: storeName,
    promoter: promoterName,
    product: productSummary,
    comments: JSON.stringify(fallbackComments),
    creatorId: sanitizeFdvText(fallbackComments.vendedorId || fallbackComments.vendedor, 140) || promoterName,
    created_at: createdAt,
  };

  const { data: inserted } = await client
    .from('surveys')
    .insert(insertBody)
    .select('id,type,date,store,promoter,product,comments,creatorId,created_at')
    .limit(1);

  const createdRow = (inserted as unknown as RawSupabaseSurvey[] | null)?.[0];
  return { targetId: createdRow?.id || null, existingRow: createdRow };
}

async function patchDegustacionSurveyRowViaSdk(
  targetSurveyId: string,
  baseFields: Record<string, unknown>,
  readTimestampIso: string
): Promise<RawSupabaseSurvey | null> {
  const client = getSupabaseRealtimeClient();
  if (!client) {
    throw new Error('Cliente oficial de Supabase no disponible.');
  }

  const useReadCols = getSurveysLeidoTradeSupport() !== false;
  if (useReadCols) {
    const { data, error } = await client
      .from('surveys')
      .update({
        ...baseFields,
        leido_trade: true,
        visto_en_trade_at: readTimestampIso,
      })
      .eq('id', targetSurveyId)
      .select('id,type,date,store,promoter,product,comments,creatorId,created_at,leido_trade,visto_en_trade_at');

    if (!error) {
      setSurveysLeidoTradeSupport(true);
      return ((data as unknown as RawSupabaseSurvey[] | null) || [])[0] || null;
    }

    if (isMissingColumnPostgrestError(error)) {
      setSurveysLeidoTradeSupport(false);
    } else {
      throw new Error(`No se pudo actualizar la degustación en Supabase: ${error.message}`);
    }
  }

  const { data, error } = await client
    .from('surveys')
    .update(baseFields)
    .eq('id', targetSurveyId)
    .select('id,type,date,store,promoter,product,comments,creatorId,created_at');

  if (error) {
    throw new Error(`No se pudo actualizar la degustación en Supabase: ${error.message}`);
  }

  return ((data as unknown as RawSupabaseSurvey[] | null) || [])[0] || null;
}

/**
 * Marca una degustación específica como vista (`leido_trade: true`, `visto_en_trade_at: ISO`)
 * en Supabase, sincronizando tanto columnas nativas como `comments` JSON y el ledger local.
 */
export async function markSupabaseDegustacionAsRead(
  surveyId: string,
  existingRawComments?: Record<string, any>
): Promise<void> {
  if (!surveyId) return;
  assertSupabaseConfigured();
  const isoNow = new Date().toISOString();
  const client = getSupabaseRealtimeClient();

  let baseComments = existingRawComments ? safeParseJson<Record<string, any>>(existingRawComments) : undefined;
  let existingRow: RawSupabaseSurvey | undefined;

  if (!baseComments && client && !isVirtualFdvRenderSurveyId(surveyId)) {
    const { data } = await client
      .from('surveys')
      .select('id,type,date,store,promoter,product,comments,creatorId,created_at')
      .eq('id', surveyId)
      .limit(1);
    existingRow = ((data as unknown as RawSupabaseSurvey[] | null) || [])[0];
    baseComments = safeParseJson<Record<string, any>>(existingRow?.comments ?? {});
  }

  const canonicalDegId = normalizeCanonicalDegustacionId(
    baseComments?.degustacionId || baseComments?.id,
    surveyId
  );
  recordLocalDegustacionReadLedger(surveyId, canonicalDegId, isoNow);

  const updatedComments = {
    ...(baseComments || {}),
    leido_trade: true,
    visto_en_trade_at: isoNow,
  };

  if (isVirtualFdvRenderSurveyId(surveyId)) {
    emitLocalDegustacionSurveyEvent('UPDATE', {
      id: surveyId,
      type: 'Degustacion',
      leido_trade: true,
      visto_en_trade_at: isoNow,
      comments: JSON.stringify(updatedComments),
    });
    return;
  }

  const updatedRow = await patchDegustacionSurveyRowViaSdk(
    surveyId,
    { comments: JSON.stringify(updatedComments) },
    isoNow
  );

  emitLocalDegustacionSurveyEvent(
    'UPDATE',
    updatedRow || {
      ...(existingRow || {}),
      id: surveyId,
      type: 'Degustacion',
      leido_trade: true,
      visto_en_trade_at: isoNow,
      comments: JSON.stringify(updatedComments),
    }
  );
}

/**
 * Marca en lote todas las degustaciones pendientes como vistas en Supabase.
 */
export async function markAllSupabaseDegustacionesAsRead(
  items: DegustacionNotificationItem[]
): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return;
  await Promise.all(items.map((item) => markSupabaseDegustacionAsRead(item.id, item.rawComments)));
}

/**
 * Sincroniza bidireccionalmente el cambio de estado o asignación de promotora hacia el backend
 * desplegado de FDV Planificador en Render (`PUT /api/degustaciones/:id`) con validación HTTPS y timeout.
 */
async function syncStatusBackToFdvPlanificadorRender(
  canonicalDegId: string,
  payload: {
    estado: 'APROBADA' | 'RECHAZADA' | 'REALIZADA' | 'SOLICITADA';
    promotoraAsignada?: string;
    notasTradeMarketing?: string;
  }
): Promise<void> {
  await syncDecisionToFdvPlanificadorRender(canonicalDegId, payload, {
    endpointUrl: FDV_PLANIFICADOR_RENDER_API_URL,
    timeoutMs: 8000,
  });
}

export async function updateSupabaseDegustacionStatus(
  surveyId: string,
  updates: {
    estado: 'APROBADA' | 'NO_AUTORIZADA' | 'RECHAZADA' | 'CANCELADA' | 'EN_CURSO' | 'COMPLETADA';
    promotoraAsignada?: string;
    promotoraEmail?: string;
    delivered?: number;
    salesAssisted?: number;
    acceptanceRate?: number;
    insumosCalculados?: OperationalSupplies & {
      mortadelaQty?: number;
      espaldaQty?: number;
      arrozQty?: number;
      azucarGrams?: number;
      lecheGrams?: number;
    };
    rawComments?: Record<string, any>;
    eventDateYmd?: string;
    isStrictAdmin?: boolean;
  }
): Promise<void> {
  assertSupabaseConfigured();
  const safeBaseComments = safeParseJson<Record<string, any>>(updates.rawComments ?? {});
  assertCanMutateTastingByWeekCycle({
    eventDate: updates.eventDateYmd || safeBaseComments.date || safeBaseComments.fecha,
    fallbackDate: safeBaseComments.created_at,
    isStrictAdmin: Boolean(updates.isStrictAdmin),
    allowMarkNoAutorizada: updates.estado === 'NO_AUTORIZADA',
  });
  const isoNow = new Date().toISOString();
  const canonicalDegId = normalizeCanonicalDegustacionId(
    safeBaseComments.degustacionId || safeBaseComments.id,
    surveyId
  );
  recordLocalDegustacionReadLedger(surveyId, canonicalDegId, isoNow);

  const cleanPromotora =
    updates.promotoraAsignada !== undefined
      ? sanitizeFdvText(updates.promotoraAsignada, 140)
      : undefined;
  const cleanPromotoraEmail =
    updates.promotoraEmail !== undefined
      ? sanitizeFdvText(updates.promotoraEmail, 160).toLowerCase()
      : undefined;

  const updatedComments = {
    ...safeBaseComments,
    estado: updates.estado,
    status: updates.estado.toLowerCase(),
    leido_trade: true,
    visto_en_trade_at: safeBaseComments.visto_en_trade_at || isoNow,
    ...(updates.estado === 'APROBADA' ? { aprobadoEnTradeAt: isoNow } : {}),
    ...(updates.estado === 'NO_AUTORIZADA' ||
    updates.estado === 'RECHAZADA' ||
    updates.estado === 'CANCELADA'
      ? { revertidoEnTradeAt: isoNow, en_historial: true }
      : {}),
    ...(cleanPromotora !== undefined
      ? {
          promotoraAsignada: cleanPromotora,
          promoter: cleanPromotora || 'POR ASIGNAR (Trade Marketing)',
        }
      : {}),
    ...(cleanPromotoraEmail ? { promotoraEmail: cleanPromotoraEmail } : {}),
    ...(updates.delivered !== undefined ? { delivered: updates.delivered } : {}),
    ...(updates.salesAssisted !== undefined ? { salesAssisted: updates.salesAssisted } : {}),
    ...(updates.acceptanceRate !== undefined ? { acceptanceRate: updates.acceptanceRate } : {}),
    ...(updates.insumosCalculados !== undefined ? { insumosCalculados: updates.insumosCalculados } : {}),
  };

  const resolved = await resolveOrMaterializeDegustacionSurveyRow(
    surveyId,
    canonicalDegId,
    updatedComments
  );

  let updatedRow: RawSupabaseSurvey | null = null;
  if (resolved.targetId) {
    updatedRow = await patchDegustacionSurveyRowViaSdk(
      resolved.targetId,
      {
        ...(cleanPromotora ? { promoter: cleanPromotora } : {}),
        comments: JSON.stringify(updatedComments),
      },
      String(updatedComments.visto_en_trade_at)
    );
  }

  emitLocalDegustacionSurveyEvent(
    'UPDATE',
    updatedRow || {
      ...(resolved.existingRow || {}),
      id: resolved.targetId || surveyId,
      type: 'Degustacion',
      leido_trade: true,
      visto_en_trade_at: String(updatedComments.visto_en_trade_at),
      comments: JSON.stringify(updatedComments),
    }
  );

  // Sincronización bidireccional no bloqueante hacia FDV Planificador (Render)
  const fdvEstado =
    updates.estado === 'COMPLETADA'
      ? 'REALIZADA'
      : updates.estado === 'EN_CURSO'
        ? 'APROBADA'
        : updates.estado === 'NO_AUTORIZADA' || updates.estado === 'CANCELADA'
          ? 'RECHAZADA'
          : updates.estado;
  void syncStatusBackToFdvPlanificadorRender(canonicalDegId, {
    estado: fdvEstado,
    promotoraAsignada: cleanPromotora,
    notasTradeMarketing:
      updates.estado === 'APROBADA' && cleanPromotora
        ? `Aprobada en Trade Marketing. Promotora asignada: ${cleanPromotora}.`
        : undefined,
  });
}

/**
 * Asigna o reasigna de forma segura una promotora activa (o `'POR ASIGNAR (Trade Marketing)'`)
 * a una degustación en `public.surveys` y sincroniza con el backend FDV en Render sin alterar el estado actual.
 */
export async function assignSupabaseDegustacionPromotora(
  surveyId: string,
  promotoraAsignada: string,
  rawComments?: Record<string, any>,
  options?: { eventDateYmd?: string; isStrictAdmin?: boolean }
): Promise<void> {
  if (!surveyId) return;
  assertSupabaseConfigured();
  const safeBaseComments = safeParseJson<Record<string, any>>(rawComments ?? {});
  assertCanMutateTastingByWeekCycle({
    eventDate: options?.eventDateYmd || safeBaseComments.date || safeBaseComments.fecha,
    fallbackDate: safeBaseComments.created_at,
    isStrictAdmin: Boolean(options?.isStrictAdmin),
  });
  const isoNow = new Date().toISOString();
  const canonicalDegId = normalizeCanonicalDegustacionId(
    safeBaseComments.degustacionId || safeBaseComments.id,
    surveyId
  );
  recordLocalDegustacionReadLedger(surveyId, canonicalDegId, isoNow);

  const cleanPromotora =
    sanitizeFdvText(promotoraAsignada, 140) || 'POR ASIGNAR (Trade Marketing)';
  const isUnassigned = /^POR ASIGNAR/i.test(cleanPromotora) || /^SIN ASIGNAR/i.test(cleanPromotora);
  const currentEstadoUpper =
    sanitizeFdvText(safeBaseComments.estado || safeBaseComments.status, 40).toUpperCase() ||
    'SOLICITADA';

  const updatedComments = {
    ...safeBaseComments,
    promotoraAsignada: isUnassigned ? '' : cleanPromotora,
    promoter: cleanPromotora,
    leido_trade: true,
    visto_en_trade_at: safeBaseComments.visto_en_trade_at || isoNow,
  };

  const resolved = await resolveOrMaterializeDegustacionSurveyRow(
    surveyId,
    canonicalDegId,
    updatedComments
  );

  let updatedRow: RawSupabaseSurvey | null = null;
  if (resolved.targetId) {
    updatedRow = await patchDegustacionSurveyRowViaSdk(
      resolved.targetId,
      {
        ...(!isUnassigned ? { promoter: cleanPromotora } : {}),
        comments: JSON.stringify(updatedComments),
      },
      String(updatedComments.visto_en_trade_at)
    );
  }

  emitLocalDegustacionSurveyEvent(
    'UPDATE',
    updatedRow || {
      ...(resolved.existingRow || {}),
      id: resolved.targetId || surveyId,
      type: 'Degustacion',
      leido_trade: true,
      visto_en_trade_at: String(updatedComments.visto_en_trade_at),
      comments: JSON.stringify(updatedComments),
    }
  );

  const fdvEstado: 'APROBADA' | 'RECHAZADA' | 'REALIZADA' | 'SOLICITADA' =
    currentEstadoUpper === 'COMPLETADA' || currentEstadoUpper === 'REALIZADA'
      ? 'REALIZADA'
      : currentEstadoUpper === 'APROBADA' ||
          currentEstadoUpper === 'PROGRAMADA' ||
          currentEstadoUpper === 'EN_CURSO'
        ? 'APROBADA'
        : currentEstadoUpper === 'RECHAZADA' || currentEstadoUpper === 'CANCELADA'
          ? 'RECHAZADA'
          : 'SOLICITADA';

  void syncStatusBackToFdvPlanificadorRender(canonicalDegId, {
    estado: fdvEstado,
    promotoraAsignada: isUnassigned ? '' : cleanPromotora,
  });
}

// Registro en memoria para blindar idempotencia ante doble clic o reintentos concurrentes
const inFlightDegustacionTokens = new Set<string>();

export interface CreateSellerDegustacionParams {
  degustacionId?: string;
  sellerName: string;
  storeName: string;
  clienteCodigo?: string;
  zone: string;
  address?: string;
  contactoPunto?: string;
  telefonoContacto?: string;
  productName: string;
  productsList?: string[];
  date: string;
  turno?: ShiftType;
  timeRange: string;
  kilos: number;
  personas: number;
  requierePromotora?: boolean;
  promoterType?: 'Fija' | 'Eventual';
  materialPop?: 'SI' | 'NO';
  notes: string;
  notasTradeMarketing?: string;
}

export async function createSupabaseSellerDegustacionRequest(
  params: CreateSellerDegustacionParams
): Promise<RawSupabaseSurvey> {
  assertSupabaseConfigured();
  const sellerName = sanitizeFdvText(params.sellerName, 140);
  const storeName = sanitizeFdvText(params.storeName, 180);
  const zone = sanitizeFdvText(params.zone, 180);
  const productName = sanitizeFdvText(params.productName, 220);
  const date = normalizeFdvCalendarDateYmd(params.date);
  const timeRange = sanitizeFdvText(params.timeRange, 80);
  const kilos = Math.round(Number(params.kilos) * 100) / 100;
  const personas = Math.round(Number(params.personas));

  // Validación estricta de integridad antes de abrir transacción
  if (!sellerName) throw new Error('El nombre del vendedor solicitante es obligatorio.');
  if (!storeName) throw new Error('El nombre del cliente / PDV es obligatorio.');
  if (!zone) throw new Error('La ruta o zona comercial es obligatoria.');
  if (!productName) throw new Error('El producto a degustar es obligatorio.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('La fecha programada debe tener formato válido YYYY-MM-DD.');
  }
  if (!timeRange) throw new Error('El turno u horario propuesto es obligatorio.');
  if (!Number.isFinite(kilos) || kilos <= 0) {
    throw new Error('La cantidad de kilos / unidades debe ser mayor a 0.');
  }
  if (!Number.isFinite(personas) || personas <= 0) {
    throw new Error('El estimado de personas / muestras debe ser mayor a 0.');
  }

  const degustacionId = normalizeCanonicalDegustacionId(
    (params.degustacionId && params.degustacionId.trim()) ||
      `deg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  );

  if (inFlightDegustacionTokens.has(degustacionId)) {
    throw new Error('Esta solicitud de degustación ya se está enviando. Por favor espere la confirmación.');
  }

  const client = getSupabaseRealtimeClient();
  if (!client) {
    throw new Error('Cliente oficial de Supabase no disponible.');
  }

  inFlightDegustacionTokens.add(degustacionId);
  try {
    // Verificación de idempotencia vía SDK oficial parametrizado para evitar duplicados ante reintentos de red
    if (/^[a-zA-Z0-9._-]+$/.test(degustacionId)) {
      const { data: existingDup } = await client
        .from('surveys')
        .select('id,type,date,store,promoter,product,comments,creatorId,created_at')
        .eq('type', 'Degustacion')
        .ilike('comments', `%${degustacionId}%`)
        .limit(1);
      const dupRow = ((existingDup as unknown as RawSupabaseSurvey[] | null) || [])[0];
      if (dupRow?.id) {
        return dupRow;
      }
    }

    const isoNow = new Date().toISOString();
    const turno: ShiftType =
      params.turno ||
      (timeRange.toUpperCase().includes('TARDE') ||
      (timeRange.toUpperCase().includes('PM') &&
        !timeRange.trim().startsWith('09') &&
        !timeRange.trim().startsWith('08'))
        ? 'TARDE'
        : 'MAÑANA');

    const productsArray =
      Array.isArray(params.productsList) && params.productsList.length > 0
        ? params.productsList.map((p) => sanitizeFdvText(p, 120)).filter(Boolean)
        : [productName];

    const clienteCodigo = sanitizeFdvText(params.clienteCodigo, 60);
    const contactoPunto = sanitizeFdvText(params.contactoPunto, 140);
    const telefonoContacto = sanitizeFdvText(params.telefonoContacto, 60);
    const address =
      sanitizeFdvText(params.address, 260) ||
      `Ruta: ${zone}${contactoPunto ? ` | Contacto: ${contactoPunto}${telefonoContacto ? ` (${telefonoContacto})` : ''}` : ''}`;
    const requierePromotora = params.requierePromotora !== undefined ? Boolean(params.requierePromotora) : true;
    const promoterType = params.promoterType || 'Fija';
    const materialPop = params.materialPop || 'SI';
    const cleanNotes = sanitizeFdvText(params.notes, 600);
    const notasTradeMarketing =
      sanitizeFdvText(params.notasTradeMarketing, 500) ||
      'Solicitud agendada desde FDV. Pendiente de revisión y asignación en Trade Marketing.';

    // Payload íntegro 100% compatible con los 35+ campos de FDV Planificador + trazabilidad de lectura
    const commentsPayload = {
      isTasting: true,
      source: 'vendedor_app',
      degustacionId,
      id: degustacionId,
      client: storeName,
      cliente: storeName,
      clienteCodigo,
      store: storeName,
      vendedor: sellerName,
      salesRep: sellerName,
      promoter: 'POR ASIGNAR (Trade Marketing)',
      promotoraAsignada: '',
      ruta: zone,
      date,
      turno,
      shift: `${turno} (${timeRange})`,
      time: timeRange,
      products: productsArray,
      product: productName,
      kilos,
      kg: kilos,
      personas,
      personasEstimadas: personas,
      estado: 'SOLICITADA',
      status: 'pendiente',
      leido_trade: false,
      visto_en_trade_at: null,
      en_historial: false,
      archivado_en: null,
      motivo_archivo: null,
      created_at: isoNow,
      requierePromotora,
      promoterType,
      materialPop,
      contactoPunto,
      telefonoContacto,
      address,
      notes: cleanNotes || `Agendada por ${sellerName}. Kilos: ${kilos}. Personas: ${personas}.`,
      originalComments: cleanNotes,
      observaciones: cleanNotes,
      notasTradeMarketing,
      resultado: null,
      delivered: 0,
      acceptanceRate: 95,
    };

    const baseBody: Record<string, unknown> = {
      type: 'Degustacion',
      date,
      store: storeName,
      promoter: sellerName,
      product: productName,
      comments: JSON.stringify(commentsPayload),
      creatorId: sellerName,
      created_at: isoNow,
    };

    let createdRow: RawSupabaseSurvey | undefined;
    const useArchiveCols =
      getSurveysArchiveColumnsSupport() !== false && getSurveysLeidoTradeSupport() !== false;
    const useReadCols = getSurveysLeidoTradeSupport() !== false;

    if (useArchiveCols) {
      const { data, error } = await client
        .from('surveys')
        .insert({
          ...baseBody,
          leido_trade: false,
          visto_en_trade_at: null,
          en_historial: false,
          archivado_en: null,
          motivo_archivo: null,
        })
        .select(
          'id,type,date,store,promoter,product,comments,creatorId,created_at,leido_trade,visto_en_trade_at,en_historial,archivado_en,motivo_archivo'
        )
        .limit(1);

      if (!error) {
        setSurveysArchiveColumnsSupport(true);
        setSurveysLeidoTradeSupport(true);
        createdRow = ((data as unknown as RawSupabaseSurvey[] | null) || [])[0];
      } else if (isMissingColumnPostgrestError(error)) {
        setSurveysArchiveColumnsSupport(false);
      } else {
        throw new Error(`No se pudo crear la solicitud en Supabase: ${error.message}`);
      }
    }

    if (!createdRow && useReadCols) {
      const { data, error } = await client
        .from('surveys')
        .insert({
          ...baseBody,
          leido_trade: false,
          visto_en_trade_at: null,
        })
        .select('id,type,date,store,promoter,product,comments,creatorId,created_at,leido_trade,visto_en_trade_at')
        .limit(1);

      if (!error) {
        setSurveysLeidoTradeSupport(true);
        createdRow = ((data as unknown as RawSupabaseSurvey[] | null) || [])[0];
      } else if (isMissingColumnPostgrestError(error)) {
        setSurveysLeidoTradeSupport(false);
      } else {
        throw new Error(`No se pudo crear la solicitud en Supabase: ${error.message}`);
      }
    }

    if (!createdRow && getSurveysLeidoTradeSupport() === false) {
      const { data, error } = await client
        .from('surveys')
        .insert(baseBody)
        .select('id,type,date,store,promoter,product,comments,creatorId,created_at')
        .limit(1);

      if (error) {
        throw new Error(`No se pudo crear la solicitud en Supabase: ${error.message}`);
      }
      createdRow = ((data as unknown as RawSupabaseSurvey[] | null) || [])[0];
    }

    // Confirmación Real (ACK): si PostgREST no adjuntó la representación, verificar persistencia por degustacionId
    if (!createdRow || !createdRow.id) {
      const { data: verifyRows } = await client
        .from('surveys')
        .select('id,type,date,store,promoter,product,comments,creatorId,created_at')
        .eq('type', 'Degustacion')
        .ilike('comments', `%${degustacionId}%`)
        .limit(1);
      createdRow = ((verifyRows as unknown as RawSupabaseSurvey[] | null) || [])[0];
    }

    if (!createdRow || !createdRow.id) {
      throw new Error('Supabase no devolvió confirmación real (ACK con id) del registro insertado.');
    }

    emitLocalDegustacionSurveyEvent('INSERT', createdRow);
    return createdRow;
  } finally {
    inFlightDegustacionTokens.delete(degustacionId);
  }
}

export async function updateSupabaseInventoryObservation(
  inventoryId: string,
  comments: string
): Promise<void> {
  const res = await supabaseFetch(`${SUPABASE_REST_URL}/inventory?id=eq.${encodeURIComponent(inventoryId)}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ comments: comments.trim() }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`No se pudo actualizar la observación de inventario (${res.status}): ${text}`);
  }
}

export async function createSupabaseInventoryRecord(params: {
  date: string;
  storeName: string;
  promoterName: string;
  productName: string;
  initialQuantity: number;
  finalQuantity: number;
  degustations: number;
  comments: string;
  region?: 'Occidente' | 'Valencia' | 'Centro' | 'Andes';
}): Promise<RawSupabaseInventory | null> {
  const res = await supabaseFetch(`${SUPABASE_REST_URL}/inventory`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({
      date: params.date,
      store: params.storeName,
      promoter: params.promoterName,
      creatorId: params.promoterName,
      product: params.productName,
      initialQuantity: params.initialQuantity,
      finalQuantity: params.finalQuantity,
      degustations: params.degustations,
      comments: params.comments.trim(),
      region: params.region ?? 'Occidente',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`No se pudo crear el balance de inventario en Supabase (${res.status}): ${text}`);
  }
  const data = (await res.json()) as RawSupabaseInventory[];
  return data[0] || null;
}

export async function deleteSupabaseInventoryRecord(inventoryId: string): Promise<void> {
  const res = await supabaseFetch(`${SUPABASE_REST_URL}/inventory?id=eq.${encodeURIComponent(inventoryId)}`, {
    method: 'DELETE',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`No se pudo eliminar el balance de inventario en Supabase (${res.status}): ${text}`);
  }
}

export async function deleteSupabaseMerchandisingRecord(surveyId: string): Promise<void> {
  const res = await supabaseFetch(`${SUPABASE_REST_URL}/surveys?id=eq.${encodeURIComponent(surveyId)}`, {
    method: 'DELETE',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`No se pudo eliminar el acta de merchandising en Supabase (${res.status}): ${text}`);
  }
}

function mapStaffCategoryToPromotoraCategoria(
  category: StaffCategory
): 'Fijas' | 'Eventuales' | 'Merchandising' {
  if (category === 'merchandising') return 'Merchandising';
  if (category === 'eventual') return 'Eventuales';
  return 'Fijas';
}

export async function saveSupabaseStaffMember(params: {
  id?: string;
  name: string;
  role: string;
  category: StaffCategory;
  email: string;
  phone: string;
  address: string;
  assignedStore: string;
  status: 'Activo' | 'Inactivo';
  password?: string;
  photoUrl?: string;
  region?: 'Occidente' | 'Valencia' | 'Centro' | 'Andes';
  regionId?: string | null;
}): Promise<{ id: string }> {
  const cleanId = String(params.id || '').trim();
  const isExistingRow = Boolean(cleanId && !cleanId.startsWith('stf_'));
  const isNumericPromotoraId = isExistingRow && /^\d+$/.test(cleanId);
  const cleanPassword = (params.password || '').trim();
  if (!cleanPassword && !isExistingRow) {
    throw new Error('Debe definir una contraseña inicial (mínimo 8 caracteres) para aprovisionar la cuenta en Supabase Auth.');
  }

  const persistInPromotorasCatalog = async (): Promise<{ id: string }> => {
    const saved = await guardarPromotoraMaestra({
      id: isExistingRow ? cleanId : undefined,
      nombre_completo: String(params.name || '').trim(),
      email: String(params.email || '').trim().toLowerCase() || null,
      telefono: String(params.phone || '').trim() || null,
      direccion: String(params.address || '').trim() || null,
      ciudad: String(params.address || '').trim() || null,
      categoria: mapStaffCategoryToPromotoraCategoria(params.category),
      activo: params.status === 'Activo',
      ...(params.region ? { region: params.region } : {}),
      ...(params.regionId ? { region_id: params.regionId } : {}),
    });
    return { id: String(saved.id) };
  };

  // Las tarjetas reales del padrón provienen de `public.promotoras` (IDs numéricos):
  // actualizar directamente en `public.promotoras` evitando llamadas 404 a `public.staff`.
  if (isNumericPromotoraId) {
    return persistInPromotorasCatalog();
  }

  // Seguridad Zero Trust: jamás persistir contraseñas en texto plano dentro de public.staff.status
  const statusPayload: Record<string, unknown> = {
    status: params.status,
    category: params.category,
    phone: String(params.phone || '').trim(),
    address: String(params.address || '').trim(),
    assignedLocation: String(params.assignedStore || '').trim(),
    ...(params.photoUrl ? { photoUrl: params.photoUrl } : {}),
  };

  const bodyPayload = {
    name: String(params.name || '').trim(),
    role: params.category === 'merchandising' ? 'Promotor Merchandising' : String(params.role || '').trim() || 'Promotora',
    email: String(params.email || '').trim(),
    status: JSON.stringify(statusPayload),
  };

  const endpoint = isExistingRow
    ? `${SUPABASE_REST_URL}/staff?id=eq.${encodeURIComponent(cleanId)}`
    : `${SUPABASE_REST_URL}/staff`;

  const res = await supabaseFetch(endpoint, {
    method: isExistingRow ? 'PATCH' : 'POST',
    headers: supabaseHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(bodyPayload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 404 || isMissingTablePostgrestError(res.status, text)) {
      return persistInPromotorasCatalog();
    }
    console.error('[saveSupabaseStaffMember] Error guardando en public.staff', {
      status: res.status,
      body: text,
      id: cleanId || null,
    });
    throw new Error(
      res.status === 403 || /42501|row-level security|permission denied/i.test(text)
        ? 'Permiso denegado por RLS al guardar el perfil en Supabase. Verifica tu rol y políticas.'
        : `No se pudo guardar el perfil de personal en Supabase (${res.status}): ${text}`
    );
  }

  const rows = (await res.json().catch(() => [])) as Array<{ id?: string }>;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Si la tabla `staff` devolvió 0 filas pero el registro existe en `promotoras`, intentar respaldo explícito
    if (isExistingRow) {
      try {
        return await persistInPromotorasCatalog();
      } catch {
        // Reportar error real de 0 filas afectadas
      }
    }
    console.error('[saveSupabaseStaffMember] 0 filas afectadas al guardar en public.staff (posible RLS)', {
      id: cleanId || null,
    });
    throw new Error(
      'No se guardaron los cambios en Supabase (0 filas afectadas). Verifica permisos RLS o que el perfil exista.'
    );
  }

  const savedId = String(rows[0]?.id || cleanId || '').trim();
  return { id: savedId };
}

export async function updateSupabaseStaffPhoto(
  staffMember: StaffMemberRecord,
  photoBase64: string
): Promise<void> {
  await saveSupabaseStaffMember({
    id: staffMember.id,
    name: staffMember.name,
    role: staffMember.role,
    category: staffMember.category,
    email: staffMember.email,
    phone: staffMember.phone,
    address: staffMember.address,
    assignedStore: staffMember.assignedStore,
    status: staffMember.status,
    password: staffMember.password,
    photoUrl: photoBase64,
  });
}

export async function deleteSupabaseStaffMember(staffId: string, staffName?: string): Promise<void> {
  const cleanId = String(staffId || '').trim();
  if (/^\d+$/.test(cleanId)) {
    await cambiarEstadoPromotoraMaestra(cleanId, false);
    return;
  }

  if (cleanId && !cleanId.startsWith('stf_')) {
    const res = await supabaseFetch(`${SUPABASE_REST_URL}/staff?id=eq.${encodeURIComponent(cleanId)}`, {
      method: 'DELETE',
      headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404 || isMissingTablePostgrestError(res.status, text)) {
        await cambiarEstadoPromotoraMaestra(cleanId, false);
        return;
      }
      throw new Error(`No se pudo eliminar el perfil de personal en Supabase (${res.status}): ${text}`);
    }
  }
  if (staffName && staffName.trim()) {
    await supabaseFetch(`${SUPABASE_REST_URL}/staff?name=eq.${encodeURIComponent(staffName.trim())}`, {
      method: 'DELETE',
      headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    }).catch(() => {});
  }
}
