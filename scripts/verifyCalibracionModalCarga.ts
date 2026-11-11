import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  extractTabularDegustacionFile,
  inferInitialBasePeriod,
  parseFechaCronograma,
  sanitizeCellText,
} from '../src/utils/degustacionesTabularParser';
import {
  ActivePromotoraOption,
  CatalogPdvEntry,
  EditableRowDraft,
  enforceSafePromotoraFkId,
  matchPromotoraCatalogo,
  validateAndEnrichExtractedRows,
} from '../src/services/degustacionesPipelineService';

async function runVerification() {
  console.log('=== VERIFICACIÓN AUTOMATIZADA: CALIBRACIÓN MODAL CARGA MULTIFORMATO (FASES 0, 2 Y 3) ===\n');

  // ---------------------------------------------------------------------------
  // 1. FASE 0: Sanitización (`sanitizeCellText`) e Integridad FK (`enforceSafePromotoraFkId`)
  // ---------------------------------------------------------------------------
  assert.equal(
    sanitizeCellText('  \u0000\u200BFIORELLA\u0007   HIPERMARKET\n\tNORTE  '),
    'FIORELLA HIPERMARKET NORTE',
    'Debe limpiar caracteres de control invisibles, zero-width y espacios múltiples'
  );
  assert.equal(
    sanitizeCellText('=SUM(A1:A2)'),
    'SUM(A1:A2)',
    'Debe neutralizar prefijo = de CSV Formula Injection'
  );
  assert.equal(
    sanitizeCellText("+CMD|' /C calc'!A0"),
    "CMD|' /C calc'!A0",
    'Debe neutralizar prefijo + no numérico'
  );
  assert.equal(
    sanitizeCellText('-2+3+cmd()'),
    '2+3+cmd()',
    'Debe neutralizar prefijo - cuando no es un número con signo simple'
  );
  assert.equal(
    sanitizeCellText('@IMPORTXML("http://evil.example", "//a")'),
    'IMPORTXML("http://evil.example", "//a")',
    'Debe neutralizar prefijo @ de inyección de fórmulas'
  );
  assert.equal(
    sanitizeCellText('= +HYPERLINK("http://evil.example")'),
    'HYPERLINK("http://evil.example")',
    'Debe neutralizar prefijos encadenados con espacio'
  );
  assert.equal(sanitizeCellText('-3.5'), '-3.5', 'Debe preservar números negativos simples');
  assert.equal(sanitizeCellText('+12'), '+12', 'Debe preservar números positivos simples');
  assert.equal(sanitizeCellText('2026-11-08'), '2026-11-08', 'Debe preservar fechas ISO');
  assert.equal(
    sanitizeCellText('X'.repeat(320)).length,
    250,
    'Debe limitar la longitud máxima por defecto a 250 caracteres'
  );

  const activeUuidJuliannys = '11111111-1111-4111-8111-111111111111';
  const activeUuidScarleth = '22222222-2222-4222-8222-222222222222';
  const activeUuidMariangel = '33333333-3333-4333-8333-333333333333';
  const activeUuidMaria1 = '44444444-4444-4444-8444-444444444444';
  const activeUuidMaria2 = '55555555-5555-4555-8555-555555555555';
  const inactiveUuid = '99999999-9999-4999-8999-999999999999';

  const allowedIds = new Set([
    activeUuidJuliannys,
    activeUuidScarleth,
    activeUuidMariangel,
    activeUuidMaria1,
    activeUuidMaria2,
  ]);

  assert.equal(enforceSafePromotoraFkId(activeUuidJuliannys, allowedIds), activeUuidJuliannys);
  assert.equal(enforceSafePromotoraFkId(null, allowedIds), null);
  assert.equal(enforceSafePromotoraFkId('', allowedIds), null);
  assert.equal(enforceSafePromotoraFkId('JULIANNYS', allowedIds), null);
  assert.equal(enforceSafePromotoraFkId('Por asignar', allowedIds), null);
  assert.equal(
    enforceSafePromotoraFkId(inactiveUuid, allowedIds),
    null,
    'Jamás debe permitir un UUID ajeno al Catálogo Activo'
  );
  console.log('✓ [1/5] Sanitización CSV Formula Injection e integridad de llave foránea verificadas.');

  // ---------------------------------------------------------------------------
  // 2. FASE 2: Emparejamiento determinista `matchPromotoraCatalogo`
  // ---------------------------------------------------------------------------
  const promotoraCatalog: ActivePromotoraOption[] = [
    {
      id: activeUuidJuliannys,
      name: 'JULIANNYS GÓMEZ',
      canonicalKey: 'JULIANNYS GOMEZ',
      email: 'juliannys@codizulca.com',
      assignedStore: 'FIORELLA HIPERMARKET NORTE',
    },
    {
      id: activeUuidScarleth,
      name: 'SCARLETH PIÑA',
      canonicalKey: 'SCARLETH PINA',
      email: 'scarleth@codizulca.com',
      assignedStore: 'ENNE FUERZAS ARMADAS',
    },
    {
      id: activeUuidMariangel,
      name: 'MARIÁNGEL URDANETA',
      canonicalKey: 'MARIANGEL URDANETA',
      email: 'mariangel@codizulca.com',
      assignedStore: 'DE CANDIDO EXPRESS',
    },
    {
      id: activeUuidMaria1,
      name: 'MARÍA FERNÁNDEZ',
      canonicalKey: 'MARIA FERNANDEZ',
      email: 'maria.f@codizulca.com',
      assignedStore: 'PDV 1',
    },
    {
      id: activeUuidMaria2,
      name: 'MARÍA GONZÁLEZ',
      canonicalKey: 'MARIA GONZALEZ',
      email: 'maria.g@codizulca.com',
      assignedStore: 'PDV 2',
    },
  ];

  // Coincidencia exacta sin tildes
  const exactRes = matchPromotoraCatalogo('  scarleth   pina ', promotoraCatalog);
  assert.equal(exactRes.match?.id, activeUuidScarleth);
  assert.equal(exactRes.isAmbiguous, false);

  // Coincidencia única por primer nombre ("JULIANNYS", "MARIANGEL")
  const firstJuliannys = matchPromotoraCatalogo('JULIANNYS', promotoraCatalog);
  assert.equal(firstJuliannys.match?.id, activeUuidJuliannys);

  const firstMariangel = matchPromotoraCatalogo('Mariangel', promotoraCatalog);
  assert.equal(firstMariangel.match?.id, activeUuidMariangel);

  // Homónimas ambiguas ("MARIA") -> match: null, isAmbiguous: true
  const homonymRes = matchPromotoraCatalogo('MARIA', promotoraCatalog);
  assert.equal(homonymRes.match, null);
  assert.equal(homonymRes.isAmbiguous, true);

  // Vacía / "Por asignar" / No existente -> match: null
  const emptyRes = matchPromotoraCatalogo('', promotoraCatalog);
  assert.equal(emptyRes.match, null);
  assert.equal(emptyRes.isUnassignedPlaceholder, true);

  const unknownRes = matchPromotoraCatalogo('VALERIA EXTERNA', promotoraCatalog);
  assert.equal(unknownRes.match, null);
  assert.equal(unknownRes.isUnassignedPlaceholder, false);
  assert.equal(unknownRes.isAmbiguous, false);
  console.log('✓ [2/5] Emparejamiento determinista `matchPromotoraCatalogo` (exacto, primer nombre, homónimas y por asignar) verificado.');

  // ---------------------------------------------------------------------------
  // 3. FASE 3: `parseFechaCronograma` con Date.UTC (cero desfase UTC-4 y textos cortos)
  // ---------------------------------------------------------------------------
  // En Octubre 2026, el día 08 cae JUEVES (2026-10-08 -> getUTCDay() === 4)
  const octJueves08 = parseFechaCronograma('JUEVES 08', 2026, 10);
  assert.equal(octJueves08.ymd, '2026-10-08');
  assert.equal(octJueves08.fechaOrigenParcial, true);
  assert.equal(octJueves08.weekdayMatches, true);
  assert.equal(octJueves08.weekdayMismatchMessage, null);

  // En Noviembre 2026, resuelve automáticamente a '08-11-2026' ('2026-11-08') de forma silenciosa
  const novJueves08 = parseFechaCronograma('JUEVES 08', 2026, 11);
  assert.equal(novJueves08.ymd, '2026-11-08');
  assert.equal(novJueves08.fechaFormateada, '08-11-2026');
  assert.equal(novJueves08.fechaOrigenParcial, true);
  assert.equal(novJueves08.weekdayMismatchMessage, null);

  // "VIERNES 9", "SABADO 10", "MIÉRCOLES 07" en Octubre 2026
  assert.equal(parseFechaCronograma('VIERNES 9', 2026, 10).ymd, '2026-10-09');
  assert.equal(parseFechaCronograma('VIERNES 9', 2026, 10).fechaFormateada, '09-10-2026');
  assert.equal(parseFechaCronograma('SABADO 10', 2026, 10).ymd, '2026-10-10');
  assert.equal(parseFechaCronograma('SABADO 10', 2026, 10).fechaFormateada, '10-10-2026');
  assert.equal(parseFechaCronograma('MIÉRCOLES 07', 2026, 10).ymd, '2026-10-07');
  assert.equal(parseFechaCronograma('MIÉRCOLES 07', 2026, 10).fechaFormateada, '07-10-2026');

  // Textos en español con mes explícito y formato latino con año corto
  assert.equal(parseFechaCronograma('08 DE NOVIEMBRE 2026', 2026, 10).ymd, '2026-11-08');
  assert.equal(parseFechaCronograma('08 DE NOVIEMBRE 2026', 2026, 10).fechaFormateada, '08-11-2026');
  assert.equal(parseFechaCronograma('08 DE NOVIEMBRE 2026', 2026, 10).fechaOrigenParcial, false);
  assert.equal(parseFechaCronograma('08 NOV', 2026, 10).ymd, '2026-11-08');
  assert.equal(parseFechaCronograma('08/11/26', 2026, 10).ymd, '2026-11-08');
  assert.equal(parseFechaCronograma('08.11.2026', 2026, 10).ymd, '2026-11-08');

  // Validación estricta de calendario real: 31 de Noviembre NO existe (silencioso, devuelve vacío)
  const nov31 = parseFechaCronograma('MARTES 31', 2026, 11);
  assert.equal(nov31.ymd, '');
  assert.equal(nov31.fechaFormateada, '');

  // El mismo "JUEVES 31" en Diciembre 2026 SÍ existe y cae jueves (2026-12-31)
  const dec31 = parseFechaCronograma('JUEVES 31', 2026, 12);
  assert.equal(dec31.ymd, '2026-12-31');
  assert.equal(dec31.weekdayMatches, true);

  // Serial numérico de Excel con Date.UTC(1899, 11, 30) sin desfase de -1 día en UTC-4
  const serialNov08 = Math.round(
    (Date.UTC(2026, 10, 8) - Date.UTC(1899, 11, 30)) / 86_400_000
  );
  const parsedSerial = parseFechaCronograma(serialNov08, 2026, 1);
  assert.equal(parsedSerial.ymd, '2026-11-08');
  assert.equal(parsedSerial.fechaOrigenParcial, false);

  // Inferencia automática de Periodo Base
  assert.deepEqual(inferInitialBasePeriod('Planificacion_Octubre_2026.xlsx', ['JUEVES 08']), {
    year: 2026,
    month: 10,
  });
  console.log('✓ [3/5] Motor `parseFechaCronograma` (Date.UTC, seriales Excel, días cortos y validación calendario) verificado.');

  // ---------------------------------------------------------------------------
  // 4. FASE 2 + 3 INTEGRADAS: Reactividad de Periodo Base y Pase Sin Bloqueo "Por Asignar"
  // ---------------------------------------------------------------------------
  const pdvCatalog: CatalogPdvEntry[] = [
    {
      canonicalKey: 'FIORELLA HIPERMARKET NORTE',
      name: 'FIORELLA HIPERMARKET NORTE',
      clientCode: 'CLI-101',
      zone: 'MARACAIBO NORTE',
      address: 'AV. FUERZAS ARMADAS',
    },
  ];

  const initialDrafts: EditableRowDraft[] = [
    {
      rowIndex: 1,
      fecha: '',
      rawFechaArchivo: 'JUEVES 08',
      fechaOrigenParcial: true,
      horaInicio: '09:00',
      horaFin: '13:00',
      turno: 'MAÑANA',
      clienteNombre: 'FIORELLA HIPERMARKET NORTE',
      clienteCodigo: 'CLI-101',
      zonaDireccion: 'AV. FUERZAS ARMADAS',
      productos: ['MORTADELA ESPECIAL'],
      cantidadKilos: 2.5,
      personasEstimadas: 80,
      vendedorFdv: 'CARLOS PEREZ',
      promotoraSugerida: 'JULIANNYS',
      rawPromotoraArchivo: 'JULIANNYS',
      observaciones: '',
    },
    {
      rowIndex: 2,
      fecha: '',
      rawFechaArchivo: 'VIERNES 09',
      fechaOrigenParcial: true,
      horaInicio: '14:00',
      horaFin: '18:00',
      turno: 'TARDE',
      clienteNombre: 'FIORELLA HIPERMARKET NORTE',
      clienteCodigo: 'CLI-101',
      zonaDireccion: 'AV. FUERZAS ARMADAS',
      productos: ['CHORIZO AHUMADO'],
      cantidadKilos: 3,
      personasEstimadas: 90,
      vendedorFdv: 'LUIS SOTO',
      promotoraSugerida: '',
      rawPromotoraArchivo: '',
      observaciones: 'Dejar por asignar para Coordinadora en Módulo 2',
    },
    {
      rowIndex: 3,
      fecha: '2026-11-20',
      rawFechaArchivo: 'VIERNES 09',
      fechaOrigenParcial: false,
      fechaEditadaManualmente: true,
      horaInicio: '09:00',
      horaFin: '13:00',
      turno: 'MAÑANA',
      clienteNombre: 'FIORELLA HIPERMARKET NORTE',
      clienteCodigo: 'CLI-101',
      zonaDireccion: 'AV. FUERZAS ARMADAS',
      productos: ['JAMON PIERNA'],
      cantidadKilos: 2,
      personasEstimadas: 60,
      vendedorFdv: 'ANA RUIZ',
      promotoraSugerida: 'EXTERNA NO REGISTRADA',
      rawPromotoraArchivo: 'EXTERNA NO REGISTRADA',
      observaciones: '',
    },
  ];

  // Evaluar primero con Periodo Base Noviembre 2026 (donde Jueves 08 y Viernes 09 NO coinciden en día de semana)
  const enrichedNov = await validateAndEnrichExtractedRows(initialDrafts, {
    pdvCatalog,
    promotoraCatalog,
    existingDbHashes: new Set(),
    baseYear: 2026,
    baseMonth: 11,
  });

  assert.equal(enrichedNov[0]!.fecha, '2026-11-08');
  assert.equal(enrichedNov[0]!.fechaFormateada, '08-11-2026');
  assert.equal(
    enrichedNov[0]!.nivelValidacion,
    'VALIDO',
    'La conversión de fecha a dd-mm-aaaa es 100% automática y silenciosa sin advertencias intermedias de día de semana'
  );
  assert.equal(enrichedNov[0]!.promotoraId, activeUuidJuliannys);
  assert.equal(enrichedNov[0]!.promotoraCoincidenciaArchivo, true);

  assert.equal(enrichedNov[1]!.promotoraId, null, 'Promotora vacía debe quedar en null ("Por asignar")');
  assert.notEqual(enrichedNov[1]!.nivelValidacion, 'ERROR', 'Promotora null JAMÁS debe marcar error rojo');

  assert.equal(enrichedNov[2]!.promotoraId, null, 'Promotora no reconocida debe quedar en null ("Por asignar")');
  assert.equal(enrichedNov[2]!.nivelValidacion, 'ADVERTENCIA', 'Promotora desconocida advierte pase a Módulo 2 sin bloquear');
  assert.equal(enrichedNov[2]!.fecha, '2026-11-20', 'Fila editada manualmente debe conservar su fecha');

  // Cambiar Periodo Base a Octubre 2026 -> JUEVES 08 y VIERNES 09 ahora coinciden exactamente y pasan a VALIDO (Verde)
  const enrichedOct = await validateAndEnrichExtractedRows(initialDrafts, {
    pdvCatalog,
    promotoraCatalog,
    existingDbHashes: new Set(),
    baseYear: 2026,
    baseMonth: 10,
  });

  assert.equal(enrichedOct[0]!.fecha, '2026-10-08');
  assert.equal(enrichedOct[0]!.nivelValidacion, 'VALIDO');
  assert.equal(enrichedOct[1]!.fecha, '2026-10-09');
  assert.equal(enrichedOct[1]!.nivelValidacion, 'VALIDO', 'Fila con promotora vacía y PDV/fecha válidos debe ser 100% VALIDO');
  assert.equal(enrichedOct[2]!.fecha, '2026-11-20', 'Edición manual de fecha no debe sobrescribirse al cambiar Periodo Base');
  console.log('✓ [4/5] Reactividad de Periodo Base y desbloqueo de filas "Por asignar" hacia Módulo 2 verificados.');

  // ---------------------------------------------------------------------------
  // 5. Prueba de extremo a extremo con libro `.xlsx` binario real (seriales + fórmulas maliciosas)
  // ---------------------------------------------------------------------------
  const wb = XLSX.utils.book_new();
  const wsData = [
    ['FECHA', 'HORARIO', 'CLIENTE', 'PRODUCTO', 'KILOS', 'VENDEDOR', 'PROMOTORA'],
    ['JUEVES 08', '09:00 A 13:00', '=FIORELLA HIPERMARKET NORTE', 'MORTADELA', 2.5, 'CARLOS', 'SCARLETH'],
    [serialNov08, 'PM', 'ENNE FUERZAS ARMADAS', 'CHORIZO', 3, '+PEDRO', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'OCTUBRE');
  const xlsxOut = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const extractedBook = await extractTabularDegustacionFile(xlsxOut, 'xlsx', {
    fileName: 'Cronograma_Octubre_2026.xlsx',
  });
  assert.equal(extractedBook.rows.length, 2);
  assert.equal(extractedBook.inferredPeriod.year, 2026);
  // Como la fila 2 trae serial explícito 2026-11-08, inferInitialBasePeriod prioriza fechas explícitas reales del archivo (mes 11)
  assert.equal(extractedBook.inferredPeriod.month, 11);
  assert.equal(extractedBook.rows[0]!.clienteNombre, 'FIORELLA HIPERMARKET NORTE');
  assert.equal(extractedBook.rows[1]!.vendedorFdv, 'PEDRO');
  assert.equal(extractedBook.rows[1]!.fecha, '2026-11-08');
  console.log('✓ [5/5] Extracción tabular `.xlsx` con seriales puros UTC y sanitización verificada.\n');

  console.log(' TODAS LAS PRUEBAS DE CALIBRACIÓN Y SEGURIDAD PASARON CON 0 ERRORES.');
}

runVerification().catch((err) => {
  console.error('❌ Falló la verificación:', err);
  process.exit(1);
});
