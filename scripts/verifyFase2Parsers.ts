import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import * as XLSX from 'xlsx';
import {
  extractTabularDegustacionFile,
  MAX_UPLOAD_FILE_BYTES,
  validateUploadFileMetadata,
} from '../src/utils/degustacionesTabularParser';
import {
  buildActivePromotoraCatalog,
  buildKnownPdvCatalog,
  validateAndEnrichExtractedRows,
} from '../src/services/degustacionesPipelineService';
import type { StaffMemberRecord } from '../src/services/supabaseModule1';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

async function fetchLiveActivePromotoras(): Promise<StaffMemberRecord[]> {
  const restUrl = (process.env.VITE_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
  if (!restUrl || !anonKey) return [];

  const res = await fetch(`${restUrl}/staff?select=id,name,role,email,status&limit=100`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
  });
  if (!res.ok) return [];

  const raw = (await res.json()) as Array<{
    id: string;
    name: string;
    role: string;
    email: string;
    status: string | Record<string, unknown> | null;
  }>;

  return raw
    .map((item): StaffMemberRecord => {
      let parsedStatus: Record<string, unknown> = {};
      if (typeof item.status === 'string') {
        try {
          parsedStatus = JSON.parse(item.status) as Record<string, unknown>;
        } catch {
          parsedStatus = { status: item.status };
        }
      } else if (item.status && typeof item.status === 'object') {
        parsedStatus = item.status;
      }

      const statusFlag =
        String(parsedStatus.status || 'Activo').toLowerCase() === 'inactivo'
          ? 'Inactivo'
          : 'Activo';
      const roleUpper = `${item.role || ''} ${String(parsedStatus.category || '')}`.toUpperCase();
      const isMerch = roleUpper.includes('MERCH');

      return {
        id: item.id,
        name: item.name,
        canonicalKey: item.name.toUpperCase(),
        role: item.role || 'Promotora',
        category: isMerch ? 'merchandising' : 'fija',
        roleCategory: isMerch ? 'MERCHANDISING' : 'PROMOTORA',
        email: item.email || '',
        phone: String(parsedStatus.phone || ''),
        address: String(parsedStatus.address || ''),
        assignedStore: String(parsedStatus.assignedLocation || ''),
        status: statusFlag,
        password: '',
        shift: 'MAÑANA',
        tastingCompleted: 0,
        salesAssisted: 0,
        activationsCount: 0,
        totalUnits: 0,
      };
    })
    .filter((s) => s.status === 'Activo' && s.roleCategory === 'PROMOTORA');
}

async function main() {
  console.log('==================================================================');
  console.log('🧪 VERIFICACIÓN AUTOMATIZADA FASE 2: LECTOR MULTIFORMATO Y VOLCADO');
  console.log('==================================================================');

  // 1. Validación de metadatos MIME / Extensión / Tamaño
  assert.equal(
    validateUploadFileMetadata({
      name: 'Planificacion_Semana46.xlsx',
      size: 24_500,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }).valid,
    true
  );
  assert.equal(
    validateUploadFileMetadata({
      name: 'ArchivoPeligroso.exe',
      size: 1024,
      type: 'application/x-msdownload',
    }).valid,
    false
  );
  assert.equal(
    validateUploadFileMetadata({
      name: 'DemasiadoGrande.pdf',
      size: MAX_UPLOAD_FILE_BYTES + 1,
      type: 'application/pdf',
    }).valid,
    false
  );
  console.log('✅ [1/5] Validador de extensiones, MIME y límite de 15 MB verificado.');

  // 2. Cargar padrón real de promotoras activas desde Supabase
  const livePromotoras = await fetchLiveActivePromotoras();
  assert.ok(livePromotoras.length > 0, 'Se esperaba al menos 1 promotora activa en public.staff.');
  const sampleRealPromotora = livePromotoras[0]!;
  console.log(
    `✅ [2/5] Padrón real consultado en Supabase: ${livePromotoras.length} promotoras activas (ej. ${sampleRealPromotora.name} -> ${sampleRealPromotora.id}).`
  );

  // 3. Prueba de Parser CSV Determinista (delimitador ';', comillas y fechas DD/MM/YYYY)
  const csvSample = [
    'FECHA PROGRAMADA;HORARIO;PUNTO DE VENTA;ZONA;PRODUCTO;KILOS;FDV;PROMOTORA SUGERIDA;OBSERVACIONES',
    `15/11/2026;9:00 am a 1:00 pm;"FAMILIA CENTER, C.A.";MARACAIBO NORTE;MORTADELA + ESPALDA;3,5;MIKELANGELO DIAZ;${sampleRealPromotora.name};Frente a charcutería`,
    `2026-11-15;09:00 - 13:00;Familia Center CA;MARACAIBO NORTE;ESPALDA + MORTADELA;3.5;MIKELANGELO DIAZ;${sampleRealPromotora.name};Fila duplicada intencional`,
    'FECHA_MALA;TARDE;PDV NUEVO ZULIA;CABIMAS;ARROZ VENCAMPO;2;CARLOS PEREZ;NOMBRE NO REGISTRADO;Para probar semáforo rojo/amarillo',
    'TOTALES;;;;;9;;;',
  ].join('\r\n');

  const csvBytes = new TextEncoder().encode(csvSample);
  const csvExtracted = await extractTabularDegustacionFile(toArrayBuffer(csvBytes), 'csv');
  assert.equal(
    csvExtracted.rows.length,
    3,
    'El parser CSV debe extraer las 3 filas reales e ignorar la fila TOTALES.'
  );
  assert.equal(csvExtracted.rows[0]?.fecha, '2026-11-15');
  assert.equal(csvExtracted.rows[0]?.horaInicio, '09:00');
  assert.equal(csvExtracted.rows[0]?.cantidadKilos, 3.5);
  console.log('✅ [3/5] Motor Tabular CSV (RFC-4180, DD/MM/YYYY, sinónimos y filtro TOTALES) verificado.');

  // 4. Prueba de libros Excel .xlsx y .xls (con banner superior en filas 1-2 y columnas matriciales)
  const sheetMatrix = [
    ['CODIZULCA C.A. - PLANIFICACIÓN COMERCIAL DE DEGUSTACIONES'],
    [],
    ['DIA', 'TURNO', 'CLIENTE', 'RUTA', 'MORTADELA', 'ESPALDA', 'VENDEDOR', 'PROMOTORA'],
    ['16/11/2026', 'TARDE', 'FAMILIA CENTER, C.A.', 'NORTE', 2, 1.5, 'LUIS FDV', sampleRealPromotora.name],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetMatrix);
  XLSX.utils.book_append_sheet(wb, ws, 'Cronograma');

  const xlsxUint8 = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const xlsUint8 = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer;

  const xlsxParsed = await extractTabularDegustacionFile(toArrayBuffer(xlsxUint8), 'xlsx');
  const xlsParsed = await extractTabularDegustacionFile(toArrayBuffer(xlsUint8), 'xls');

  assert.equal(xlsxParsed.rows.length, 1);
  assert.equal(xlsParsed.rows.length, 1);
  assert.equal(xlsxParsed.rows[0]?.fecha, '2026-11-16');
  assert.equal(xlsxParsed.rows[0]?.turno, 'TARDE');
  assert.equal(xlsxParsed.rows[0]?.cantidadKilos, 3.5);
  assert.deepEqual(xlsxParsed.rows[0]?.productos, ['MORTADELA', 'ESPALDA']);
  console.log('✅ [4/5] Motor Tabular Excel (.xlsx y .xls BIFF8 con autodetección de encabezados) verificado.');

  // 5. Prueba de Bandeja de Validación Pre-Volcado (Semáforo Verde / Amarillo / Rojo + Idempotencia + Promotora UUID)
  const pdvCatalog = buildKnownPdvCatalog({
    syncedStoreNames: [{ name: 'FAMILIA CENTER, C.A.', clientCode: 'CLI-001', zone: 'MARACAIBO NORTE' }],
  });
  const promotoraCatalog = buildActivePromotoraCatalog(livePromotoras);

  const enriched = await validateAndEnrichExtractedRows(
    csvExtracted.rows.map((r, i) => ({
      rowIndex: i + 1,
      ...r,
    })),
    {
      pdvCatalog,
      promotoraCatalog,
      existingDbHashes: new Set(),
    }
  );

  // Fila 1: Verde (PDV en catálogo + Promotora activa con UUID real + sin duplicar)
  assert.equal(enriched[0]?.nivelValidacion, 'VALIDO');
  assert.equal(enriched[0]?.promotoraId, sampleRealPromotora.id);
  assert.equal(enriched[0]?.esDuplicadoEnArchivo, false);

  // Fila 2: Amarilla por duplicado idempotente exacto de Fila 1 (misma fecha, mismo PDV canónico, misma hora y mismos productos en distinto orden)
  assert.equal(enriched[1]?.idempotencyHash, enriched[0]?.idempotencyHash);
  assert.equal(enriched[1]?.esDuplicadoEnArchivo, true);
  assert.equal(enriched[1]?.nivelValidacion, 'ADVERTENCIA');

  // Fila 3: Roja por fecha inválida "FECHA_MALA"
  assert.equal(enriched[2]?.nivelValidacion, 'ERROR');

  // 6. Prueba en vivo del endpoint backend POST /api/degustaciones/extract-pdf
  const badPdfRes = await fetch('http://localhost:3000/api/degustaciones/extract-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: Buffer.from('NO_ES_UN_PDF'),
  });
  assert.equal(badPdfRes.status, 415);
  const badPdfBody = (await badPdfRes.json()) as { code?: string };
  assert.equal(badPdfBody.code, 'INVALID_PDF_SIGNATURE');

  const minimalPdfRes = await fetch('http://localhost:3000/api/degustaciones/extract-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: Buffer.from('%PDF-1.4\n%EOF\n'),
  });
  assert.ok(
    minimalPdfRes.status === 200 || minimalPdfRes.status === 503,
    `Se esperaba HTTP 200 (con API key) o 503 AI_KEY_MISSING (sin API key), recibido: ${minimalPdfRes.status}`
  );
  console.log(
    `✅ [5/5] Semáforo (Verde/Amarillo/Rojo), Hash SHA-256 y endpoint PDF (/api/degustaciones/extract-pdf -> HTTP ${minimalPdfRes.status}) verificados.`
  );
  console.log('==================================================================');
  console.log('🎉 TODAS LAS PRUEBAS DE FASE 2 PASARON CON 0 ERRORES.');
}

main().catch((err) => {
  console.error('❌ Falló la verificación de Fase 2:', err);
  process.exit(1);
});
