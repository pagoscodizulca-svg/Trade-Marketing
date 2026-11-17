import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FEATURE_FLAGS } from '../config/featureFlags';
import { getSupabaseRealtimeClient, assertSupabaseConfigured } from './supabaseClient';
import {
  getCaracasTodayYmd,
  getCaracasWeekCycleBounds,
  isTastingBeforeTodayCaracas,
  isTastingInPastCaracasWeek,
  isValidIsoCalendarDateYmd,
  resolveTastingAuthorizationState,
  resolveTastingEventCaracasYmd,
} from '../utils/caracasWeekCycle';

// ============================================================================
// SERVICIO DE CICLO SEMANAL E HISTORIAL PAGINADO EN SERVIDOR (`25` / PÁGINA)
// Garantías de Seguridad:
//   1. Cero concatenación SQL; uso exclusivo de métodos parametrizados del SDK oficial.
//   2. Validación y sanitización estricta con `Zod` de fechas ISO, límites de paginación
//      (`1..100`, default `25`) y filtros de texto/vendedor/promotora.
//   3. Guardia RBAC de Integridad Histórica (`HistoricalTastingLockError` HTTP 403)
//      impidiendo a usuarios no administradores modificar registros `< inicio_semana_actual`.
// ============================================================================

export const DEFAULT_HISTORIAL_PAGE_SIZE = 25;
export const MAX_HISTORIAL_PAGE_SIZE = 100;

export class HistoricalTastingLockError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'HISTORICAL_RECORD_LOCKED';

  constructor(message?: string) {
    super(
      message ||
        'Registro Histórico (Cerrado): Solo un usuario Administrador puede modificar o eliminar degustaciones de semanas anteriores.'
    );
    this.name = 'HistoricalTastingLockError';
  }
}

/**
 * Elimina caracteres de control invisibles, recorta espacios y escapa comodines LIKE (`%`, `_`, `\`)
 * para búsquedas parametrizadas seguras sin riesgo de inyección en filtros.
 */
export function sanitizeFilterToken(raw: unknown, maxLen = 120): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function escapeIlikePattern(cleanToken: string): string {
  return cleanToken.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const OptionalIsoDateSchema = z
  .string()
  .trim()
  .optional()
  .transform((val) => (val ? val : undefined))
  .refine((val) => val === undefined || isValidIsoCalendarDateYmd(val), {
    message: 'Formato de fecha inválido; se requiere fecha calendario ISO YYYY-MM-DD válida.',
  });

export const HistorialPaginationFilterInputSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_HISTORIAL_PAGE_SIZE)
      .default(DEFAULT_HISTORIAL_PAGE_SIZE),
    dateFrom: OptionalIsoDateSchema,
    dateTo: OptionalIsoDateSchema,
    singleDate: OptionalIsoDateSchema,
    yearMonth: z
      .string()
      .trim()
      .optional()
      .transform((val) => (val ? val : undefined))
      .refine((val) => val === undefined || /^\d{4}-(0[1-9]|1[0-2])$/.test(val), {
        message: 'Mes inválido; se requiere formato YYYY-MM.',
      }),
    sellerFilter: z
      .string()
      .optional()
      .transform((v) => sanitizeFilterToken(v, 120)),
    promotoraFilter: z
      .string()
      .optional()
      .transform((v) => sanitizeFilterToken(v, 120)),
    statusFilter: z
      .string()
      .optional()
      .transform((v) => sanitizeFilterToken(v, 40).toUpperCase()),
    shiftFilter: z
      .string()
      .optional()
      .transform((v) => sanitizeFilterToken(v, 30).toUpperCase()),
    productFilter: z
      .string()
      .optional()
      .transform((v) => sanitizeFilterToken(v, 100)),
    searchQuery: z
      .string()
      .optional()
      .transform((v) => sanitizeFilterToken(v, 120)),
  })
  .superRefine((val, ctx) => {
    if (val.dateFrom && val.dateTo && val.dateFrom > val.dateTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateFrom'],
        message: 'La fecha inicial (Desde) no puede ser mayor que la fecha final (Hasta).',
      });
    }
  });

export type ValidatedHistorialFilterParams = z.output<typeof HistorialPaginationFilterInputSchema>;
export type RawHistorialFilterParams = z.input<typeof HistorialPaginationFilterInputSchema>;

export interface SanitizedHistorialDateWindow {
  inicioSemanaActualYmd: string;
  effectiveGteYmd: string | null;
  effectiveLteYmd: string | null;
  isEmptyBecauseFutureFilter: boolean;
}

/**
 * Valida los parámetros de consulta del Historial y acota cualquier rango de fechas
 * estrictamente a `< inicioSemanaActualYmd` (`America/Caracas`).
 */
export function validateAndResolveHistorialQueryWindow(
  rawInput: RawHistorialFilterParams,
  referenceNow: Date | number | string = new Date()
): {
  params: ValidatedHistorialFilterParams;
  window: SanitizedHistorialDateWindow;
} {
  const params = HistorialPaginationFilterInputSchema.parse(rawInput);
  const bounds = getCaracasWeekCycleBounds(referenceNow);
  const todayCaracasYmd = bounds.todayCaracasYmd;
  const inicioSemanaActualYmd = FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
    ? bounds.inicioSemanaActualYmd
    : todayCaracasYmd;

  let effectiveGteYmd: string | null = null;
  let effectiveLteYmd: string | null = null;

  if (params.singleDate) {
    effectiveGteYmd = params.singleDate;
    effectiveLteYmd = params.singleDate;
  } else if (params.yearMonth) {
    const [y, m] = params.yearMonth.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    effectiveGteYmd = `${params.yearMonth}-01`;
    effectiveLteYmd = `${params.yearMonth}-${String(lastDay).padStart(2, '0')}`;
  } else {
    effectiveGteYmd = params.dateFrom ?? null;
    effectiveLteYmd = params.dateTo ?? null;
  }

  // Cuando el modo Ciclo ISO está activo, el Historial contiene exclusivamente `< inicioSemanaActualYmd`.
  // Cuando está desactivado (`ENABLE_MODULO1_CICLO_ISO_BADGE === false`), el Historial contiene
  // `< todayCaracasYmd` MÁS las solicitudes descartadas (`NO_AUTORIZADA`) incluso de fechas futuras.
  if (FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE) {
    if (effectiveGteYmd && effectiveGteYmd >= inicioSemanaActualYmd) {
      return {
        params,
        window: {
          inicioSemanaActualYmd,
          effectiveGteYmd,
          effectiveLteYmd,
          isEmptyBecauseFutureFilter: true,
        },
      };
    }

    if (effectiveLteYmd && effectiveLteYmd >= inicioSemanaActualYmd) {
      const [monY, monM, monD] = inicioSemanaActualYmd.split('-').map(Number);
      const prevSundayUtc = new Date(Date.UTC(monY, monM - 1, monD - 1));
      effectiveLteYmd = `${prevSundayUtc.getUTCFullYear()}-${String(
        prevSundayUtc.getUTCMonth() + 1
      ).padStart(2, '0')}-${String(prevSundayUtc.getUTCDate()).padStart(2, '0')}`;
    }
  }

  return {
    params,
    window: {
      inicioSemanaActualYmd,
      effectiveGteYmd,
      effectiveLteYmd,
      isEmptyBecauseFutureFilter: Boolean(
        effectiveGteYmd && effectiveLteYmd && effectiveGteYmd > effectiveLteYmd
      ),
    },
  };
}

export interface RawHistoricalSurveyRow {
  id: string;
  type: string;
  date?: string | null;
  fecha_evento?: string | null;
  store?: string | null;
  promoter?: string | null;
  product?: string | null;
  comments?: string | null;
  creatorId?: string | null;
  created_at?: string | null;
  leido_trade?: boolean | null;
  visto_en_trade_at?: string | null;
  en_historial?: boolean | null;
  archivado_en?: string | null;
  motivo_archivo?: string | null;
}

export interface ServerPaginatedHistorialSurveyResult {
  rows: RawHistoricalSurveyRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  inicioSemanaActualYmd: string;
  usedIndexedFechaEventoColumn: boolean;
}

let fechaEventoColumnSupported: boolean | null = null;

function isUndefinedColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim();
  const msg = String(err.message || '').toLowerCase();
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    (msg.includes('column') && (msg.includes('does not exist') || msg.includes('schema cache')))
  );
}

const HISTORIAL_SELECT_WITH_FECHA_EVENTO =
  'id,type,date,fecha_evento,store,promoter,product,comments,creatorId,created_at,leido_trade,visto_en_trade_at,en_historial,archivado_en,motivo_archivo';

const HISTORIAL_SELECT_FALLBACK =
  'id,type,date,store,promoter,product,comments,creatorId,created_at';

/**
 * Ejecuta una consulta paginada eficiente en servidor (`range(from, to)` + `{ count: 'exact' }`)
 * sobre `public.surveys` (`type = 'Degustacion'`) para semanas estrictamente anteriores
 * a `inicioSemanaActualYmd` en `America/Caracas`, en orden `fecha_evento DESC, created_at DESC`.
 */
export async function queryServerPaginatedHistorialSurveys(
  rawInput: RawHistorialFilterParams,
  options?: {
    clientOverride?: SupabaseClient | null;
    referenceNow?: Date | number | string;
  }
): Promise<ServerPaginatedHistorialSurveyResult> {
  const { params, window: dateWindow } = validateAndResolveHistorialQueryWindow(
    rawInput,
    options?.referenceNow
  );

  if (dateWindow.isEmptyBecauseFutureFilter) {
    return {
      rows: [],
      totalCount: 0,
      page: 1,
      pageSize: params.pageSize,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
      inicioSemanaActualYmd: dateWindow.inicioSemanaActualYmd,
      usedIndexedFechaEventoColumn: fechaEventoColumnSupported !== false,
    };
  }

  if (!options?.clientOverride) {
    assertSupabaseConfigured();
  }
  const client = options?.clientOverride ?? getSupabaseRealtimeClient();
  if (!client) {
    throw new Error('Cliente oficial de Supabase no disponible.');
  }

  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;

  const tryIndexedFechaEvento = fechaEventoColumnSupported !== false;

  if (tryIndexedFechaEvento) {
    let query = client
      .from('surveys')
      .select(HISTORIAL_SELECT_WITH_FECHA_EVENTO, { count: 'exact' })
      .eq('type', 'Degustacion');

    if (FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE) {
      query = query.lt('fecha_evento', dateWindow.inicioSemanaActualYmd);
    } else {
      query = query.or(
        `fecha_evento.lt.${dateWindow.inicioSemanaActualYmd},en_historial.eq.true`
      );
    }

    if (dateWindow.effectiveGteYmd) {
      query = query.gte('fecha_evento', dateWindow.effectiveGteYmd);
    }
    if (dateWindow.effectiveLteYmd) {
      query = query.lte('fecha_evento', dateWindow.effectiveLteYmd);
    }
    if (params.productFilter && params.productFilter !== 'TODOS') {
      query = query.ilike('product', `%${escapeIlikePattern(params.productFilter)}%`);
    }
    if (params.sellerFilter && params.sellerFilter !== 'TODOS') {
      query = query.ilike('comments', `%${escapeIlikePattern(params.sellerFilter)}%`);
    }
    if (params.promotoraFilter && params.promotoraFilter !== 'TODAS') {
      if (params.promotoraFilter === 'POR_ASIGNAR') {
        query = query.ilike('comments', '%POR ASIGNAR%');
      } else {
        query = query.ilike('comments', `%${escapeIlikePattern(params.promotoraFilter)}%`);
      }
    }
    if (params.searchQuery) {
      query = query.ilike('comments', `%${escapeIlikePattern(params.searchQuery)}%`);
    }

    const { data, count, error } = await query
      .order('fecha_evento', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (!error) {
      fechaEventoColumnSupported = true;
      const totalCount = Math.max(0, count ?? (data?.length || 0));
      const totalPages = Math.max(1, Math.ceil(totalCount / params.pageSize));
      const rows = (data || []) as unknown as RawHistoricalSurveyRow[];
      return {
        rows,
        totalCount,
        page: Math.min(params.page, totalPages),
        pageSize: params.pageSize,
        totalPages,
        startIndex: rows.length > 0 ? from + 1 : 0,
        endIndex: rows.length > 0 ? from + rows.length : 0,
        inicioSemanaActualYmd: dateWindow.inicioSemanaActualYmd,
        usedIndexedFechaEventoColumn: true,
      };
    }

    if (isUndefinedColumnError(error)) {
      fechaEventoColumnSupported = false;
    } else {
      throw new Error(`Error consultando Historial paginado en Supabase: ${error.message}`);
    }
  }

  // Fallback tipado sobre `date` cuando la migración `20261113_ciclo_semanal_automatico_degustaciones.sql`
  // aún no ha sido ejecutada manualmente en el SQL Editor remoto.
  let fallbackQuery = client
    .from('surveys')
    .select(HISTORIAL_SELECT_FALLBACK, { count: 'exact' })
    .eq('type', 'Degustacion')
    .lt('date', dateWindow.inicioSemanaActualYmd);

  if (dateWindow.effectiveGteYmd) {
    fallbackQuery = fallbackQuery.gte('date', dateWindow.effectiveGteYmd);
  }
  if (dateWindow.effectiveLteYmd) {
    fallbackQuery = fallbackQuery.lte('date', dateWindow.effectiveLteYmd);
  }
  if (params.productFilter && params.productFilter !== 'TODOS') {
    fallbackQuery = fallbackQuery.ilike('product', `%${escapeIlikePattern(params.productFilter)}%`);
  }
  if (params.sellerFilter && params.sellerFilter !== 'TODOS') {
    fallbackQuery = fallbackQuery.ilike('comments', `%${escapeIlikePattern(params.sellerFilter)}%`);
  }
  if (params.promotoraFilter && params.promotoraFilter !== 'TODAS') {
    if (params.promotoraFilter === 'POR_ASIGNAR') {
      fallbackQuery = fallbackQuery.ilike('comments', '%POR ASIGNAR%');
    } else {
      fallbackQuery = fallbackQuery.ilike(
        'comments',
        `%${escapeIlikePattern(params.promotoraFilter)}%`
      );
    }
  }
  if (params.searchQuery) {
    fallbackQuery = fallbackQuery.ilike('comments', `%${escapeIlikePattern(params.searchQuery)}%`);
  }

  const { data: fbData, count: fbCount, error: fbError } = await fallbackQuery
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (fbError) {
    throw new Error(`Error consultando Historial paginado (fallback): ${fbError.message}`);
  }

  const rawRows = ((fbData || []) as unknown as RawHistoricalSurveyRow[]).filter((r) =>
    FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE
      ? isTastingInPastCaracasWeek(r.date, options?.referenceNow)
      : isTastingBeforeTodayCaracas(r.date, options?.referenceNow) || Boolean(r.en_historial)
  );
  const totalCount = Math.max(0, fbCount ?? rawRows.length);
  const totalPages = Math.max(1, Math.ceil(totalCount / params.pageSize));

  return {
    rows: rawRows,
    totalCount,
    page: Math.min(params.page, totalPages),
    pageSize: params.pageSize,
    totalPages,
    startIndex: rawRows.length > 0 ? from + 1 : 0,
    endIndex: rawRows.length > 0 ? from + rawRows.length : 0,
    inicioSemanaActualYmd: dateWindow.inicioSemanaActualYmd,
    usedIndexedFechaEventoColumn: false,
  };
}

/**
 * Paginación determinista y sanitizada sobre elementos ya reconciliados en memoria
 * (usada como respaldo inmediato de UI y sincronizada con los mismos límites `Zod`).
 */
export function paginateSanitizedHistorialCollection<
  T extends {
    id: string;
    date?: string | null;
    status?: string | null;
    enHistorial?: boolean | null;
    createdAt?: string | null;
    rawComments?: Record<string, unknown> | null;
  },
>(
  items: readonly T[],
  rawInput: Pick<RawHistorialFilterParams, 'page' | 'pageSize' | 'dateFrom' | 'dateTo' | 'singleDate' | 'yearMonth'>,
  referenceNow: Date | number | string = new Date()
): {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  inicioSemanaActualYmd: string;
} {
  const { params, window: dateWindow } = validateAndResolveHistorialQueryWindow(
    rawInput,
    referenceNow
  );

  if (dateWindow.isEmptyBecauseFutureFilter) {
    return {
      items: [],
      page: 1,
      pageSize: params.pageSize,
      totalItems: 0,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
      inicioSemanaActualYmd: dateWindow.inicioSemanaActualYmd,
    };
  }

  const todayCaracasYmd = getCaracasTodayYmd(referenceNow);
  const resolvedMap = new Map<string, string>();
  const historicalFiltered = items.filter((item) => {
    const fallback = item.rawComments?.date ?? item.rawComments?.fecha ?? item.createdAt;
    const ymd = resolveTastingEventCaracasYmd(item.date, fallback);

    if (FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE) {
      if (!ymd || ymd >= dateWindow.inicioSemanaActualYmd) return false;
    } else {
      const authState = resolveTastingAuthorizationState({
        rawEstado: item.rawComments?.estado ?? item.rawComments?.status,
        statusUi: item.status,
        rawEventDate: item.date,
        fallbackDate: fallback,
        referenceNow,
      });
      const belongsToHistorial =
        Boolean(item.enHistorial) ||
        authState.belongsToHistorial ||
        Boolean(ymd && ymd < todayCaracasYmd);
      if (!belongsToHistorial) return false;
    }

    if (dateWindow.effectiveGteYmd && (!ymd || ymd < dateWindow.effectiveGteYmd)) return false;
    if (dateWindow.effectiveLteYmd && (!ymd || ymd > dateWindow.effectiveLteYmd)) return false;
    if (ymd) {
      resolvedMap.set(item.id, ymd);
    }
    return true;
  });

  historicalFiltered.sort((a, b) => {
    const dA = resolvedMap.get(a.id) || '0000-00-00';
    const dB = resolvedMap.get(b.id) || '0000-00-00';
    if (dB !== dA) return dB.localeCompare(dA);
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });

  const totalItems = historicalFiltered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / params.pageSize));
  const safePage = Math.min(params.page, totalPages);
  const offset = (safePage - 1) * params.pageSize;
  const pageItems = historicalFiltered.slice(offset, offset + params.pageSize);

  return {
    items: pageItems,
    page: safePage,
    pageSize: params.pageSize,
    totalItems,
    totalPages,
    startIndex: pageItems.length > 0 ? offset + 1 : 0,
    endIndex: pageItems.length > 0 ? offset + pageItems.length : 0,
    inicioSemanaActualYmd: dateWindow.inicioSemanaActualYmd,
  };
}

/**
 * Guardia de Integridad Histórica (RBAC):
 * Impide que cualquier rol no administrador (`isStrictAdmin === false`) modifique, apruebe,
 * rechace, reasigne o elimine degustaciones pertenecientes a semanas anteriores cerradas
 * (`fecha_evento < inicio_semana_actual` en `America/Caracas`).
 */
export function isStrictAdminRole(role?: string | null): boolean {
  const clean = String(role || '').trim().toLowerCase();
  return (
    clean === 'super_admin' ||
    clean === 'admin' ||
    clean === 'gerente_admin' ||
    clean === 'superadmin'
  );
}

export function assertCanMutateTastingByWeekCycle(params: {
  eventDate: unknown;
  fallbackDate?: unknown;
  isStrictAdmin: boolean;
  allowMarkNoAutorizada?: boolean;
  referenceNow?: Date | number | string;
}): void {
  if (params.isStrictAdmin || params.allowMarkNoAutorizada) {
    return;
  }

  if (FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE) {
    if (isTastingInPastCaracasWeek(params.eventDate, params.referenceNow, params.fallbackDate)) {
      throw new HistoricalTastingLockError();
    }
    return;
  }

  if (isTastingBeforeTodayCaracas(params.eventDate, params.referenceNow, params.fallbackDate)) {
    throw new HistoricalTastingLockError(
      'Registro Histórico (Cerrado): Solo un usuario Administrador puede modificar degustaciones de fechas pasadas.'
    );
  }
}
