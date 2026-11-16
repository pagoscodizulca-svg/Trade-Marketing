import { normalizeExcelDate } from './excelDateNormalizer';

// ============================================================================
// MOTOR PURO DE CICLO SEMANAL ISO EN ZONA OFICIAL `America/Caracas` (UTC-4)
// Reglas Estrictas de Precisión Temporal:
//   1. Evaluado exclusivamente con `Intl.DateTimeFormat` (`timeZone: 'America/Caracas'`),
//      independiente del huso horario del navegador o del UTC sin conversión del servidor.
//   2. Semana ISO en curso:
//      - Inicia:  Lunes   00:00:00.000 (`America/Caracas`)
//      - Culmina: Domingo 23:59:59.999 (`America/Caracas`)
//   3. Partición automática disjunta (cero duplicados, cero pérdida):
//      - Bandeja de Entrada (`BANDEJA_ENTRADA`): `fecha_evento >= inicio_semana_actual`
//      - Pestaña Historial  (`HISTORIAL`):       `fecha_evento <  inicio_semana_actual`
// ============================================================================

export const OFFICIAL_CARACAS_TIMEZONE = 'America/Caracas' as const;
export const MAX_SAFE_TIMEOUT_MS = 2_147_483_647; // Límite entero firmado 32-bit para setTimeout

export type CaracasWeeklyBucket = 'BANDEJA_ENTRADA' | 'HISTORIAL';

export interface CaracasWallClockParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
  millisecond: number; // 0..999
  ymd: string; // YYYY-MM-DD
}

export interface CaracasWeekCycleBounds {
  timeZone: typeof OFFICIAL_CARACAS_TIMEZONE;
  evaluatedAtUtcMs: number;
  todayCaracasYmd: string;
  caracasWallTimeIso: string;
  isoWeekday: number; // 1 (Lunes) .. 7 (Domingo)
  isoWeekNumber: number;
  isoWeekYear: number;
  inicioSemanaActualYmd: string; // Lunes YYYY-MM-DD
  finSemanaActualYmd: string; // Domingo YYYY-MM-DD
  inicioSemanaActualCaracasIso: string; // YYYY-MM-DDT00:00:00.000-04:00
  finSemanaActualCaracasIso: string; // YYYY-MM-DDT23:59:59.999-04:00
  inicioSemanaActualUtcMs: number; // Epoch UTC ms exacto de Lunes 00:00:00.000 Caracas
  finSemanaActualUtcMs: number; // Epoch UTC ms exacto de Domingo 23:59:59.999 Caracas
  nextMondayYmd: string; // Próximo Lunes YYYY-MM-DD
  nextRolloverUtcMs: number; // Epoch UTC ms exacto del próximo Lunes 00:00:00.000 Caracas
  msUntilNextRollover: number;
}

const CARACAS_PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: OFFICIAL_CARACAS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function formatUtcAnchorToYmd(utcAnchor: Date): string {
  return `${utcAnchor.getUTCFullYear()}-${pad2(utcAnchor.getUTCMonth() + 1)}-${pad2(
    utcAnchor.getUTCDate()
  )}`;
}

/**
 * Valida que una cadena `YYYY-MM-DD` corresponda a una fecha real del calendario gregoriano
 * (rechazando fechas imposibles como `2026-02-30` o `2026-13-01`).
 */
export function isValidIsoCalendarDateYmd(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function toInstantDate(instant: Date | number | string = new Date()): Date {
  const dt = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant);
  if (Number.isNaN(dt.getTime())) {
    throw new Error('Instante temporal inválido para cálculo de ciclo semanal en America/Caracas.');
  }
  return dt;
}

/**
 * Extrae las partes exactas de fecha y hora mural en `America/Caracas` mediante `Intl.DateTimeFormat`.
 */
export function extractCaracasWallClockParts(
  instant: Date | number | string = new Date()
): CaracasWallClockParts {
  const dt = toInstantDate(instant);
  const parts = CARACAS_PARTS_FORMATTER.formatToParts(dt);

  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        if (hour === 24) hour = 0;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }

  const millisecond = dt.getUTCMilliseconds();
  const ymd = `${year}-${pad2(month)}-${pad2(day)}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    ymd,
  };
}

/**
 * Resuelve el epoch UTC exacto (en milisegundos) correspondiente a las `00:00:00.000`
 * de una fecha `YYYY-MM-DD` en la zona IANA `America/Caracas`.
 */
export function resolveCaracasLocalMidnightUtcMs(ymd: string): number {
  if (!isValidIsoCalendarDateYmd(ymd)) {
    throw new Error(`Fecha ISO inválida para medianoche America/Caracas: "${ymd}".`);
  }
  const [year, month, day] = ymd.split('-').map(Number);
  // Semilla inicial en UTC-04:00 (04:00:00.000Z) y ajuste exacto vía Intl.DateTimeFormat
  let guessUtcMs = Date.UTC(year, month - 1, day, 4, 0, 0, 0);
  const observed = extractCaracasWallClockParts(guessUtcMs);
  const observedPseudoUtcMs = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute,
    observed.second,
    observed.millisecond
  );
  const targetPseudoUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  guessUtcMs -= observedPseudoUtcMs - targetPseudoUtcMs;
  return guessUtcMs;
}

function computeIsoWeekNumberAndYear(
  year: number,
  month: number,
  day: number
): { isoWeekNumber: number; isoWeekYear: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7; // 1 = Lunes .. 7 = Domingo
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoWeekYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoWeekYear, 0, 1));
  const isoWeekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { isoWeekNumber, isoWeekYear };
}

/**
 * Calcula los límites exactos de la Semana ISO en Curso en `America/Caracas`:
 * - Inicio:  Lunes   `00:00:00.000` (`America/Caracas`)
 * - Término: Domingo `23:59:59.999` (`America/Caracas`)
 */
export function getCaracasWeekCycleBounds(
  instant: Date | number | string = new Date()
): CaracasWeekCycleBounds {
  const dt = toInstantDate(instant);
  const evaluatedAtUtcMs = dt.getTime();
  const parts = extractCaracasWallClockParts(dt);

  const calendarUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const utcDay = calendarUtc.getUTCDay(); // 0 = Domingo .. 6 = Sábado
  const isoWeekday = utcDay === 0 ? 7 : utcDay; // 1 = Lunes .. 7 = Domingo

  const mondayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - (isoWeekday - 1)));
  const sundayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + (7 - isoWeekday)));
  const nextMondayUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day - (isoWeekday - 1) + 7)
  );

  const inicioSemanaActualYmd = formatUtcAnchorToYmd(mondayUtc);
  const finSemanaActualYmd = formatUtcAnchorToYmd(sundayUtc);
  const nextMondayYmd = formatUtcAnchorToYmd(nextMondayUtc);

  const inicioSemanaActualUtcMs = resolveCaracasLocalMidnightUtcMs(inicioSemanaActualYmd);
  const nextRolloverUtcMs = resolveCaracasLocalMidnightUtcMs(nextMondayYmd);
  const finSemanaActualUtcMs = nextRolloverUtcMs - 1;
  const { isoWeekNumber, isoWeekYear } = computeIsoWeekNumberAndYear(
    parts.year,
    parts.month,
    parts.day
  );

  const caracasWallTimeIso = `${parts.ymd}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(
    parts.second
  )}.${pad3(parts.millisecond)}-04:00`;

  return {
    timeZone: OFFICIAL_CARACAS_TIMEZONE,
    evaluatedAtUtcMs,
    todayCaracasYmd: parts.ymd,
    caracasWallTimeIso,
    isoWeekday,
    isoWeekNumber,
    isoWeekYear,
    inicioSemanaActualYmd,
    finSemanaActualYmd,
    inicioSemanaActualCaracasIso: `${inicioSemanaActualYmd}T00:00:00.000-04:00`,
    finSemanaActualCaracasIso: `${finSemanaActualYmd}T23:59:59.999-04:00`,
    inicioSemanaActualUtcMs,
    finSemanaActualUtcMs,
    nextMondayYmd,
    nextRolloverUtcMs,
    msUntilNextRollover: Math.max(0, nextRolloverUtcMs - evaluatedAtUtcMs),
  };
}

/**
 * Normaliza la fecha del evento de degustación (`surveys.date`, `comments.date` o `cronograma_degustaciones.fecha`)
 * hacia su fecha calendario `YYYY-MM-DD` en `America/Caracas`:
 * - Fechas calendario puras (`YYYY-MM-DD`, `DD/MM/YYYY` o `YYYY-MM-DDT00:00:00Z`) conservan su día exacto.
 * - Timestamps reales con hora y zona (`TIMESTAMPTZ`, ej. `2026-11-16T03:59:59Z`) se proyectan a `America/Caracas`.
 */
export function resolveTastingEventCaracasYmd(
  rawDate: unknown,
  fallbackDate?: unknown
): string | null {
  const trySingle = (candidate: unknown): string | null => {
    if (candidate === null || candidate === undefined) return null;

    if (candidate instanceof Date) {
      if (Number.isNaN(candidate.getTime())) return null;
      return extractCaracasWallClockParts(candidate).ymd;
    }

    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (!trimmed) return null;

      // 1. Fecha calendario pura YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return isValidIsoCalendarDateYmd(trimmed) ? trimmed : null;
      }

      // 2. Placeholder calendario a medianoche exacta YYYY-MM-DDT00:00:00(.000)?(Z|+00:00)
      const midnightCalendarMatch = trimmed.match(
        /^(\d{4}-\d{2}-\d{2})[T\s]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?$/i
      );
      if (midnightCalendarMatch?.[1]) {
        return isValidIsoCalendarDateYmd(midnightCalendarMatch[1])
          ? midnightCalendarMatch[1]
          : null;
      }

      // 3. Timestamp real con hora y desplazamiento horario explícito -> proyectar a America/Caracas
      if (
        /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(trimmed) &&
        /(?:Z|[+-]\d{2}:?\d{2}|[+-]\d{2})$/i.test(trimmed)
      ) {
        const normalizedOffset = /[+-]\d{2}$/.test(trimmed) ? `${trimmed}:00` : trimmed;
        const parsedTs = new Date(normalizedOffset);
        if (!Number.isNaN(parsedTs.getTime())) {
          return extractCaracasWallClockParts(parsedTs).ymd;
        }
      }

      // 4. Timestamp local sin sufijo de zona (ej. '2026-11-15 14:30:00' ya expresado en hora local)
      const localDateTimePrefix = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T\s]\d{2}:\d{2}/);
      if (localDateTimePrefix?.[1] && isValidIsoCalendarDateYmd(localDateTimePrefix[1])) {
        return localDateTimePrefix[1];
      }
    }

    const normalized = normalizeExcelDate(candidate);
    if (normalized.isValid && normalized.fechaIso && isValidIsoCalendarDateYmd(normalized.fechaIso)) {
      return normalized.fechaIso;
    }

    return null;
  };

  return trySingle(rawDate) ?? trySingle(fallbackDate);
}

/**
 * Clasifica de forma determinista y sin duplicados una degustación según el ciclo semanal ISO
 * en `America/Caracas`:
 * - `fecha_evento >= inicio_semana_actual` -> `'BANDEJA_ENTRADA'`
 * - `fecha_evento <  inicio_semana_actual` -> `'HISTORIAL'`
 */
export function classifyTastingByCaracasWeek(
  rawEventDate: unknown,
  referenceNow: Date | number | string = new Date(),
  fallbackDate?: unknown
): {
  bucket: CaracasWeeklyBucket;
  eventDateYmd: string | null;
  bounds: CaracasWeekCycleBounds;
} {
  const bounds = getCaracasWeekCycleBounds(referenceNow);
  const eventDateYmd = resolveTastingEventCaracasYmd(rawEventDate, fallbackDate);

  // Si un registro en tránsito carece de fecha parseable, permanece visible en Bandeja de Entrada para revisión
  if (!eventDateYmd) {
    return {
      bucket: 'BANDEJA_ENTRADA',
      eventDateYmd: null,
      bounds,
    };
  }

  return {
    bucket: eventDateYmd < bounds.inicioSemanaActualYmd ? 'HISTORIAL' : 'BANDEJA_ENTRADA',
    eventDateYmd,
    bounds,
  };
}

export function isTastingInPastCaracasWeek(
  rawEventDate: unknown,
  referenceNow: Date | number | string = new Date(),
  fallbackDate?: unknown
): boolean {
  return classifyTastingByCaracasWeek(rawEventDate, referenceNow, fallbackDate).bucket === 'HISTORIAL';
}

export function isTastingInCurrentOrFutureCaracasWeek(
  rawEventDate: unknown,
  referenceNow: Date | number | string = new Date(),
  fallbackDate?: unknown
): boolean {
  return (
    classifyTastingByCaracasWeek(rawEventDate, referenceNow, fallbackDate).bucket ===
    'BANDEJA_ENTRADA'
  );
}

function getShiftSortOrder(shift?: string | null): number {
  const norm = String(shift || '').trim().toUpperCase();
  if (norm === 'MAÑANA' || norm === 'MANANA') return 1;
  if (norm === 'COMPLETO') return 2;
  if (norm === 'TARDE') return 3;
  return 4;
}

/**
 * Particiona una colección de degustaciones en `bandejaEntrada` (`>= inicio_semana_actual`, orden ASC)
 * e `historial` (`< inicio_semana_actual`, orden DESC), garantizando 0 duplicados y 0 pérdida de filas.
 */
export function partitionTastingsByCaracasWeek<
  T extends {
    id: string;
    date?: string | null;
    shift?: string | null;
    createdAt?: string | null;
    rawComments?: Record<string, unknown> | null;
  },
>(
  items: readonly T[],
  referenceNow: Date | number | string = new Date()
): {
  bandejaEntrada: T[];
  historial: T[];
  bounds: CaracasWeekCycleBounds;
} {
  const bounds = getCaracasWeekCycleBounds(referenceNow);
  const bandejaEntrada: T[] = [];
  const historial: T[] = [];
  const resolvedDates = new Map<string, string>();

  for (const item of items) {
    const fallback = item.rawComments?.date ?? item.rawComments?.fecha ?? item.createdAt;
    const ymd = resolveTastingEventCaracasYmd(item.date, fallback);
    if (ymd) {
      resolvedDates.set(item.id, ymd);
    }
    if (ymd && ymd < bounds.inicioSemanaActualYmd) {
      historial.push(item);
    } else {
      bandejaEntrada.push(item);
    }
  }

  bandejaEntrada.sort((a, b) => {
    const dA = resolvedDates.get(a.id) || '9999-12-31';
    const dB = resolvedDates.get(b.id) || '9999-12-31';
    if (dA !== dB) return dA.localeCompare(dB);
    const shiftDiff = getShiftSortOrder(a.shift) - getShiftSortOrder(b.shift);
    if (shiftDiff !== 0) return shiftDiff;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });

  historial.sort((a, b) => {
    const dA = resolvedDates.get(a.id) || '0000-00-00';
    const dB = resolvedDates.get(b.id) || '0000-00-00';
    if (dB !== dA) return dB.localeCompare(dA);
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });

  return {
    bandejaEntrada,
    historial,
    bounds,
  };
}

/**
 * Calcula un rango limpio de semanas anteriores cerradas (ej. `weeksBack = 1` -> Semana Pasada Lun..Dom;
 * `weeksBack = 4` -> Últimas 4 Semanas cerradas) evaluado en `America/Caracas`.
 */
export function getPastCaracasWeeksRange(
  weeksBack = 1,
  referenceNow: Date | number | string = new Date()
): {
  dateFromYmd: string;
  dateToYmd: string;
  inicioSemanaActualYmd: string;
} {
  const safeWeeks = Math.max(1, Math.min(52, Math.floor(weeksBack)));
  const bounds = getCaracasWeekCycleBounds(referenceNow);
  const [monY, monM, monD] = bounds.inicioSemanaActualYmd.split('-').map(Number);

  const fromUtc = new Date(Date.UTC(monY, monM - 1, monD - safeWeeks * 7));
  const toUtc = new Date(Date.UTC(monY, monM - 1, monD - 1));

  return {
    dateFromYmd: formatUtcAnchorToYmd(fromUtc),
    dateToYmd: formatUtcAnchorToYmd(toUtc),
    inicioSemanaActualYmd: bounds.inicioSemanaActualYmd,
  };
}

// ============================================================================
// FLUJO DIARIO `America/Caracas` (`UTC-4`) Y ETIQUETA OFICIAL `NO_AUTORIZADA`
// - Bandeja de Entrada: `fecha >= hoy_caracas` y NO descartada (`NO_AUTORIZADA`)
// - Pestaña Historial:  `fecha <  hoy_caracas` o descartada (`NO_AUTORIZADA`)
//   - Si fue aprobada -> conserva etiqueta `Autorizada` (o estado de ejecución)
//   - Si NO fue aprobada (pasó la fecha sin aprobarse o se descartó) -> `No Autorizada`
// ============================================================================

export type TastingAuthorizationBadgeState = 'AUTORIZADA' | 'NO_AUTORIZADA' | 'PENDIENTE';

export function getCaracasTodayYmd(instant: Date | number | string = new Date()): string {
  return extractCaracasWallClockParts(instant).ymd;
}

export function getMsUntilNextCaracasMidnight(
  instant: Date | number | string = new Date()
): number {
  const dt = toInstantDate(instant);
  const parts = extractCaracasWallClockParts(dt);
  const nextDayUtcAnchor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const tomorrowYmd = formatUtcAnchorToYmd(nextDayUtcAnchor);
  const nextMidnightUtcMs = resolveCaracasLocalMidnightUtcMs(tomorrowYmd);
  return Math.max(0, nextMidnightUtcMs - dt.getTime());
}

export function isTastingBeforeTodayCaracas(
  rawEventDate: unknown,
  referenceNow: Date | number | string = new Date(),
  fallbackDate?: unknown
): boolean {
  const todayCaracasYmd = getCaracasTodayYmd(referenceNow);
  const eventDateYmd = resolveTastingEventCaracasYmd(rawEventDate, fallbackDate);
  if (!eventDateYmd) return false;
  return eventDateYmd < todayCaracasYmd;
}

export function resolveTastingAuthorizationState(params: {
  rawEstado?: unknown;
  statusUi?: string | null;
  rawEventDate?: unknown;
  fallbackDate?: unknown;
  referenceNow?: Date | number | string;
}): {
  authorizationState: TastingAuthorizationBadgeState;
  eventDateYmd: string | null;
  todayCaracasYmd: string;
  isPastDateCaracas: boolean;
  belongsToHistorial: boolean;
} {
  const todayCaracasYmd = getCaracasTodayYmd(params.referenceNow ?? new Date());
  const eventDateYmd = resolveTastingEventCaracasYmd(params.rawEventDate, params.fallbackDate);
  const isPastDateCaracas = Boolean(eventDateYmd && eventDateYmd < todayCaracasYmd);

  const rawToken = String(params.rawEstado ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  const uiToken = String(params.statusUi ?? '')
    .trim()
    .toUpperCase();

  if (
    rawToken === 'NO_AUTORIZADA' ||
    rawToken === 'NO_AUTORIZADO' ||
    rawToken === 'RECHAZADA' ||
    rawToken === 'RECHAZADO' ||
    rawToken === 'CANCELADA' ||
    rawToken === 'CANCELADO' ||
    uiToken === 'NO_AUTORIZADA'
  ) {
    return {
      authorizationState: 'NO_AUTORIZADA',
      eventDateYmd,
      todayCaracasYmd,
      isPastDateCaracas,
      belongsToHistorial: true,
    };
  }

  if (
    rawToken === 'APROBADA' ||
    rawToken === 'APROBADO' ||
    rawToken === 'AUTORIZADA' ||
    rawToken === 'AUTORIZADO' ||
    rawToken === 'ACEPTADA' ||
    rawToken === 'PROGRAMADA' ||
    rawToken === 'CONFIRMADA' ||
    rawToken === 'EN_CURSO' ||
    rawToken === 'COMPLETADA' ||
    rawToken === 'REALIZADA' ||
    rawToken === 'EJECUTADA' ||
    uiToken === 'PROGRAMADO' ||
    uiToken === 'EN_CURSO' ||
    uiToken === 'COMPLETADO'
  ) {
    return {
      authorizationState: 'AUTORIZADA',
      eventDateYmd,
      todayCaracasYmd,
      isPastDateCaracas,
      belongsToHistorial: isPastDateCaracas,
    };
  }

  if (isPastDateCaracas) {
    return {
      authorizationState: 'NO_AUTORIZADA',
      eventDateYmd,
      todayCaracasYmd,
      isPastDateCaracas: true,
      belongsToHistorial: true,
    };
  }

  return {
    authorizationState: 'PENDIENTE',
    eventDateYmd,
    todayCaracasYmd,
    isPastDateCaracas: false,
    belongsToHistorial: false,
  };
}

/**
 * Partición determinista diaria en `America/Caracas` (`UTC-4`):
 * - `bandejaEntrada`: solicitudes y degustaciones vigentes o futuras (`fecha >= hoy_caracas`, incluyendo próximo lunes y siguientes) que NO fueron descartadas (`NO_AUTORIZADA`).
 * - `historial`: degustaciones cuya fecha ya pasó (`fecha < hoy_caracas`) O que fueron marcadas explícitamente como `No Autorizada` (`NO_AUTORIZADA`).
 * Garantiza 0 duplicados y 0 pérdida de registros.
 */
export function partitionTastingsByTodayAndAuthorization<
  T extends {
    id: string;
    date?: string | null;
    shift?: string | null;
    status?: string | null;
    createdAt?: string | null;
    rawComments?: Record<string, unknown> | null;
  },
>(
  items: readonly T[],
  referenceNow: Date | number | string = new Date()
): {
  bandejaEntrada: T[];
  historial: T[];
  bounds: CaracasWeekCycleBounds;
  todayCaracasYmd: string;
} {
  const bounds = getCaracasWeekCycleBounds(referenceNow);
  const todayCaracasYmd = bounds.todayCaracasYmd;
  const bandejaEntrada: T[] = [];
  const historial: T[] = [];
  const resolvedDates = new Map<string, string>();

  for (const item of items) {
    const fallback = item.rawComments?.date ?? item.rawComments?.fecha ?? item.createdAt;
    const rawEstado = item.rawComments?.estado ?? item.rawComments?.status;
    const resolved = resolveTastingAuthorizationState({
      rawEstado,
      statusUi: item.status,
      rawEventDate: item.date,
      fallbackDate: fallback,
      referenceNow,
    });

    if (resolved.eventDateYmd) {
      resolvedDates.set(item.id, resolved.eventDateYmd);
    }

    if (resolved.belongsToHistorial) {
      historial.push(item);
    } else {
      bandejaEntrada.push(item);
    }
  }

  bandejaEntrada.sort((a, b) => {
    const dA = resolvedDates.get(a.id) || '9999-12-31';
    const dB = resolvedDates.get(b.id) || '9999-12-31';
    if (dA !== dB) return dA.localeCompare(dB);
    const shiftDiff = getShiftSortOrder(a.shift) - getShiftSortOrder(b.shift);
    if (shiftDiff !== 0) return shiftDiff;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });

  historial.sort((a, b) => {
    const dA = resolvedDates.get(a.id) || '0000-00-00';
    const dB = resolvedDates.get(b.id) || '0000-00-00';
    if (dB !== dA) return dB.localeCompare(dA);
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });

  return {
    bandejaEntrada,
    historial,
    bounds,
    todayCaracasYmd,
  };
}
