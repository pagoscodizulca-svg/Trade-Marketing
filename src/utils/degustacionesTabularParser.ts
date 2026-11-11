import type { ShiftType } from '../types';
import type { ArchivoPlanificacionExtension } from '../types/degustacionesPipeline';
import { normalizeHora24 } from './degustacionIdempotency';
import {
  MAX_CELL_TEXT_CHARS,
  MAX_EXCEL_FILE_BYTES,
  MAX_IMPORT_ROWS,
  excelDateParser,
  findMonthInText,
  formatExcelRowDateError,
  isDangerousObjectKey,
  sanitizeSpreadsheetText,
  stripAccents,
} from './excelDateParser';
import {
  MAX_HEADER_SCAN_ROWS,
  MAX_WORKBOOK_SCAN_COLS,
  NumberedSheetRow,
  SheetMergeRange,
  SheetSelectionReason,
  WorkbookCellValue,
  buildDegustacionColumnIndexMap,
  findDegustacionHeaderRow,
  parseSheetNameChronology,
  readMostRecentWorkbookSheet,
} from './excelWorkbookReader';

export type { SheetSelectionReason };
export { MAX_HEADER_SCAN_ROWS, MAX_IMPORT_ROWS };
export const MAX_UPLOAD_FILE_BYTES = MAX_EXCEL_FILE_BYTES; // 10 MB máximo para mitigar DoS
export const MAX_CELL_TEXT_LENGTH = MAX_CELL_TEXT_CHARS; // 250 caracteres por celda

export const ALLOWED_EXTENSIONS: readonly ArchivoPlanificacionExtension[] = [
  'xlsx',
  'xls',
  'csv',
  'pdf',
] as const;

const ALLOWED_MIME_PREFIXES: Readonly<Record<ArchivoPlanificacionExtension, readonly string[]>> =
  Object.freeze({
    xlsx: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
    ],
    xls: [
      'application/vnd.ms-excel',
      'application/excel',
      'application/x-excel',
      'application/x-msexcel',
      'application/octet-stream',
    ],
    csv: [
      'text/csv',
      'text/plain',
      'application/csv',
      'application/vnd.ms-excel',
      'application/octet-stream',
    ],
    pdf: ['application/pdf', 'application/x-pdf', 'application/octet-stream'],
  });

/**
 * Sanitizador determinista obligatorio para entradas de archivos (Excel/CSV/PDF) y celdas editables:
 * - Elimina caracteres de control invisibles y zero-width chars.
 * - Colapsa saltos/espacios redundantes y aplica `.trim()`.
 * - Neutraliza prefijos de CSV/Formula Injection (`=`, `+`, `-`, `@`, `\t`, `\r` al inicio de textos libres)
 *   sin alterar números negativos legítimos (`-3.5`) ni fechas válidas (`2026-10-15`).
 * - Limita la longitud máxima razonable por celda (por defecto 250 caracteres).
 */
export function sanitizeCellText(raw: unknown, maxLength = MAX_CELL_TEXT_LENGTH): string {
  return sanitizeSpreadsheetText(raw, maxLength);
}

/**
 * Contrato crudo normalizado antes del cruce con catálogos reales de BD e idempotencia.
 * Idéntico para Excel, CSV y extracción estructurada de PDF con IA.
 */
export interface RawExtractedDegustacionRow {
  excelRowNumber?: number; // Fila exacta 1-based en la hoja Excel o línea del CSV
  fecha: string; // Clave canónica interna aaaa-mm-dd (o '' si la celda estaba vacía/inválida)
  fechaFormateada: string; // Representación visual exacta dd-mm-aaaa (ej. "05-03-2026", o '')
  fechaTimestamp: number | null; // Timestamp numérico UTC 00:00:00.000 comparable en memoria
  rawFecha?: string; // Valor original recibido para reporte de error por fila
  fechaErrorDetalle?: string | null; // Diagnóstico explícito con fila Excel y valor recibido cuando falla
  fechaOrigenParcial?: boolean;
  horaInicio: string; // HH:MM
  horaFin: string; // HH:MM
  turno: ShiftType;
  clienteNombre: string;
  clienteCodigo: string;
  zonaDireccion: string;
  productos: string[];
  cantidadKilos: number;
  personasEstimadas: number;
  vendedorFdv: string;
  promotoraSugerida: string;
  observaciones: string;
}

export interface FileValidationCheck {
  valid: boolean;
  extension: ArchivoPlanificacionExtension | null;
  error?: string;
}

export function validateUploadFileMetadata(file: {
  name: string;
  size: number;
  type?: string;
}): FileValidationCheck {
  const cleanName = sanitizeCellText(file.name, 180);
  const extMatch = cleanName.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = (extMatch?.[1] || '') as ArchivoPlanificacionExtension;

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      extension: null,
      error: `Formato no permitido ("${cleanName}"). Solo se aceptan archivos .xlsx, .xls, .csv o .pdf.`,
    };
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return {
      valid: false,
      extension: ext,
      error: 'El archivo seleccionado está vacío (0 bytes).',
    };
  }

  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(2);
    const maxMb = Math.round(MAX_UPLOAD_FILE_BYTES / (1024 * 1024));
    return {
      valid: false,
      extension: ext,
      error: `El archivo pesa ${mb} MB y supera el límite máximo permitido de ${maxMb} MB.`,
    };
  }

  const rawMime = String(file.type || '').trim().toLowerCase();
  if (rawMime) {
    const allowedMimes = ALLOWED_MIME_PREFIXES[ext];
    const matchesMime = allowedMimes.some((m) => rawMime.startsWith(m));
    if (!matchesMime) {
      return {
        valid: false,
        extension: ext,
        error: `El tipo MIME "${rawMime}" no coincide con la extensión .${ext}.`,
      };
    }
  }

  return { valid: true, extension: ext };
}

type CellValue = WorkbookCellValue;
type NumberedRow = NumberedSheetRow;

function cellToText(cell: CellValue): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    const parsed = excelDateParser(cell);
    return parsed.ok ? parsed.displayDate : '';
  }
  return sanitizeCellText(cell);
}

function rawCellToDiagnosticString(cell: CellValue): string {
  if (cell === null || cell === undefined || cell === '') return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  if (cell instanceof Date) {
    const parsed = excelDateParser(cell);
    return parsed.ok ? parsed.isoDate || '' : 'Date(Invalid)';
  }
  if (typeof cell === 'boolean') return String(cell);
  return String(cell)
    .slice(0, 120)
    .replace(/[\u0000-\u001F\u007F-\u009F\u00A0\u200B-\u200D\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parser CSV determinista RFC-4180 con rastreo exacto del número de línea real 1-based en el archivo.
 */
function parseDeterministicCsvWithLineNumbers(rawText: string): NumberedRow[] {
  const src = rawText.replace(/^\uFEFF/, '');
  const firstNonEmptyLine =
    src
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';

  const delimiter = ([',', ';', '\t'] as const).reduce((best, candidate) =>
    firstNonEmptyLine.split(candidate).length > firstNonEmptyLine.split(best).length
      ? candidate
      : best
  );

  const numberedRows: NumberedRow[] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let currentLine = 1;
  let rowStartLine = 1;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') {
          currentLine++;
        } else if (ch === '\r') {
          if (src[i + 1] === '\n') i++;
          currentLine++;
        }
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      if (row.length <= MAX_WORKBOOK_SCAN_COLS) {
        row.push(sanitizeCellText(cell));
      }
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      if (row.length <= MAX_WORKBOOK_SCAN_COLS) {
        row.push(sanitizeCellText(cell));
      }
      if (row.some((c) => c !== '')) {
        numberedRows.push({ excelRowNumber: rowStartLine, cells: row });
        if (numberedRows.length > MAX_IMPORT_ROWS + 25) {
          throw new Error(
            `El archivo supera el límite máximo permitido de ${MAX_IMPORT_ROWS} filas por lote. Divida la carga en archivos más pequeños.`
          );
        }
      }
      currentLine++;
      rowStartLine = currentLine;
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.trim() !== '' || row.length > 0) {
    if (row.length <= MAX_WORKBOOK_SCAN_COLS) {
      row.push(sanitizeCellText(cell));
    }
    if (row.some((c) => c !== '')) {
      numberedRows.push({ excelRowNumber: rowStartLine, cells: row });
      if (numberedRows.length > MAX_IMPORT_ROWS + 25) {
        throw new Error(
          `El archivo supera el límite máximo permitido de ${MAX_IMPORT_ROWS} filas por lote. Divida la carga en archivos más pequeños.`
        );
      }
    }
  }

  return numberedRows;
}

/**
 * Parser CSV determinista RFC-4180 (soporta comillas escapadas, saltos internos y autodetección de `,`, `;` o `\t`),
 * aplicando sanitización estricta celda por celda.
 */
export function parseDeterministicCsv(rawText: string): string[][] {
  return parseDeterministicCsvWithLineNumbers(rawText).map((r) => r.cells as string[]);
}

export const MONTHS_ES_OPTIONS = [
  { value: 1, label: 'Enero' },
  { value: 2, label: 'Febrero' },
  { value: 3, label: 'Marzo' },
  { value: 4, label: 'Abril' },
  { value: 5, label: 'Mayo' },
  { value: 6, label: 'Junio' },
  { value: 7, label: 'Julio' },
  { value: 8, label: 'Agosto' },
  { value: 9, label: 'Septiembre' },
  { value: 10, label: 'Octubre' },
  { value: 11, label: 'Noviembre' },
  { value: 12, label: 'Diciembre' },
] as const;

export function getCurrentVenezuelaYearMonth(): { year: number; month: number } {
  const veMs = Date.now() - 4 * 60 * 60 * 1000;
  const veDate = new Date(veMs);
  return {
    year: veDate.getUTCFullYear(),
    month: veDate.getUTCMonth() + 1,
  };
}

export interface ParsedFechaCronogramaResult {
  ymd: string; // Clave interna aaaa-mm-dd o ''
  fechaFormateada: string; // Representación visual dd-mm-aaaa o ''
  fechaTimestamp: number | null; // Timestamp numérico UTC 00:00:00.000 o null
  rawDisplay: string;
  fechaOrigenParcial: boolean;
  expectedWeekday: number | null;
  actualWeekday: number | null;
  weekdayMatches: boolean;
  weekdayMismatchMessage: string | null;
  invalidCalendarMessage: string | null;
}

/**
 * Motor determinista de resolución de fechas de Excel/CSV respaldado por `excelDateParser`,
 * operando estrictamente en UTC puro (`Date.UTC`), priorizando `DD/MM/YYYY` sobre `MM/DD/YYYY`
 * y validando existencia real en el calendario.
 */
export function parseFechaCronograma(
  rawVal: CellValue,
  baseYear?: number,
  baseMonth?: number,
  extraOptions?: { date1904?: boolean; excelRowNumber?: number }
): ParsedFechaCronogramaResult {
  const fallbackPeriod = getCurrentVenezuelaYearMonth();
  const effectiveYear =
    typeof baseYear === 'number' && baseYear >= 1900 && baseYear <= 2199
      ? baseYear
      : fallbackPeriod.year;
  const effectiveMonth =
    typeof baseMonth === 'number' && baseMonth >= 1 && baseMonth <= 12
      ? baseMonth
      : fallbackPeriod.month;

  if (rawVal === null || rawVal === undefined || rawVal === '') {
    return {
      ymd: '',
      fechaFormateada: '',
      fechaTimestamp: null,
      rawDisplay: '',
      fechaOrigenParcial: false,
      expectedWeekday: null,
      actualWeekday: null,
      weekdayMatches: true,
      weekdayMismatchMessage: null,
      invalidCalendarMessage: formatExcelRowDateError({
        excelRowNumber: extraOptions?.excelRowNumber,
        rawValue: rawVal,
      }),
    };
  }

  // 1. Resolución directa estricta en UTC puro (prioridad DD/MM/YYYY, rechazo de meses > 12 y días inexistentes)
  const direct = excelDateParser(rawVal, {
    date1904: extraOptions?.date1904,
    allowUsMmDdFallback: false,
  });

  if (direct.ok && direct.isoDate && direct.timestampUtc !== null) {
    const actualWeekday = new Date(direct.timestampUtc).getUTCDay();
    return {
      ymd: direct.isoDate,
      fechaFormateada: direct.displayDate,
      fechaTimestamp: direct.timestampUtc,
      rawDisplay: direct.rawReceived || direct.displayDate,
      fechaOrigenParcial: false,
      expectedWeekday: null,
      actualWeekday,
      weekdayMatches: true,
      weekdayMismatchMessage: null,
      invalidCalendarMessage: null,
    };
  }

  // 2. Si el valor falló por formato parcial sin año/mes (ej. "08 NOV", "JUEVES 08"),
  //    intentar resolución con Periodo Base; pero jamás rescatar meses > 12 ni días inexistentes con año completo.
  if (direct.errorCode === 'UNRECOGNIZED_FORMAT') {
    const withFallback = excelDateParser(rawVal, {
      date1904: extraOptions?.date1904,
      fallbackYear: effectiveYear,
      fallbackMonth: effectiveMonth,
      allowUsMmDdFallback: false,
    });

    if (withFallback.ok && withFallback.isoDate && withFallback.timestampUtc !== null) {
      const actualWeekday = new Date(withFallback.timestampUtc).getUTCDay();
      return {
        ymd: withFallback.isoDate,
        fechaFormateada: withFallback.displayDate,
        fechaTimestamp: withFallback.timestampUtc,
        rawDisplay: withFallback.rawReceived || withFallback.displayDate,
        fechaOrigenParcial: true,
        expectedWeekday: null,
        actualWeekday,
        weekdayMatches: true,
        weekdayMismatchMessage: null,
        invalidCalendarMessage: null,
      };
    }

    return {
      ymd: '',
      fechaFormateada: '',
      fechaTimestamp: null,
      rawDisplay: withFallback.rawReceived || direct.rawReceived,
      fechaOrigenParcial: false,
      expectedWeekday: null,
      actualWeekday: null,
      weekdayMatches: false,
      weekdayMismatchMessage: null,
      invalidCalendarMessage: formatExcelRowDateError({
        excelRowNumber: extraOptions?.excelRowNumber,
        rawValue: rawVal,
        parseResult: withFallback,
      }),
    };
  }

  return {
    ymd: '',
    fechaFormateada: '',
    fechaTimestamp: null,
    rawDisplay: direct.rawReceived,
    fechaOrigenParcial: false,
    expectedWeekday: null,
    actualWeekday: null,
    weekdayMatches: false,
    weekdayMismatchMessage: null,
    invalidCalendarMessage: formatExcelRowDateError({
      excelRowNumber: extraOptions?.excelRowNumber,
      rawValue: rawVal,
      parseResult: direct,
    }),
  };
}

/**
 * Infiere automáticamente el Periodo Base inicial (Mes y Año) a partir de:
 * 1) Cualquier fecha completa explícita presente en las filas del archivo.
 * 2) Mes y/o año presentes en el nombre de la pestaña activa (si proviene de Excel).
 * 3) Mes y/o año presentes en el nombre del archivo.
 * 4) Mes y año actuales del sistema en Venezuela (`UTC-4`).
 */
export function inferInitialBasePeriod(
  fileName: string,
  rawDateSamples: ReadonlyArray<CellValue> = [],
  sheetName?: string
): { year: number; month: number } {
  const current = getCurrentVenezuelaYearMonth();

  for (const sample of rawDateSamples) {
    if (sample === null || sample === undefined || sample === '') continue;
    const parsed = parseFechaCronograma(sample, current.year, current.month);
    if (parsed.ymd && !parsed.fechaOrigenParcial) {
      return {
        year: Number(parsed.ymd.slice(0, 4)),
        month: Number(parsed.ymd.slice(5, 7)),
      };
    }
  }

  if (sheetName) {
    const sheetChronology = parseSheetNameChronology(sheetName, current.year);
    if (sheetChronology) {
      return {
        year: sheetChronology.year,
        month: sheetChronology.month,
      };
    }
  }

  const fileChronology = parseSheetNameChronology(fileName, current.year);
  if (fileChronology) {
    return {
      year: fileChronology.year,
      month: fileChronology.month,
    };
  }

  const cleanName = stripAccents(sanitizeCellText(fileName, 180));
  const yearInNameMatch = cleanName.match(/\b(20\d{2})\b/);
  const detectedYear = yearInNameMatch ? Number(yearInNameMatch[1]) : current.year;

  const monthFound = findMonthInText(cleanName);
  if (monthFound) {
    return {
      year: detectedYear,
      month: monthFound.month,
    };
  }

  if (yearInNameMatch) {
    return {
      year: detectedYear,
      month: current.month,
    };
  }

  return current;
}

/**
 * Wrapper compatible hacia `YYYY-MM-DD` (devuelve `''` si no es una fecha calendario válida).
 */
export function normalizeTabularDateToYmd(
  cell: CellValue,
  baseYear?: number,
  baseMonth?: number
): string {
  return parseFechaCronograma(cell, baseYear, baseMonth).ymd;
}

function parseExcelTimeCell(cell: CellValue): string {
  if (cell === null || cell === undefined || cell === '') return '';
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return `${String(cell.getUTCHours()).padStart(2, '0')}:${String(cell.getUTCMinutes()).padStart(2, '0')}`;
  }
  if (typeof cell === 'number' && cell >= 0 && cell < 1) {
    const totalMinutes = Math.round(cell * 24 * 60);
    const hh = Math.floor(totalMinutes / 60) % 24;
    const mm = totalMinutes % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  return sanitizeCellText(cell, 80);
}

export function resolveScheduleWindow(params: {
  rawHoraInicio?: string;
  rawHoraFin?: string;
  rawHorarioOrTurno?: string;
}): { horaInicio: string; horaFin: string; turno: ShiftType } {
  const combined = `${params.rawHorarioOrTurno || ''} ${params.rawHoraInicio || ''}`.trim();
  const upper = stripAccents(combined).toUpperCase();

  let horaInicio = '';
  let horaFin = '';

  const rangeSource = params.rawHoraInicio?.includes('-')
    ? params.rawHoraInicio
    : params.rawHorarioOrTurno || '';
  const rangeParts = rangeSource.split(/\s*(?:\-|–|—|\bA\b|\bAL\b|\bHASTA\b)\s*/i);
  if (rangeParts.length >= 2 && /\d/.test(rangeParts[0]!) && /\d/.test(rangeParts[1]!)) {
    horaInicio = normalizeHora24(rangeParts[0], '');
    horaFin = normalizeHora24(rangeParts[1], '');
  }

  if (!horaInicio && params.rawHoraInicio && /\d/.test(params.rawHoraInicio)) {
    horaInicio = normalizeHora24(params.rawHoraInicio, '');
  }
  if (!horaFin && params.rawHoraFin && /\d/.test(params.rawHoraFin)) {
    horaFin = normalizeHora24(params.rawHoraFin, '');
  }

  let turno: ShiftType = 'MAÑANA';
  if (upper.includes('COMPLETO') || upper.includes('TODO EL DIA')) {
    turno = 'COMPLETO';
  } else if (upper.includes('TARDE') || upper.includes('VESPERTINO')) {
    turno = 'TARDE';
  } else if (upper.includes('MANANA') || upper.includes('MATUTINO')) {
    turno = 'MAÑANA';
  } else if (horaInicio) {
    const startH = Number(horaInicio.slice(0, 2));
    const endH = horaFin ? Number(horaFin.slice(0, 2)) : startH + 4;
    if (startH < 12 && endH >= 16) {
      turno = 'COMPLETO';
    } else if (startH >= 12) {
      turno = 'TARDE';
    }
  }

  if (!horaInicio) {
    horaInicio = turno === 'TARDE' ? '14:00' : '09:00';
  }
  if (!horaFin) {
    horaFin = turno === 'COMPLETO' ? '18:00' : turno === 'TARDE' ? '18:00' : '13:00';
  }

  return { horaInicio, horaFin, turno };
}

function parsePositiveNumber(raw: CellValue, defaultVal = 0): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  const clean = String(raw ?? '')
    .trim()
    .replace(',', '.')
    .replace(/[^0-9.\-]/g, '');
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : defaultVal;
}

interface InternalMapOptions {
  fileName?: string;
  sheetName?: string;
  baseYear?: number;
  baseMonth?: number;
  date1904?: boolean;
  merges?: ReadonlyArray<SheetMergeRange>;
}

function mapNumberedRowsToDegustacionRows(
  numberedRows: NumberedRow[],
  options?: InternalMapOptions
): {
  rows: RawExtractedDegustacionRow[];
  detectedColumns: string[];
  inferredPeriod: { year: number; month: number };
  warning?: string;
} {
  const fallbackPeriod = getCurrentVenezuelaYearMonth();
  if (!numberedRows || numberedRows.length < 2) {
    return {
      rows: [],
      detectedColumns: [],
      inferredPeriod: fallbackPeriod,
      warning: 'El archivo no contiene encabezados ni filas de planificación.',
    };
  }

  const { headerArrayIdx } = findDegustacionHeaderRow(numberedRows);
  const headerEntry = numberedRows[headerArrayIdx]!;
  const rawHeaders = headerEntry.cells || [];
  const colIndex = buildDegustacionColumnIndexMap(rawHeaders);
  const detectedColumns = rawHeaders.map((h) => cellToText(h)).filter(Boolean);

  if (colIndex.clienteNombre < 0 && colIndex.fecha < 0) {
    return {
      rows: [],
      detectedColumns,
      inferredPeriod: fallbackPeriod,
      warning:
        'No se reconocieron columnas estándar (ej. FECHA, CLIENTE / PDV, PRODUCTO). Verifique los encabezados del archivo.',
    };
  }

  // Propagar celdas combinadas verticales (`!merges`) únicamente sobre columnas de agrupación debajo del encabezado
  if (options?.merges && options.merges.length > 0) {
    const rowByExcelNum = new Map<number, CellValue[]>();
    for (let i = headerArrayIdx + 1; i < numberedRows.length; i++) {
      const entry = numberedRows[i]!;
      rowByExcelNum.set(entry.excelRowNumber, entry.cells);
    }

    const groupingCols = new Set<number>(
      [
        colIndex.fecha,
        colIndex.horaInicio,
        colIndex.horaFin,
        colIndex.horarioTurno,
        colIndex.zonaDireccion,
      ].filter((idx): idx is number => typeof idx === 'number' && idx >= 0)
    );

    const headerZeroBasedRow = headerEntry.excelRowNumber - 1;
    for (const merge of options.merges) {
      if (
        merge.s.c === merge.e.c &&
        merge.e.r > merge.s.r &&
        merge.s.r > headerZeroBasedRow &&
        groupingCols.has(merge.s.c)
      ) {
        const topRowCells = rowByExcelNum.get(merge.s.r + 1);
        const topVal = topRowCells?.[merge.s.c];
        if (topVal === undefined || topVal === null || topVal === '') continue;

        for (let targetZeroRow = merge.s.r + 1; targetZeroRow <= merge.e.r; targetZeroRow++) {
          const targetCells = rowByExcelNum.get(targetZeroRow + 1);
          if (!targetCells) continue;
          // Solo propagar si la fila hija tiene datos reales en otras columnas
          const hasOtherData = targetCells.some(
            (c, colIdx) => colIdx !== merge.s.c && cellToText(c) !== ''
          );
          if (!hasOtherData) continue;
          const currentCell = targetCells[merge.s.c];
          if (currentCell === undefined || currentCell === null || cellToText(currentCell) === '') {
            targetCells[merge.s.c] = topVal;
          }
        }
      }
    }
  }

  const getCell = (row: CellValue[], field: string): CellValue => {
    if (isDangerousObjectKey(field)) return undefined;
    const idx = colIndex[field] ?? -1;
    return idx >= 0 ? row[idx] : undefined;
  };

  const candidateDataRows: NumberedRow[] = [];
  for (let i = headerArrayIdx + 1; i < numberedRows.length; i++) {
    const entry = numberedRows[i]!;
    const row = entry.cells || [];
    if (row.every((c) => cellToText(c) === '')) continue;

    const rawCliente = cellToText(getCell(row, 'clienteNombre'));
    const rawFechaCell = getCell(row, 'fecha');
    const rawFechaText =
      typeof rawFechaCell === 'number' ? String(rawFechaCell) : cellToText(rawFechaCell);

    if (/^TOTAL(ES)?\b/i.test(rawCliente) || /^TOTAL(ES)?\b/i.test(rawFechaText)) {
      continue;
    }

    candidateDataRows.push(entry);
  }

  if (candidateDataRows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `El archivo contiene ${candidateDataRows.length} filas de datos y supera el máximo permitido de ${MAX_IMPORT_ROWS} registros por lote. Divida el archivo en lotes más pequeños.`
    );
  }

  const missingDateColumnWarning =
    colIndex.fecha < 0
      ? `No se encontró una columna de fecha reconocible (ej. "Fecha", "Fecha de Degustación"). Columnas detectadas: ${detectedColumns.join(', ') || 'ninguna'}.`
      : undefined;

  const rawDateSamples: CellValue[] = [];
  for (const entry of candidateDataRows) {
    const sample = getCell(entry.cells, 'fecha');
    if (sample !== undefined && sample !== null && sample !== '') {
      rawDateSamples.push(sample);
    }
  }

  const inferredPeriod = inferInitialBasePeriod(
    options?.fileName || '',
    rawDateSamples,
    options?.sheetName
  );
  const effectiveYear = options?.baseYear ?? inferredPeriod.year;
  const effectiveMonth = options?.baseMonth ?? inferredPeriod.month;

  const extracted: RawExtractedDegustacionRow[] = [];

  for (const entry of candidateDataRows) {
    const row = entry.cells;
    const excelRowNumber = entry.excelRowNumber;
    const rawCliente = cellToText(getCell(row, 'clienteNombre'));
    const rawFechaCell = getCell(row, 'fecha');
    const rawFechaDiagnostic = rawCellToDiagnosticString(rawFechaCell);

    const dateResolution =
      colIndex.fecha < 0
        ? {
            ymd: '',
            fechaFormateada: '',
            fechaTimestamp: null,
            fechaOrigenParcial: false,
            invalidCalendarMessage: `Fila Excel #${excelRowNumber}: No se detectó columna de Fecha en los encabezados del archivo (${detectedColumns.join(', ') || 'sin encabezados'}).`,
          }
        : parseFechaCronograma(rawFechaCell, effectiveYear, effectiveMonth, {
            date1904: options?.date1904,
            excelRowNumber,
          });

    const schedule = resolveScheduleWindow({
      rawHoraInicio: parseExcelTimeCell(getCell(row, 'horaInicio')),
      rawHoraFin: parseExcelTimeCell(getCell(row, 'horaFin')),
      rawHorarioOrTurno: parseExcelTimeCell(getCell(row, 'horarioTurno')),
    });

    const rawProdText = cellToText(getCell(row, 'productos'));
    const prodTokens = rawProdText
      .split(/[,+/|;]+/)
      .map((p) => sanitizeCellText(p, 120))
      .filter(Boolean);

    const mortQty = parsePositiveNumber(getCell(row, 'colMortadela'), 0);
    const espQty = parsePositiveNumber(getCell(row, 'colEspalda'), 0);
    const arrQty = parsePositiveNumber(getCell(row, 'colArroz'), 0);

    if (prodTokens.length === 0) {
      if (mortQty > 0) prodTokens.push('MORTADELA');
      if (espQty > 0) prodTokens.push('ESPALDA');
      if (arrQty > 0) prodTokens.push('ARROZ VENCAMPO');
    }

    const explicitKilos = parsePositiveNumber(getCell(row, 'cantidadKilos'), 0);
    const matrixKilos = mortQty + espQty + arrQty;
    const cantidadKilos =
      explicitKilos > 0
        ? Math.round(explicitKilos * 100) / 100
        : matrixKilos > 0
          ? Math.round(matrixKilos * 100) / 100
          : 1;

    const personasEstimadas = Math.max(
      0,
      Math.round(parsePositiveNumber(getCell(row, 'personasEstimadas'), 0))
    );

    extracted.push({
      excelRowNumber,
      fecha: dateResolution.ymd,
      fechaFormateada: dateResolution.fechaFormateada,
      fechaTimestamp: dateResolution.fechaTimestamp,
      rawFecha: rawFechaDiagnostic,
      fechaErrorDetalle: dateResolution.invalidCalendarMessage,
      fechaOrigenParcial: dateResolution.fechaOrigenParcial,
      horaInicio: schedule.horaInicio,
      horaFin: schedule.horaFin,
      turno: schedule.turno,
      clienteNombre: rawCliente,
      clienteCodigo: cellToText(getCell(row, 'clienteCodigo')),
      zonaDireccion: cellToText(getCell(row, 'zonaDireccion')),
      productos: prodTokens,
      cantidadKilos,
      personasEstimadas,
      vendedorFdv: cellToText(getCell(row, 'vendedorFdv')),
      promotoraSugerida: cellToText(getCell(row, 'promotoraSugerida')),
      observaciones: cellToText(getCell(row, 'observaciones')),
    });
  }

  return {
    rows: extracted,
    detectedColumns,
    inferredPeriod,
    ...(missingDateColumnWarning ? { warning: missingDateColumnWarning } : {}),
  };
}

/**
 * Convierte una matriz tabular cruda (Excel o CSV) en el arreglo normalizado `RawExtractedDegustacionRow[]`.
 */
export function mapMatrixToDegustacionRows(
  matrix: CellValue[][],
  options?: { fileName?: string; baseYear?: number; baseMonth?: number; date1904?: boolean }
): {
  rows: RawExtractedDegustacionRow[];
  detectedColumns: string[];
  inferredPeriod: { year: number; month: number };
  warning?: string;
} {
  const numberedRows: NumberedRow[] = (matrix || []).map((cells, idx) => ({
    excelRowNumber: idx + 1,
    cells: Array.isArray(cells) ? [...cells] : [],
  }));
  return mapNumberedRowsToDegustacionRows(numberedRows, options);
}

/**
 * Extrae filas deterministas desde un archivo `.xlsx`, `.xls` o `.csv` en el navegador o en Node.js:
 * - Para libros Excel (`.xlsx` / `.xls`), selecciona automáticamente la pestaña más reciente en 2 niveles
 *   (por nombre o por fechas internas en UTC) y ejecuta Lazy Parsing exclusivamente sobre la hoja ganadora.
 * - Conserva números exactos de fila Excel 1-based, errores de fórmula, celdas combinadas verticales y `date1904`.
 */
export async function extractTabularDegustacionFile(
  fileBuffer: ArrayBuffer,
  extension: 'xlsx' | 'xls' | 'csv',
  options?: {
    fileName?: string;
    baseYear?: number;
    baseMonth?: number;
    targetSheetName?: string;
  }
): Promise<{
  rows: RawExtractedDegustacionRow[];
  detectedColumns: string[];
  inferredPeriod: { year: number; month: number };
  warning?: string;
  selectedSheetName?: string;
  autoSelectedSheetName?: string;
  sheetSelectionReason?: SheetSelectionReason;
  availableSheets?: string[];
  deepParsedSheetCount?: number;
}> {
  if (!fileBuffer || fileBuffer.byteLength <= 0) {
    return {
      rows: [],
      detectedColumns: [],
      inferredPeriod: getCurrentVenezuelaYearMonth(),
      warning: 'El archivo seleccionado está vacío (0 bytes).',
    };
  }

  if (fileBuffer.byteLength > MAX_UPLOAD_FILE_BYTES) {
    const mb = (fileBuffer.byteLength / (1024 * 1024)).toFixed(2);
    const maxMb = Math.round(MAX_UPLOAD_FILE_BYTES / (1024 * 1024));
    throw new Error(
      `El archivo pesa ${mb} MB y supera el límite máximo permitido de ${maxMb} MB.`
    );
  }

  if (extension === 'csv') {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(fileBuffer);
    const text = utf8.includes('\uFFFD')
      ? new TextDecoder('windows-1252').decode(fileBuffer)
      : utf8;
    const csvRows = parseDeterministicCsvWithLineNumbers(text);
    return mapNumberedRowsToDegustacionRows(csvRows, options);
  }

  const XLSX = await import('xlsx');
  // Leemos números seriales puros (`cellDates: false`) para que `excelDateParser` resuelva
  // en UTC puro sin crear instancias Date desplazadas por la zona horaria local.
  const workbook = XLSX.read(fileBuffer, {
    type: 'array',
    cellDates: false,
  });

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return {
      rows: [],
      detectedColumns: [],
      inferredPeriod: getCurrentVenezuelaYearMonth(),
      warning: 'El libro Excel no contiene hojas disponibles.',
    };
  }

  const wbRead = readMostRecentWorkbookSheet(XLSX, workbook, {
    fileName: options?.fileName,
    baseYear: options?.baseYear,
    baseMonth: options?.baseMonth,
    targetSheetName: options?.targetSheetName,
  });

  if (!wbRead.selectedSheetName) {
    return {
      rows: [],
      detectedColumns: [],
      inferredPeriod: getCurrentVenezuelaYearMonth(),
      warning: 'El libro Excel no contiene pestañas visibles con datos.',
    };
  }

  const mapped = mapNumberedRowsToDegustacionRows(wbRead.numberedRows, {
    fileName: options?.fileName,
    sheetName: wbRead.selectedSheetName,
    baseYear: options?.baseYear,
    baseMonth: options?.baseMonth,
    date1904: wbRead.isDate1904,
    merges: wbRead.merges,
  });

  return {
    ...mapped,
    selectedSheetName: wbRead.selectedSheetName,
    autoSelectedSheetName: wbRead.autoSelectedSheetName,
    sheetSelectionReason: wbRead.selectionReason,
    availableSheets: wbRead.availableSheets,
    deepParsedSheetCount: wbRead.deepParsedSheetCount,
  };
}

/**
 * Genera el contenido oficial de plantilla CSV (solo encabezados reales, cero datos inventados).
 */
export const DEGUSTACIONES_CSV_TEMPLATE_HEADERS = [
  'FECHA',
  'HORA INICIO',
  'HORA FIN',
  'TURNO',
  'CLIENTE',
  'CODIGO CLIENTE',
  'DIRECCION / ZONA',
  'PRODUCTOS',
  'KILOS',
  'PERSONAS ESTIMADAS',
  'FDV / VENDEDOR',
  'PROMOTORA SUGERIDA',
  'OBSERVACIONES',
] as const;

export function downloadDegustacionesCsvTemplate(): void {
  const csvContent = `\uFEFF${DEGUSTACIONES_CSV_TEMPLATE_HEADERS.join(',')}\n`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'Plantilla_Carga_Degustaciones_Codizulca.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
