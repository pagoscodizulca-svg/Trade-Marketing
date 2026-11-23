import ExcelJS from 'exceljs';

export interface FixtureSheetSpec {
  name: string;
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
  hidden?: boolean;
  merges?: ReadonlyArray<string>;
  cellOverrides?: Record<string, unknown>;
}

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer | Buffer): ArrayBuffer {
  const u8 =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

/**
 * Construye un libro `.xlsx` binario real en memoria usando `exceljs`
 * (sin depender de SheetJS `xlsx@0.18.5`).
 */
export async function buildXlsxFixtureBuffer(
  sheets: ReadonlyArray<FixtureSheetSpec>
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name);
    if (spec.hidden) {
      ws.state = 'hidden';
    }
    for (const row of spec.rows) {
      ws.addRow([...row]);
    }
    if (spec.merges) {
      for (const rangeRef of spec.merges) {
        ws.mergeCells(rangeRef);
      }
    }
    if (spec.cellOverrides) {
      for (const [cellAddr, cellVal] of Object.entries(spec.cellOverrides)) {
        ws.getCell(cellAddr).value = cellVal as ExcelJS.CellValue;
      }
    }
  }
  const raw = (await wb.xlsx.writeBuffer()) as ArrayBuffer | Uint8Array;
  return toArrayBuffer(raw);
}

/**
 * Stub binario con firma mágica OLE2 / BIFF8 (`.xls` legado) para probar
 * el rechazo de seguridad de archivos binarios `.xls` sin usar SheetJS.
 */
export function buildLegacyOleXlsStubBuffer(): ArrayBuffer {
  const ole = Uint8Array.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  return toArrayBuffer(ole);
}
