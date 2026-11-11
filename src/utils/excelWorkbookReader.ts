import type * as XLSXTypes from 'xlsx';
import {
  MAX_IMPORT_ROWS,
  createSafeNullMap,
  excelDateParser,
  findMonthInText,
  isDangerousObjectKey,
  isFechaDegustacionHeader,
  normalizeExcelHeader,
  sanitizeSpreadsheetText,
  stripAccents,
} from './excelDateParser';

export type WorkbookCellValue = string | number | boolean | Date | null | undefined;

export interface NumberedSheetRow {
  readonly excelRowNumber: number; // 1-based exact row in Excel / CSV
  readonly cells: WorkbookCellValue[];
}

export interface SheetMergeRange {
  readonly s: { readonly r: number; readonly c: number };
  readonly e: { readonly r: number; readonly c: number };
}

export type SheetSelectionReason =
  | 'NOMBRE_PESTANA'
  | 'CONTENIDO_FECHAS'
  | 'UNICA_HOJA'
  | 'MANUAL';

export interface SheetChronologyMatch {
  readonly timestampUtc: number;
  readonly year: number;
  readonly month: number;
  readonly day: number | null;
  readonly hasExplicitYear: boolean;
}

export interface WorkbookSelectiveReadResult {
  readonly selectedSheetName: string;
  readonly autoSelectedSheetName: string;
  readonly selectionReason: SheetSelectionReason;
  readonly availableSheets: string[];
  readonly isDate1904: boolean;
  readonly deepParsedSheetCount: number;
  readonly numberedRows: NumberedSheetRow[];
  readonly merges: SheetMergeRange[];
}

/** Escaneo dinámico de encabezados acotado estrictamente a las primeras 15 filas. */
export const MAX_HEADER_SCAN_ROWS = 15;

/** Límite defensivo anti-DoS de columnas inspeccionadas por hoja. */
export const MAX_WORKBOOK_SCAN_COLS = 60;

/**
 * Diccionario canónico unificado de sinónimos de columnas para Excel y CSV.
 */
export const DEGUSTACION_COLUMN_SYNONYMS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    createSafeNullMap<readonly string[]>([
      [
        'fecha',
        [
          'FECHA',
          'FECHAPROGRAMADA',
          'FECHADEGUSTACION',
          'FECHADEDEGUSTACION',
          'FECHAEJECUCION',
          'FECHAACTIVIDAD',
          'FECHAEVENTO',
          'FECHAVISITA',
          'FECDEGUSTACION',
          'DIA',
          'DIADEGUSTACION',
          'DATE',
          'TASTINGDATE',
        ],
      ],
      ['horaInicio', ['HORAINICIO', 'HORADEINICIO', 'DESDE', 'INICIO', 'HORAENTRADA']],
      ['horaFin', ['HORAFIN', 'HORADEFIN', 'HASTA', 'FIN', 'HORASALIDA', 'CIERRE']],
      ['horarioTurno', ['TURNO', 'JORNADA', 'HORARIO', 'HORA', 'FRANJA', 'SHIFT']],
      [
        'clienteNombre',
        [
          'CLIENTE',
          'PDV',
          'PUNTODEVENTA',
          'PUNTOVENTA',
          'NOMBRECLIENTE',
          'TIENDA',
          'COMERCIO',
          'SUPERMERCADO',
          'RAZONSOCIAL',
          'ESTABLECIMIENTO',
        ],
      ],
      [
        'clienteCodigo',
        ['CODIGOCLIENTE', 'CODCLIENTE', 'CODIGO', 'IDCLIENTE', 'RIF', 'CLIENTECODIGO'],
      ],
      [
        'zonaDireccion',
        [
          'DIRECCION',
          'ZONA',
          'RUTA',
          'DIRECCIONZONA',
          'SECTOR',
          'CIUDAD',
          'MUNICIPIO',
          'UBICACION',
        ],
      ],
      [
        'productos',
        [
          'PRODUCTO',
          'PRODUCTOS',
          'PRODUCTOADEGUSTAR',
          'PRODUCTODEGUSTAR',
          'LINEA',
          'MARCA',
          'SKU',
          'DESCRIPCIONPRODUCTO',
          'ARTICULO',
        ],
      ],
      [
        'cantidadKilos',
        [
          'KILOS',
          'KG',
          'CANTIDAD',
          'CANTIDADKILOS',
          'PESO',
          'UNIDADES',
          'CANT',
          'TOTALKG',
        ],
      ],
      [
        'personasEstimadas',
        [
          'PERSONAS',
          'PERSONASESTIMADAS',
          'MUESTRAS',
          'IMPACTOS',
          'META',
          'PORCIONES',
          'ALCANCE',
        ],
      ],
      [
        'vendedorFdv',
        [
          'FDV',
          'VENDEDOR',
          'EJECUTIVO',
          'ASESOR',
          'VENDEDORFDV',
          'REPRESENTANTE',
          'FUERZADEVENTAS',
          'FUERZAVENTAS',
          'SOLICITANTE',
        ],
      ],
      [
        'promotoraSugerida',
        [
          'PROMOTORA',
          'PROMOTORASUGERIDA',
          'IMPULSADORA',
          'RESPONSABLE',
          'PROMOTOR',
          'PROMOTORAASIGNADA',
        ],
      ],
      [
        'observaciones',
        [
          'OBSERVACIONES',
          'OBSERVACION',
          'NOTAS',
          'COMENTARIOS',
          'DETALLE',
          'MOTIVO',
          'INDICACIONES',
        ],
      ],
      ['colMortadela', ['MORTADELA', 'KGMORTADELA']],
      ['colEspalda', ['ESPALDA', 'ESPALDAAHUMADA', 'KGESPALDA']],
      ['colArroz', ['ARROZ', 'VENCAMPO', 'ARROZVENCAMPO']],
    ])
  );

const ALL_SYNONYM_KEYS = new Set(Object.values(DEGUSTACION_COLUMN_SYNONYMS).flat());

const ALL_SYNONYM_LOWER_COMPACT = new Set(
  Array.from(ALL_SYNONYM_KEYS).map((k) => k.toLowerCase())
);

function cellToHeaderProbeString(cell: WorkbookCellValue): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return '';
  return sanitizeSpreadsheetText(cell, 160);
}

/**
 * Puntúa una fila candidata como encabezado de degustaciones normalizando `.trim()`,
 * minúsculas, sin tildes y espacios simples.
 */
export function scoreDegustacionHeaderRow(rowCells: ReadonlyArray<WorkbookCellValue>): number {
  let score = 0;
  for (const cell of rowCells) {
    const nh = normalizeExcelHeader(cellToHeaderProbeString(cell));
    if (!nh.canonicalKey && !nh.compactKey && !nh.normalizedLower) continue;
    const lowerNoSpace = nh.normalizedLower.replace(/\s+/g, '');
    if (
      ALL_SYNONYM_KEYS.has(nh.canonicalKey) ||
      ALL_SYNONYM_KEYS.has(nh.compactKey) ||
      ALL_SYNONYM_LOWER_COMPACT.has(lowerNoSpace) ||
      isFechaDegustacionHeader(nh, DEGUSTACION_COLUMN_SYNONYMS.fecha)
    ) {
      score++;
    }
  }
  return score;
}

/**
 * Construye el mapa seguro (`Object.create(null)`) de índices de columna a partir de la fila de encabezados.
 */
export function buildDegustacionColumnIndexMap(
  rawHeaders: ReadonlyArray<WorkbookCellValue>
): Record<string, number> {
  const normalizedHeaders = rawHeaders.map((h) =>
    normalizeExcelHeader(cellToHeaderProbeString(h))
  );
  const colIndex = createSafeNullMap<number>();

  for (const [field, aliases] of Object.entries(DEGUSTACION_COLUMN_SYNONYMS)) {
    if (isDangerousObjectKey(field)) continue;
    const lowerAliases = aliases.map((a) => a.toLowerCase());
    let idx = normalizedHeaders.findIndex((nh) => {
      if (!nh.canonicalKey && !nh.compactKey) return false;
      const lowerNoSpace = nh.normalizedLower.replace(/\s+/g, '');
      return (
        aliases.includes(nh.canonicalKey) ||
        aliases.includes(nh.compactKey) ||
        lowerAliases.includes(lowerNoSpace)
      );
    });
    if (idx < 0 && field === 'fecha') {
      idx = normalizedHeaders.findIndex((nh) => isFechaDegustacionHeader(nh, aliases));
    }
    colIndex[field] = idx;
  }

  return colIndex;
}

/**
 * Localiza dinámicamente la fila real de encabezados dentro de las primeras 15 filas (`MAX_HEADER_SCAN_ROWS`).
 */
export function findDegustacionHeaderRow(
  rows: ReadonlyArray<NumberedSheetRow>
): { headerArrayIdx: number; bestScore: number } {
  let bestIdx = 0;
  let bestScore = 0;

  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i]!;
    // Escanea las primeras 15 filas físicas de la hoja (o los primeros 15 registros si hay desplazamiento)
    if (i >= MAX_HEADER_SCAN_ROWS && entry.excelRowNumber > MAX_HEADER_SCAN_ROWS) {
      break;
    }
    const score = scoreDegustacionHeaderRow(entry.cells || []);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return {
    headerArrayIdx: bestScore >= 2 ? bestIdx : 0,
    bestScore,
  };
}

function getCurrentUtcMinus4YearMonth(): { year: number; month: number } {
  const veDate = new Date(Date.now() - 4 * 60 * 60 * 1000);
  return {
    year: veDate.getUTCFullYear(),
    month: veDate.getUTCMonth() + 1,
  };
}

function isValidUtcDate(year: number, month: number, day: number): boolean {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function expandTwoDigitYear(yy: number): number {
  return yy >= 70 ? 1900 + yy : 2000 + yy;
}

/**
 * Nivel 1: Analiza el nombre de una pestaña de Excel para extraer su marca cronológica en UTC puro.
 * Soporta:
 * - Fechas completas numéricas: `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY`, `DD-MM-YY`
 * - Periodos numéricos Mes/Año: `MM-YYYY`, `MM/YYYY`, `YYYY-MM`, `YYYY/MM`
 * - Meses en español/inglés completos o abreviados con o sin año:
 *   `"Noviembre 2026"`, `"NOV 2026"`, `"Octubre_26"`, `"15 Nov 2026"`, `"Noviembre"`
 */
export function parseSheetNameChronology(
  rawSheetName: string,
  referenceYear?: number
): SheetChronologyMatch | null {
  const clean = stripAccents(sanitizeSpreadsheetText(rawSheetName, 140)).trim();
  if (!clean || isDangerousObjectKey(clean)) return null;

  const fallbackYear =
    typeof referenceYear === 'number' && referenceYear >= 1990 && referenceYear <= 2100
      ? referenceYear
      : getCurrentUtcMinus4YearMonth().year;

  // 1. Fecha completa ISO en el nombre: YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  const isoFullMatch = clean.match(/(?:^|[^\d])(19\d{2}|20\d{2}|2100)[/\-_.](0?[1-9]|1[0-2])[/\-_.](0?[1-9]|[12]\d|3[01])(?=[^\d]|$)/);
  if (isoFullMatch) {
    const year = Number(isoFullMatch[1]);
    const month = Number(isoFullMatch[2]);
    const day = Number(isoFullMatch[3]);
    if (isValidUtcDate(year, month, day)) {
      return {
        timestampUtc: Date.UTC(year, month - 1, day),
        year,
        month,
        day,
        hasExplicitYear: true,
      };
    }
  }

  // 2. Fecha completa LatAm en el nombre: DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY / DD-MM-YY
  const latamFullMatch = clean.match(/(?:^|[^\d])(0?[1-9]|[12]\d|3[01])[/\-_.](0?[1-9]|1[0-2])[/\-_.](19\d{2}|20\d{2}|2100|\d{2})(?=[^\d]|$)/);
  if (latamFullMatch) {
    const day = Number(latamFullMatch[1]);
    const month = Number(latamFullMatch[2]);
    const rawYear = latamFullMatch[3]!;
    const year = rawYear.length === 2 ? expandTwoDigitYear(Number(rawYear)) : Number(rawYear);
    if (isValidUtcDate(year, month, day)) {
      return {
        timestampUtc: Date.UTC(year, month - 1, day),
        year,
        month,
        day,
        hasExplicitYear: true,
      };
    }
  }

  // 3. Mes en letras (español o inglés, completo o abreviado) con o sin día/año
  const monthFound = findMonthInText(clean);
  if (monthFound) {
    const { month, matchedToken } = monthFound;
    const explicit4YearMatch = clean.match(/(?:^|[^\d])(19\d{2}|20\d{2}|2100)(?=[^\d]|$)/);
    let year = explicit4YearMatch ? Number(explicit4YearMatch[1]) : fallbackYear;
    let hasExplicitYear = Boolean(explicit4YearMatch);
    let day: number | null = null;

    const escapedToken = matchedToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (explicit4YearMatch) {
      // Buscar día antes o después del mes cuando ya existe año de 4 dígitos (ej. "15 Nov 2026" o "Nov 15 2026")
      const dayBeforeRe = new RegExp(`(?:^|[^\\d])(0?[1-9]|[12]\\d|3[01])[\\s\\-_./,]*(?:de\\s+)?${escapedToken}`, 'i');
      const dayAfterRe = new RegExp(`${escapedToken}[.\\s\\-_/,]*(0?[1-9]|[12]\\d|3[01])(?=[^\\d]|$)`, 'i');
      const dbMatch = clean.match(dayBeforeRe);
      const daMatch = clean.match(dayAfterRe);
      const candidateDay = dbMatch ? Number(dbMatch[1]) : daMatch ? Number(daMatch[1]) : null;
      if (candidateDay !== null && candidateDay !== year && isValidUtcDate(year, month, candidateDay)) {
        day = candidateDay;
      }
    } else {
      // Sin año de 4 dígitos: detectar año corto de 2 dígitos pegado/separado tras el mes (ej. "Octubre_26", "NOV-26", "Dic 25")
      const twoDigitAfterMonthRe = new RegExp(
        `${escapedToken}[.\\s\\-_/']*(2\\d|3\\d)(?=[^\\d]|$)`,
        'i'
      );
      const yyMatch = clean.match(twoDigitAfterMonthRe);
      if (yyMatch) {
        year = expandTwoDigitYear(Number(yyMatch[1]));
        hasExplicitYear = true;
      }

      // Verificar si además hay un día explícito antes del mes (ej. "15 Octubre_26" o "15 Nov")
      const dayBeforeRe = new RegExp(`(?:^|[^\\d])(0?[1-9]|[12]\\d|3[01])[\\s\\-_./,]*(?:de\\s+)?${escapedToken}`, 'i');
      const dbMatch = clean.match(dayBeforeRe);
      if (dbMatch) {
        const candidateDay = Number(dbMatch[1]);
        if (isValidUtcDate(year, month, candidateDay)) {
          day = candidateDay;
        }
      }
    }

    const timestampUtc =
      day !== null
        ? Date.UTC(year, month - 1, day)
        : Date.UTC(year, month, 0); // Fin del mes en UTC para periodos mensuales

    return {
      timestampUtc,
      year,
      month,
      day,
      hasExplicitYear,
    };
  }

  // 4. Periodo numérico Año-Mes: YYYY-MM o YYYY/MM o YYYY_MM
  const ymMatch = clean.match(/(?:^|[^\d])(19\d{2}|20\d{2}|2100)[/\-_.](0?[1-9]|1[0-2])(?=[^\d]|$)/);
  if (ymMatch) {
    const year = Number(ymMatch[1]);
    const month = Number(ymMatch[2]);
    return {
      timestampUtc: Date.UTC(year, month, 0),
      year,
      month,
      day: null,
      hasExplicitYear: true,
    };
  }

  // 5. Periodo numérico Mes-Año: MM-YYYY o MM/YYYY o MM_YYYY
  const myMatch = clean.match(/(?:^|[^\d])(0?[1-9]|1[0-2])[/\-_.](19\d{2}|20\d{2}|2100)(?=[^\d]|$)/);
  if (myMatch) {
    const month = Number(myMatch[1]);
    const year = Number(myMatch[2]);
    return {
      timestampUtc: Date.UTC(year, month, 0),
      year,
      month,
      day: null,
      hasExplicitYear: true,
    };
  }

  return null;
}

function readWorksheetCell(
  XLSX: typeof XLSXTypes,
  sheet: XLSXTypes.WorkSheet,
  r: number,
  c: number
): { value: WorkbookCellValue; hasContent: boolean } {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cellObj = sheet[addr] as
    | { t?: string; v?: WorkbookCellValue; w?: string }
    | undefined;

  if (!cellObj) {
    return { value: '', hasContent: false };
  }

  if (cellObj.t === 'e') {
    const errText = String(cellObj.w || '#ERROR!').trim();
    return { value: errText, hasContent: true };
  }
  if (cellObj.t === 'n') {
    const numVal = typeof cellObj.v === 'number' ? cellObj.v : '';
    return {
      value: numVal,
      hasContent: cellObj.v !== undefined && cellObj.v !== null,
    };
  }
  if (cellObj.t === 'b') {
    return { value: Boolean(cellObj.v), hasContent: true };
  }
  if (cellObj.v instanceof Date) {
    return { value: cellObj.v, hasContent: true };
  }

  const strVal = String(cellObj.v ?? cellObj.w ?? '');
  return { value: strVal, hasContent: strVal.trim() !== '' };
}

interface ProbedSheetSummary {
  readonly name: string;
  readonly index: number;
  readonly isEmpty: boolean;
  readonly isStructuredCandidate: boolean;
  readonly headerZeroRow: number;
  readonly headerScore: number;
  readonly dateColIdx: number;
  readonly hasDataBelowHeader: boolean;
  readonly nameChronology: SheetChronologyMatch | null;
}

/**
 * Sonda ultraligera de las primeras 15 filas (`MAX_HEADER_SCAN_ROWS`) de una pestaña visible:
 * detecta si tiene estructura válida de degustaciones sin convertir la hoja entera a JSON.
 */
function probeWorksheetStructure(
  XLSX: typeof XLSXTypes,
  sheet: XLSXTypes.WorkSheet | undefined,
  name: string,
  index: number,
  referenceYear: number
): ProbedSheetSummary {
  if (!sheet || !sheet['!ref']) {
    return {
      name,
      index,
      isEmpty: true,
      isStructuredCandidate: false,
      headerZeroRow: 0,
      headerScore: 0,
      dateColIdx: -1,
      hasDataBelowHeader: false,
      nameChronology: null,
    };
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const maxCols = Math.min(range.e.c, MAX_WORKBOOK_SCAN_COLS);
  const maxHeaderZeroRow = Math.min(
    range.e.r,
    Math.max(MAX_HEADER_SCAN_ROWS - 1, range.s.r + MAX_HEADER_SCAN_ROWS - 1)
  );

  let bestScore = 0;
  let bestZeroRow = range.s.r;
  let bestCells: WorkbookCellValue[] = [];
  let anyTopContent = false;

  for (let r = 0; r <= maxHeaderZeroRow; r++) {
    if (r < range.s.r) continue;
    const rowCells: WorkbookCellValue[] = [];
    let rowHasContent = false;

    for (let c = 0; c <= maxCols; c++) {
      if (c < range.s.c) {
        rowCells.push('');
        continue;
      }
      const { value, hasContent } = readWorksheetCell(XLSX, sheet, r, c);
      rowCells.push(value);
      if (hasContent) rowHasContent = true;
    }

    if (rowHasContent) {
      anyTopContent = true;
      const score = scoreDegustacionHeaderRow(rowCells);
      if (score > bestScore) {
        bestScore = score;
        bestZeroRow = r;
        bestCells = rowCells;
      }
    }
  }

  const colMap = bestScore >= 2 ? buildDegustacionColumnIndexMap(bestCells) : createSafeNullMap<number>();
  const dateColIdx = typeof colMap.fecha === 'number' ? colMap.fecha : -1;
  const clienteColIdx = typeof colMap.clienteNombre === 'number' ? colMap.clienteNombre : -1;
  const hasCoreColumns = bestScore >= 2 && (dateColIdx >= 0 || clienteColIdx >= 0);

  let hasDataBelowHeader = false;
  if (hasCoreColumns && bestZeroRow < range.e.r) {
    const maxDataCheckRow = Math.min(range.e.r, bestZeroRow + 50);
    for (let r = bestZeroRow + 1; r <= maxDataCheckRow; r++) {
      let nonBlankCells = 0;
      let firstText = '';
      for (let c = 0; c <= maxCols; c++) {
        if (c < range.s.c) continue;
        const { value, hasContent } = readWorksheetCell(XLSX, sheet, r, c);
        if (hasContent) {
          nonBlankCells++;
          if (!firstText) firstText = sanitizeSpreadsheetText(value, 40);
        }
      }
      if (nonBlankCells > 0 && !/^TOTAL(ES)?\b/i.test(firstText)) {
        hasDataBelowHeader = true;
        break;
      }
    }
  }

  const isEmpty = !anyTopContent && !hasDataBelowHeader;
  const isStructuredCandidate = hasCoreColumns && hasDataBelowHeader;

  return {
    name,
    index,
    isEmpty,
    isStructuredCandidate,
    headerZeroRow: bestZeroRow,
    headerScore: bestScore,
    dateColIdx,
    hasDataBelowHeader,
    nameChronology: parseSheetNameChronology(name, referenceYear),
  };
}

/**
 * Nivel 2 (Fallback ligero): escanea únicamente la columna de Fecha de una hoja candidata en UTC puro
 * para hallar la fecha válida de degustación más reciente sin parsear el resto de las columnas.
 */
function scanMaxContentDateUtcInSheet(
  XLSX: typeof XLSXTypes,
  sheet: XLSXTypes.WorkSheet | undefined,
  summary: ProbedSheetSummary,
  options: { isDate1904: boolean; fallbackYear: number; fallbackMonth: number }
): number | null {
  if (!sheet || !sheet['!ref'] || summary.dateColIdx < 0) return null;

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const maxRow = Math.min(range.e.r, summary.headerZeroRow + MAX_IMPORT_ROWS);
  let maxTimestampUtc: number | null = null;

  // Incluir propagación ligera de la última fecha superior si hay celdas combinadas verticales en la columna fecha
  const merges =
    (sheet['!merges'] as SheetMergeRange[] | undefined) || [];
  const mergedDateLookup = new Map<number, WorkbookCellValue>();
  for (const m of merges) {
    if (m.s.c === summary.dateColIdx && m.e.c === summary.dateColIdx && m.s.r > summary.headerZeroRow) {
      const top = readWorksheetCell(XLSX, sheet, m.s.r, summary.dateColIdx);
      if (top.hasContent) {
        for (let rr = m.s.r; rr <= m.e.r; rr++) {
          mergedDateLookup.set(rr, top.value);
        }
      }
    }
  }

  for (let r = summary.headerZeroRow + 1; r <= maxRow; r++) {
    const cellRead = readWorksheetCell(XLSX, sheet, r, summary.dateColIdx);
    const rawCandidate = cellRead.hasContent ? cellRead.value : mergedDateLookup.get(r);
    if (rawCandidate === undefined || rawCandidate === null || rawCandidate === '') continue;

    const direct = excelDateParser(rawCandidate, {
      date1904: options.isDate1904,
      allowUsMmDdFallback: false,
    });

    let ts = direct.ok ? direct.timestampUtc : null;
    if (ts === null && direct.errorCode === 'UNRECOGNIZED_FORMAT') {
      const withFallback = excelDateParser(rawCandidate, {
        date1904: options.isDate1904,
        fallbackYear: options.fallbackYear,
        fallbackMonth: options.fallbackMonth,
        allowUsMmDdFallback: false,
      });
      if (withFallback.ok) {
        ts = withFallback.timestampUtc;
      }
    }

    if (ts !== null && (maxTimestampUtc === null || ts > maxTimestampUtc)) {
      maxTimestampUtc = ts;
    }
  }

  return maxTimestampUtc;
}

/**
 * Conversión profunda (Lazy Parsing) ejecutada **exclusivamente** sobre la pestaña ganadora.
 * Preserva el número exacto de fila Excel (`1-based`), errores de fórmula y celdas combinadas,
 * omitiendo filas completamente vacías e imponiendo el límite anti-DoS de `MAX_IMPORT_ROWS`.
 */
function deepParseSingleWorksheet(
  XLSX: typeof XLSXTypes,
  sheet: XLSXTypes.WorkSheet | undefined
): { numberedRows: NumberedSheetRow[]; merges: SheetMergeRange[] } {
  if (!sheet || !sheet['!ref']) {
    return { numberedRows: [], merges: [] };
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const maxCols = Math.min(range.e.c, MAX_WORKBOOK_SCAN_COLS);
  const numberedRows: NumberedSheetRow[] = [];

  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: WorkbookCellValue[] = [];
    let hasAnyContent = false;

    for (let c = 0; c <= maxCols; c++) {
      if (c < range.s.c) {
        cells.push('');
        continue;
      }
      const { value, hasContent } = readWorksheetCell(XLSX, sheet, r, c);
      cells.push(value);
      if (hasContent) hasAnyContent = true;
    }

    if (hasAnyContent) {
      numberedRows.push({
        excelRowNumber: r + 1,
        cells,
      });

      if (numberedRows.length > MAX_IMPORT_ROWS + 25) {
        throw new Error(
          `El archivo supera el límite máximo permitido de ${MAX_IMPORT_ROWS} filas por lote. Divida la carga en archivos más pequeños.`
        );
      }
    }
  }

  const merges =
    ((sheet['!merges'] as SheetMergeRange[] | undefined) || []).slice();

  return { numberedRows, merges };
}

function inferReferenceYearFromWorkbook(
  visibleSheetNames: ReadonlyArray<string>,
  fileName?: string
): number {
  const current = getCurrentUtcMinus4YearMonth();
  let maxExplicitYear: number | null = null;

  for (const name of visibleSheetNames) {
    const parsed = parseSheetNameChronology(name, current.year);
    if (parsed?.hasExplicitYear && (maxExplicitYear === null || parsed.year > maxExplicitYear)) {
      maxExplicitYear = parsed.year;
    }
  }
  if (maxExplicitYear !== null) return maxExplicitYear;

  if (fileName) {
    const cleanFile = stripAccents(sanitizeSpreadsheetText(fileName, 180));
    const match4 = cleanFile.match(/(?:^|[^\d])(20\d{2})(?=[^\d]|$)/);
    if (match4) return Number(match4[1]);
  }

  return current.year;
}

/**
 * Selecciona automáticamente la pestaña más reciente de un libro Excel (`.xlsx` / `.xls`) usando
 * el algoritmo de 2 niveles (1: Nombre de Pestaña; 2: Contenido Interno de Fechas en UTC) y ejecuta
 * **Lectura Selectiva (Lazy Parsing)** convirtiendo en profundidad únicamente la hoja seleccionada.
 */
export function readMostRecentWorkbookSheet(
  XLSX: typeof XLSXTypes,
  workbook: XLSXTypes.WorkBook,
  options?: {
    fileName?: string;
    baseYear?: number;
    baseMonth?: number;
    targetSheetName?: string;
  }
): WorkbookSelectiveReadResult {
  const allSheetNames = (workbook.SheetNames || []).filter(
    (name) => Boolean(name) && !isDangerousObjectKey(name)
  );

  if (allSheetNames.length === 0) {
    return {
      selectedSheetName: '',
      autoSelectedSheetName: '',
      selectionReason: 'UNICA_HOJA',
      availableSheets: [],
      isDate1904: false,
      deepParsedSheetCount: 0,
      numberedRows: [],
      merges: [],
    };
  }

  const isDate1904 = Boolean(
    (workbook.Workbook as { WBProps?: { date1904?: boolean } } | undefined)?.WBProps?.date1904
  );

  const sheetMetaList =
    (workbook.Workbook as { Sheets?: Array<{ Hidden?: number }> } | undefined)?.Sheets || [];

  // Ignorar estrictamente toda pestaña oculta o muy oculta (`Hidden !== 0`)
  const visibleEntries: Array<{ name: string; index: number }> = [];
  workbook.SheetNames.forEach((name, idx) => {
    if (!name || isDangerousObjectKey(name)) return;
    const hiddenFlag = sheetMetaList[idx]?.Hidden;
    if (hiddenFlag !== undefined && hiddenFlag !== 0) return;
    visibleEntries.push({ name, index: idx });
  });

  if (visibleEntries.length === 0) {
    return {
      selectedSheetName: '',
      autoSelectedSheetName: '',
      selectionReason: 'UNICA_HOJA',
      availableSheets: [],
      isDate1904,
      deepParsedSheetCount: 0,
      numberedRows: [],
      merges: [],
    };
  }

  const referenceYear =
    options?.baseYear ??
    inferReferenceYearFromWorkbook(
      visibleEntries.map((e) => e.name),
      options?.fileName
    );
  const currentPeriod = getCurrentUtcMinus4YearMonth();
  const fallbackMonth = options?.baseMonth ?? currentPeriod.month;

  // Sonda ligera <= 15 filas para descartar hojas vacías o puramente decorativas / catálogos
  const probedVisible = visibleEntries.map((entry) =>
    probeWorksheetStructure(XLSX, workbook.Sheets[entry.name], entry.name, entry.index, referenceYear)
  );

  const structuredCandidates = probedVisible.filter((s) => s.isStructuredCandidate);
  const nonEmptyVisible = probedVisible.filter((s) => !s.isEmpty);

  const pool =
    structuredCandidates.length > 0
      ? structuredCandidates
      : nonEmptyVisible.length > 0
        ? nonEmptyVisible
        : [probedVisible[0]!];

  const availableSheets = pool.map((s) => s.name);

  // Determinar siempre cuál es la pestaña más reciente automática
  let autoWinner: ProbedSheetSummary = pool[0]!;
  let autoReason: SheetSelectionReason = 'UNICA_HOJA';

  if (pool.length === 1) {
    autoWinner = pool[0]!;
    autoReason = 'UNICA_HOJA';
  } else {
    // NIVEL 1: Selección por nombre cronológico de pestaña
    const withNameChronology = pool.filter((s) => s.nameChronology !== null);

    if (withNameChronology.length > 0) {
      let maxNameTs = -Infinity;
      for (const s of withNameChronology) {
        if (s.nameChronology!.timestampUtc > maxNameTs) {
          maxNameTs = s.nameChronology!.timestampUtc;
        }
      }
      const tiedTopByName = withNameChronology.filter(
        (s) => s.nameChronology!.timestampUtc === maxNameTs
      );

      if (tiedTopByName.length === 1) {
        // Ganador único en Nivel 1 -> Lazy Parsing inmediato sin escanear fechas internas de otras hojas
        autoWinner = tiedTopByName[0]!;
        autoReason = 'NOMBRE_PESTANA';
      } else {
        // Empate en Nivel 1 (ej. dos hojas del mismo mes): desempatar con Nivel 2 solo entre empatadas
        let bestContentTs = -Infinity;
        let bestTied = tiedTopByName[tiedTopByName.length - 1]!;
        for (const candidate of tiedTopByName) {
          const contentTs = scanMaxContentDateUtcInSheet(
            XLSX,
            workbook.Sheets[candidate.name],
            candidate,
            {
              isDate1904,
              fallbackYear: candidate.nameChronology?.year ?? referenceYear,
              fallbackMonth: candidate.nameChronology?.month ?? fallbackMonth,
            }
          );
          if (contentTs !== null && contentTs >= bestContentTs) {
            bestContentTs = contentTs;
            bestTied = candidate;
          }
        }
        autoWinner = bestTied;
        autoReason = bestContentTs > -Infinity ? 'CONTENIDO_FECHAS' : 'NOMBRE_PESTANA';
      }
    } else {
      // NIVEL 2: Fallback por contenido interno de fechas (ej. "Hoja1", "Hoja2", "Datos", "Cronograma")
      let bestContentTs = -Infinity;
      let bestByContent: ProbedSheetSummary | null = null;

      for (const candidate of pool) {
        const contentTs = scanMaxContentDateUtcInSheet(
          XLSX,
          workbook.Sheets[candidate.name],
          candidate,
          {
            isDate1904,
            fallbackYear: referenceYear,
            fallbackMonth,
          }
        );
        if (contentTs !== null && contentTs > bestContentTs) {
          bestContentTs = contentTs;
          bestByContent = candidate;
        }
      }

      if (bestByContent) {
        autoWinner = bestByContent;
        autoReason = 'CONTENIDO_FECHAS';
      } else {
        autoWinner = pool[0]!;
        autoReason = 'CONTENIDO_FECHAS';
      }
    }
  }

  // Si el usuario solicitó cambio manual de pestaña, validarla contra las hojas visibles del libro
  let finalSelected = autoWinner;
  let finalReason: SheetSelectionReason = autoReason;

  if (options?.targetSheetName) {
    const cleanTarget = sanitizeSpreadsheetText(options.targetSheetName, 140);
    const manualMatch =
      pool.find((s) => s.name === cleanTarget) ??
      nonEmptyVisible.find((s) => s.name === cleanTarget);
    if (manualMatch) {
      finalSelected = manualMatch;
      finalReason = manualMatch.name === autoWinner.name ? autoReason : 'MANUAL';
    }
  }

  // Lazy Parsing: convertir en profundidad ÚNICAMENTE la pestaña seleccionada
  const { numberedRows, merges } = deepParseSingleWorksheet(
    XLSX,
    workbook.Sheets[finalSelected.name]
  );

  return {
    selectedSheetName: finalSelected.name,
    autoSelectedSheetName: autoWinner.name,
    selectionReason: finalReason,
    availableSheets,
    isDate1904,
    deepParsedSheetCount: 1,
    numberedRows,
    merges,
  };
}
