import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import type { Request, Response } from 'express';
import {
  analyzeMigrations,
  formatIssues,
  type MigrationFile,
} from './support/sqlMigrationAnalyzer';
import { runStaticCertification } from '../scripts/certifySchemaProduction';
import { MOCK_PUBLIC_ANON_KEY } from './antigravity_audit/localMockInfra';
import { isDedicatedTableMissing } from '../src/services/solicitudesContraloriaService';
import {
  buildDeterministicInvoiceStoragePath,
  CONTRALORIA_FACTURAS_BUCKET_ID,
  FiscalDocumentSecurityError,
  verifyFiscalDocumentMagicBytes,
} from '../src/server/fiscalReceiptFileValidator';
import {
  createContraloriaInvoicesHandlers,
  type ContraloriaInvoiceDbRow,
  type ContraloriaInvoicesGateway,
} from '../src/server/contraloriaInvoicesHandler';
import {
  createRequisitionInSupabase,
  fetchContraloriaFinancialBundle,
  issuePazYSalvoInSupabase,
  transitionRequisitionInSupabase,
  upsertCampanaTrade,
  upsertPresupuestoTrade,
  upsertTarifarioCostoTrade,
  verifyPazYSalvoInSupabase,
} from '../src/services/contraloriaFinancialService';
import {
  classifyFeasibilityProductLine,
  evaluateTastingFeasibility,
} from '../src/utils/tastingFeasibility';
import type { TarifarioCostoTrade } from '../src/types/contraloriaFinancial';

const ROOT_DIR = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'supabase', 'migrations');
const HITO4_MIGRATION = '20261118000700_hito4_contraloria_financiera_y_paz_y_salvo.sql';

const UUID_CAMP = '11111111-1111-4111-8111-111111111110';
const UUID_PRES = '22222222-2222-4222-8222-222222222210';
const UUID_TARIFA = '33333333-3333-4333-8333-333333333310';
const UUID_REQ = '44444444-4444-4444-8444-444444444410';
const UUID_CONC = '55555555-5555-4555-8555-555555555510';
const UUID_FACT = '66666666-6666-4666-8666-666666666610';
const UUID_FACT_VAL = '66666666-6666-4666-8666-666666666611';
const UUID_PYS = '77777777-7777-4777-8777-777777777710';
const UUID_USER_ZULIA = '88888888-8888-4888-8888-888888888810';
const UUID_USER_VAL = '88888888-8888-4888-8888-888888888811';

const VALID_PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8');
const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const VALID_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);
const VALID_WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

function loadAllMigrations(): MigrationFile[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

function createMockExpressRes() {
  let statusCode = 200;
  let body: any = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, getStatus: () => statusCode, getBody: () => body };
}

function encodeMetaHeader(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

async function startMockPostgrestServer(
  handler: (req: RecordedRequest, res: http.ServerResponse) => void
): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      const rec: RecordedRequest = {
        method: req.method || 'GET',
        url: req.url || '/',
        body: parsed,
      };
      requests.push(rec);
      handler(rec, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('Hito 4.1 (B-07, S-03, S-04, P-05): Migración SQL 20261118000700 completa, RLS forzoso, secuencia MP-07 y Paz y Salvo pgcrypto inmutable', () => {
  const migrations = loadAllMigrations();
  const hito4 = migrations.find((m) => m.name === HITO4_MIGRATION);
  assert.ok(hito4, `Debe existir la migración ${HITO4_MIGRATION}`);

  const analysis = analyzeMigrations(migrations);
  assert.equal(
    analysis.errors.length,
    0,
    `Analizador estático debe pasar con 0 errores:\n${formatIssues(analysis.errors)}`
  );

  const cert = runStaticCertification(MIGRATIONS_DIR);
  assert.equal(cert.passed, true);
  assert.ok(cert.migrationCount >= 21, 'Debe analizar al menos 21 migraciones');

  const sql = hito4!.sql;

  // 1. Extensión pgcrypto y secuencia atómica MP-07-XXXX
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pgcrypto/i);
  assert.match(sql, /CREATE SEQUENCE IF NOT EXISTS public\.seq_mp07_correlativo/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.fn_generar_correlativo_mp07/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_crear_solicitud_contraloria/i);

  // 2. Las 7 tablas financieras nuevas con RLS forzoso, aislamiento y cero GRANT DELETE
  const financialTables = [
    'campanas_trade',
    'presupuestos_trade',
    'tarifario_costos_trade',
    'contraloria_requisiciones',
    'contraloria_conciliaciones',
    'contraloria_facturas',
    'certificados_paz_y_salvo',
  ];
  for (const tbl of financialTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${tbl}`, 'i'), `Falta tabla ${tbl}`);
    assert.match(
      sql,
      new RegExp(`ALTER TABLE public\\.${tbl} ENABLE ROW LEVEL SECURITY`, 'i'),
      `Falta ENABLE RLS en ${tbl}`
    );
    assert.match(
      sql,
      new RegExp(`ALTER TABLE public\\.${tbl} FORCE ROW LEVEL SECURITY`, 'i'),
      `Falta FORCE RLS en ${tbl}`
    );
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON TABLE public\\.${tbl} FROM PUBLIC, anon`, 'i'),
      `Falta REVOKE anon en ${tbl}`
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`GRANT[^\\n;]*DELETE[^\\n;]*${tbl}`, 'i'),
      `No debe otorgarse GRANT DELETE sobre ${tbl}`
    );
  }

  // 3. Segregación de funciones en BD + SHA-256 pgcrypto + triggers inmutables + bucket privado
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_transicionar_requisicion_contraloria/i);
  assert.match(sql, /SEGREGATION_OF_DUTIES/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_emitir_paz_y_salvo/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_verificar_paz_y_salvo/i);
  assert.match(sql, /encode\(digest\(convert_to\(/i);
  assert.match(sql, /IMMUTABLE_PAZ_Y_SALVO/i);
  assert.match(sql, /IMMUTABLE_CLOSED_RECONCILIATION/i);
  assert.match(sql, /'contraloria-facturas'/i);
  assert.match(sql, /public = false/i);
});

test('Hito 4.2 (P-05): isDedicatedTableMissing rechaza falsos positivos en 409/403/401 y acepta solo tabla inexistente real', () => {
  // Caso crítico que causaba Split-Brain en SYNC-06:
  assert.equal(
    isDedicatedTableMissing(
      409,
      JSON.stringify({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "solicitudes_contraloria_codigo_correlativo_key"',
      })
    ),
    false,
    '409/23505 NUNCA debe interpretarse como tabla inexistente'
  );
  assert.equal(
    isDedicatedTableMissing(403, 'permission denied for table solicitudes_contraloria'),
    false,
    '403 RLS NUNCA debe degradar a public.surveys'
  );
  assert.equal(isDedicatedTableMissing(401, 'JWT expired'), false);
  assert.equal(isDedicatedTableMissing(400, 'invalid input syntax'), false);
  assert.equal(isDedicatedTableMissing(500, 'internal server error'), false);

  // Casos genuinos de tabla inexistente:
  assert.equal(
    isDedicatedTableMissing(
      404,
      JSON.stringify({
        code: 'PGRST205',
        message: "Could not find the table 'public.solicitudes_contraloria' in the schema cache",
      })
    ),
    true
  );
  assert.equal(isDedicatedTableMissing(404, ''), true);
});

test('Hito 4.3 (B-07): Validación por magic bytes de facturas (PDF/JPG/PNG/WebP), Storage privado, aislamiento por sede y rollback', async () => {
  // 1. Magic bytes válidos
  const pdfCheck = verifyFiscalDocumentMagicBytes(VALID_PDF_BYTES);
  assert.equal(pdfCheck.mimeType, 'application/pdf');
  assert.equal(pdfCheck.extension, 'pdf');
  assert.equal(
    pdfCheck.sha256Hex,
    crypto.createHash('sha256').update(VALID_PDF_BYTES).digest('hex')
  );
  assert.equal(verifyFiscalDocumentMagicBytes(VALID_PNG_BYTES).mimeType, 'image/png');
  assert.equal(verifyFiscalDocumentMagicBytes(VALID_JPEG_BYTES).mimeType, 'image/jpeg');
  assert.equal(verifyFiscalDocumentMagicBytes(VALID_WEBP_BYTES).mimeType, 'image/webp');

  // 2. Magic bytes maliciosos o falsificados
  assert.throws(
    () => verifyFiscalDocumentMagicBytes(Buffer.alloc(0)),
    (e: unknown) => e instanceof FiscalDocumentSecurityError && e.statusCode === 400
  );
  assert.throws(
    () => verifyFiscalDocumentMagicBytes(Buffer.from('MZ\x90\x00\x03\x00\x00\x00PE_EXEC_FAKE')),
    (e: unknown) => e instanceof FiscalDocumentSecurityError && e.code === 'DANGEROUS_CONTENT_DETECTED'
  );
  assert.throws(
    () => verifyFiscalDocumentMagicBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
    (e: unknown) => e instanceof FiscalDocumentSecurityError && e.code === 'DANGEROUS_CONTENT_DETECTED'
  );
  assert.throws(
    () => verifyFiscalDocumentMagicBytes(Buffer.from('<!DOCTYPE html><html><script>x</script></html>')),
    (e: unknown) => e instanceof FiscalDocumentSecurityError && e.code === 'DANGEROUS_CONTENT_DETECTED'
  );
  assert.throws(
    () => verifyFiscalDocumentMagicBytes(Buffer.from('PK\x03\x04zip_disguised_as_pdf_file')),
    (e: unknown) => e instanceof FiscalDocumentSecurityError && e.code === 'DANGEROUS_CONTENT_DETECTED'
  );
  assert.throws(
    () => verifyFiscalDocumentMagicBytes(Buffer.from('Plain text pretending to be PDF')),
    (e: unknown) => e instanceof FiscalDocumentSecurityError && e.code === 'UNSUPPORTED_MAGIC_BYTES'
  );
  assert.throws(
    () => verifyFiscalDocumentMagicBytes(VALID_PDF_BYTES, 10),
    (e: unknown) => e instanceof FiscalDocumentSecurityError && e.statusCode === 413
  );

  // 3. Ruta determinística inmune a path traversal
  const safePath = buildDeterministicInvoiceStoragePath({
    sucursal: 'ZULIA',
    requisicionId: UUID_REQ,
    extension: 'pdf',
    fileUuid: UUID_FACT,
  });
  assert.equal(safePath, `facturas/ZULIA/${UUID_REQ}/${UUID_FACT}.pdf`);
  assert.throws(() =>
    buildDeterministicInvoiceStoragePath({
      sucursal: 'ZULIA',
      requisicionId: '../../etc/passwd',
      extension: 'pdf',
    })
  );

  // 4. Handler E2E con gateway desacoplado
  const storageObjects = new Set<string>();
  const storedInvoices = new Map<string, ContraloriaInvoiceDbRow>();
  const seenRifNum = new Set<string>();
  let concClosed = false;

  const gateway: ContraloriaInvoicesGateway = {
    async lookupConciliacion(concId) {
      if (concId !== UUID_CONC) return null;
      return {
        id: UUID_CONC,
        requisicion_id: UUID_REQ,
        cerrada: concClosed,
        sucursal: 'ZULIA',
      };
    },
    async uploadPrivateInvoiceObject({ path: objPath }) {
      storageObjects.add(objPath);
    },
    async deletePrivateInvoiceObjects(_bucket, paths) {
      for (const p of paths) storageObjects.delete(p);
    },
    async insertFiscalReceiptRow(params) {
      const uniqueKey = `${params.rifProveedor}::${params.numeroFactura}`;
      if (seenRifNum.has(uniqueKey)) {
        const err = new Error('duplicate key value violates unique constraint "uq_contraloria_facturas_rif_numero"');
        (err as unknown as { pgCode?: string }).pgCode = '23505';
        throw err;
      }
      seenRifNum.add(uniqueKey);
      const row: ContraloriaInvoiceDbRow = {
        id: UUID_FACT,
        conciliacion_id: params.conciliacionId,
        requisicion_id: params.requisicionId,
        numero_factura: params.numeroFactura,
        rif_proveedor: params.rifProveedor,
        razon_social_proveedor: params.razonSocialProveedor,
        concepto: params.concepto,
        subtotal_usd: params.subtotalUsd,
        impuesto_usd: params.impuestoUsd,
        total_usd: params.totalUsd,
        storage_bucket: params.storageBucket,
        storage_path: params.storagePath,
        mime_type: params.mimeType,
        tamano_bytes: params.tamanoBytes,
        archivo_sha256_hex: params.archivoSha256Hex,
        validada_contraloria: false,
        notas_validacion: null,
        sucursal: params.sucursal,
        created_at: '2026-11-18T12:00:00Z',
      };
      storedInvoices.set(row.id, row);
      return row;
    },
    async findInvoicesByIds(ids) {
      const list: ContraloriaInvoiceDbRow[] = [];
      for (const id of ids) {
        const found = storedInvoices.get(id);
        if (found) list.push(found);
      }
      return list;
    },
    async createSignedUrls(bucket, paths) {
      assert.equal(bucket, CONTRALORIA_FACTURAS_BUCKET_ID);
      const out: Record<string, string> = {};
      for (const p of paths) out[p] = `http://127.0.0.1/signed/${p}`;
      return out;
    },
  };

  const handlers = createContraloriaInvoicesHandlers({ resolveGateway: () => gateway });

  const baseMeta = {
    requisicionId: UUID_REQ,
    conciliacionId: UUID_CONC,
    invoiceNumber: 'FAC-00123',
    supplierRif: 'J-30111222-3',
    supplierName: 'Proveedora Zulia C.A.',
    concept: 'Hielo y vasos degustación',
    subtotalUsd: 86.21,
    taxAmountUsd: 13.79,
    totalUsd: 100.0,
  };

  // A) Carga válida PDF -> 201 + signedUrl + objeto en bucket privado
  const resOk = createMockExpressRes();
  await handlers.handleUploadFiscalReceipt(
    {
      authUser: { id: UUID_USER_ZULIA, email: 'coord@z.com', appRole: 'coordinacion', sucursal: 'ZULIA' },
      headers: { 'x-factura-meta': encodeMetaHeader(baseMeta) },
      body: VALID_PDF_BYTES,
    } as unknown as Request,
    resOk.res
  );
  assert.equal(resOk.getStatus(), 201);
  assert.equal(resOk.getBody().ok, true);
  assert.ok(String(resOk.getBody().signedUrl).startsWith('http://127.0.0.1/signed/facturas/ZULIA/'));
  assert.equal(storageObjects.size, 1);

  // B) Bloqueo de doble rendición (23505) + ROLLBACK automático del blob en Storage (0 huérfanos)
  const resDup = createMockExpressRes();
  await handlers.handleUploadFiscalReceipt(
    {
      authUser: { id: UUID_USER_ZULIA, email: 'coord@z.com', appRole: 'coordinacion', sucursal: 'ZULIA' },
      headers: { 'x-factura-meta': encodeMetaHeader(baseMeta) },
      body: VALID_PDF_BYTES,
    } as unknown as Request,
    resDup.res
  );
  assert.equal(resDup.getStatus(), 409);
  assert.equal(resDup.getBody().code, 'DUPLICATE_INVOICE');
  assert.equal(storageObjects.size, 1, 'El blob subido antes del fallo 23505 debe eliminarse (rollback)');

  // C) Aislamiento entre sedes: usuario de VALENCIA no puede subir a conciliación de ZULIA -> 403
  const resCrossBranch = createMockExpressRes();
  await handlers.handleUploadFiscalReceipt(
    {
      authUser: { id: UUID_USER_VAL, email: 'coord@v.com', appRole: 'coordinacion', sucursal: 'VALENCIA' },
      headers: { 'x-factura-meta': encodeMetaHeader({ ...baseMeta, invoiceNumber: 'FAC-99999' }) },
      body: VALID_PDF_BYTES,
    } as unknown as Request,
    resCrossBranch.res
  );
  assert.equal(resCrossBranch.getStatus(), 403);
  assert.equal(resCrossBranch.getBody().code, 'FORBIDDEN_BRANCH');

  // D) Inmutabilidad post-cierre: conciliación cerrada bloquea nuevas facturas -> 409
  concClosed = true;
  const resClosed = createMockExpressRes();
  await handlers.handleUploadFiscalReceipt(
    {
      authUser: { id: UUID_USER_ZULIA, email: 'coord@z.com', appRole: 'coordinacion', sucursal: 'ZULIA' },
      headers: { 'x-factura-meta': encodeMetaHeader({ ...baseMeta, invoiceNumber: 'FAC-77777' }) },
      body: VALID_PDF_BYTES,
    } as unknown as Request,
    resClosed.res
  );
  assert.equal(resClosed.getStatus(), 409);
  assert.equal(resClosed.getBody().code, 'RECONCILIATION_CLOSED');

  // E) Signed URLs respetan aislamiento por sede
  storedInvoices.set(UUID_FACT_VAL, {
    ...storedInvoices.get(UUID_FACT)!,
    id: UUID_FACT_VAL,
    sucursal: 'VALENCIA',
    storage_path: `facturas/VALENCIA/${UUID_REQ}/${UUID_FACT_VAL}.pdf`,
  });
  const resSignedZulia = createMockExpressRes();
  await handlers.handleBatchFiscalReceiptSignedUrls(
    {
      authUser: { id: UUID_USER_ZULIA, email: 'coord@z.com', appRole: 'coordinacion', sucursal: 'ZULIA' },
      body: { facturaIds: [UUID_FACT, UUID_FACT_VAL] },
    } as unknown as Request,
    resSignedZulia.res
  );
  assert.equal(resSignedZulia.getStatus(), 200);
  assert.ok(resSignedZulia.getBody().urls[UUID_FACT], 'Debe devolver URL firmada de su sede');
  assert.equal(
    resSignedZulia.getBody().urls[UUID_FACT_VAL],
    undefined,
    'No debe devolver URL firmada de factura de otra sede'
  );
});

test('Hito 4.4 (B-07, S-03, S-04): Servicios financieros RPC, SHA-256 real sin fake hash en cliente y tarifario dinámico en tastingFeasibility', async () => {
  // 1. Verificar eliminación del hash aleatorio falso en AppContext.tsx
  const appContextSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/context/AppContext.tsx'), 'utf8');
  assert.doesNotMatch(
    appContextSrc,
    /crypto\.getRandomValues/,
    'AppContext.tsx jamás debe fabricar hashes Paz y Salvo con crypto.getRandomValues en el cliente'
  );

  let actorRole: 'coordinacion' | 'contraloria' = 'coordinacion';
  let currentReqState = 'VALIDACION_COMERCIAL';
  let storedCert: Record<string, unknown> | null = null;
  let storedTarifa: TarifarioCostoTrade | null = null;

  const mock = await startMockPostgrestServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    const body = (req.body || {}) as Record<string, unknown>;

    if (p.endsWith('/rest/v1/campanas_trade')) {
      if (req.method === 'POST') {
        return sendJson(res, 201, {
          id: UUID_CAMP,
          ...body,
          created_at: '2026-11-18T10:00:00Z',
          updated_at: '2026-11-18T10:00:00Z',
        });
      }
      return sendJson(res, 200, []);
    }

    if (p.endsWith('/rest/v1/presupuestos_trade')) {
      if (req.method === 'POST') {
        return sendJson(res, 201, {
          id: UUID_PRES,
          ...body,
          created_at: '2026-11-18T10:00:00Z',
          updated_at: '2026-11-18T10:00:00Z',
        });
      }
      return sendJson(res, 200, []);
    }

    if (p.endsWith('/rest/v1/tarifario_costos_trade')) {
      if (req.method === 'POST') {
        storedTarifa = {
          id: UUID_TARIFA,
          line_id: String(body.line_id),
          etiqueta: String(body.etiqueta),
          marca: body.marca as 'ASTURIAS' | 'VENCAMPO' | 'GENERAL',
          unidad_medida: String(body.unidad_medida || 'Piezas (1kg)'),
          costo_unitario_usd: Number(body.costo_unitario_usd),
          precio_referencia_usd: Number(body.precio_referencia_usd),
          vigente_desde: String(body.vigente_desde),
          vigente_hasta: null,
          activo: true,
          sucursal: 'ZULIA',
          created_at: '2026-11-18T10:00:00Z',
          updated_at: '2026-11-18T10:00:00Z',
        };
        return sendJson(res, 201, storedTarifa);
      }
      return sendJson(res, 200, storedTarifa ? [storedTarifa] : []);
    }

    if (p.endsWith('/rest/v1/rpc/rpc_crear_requisicion_contraloria')) {
      const payload = (body.p_payload || {}) as Record<string, unknown>;
      currentReqState = payload.estado === 'BORRADOR' ? 'BORRADOR' : 'VALIDACION_COMERCIAL';
      return sendJson(res, 200, {
        ok: true,
        requisicion: {
          id: UUID_REQ,
          codigo_correlativo: 'MP-07-0075',
          fecha_solicitud: payload.fecha_solicitud,
          proposito_campana: payload.proposito_campana,
          solicitante_nombre: payload.solicitante_nombre,
          estado: currentReqState,
          items: payload.items,
          total_unidades: payload.total_unidades,
          costo_estimado_usd: payload.costo_estimado_usd,
          tope_presupuesto_usd: payload.tope_presupuesto_usd,
          sucursal: 'ZULIA',
        },
        conciliacion: {
          id: UUID_CONC,
          requisicion_id: UUID_REQ,
          codigo_correlativo: 'MP-07-0075',
          producto_principal: 'MORTADELA ASTURIAS',
          unidades_entregadas: payload.total_unidades,
          unidades_degustadas: 0,
          unidades_devueltas: 0,
          fondo_asignado_usd: 0,
          total_gastos_reportados_usd: 0,
          cerrada: false,
          sucursal: 'ZULIA',
        },
      });
    }

    if (p.endsWith('/rest/v1/rpc/rpc_transicionar_requisicion_contraloria')) {
      const dest = String(body.p_estado_destino || '');
      if (dest === 'APROBADO_CONTRALORIA' && actorRole !== 'contraloria') {
        return sendJson(res, 403, {
          code: '42501',
          message:
            'SEGREGATION_OF_DUTIES: Solo Contraloría Interna o Super Admin puede aprobar o rechazar en Revisión Financiera.',
        });
      }
      currentReqState = dest;
      return sendJson(res, 200, {
        ok: true,
        estado_actual: dest,
        requisicion: {
          id: UUID_REQ,
          codigo_correlativo: 'MP-07-0075',
          fecha_solicitud: '18/11/2026',
          proposito_campana: 'Campaña Q4 Zulia',
          solicitante_nombre: 'Trade',
          estado: dest,
          items: [],
          total_unidades: 10,
          costo_estimado_usd: 185,
          tope_presupuesto_usd: 200,
          sucursal: 'ZULIA',
        },
      });
    }

    if (p.endsWith('/rest/v1/rpc/rpc_emitir_paz_y_salvo')) {
      if (actorRole !== 'contraloria') {
        return sendJson(res, 403, {
          code: '42501',
          message: 'SEGREGATION_OF_DUTIES: Solo Contraloría Interna puede emitir Paz y Salvo.',
        });
      }
      const canonical = {
        schema: 'codizulca.paz_y_salvo.v1',
        codigo_certificado: 'PYS-MP-07-0075',
        requisicion_id: UUID_REQ,
        conciliacion_id: UUID_CONC,
        notas_cierre: body.p_notas_cierre,
      };
      const realSha256 = crypto
        .createHash('sha256')
        .update(JSON.stringify(canonical), 'utf8')
        .digest('hex');

      storedCert = {
        id: UUID_PYS,
        codigo_certificado: 'PYS-MP-07-0075',
        requisicion_id: UUID_REQ,
        conciliacion_id: UUID_CONC,
        codigo_correlativo: 'MP-07-0075',
        payload_canonico: canonical,
        sha256_hash: realSha256,
        emitido_por_uid: UUID_USER_ZULIA,
        emitido_por_nombre: 'Contraloría Codizulca',
        emitido_por_rol: 'contraloria',
        emitido_en: '2026-11-18T18:00:00.000Z',
        notas_cierre: String(body.p_notas_cierre || ''),
        sucursal: 'ZULIA',
      };
      return sendJson(res, 200, {
        ok: true,
        certificado: storedCert,
        conciliacion: {
          id: UUID_CONC,
          requisicion_id: UUID_REQ,
          codigo_correlativo: 'MP-07-0075',
          unidades_entregadas: 10,
          unidades_degustadas: 8,
          unidades_devueltas: 2,
          cerrada: true,
          cerrada_en: '2026-11-18T18:00:00.000Z',
        },
        requisicion: {
          id: UUID_REQ,
          codigo_correlativo: 'MP-07-0075',
          fecha_solicitud: '18/11/2026',
          proposito_campana: 'Campaña Q4 Zulia',
          solicitante_nombre: 'Trade',
          estado: 'CONCILIADO_CERRADO',
          paz_y_salvo_id: UUID_PYS,
          items: [],
          total_unidades: 10,
          costo_estimado_usd: 185,
          tope_presupuesto_usd: 200,
        },
      });
    }

    if (p.endsWith('/rest/v1/rpc/rpc_verificar_paz_y_salvo')) {
      assert.ok(storedCert);
      const recomputed = crypto
        .createHash('sha256')
        .update(JSON.stringify(storedCert.payload_canonico), 'utf8')
        .digest('hex');
      return sendJson(res, 200, {
        found: true,
        valid: recomputed === storedCert.sha256_hash,
        codigo_certificado: storedCert.codigo_certificado,
        stored_sha256: storedCert.sha256_hash,
        recomputed_sha256: recomputed,
      });
    }

    if (
      p.endsWith('/rest/v1/contraloria_requisiciones') ||
      p.endsWith('/rest/v1/contraloria_conciliaciones') ||
      p.endsWith('/rest/v1/contraloria_facturas') ||
      p.endsWith('/rest/v1/certificados_paz_y_salvo')
    ) {
      return sendJson(res, 200, []);
    }

    return sendJson(res, 404, { message: `Unhandled ${req.method} ${p}` });
  });

  try {
    const client = createClient(mock.baseUrl, MOCK_PUBLIC_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Campaña + Presupuesto + Tarifario dinámico en BD
    const camp = await upsertCampanaTrade(
      {
        codigo: 'camp-q4',
        nombre: 'Campaña Navideña Zulia',
        marca: 'ASTURIAS',
        fecha_inicio: '2026-11-01',
        fecha_fin: '2026-12-31',
        sucursal: 'ZULIA',
      },
      client
    );
    assert.equal(camp.codigo, 'CAMP-Q4');

    const pres = await upsertPresupuestoTrade(
      {
        campana_id: UUID_CAMP,
        periodo_ym: '2026-11',
        categoria: 'Degustaciones BTL',
        monto_asignado_usd: 5000,
        sucursal: 'ZULIA',
      },
      client
    );
    assert.equal(pres.monto_asignado_usd, 5000);

    const tarifa = await upsertTarifarioCostoTrade(
      {
        line_id: 'mortadela_asturias',
        etiqueta: 'Mortadela Especial Asturias (Tarifa Q4)',
        marca: 'ASTURIAS',
        costo_unitario_usd: 18.5,
        precio_referencia_usd: 6.2,
        vigente_desde: '2026-11-01',
        sucursal: 'ZULIA',
      },
      client
    );
    assert.equal(tarifa.costo_unitario_usd, 18.5);

    const bundle = await fetchContraloriaFinancialBundle(client);
    assert.equal(bundle.tarifario.length, 1);

    // tastingFeasibility lee costos dinámicos del tarifario de BD (18.50 en vez del 12.00 fijo)
    const reportWithDbTariff = evaluateTastingFeasibility({
      periodLabel: 'Noviembre 2026',
      dateMatcher: () => true,
      tarifarioCostos: bundle.tarifario,
      fallbackVisits: [
        {
          id: 'v1',
          date: '2026-11-18',
          dayLabel: 'Miércoles 18/11',
          shift: 'MAÑANA',
          storeId: 's1',
          storeName: 'Fiorella',
          zone: 'MARACAIBO',
          productFocus: 'MORTADELA ASTURIAS',
          promotoraId: 'p1',
          promotoraName: 'María',
          sellerName: 'Carlos',
          plannedUnits: 2,
          tastedUnits: 2,
          assistedSalesUnits: 10,
          mortadelaQty: 2,
          espaldaQty: 0,
          arrozQty: 0,
          azucarGrams: 0,
          lecheGrams: 0,
          status: 'COMPLETADA',
        },
      ],
    });
    assert.equal(
      reportWithDbTariff.totalTastedProductCostUsd,
      37,
      '2 piezas × $18.50 del tarifario BD = $37.00 (no $24.00 del costo fijo anterior)'
    );
    assert.equal(
      Number(reportWithDbTariff.totalGeneratedRevenueUsd.toFixed(2)),
      62,
      '10 unidades vendidas × $6.20 precio de referencia BD = $62.00'
    );
    assert.equal(classifyFeasibilityProductLine('MORTADELA ASTURIAS').tastingUnitCostUsd, 12);

    // Requisición con correlativo secuencial + Segregación de Funciones en BD (S-03)
    const created = await createRequisitionInSupabase(
      {
        campaignOrPurpose: 'Campaña Q4 Zulia',
        status: 'APROBADO_CONTRALORIA', // intento de auto-aprobación ignorado
        items: [
          {
            id: 'it1',
            itemNumber: 1,
            productName: 'MORTADELA ASTURIAS',
            category: 'PRODUCTO_DEGUSTACION',
            quantityRequested: 10,
            unitOfMeasure: 'Piezas',
            unitCostUsd: 18.5,
            totalCostUsd: 185,
          },
        ],
      },
      client
    );
    assert.equal(created.requisicion.requestCode, 'MP-07-0075');
    assert.equal(
      created.requisicion.status,
      'VALIDACION_COMERCIAL',
      'Nunca debe nacer auto-aprobada en APROBADO_CONTRALORIA'
    );

    // Coordinación intenta auto-aprobar -> bloqueado por RPC (S-03)
    actorRole = 'coordinacion';
    await assert.rejects(
      () =>
        transitionRequisitionInSupabase(
          { requisicionId: UUID_REQ, nextStatus: 'APROBADO_CONTRALORIA' },
          client
        ),
      /SEGREGATION_OF_DUTIES/i
    );

    // Contraloría aprueba -> permitido
    actorRole = 'contraloria';
    const approved = await transitionRequisitionInSupabase(
      { requisicionId: UUID_REQ, nextStatus: 'APROBADO_CONTRALORIA' },
      client
    );
    assert.equal(approved.status, 'APROBADO_CONTRALORIA');

    // Emisión y verificación de Paz y Salvo con SHA-256 real (S-04)
    const pys = await issuePazYSalvoInSupabase(UUID_REQ, 'Auditoría conforme al 100%.', client);
    assert.match(pys.certificado.sha256_hash, /^[0-9a-f]{64}$/);
    assert.equal(pys.requisicion.status, 'CONCILIADO_CERRADO');
    assert.equal(pys.conciliacion.cerrada, true);

    const verified = await verifyPazYSalvoInSupabase('PYS-MP-07-0075', client);
    assert.equal(verified.found, true);
    assert.equal(verified.valid, true);
    assert.equal(verified.recomputed_sha256, pys.certificado.sha256_hash);
  } finally {
    await mock.close();
  }
});
