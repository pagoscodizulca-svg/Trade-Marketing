import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

import {
  cambiarEstadoPromotoraMaestra,
  guardarPromotoraMaestra,
} from '../src/services/masterCatalogSyncService';
import {
  buildBatchFillPlan,
  buildMatrixUpsertRowFromVisit,
  persistMatrixUpsertBatch,
} from '../src/services/scheduleMatrixService';
import {
  applyPayload,
  construirCuerpoServidor,
} from '../ruta-degustacion/src/lib/deliveryOps';
import {
  buildSafeEvidenceStoragePath,
  EVIDENCIA_MAX_BYTES,
  isSafeStorageObjectPath,
  validateEvidenceImageFile,
} from '../ruta-degustacion/src/lib/evidenceValidation';
import type { Entrega } from '../ruta-degustacion/src/types';
import type { Store, User } from '../src/types';

const MOCK_PUBLIC_KEY = 'sb_publishable_qa_fase2_mock_only';
const UUID_CRON_TEST = '55555555-5555-4555-8555-555555555551';
const UUID_PROM_TEST = '66666666-6666-4666-8666-666666666661';

interface MockReqRecord {
  method: string;
  url: string;
  body: unknown;
}

async function startMockPostgrest(
  handler: (
    req: MockReqRecord,
    res: http.ServerResponse
  ) => void
): Promise<{
  baseUrl: string;
  requests: MockReqRecord[];
  close: () => Promise<void>;
}> {
  const requests: MockReqRecord[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
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
      const record: MockReqRecord = {
        method: req.method || 'GET',
        url: req.url || '/',
        body: parsed,
      };
      requests.push(record);
      handler(record, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

function jsonRes(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('BLOQUEO 1: guardarPromotoraMaestra actualiza ID numérico con columnas ERP (`correo`) y detecta 0 filas RLS', async () => {
  let mode: 'ok' | 'rls_zero_rows' | 'rls_42501' = 'ok';

  const mock = await startMockPostgrest((req, res) => {
    if (req.url.startsWith('/rest/v1/promotoras') && req.method === 'PATCH') {
      const body = req.body as Record<string, unknown>;
      if (mode === 'rls_42501') {
        return jsonRes(res, 403, {
          code: '42501',
          message: 'permission denied for table promotoras',
        });
      }
      // Para guardarPromotoraMaestra debe enviar columnas reales de producción (`correo`, `direccion`), sin `email`/`ciudad` inexistentes
      assert.ok('correo' in body, 'Debe enviar columna `correo` para ID numérico ERP');
      assert.ok(!('ciudad' in body), 'No debe enviar columna `ciudad` en esquema ERP');
      assert.ok(!('email' in body), 'No debe enviar columna `email` en esquema ERP');

      if (mode === 'rls_zero_rows') {
        return jsonRes(res, 200, []);
      }
      return jsonRes(res, 200, [
        {
          id: 7,
          nombre_completo: body.nombre_completo,
          correo: body.correo,
          telefono: body.telefono,
          direccion: body.direccion,
          activo: body.activo,
          categoria: body.categoria,
        },
      ]);
    }
    return jsonRes(res, 404, { message: `Unhandled ${req.method} ${req.url}` });
  });

  try {
    const client = createClient(mock.baseUrl, MOCK_PUBLIC_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Guardado exitoso con columnas ERP reales
    mode = 'ok';
    const saved = await guardarPromotoraMaestra(
      {
        id: '7',
        nombre_completo: 'Nicole Godoy',
        email: 'nicole@codizulca.com',
        telefono: '0412-1234567',
        direccion: 'Maracaibo Norte [QA]',
        categoria: 'Fijas',
        activo: true,
      },
      client
    );
    assert.equal(saved.id, '7');
    assert.equal(saved.email, 'nicole@codizulca.com');
    assert.equal(saved.direccion, 'Maracaibo Norte [QA]');

    // 2. Silencio 200 [] por RLS -> debe rechazar explícitamente (nunca fingir éxito)
    mode = 'rls_zero_rows';
    await assert.rejects(
      () =>
        guardarPromotoraMaestra(
          {
            id: '7',
            nombre_completo: 'Nicole Godoy',
            categoria: 'Fijas',
          },
          client
        ),
      /0 filas afectadas/i
    );

    // 3. Error 42501 RLS -> mensaje accionable
    mode = 'rls_42501';
    await assert.rejects(
      () => cambiarEstadoPromotoraMaestra('7', false, client),
      /Permiso denegado por RLS/i
    );
  } finally {
    await mock.close();
  }
});

test('BLOQUEO 2: persistMatrixUpsertBatch persiste en cronograma_degustaciones y propaga a App Promotoras y App Chofer', async () => {
  let mode: 'ok' | 'rls_zero' = 'ok';
  const insertedTables: string[] = [];
  const captured: {
    delivery: Record<string, unknown> | null;
    ruta: Record<string, unknown> | null;
  } = { delivery: null, ruta: null };

  const mock = await startMockPostgrest((req, res) => {
    if (req.url.includes('/rest/v1/rpc/rpc_upsert_matriz_cronograma_lote')) {
      return jsonRes(res, 404, {
        code: 'PGRST202',
        message: 'Could not find the function public.rpc_upsert_matriz_cronograma_lote in the schema cache',
      });
    }

    if (req.url.startsWith('/rest/v1/cronograma_degustaciones') && req.method === 'POST') {
      insertedTables.push('cronograma_degustaciones');
      if (mode === 'rls_zero') return jsonRes(res, 200, []);
      const body = req.body as Record<string, unknown>;
      assert.equal(body.estado, 'APROBADA', 'Agendamiento directo desde Módulo 2 debe quedar APROBADA');
      assert.equal(body.observaciones, '[QA-TEST] Verificacion tri-app');
      return jsonRes(res, 201, [
        {
          id: UUID_CRON_TEST,
          cliente_nombre: body.cliente_nombre,
          fecha: body.fecha,
          turno: body.turno,
          estado: body.estado,
          promotora_id: body.promotora_id,
          promotora_nombre: body.promotora_nombre,
        },
      ]);
    }

    if (req.url.startsWith('/rest/v1/rutas_promotoras') && req.method === 'GET') {
      return jsonRes(res, 200, []);
    }
    if (req.url.startsWith('/rest/v1/rutas_promotoras') && req.method === 'POST') {
      insertedTables.push('rutas_promotoras');
      captured.ruta = req.body as Record<string, unknown>;
      return jsonRes(res, 201, [{ id: '77777777-7777-4777-8777-777777777771' }]);
    }

    if (req.url.startsWith('/rest/v1/entregas_degustacion') && req.method === 'GET') {
      return jsonRes(res, 200, []);
    }
    if (req.url.startsWith('/rest/v1/entregas_degustacion') && req.method === 'POST') {
      insertedTables.push('entregas_degustacion');
      captured.delivery = req.body as Record<string, unknown>;
      return jsonRes(res, 201, [{ id: captured.delivery.id }]);
    }

    return jsonRes(res, 404, { message: `Unhandled ${req.method} ${req.url}` });
  });

  try {
    const stores: Store[] = [
      {
        id: 'st_1',
        name: 'SUPERMERCADO DE PRUEBA QA',
        clientCode: 'CLI-QA-01',
        address: 'Av. Bella Vista',
        zone: 'MARACAIBO NORTE',
        city: 'Maracaibo',
        latitude: null,
        longitude: null,
        geofenceRadiusMeters: 150,
        sellerName: 'Vendedor QA',
        channel: 'Supermercado',
      },
    ];
    const users: User[] = [
      {
        id: UUID_PROM_TEST,
        name: 'Nicole Godoy',
        email: 'nicole@codizulca.com',
        role: 'promotora',
      },
    ];

    const plan = buildBatchFillPlan({
      existingVisits: [],
      stores,
      users,
      storeIds: ['st_1'],
      product: 'MORTADELA ASTURIAS 0.900 KG',
      products: ['MORTADELA ASTURIAS 0.900 KG', 'VENCAMPO ARROZ'],
      quantityInput: '2',
      shift: 'MAÑANA',
      dayLabel: 'LUNES 23/11',
      date: '2026-11-23',
      promotoraName: 'Nicole Godoy',
      notes: '[QA-TEST] Verificacion tri-app',
    });

    assert.equal(plan.countCreated, 1);
    assert.equal(plan.affectedVisits[0]!.notes, '[QA-TEST] Verificacion tri-app');
    assert.deepEqual(plan.affectedVisits[0]!.selectedProducts, [
      'MORTADELA ASTURIAS 0.900 KG',
      'VENCAMPO ARROZ',
    ]);

    const row = buildMatrixUpsertRowFromVisit(plan.affectedVisits[0]!, {
      clientCode: 'CLI-QA-01',
      promotoraEmail: 'nicole@codizulca.com',
      sucursal: 'ZULIA',
    });

    const client = createClient(mock.baseUrl, MOCK_PUBLIC_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    mode = 'ok';
    const res = await persistMatrixUpsertBatch([row], client);
    assert.equal(res.ok, true);
    assert.equal(res.insertadas, 1);
    assert.deepEqual(insertedTables, [
      'cronograma_degustaciones',
      'rutas_promotoras',
      'entregas_degustacion',
    ]);
    assert.ok(captured.ruta);
    assert.equal(captured.ruta.cronograma_id, UUID_CRON_TEST);
    assert.equal(captured.ruta.promotora_email, 'nicole@codizulca.com');
    assert.equal(captured.ruta.observaciones, '[QA-TEST] Verificacion tri-app');
    assert.ok(captured.delivery);
    assert.equal(captured.delivery.cronograma_id, UUID_CRON_TEST);
    assert.equal(captured.delivery.estado_logistico, 'PENDIENTE');
    assert.equal(captured.delivery.notas_chofer, '[QA-TEST] Verificacion tri-app');

    // Detección de 0 filas por RLS
    mode = 'rls_zero';
    await assert.rejects(() => persistMatrixUpsertBatch([row], client), /0 filas devueltas/i);
  } finally {
    await mock.close();
  }
});

test('BLOQUEO 3 (App Chofer): transiciones Salida/Llegada y validación segura de evidencia fotográfica', () => {
  const baseEntrega: Entrega = {
    id: 'ent-qa-123',
    fecha: 'LUNES 23',
    turno: 'MAÑANA',
    numero_grupo_turno: 'MAÑANA · 2026-11-23',
    cliente: 'SUPERMERCADO QA',
    producto: 'MORTADELA ASTURIAS',
    vendedor: 'VENDEDOR QA',
    promotora: 'NICOLE GODOY',
    stand_entregado: false,
    producto_entregado: false,
    completado: false,
    estado_logistico: 'PENDIENTE',
    hora_salida: null,
    hora_salida_real: null,
    hora_llegada: null,
    hora_entrega: null,
    evidencia_path: null,
    evidencia_bucket: 'entregas-evidencias',
    evidencia_subida_at: null,
    notas_chofer: '[QA-TEST]',
  };

  // 1. Confirmar Salida
  const salidaIso = '2026-11-23T12:15:00.000Z';
  const enRuta = applyPayload(baseEntrega, {
    estado_logistico: 'EN_RUTA',
    hora_salida_real: salidaIso,
  });
  assert.equal(enRuta.estado_logistico, 'EN_RUTA');
  assert.equal(enRuta.completado, false);
  assert.ok(enRuta.hora_salida && /^\d{2}:\d{2}$/.test(enRuta.hora_salida));
  const cuerpoSalida = construirCuerpoServidor(
    { estado_logistico: 'EN_RUTA', hora_salida_real: salidaIso },
    salidaIso,
    true
  );
  assert.equal(cuerpoSalida.estado_logistico, 'EN_RUTA');
  assert.equal(cuerpoSalida.hora_salida_real, salidaIso);
  assert.ok(typeof cuerpoSalida.hora_salida === 'string');

  // 2. Confirmar Llegada
  const llegadaIso = '2026-11-23T13:05:00.000Z';
  const entregado = applyPayload(enRuta, {
    estado_logistico: 'ENTREGADO',
    completado: true,
    stand_entregado: true,
    producto_entregado: true,
    hora_llegada_real: llegadaIso,
    hora_entrega_real: llegadaIso,
  });
  assert.equal(entregado.estado_logistico, 'ENTREGADO');
  assert.equal(entregado.completado, true);
  assert.ok(entregado.hora_llegada && /^\d{2}:\d{2}$/.test(entregado.hora_llegada));
  assert.equal(entregado.hora_entrega, entregado.hora_llegada);

  // 3. Validación estricta de evidencia fotográfica (MIME + <=5MB + sin path traversal)
  assert.deepEqual(
    validateEvidenceImageFile({ name: 'qa.png', type: 'image/png', size: 1024 }),
    { ok: true, mime: 'image/png', ext: 'png' }
  );
  assert.deepEqual(
    validateEvidenceImageFile({ name: 'foto.jpg', type: 'image/jpeg', size: 2048 }),
    { ok: true, mime: 'image/jpeg', ext: 'jpg' }
  );
  assert.deepEqual(
    validateEvidenceImageFile({ name: 'foto.webp', type: 'image/webp', size: 4096 }),
    { ok: true, mime: 'image/webp', ext: 'webp' }
  );

  // Rechaza tipos inseguros (SVG/HTML/PDF)
  assert.equal(
    validateEvidenceImageFile({ name: 'xss.svg', type: 'image/svg+xml', size: 200 }).ok,
    false
  );
  assert.equal(
    validateEvidenceImageFile({ name: 'doc.pdf', type: 'application/pdf', size: 200 }).ok,
    false
  );
  // Rechaza vacío y > 5MB
  assert.equal(
    validateEvidenceImageFile({ name: 'empty.png', type: 'image/png', size: 0 }).ok,
    false
  );
  assert.equal(
    validateEvidenceImageFile({
      name: 'huge.png',
      type: 'image/png',
      size: EVIDENCIA_MAX_BYTES + 1,
    }).ok,
    false
  );

  // Sanitización de path contra path traversal
  const safePath = buildSafeEvidenceStoragePath('../../etc/passwd/ent-01', 'png', 1700000000000, 'abc-123');
  assert.equal(safePath.startsWith('entregas/'), true);
  assert.equal(safePath.includes('..'), false);
  assert.equal(safePath.includes('\\'), false);
  assert.equal(isSafeStorageObjectPath(safePath), true);
  assert.equal(isSafeStorageObjectPath('entregas/../secret.png'), false);
  assert.equal(isSafeStorageObjectPath('/entregas/a.png'), false);
});

test('SEGURIDAD SQL: migración y script SQL Editor cumplen RLS estricto, cero anon y bucket privado entregas-evidencias', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261130000100_fix_rls_perfiles_degustaciones_chofer_storage.sql'
  );
  const editorSqlPath = path.resolve(
    process.cwd(),
    'sql/fix_rls_perfiles_degustaciones_chofer_storage.sql'
  );

  for (const filePath of [migrationPath, editorSqlPath]) {
    assert.equal(fs.existsSync(filePath), true, `Debe existir ${filePath}`);
    const sql = fs.readFileSync(filePath, 'utf8');

    // Reglas innegociables de seguridad
    assert.equal(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql), false, 'Jamás desactivar RLS');
    assert.equal(/GRANT\s+[^\n;]*\bTO\s+anon\b/i.test(sql), false, 'Jamás abrir permisos a anon');
    assert.equal(/user_metadata/i.test(sql), false, 'Jamás usar user_metadata para autorización');
    assert.equal(/auth\.role\s*\(/i.test(sql), false, 'Jamás usar auth.role() deprecado');
    assert.equal(/\bDROP\s+TABLE\b/i.test(sql), false, 'Jamás DROP TABLE');
    assert.equal(/\bTRUNCATE\b/i.test(sql), false, 'Jamás TRUNCATE');

    // Cobertura obligatoria
    assert.ok(sql.includes('ENABLE ROW LEVEL SECURITY'), 'Debe habilitar RLS');
    assert.ok(sql.includes('TO authenticated'), 'Debe usar TO authenticated');
    assert.ok(sql.includes('REVOKE ALL ON TABLE public.promotoras FROM PUBLIC, anon'));
    assert.ok(sql.includes("'entregas-evidencias'"), 'Debe configurar bucket entregas-evidencias');
    assert.ok(sql.includes('5242880'), 'Debe limitar evidencia a 5 MB');
    assert.ok(sql.includes("ARRAY['image/jpeg', 'image/png', 'image/webp']"));
    assert.ok(sql.includes('trade_storage_insert_entregas_evidencias'));
    assert.ok(sql.includes('trade_storage_select_entregas_evidencias'));
    assert.ok(sql.includes('trade_storage_update_entregas_evidencias'));
  }

  // El script del SQL Editor debe incluir bloque de verificación en 1 clic
  const editorSql = fs.readFileSync(editorSqlPath, 'utf8');
  assert.ok(editorSql.includes('FROM pg_policies'));
  assert.ok(editorSql.includes('FROM storage.buckets'));
  assert.ok(editorSql.includes('FROM information_schema.columns'));
});
