/**
 * Normalizador modular, puro, determinista e inmutable para fechas e importaciones tabulares
 * provenientes de Excel (.xlsx / .xls) y CSV (.csv) hacia PostgreSQL (`DATE` ISO `YYYY-MM-DD`).
 *
 * Garantías clave de ingeniería de datos y seguridad:
 * 1. Conversión de seriales numéricos de Excel 100% en UTC puro (compensando epoch 25569 días entre
 *    1899-12-30 y 1970-01-01 y modo opcional `date1904`) para evitar desfases de `-1 día` en `America/Caracas` (`UTC-4`).
 * 2. Prioridad estricta latinoamericana `DD/MM/YYYY` sobre `MM/DD/YYYY`, rechazando meses > 12 y
 *    fechas inexistentes en el calendario real (ej. `31/02/2026`, `29/02/2026`, `29/02/1900`).
 * 3. Extracción segura de instancias `Date` sin usar `.toISOString()` sobre horas locales.
 * 4. Normalización de encabezados inmune a espacios extras, tildes y conectores (`"Fecha de Degustación"`).
 * 5. Prevención de Prototype Pollution (`Object.create(null)` + bloqueo de `__proto__`, `constructor`, `prototype`)
 *    y sanitización contra Formula/CSV Injection (`=`, `+`, `-`, `@`, `\t`, `\r`).
 */

export const MAX_EXCEL_FILE_BYTES = 10 * 1024 * 1024; // 10 MB máximo para mitigar DoS
export const MAX_IMPORT_ROWS = 2000; // Máximo de filas de datos por lote
export const MAX_CELL_TEXT_CHARS = 250;
export const MAX_DATE_RAW_PREVIEW_CHARS = 80;

const MS_PER_DAY = 86_400_000;
const EXCEL_UNIX_EPOCH_OFFSET_DAYS = 25569; // Días entre 1899-12-30 y 1970-01-01 (seriales >= 60)
const EXCEL_PRE_LEAP_BUG_OFFSET_DAYS = 25568; // Ajuste para seriales 1..59 (ene-feb 1900)
const EXCEL_1904_MODE_OFFSET_DAYS = 1462; // Diferencia entre sistema 1900 y sistema 1904 (Mac)
const DEFAULT_MIN_YEAR = 1990;
const DEFAULT_MAX_YEAR = 2100;

export type ExcelDateErrorCode =
  | 'EMPTY'
  | 'EXCEL_FORMULA_ERROR'
  | 'INVALID_MONTH'
  | 'NON_EXISTENT_DAY'
  | 'OUT_OF_RANGE_YEAR'
  | 'UNRECOGNIZED_FORMAT';

export interface ExcelDateParseResult {
  readonly ok: boolean;
  /** Formato canónico exacto ISO `YYYY-MM-DD` requerido por columnas `DATE` en PostgreSQL, o `null`. */
  readonly isoDate: string | null;
  /** Formato visual regional `DD-MM-YYYY`, o `""` si es inválida. */
  readonly displayDate: string;
  /** Timestamp numérico en UTC puro `Date.UTC(year, month - 1, day)`, o `null`. */
  readonly timestampUtc: number | null;
  /** Vista previa sanitizada del valor recibido para reportar errores claros por fila. */
  readonly rawReceived: string;
  /** `true` únicamente cuando se completó año/mes con `fallbackYear`/`fallbackMonth` (ej. `"JUEVES 08"`). */
  readonly usedFallbackPeriod: boolean;
  readonly errorCode: ExcelDateErrorCode | null;
  readonly errorMessage: string | null;
}

export interface ExcelDateParserOptions {
  /** Activa compensación `+1462` días si el libro Excel usa el sistema de fechas 1904. */
  readonly date1904?: boolean;
  /** Año de respaldo opcional solo para textos parciales sin año (`"08 NOV"`, `"JUEVES 08"`). */
  readonly fallbackYear?: number;
  /** Mes de respaldo opcional (1..12) solo para textos parciales día-semana + número (`"JUEVES 08"`). */
  readonly fallbackMonth?: number;
  /** Año mínimo aceptado (por defecto `1990`). */
  readonly minYear?: number;
  /** Año máximo aceptado (por defecto `2100`). */
  readonly maxYear?: number;
  /**
   * Por defecto `false`: impone estrictamente el estándar latinoamericano `DD/MM/YYYY`
   * y rechaza cualquier mes > 12. Solo activar en `true` si se requiere rescate explícito `MM/DD/YYYY`.
   */
  readonly allowUsMmDdFallback?: boolean;
}

export interface NormalizedExcelHeader {
  /** Texto limpio con un solo espacio entre palabras y sin controles. */
  readonly cleanLabel: string;
  /** Texto normalizado en minúsculas, sin tildes y con espacios simples (ej. `"fecha de degustacion"`). */
  readonly normalizedLower: string;
  /** Clave alfanumérica en mayúsculas sin espacios ni tildes (ej. `"FECHADEDEGUSTACION"`). */
  readonly compactKey: string;
  /** Clave canónica sin conectores ni notas entre paréntesis (ej. `"FECHADEGUSTACION"`). */
  readonly canonicalKey: string;
  /** Tokens alfanuméricos individuales sin tildes en mayúsculas. */
  readonly tokens: readonly string[];
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Verifica si una clave dinámica representa riesgo de Prototype Pollution.
 */
export function isDangerousObjectKey(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  const trimmed = key.trim();
  const lower = trimmed.toLowerCase();
  return DANGEROUS_KEYS.has(trimmed) || DANGEROUS_KEYS.has(lower);
}

/**
 * Crea un diccionario seguro sin cadena de prototipos (`Object.create(null)`),
 * ignorando claves peligrosas (`__proto__`, `constructor`, `prototype`).
 */
export function createSafeNullMap<T>(
  entries: ReadonlyArray<readonly [string, T]> = []
): Record<string, T> {
  const map = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    if (!isDangerousObjectKey(key)) {
      map[key] = value;
    }
  }
  return map;
}

function createFrozenLookup<T>(
  entries: ReadonlyArray<readonly [string, T]>
): Readonly<Record<string, T>> {
  return Object.freeze(createSafeNullMap(entries));
}

const HEADER_STOPWORDS = createFrozenLookup<true>([
  ['DE', true],
  ['DEL', true],
  ['LA', true],
  ['LAS', true],
  ['EL', true],
  ['LOS', true],
  ['A', true],
  ['AL', true],
  ['EN', true],
  ['POR', true],
  ['PARA', true],
  ['CON', true],
  ['Y', true],
  ['O', true],
  ['OF', true],
  ['THE', true],
]);

const MONTH_MAP = createFrozenLookup<number>([
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
  ['agos', 8],
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
  // Inglés
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

const WEEKDAY_MAP = createFrozenLookup<true>([
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

const ALPHA_STOPWORDS = createFrozenLookup<true>([
  ['de', true],
  ['del', true],
  ['el', true],
  ['la', true],
  ['los', true],
  ['las', true],
  ['dia', true],
  ['ano', true],
  ['anio', true],
  ['the', true],
  ['of', true],
  ['on', true],
  ['st', true],
  ['nd', true],
  ['rd', true],
  ['th', true],
  ['am', true],
  ['pm', true],
  ['hrs', true],
]);

const EMPTY_PLACEHOLDERS = createFrozenLookup<true>([
  ['na', true],
  ['n/a', true],
  ['nd', true],
  ['n/d', true],
  ['s/f', true],
  ['sf', true],
  ['null', true],
  ['undefined', true],
  ['none', true],
  ['nan', true],
  ['sin fecha', true],
  ['sin definir', true],
  ['por definir', true],
  ['por asignar', true],
  ['pendiente', true],
  ['-', true],
  ['--', true],
  ['---', true],
]);

const EXCEL_FORMULA_ERROR_TOKENS = createFrozenLookup<true>([
  ['#VALUE!', true],
  ['#¡VALOR!', true],
  ['#VALOR!', true],
  ['#REF!', true],
  ['#¡REF!', true],
  ['#NAME?', true],
  ['#¿NOMBRE?', true],
  ['#NUM!', true],
  ['#¡NUM!', true],
  ['#N/A', true],
  ['#N/D', true],
  ['#DIV/0!', true],
  ['#¡DIV/0!', true],
  ['#NULL!', true],
  ['#¡NULO!', true],
  ['#ERROR!', true],
]);

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Remueve marcas diacríticas (tildes / diéresis) de forma determinista para comparaciones de texto.
 */
export function stripAccents(value: string): string {
  return stripDiacritics(String(value ?? ''));
}

const SORTED_MONTH_TOKENS = Object.freeze(
  Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length)
);

/**
 * Resuelve un token de mes en español o inglés (completo o abreviado, con o sin punto/tildes) a `1..12`.
 */
export function resolveMonthNameToken(rawToken: string): number | null {
  const normalized = stripDiacritics(String(rawToken ?? ''))
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .trim();
  if (!normalized || isDangerousObjectKey(normalized)) return null;
  const val = MONTH_MAP[normalized];
  return typeof val === 'number' ? val : null;
}

/**
 * Busca el primer nombre o abreviatura válida de mes (español/inglés) como palabra delimitada dentro de un texto
 * (ej. `"Noviembre 2026"`, `"Octubre_26"`, `"NOV2026"`, `"Planificacion_Sept.2026"`).
 */
export function findMonthInText(rawText: string): { month: number; matchedToken: string } | null {
  const asciiLower = stripDiacritics(String(rawText ?? '')).toLowerCase();
  if (!asciiLower.trim()) return null;

  for (const key of SORTED_MONTH_TOKENS) {
    // Delimitador no alfabético a izquierda y derecha (permite "nov2026", "octubre_26", "sept. 2026", "noviembre")
    const re = new RegExp(`(?:^|[^a-z])(${key})(?=[^a-z]|$)`);
    const match = asciiLower.match(re);
    if (match?.[1]) {
      const month = MONTH_MAP[key];
      if (typeof month === 'number') {
        return { month, matchedToken: match[1] };
      }
    }
  }
  return null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * Sanitiza textos libres provenientes de Excel/CSV contra caracteres de control, espacios redundantes
 * y ataques de Formula/CSV Injection (`=`, `+`, `-`, `@`, `\t`, `\r` al inicio), preservando
 * números negativos legítimos (`-3.5`) y fechas válidas (`2026-10-15`, `05-10-2026`).
 */
export function sanitizeSpreadsheetText(raw: unknown, maxLength = MAX_CELL_TEXT_CHARS): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'function' || typeof raw === 'symbol') return '';
  if (typeof raw === 'object' && !(raw instanceof Date)) return '';

  const limit = Math.max(1, maxLength);
  const rawStr = String(raw);

  // Detectar si antes de colapsar espacios la celda iniciaba con tabulación/retorno seguido de operador ejecutable
  const trimmedRawStart = rawStr.replace(/^[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]+/, '');
  const hadLeadingTabOrCrFormula = /^[\t\r]+\s*[=+\-@]/.test(trimmedRawStart);

  let cleaned = rawStr
    .replace(/[\u0000-\u001F\u007F-\u009F\u00A0\u200B-\u200D\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  if (hadLeadingTabOrCrFormula || /^[=+\-@]/.test(cleaned)) {
    const isLegitSignedNumber = /^[+-]?\d+(?:[.,]\d+)?$/.test(cleaned);
    const isLegitDatePattern =
      /^\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}$/.test(cleaned) ||
      /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(cleaned);

    if (!isLegitSignedNumber && !isLegitDatePattern) {
      cleaned = cleaned.replace(/^(?:[=+\-@]\s*)+/, '').trim();
    }
  }

  return cleaned.length > limit ? cleaned.slice(0, limit).trim() : cleaned;
}

/**
 * Normaliza encabezados de columnas de Excel/CSV aplicando `.trim()`, colapso de espacios múltiples,
 * remoción de tildes, descarte de pistas entre paréntesis (`(DD/MM/YYYY)`) y remoción de conectores
 * (`DE`, `DEL`, `LA`, `EL`), de modo que `"  Fecha   de   Degustación  "` converja en `"FECHADEGUSTACION"`.
 */
export function normalizeExcelHeader(rawHeader: unknown): NormalizedExcelHeader {
  const cleanLabel = sanitizeSpreadsheetText(rawHeader, 160);
  if (!cleanLabel || isDangerousObjectKey(cleanLabel)) {
    return Object.freeze({
      cleanLabel: '',
      normalizedLower: '',
      compactKey: '',
      canonicalKey: '',
      tokens: Object.freeze([]),
    });
  }

  // Remover pistas de formato entre paréntesis o corchetes: ej. "Fecha de Degustación (DD/MM/AAAA)"
  const withoutHints = cleanLabel.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  const upperAscii = stripDiacritics(withoutHints).toUpperCase();

  const tokens = upperAscii
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => Boolean(t) && !isDangerousObjectKey(t));

  const normalizedLower = tokens.join(' ').toLowerCase();

  const compactKey = stripDiacritics(cleanLabel)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const significantTokens = tokens.filter((tok) => !HEADER_STOPWORDS[tok]);
  const canonicalKey = (significantTokens.length > 0 ? significantTokens : tokens).join('');

  return Object.freeze({
    cleanLabel,
    normalizedLower,
    compactKey,
    canonicalKey,
    tokens: Object.freeze(tokens),
  });
}

const EXCLUDED_DATE_HEADER_KEYWORDS = ['VENCIMIENTO', 'NACIMIENTO', 'CREACION', 'REGISTRO', 'INGRESO', 'EMISION', 'FACTURA'];

/**
 * Determina si un encabezado normalizado corresponde a la columna de Fecha de Degustación.
 */
export function isFechaDegustacionHeader(
  header: NormalizedExcelHeader,
  explicitAliases: ReadonlyArray<string> = []
): boolean {
  if (!header.canonicalKey && !header.compactKey) return false;
  if (explicitAliases.includes(header.canonicalKey) || explicitAliases.includes(header.compactKey)) {
    return true;
  }

  const hasExcludedWord = header.tokens.some((t) => EXCLUDED_DATE_HEADER_KEYWORDS.includes(t));
  if (hasExcludedWord) return false;

  const firstToken = header.tokens[0] || '';
  if (firstToken === 'FECHA' || firstToken === 'FEC') {
    return true;
  }
  if (
    header.canonicalKey === 'DIA' ||
    header.canonicalKey === 'DIADEGUSTACION' ||
    header.canonicalKey === 'DATE' ||
    header.canonicalKey === 'TASTINGDATE'
  ) {
    return true;
  }

  return false;
}

function formatRawPreview(rawInput: unknown): string {
  if (rawInput === null || rawInput === undefined) return '';
  if (rawInput instanceof Date) {
    return Number.isNaN(rawInput.getTime()) ? 'Date(Invalid)' : `Date(${rawInput.getTime()})`;
  }
  if (typeof rawInput === 'number') {
    return Number.isFinite(rawInput) ? String(rawInput) : String(rawInput);
  }
  if (typeof rawInput === 'string') {
    const clean = rawInput
      .replace(/[\u0000-\u001F\u007F-\u009F\u00A0\u200B-\u200D\uFEFF]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clean.length > MAX_DATE_RAW_PREVIEW_CHARS
      ? `${clean.slice(0, MAX_DATE_RAW_PREVIEW_CHARS)}...`
      : clean;
  }
  return '';
}

function buildErrorResult(
  rawReceived: string,
  errorCode: ExcelDateErrorCode,
  errorMessage: string
): ExcelDateParseResult {
  return Object.freeze({
    ok: false,
    isoDate: null,
    displayDate: '',
    timestampUtc: null,
    rawReceived,
    usedFallbackPeriod: false,
    errorCode,
    errorMessage,
  });
}

function buildValidatedCalendarResult(params: {
  year: number;
  month: number;
  day: number;
  rawReceived: string;
  minYear: number;
  maxYear: number;
  usedFallbackPeriod?: boolean;
}): ExcelDateParseResult {
  const { year, month, day, rawReceived, minYear, maxYear, usedFallbackPeriod = false } = params;

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return buildErrorResult(
      rawReceived,
      'INVALID_MONTH',
      `El mes ${month} no es válido (debe estar entre 01 y 12 en formato DD/MM/AAAA).`
    );
  }

  if (!Number.isInteger(year) || year < minYear || year > maxYear) {
    return buildErrorResult(
      rawReceived,
      'OUT_OF_RANGE_YEAR',
      `El año ${year} está fuera del rango permitido (${minYear}–${maxYear}).`
    );
  }

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return buildErrorResult(
      rawReceived,
      'NON_EXISTENT_DAY',
      `El día ${day} no existe para el mes ${pad2(month)}/${pad4(year)}.`
    );
  }

  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const check = new Date(utcMs);
  if (
    Number.isNaN(utcMs) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return buildErrorResult(
      rawReceived,
      'NON_EXISTENT_DAY',
      `La fecha ${pad2(day)}/${pad2(month)}/${pad4(year)} no existe en el calendario real.`
    );
  }

  return Object.freeze({
    ok: true,
    isoDate: `${pad4(year)}-${pad2(month)}-${pad2(day)}`,
    displayDate: `${pad2(day)}-${pad2(month)}-${pad4(year)}`,
    timestampUtc: utcMs,
    rawReceived,
    usedFallbackPeriod,
    errorCode: null,
    errorMessage: null,
  });
}

function expandTwoDigitYear(rawYearToken: string): number {
  const parsed = Number(rawYearToken);
  if (!Number.isInteger(parsed) || parsed < 0) return -1;
  if (rawYearToken.length === 2) {
    return parsed <= 69 ? 2000 + parsed : 1900 + parsed;
  }
  if (rawYearToken.length === 4) {
    return parsed;
  }
  return -1;
}

function parseExcelSerialToUtc(
  serial: number,
  rawReceived: string,
  options: { date1904: boolean; minYear: number; maxYear: number }
): ExcelDateParseResult {
  if (!Number.isFinite(serial)) {
    return buildErrorResult(rawReceived, 'UNRECOGNIZED_FORMAT', 'Número serial de fecha inválido.');
  }

  const adjustedSerial = options.date1904 ? serial + EXCEL_1904_MODE_OFFSET_DAYS : serial;
  if (adjustedSerial < 1 || adjustedSerial > 2_958_465) {
    return buildErrorResult(
      rawReceived,
      'OUT_OF_RANGE_YEAR',
      `Serial numérico de Excel fuera de rango (${rawReceived}).`
    );
  }

  // Compensar mínima imprecisión flotante IEEE-754 en fracciones de hora (ej. 46310.9999999999)
  // sin cruzar al día siguiente cuando el serial tiene hora legítima como 46310.5
  const wholeDays = Math.floor(adjustedSerial + 1e-9);

  if (!options.date1904 && wholeDays === 60) {
    return buildErrorResult(
      rawReceived,
      'NON_EXISTENT_DAY',
      'El serial 60 de Excel corresponde al 29/02/1900, fecha inexistente en el calendario real.'
    );
  }

  const epochOffsetDays =
    wholeDays < 60 ? EXCEL_PRE_LEAP_BUG_OFFSET_DAYS : EXCEL_UNIX_EPOCH_OFFSET_DAYS;
  const utcMs = (wholeDays - epochOffsetDays) * MS_PER_DAY;
  const dt = new Date(utcMs);

  return buildValidatedCalendarResult({
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
    rawReceived,
    minYear: options.minYear,
    maxYear: options.maxYear,
  });
}

function parseTextAlphaDate(
  asciiLower: string,
  rawReceived: string,
  options: {
    fallbackYear?: number;
    fallbackMonth?: number;
    minYear: number;
    maxYear: number;
  }
): ExcelDateParseResult {
  const sanitized = asciiLower.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!sanitized) {
    return buildErrorResult(rawReceived, 'UNRECOGNIZED_FORMAT', 'Formato de fecha no reconocido.');
  }

  const rawTokens = sanitized.split(' ');
  if (rawTokens.length > 14) {
    return buildErrorResult(rawReceived, 'UNRECOGNIZED_FORMAT', 'Formato de fecha demasiado extenso o ilegible.');
  }

  for (const tok of rawTokens) {
    if (isDangerousObjectKey(tok)) {
      return buildErrorResult(rawReceived, 'UNRECOGNIZED_FORMAT', 'Valor de fecha bloqueado por seguridad.');
    }
  }

  const meaningful: string[] = [];
  for (const tok of rawTokens) {
    if (!tok || ALPHA_STOPWORDS[tok]) continue;
    const ordMatch = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(tok);
    meaningful.push(ordMatch ? ordMatch[1]! : tok);
  }

  let detectedMonth: number | null = null;
  let hadExplicitWeekday = false;
  const numericTokens: Array<{ value: number; raw: string }> = [];

  for (let i = 0; i < meaningful.length; i++) {
    const tok = meaningful[i]!;
    if (tok === 'mar') {
      const nextTok = meaningful[i + 1];
      const nextNextTok = meaningful[i + 2];
      const isLeadingWeekday =
        i === 0 &&
        nextTok !== undefined &&
        /^\d{1,2}$/.test(nextTok) &&
        nextNextTok !== undefined &&
        MONTH_MAP[nextNextTok] !== undefined;
      if (isLeadingWeekday) {
        hadExplicitWeekday = true;
        continue;
      }
    }

    if (WEEKDAY_MAP[tok]) {
      hadExplicitWeekday = true;
      continue;
    }

    const mappedMonth = MONTH_MAP[tok];
    if (mappedMonth !== undefined && detectedMonth === null) {
      detectedMonth = mappedMonth;
      continue;
    }

    if (/^\d{1,4}$/.test(tok)) {
      numericTokens.push({ value: Number(tok), raw: tok });
      continue;
    }

    // Si aparece una palabra desconocida que no es mes, día de semana ni conector, la cadena es inválida
    return buildErrorResult(
      rawReceived,
      'UNRECOGNIZED_FORMAT',
      `Formato de fecha ilegible ("${rawReceived}"). Use DD/MM/AAAA.`
    );
  }

  if (detectedMonth !== null) {
    if (numericTokens.length >= 2) {
      const fourDigitIdx = numericTokens.findIndex((n) => n.raw.length === 4);
      let dayTok: { value: number; raw: string };
      let yearTok: { value: number; raw: string };

      if (fourDigitIdx === 0) {
        yearTok = numericTokens[0]!;
        dayTok = numericTokens[1]!;
      } else if (fourDigitIdx > 0) {
        dayTok = numericTokens[0]!;
        yearTok = numericTokens[fourDigitIdx]!;
      } else {
        dayTok = numericTokens[0]!;
        yearTok = numericTokens[1]!;
      }

      const year = expandTwoDigitYear(yearTok.raw);
      return buildValidatedCalendarResult({
        year,
        month: detectedMonth,
        day: dayTok.value,
        rawReceived,
        minYear: options.minYear,
        maxYear: options.maxYear,
      });
    }

    if (numericTokens.length === 1 && options.fallbackYear !== undefined) {
      return buildValidatedCalendarResult({
        year: options.fallbackYear,
        month: detectedMonth,
        day: numericTokens[0]!.value,
        rawReceived,
        minYear: options.minYear,
        maxYear: options.maxYear,
        usedFallbackPeriod: true,
      });
    }
  }

  if (
    detectedMonth === null &&
    hadExplicitWeekday &&
    numericTokens.length === 1 &&
    options.fallbackYear !== undefined &&
    options.fallbackMonth !== undefined
  ) {
    return buildValidatedCalendarResult({
      year: options.fallbackYear,
      month: options.fallbackMonth,
      day: numericTokens[0]!.value,
      rawReceived,
      minYear: options.minYear,
      maxYear: options.maxYear,
      usedFallbackPeriod: true,
    });
  }

  return buildErrorResult(
    rawReceived,
    'UNRECOGNIZED_FORMAT',
    `No se pudo interpretar la fecha "${rawReceived}". Use formato DD/MM/AAAA.`
  );
}

/**
 * Función pura principal `excelDateParser`: convierte cualquier valor de celda de Excel/CSV
 * al formato ISO `YYYY-MM-DD` exacto requerido por PostgreSQL (`DATE`), operando en UTC puro,
 * priorizando `DD/MM/YYYY` sobre `MM/DD/YYYY` y validando existencia real en el calendario.
 */
export function excelDateParser(
  rawInput: unknown,
  options?: ExcelDateParserOptions
): ExcelDateParseResult {
  const minYear = options?.minYear ?? DEFAULT_MIN_YEAR;
  const maxYear = options?.maxYear ?? DEFAULT_MAX_YEAR;
  const date1904 = Boolean(options?.date1904);
  const allowUsMmDdFallback = Boolean(options?.allowUsMmDdFallback);
  const rawReceived = formatRawPreview(rawInput);

  try {
    if (rawInput === null || rawInput === undefined) {
      return buildErrorResult('', 'EMPTY', 'La celda de fecha está vacía.');
    }

    if (typeof rawInput === 'boolean' || typeof rawInput === 'symbol' || typeof rawInput === 'function') {
      return buildErrorResult(
        rawReceived,
        'UNRECOGNIZED_FORMAT',
        `Tipo de dato inválido en celda de fecha ("${rawReceived}").`
      );
    }

    // 1. Números seriales nativos de Excel (enteros o decimales con hora, ej. 46310 o 46310.5)
    if (typeof rawInput === 'number') {
      return parseExcelSerialToUtc(rawInput, rawReceived, { date1904, minYear, maxYear });
    }

    // 2. Instancias Date de JavaScript (evitando `.toISOString()` sobre horas locales y desfases UTC-4)
    if (rawInput instanceof Date) {
      const time = rawInput.getTime();
      if (Number.isNaN(time)) {
        return buildErrorResult(rawReceived, 'UNRECOGNIZED_FORMAT', 'Instancia de fecha (Date) inválida.');
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

      // Si es medianoche UTC exacta (ej. `new Date("2026-10-15")` o `Date.UTC(2026, 9, 15)`),
      // extraer siempre en UTC evita que `UTC-4` retroceda a las 20:00 del día anterior.
      // Si no es medianoche UTC pero sí medianoche local (`new Date(2026, 9, 15, 0, 0, 0)`),
      // extraer componentes locales evita saltos por `.toISOString()`.
      const useLocalComponents = !isExactUtcMidnight && isExactLocalMidnight;

      const year = useLocalComponents ? rawInput.getFullYear() : rawInput.getUTCFullYear();
      const month = useLocalComponents ? rawInput.getMonth() + 1 : rawInput.getUTCMonth() + 1;
      const day = useLocalComponents ? rawInput.getDate() : rawInput.getUTCDate();

      return buildValidatedCalendarResult({
        year,
        month,
        day,
        rawReceived: `${pad4(year)}-${pad2(month)}-${pad2(day)}`,
        minYear,
        maxYear,
      });
    }

    if (typeof rawInput !== 'string') {
      return buildErrorResult(rawReceived, 'UNRECOGNIZED_FORMAT', 'Valor de celda no compatible con fecha.');
    }

    // Limpieza inicial de cadena sin destruir posibles errores de Excel (#¡VALOR!) ni números
    const cleaned = rawInput
      .slice(0, 240)
      .replace(/[\u0000-\u001F\u007F-\u009F\u00A0\u200B-\u200D\uFEFF]+/g, ' ')
      .replace(/^'+/, '') // Apóstrofe de texto forzado en Excel ('15/10/2026)
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      return buildErrorResult('', 'EMPTY', 'La celda de fecha está vacía.');
    }

    if (isDangerousObjectKey(cleaned)) {
      return buildErrorResult(rawReceived, 'UNRECOGNIZED_FORMAT', 'Valor bloqueado por seguridad.');
    }

    const upperTrimmed = cleaned.toUpperCase();
    if (EXCEL_FORMULA_ERROR_TOKENS[upperTrimmed] || /^#[¡¿]?[A-Z0-9/]+[!?]?$/.test(upperTrimmed)) {
      return buildErrorResult(
        cleaned,
        'EXCEL_FORMULA_ERROR',
        `La celda contiene un error de fórmula de Excel ("${cleaned}").`
      );
    }

    const asciiLower = stripDiacritics(cleaned).toLowerCase();
    if (EMPTY_PLACEHOLDERS[asciiLower]) {
      return buildErrorResult(cleaned, 'EMPTY', `La celda indica fecha pendiente ("${cleaned}").`);
    }

    // 3. Serial numérico de Excel almacenado como texto (5 dígitos con o sin fracción, ej. "46310" o "46310,5")
    if (/^\d{5}(?:[.,]\d{1,12})?$/.test(asciiLower)) {
      const numericSerial = Number(asciiLower.replace(',', '.'));
      return parseExcelSerialToUtc(numericSerial, cleaned, { date1904, minYear, maxYear });
    }

    // 4. Formato ISO 8601 (`YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY.MM.DD` con o sin hora)
    const isoMatch = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[t\s].*)?$/.exec(asciiLower);
    if (isoMatch) {
      return buildValidatedCalendarResult({
        year: Number(isoMatch[1]),
        month: Number(isoMatch[2]),
        day: Number(isoMatch[3]),
        rawReceived: cleaned,
        minYear,
        maxYear,
      });
    }

    // 5. Cadenas regionales `DD/MM/YYYY`, `D/M/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `DD/MM/YY`
    //    Prioridad explícita latinoamericana: bloque 1 = Día, bloque 2 = Mes.
    const regionalMatch =
      /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)?$/.exec(
        asciiLower
      );
    if (regionalMatch) {
      const firstBlockDay = Number(regionalMatch[1]);
      const secondBlockMonth = Number(regionalMatch[2]);
      const expandedYear = expandTwoDigitYear(regionalMatch[3]!);

      if (expandedYear < 0) {
        return buildErrorResult(cleaned, 'OUT_OF_RANGE_YEAR', `Año inválido en "${cleaned}".`);
      }

      if (secondBlockMonth >= 1 && secondBlockMonth <= 12) {
        return buildValidatedCalendarResult({
          year: expandedYear,
          month: secondBlockMonth,
          day: firstBlockDay,
          rawReceived: cleaned,
          minYear,
          maxYear,
        });
      }

      if (allowUsMmDdFallback && firstBlockDay >= 1 && firstBlockDay <= 12 && secondBlockMonth <= 31) {
        return buildValidatedCalendarResult({
          year: expandedYear,
          month: firstBlockDay,
          day: secondBlockMonth,
          rawReceived: cleaned,
          minYear,
          maxYear,
        });
      }

      return buildErrorResult(
        cleaned,
        'INVALID_MONTH',
        `Mes fuera de rango (${secondBlockMonth}) en "${cleaned}". Se prioriza formato DD/MM/AAAA (mes entre 01 y 12).`
      );
    }

    // Formato corto `DD/MM` sin año únicamente cuando se suministra `fallbackYear`
    if (options?.fallbackYear !== undefined) {
      const shortDm = /^(\d{1,2})[/\-](\d{1,2})$/.exec(asciiLower);
      if (shortDm) {
        return buildValidatedCalendarResult({
          year: options.fallbackYear,
          month: Number(shortDm[2]),
          day: Number(shortDm[1]),
          rawReceived: cleaned,
          minYear,
          maxYear,
          usedFallbackPeriod: true,
        });
      }
    }

    // 6. Fechas escritas en letras en español o inglés
    return parseTextAlphaDate(asciiLower, cleaned, {
      fallbackYear: options?.fallbackYear,
      fallbackMonth: options?.fallbackMonth,
      minYear,
      maxYear,
    });
  } catch {
    return buildErrorResult(
      rawReceived,
      'UNRECOGNIZED_FORMAT',
      `Valor de fecha corrupto o ilegible ("${rawReceived}").`
    );
  }
}

/**
 * Construye un mensaje de error claro y accionable para el usuario indicando el número exacto de fila
 * en el archivo Excel/CSV y el valor recibido cuando una fecha es vacía, corrupta o inexistente.
 */
export function formatExcelRowDateError(params: {
  excelRowNumber?: number;
  rawValue?: unknown;
  parseResult?: ExcelDateParseResult;
}): string {
  const rowPrefix =
    typeof params.excelRowNumber === 'number' && params.excelRowNumber > 0
      ? `Fila Excel #${params.excelRowNumber}: `
      : '';

  const result = params.parseResult ?? excelDateParser(params.rawValue);
  const preview = result.rawReceived || formatRawPreview(params.rawValue);

  if (result.errorCode === 'EMPTY' || !preview) {
    return preview
      ? `${rowPrefix}Fecha pendiente o vacía (recibido: "${preview}"). Ingrese DD-MM-AAAA.`
      : `${rowPrefix}Fecha vacía en el archivo. Ingrese una fecha válida (DD-MM-AAAA).`;
  }

  if (result.errorCode === 'EXCEL_FORMULA_ERROR') {
    return `${rowPrefix}Error de fórmula en celda de fecha (recibido: "${preview}"). Corrija la celda a DD-MM-AAAA.`;
  }

  if (result.errorCode === 'INVALID_MONTH') {
    return `${rowPrefix}Fecha inválida (recibido: "${preview}") — el mes supera 12 bajo el estándar DD/MM/AAAA.`;
  }

  if (result.errorCode === 'NON_EXISTENT_DAY') {
    return `${rowPrefix}Fecha inexistente en el calendario (recibido: "${preview}"). Verifique día y mes (DD-MM-AAAA).`;
  }

  if (result.errorCode === 'OUT_OF_RANGE_YEAR') {
    return `${rowPrefix}Año fuera de rango en fecha (recibido: "${preview}"). Use formato DD-MM-AAAA.`;
  }

  return `${rowPrefix}Fecha corrupta o ilegible (recibido: "${preview}"). Use formato DD-MM-AAAA.`;
}
