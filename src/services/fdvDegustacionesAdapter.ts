import type { SupabaseClient } from '@supabase/supabase-js';
import type { DegustacionResultadoReport, ShiftType } from '../types';
import { normalizeExcelDate } from '../utils/excelDateNormalizer';
import { isDangerousObjectKey } from '../utils/excelDateParser';
import { assertSupabaseConfigured, getSupabaseRealtimeClient } from './supabaseClient';
import type { RawSupabaseSurvey } from './supabaseModule1';

/**
 * Origen oficial en producción de la aplicación Fuerza de Ventas (FDV Planificador).
 */
export const DEFAULT_FDV_RENDER_ORIGIN = 'https://dashboard-fdv-planificador.onrender.com';
export const DEFAULT_FDV_RENDER_API_URL = `${DEFAULT_FDV_RENDER_ORIGIN}/api/degustaciones`;
export const FDV_RENDER_VIRTUAL_ID_PREFIX = 'fdv-render:';

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_JSON_CLONE_DEPTH = 12;

export interface RawFdvRenderDegustacion {
  id: string;
  clienteCodigo?: string | null;
  clienteNombre?: string | null;
  cliente?: string | null;
  client?: string | null;
  vendedorNombre?: string | null;
  vendedor?: string | null;
  vendedorId?: string | null;
  ruta?: string | null;
  fecha?: string | null;
  date?: string | null;
  turno?: string | null;
  hora?: string | null;
  productos?: string[] | string | null;
  kilosEstimados?: number | string | null;
  kilos?: number | string | null;
  personasEstimadas?: number | string | null;
  personas?: number | string | null;
  requierePromotora?: boolean | null;
  promotoraAsignada?: string | null;
  materialPop?: boolean | string | null;
  contactoPunto?: string | null;
  telefonoContacto?: string | null;
  observaciones?: string | null;
  estado?: string | null;
  notasTradeMarketing?: string | null;
  resultado?: DegustacionResultadoReport | Record<string, unknown> | null;
  createdAt?: string | null;
  created_at?: string | null;
}

export interface FdvLifecycleInput {
  rawEstado: unknown;
  isFromSellerApp: boolean;
  ymd: string;
  todayYmd: string;
  aprobadoYmd?: string;
  manuallyArchived?: boolean;
  enHistorial?: boolean;
}

export type CanonicalFdvEstado =
  | 'SOLICITADA'
  | 'APROBADA'
  | 'NO_AUTORIZADA'
  | 'EN_CURSO'
  | 'COMPLETADA'
  | 'RECHAZADA'
  | 'CANCELADA';

export interface FdvLifecycleResolution {
  canonicalEstado: CanonicalFdvEstado;
  uiStatus: 'PENDIENTE' | 'PROGRAMADO' | 'EN_CURSO' | 'COMPLETADO' | 'NO_AUTORIZADA';
  isArchived: boolean;
  enHistorial: boolean;
  isRejectedOrCancelled: boolean;
  isNotAuthorized: boolean;
  isOverduePending: boolean;
  isEligibleForModule2: boolean;
}

// ============================================================================
// CACHÉ EN MEMORIA DE CAPACIDADES DE ESQUEMA (CERO ERRORES 400 / 404 REPETIDOS)
// ============================================================================

let surveysLeidoTradeColumnSupported: boolean | null = null;
let surveysArchiveColumnsSupported: boolean | null = null;
let cronogramaTableSupported: boolean | null = null;

export function getSurveysLeidoTradeSupport(): boolean | null {
  return surveysLeidoTradeColumnSupported;
}

export function setSurveysLeidoTradeSupport(supported: boolean): void {
  surveysLeidoTradeColumnSupported = supported;
}

export function getSurveysArchiveColumnsSupport(): boolean | null {
  return surveysArchiveColumnsSupported;
}

export function setSurveysArchiveColumnsSupport(supported: boolean): void {
  surveysArchiveColumnsSupported = supported;
}

export function getCronogramaTableSupport(): boolean | null {
  return cronogramaTableSupported;
}

export function setCronogramaTableSupport(supported: boolean): void {
  cronogramaTableSupported = supported;
}

export function resetFdvSchemaCapabilitiesCache(): void {
  surveysLeidoTradeColumnSupported = null;
  surveysArchiveColumnsSupported = null;
  cronogramaTableSupported = null;
}

export function isMissingColumnPostgrestError(errorOrMessage: unknown): boolean {
  if (!errorOrMessage) return false;
  const pattern =
    /leido_trade|visto_en_trade_at|en_historial|archivado_en|motivo_archivo|PGRST204|42703/i;
  if (typeof errorOrMessage === 'string') {
    return pattern.test(errorOrMessage);
  }
  if (typeof errorOrMessage === 'object') {
    const err = errorOrMessage as { code?: string; message?: string; details?: string; hint?: string };
    const combined = `${err.code || ''} ${err.message || ''} ${err.details || ''} ${err.hint || ''}`;
    return pattern.test(combined);
  }
  return false;
}

export function isMissingTablePostgrestError(statusOrCode: number | string, message = ''): boolean {
  if (statusOrCode === 404 || statusOrCode === 'PGRST205' || statusOrCode === '42P01') {
    return true;
  }
  return /PGRST205|42P01|could not find the table|relation\s+["']?[^"']+["']?\s+does not exist|cronograma_degustaciones/i.test(
    message
  );
}

// ============================================================================
// SEGURIDAD: SANITIZACIÓN, ANTI-PROTOTYPE POLLUTION Y VALIDACIÓN HTTPS
// ============================================================================

export function sanitizeFdvText(input: unknown, maxLength = 300): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string' && typeof input !== 'number' && typeof input !== 'boolean') {
    return '';
  }
  const clean = String(input)
    .replace(CONTROL_CHARS_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLength ? clean.slice(0, maxLength).trim() : clean;
}

export function sanitizeExternalHttpsUrl(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== 'string') return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      return undefined;
    }
    if (parsed.username || parsed.password) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function validateFdvRenderEndpoint(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed.length > 512) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;

    const configuredEnvUrl = (
      (import.meta as unknown as { env?: Record<string, string | undefined> })?.env
        ?.VITE_FDV_PLANIFICADOR_API_URL || ''
    ).trim();

    let allowedConfiguredOrigin: string | null = null;
    if (configuredEnvUrl) {
      try {
        const envParsed = new URL(configuredEnvUrl);
        if (envParsed.protocol === 'https:' && !envParsed.username && !envParsed.password) {
          allowedConfiguredOrigin = envParsed.origin;
        }
      } catch {
        allowedConfiguredOrigin = null;
      }
    }

    if (
      parsed.origin !== DEFAULT_FDV_RENDER_ORIGIN &&
      (!allowedConfiguredOrigin || parsed.origin !== allowedConfiguredOrigin)
    ) {
      return null;
    }

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function stripPrototypePollutionDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_JSON_CLONE_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripPrototypePollutionDeep(item, depth + 1)) as unknown as T;
  }
  const cleanObj: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (isDangerousObjectKey(key)) continue;
    cleanObj[key] = stripPrototypePollutionDeep(entryValue, depth + 1);
  }
  return cleanObj as T;
}

export function safeJsonParseObject<T extends Record<string, any> = Record<string, any>>(
  input: unknown
): T {
  if (!input) return {} as T;
  if (typeof input === 'object' && !Array.isArray(input)) {
    return stripPrototypePollutionDeep(input) as T;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return {} as T;
    try {
      const parsed = JSON.parse(trimmed, (key, val) => {
        if (isDangerousObjectKey(key)) return undefined;
        return val;
      });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return stripPrototypePollutionDeep(parsed) as T;
      }
      return { originalComments: sanitizeFdvText(trimmed, 1000) } as unknown as T;
    } catch {
      return { originalComments: sanitizeFdvText(trimmed, 1000) } as unknown as T;
    }
  }
  return {} as T;
}

// ============================================================================
// ZONA HORARIA SEGURA (UTC PURO PARA FECHAS CALENDARIO / UTC-4 PARA TIMESTAMPS)
// ============================================================================

export function normalizeFdvCalendarDateYmd(rawDate: unknown): string {
  if (rawDate === null || rawDate === undefined) return '';
  const trimmed = String(rawDate).trim();
  if (!trimmed) return '';

  // Si incluye hora explícita distinta de medianoche UTC (ej. created_at ISO), ajustar a America/Caracas (UTC-4)
  if (
    /^\d{4}-\d{2}-\d{2}[T\s](?!00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?$)\d{2}:\d{2}/i.test(
      trimmed
    ) &&
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  ) {
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) {
      const ve = new Date(d.getTime() - 4 * 60 * 60 * 1000);
      return ve.toISOString().slice(0, 10);
    }
  }

  // Fechas calendario ('2026-11-06', '2026-11-06T00:00:00.000Z', '06/11/2026'): UTC puro sin restar 1 día
  return normalizeExcelDate(trimmed).fechaIso ?? '';
}

export function normalizeCanonicalFdvId(rawId?: unknown, fallbackSurveyId?: string): string {
  const cleanRaw = sanitizeFdvText(rawId, 140)
    .replace(/^fdv-render:/i, '')
    .replace(/^DEG-(?=deg-)/i, '');
  if (cleanRaw) return cleanRaw;
  return sanitizeFdvText(fallbackSurveyId, 140)
    .replace(/^fdv-render:/i, '')
    .replace(/^DEG-(?=deg-)/i, '');
}

export function isVirtualFdvRenderSurveyId(surveyId?: string | null): boolean {
  return Boolean(surveyId && surveyId.startsWith(FDV_RENDER_VIRTUAL_ID_PREFIX));
}

// ============================================================================
// MÁQUINA DE ESTADOS FIEL AL CONTRATO FDV -> TRADE MARKETING
// ============================================================================

export function resolveFdvRequestLifecycle(input: FdvLifecycleInput): FdvLifecycleResolution {
  const estadoToken = sanitizeFdvText(input.rawEstado, 40).toUpperCase();
  const ymd = sanitizeFdvText(input.ymd, 20);
  const todayYmd = sanitizeFdvText(input.todayYmd, 20);
  const aprobadoYmd = sanitizeFdvText(input.aprobadoYmd, 20);
  const isBeforeToday = Boolean(ymd && todayYmd && ymd < todayYmd);
  const manuallyArchived = Boolean(input.manuallyArchived);
  const hasExplicitHistorialFlag = typeof input.enHistorial === 'boolean';
  const explicitEnHistorial = Boolean(input.enHistorial) || manuallyArchived;

  const normalizedEstadoToken = estadoToken.replace(/\s+/g, '_');

  if (
    normalizedEstadoToken === 'NO_AUTORIZADA' ||
    normalizedEstadoToken === 'NO_AUTORIZADO' ||
    normalizedEstadoToken === 'RECHAZADA' ||
    normalizedEstadoToken === 'CANCELADA'
  ) {
    return {
      canonicalEstado:
        normalizedEstadoToken === 'RECHAZADA'
          ? 'RECHAZADA'
          : normalizedEstadoToken === 'CANCELADA'
            ? 'CANCELADA'
            : 'NO_AUTORIZADA',
      uiStatus: 'NO_AUTORIZADA',
      isArchived: true,
      enHistorial: true,
      isRejectedOrCancelled: true,
      isNotAuthorized: true,
      isOverduePending: false,
      isEligibleForModule2: false,
    };
  }

  if (input.isFromSellerApp) {
    if (
      normalizedEstadoToken === 'COMPLETADA' ||
      normalizedEstadoToken === 'REALIZADA' ||
      normalizedEstadoToken === 'EJECUTADA'
    ) {
      const archived = hasExplicitHistorialFlag
        ? explicitEnHistorial
        : manuallyArchived || isBeforeToday;
      return {
        canonicalEstado: 'COMPLETADA',
        uiStatus: 'COMPLETADO',
        isArchived: archived,
        enHistorial: archived,
        isRejectedOrCancelled: false,
        isNotAuthorized: false,
        isOverduePending: false,
        isEligibleForModule2: true,
      };
    }

    if (normalizedEstadoToken === 'EN_CURSO') {
      const archived = hasExplicitHistorialFlag
        ? explicitEnHistorial
        : manuallyArchived || isBeforeToday;
      return {
        canonicalEstado: 'EN_CURSO',
        uiStatus: 'EN_CURSO',
        isArchived: archived,
        enHistorial: archived,
        isRejectedOrCancelled: false,
        isNotAuthorized: false,
        isOverduePending: false,
        isEligibleForModule2: true,
      };
    }

    if (
      normalizedEstadoToken === 'APROBADA' ||
      normalizedEstadoToken === 'AUTORIZADA' ||
      normalizedEstadoToken === 'ACEPTADA' ||
      normalizedEstadoToken === 'PROGRAMADA' ||
      normalizedEstadoToken === 'CONFIRMADA'
    ) {
      const wasApprovedTodayOrLater = Boolean(aprobadoYmd && todayYmd && aprobadoYmd >= todayYmd);
      const archived = hasExplicitHistorialFlag
        ? explicitEnHistorial
        : manuallyArchived || (isBeforeToday && !wasApprovedTodayOrLater);
      return {
        canonicalEstado: 'APROBADA',
        uiStatus: 'PROGRAMADO',
        isArchived: archived,
        enHistorial: archived,
        isRejectedOrCancelled: false,
        isNotAuthorized: false,
        isOverduePending: false,
        isEligibleForModule2: true,
      };
    }

    // Regla Crítica (`America/Caracas`, UTC-4):
    // Si pasó la fecha programada (`ymd < todayYmd`) sin haber sido autorizada,
    // pasa automáticamente a la Pestaña de Historial con estado explícito `NO_AUTORIZADA`.
    if (isBeforeToday) {
      return {
        canonicalEstado: 'NO_AUTORIZADA',
        uiStatus: 'NO_AUTORIZADA',
        isArchived: true,
        enHistorial: true,
        isRejectedOrCancelled: false,
        isNotAuthorized: true,
        isOverduePending: true,
        isEligibleForModule2: false,
      };
    }

    const archived = hasExplicitHistorialFlag ? explicitEnHistorial : manuallyArchived;
    return {
      canonicalEstado: 'SOLICITADA',
      uiStatus: 'PENDIENTE',
      isArchived: archived,
      enHistorial: archived,
      isRejectedOrCancelled: false,
      isNotAuthorized: false,
      isOverduePending: false,
      isEligibleForModule2: false,
    };
  }

  // Registros históricos de promotoras en campo (!isFromSellerApp)
  const archived = hasExplicitHistorialFlag
    ? explicitEnHistorial
    : manuallyArchived || isBeforeToday;
  return {
    canonicalEstado: 'COMPLETADA',
    uiStatus: 'COMPLETADO',
    isArchived: archived,
    enHistorial: archived,
    isRejectedOrCancelled: false,
    isNotAuthorized: false,
    isOverduePending: false,
    isEligibleForModule2: true,
  };
}

// ============================================================================
// ADAPTADOR Y RECONCILIACIÓN IDEMPOTENTE: RENDER API <-> SUPABASE `surveys`
// ============================================================================

function toPositiveFinite(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[^0-9.,-]/g, '').replace(',', '.');
    const parsed = Number.parseFloat(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function sanitizeResultadoReport(raw: unknown): DegustacionResultadoReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clean = stripPrototypePollutionDeep(raw as Record<string, unknown>);
  const kilosDegustados =
    clean.kilosDegustados !== undefined ? Math.max(0, toPositiveFinite(clean.kilosDegustados, 0)) : undefined;
  const personasAlcanzadas =
    clean.personasAlcanzadas !== undefined
      ? Math.max(0, Math.round(toPositiveFinite(clean.personasAlcanzadas, 0)))
      : undefined;
  const ventasGeneradas = clean.ventasGeneradas
    ? sanitizeFdvText(clean.ventasGeneradas, 120)
    : undefined;
  const comentarios = clean.comentarios ? sanitizeFdvText(clean.comentarios, 500) : undefined;

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

export function adaptRenderDegustacionToSurveyRow(rawItem: unknown): RawSupabaseSurvey | null {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return null;
  const item = stripPrototypePollutionDeep(rawItem as Partial<RawFdvRenderDegustacion>);

  const canonicalDegId = normalizeCanonicalFdvId(item.id);
  if (!canonicalDegId) return null;

  const ymd = normalizeFdvCalendarDateYmd(item.fecha ?? item.date);
  if (!ymd) return null;

  const storeName =
    sanitizeFdvText(item.clienteNombre ?? item.cliente ?? item.client, 180) || 'Cliente PDV';
  const clienteCodigo = sanitizeFdvText(item.clienteCodigo, 60);
  const sellerName = sanitizeFdvText(item.vendedorNombre ?? item.vendedor, 140) || 'Fuerza de Ventas';
  const vendedorId = sanitizeFdvText(item.vendedorId, 80);
  const ruta = sanitizeFdvText(item.ruta, 180) || 'Maracaibo / Zulia';
  const rawTurnoUpper = sanitizeFdvText(item.turno, 30).toUpperCase();
  const turnoNormalized =
    rawTurnoUpper === 'MANANA'
      ? 'MAÑANA'
      : rawTurnoUpper === 'TARDE'
        ? 'TARDE'
        : rawTurnoUpper === 'COMPLETO'
          ? 'COMPLETO'
          : 'MAÑANA';
  const shiftForUi: ShiftType = turnoNormalized === 'TARDE' ? 'TARDE' : 'MAÑANA';
  const hora =
    sanitizeFdvText(item.hora, 60) ||
    (turnoNormalized === 'COMPLETO'
      ? '09:00 AM - 07:00 PM'
      : shiftForUi === 'TARDE'
        ? '02:00 PM - 07:00 PM'
        : '09:00 AM - 01:00 PM');

  const productsList: string[] = Array.isArray(item.productos)
    ? item.productos.map((p) => sanitizeFdvText(p, 120)).filter(Boolean)
    : sanitizeFdvText(item.productos, 300)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
  const productSummary = productsList.join(', ') || 'Portafolio Codizulca';

  const kilos = Math.max(
    0.5,
    Math.round(toPositiveFinite(item.kilosEstimados ?? item.kilos, 1) * 100) / 100
  );
  const personas = Math.max(
    0,
    Math.round(toPositiveFinite(item.personasEstimadas ?? item.personas, 0))
  );
  const requierePromotora = item.requierePromotora !== undefined ? Boolean(item.requierePromotora) : true;
  const promotoraAsignada = sanitizeFdvText(item.promotoraAsignada, 140);
  const materialPop =
    typeof item.materialPop === 'boolean'
      ? item.materialPop
        ? 'SI'
        : 'NO'
      : sanitizeFdvText(item.materialPop, 30) || 'SI';
  const contactoPunto = sanitizeFdvText(item.contactoPunto, 140);
  const telefonoContacto = sanitizeFdvText(item.telefonoContacto, 60);
  const observaciones = sanitizeFdvText(item.observaciones, 600);
  const notasTradeMarketing = sanitizeFdvText(item.notasTradeMarketing, 600);
  const estadoRaw = sanitizeFdvText(item.estado, 40).toUpperCase() || 'SOLICITADA';
  const resultado = sanitizeResultadoReport(item.resultado);

  let createdAtIso = sanitizeFdvText(item.createdAt ?? item.created_at, 60);
  if (createdAtIso) {
    const parsedCreated = new Date(createdAtIso);
    if (Number.isNaN(parsedCreated.getTime())) {
      createdAtIso = '';
    } else {
      createdAtIso = parsedCreated.toISOString();
    }
  }
  if (!createdAtIso) {
    createdAtIso = `${ymd}T12:00:00.000Z`;
  }

  const address = `Ruta: ${ruta}${
    contactoPunto ? ` | Contacto: ${contactoPunto}${telefonoContacto ? ` (${telefonoContacto})` : ''}` : ''
  }`;

  const commentsPayload = {
    isTasting: true,
    source: 'vendedor_app',
    degustacionId: canonicalDegId,
    id: canonicalDegId,
    client: storeName,
    cliente: storeName,
    clienteCodigo,
    store: storeName,
    vendedor: sellerName,
    salesRep: sellerName,
    vendedorId: vendedorId || undefined,
    promoter: promotoraAsignada || 'POR ASIGNAR (Trade Marketing)',
    promotoraAsignada,
    ruta,
    date: ymd,
    turno: turnoNormalized,
    shift: `${turnoNormalized} (${hora})`,
    time: hora,
    products: productsList.length > 0 ? productsList : [productSummary],
    product: productSummary,
    kilos,
    kg: kilos,
    personas,
    personasEstimadas: personas,
    requierePromotora,
    promoterType: requierePromotora ? 'Fija' : 'Vendedor / Impulso',
    materialPop,
    contactoPunto,
    telefonoContacto,
    address,
    notes: observaciones,
    originalComments: observaciones,
    observaciones,
    estado: estadoRaw,
    status: estadoRaw.toLowerCase(),
    notasTradeMarketing,
    resultado,
    created_at: createdAtIso,
  };

  return {
    id: `${FDV_RENDER_VIRTUAL_ID_PREFIX}${canonicalDegId}`,
    type: 'Degustacion',
    date: ymd,
    store: storeName,
    promoter: promotoraAsignada || sellerName,
    product: productSummary,
    comments: JSON.stringify(commentsPayload),
    creatorId: vendedorId || sellerName,
    created_at: createdAtIso,
  };
}

function scoreDegustacionSurveyRow(row: RawSupabaseSurvey, comments: Record<string, any>): number {
  const estadoUpper = sanitizeFdvText(comments.estado || comments.status, 40).toUpperCase();
  const hasDecision =
    estadoUpper === 'APROBADA' ||
    estadoUpper === 'PROGRAMADA' ||
    estadoUpper === 'CONFIRMADA' ||
    estadoUpper === 'EN_CURSO' ||
    estadoUpper === 'COMPLETADA' ||
    estadoUpper === 'REALIZADA' ||
    estadoUpper === 'EJECUTADA' ||
    estadoUpper === 'RECHAZADA' ||
    estadoUpper === 'CANCELADA';
  const isArchivedInDb = row.en_historial === true || comments.en_historial === true;
  return (
    (!isVirtualFdvRenderSurveyId(row.id) ? 8 : 0) +
    (isArchivedInDb ? 6 : 0) +
    (row.leido_trade === true || comments.leido_trade === true ? 4 : 0) +
    (hasDecision ? 4 : 0) +
    (comments.aprobadoEnTradeAt || comments.revertidoEnTradeAt ? 2 : 0) +
    (comments.source === 'vendedor_app' ? 1 : 0)
  );
}

export function mergeSupabaseAndRenderDegustacionRows(
  supabaseRows: RawSupabaseSurvey[],
  renderRows: RawSupabaseSurvey[]
): {
  mergedRows: RawSupabaseSurvey[];
  renderOnlyRows: RawSupabaseSurvey[];
} {
  const byCanonicalKey = new Map<string, { row: RawSupabaseSurvey; comments: Record<string, any> }>();

  for (const row of supabaseRows) {
    if (!row || !row.id || row.type !== 'Degustacion') continue;
    const c = safeJsonParseObject<Record<string, any>>(row.comments);
    const key = normalizeCanonicalFdvId(c.degustacionId || c.id, row.id);
    if (!key) continue;

    const existing = byCanonicalKey.get(key);
    if (!existing) {
      byCanonicalKey.set(key, { row, comments: c });
      continue;
    }

    if (scoreDegustacionSurveyRow(row, c) > scoreDegustacionSurveyRow(existing.row, existing.comments)) {
      byCanonicalKey.set(key, { row, comments: c });
    }
  }

  const renderOnlyRows: RawSupabaseSurvey[] = [];

  for (const renderRow of renderRows) {
    if (!renderRow || !renderRow.id) continue;
    const rc = safeJsonParseObject<Record<string, any>>(renderRow.comments);
    const key = normalizeCanonicalFdvId(rc.degustacionId || rc.id, renderRow.id);
    if (!key) continue;

    const existing = byCanonicalKey.get(key);
    if (!existing) {
      byCanonicalKey.set(key, { row: renderRow, comments: rc });
      renderOnlyRows.push(renderRow);
      continue;
    }

    // Enriquecer metadatos faltantes en la fila de Supabase sin sobrescribir decisiones ni archivado de Trade Marketing
    const ec = existing.comments;
    const existingEstado = sanitizeFdvText(ec.estado || ec.status, 40).toUpperCase();
    const renderEstado = sanitizeFdvText(rc.estado || rc.status, 40).toUpperCase();
    const shouldAdoptRenderResultado = !ec.resultado && Boolean(rc.resultado);
    const shouldAdoptRenderRealizada =
      (existingEstado === '' || existingEstado === 'SOLICITADA' || existingEstado === 'APROBADA') &&
      renderEstado === 'REALIZADA';

    const preservedEnHistorial =
      existing.row.en_historial === true || ec.en_historial === true
        ? true
        : typeof existing.row.en_historial === 'boolean'
          ? existing.row.en_historial
          : typeof ec.en_historial === 'boolean'
            ? ec.en_historial
            : undefined;

    const enrichedComments: Record<string, any> = {
      ...rc,
      ...ec,
      clienteCodigo: ec.clienteCodigo || rc.clienteCodigo || '',
      vendedorId: ec.vendedorId || rc.vendedorId || undefined,
      ruta: ec.ruta || rc.ruta || '',
      contactoPunto: ec.contactoPunto || rc.contactoPunto || '',
      telefonoContacto: ec.telefonoContacto || rc.telefonoContacto || '',
      promotoraAsignada: ec.promotoraAsignada || rc.promotoraAsignada || '',
      notasTradeMarketing: ec.notasTradeMarketing || rc.notasTradeMarketing || '',
      resultado: shouldAdoptRenderResultado ? rc.resultado : ec.resultado ?? null,
      estado: shouldAdoptRenderRealizada ? 'REALIZADA' : ec.estado || rc.estado || 'SOLICITADA',
      ...(preservedEnHistorial !== undefined ? { en_historial: preservedEnHistorial } : {}),
      ...(ec.archivado_en ? { archivado_en: ec.archivado_en } : {}),
      ...(ec.motivo_archivo ? { motivo_archivo: ec.motivo_archivo } : {}),
    };

    byCanonicalKey.set(key, {
      row: {
        ...existing.row,
        comments: JSON.stringify(enrichedComments),
      },
      comments: enrichedComments,
    });
  }

  return {
    mergedRows: Array.from(byCanonicalKey.values()).map((entry) => entry.row),
    renderOnlyRows,
  };
}

// ============================================================================
// CONSULTAS PARAMETRIZADAS VÍA SDK OFICIAL `@supabase/supabase-js` + RENDER HTTPS
// ============================================================================

const SURVEYS_COLUMNS_WITH_ARCHIVE =
  'id,type,date,store,promoter,product,rating,intent,purchase,email,competitor,comments,creatorId,created_at,leido_trade,visto_en_trade_at,en_historial,archivado_en,motivo_archivo';
const SURVEYS_COLUMNS_WITH_READ =
  'id,type,date,store,promoter,product,rating,intent,purchase,email,competitor,comments,creatorId,created_at,leido_trade,visto_en_trade_at';
const SURVEYS_COLUMNS_BASE =
  'id,type,date,store,promoter,product,rating,intent,purchase,email,competitor,comments,creatorId,created_at';

function createAbortError(message = 'Operación cancelada por AbortSignal'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export async function fetchDegustacionSurveysViaSdk(
  clientOverride?: SupabaseClient | null,
  options?: { signal?: AbortSignal }
): Promise<RawSupabaseSurvey[]> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw createAbortError();
  }
  if (!clientOverride) {
    assertSupabaseConfigured();
  }
  const client = clientOverride ?? getSupabaseRealtimeClient();
  if (!client) {
    throw new Error('Cliente oficial de Supabase no disponible.');
  }

  const pageSize = 1000;
  const collected: RawSupabaseSurvey[] = [];

  const runPageQuery = async (cols: string, from: number, to: number) => {
    if (signal?.aborted) {
      throw createAbortError();
    }
    let query = client
      .from('surveys')
      .select(cols)
      .eq('type', 'Degustacion')
      .order('created_at', { ascending: false })
      .range(from, to);
    if (signal && typeof (query as { abortSignal?: (s: AbortSignal) => typeof query }).abortSignal === 'function') {
      query = (query as { abortSignal: (s: AbortSignal) => typeof query }).abortSignal(signal);
    }
    const res = await query;
    if (signal?.aborted) {
      throw createAbortError();
    }
    return res;
  };

  for (let page = 0; page < 5; page++) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const useArchiveCols =
      surveysArchiveColumnsSupported !== false && surveysLeidoTradeColumnSupported !== false;
    const useReadCols = surveysLeidoTradeColumnSupported !== false;

    const selectedCols = useArchiveCols
      ? SURVEYS_COLUMNS_WITH_ARCHIVE
      : useReadCols
        ? SURVEYS_COLUMNS_WITH_READ
        : SURVEYS_COLUMNS_BASE;

    const { data, error } = await runPageQuery(selectedCols, from, to);

    if (error) {
      if (useArchiveCols && isMissingColumnPostgrestError(error)) {
        surveysArchiveColumnsSupported = false;
        const retryRead = await runPageQuery(SURVEYS_COLUMNS_WITH_READ, from, to);

        if (!retryRead.error) {
          if (surveysLeidoTradeColumnSupported === null) {
            surveysLeidoTradeColumnSupported = true;
          }
          const rows = (retryRead.data || []) as unknown as RawSupabaseSurvey[];
          collected.push(...rows);
          if (rows.length < pageSize) break;
          continue;
        }

        if (isMissingColumnPostgrestError(retryRead.error)) {
          surveysLeidoTradeColumnSupported = false;
          const retryBase = await runPageQuery(SURVEYS_COLUMNS_BASE, from, to);

          if (retryBase.error) {
            throw new Error(`Supabase SDK surveys(Degustacion) failed: ${retryBase.error.message}`);
          }
          const rows = (retryBase.data || []) as unknown as RawSupabaseSurvey[];
          collected.push(...rows);
          if (rows.length < pageSize) break;
          continue;
        }

        throw new Error(`Supabase SDK surveys(Degustacion) failed: ${retryRead.error.message}`);
      }

      if (useReadCols && isMissingColumnPostgrestError(error)) {
        surveysLeidoTradeColumnSupported = false;
        const retry = await runPageQuery(SURVEYS_COLUMNS_BASE, from, to);

        if (retry.error) {
          throw new Error(`Supabase SDK surveys(Degustacion) failed: ${retry.error.message}`);
        }
        const rows = (retry.data || []) as unknown as RawSupabaseSurvey[];
        collected.push(...rows);
        if (rows.length < pageSize) break;
        continue;
      }
      throw new Error(`Supabase SDK surveys(Degustacion) failed: ${error.message}`);
    }

    if (useArchiveCols && surveysArchiveColumnsSupported === null) {
      surveysArchiveColumnsSupported = true;
      surveysLeidoTradeColumnSupported = true;
    } else if (useReadCols && surveysLeidoTradeColumnSupported === null) {
      surveysLeidoTradeColumnSupported = true;
    }

    const rows = (data || []) as unknown as RawSupabaseSurvey[];
    collected.push(...rows);
    if (rows.length < pageSize) break;
  }

  return collected;
}

export async function fetchNonDegustacionSurveysViaSdk(
  clientOverride?: SupabaseClient | null,
  options?: { includeConsumerSurveys?: boolean }
): Promise<RawSupabaseSurvey[]> {
  if (!clientOverride) {
    assertSupabaseConfigured();
  }
  const client = clientOverride ?? getSupabaseRealtimeClient();
  if (!client) {
    throw new Error('Cliente oficial de Supabase no disponible.');
  }

  let baseQuery = client.from('surveys').select(SURVEYS_COLUMNS_BASE);
  if (options?.includeConsumerSurveys === false) {
    baseQuery = baseQuery.eq('type', 'Merchandising');
  } else {
    baseQuery = baseQuery.neq('type', 'Degustacion');
  }

  const { data, error } = await baseQuery
    .order('date', { ascending: false })
    .limit(1000);

  if (error) {
    throw new Error(`Supabase SDK surveys(non-Degustacion) failed: ${error.message}`);
  }

  return (data || []) as unknown as RawSupabaseSurvey[];
}

let inFlightRenderGetPromise: Promise<RawSupabaseSurvey[]> | null = null;
let lastRenderCacheAt = 0;
let lastRenderCachedRows: RawSupabaseSurvey[] = [];
const RENDER_CACHE_TTL_MS = 12_000;

export async function fetchFdvPlanificadorRenderDegustaciones(options?: {
  endpointUrl?: string;
  timeoutMs?: number;
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<RawSupabaseSurvey[]> {
  const externalSignal = options?.signal;
  if (externalSignal?.aborted) {
    throw createAbortError();
  }
  const safeEndpoint = validateFdvRenderEndpoint(options?.endpointUrl ?? DEFAULT_FDV_RENDER_API_URL);
  if (!safeEndpoint) return [];

  const now = Date.now();
  if (
    !options?.forceRefresh &&
    !options?.fetchImpl &&
    lastRenderCachedRows.length > 0 &&
    now - lastRenderCacheAt < RENDER_CACHE_TTL_MS
  ) {
    return lastRenderCachedRows;
  }

  if (!options?.forceRefresh && !options?.fetchImpl && !externalSignal && inFlightRenderGetPromise) {
    return inFlightRenderGetPromise;
  }

  const timeoutMs = Math.max(1000, Math.min(25_000, options?.timeoutMs ?? 12_000));
  const fetcher = options?.fetchImpl ?? fetch;

  const runner = (async (): Promise<RawSupabaseSurvey[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        throw createAbortError();
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const res = await fetcher(safeEndpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (externalSignal?.aborted) {
        throw createAbortError();
      }
      if (!res.ok) return lastRenderCachedRows;

      const rawText = await res.text();
      if (externalSignal?.aborted) {
        throw createAbortError();
      }
      if (!rawText || rawText.length > 5 * 1024 * 1024) return lastRenderCachedRows;

      const parsedEnvelope = safeJsonParseObject<{
        success?: boolean;
        data?: unknown[];
      }>(rawText);

      const rawItems = Array.isArray(parsedEnvelope.data) ? parsedEnvelope.data : [];
      const adapted: RawSupabaseSurvey[] = [];
      for (const item of rawItems) {
        const surveyRow = adaptRenderDegustacionToSurveyRow(item);
        if (surveyRow) adapted.push(surveyRow);
      }

      if (!options?.fetchImpl) {
        lastRenderCachedRows = adapted;
        lastRenderCacheAt = Date.now();
      }
      return adapted;
    } catch (err) {
      if (externalSignal?.aborted) {
        throw createAbortError();
      }
      void err;
      return lastRenderCachedRows;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  })();

  if (!options?.fetchImpl && !externalSignal) {
    inFlightRenderGetPromise = runner.finally(() => {
      inFlightRenderGetPromise = null;
    });
    return inFlightRenderGetPromise;
  }

  return runner;
}

export async function syncDecisionToFdvPlanificadorRender(
  canonicalDegId: string,
  payload: {
    estado: 'APROBADA' | 'RECHAZADA' | 'REALIZADA' | 'SOLICITADA';
    promotoraAsignada?: string;
    notasTradeMarketing?: string;
  },
  options?: {
    endpointUrl?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }
): Promise<boolean> {
  const cleanDegId = normalizeCanonicalFdvId(canonicalDegId);
  if (!cleanDegId || !/^deg-/i.test(cleanDegId)) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(cleanDegId)) return false;

  const safeEndpoint = validateFdvRenderEndpoint(options?.endpointUrl ?? DEFAULT_FDV_RENDER_API_URL);
  if (!safeEndpoint) return false;

  const timeoutMs = Math.max(1000, Math.min(15_000, options?.timeoutMs ?? 8_000));
  const fetcher = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetcher(`${safeEndpoint}/${encodeURIComponent(cleanDegId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        estado: payload.estado,
        ...(payload.promotoraAsignada !== undefined
          ? { promotoraAsignada: sanitizeFdvText(payload.promotoraAsignada, 140) }
          : {}),
        ...(payload.notasTradeMarketing !== undefined
          ? { notasTradeMarketing: sanitizeFdvText(payload.notasTradeMarketing, 500) }
          : {}),
        updatedAt: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    if (res.ok && !options?.fetchImpl) {
      lastRenderCacheAt = 0;
    }
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
