import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  MAX_EXCEL_FILE_BYTES,
  MAX_IMPORT_ROWS,
  createSafeNullMap,
  excelDateParser,
  formatExcelRowDateError,
  isDangerousObjectKey,
  isFechaDegustacionHeader,
  normalizeExcelHeader,
  sanitizeSpreadsheetText,
} from '../src/utils/excelDateParser';
import {
  MAX_UPLOAD_FILE_BYTES,
  extractTabularDegustacionFile,
  mapMatrixToDegustacionRows,
  validateUploadFileMetadata,
} from '../src/utils/degustacionesTabularParser';
import {
  EditableRowDraft,
  validateAndEnrichExtractedRows,
} from '../src/services/degustacionesPipelineService';
import {
  MAX_IMPORT_FILE_BYTES as CHOFER_MAX_BYTES,
  matrizAEntregas,
  sanitizarTextoCelda,
} from '../ruta-degustacion/src/utils/csvImport';

process.env.TZ = 'America/Caracas'; // Forzar huso horario UTC-4 para validar bordes de medianoche

async function runExcelDateParserSuite(): Promise<void> {
  console.log('================================================================================');
  console.log('🧪 SUITE INTEGRAL DE CALIDAD Y SEGURIDAD: excelDateParser + Importación Excel/CSV');
  console.log('================================================================================\n');

  // ---------------------------------------------------------------------------
  // (a) Seriales numéricos de Excel (enteros, decimales, texto, date1904 y bug 1900)
  // ---------------------------------------------------------------------------
  const serialOct15 = excelDateParser(46310);
  assert.equal(serialOct15.ok, true);
  assert.equal(serialOct15.isoDate, '2026-10-15', 'Serial 46310 debe ser exactamente 2026-10-15');
  assert.equal(serialOct15.displayDate, '15-10-2026');

  const serialDecimalNoon = excelDateParser(46310.5);
  assert.equal(serialDecimalNoon.ok, true);
  assert.equal(serialDecimalNoon.isoDate, '2026-10-15', 'Serial decimal 46310.5 debe mantener 2026-10-15');

  const serialDecimalLate = excelDateParser(46310.99);
  assert.equal(serialDecimalLate.ok, true);
  assert.equal(serialDecimalLate.isoDate, '2026-10-15', 'Serial 46310.99 no debe saltar al día siguiente');

  const serialOct05 = excelDateParser(46300);
  assert.equal(serialOct05.ok, true);
  assert.equal(serialOct05.isoDate, '2026-10-05');

  const serialStringComma = excelDateParser('46310,5');
  assert.equal(serialStringComma.ok, true);
  assert.equal(serialStringComma.isoDate, '2026-10-15');

  const serial1904 = excelDateParser(46310 - 1462, { date1904: true });
  assert.equal(serial1904.ok, true);
  assert.equal(serial1904.isoDate, '2026-10-15', 'Modo date1904 debe compensar +1462 días');

  const phantomFeb291900 = excelDateParser(60, { minYear: 1899 });
  assert.equal(phantomFeb291900.ok, false, 'Serial 60 (29/02/1900) debe rechazarse');
  assert.equal(phantomFeb291900.errorCode, 'NON_EXISTENT_DAY');

  const straySmallInt = excelDateParser(15);
  assert.equal(straySmallInt.ok, false, 'Un entero suelto como 15 jamás debe grabarse como año 1900');
  assert.equal(straySmallInt.errorCode, 'OUT_OF_RANGE_YEAR');

  console.log('✅ [a] Seriales numéricos de Excel (enteros, decimales, date1904 y bloqueo 1900) verificados.');

  // ---------------------------------------------------------------------------
  // (b) Cadenas regionales e ISO: prioridad estricta DD/MM/YYYY sobre MM/DD/YYYY
  // ---------------------------------------------------------------------------
  const txt15Oct = excelDateParser('15/10/2026');
  assert.equal(txt15Oct.ok, true);
  assert.equal(txt15Oct.isoDate, '2026-10-15');
  assert.equal(txt15Oct.displayDate, '15-10-2026');

  const txt05Oct = excelDateParser('05/10/2026');
  assert.equal(txt05Oct.ok, true);
  assert.equal(
    txt05Oct.isoDate,
    '2026-10-05',
    '"05/10/2026" DEBE interpretarse como 5 de octubre (2026-10-05) y jamás como 10 de mayo'
  );
  assert.equal(txt05Oct.displayDate, '05-10-2026');

  assert.equal(excelDateParser('5/10/2026').isoDate, '2026-10-05');
  assert.equal(excelDateParser('05-10-2026').isoDate, '2026-10-05');
  assert.equal(excelDateParser('05.10.2026').isoDate, '2026-10-05');
  assert.equal(excelDateParser('05/10/26').isoDate, '2026-10-05');
  assert.equal(excelDateParser('2026-10-05').isoDate, '2026-10-05');
  assert.equal(excelDateParser('5 de octubre de 2026').isoDate, '2026-10-05');
  assert.equal(excelDateParser('29/02/2024').isoDate, '2024-02-29', 'Año bisiesto real 2024 válido');

  console.log('✅ [b] Prioridad estricta latinoamericana DD/MM/YYYY ("05/10/2026" -> 2026-10-05) verificada.');

  // ---------------------------------------------------------------------------
  // (c) Bordes de medianoche en UTC-4 (America/Caracas): cero retroceso al día anterior
  // ---------------------------------------------------------------------------
  const utcMidnightIso = new Date('2026-10-15T00:00:00.000Z');
  const parsedUtcMidnight = excelDateParser(utcMidnightIso);
  assert.equal(parsedUtcMidnight.ok, true);
  assert.equal(
    parsedUtcMidnight.isoDate,
    '2026-10-15',
    'Medianoche UTC (20:00 del día 14 en UTC-4) jamás debe retroceder a 2026-10-14'
  );

  const utcJustAfterMidnight = new Date('2026-10-15T01:30:00.000Z'); // 21:30 del día 14 en UTC-4
  assert.equal(
    excelDateParser(utcJustAfterMidnight).isoDate,
    '2026-10-15',
    '01:30Z (21:30 del día anterior en UTC-4) no debe retroceder a 2026-10-14'
  );

  const localMidnight = new Date(2026, 9, 15, 0, 0, 0, 0);
  assert.equal(
    excelDateParser(localMidnight).isoDate,
    '2026-10-15',
    'Medianoche local new Date(2026, 9, 15) debe conservar exactamente 2026-10-15'
  );

  assert.equal(excelDateParser(46310.0).isoDate, '2026-10-15');
  assert.equal(excelDateParser(46310.01).isoDate, '2026-10-15');
  assert.equal(excelDateParser('2026-10-15T00:00:00Z').isoDate, '2026-10-15');

  console.log('✅ [c] Bordes de medianoche en UTC-4 (America/Caracas) verificados sin desfase de -1 día.');

  // ---------------------------------------------------------------------------
  // (d) Encabezados con tildes, conectores, espacios extras, hojas múltiples y celdas combinadas
  // ---------------------------------------------------------------------------
  const messyHeaders = [
    '   Fecha   de   Degustación   ',
    'FECHA DE LA DEGUSTACIÓN (DD/MM/YYYY)',
    'Fecha Degustacion',
    '  Fecha\u00A0Programada  ',
    'Fec. Degustación',
    'Día de Degustación',
    '  Fecha  ',
  ];
  for (const h of messyHeaders) {
    const nh = normalizeExcelHeader(h);
    assert.equal(
      isFechaDegustacionHeader(nh),
      true,
      `El encabezado "${h}" debe reconocerse como columna de fecha (canónica: ${nh.canonicalKey})`
    );
  }
  assert.equal(
    isFechaDegustacionHeader(normalizeExcelHeader('Fecha de Vencimiento')),
    false,
    '"Fecha de Vencimiento" no debe confundirse con la fecha de la degustación'
  );

  // Libro Excel real en memoria:
  // - Hoja 1: "PORTADA" sin tabla
  // - Hoja 2: "CRONOGRAMA" con banner en fila 1, fila 2 vacía, encabezados con tildes/espacios en fila 3,
  //   celdas de fecha combinadas verticalmente en filas 4 y 5 ("05/10/2026"), serial decimal en fila 6,
  //   fila 7 vacía y fecha corrupta en fila 8 ("31/02/2026") + error de fórmula Excel en fila 9 (#¡VALOR!)
  const wb = XLSX.utils.book_new();
  const wsCover = XLSX.utils.aoa_to_sheet([['REPORTE CORPORATIVO CODIZULCA'], ['CONFIDENCIAL']]);
  XLSX.utils.book_append_sheet(wb, wsCover, 'PORTADA');

  const wsSchedule = XLSX.utils.aoa_to_sheet([
    ['PLANIFICACIÓN COMERCIAL OCTUBRE 2026'], // Fila Excel #1
    [], // Fila Excel #2 (vacía)
    [
      '  Fecha   de   Degustación (DD/MM/AAAA)  ',
      '  Punto   de   Venta  ',
      'Producto a Degustar',
      'Cantidad en Kilos',
      'Fuerza de Ventas',
      'Promotora Sugerida',
    ], // Fila Excel #3 (Encabezados)
    ['05/10/2026', 'FIORELLA HIPERMARKET NORTE', 'MORTADELA', 3, 'CARLOS PEREZ', 'JULIANNYS'], // Fila Excel #4
    ['', 'ENNE FUERZAS ARMADAS', 'ESPALDA', 2.5, 'LUIS SOTO', 'SCARLETH'], // Fila Excel #5 (hereda fecha por !merges A4:A5)
    [46310.5, 'DE CANDIDO EXPRESS', 'ARROZ VENCAMPO', 4, 'ANA RUIZ', ''], // Fila Excel #6 (serial decimal -> 2026-10-15)
    [], // Fila Excel #7 (completamente vacía -> omitida sin desplazar numeración)
    ['31/02/2026', 'SUPERMERCADO ZULIA', 'MORTADELA ESPECIAL', 3.5, 'PEDRO GIL', 'MARIANGEL'], // Fila Excel #8 (fecha inexistente)
    ['placeholder', 'HIPER LIDER CABIMAS', 'CHORIZO', 2, 'JOSE DIAZ', ''], // Fila Excel #9 (se inyecta error de fórmula t='e')
  ]);

  // Combinar verticalmente A4:A5 (índices 0-based r:3..4, c:0)
  wsSchedule['!merges'] = [{ s: { r: 3, c: 0 }, e: { r: 4, c: 0 } }];
  // Simular error real de fórmula Excel en celda A9 (r:8, c:0) con código numérico interno v=15
  wsSchedule['A9'] = { t: 'e', v: 15, w: '#¡VALOR!' };

  XLSX.utils.book_append_sheet(wb, wsSchedule, 'CRONOGRAMA');
  const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const extracted = await extractTabularDegustacionFile(xlsxBuffer, 'xlsx', {
    fileName: 'Planificacion_Octubre_2026.xlsx',
  });

  assert.equal(extracted.rows.length, 5, 'Debe extraer exactamente las 5 filas reales de la hoja CRONOGRAMA');

  // Fila Excel #4: "05/10/2026" -> 2026-10-05
  assert.equal(extracted.rows[0]!.excelRowNumber, 4);
  assert.equal(extracted.rows[0]!.fecha, '2026-10-05');
  assert.equal(extracted.rows[0]!.fechaFormateada, '05-10-2026');

  // Fila Excel #5: celda combinada vertical A4:A5 -> hereda 2026-10-05
  assert.equal(extracted.rows[1]!.excelRowNumber, 5);
  assert.equal(extracted.rows[1]!.fecha, '2026-10-05');
  assert.equal(extracted.rows[1]!.clienteNombre, 'ENNE FUERZAS ARMADAS');

  // Fila Excel #6: serial decimal 46310.5 -> 2026-10-15
  assert.equal(extracted.rows[2]!.excelRowNumber, 6);
  assert.equal(extracted.rows[2]!.fecha, '2026-10-15');

  // Fila Excel #8 (tras saltar la fila #7 vacía sin perder el número exacto #8!)
  assert.equal(
    extracted.rows[3]!.excelRowNumber,
    8,
    'La numeración debe coincidir exactamente con la Fila #8 del Excel aunque la fila #7 esté vacía'
  );
  assert.equal(extracted.rows[3]!.fecha, '');
  assert.equal(extracted.rows[3]!.clienteNombre, 'SUPERMERCADO ZULIA', 'El resto de campos válidos debe preservarse intacto');
  assert.equal(extracted.rows[3]!.cantidadKilos, 3.5);
  assert.ok(extracted.rows[3]!.fechaErrorDetalle?.includes('Fila Excel #8'));
  assert.ok(extracted.rows[3]!.fechaErrorDetalle?.includes('31/02/2026'));

  // Fila Excel #9: celda de error de fórmula t='e' (v=15, w='#¡VALOR!') jamás debe leerse como serial 15 (1900-01-15)
  assert.equal(extracted.rows[4]!.excelRowNumber, 9);
  assert.equal(extracted.rows[4]!.fecha, '');
  assert.ok(extracted.rows[4]!.fechaErrorDetalle?.includes('Fila Excel #9'));
  assert.ok(
    extracted.rows[4]!.fechaErrorDetalle?.includes('#VALUE!') ||
      extracted.rows[4]!.fechaErrorDetalle?.includes('#¡VALOR!'),
    `Error esperado #VALUE! o #¡VALOR!, actual: ${extracted.rows[4]!.fechaErrorDetalle}`
  );

  // Verificar también en ruta-degustacion/src/utils/csvImport.ts
  const choferResult = matrizAEntregas([
    ['  Fecha   de   Degustación  ', 'Turno', 'Punto de Venta', 'Producto a Degustar', 'Fuerza de Ventas', 'Promotora'],
    ['05/10/2026', 'MAÑANA', 'FIORELLA NORTE', 'MORTADELA', 'CARLOS', 'JULIANNYS'],
    [new Date('2026-10-15T00:00:00.000Z'), 'TARDE', 'ENNE FUERZAS ARMADAS', 'ESPALDA', 'LUIS', 'SCARLETH'],
  ]);
  assert.equal(choferResult.errors.length, 0);
  assert.equal(choferResult.rows[0]!.fecha, '05-10-2026');
  assert.equal(choferResult.rows[1]!.fecha, '15-10-2026');

  console.log('✅ [d] Encabezados con tildes/conectores/espacios, multi-hoja, !merges y numeración exacta Excel verificados.');

  // ---------------------------------------------------------------------------
  // (e) Valores vacíos/inválidos, errores explícitos por fila y reglas de Seguridad
  // ---------------------------------------------------------------------------
  const invalidCases: Array<{ input: unknown; expectedCode: string }> = [
    { input: '', expectedCode: 'EMPTY' },
    { input: '   ', expectedCode: 'EMPTY' },
    { input: null, expectedCode: 'EMPTY' },
    { input: undefined, expectedCode: 'EMPTY' },
    { input: 'SIN FECHA', expectedCode: 'EMPTY' },
    { input: '31/02/2026', expectedCode: 'NON_EXISTENT_DAY' },
    { input: '29/02/2026', expectedCode: 'NON_EXISTENT_DAY' },
    { input: '31/04/2026', expectedCode: 'NON_EXISTENT_DAY' },
    { input: '15/13/2026', expectedCode: 'INVALID_MONTH' },
    { input: '05/13/2026', expectedCode: 'INVALID_MONTH' },
    { input: '11/25/2026', expectedCode: 'INVALID_MONTH' },
    { input: '#VALUE!', expectedCode: 'EXCEL_FORMULA_ERROR' },
    { input: 'TEXTO_CORRUPTO', expectedCode: 'UNRECOGNIZED_FORMAT' },
  ];

  for (const tc of invalidCases) {
    const res = excelDateParser(tc.input);
    assert.equal(res.ok, false, `Valor inválido debe fallar: ${String(tc.input)}`);
    assert.equal(res.isoDate, null);
    assert.equal(res.errorCode, tc.expectedCode, `Código esperado para ${String(tc.input)}`);
  }

  // Verificar preservación de campos válidos y mensaje explícito en validateAndEnrichExtractedRows
  const draftsFromExcel: EditableRowDraft[] = extracted.rows.map((r, idx) => ({
    rowIndex: idx + 1,
    excelRowNumber: r.excelRowNumber,
    fecha: r.fecha,
    fechaFormateada: r.fechaFormateada,
    fechaTimestamp: r.fechaTimestamp,
    rawFechaArchivo: r.rawFecha,
    fechaErrorDetalle: r.fechaErrorDetalle,
    fechaOrigenParcial: r.fechaOrigenParcial,
    horaInicio: r.horaInicio,
    horaFin: r.horaFin,
    turno: r.turno,
    clienteNombre: r.clienteNombre,
    clienteCodigo: r.clienteCodigo,
    zonaDireccion: r.zonaDireccion,
    productos: r.productos,
    cantidadKilos: r.cantidadKilos,
    personasEstimadas: r.personasEstimadas,
    vendedorFdv: r.vendedorFdv,
    promotoraSugerida: r.promotoraSugerida,
    rawPromotoraArchivo: r.promotoraSugerida,
    observaciones: r.observaciones,
  }));

  const enriched = await validateAndEnrichExtractedRows(draftsFromExcel, {
    pdvCatalog: [],
    promotoraCatalog: [],
    existingDbHashes: new Set(),
    baseYear: 2026,
    baseMonth: 10,
  });

  const row8Enriched = enriched[3]!;
  assert.equal(row8Enriched.excelRowNumber, 8);
  assert.equal(row8Enriched.nivelValidacion, 'ERROR');
  assert.ok(
    row8Enriched.mensajesValidacion.some(
      (m) => m.includes('Fila Excel #8') && m.includes('31/02/2026')
    ),
    `El error de la fila 8 debe indicar número de fila y valor recibido, actual: ${row8Enriched.mensajesValidacion.join(' | ')}`
  );
  // Todos los demás campos válidos de la fila #8 permanecen íntegros:
  assert.equal(row8Enriched.clienteNombre, 'SUPERMERCADO ZULIA');
  assert.equal(row8Enriched.productoResumen, 'MORTADELA ESPECIAL');
  assert.equal(row8Enriched.cantidadKilos, 3.5);
  assert.equal(row8Enriched.vendedorFdv, 'PEDRO GIL');

  // Seguridad 1: Límite de 10 MB y extensiones permitidas
  assert.equal(MAX_EXCEL_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_UPLOAD_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(CHOFER_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(
    validateUploadFileMetadata({
      name: 'Exceso_11MB.xlsx',
      size: 11 * 1024 * 1024,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }).valid,
    false
  );
  assert.equal(
    validateUploadFileMetadata({
      name: 'Script.js',
      size: 512,
      type: 'application/javascript',
    }).valid,
    false
  );

  // Seguridad 2: Límite máximo de filas por lote (MAX_IMPORT_ROWS = 2000)
  const oversizedMatrix: unknown[][] = [['FECHA', 'CLIENTE', 'PRODUCTO', 'KILOS']];
  for (let i = 0; i < MAX_IMPORT_ROWS + 5; i++) {
    oversizedMatrix.push(['15/10/2026', `PDV ${i}`, 'MORTADELA', 2]);
  }
  assert.throws(
    () => mapMatrixToDegustacionRows(oversizedMatrix as string[][]),
    /supera el máximo permitido de 2000 registros/
  );

  // Seguridad 3: Anti-Prototype Pollution
  assert.equal(isDangerousObjectKey('__proto__'), true);
  assert.equal(isDangerousObjectKey('constructor'), true);
  assert.equal(isDangerousObjectKey('prototype'), true);
  const safeMap = createSafeNullMap([
    ['__proto__', 'hacked'],
    ['constructor', 'hacked'],
    ['prototype', 'hacked'],
    ['fecha', '2026-10-15'],
  ]);
  assert.equal(Object.getPrototypeOf(safeMap), null);
  assert.equal(safeMap.fecha, '2026-10-15');
  assert.equal(({} as Record<string, unknown>).hacked, undefined);

  const protoMatrix = [
    ['__proto__', 'constructor', 'prototype', 'Fecha de Degustación', 'Cliente', 'Producto'],
    ['evil1', 'evil2', 'evil3', '05/10/2026', 'PDV SEGURO', 'MORTADELA'],
  ];
  const protoExtracted = mapMatrixToDegustacionRows(protoMatrix);
  assert.equal(protoExtracted.rows.length, 1);
  assert.equal(protoExtracted.rows[0]!.fecha, '2026-10-05');
  assert.equal(({} as Record<string, unknown>).evil1, undefined);

  // Seguridad 4: Sanitización contra Formula/CSV Injection (incluyendo tab/CR iniciales)
  assert.equal(sanitizeSpreadsheetText("=CMD|' /C calc'!A0"), "CMD|' /C calc'!A0");
  assert.equal(sanitizeSpreadsheetText('\t=SUM(A1:A10)'), 'SUM(A1:A10)');
  assert.equal(sanitizeSpreadsheetText('\r@IMPORTXML("http://evil","//a")'), 'IMPORTXML("http://evil","//a")');
  assert.equal(sanitizeSpreadsheetText('+HYPERLINK("http://evil")'), 'HYPERLINK("http://evil")');
  assert.equal(sanitizeSpreadsheetText('-3.5'), '-3.5', 'Número negativo legítimo debe preservarse');
  assert.equal(sanitizeSpreadsheetText('2026-10-15'), '2026-10-15', 'Fecha ISO válida debe preservarse');
  assert.equal(sanitizarTextoCelda('\t=CMD()'), 'CMD()');
  assert.equal(sanitizarTextoCelda('-12,5'), '-12,5');

  const formattedErr = formatExcelRowDateError({
    excelRowNumber: 14,
    rawValue: '15/13/2026',
  });
  assert.ok(formattedErr.includes('Fila Excel #14'));
  assert.ok(formattedErr.includes('15/13/2026'));

  console.log('✅ [e] Fechas inválidas, errores explícitos por fila y controles de seguridad (10MB, 2000 filas, Anti-Proto, Anti-Formula) verificados.\n');

  console.log('================================================================================');
  console.log('🎉 SUITE excelDateParser COMPLETADA: 100% DE PRUEBAS PASARON CON 0 ERRORES.');
  console.log('================================================================================');
}

runExcelDateParserSuite().catch((err) => {
  console.error('❌ Falló la suite verifyExcelDateParser:', err);
  process.exit(1);
});
