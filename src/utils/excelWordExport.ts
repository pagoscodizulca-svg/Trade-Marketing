/**
 * Exportadores ejecutivos nativos (`M-02`): Excel `.xlsx` (exceljs) y Word `.docx` (docx).
 * Los módulos pesados se importan de forma diferida para no inflar el bundle inicial.
 * Seguridad: toda celda de texto pasa por `neutralizeFormulaInjection` (CSV/Excel injection).
 */

export interface ExportTableSheet {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null | undefined>>;
  /** Índices (0-based) de columnas con formato moneda USD */
  currencyColumns?: number[];
  /** Índices (0-based) de columnas con formato porcentaje (valor 0-100) */
  percentColumns?: number[];
}

export interface ExecutiveWorkbookInput {
  title: string;
  generatedBy: string;
  generatedAtIso?: string;
  sheets: ExportTableSheet[];
}

export interface DocxReportSection {
  heading: string;
  paragraphs?: string[];
  table?: { headers: string[]; rows: string[][] };
}

export interface DocxReportInput {
  title: string;
  subtitle?: string;
  metadata: Array<[string, string]>;
  sections: DocxReportSection[];
  pazYSalvo?: { codigo: string; sha256: string } | null;
  signatures?: string[];
}

/** Neutraliza `=`, `+`, `-`, `@`, TAB y CR iniciales para que Excel los trate como texto literal. */
export function neutralizeFormulaInjection(value: unknown): string {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function sanitizeSheetName(name: string, index: number): string {
  const clean = name.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
  return clean || `Hoja${index + 1}`;
}

export async function buildExecutiveWorkbookBuffer(
  input: ExecutiveWorkbookInput
): Promise<ArrayBuffer | Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CODIZULCA C.A. · Trade Marketing';
  wb.created = input.generatedAtIso ? new Date(input.generatedAtIso) : new Date();
  wb.title = neutralizeFormulaInjection(input.title);

  input.sheets.forEach((sheet, idx) => {
    const ws = wb.addWorksheet(sanitizeSheetName(sheet.name, idx));
    ws.addRow([neutralizeFormulaInjection(input.title)]).font = { bold: true, size: 14 };
    ws.addRow([
      neutralizeFormulaInjection(
        `Generado por ${input.generatedBy} · ${input.generatedAtIso || new Date().toISOString()}`
      ),
    ]).font = { italic: true, size: 9 };
    ws.addRow([]);

    const headerRow = ws.addRow(sheet.headers.map(neutralizeFormulaInjection));
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    for (const row of sheet.rows) {
      const added = ws.addRow(
        row.map((v) => {
          if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
          if (typeof v === 'boolean') return v ? 'SI' : 'NO';
          return neutralizeFormulaInjection(v);
        })
      );
      for (const c of sheet.currencyColumns || []) {
        added.getCell(c + 1).numFmt = '"$"#,##0.00';
      }
      for (const c of sheet.percentColumns || []) {
        const cell = added.getCell(c + 1);
        if (typeof cell.value === 'number') cell.value = cell.value / 100;
        cell.numFmt = '0.0%';
      }
    }

    sheet.headers.forEach((h, i) => {
      const maxLen = Math.max(
        h.length,
        ...sheet.rows.map((r) => String(r[i] ?? '').length)
      );
      ws.getColumn(i + 1).width = Math.min(48, Math.max(12, maxLen + 2));
    });
    ws.views = [{ state: 'frozen', ySplit: 4 }];
  });

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export async function buildDocxReportBuffer(input: DocxReportInput): Promise<Uint8Array> {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel } =
    docx;

  const cell = (text: string, bold = false) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
    });

  const makeTable = (headers: string[], rows: string[][]) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: headers.map((h) => cell(h, true)) }),
        ...rows.map((r) => new TableRow({ children: r.map((c) => cell(String(c ?? ''))) })),
      ],
    });

  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: 'CODIZULCA C.A. · RIF J-07011928-0', bold: true })],
    }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(input.title)] }),
  ];
  if (input.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: input.subtitle, italics: true })] }));

  children.push(makeTable(['Campo', 'Valor'], input.metadata.map(([k, v]) => [k, v])));

  for (const section of input.sections) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(section.heading)] })
    );
    for (const p of section.paragraphs || []) {
      children.push(new Paragraph({ children: [new TextRun(p)] }));
    }
    if (section.table) children.push(makeTable(section.table.headers, section.table.rows));
  }

  if (input.pazYSalvo) {
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Certificado Paz y Salvo')] }),
      new Paragraph({ children: [new TextRun(`Código: ${input.pazYSalvo.codigo}`)] }),
      new Paragraph({ children: [new TextRun({ text: `SHA-256: ${input.pazYSalvo.sha256}`, font: 'Consolas' })] })
    );
  }

  children.push(new Paragraph({ children: [new TextRun('')] }));
  for (const sig of input.signatures || ['Elaborado por', 'Revisado por', 'Aprobado por']) {
    children.push(
      new Paragraph({ children: [new TextRun('______________________________')] }),
      new Paragraph({ children: [new TextRun({ text: sig, bold: true })] })
    );
  }

  const doc = new Document({
    creator: 'CODIZULCA C.A. · Trade Marketing',
    title: input.title,
    sections: [{ children }],
  });
  return Packer.toBuffer ? ((await Packer.toBuffer(doc)) as Uint8Array) : new Uint8Array();
}

function triggerBlobDownload(data: BlobPart, fileName: string, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function downloadExecutiveWorkbookXlsx(
  input: ExecutiveWorkbookInput,
  fileName: string
): Promise<void> {
  const buf = await buildExecutiveWorkbookBuffer(input);
  triggerBlobDownload(
    buf as BlobPart,
    fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

export async function downloadDocxReport(input: DocxReportInput, fileName: string): Promise<void> {
  const buf = await buildDocxReportBuffer(input);
  triggerBlobDownload(
    buf as BlobPart,
    fileName.endsWith('.docx') ? fileName : `${fileName}.docx`,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}
