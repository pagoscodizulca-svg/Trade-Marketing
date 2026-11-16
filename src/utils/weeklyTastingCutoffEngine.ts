import { normalizeExcelDate } from './excelDateNormalizer';

// ============================================================================
// MOTOR PURO E INYECTABLE (MOCKED CLOCK) DE ARCHIVADO LÓGICO Y CIERRE DOMINICAL
// Regla de Negocio:
//   - Todos los domingos a las 21:00 (9:00 PM) en `America/Caracas` (UTC-04:00),
//     equivalente a `0 1 * * 1` en UTC (Lunes 01:00 UTC), pasan a `Historial`
//     todas las degustaciones con `en_historial = false` cuya fecha programada/
//     celebrada sea `<= fecha_corte_domingo`, preservando su estado operativo.
//   - Las degustaciones con `fecha_evento > fecha_corte_domingo` (lunes siguiente
//     en adelante) permanecen intactas en `en_historial = false`.
// ============================================================================

export const DEFAULT_BUSINESS_TIMEZONE = 'America/Caracas';
export const MOTIVO_CORTE_INICIAL = 'CORTE_INICIAL';
export const MOTIVO_CIERRE_DOMINGO_9PM = 'CIERRE_DOMINGO_9PM';

/** Expresión cron en UTC equivalente a Domingos 21:00 America/Caracas (UTC-04:00). */
export const PG_CRON_SUNDAY_9PM_CARACAS_UTC = '0 1 * * 1';

export type CierreSemanalEstado = 'OK' | 'ERROR';

export interface CierreSemanalDiagnostico {
  zona_horaria: string;
  hora_local_ejecucion: string;
  motivo_archivo: string;
  surveys_archivadas: number;
  cronograma_archivadas: number;
  modo_forzado: boolean;
  corridas_idempotentes?: number;
}

export interface CierreSemanalLogEntry {
  id: string;
  ejecutado_en: string;
  fecha_corte: string; // YYYY-MM-DD (Domingo de cierre)
  registros_archivados: number;
  estado: CierreSemanalEstado;
  detalle_diagnostico: CierreSemanalDiagnostico | Record<string, unknown>;
}

export interface SundayCutoffTimeContext {
  timeZone: string;
  executedAtIso: string;
  localYmd: string;
  localHour: number;
  localMinute: number;
  localSecond: number;
  isoDayOfWeek: number; // 1 = Lunes .. 7 = Domingo
  localFormattedTimestamp: string;
  isWithinScheduledWindow: boolean; // Domingo >= 21:00 en la zona horaria configurada
  fechaCorteDomingo: string; // YYYY-MM-DD del domingo correspondiente al cierre
}

export interface ArchivableTastingItem {
  id: string;
  date?: string | null;
  shift?: string | null;
  turnoRaw?: string | null;
  timeRange?: string | null;
  createdAt?: string | null;
  status: string;
  enHistorial?: boolean;
  isArchived?: boolean;
  archivadoEn?: string | null;
  motivoArchivo?: string | null;
  sourceTable?: 'surveys' | 'cronograma_degustaciones';
}

export interface DeterministicWeeklyCutoffResult<T extends ArchivableTastingItem> {
  ok: boolean;
  skippedOutsideWindow: boolean;
  idempotentNoop: boolean;
  fechaCorteDomingo: string;
  archivedCount: number;
  surveysArchivedCount: number;
  cronogramaArchivedCount: number;
  archivedIds: string[];
  updatedRecords: T[];
  auditLogs: CierreSemanalLogEntry[];
  logEntry: CierreSemanalLogEntry | null;
}

export interface PaginatedSliceResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number; // 1-based (0 cuando vacío)
  endIndex: number; // 1-based (0 cuando vacío)
}

const ISO_WEEKDAY_BY_SHORT_EN: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function sanitizeTimeZoneOrDefault(rawTimeZone?: string | null): string {
  const candidate = String(rawTimeZone || '').trim();
  if (!candidate) return DEFAULT_BUSINESS_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_BUSINESS_TIMEZONE;
  }
}

function subtractDaysFromYmd(ymd: string, daysToSubtract: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - daysToSubtract, 12, 0, 0));
  return dt.toISOString().slice(0, 10);
}

/**
 * Calcula con precisión matemática la fecha/hora local en `timeZone` (`America/Caracas` por defecto)
 * y determina la `fechaCorteDomingo` (`YYYY-MM-DD`) sin depender del huso horario del SO anfitrión.
 */
export function resolveSundayCutoffContext(
  now: Date = new Date(),
  rawTimeZone?: string | null,
  forceRun = false
): SundayCutoffTimeContext {
  const safeNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const timeZone = sanitizeTimeZoneOrDefault(rawTimeZone);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(safeNow);
  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value || '';

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const rawHour = Number.parseInt(getPart('hour'), 10);
  const localHour = Number.isFinite(rawHour) ? (rawHour === 24 ? 0 : rawHour) : 0;
  const localMinute = Number.parseInt(getPart('minute'), 10) || 0;
  const localSecond = Number.parseInt(getPart('second'), 10) || 0;
  const weekdayToken = getPart('weekday');
  const isoDayOfWeek = ISO_WEEKDAY_BY_SHORT_EN[weekdayToken] ?? 7;

  const localYmd = `${year}-${month}-${day}`;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const localFormattedTimestamp = `${localYmd} ${pad2(localHour)}:${pad2(localMinute)}:${pad2(localSecond)}`;

  const isWithinScheduledWindow = isoDayOfWeek === 7 && localHour >= 21;

  // Si es domingo, el corte es ese mismo domingo; si un operador fuerza recuperación un lunes/martes,
  // el corte corresponde estrictamente al domingo inmediato anterior (nunca a la semana en curso).
  const fechaCorteDomingo =
    isoDayOfWeek === 7
      ? localYmd
      : forceRun
        ? subtractDaysFromYmd(localYmd, isoDayOfWeek)
        : localYmd;

  return {
    timeZone,
    executedAtIso: safeNow.toISOString(),
    localYmd,
    localHour,
    localMinute,
    localSecond,
    isoDayOfWeek,
    localFormattedTimestamp,
    isWithinScheduledWindow,
    fechaCorteDomingo,
  };
}

/**
 * Normaliza la fecha programada/celebrada de una degustación a `YYYY-MM-DD` sin desfase de zona horaria.
 */
export function resolveCanonicalEventDateYmd(rawDate?: unknown): string {
  if (rawDate === null || rawDate === undefined) return '';
  const trimmed = String(rawDate).trim();
  if (!trimmed) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = normalizeExcelDate(trimmed);
  return parsed.isValid && parsed.fechaIso ? parsed.fechaIso : '';
}

/**
 * Determina si una degustación está archivada en `Historial` respetando prioridad estricta del flag lógico `enHistorial`.
 */
export function isTastingInHistorial(item: {
  enHistorial?: boolean | null;
  isArchived?: boolean | null;
}): boolean {
  if (typeof item.enHistorial === 'boolean') {
    return item.enHistorial;
  }
  return Boolean(item.isArchived);
}

/**
 * Evalúa la regla exacta del cierre dominical de las 9:00 PM:
 *   - Solo afecta registros activos (`en_historial = false`).
 *   - Pasa a `Historial` si y solo si `fecha_evento <= fecha_corte_domingo`.
 *   - Protege estrictamente `fecha_evento > fecha_corte_domingo` (semana siguiente).
 */
export function shouldArchiveOnSundayCutoff(
  item: {
    date?: string | null;
    enHistorial?: boolean | null;
    isArchived?: boolean | null;
  },
  fechaCorteDomingo: string
): boolean {
  if (isTastingInHistorial(item)) {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaCorteDomingo)) {
    return false;
  }
  const eventYmd = resolveCanonicalEventDateYmd(item.date);
  if (!eventYmd) {
    return false;
  }
  return eventYmd <= fechaCorteDomingo;
}

/**
 * Ejecuta en memoria el cierre dominical 9:00 PM con reloj inyectable (`now`) y bitácora idempotente
 * libre de PII (`cierres_semanales_log`). Preserva al 100% `status` y demás campos operativos.
 */
export function executeDeterministicWeeklyCutoff<T extends ArchivableTastingItem>(params: {
  records: readonly T[];
  existingLogs?: readonly CierreSemanalLogEntry[];
  now: Date;
  timeZone?: string;
  forceRun?: boolean;
  idGenerator?: () => string;
}): DeterministicWeeklyCutoffResult<T> {
  const forceRun = Boolean(params.forceRun);
  const ctx = resolveSundayCutoffContext(params.now, params.timeZone, forceRun);
  const currentLogs = [...(params.existingLogs || [])];

  if (!forceRun && !ctx.isWithinScheduledWindow) {
    return {
      ok: true,
      skippedOutsideWindow: true,
      idempotentNoop: false,
      fechaCorteDomingo: ctx.fechaCorteDomingo,
      archivedCount: 0,
      surveysArchivedCount: 0,
      cronogramaArchivedCount: 0,
      archivedIds: [],
      updatedRecords: params.records.map((r) => ({ ...r })),
      auditLogs: currentLogs,
      logEntry: null,
    };
  }

  const archivedIds: string[] = [];
  let surveysArchivedCount = 0;
  let cronogramaArchivedCount = 0;

  const updatedRecords = params.records.map((record) => {
    if (!shouldArchiveOnSundayCutoff(record, ctx.fechaCorteDomingo)) {
      return { ...record };
    }

    archivedIds.push(record.id);
    if (record.sourceTable === 'cronograma_degustaciones') {
      cronogramaArchivedCount += 1;
    } else {
      surveysArchivedCount += 1;
    }

    // Archivado 100% lógico: NO modifica `status` ni relaciones operativas
    return {
      ...record,
      enHistorial: true,
      isArchived: true,
      archivadoEn: ctx.executedAtIso,
      motivoArchivo: MOTIVO_CIERRE_DOMINGO_9PM,
    };
  });

  const archivedCount = archivedIds.length;
  const existingOkIndex = currentLogs.findIndex(
    (log) => log.fecha_corte === ctx.fechaCorteDomingo && log.estado === 'OK'
  );

  // Idempotencia estricta: segunda ejecución el mismo domingo afecta 0 filas y NO duplica auditoría
  if (existingOkIndex >= 0 && archivedCount === 0) {
    const existingEntry = currentLogs[existingOkIndex]!;
    return {
      ok: true,
      skippedOutsideWindow: false,
      idempotentNoop: true,
      fechaCorteDomingo: ctx.fechaCorteDomingo,
      archivedCount: 0,
      surveysArchivedCount: 0,
      cronogramaArchivedCount: 0,
      archivedIds: [],
      updatedRecords,
      auditLogs: currentLogs,
      logEntry: existingEntry,
    };
  }

  const nextId =
    params.idGenerator?.() ||
    `cierre-${ctx.fechaCorteDomingo}-${Math.random().toString(36).slice(2, 10)}`;

  if (existingOkIndex >= 0) {
    const prev = currentLogs[existingOkIndex]!;
    const prevDiag = (prev.detalle_diagnostico || {}) as Record<string, unknown>;
    const updatedEntry: CierreSemanalLogEntry = {
      ...prev,
      ejecutado_en: ctx.executedAtIso,
      registros_archivados: prev.registros_archivados + archivedCount,
      detalle_diagnostico: {
        ...prevDiag,
        ultima_actualizacion_idempotente: ctx.executedAtIso,
        adicionales_archivados: archivedCount,
      },
    };
    currentLogs[existingOkIndex] = updatedEntry;
    return {
      ok: true,
      skippedOutsideWindow: false,
      idempotentNoop: false,
      fechaCorteDomingo: ctx.fechaCorteDomingo,
      archivedCount,
      surveysArchivedCount,
      cronogramaArchivedCount,
      archivedIds,
      updatedRecords,
      auditLogs: currentLogs,
      logEntry: updatedEntry,
    };
  }

  const newLogEntry: CierreSemanalLogEntry = {
    id: nextId,
    ejecutado_en: ctx.executedAtIso,
    fecha_corte: ctx.fechaCorteDomingo,
    registros_archivados: archivedCount,
    estado: 'OK',
    detalle_diagnostico: {
      zona_horaria: ctx.timeZone,
      hora_local_ejecucion: ctx.localFormattedTimestamp,
      motivo_archivo: MOTIVO_CIERRE_DOMINGO_9PM,
      surveys_archivadas: surveysArchivedCount,
      cronograma_archivadas: cronogramaArchivedCount,
      modo_forzado: forceRun,
    },
  };

  currentLogs.push(newLogEntry);

  return {
    ok: true,
    skippedOutsideWindow: false,
    idempotentNoop: false,
    fechaCorteDomingo: ctx.fechaCorteDomingo,
    archivedCount,
    surveysArchivedCount,
    cronogramaArchivedCount,
    archivedIds,
    updatedRecords,
    auditLogs: currentLogs,
    logEntry: newLogEntry,
  };
}

function resolveShiftSortRank(shift?: string | null, turnoRaw?: string | null): number {
  const token = `${turnoRaw || ''} ${shift || ''}`.toUpperCase();
  if (token.includes('MAÑANA') || token.includes('MANANA')) return 1;
  if (token.includes('COMPLETO')) return 2;
  if (token.includes('TARDE')) return 3;
  return 4;
}

/**
 * Filtro defensivo y ordenamiento cronológico (`fecha ASC`, luego jornada/hora) para la pestaña activa `Degustaciones`.
 */
export function selectActiveDegustacionesTabItems<
  T extends {
    id: string;
    date?: string | null;
    shift?: string | null;
    turnoRaw?: string | null;
    timeRange?: string | null;
    createdAt?: string | null;
    enHistorial?: boolean | null;
    isArchived?: boolean | null;
  },
>(items: readonly T[]): T[] {
  return items
    .filter((item) => !isTastingInHistorial(item))
    .sort((a, b) => {
      const dateA = resolveCanonicalEventDateYmd(a.date) || '9999-12-31';
      const dateB = resolveCanonicalEventDateYmd(b.date) || '9999-12-31';
      if (dateA !== dateB) {
        return dateA.localeCompare(dateB);
      }
      const rankDiff =
        resolveShiftSortRank(a.shift, a.turnoRaw) - resolveShiftSortRank(b.shift, b.turnoRaw);
      if (rankDiff !== 0) return rankDiff;
      const timeCmp = String(a.timeRange || '').localeCompare(String(b.timeRange || ''));
      if (timeCmp !== 0) return timeCmp;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
}

/**
 * Filtro estricto (`en_historial = true`) y ordenamiento por fecha descendente (`fecha DESC`) para la pestaña `Historial`.
 */
export function selectHistorialTabItems<
  T extends {
    id: string;
    date?: string | null;
    archivadoEn?: string | null;
    createdAt?: string | null;
    enHistorial?: boolean | null;
    isArchived?: boolean | null;
  },
>(items: readonly T[]): T[] {
  return items
    .filter((item) => isTastingInHistorial(item))
    .sort((a, b) => {
      const dateA = resolveCanonicalEventDateYmd(a.date) || '0000-00-00';
      const dateB = resolveCanonicalEventDateYmd(b.date) || '0000-00-00';
      if (dateB !== dateA) {
        return dateB.localeCompare(dateA);
      }
      const archCmp = String(b.archivadoEn || '').localeCompare(String(a.archivadoEn || ''));
      if (archCmp !== 0) return archCmp;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
}

/**
 * Paginación defensiva en memoria para la pestaña `Historial`.
 */
export function paginateHistorialItems<T>(
  items: readonly T[],
  requestedPage: number,
  requestedPageSize = 25
): PaginatedSliceResult<T> {
  const pageSize = Math.max(1, Math.min(200, Math.floor(Number(requestedPageSize) || 25)));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.max(1, Math.min(totalPages, Math.floor(Number(requestedPage) || 1)));

  if (totalItems === 0) {
    return {
      items: [],
      page: 1,
      pageSize,
      totalItems: 0,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
    };
  }

  const offset = (safePage - 1) * pageSize;
  const sliced = items.slice(offset, offset + pageSize);

  return {
    items: sliced,
    page: safePage,
    pageSize,
    totalItems,
    totalPages,
    startIndex: offset + 1,
    endIndex: offset + sliced.length,
  };
}
