/**
 * Módulo utilitario puro, inmutable y libre de efectos secundarios para la normalización
 * automática y silenciosa de fechas provenientes de Excel/CSV/JSON hacia `dd-mm-aaaa`,
 * separando la representación visual de la clave comparable interna en UTC.
 */

export const MAX_DATE_INPUT_LENGTH = 100;
const RAW_PRE_SLICE_LIMIT = 240;
const MS_PER_DAY = 86_400_000;
const END_OF_DAY_OFFSET_MS = 86_399_999; // 23:59:59.999
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30); // Compensa el offset Lotus 1-2-3 (>= 60)
const EXCEL_PRE_LEAP_EPOCH_UTC_MS = Date.UTC(1899, 11, 31); // Seriales 1..59 (ene-feb 1900)

export interface NormalizedExcelDate {
  readonly isValid: boolean;
  /** Formato visual exacto `dd-mm-aaaa` (ej. `"05-03-2026"`), o `""` si es vacía/inválida. */
  readonly fechaFormateada: string;
  /** Clave canónica interna `aaaa-mm-dd` para persistencia/ordenamiento, o `null` si es inválida. */
  readonly fechaIso: string | null;
  /** Timestamp numérico UTC a las `00:00:00.000` (`Date.UTC(y, m - 1, d)`), o `null` si es inválida. */
  readonly fechaTimestamp: number | null;
}

export interface NormalizeExcelDateOptions {
  /** Año de respaldo opcional únicamente para celdas parciales sin año (ej. `"08 nov"` o `"JUEVES 08"`). */
  readonly fallbackYear?: number;
  /** Mes de respaldo opcional (1..12) únicamente para celdas tipo `"JUEVES 08"`. */
  readonly fallbackMonth?: number;
  /** Si es `true`, rechaza cualquier mes > 12 en formatos `DD/MM/YYYY` sin inversión a `MM/DD/YYYY`. */
  readonly strictDdMmYyyy?: boolean;
}

export interface DateFilterCriteria {
  /** Filtro por día exacto (acepta `dd-mm-aaaa`, `aaaa-mm-dd`, `Date`, serial, etc.). */
  readonly fechaUnica?: unknown;
  /** Límite inferior inclusivo (`00:00:00.000` UTC). */
  readonly desde?: unknown;
  /** Límite superior inclusivo (`23:59:59.999` UTC). */
  readonly hasta?: unknown;
}

export interface NormalizedDateRangeBounds {
  readonly hasActiveFilter: boolean;
  readonly isFilterInvalid: boolean;
  readonly desdeMs: number | null;
  readonly hastaMs: number | null;
}

export const EMPTY_NORMALIZED_DATE: NormalizedExcelDate = Object.freeze({
  isValid: false,
  fechaFormateada: '',
  fechaIso: null,
  fechaTimestamp: null,
});

function createNullDictionary<T>(entries: ReadonlyArray<readonly [string, T]>): Readonly<Record<string, T>> {
  const dict = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    dict[key] = value;
  }
  return Object.freeze(dict);
}

/** Diccionario sin prototipo (anti-Prototype Pollution) para meses en español e inglés. */
const MONTH_MAP = createNullDictionary<number>([
  // Español
  ['enero', 1],
  ['ene', 1],
  ['febrero', 2],
  ['feb', 2],
  ['marzo', 3],
  ['mar', 3],
  ['abril', 4],
  ['abr', 4],
  ['mayo', 5],
  ['may', 5],
  ['junio', 6],
  ['jun', 6],
  ['julio', 7],
  ['jul', 7],
  ['agosto', 8],
  ['ago', 8],
  ['septiembre', 9],
  ['setiembre', 9],
  ['sep', 9],
  ['sept', 9],
  ['set', 9],
  ['octubre', 10],
  ['oct', 10],
  ['noviembre', 11],
  ['nov', 11],
  ['diciembre', 12],
  ['dic', 12],
  // Inglés (respaldo)
  ['january', 1],
  ['jan', 1],
  ['february', 2],
  ['march', 3],
  ['april', 4],
  ['apr', 4],
  ['june', 6],
  ['july', 7],
  ['august', 8],
  ['aug', 8],
  ['september', 9],
  ['october', 10],
  ['november', 11],
  ['december', 12],
  ['dec', 12],
]);

/** Días de la semana sin ambigüedad con meses (nota: `'mar'` se desambigua contextualmente). */
const WEEKDAY_MAP = createNullDictionary<true>([
  ['lunes', true],
  ['lun', true],
  ['martes', true],
  ['miercoles', true],
  ['mierc', true],
  ['mie', true],
  ['jueves', true],
  ['juev', true],
  ['jue', true],
  ['viernes', true],
  ['vier', true],
  ['vie', true],
  ['sabado', true],
  ['sab', true],
  ['domingo', true],
  ['dom', true],
  ['monday', true],
  ['mon', true],
  ['tuesday', true],
  ['tues', true],
  ['tue', true],
  ['wednesday', true],
  ['wed', true],
  ['thursday', true],
  ['thurs', true],
  ['thur', true],
  ['thu', true],
  ['friday', true],
  ['fri', true],
  ['saturday', true],
  ['sat', true],
  ['sunday', true],
  ['sun', true],
]);

const CONNECTOR_TOKENS = createNullDictionary<true>([
  ['de', true],
  ['del', true],
  ['el', true],
  ['la', true],
  ['ano', true],
  ['of', true],
  ['the', true],
  ['year', true],
]);

const NON_DATE_PLACEHOLDERS = createNullDictionary<true>([
  ['na', true],
  ['n/a', true],
  ['n.a.', true],
  ['s/f', true],
  ['sf', true],
  ['sin fecha', true],
  ['sinfecha', true],
  ['por definir', true],
  ['pendiente', true],
  ['null', true],
  ['undefined', true],
  ['none', true],
  ['-', true],
  ['--', true],
  ['---', true],
]);

/**
 * Sanitiza entradas textuales de fecha: elimina caracteres de control, zero-width y NBSP (`\u00A0`),
 * recorta espacios y aplica límite duro de 100 caracteres antes de cualquier evaluación regex (anti-ReDoS).
 */
export function sanitizeDateInput(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const bounded = raw.length > RAW_PRE_SLICE_LIMIT ? raw.slice(0, RAW_PRE_SLICE_LIMIT) : raw;
  const cleaned = bounded
    .replace(/[\u0000-\u001F\u007F-\u009F\u00A0\u1680\u2000-\u200D\u202F\u205F\u3000\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length > MAX_DATE_INPUT_LENGTH) {
    return '';
  }
  return cleaned;
}

function isValidCalendarYmd(year: number, month: number, day: number): boolean {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1900 ||
    year > 2199 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function buildValidResult(year: number, month: number, day: number): NormalizedExcelDate {
  if (!isValidCalendarYmd(year, month, day)) {
    return EMPTY_NORMALIZED_DATE;
  }
  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  const yyyy = String(year).padStart(4, '0');
  return Object.freeze({
    isValid: true,
    fechaFormateada: `${dd}-${mm}-${yyyy}`,
    fechaIso: `${yyyy}-${mm}-${dd}`,
    fechaTimestamp: Date.UTC(year, month - 1, day, 0, 0, 0, 0),
  });
}

function expandTwoDigitYear(rawYear: string): number {
  const numeric = Number(rawYear);
  if (!Number.isInteger(numeric) || numeric < 0) return -1;
  if (rawYear.length === 2) {
    return numeric <= 69 ? 2000 + numeric : 1900 + numeric;
  }
  return rawYear.length === 4 ? numeric : -1;
}

function parseExcelSerialNumber(serial: number): NormalizedExcelDate {
  if (!Number.isFinite(serial) || serial < 1 || serial > 110_000) {
    return EMPTY_NORMALIZED_DATE;
  }
  const wholeDays = Math.floor(serial + 1e-9);
  if (wholeDays === 60) {
    // El serial 60 corresponde al inexistente 29-02-1900 heredado de Lotus 1-2-3
    return EMPTY_NORMALIZED_DATE;
  }
  const epochMs = wholeDays < 60 ? EXCEL_PRE_LEAP_EPOCH_UTC_MS : EXCEL_EPOCH_UTC_MS;
  const utcDate = new Date(epochMs + wholeDays * MS_PER_DAY);
  if (Number.isNaN(utcDate.getTime())) {
    return EMPTY_NORMALIZED_DATE;
  }
  return buildValidResult(
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth() + 1,
    utcDate.getUTCDate()
  );
}

function parseDayToken(token: string): number {
  const m = /^(\d{1,2})(?:st|nd|rd|th|ro|er|do|to|mo|vo|no)?$/.exec(token);
  if (!m) return -1;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? n : -1;
}

function parseYearToken(token: string): number {
  if (!/^\d{2}(?:\d{2})?$/.test(token)) return -1;
  return expandTwoDigitYear(token);
}

function parseAlphaDateTokens(
  asciiLower: string,
  options?: NormalizeExcelDateOptions
): NormalizedExcelDate {
  // Retirar sufijo horario opcional al final (ej. "15 de noviembre de 2026 14:30:00")
  const withoutTime = asciiLower.replace(
    /\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?$/,
    ''
  );
  const rawTokens = withoutTime
    .replace(/[/\-.,;º°]+/g, ' ')
    .split(' ')
    .filter(Boolean);

  if (rawTokens.length === 0 || rawTokens.length > 10) {
    return EMPTY_NORMALIZED_DATE;
  }

  let idx = 0;
  let hadLeadingWeekday = false;
  const first = rawTokens[0]!;

  if (WEEKDAY_MAP[first]) {
    hadLeadingWeekday = true;
    idx = 1;
  } else if (first === 'mar' && rawTokens.length >= 2) {
    // Desambiguar "mar" inicial: si hay otro mes explícito más adelante es "martes", o si le sigue un día sin año en formato corto "MAR 08"
    const hasLaterMonth = rawTokens.slice(1).some((tok) => MONTH_MAP[tok] !== undefined);
    const isShortWeekdayDay = rawTokens.length === 2 && parseDayToken(rawTokens[1]!) > 0;
    if (hasLaterMonth || (isShortWeekdayDay && options?.fallbackMonth !== undefined)) {
      hadLeadingWeekday = true;
      idx = 1;
    }
  }

  const core: string[] = [];
  for (let i = idx; i < rawTokens.length; i++) {
    const tok = rawTokens[i]!;
    if (CONNECTOR_TOKENS[tok]) continue;
    core.push(tok);
  }

  if (core.length === 3) {
    const [t0, t1, t2] = core as [string, string, string];

    // Caso A: Día + Mes en letras + Año ("5 de marzo de 2026", "05/sep./26", "14 aug 2026")
    const monthMiddle = MONTH_MAP[t1];
    if (monthMiddle !== undefined) {
      const dd = parseDayToken(t0);
      const yyyy = parseYearToken(t2);
      if (dd > 0 && yyyy > 0) {
        return buildValidResult(yyyy, monthMiddle, dd);
      }
      // Variante Año(4d) + Mes en letras + Día ("2026 nov 15")
      if (t0.length === 4) {
        const yyyyFirst = parseYearToken(t0);
        const ddLast = parseDayToken(t2);
        if (yyyyFirst > 0 && ddLast > 0) {
          return buildValidResult(yyyyFirst, monthMiddle, ddLast);
        }
      }
    }

    // Caso B: Mes en letras + Día + Año ("Marzo 5, 2026", "August 14th, 2026")
    const monthFirst = MONTH_MAP[t0];
    if (monthFirst !== undefined) {
      const dd = parseDayToken(t1);
      const yyyy = parseYearToken(t2);
      if (dd > 0 && yyyy > 0) {
        return buildValidResult(yyyy, monthFirst, dd);
      }
    }
  }

  // Casos parciales silenciosos cuando la hoja omite el año (ej. "08 NOV" o "JUEVES 08")
  if (core.length === 2 && options?.fallbackYear) {
    const [t0, t1] = core as [string, string];
    const mSecond = MONTH_MAP[t1];
    if (mSecond !== undefined) {
      const dd = parseDayToken(t0);
      if (dd > 0) return buildValidResult(options.fallbackYear, mSecond, dd);
    }
    const mFirst = MONTH_MAP[t0];
    if (mFirst !== undefined) {
      const dd = parseDayToken(t1);
      if (dd > 0) return buildValidResult(options.fallbackYear, mFirst, dd);
    }
  }

  if (
    core.length === 1 &&
    (hadLeadingWeekday || /^\d{1,2}$/.test(core[0]!)) &&
    options?.fallbackYear &&
    options?.fallbackMonth
  ) {
    const dd = parseDayToken(core[0]!);
    if (dd > 0) {
      return buildValidResult(options.fallbackYear, options.fallbackMonth, dd);
    }
  }

  return EMPTY_NORMALIZED_DATE;
}

/**
 * Transforma de forma 100% automática, determinista y silenciosa cualquier celda de fecha de Excel
 * al contrato `{ isValid, fechaFormateada: "dd-mm-aaaa", fechaIso: "aaaa-mm-dd", fechaTimestamp }`.
 * Nunca lanza excepciones no controladas.
 */
export function normalizeExcelDate(
  rawInput: unknown,
  options?: NormalizeExcelDateOptions
): NormalizedExcelDate {
  try {
    if (rawInput === null || rawInput === undefined) {
      return EMPTY_NORMALIZED_DATE;
    }

    // 1. Validación estricta de tipos (prevención de Prototype Pollution y coerción de objetos)
    if (typeof rawInput === 'number') {
      return parseExcelSerialNumber(rawInput);
    }

    if (rawInput instanceof Date) {
      const time = rawInput.getTime();
      if (Number.isNaN(time)) {
        return EMPTY_NORMALIZED_DATE;
      }
      const isExactUtcMidnight =
        rawInput.getUTCHours() === 0 &&
        rawInput.getUTCMinutes() === 0 &&
        rawInput.getUTCSeconds() === 0 &&
        rawInput.getUTCMilliseconds() === 0;
      const isExactLocalMidnight =
        rawInput.getHours() === 0 &&
        rawInput.getMinutes() === 0 &&
        rawInput.getSeconds() === 0 &&
        rawInput.getMilliseconds() === 0;

      const useLocalComponents = !isExactUtcMidnight && isExactLocalMidnight;
      const year = useLocalComponents ? rawInput.getFullYear() : rawInput.getUTCFullYear();
      const month = useLocalComponents ? rawInput.getMonth() + 1 : rawInput.getUTCMonth() + 1;
      const day = useLocalComponents ? rawInput.getDate() : rawInput.getUTCDate();
      return buildValidResult(year, month, day);
    }

    if (typeof rawInput !== 'string') {
      return EMPTY_NORMALIZED_DATE;
    }

    const cleaned = sanitizeDateInput(rawInput);
    if (!cleaned) {
      return EMPTY_NORMALIZED_DATE;
    }

    const asciiLower = cleaned
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (NON_DATE_PLACEHOLDERS[asciiLower]) {
      return EMPTY_NORMALIZED_DATE;
    }

    // 2. Número serial de Excel almacenado como texto (ej. "46337", "46337.54", "46337,54")
    if (/^\d{5}(?:[.,]\d{1,10})?$/.test(asciiLower)) {
      const numericSerial = Number(asciiLower.replace(',', '.'));
      return parseExcelSerialNumber(numericSerial);
    }

    // 3. Formato ISO 8601 con o sin timestamp ("2026-11-15", "2026/11/15", "2026-11-15T00:00:00.000Z")
    const isoMatch = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[t\s].*)?$/.exec(asciiLower);
    if (isoMatch) {
      return buildValidResult(
        Number(isoMatch[1]),
        Number(isoMatch[2]),
        Number(isoMatch[3])
      );
    }

    // 4. Cadenas numéricas con separadores mixtos: prioridad local dd-mm-aaaa; mm-dd-aaaa solo cuando bloque2 > 12
    const numericMatch =
      /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)?$/.exec(
        asciiLower
      );
    if (numericMatch) {
      const first = Number(numericMatch[1]);
      const second = Number(numericMatch[2]);
      const year = expandTwoDigitYear(numericMatch[3]!);
      if (year < 0) return EMPTY_NORMALIZED_DATE;

      if (first >= 1 && first <= 31 && second >= 1 && second <= 12) {
        return buildValidResult(year, second, first);
      }
      if (!options?.strictDdMmYyyy && first >= 1 && first <= 12 && second > 12 && second <= 31) {
        return buildValidResult(year, first, second);
      }
      return EMPTY_NORMALIZED_DATE;
    }

    // Formato corto numérico DD/MM sin año cuando se provee año de respaldo
    if (options?.fallbackYear) {
      const shortDm = /^(\d{1,2})[/\-](\d{1,2})$/.exec(asciiLower);
      if (shortDm) {
        const d = Number(shortDm[1]);
        const m = Number(shortDm[2]);
        if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
          return buildValidResult(options.fallbackYear, m, d);
        }
      }
    }

    // 5. Fechas en letras en español e inglés (completas o abreviadas, con o sin día de la semana)
    return parseAlphaDateTokens(asciiLower, options);
  } catch {
    return EMPTY_NORMALIZED_DATE;
  }
}

/**
 * Devuelve directamente la fecha visual `dd-mm-aaaa` o `fallback` (`""` por defecto) de forma silenciosa.
 */
export function formatToDdMmYyyy(rawInput: unknown, fallback = ''): string {
  const parsed = normalizeExcelDate(rawInput);
  return parsed.isValid ? parsed.fechaFormateada : fallback;
}

/**
 * Normaliza los límites de un filtro de fecha única o rango (`desde` / `hasta`) usando exactamente
 * el mismo motor `normalizeExcelDate`, garantizando comparación matemática inclusiva:
 * `desde 00:00:00.000 UTC` <= `fechaRegistro` <= `hasta 23:59:59.999 UTC`.
 */
function isNonEmptyFilterInput(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string') return val.trim().length > 0;
  return typeof val === 'number' || val instanceof Date;
}

export function normalizeDateRangeBounds(criteria: DateFilterCriteria): NormalizedDateRangeBounds {
  try {
    if (isNonEmptyFilterInput(criteria.fechaUnica)) {
      const parsedSingle = normalizeExcelDate(criteria.fechaUnica);
      if (!parsedSingle.isValid || parsedSingle.fechaTimestamp === null) {
        return {
          hasActiveFilter: true,
          isFilterInvalid: true,
          desdeMs: null,
          hastaMs: null,
        };
      }
      return {
        hasActiveFilter: true,
        isFilterInvalid: false,
        desdeMs: parsedSingle.fechaTimestamp,
        hastaMs: parsedSingle.fechaTimestamp + END_OF_DAY_OFFSET_MS,
      };
    }

    const hasDesde = isNonEmptyFilterInput(criteria.desde);
    const hasHasta = isNonEmptyFilterInput(criteria.hasta);

    if (!hasDesde && !hasHasta) {
      return {
        hasActiveFilter: false,
        isFilterInvalid: false,
        desdeMs: null,
        hastaMs: null,
      };
    }

    const parsedDesde = hasDesde ? normalizeExcelDate(criteria.desde) : null;
    const parsedHasta = hasHasta ? normalizeExcelDate(criteria.hasta) : null;

    if ((hasDesde && !parsedDesde?.isValid) || (hasHasta && !parsedHasta?.isValid)) {
      return {
        hasActiveFilter: true,
        isFilterInvalid: true,
        desdeMs: null,
        hastaMs: null,
      };
    }

    let startDayMs = parsedDesde?.fechaTimestamp ?? null;
    let endDayMs = parsedHasta?.fechaTimestamp ?? null;

    // Si el usuario ingresó `desde > hasta`, ordenar automáticamente los extremos sin fallar
    if (startDayMs !== null && endDayMs !== null && startDayMs > endDayMs) {
      const swap = startDayMs;
      startDayMs = endDayMs;
      endDayMs = swap;
    }

    return {
      hasActiveFilter: true,
      isFilterInvalid: false,
      desdeMs: startDayMs,
      hastaMs: endDayMs !== null ? endDayMs + END_OF_DAY_OFFSET_MS : null,
    };
  } catch {
    return {
      hasActiveFilter: false,
      isFilterInvalid: false,
      desdeMs: null,
      hastaMs: null,
    };
  }
}

/**
 * Evalúa de forma segura y silenciosa si la fecha de un registro (timestamp numérico ya calculado
 * o cualquier valor crudo) cumple con el filtro de fecha única o rango inclusivo `desde` / `hasta`.
 */
export function matchesDateFilter(
  rowDateOrTimestamp: unknown,
  criteria: DateFilterCriteria,
  precomputedTimestamp?: number | null
): boolean {
  try {
    const bounds = normalizeDateRangeBounds(criteria);
    if (!bounds.hasActiveFilter) {
      return true;
    }
    if (bounds.isFilterInvalid) {
      return false;
    }

    const recordTs =
      typeof precomputedTimestamp === 'number' && Number.isFinite(precomputedTimestamp)
        ? precomputedTimestamp
        : normalizeExcelDate(rowDateOrTimestamp).fechaTimestamp;

    if (recordTs === null) {
      return false;
    }

    if (bounds.desdeMs !== null && recordTs < bounds.desdeMs) {
      return false;
    }
    if (bounds.hastaMs !== null && recordTs > bounds.hastaMs) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
