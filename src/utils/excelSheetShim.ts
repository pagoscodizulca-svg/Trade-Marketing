/**
 * Lector seguro de libros `.xlsx` basado en `exceljs` (reemplaza a `xlsx`/SheetJS · S-01 / P-03).
 *
 * Expone una estructura mínima compatible con la que consume `excelWorkbookReader.ts`
 * (`SheetNames`, `Sheets[nombre]` con `!ref`, `!merges` y celdas `A1 -> {t, v, w}`), de modo que
 * la lógica de selección de pestañas y fechas no cambia.
 *
 * Defensas: tope de bytes, tope de tamaño descomprimido (anti zip-bomb), tope de filas/columnas,
 * rechazo explícito de `.xls` binario legado, y construcción perezosa de cada hoja.
 */

export const MAX_XLSX_COMPRESSED_BYTES = 10 * 1024 * 1024;
export const MAX_XLSX_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;
export const MAX_XLSX_ROWS_PER_SHEET = 20_000;
export const MAX_XLSX_COLUMNS = 200;

export interface ShimCell {
  t: 'n' | 's' | 'b' | 'e';
  v?: string | number | boolean;
  w?: string;
}

export interface ShimRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export type ShimWorkSheet = Record<string, unknown> & {
  '!ref'?: string;
  '!merges'?: ShimRange[];
};

export interface ShimWorkBook {
  SheetNames: string[];
  Sheets: Record<string, ShimWorkSheet>;
  Workbook?: unknown;
}

export interface ShimXlsxApi {
  utils: {
    decode_range(ref: string): ShimRange;
    encode_cell(addr: { r: number; c: number }): string;
  };
}

export class UnsupportedSpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSpreadsheetError';
  }
}

export function encodeColumnLabel(col0: number): string {
  let n = col0 + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export function decodeColumnLabel(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function decodeCellAddress(addr: string): { r: number; c: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(addr.trim());
  if (!m) throw new Error(`Dirección de celda inválida: ${addr}`);
  return { r: Number(m[2]) - 1, c: decodeColumnLabel(m[1]) };
}

export const shimXlsxApi: ShimXlsxApi = {
  utils: {
    decode_range(ref: string): ShimRange {
      const [a, b] = ref.split(':');
      const s = decodeCellAddress(a);
      const e = b ? decodeCellAddress(b) : s;
      return { s, e };
    },
    encode_cell({ r, c }) {
      return `${encodeColumnLabel(c)}${r + 1}`;
    },
  },
};

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

function dateToExcelSerial(d: Date): number {
  return (d.getTime() - EXCEL_EPOCH_UTC_MS) / 86_400_000;
}

function toUint8(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

/** Firma ZIP (`PK\x03\x04`): obligatoria para `.xlsx`. El binario OLE (`D0 CF 11 E0`) es `.xls` legado. */
export function assertXlsxMagicBytes(bytes: Uint8Array): void {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new UnsupportedSpreadsheetError(
      'El formato Excel 97-2003 (.xls) ya no es compatible por seguridad. Abre el archivo en Excel y guárdalo como .xlsx.'
    );
  }
  if (!(bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    throw new UnsupportedSpreadsheetError('El archivo no es un libro .xlsx válido.');
  }
}

async function assertSafeZipSize(bytes: Uint8Array): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  zip.forEach((_p, file) => {
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  });
  if (total > MAX_XLSX_UNCOMPRESSED_BYTES) {
    throw new UnsupportedSpreadsheetError(
      'El libro Excel descomprimido excede el límite permitido (posible archivo malicioso).'
    );
  }
}

function cellFromValue(value: unknown): ShimCell | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? { t: 'n', v: value } : null;
  if (typeof value === 'boolean') return { t: 'b', v: value };
  if (typeof value === 'string') return { t: 's', v: value };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { t: 'n', v: dateToExcelSerial(value) };
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.error === 'string') return { t: 'e', w: obj.error };
    if ('result' in obj || 'formula' in obj || 'sharedFormula' in obj) {
      return cellFromValue(obj.result);
    }
    if (Array.isArray(obj.richText)) {
      const text = (obj.richText as Array<{ text?: string }>).map((p) => p.text ?? '').join('');
      return text ? { t: 's', v: text } : null;
    }
    if (typeof obj.text === 'string') return obj.text ? { t: 's', v: obj.text } : null;
  }
  return { t: 's', v: String(value) };
}

type ExcelJsWorksheet = {
  name: string;
  state?: string;
  rowCount: number;
  model?: { merges?: string[] };
  eachRow(opts: { includeEmpty: boolean }, cb: (row: { number: number; eachCell(opts: { includeEmpty: boolean }, cb: (cell: { col: number | string; value: unknown }, col: number) => void): void }, rowNumber: number) => void): void;
};

function buildSheet(ws: ExcelJsWorksheet): ShimWorkSheet {
  if (ws.rowCount > MAX_XLSX_ROWS_PER_SHEET) {
    throw new UnsupportedSpreadsheetError(
      `La hoja "${ws.name}" tiene ${ws.rowCount} filas y supera el límite de ${MAX_XLSX_ROWS_PER_SHEET}.`
    );
  }

  const sheet: ShimWorkSheet = {};
  let minR = Infinity;
  let minC = Infinity;
  let maxR = -1;
  let maxC = -1;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const c0 = colNumber - 1;
      if (c0 >= MAX_XLSX_COLUMNS) return;
      const parsed = cellFromValue(cell.value);
      if (!parsed) return;
      const r0 = rowNumber - 1;
      sheet[`${encodeColumnLabel(c0)}${r0 + 1}`] = parsed;
      if (r0 < minR) minR = r0;
      if (c0 < minC) minC = c0;
      if (r0 > maxR) maxR = r0;
      if (c0 > maxC) maxC = c0;
    });
  });

  if (maxR >= 0) {
    sheet['!ref'] = `${encodeColumnLabel(minC)}${minR + 1}:${encodeColumnLabel(maxC)}${maxR + 1}`;
  }

  const merges: ShimRange[] = [];
  for (const ref of ws.model?.merges ?? []) {
    try {
      merges.push(shimXlsxApi.utils.decode_range(ref));
    } catch {
      /* se ignora un rango de combinación malformado */
    }
  }
  if (merges.length > 0) sheet['!merges'] = merges;
  return sheet;
}

/**
 * Carga un `.xlsx` desde memoria. Las fechas se normalizan a números seriales del sistema 1900
 * (por lo tanto `date1904` siempre es `false` en la estructura devuelta).
 */
export async function loadXlsxAsSheetShim(buffer: ArrayBuffer | Uint8Array): Promise<ShimWorkBook> {
  const bytes = toUint8(buffer);
  if (bytes.byteLength > MAX_XLSX_COMPRESSED_BYTES) {
    throw new UnsupportedSpreadsheetError('El archivo Excel supera el límite máximo permitido de 10 MB.');
  }
  assertXlsxMagicBytes(bytes);
  await assertSafeZipSize(bytes);

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as never);

  const SheetNames: string[] = [];
  const Sheets: Record<string, ShimWorkSheet> = {};
  const metaSheets: Array<{ Hidden: number }> = [];
  const cache = new Map<string, ShimWorkSheet>();

  wb.worksheets.forEach((ws) => {
    SheetNames.push(ws.name);
    metaSheets.push({ Hidden: ws.state === 'hidden' ? 1 : ws.state === 'veryHidden' ? 2 : 0 });
    Object.defineProperty(Sheets, ws.name, {
      enumerable: true,
      configurable: true,
      get() {
        let built = cache.get(ws.name);
        if (!built) {
          built = buildSheet(ws as unknown as ExcelJsWorksheet);
          cache.set(ws.name, built);
        }
        return built;
      },
    });
  });

  return {
    SheetNames,
    Sheets,
    Workbook: { WBProps: { date1904: false }, Sheets: metaSheets },
  };
}

/** Matriz de texto de la primera hoja (para importadores de maestros). */
export async function readFirstSheetAsStringMatrix(
  buffer: ArrayBuffer | Uint8Array
): Promise<string[][]> {
  const wb = await loadXlsxAsSheetShim(buffer);
  const name = wb.SheetNames[0];
  const sheet = name ? wb.Sheets[name] : undefined;
  if (!sheet || !sheet['!ref']) return [];

  const range = shimXlsxApi.utils.decode_range(sheet['!ref']);
  const rows: string[][] = [];
  for (let r = 0; r <= range.e.r; r += 1) {
    const row: string[] = [];
    for (let c = 0; c <= range.e.c; c += 1) {
      const cell = sheet[`${encodeColumnLabel(c)}${r + 1}`] as ShimCell | undefined;
      row.push(cell ? String(cell.t === 'e' ? cell.w ?? '' : cell.v ?? '') : '');
    }
    rows.push(row);
  }
  return rows;
}
