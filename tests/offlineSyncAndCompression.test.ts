import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearMemoryPortalQueueForTests,
  enqueuePortalAction,
  flushPortalOfflineQueue,
  listPendingPortalActions,
  loadPortalOfflineSnapshot,
  loadPortalShiftSession,
  purgePortalOfflineSensitiveData,
  savePortalOfflineSnapshot,
  savePortalShiftSession,
} from '../src/services/portalOfflineQueueService';
import {
  compressOfflineEvidencePhoto,
  MAX_OFFLINE_COMPRESSED_PHOTO_BYTES,
} from '../src/utils/offlinePhotoCompressor';
import { assertSafeEnvironment, SecurityEnvViolationError } from '../scripts/certifySchemaProduction';
import { redactString } from '../src/server/logger';

const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test('Compresor offline valida magic bytes <= 350 KB y bloquea SVG/HTML/oversize', async () => {
  const pngBlob = new Blob([VALID_PNG_BYTES], { type: 'image/png' });
  const ok = await compressOfflineEvidencePhoto(pngBlob, MAX_OFFLINE_COMPRESSED_PHOTO_BYTES);
  assert.equal(ok.mimeType, 'image/png');
  assert.ok(ok.compressedBytes <= MAX_OFFLINE_COMPRESSED_PHOTO_BYTES);
  assert.ok(ok.base64.length > 0);

  const svgBlob = new Blob(['<svg><script>alert(1)</script></svg>'], { type: 'image/svg+xml' });
  await assert.rejects(
    () => compressOfflineEvidencePhoto(svgBlob, MAX_OFFLINE_COMPRESSED_PHOTO_BYTES),
    /bloqueado por seguridad/i
  );

  const bigBytes = new Uint8Array(400 * 1024);
  bigBytes.set(VALID_PNG_BYTES, 0);
  const bigBlob = new Blob([bigBytes], { type: 'image/png' });
  await assert.rejects(
    () => compressOfflineEvidencePhoto(bigBlob, MAX_OFFLINE_COMPRESSED_PHOTO_BYTES),
    /350 KB/i
  );
});

test('Cola offline precarga snapshot, sincroniza con backoff y purga todos los datos sensibles al expirar', async () => {
  clearMemoryPortalQueueForTests();

  await savePortalShiftSession({
    token: 'opaque.signature',
    session: {
      id: '11111111-1111-4111-8111-111111111111',
      rol: 'promotora',
      personal_id: null,
      personal_nombre: 'Promotora Zulia',
      region_id: '22222222-2222-4222-8222-222222222222',
      region_nombre: 'Zulia',
      sucursal: 'ZULIA',
      ruta_codigo: 'RUTA-NORTE',
      duracion_horas: 12,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      last_used_at: null,
    },
    savedAtIso: new Date().toISOString(),
  });

  await savePortalOfflineSnapshot({
    routes: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        cronograma_id: '55555555-5555-4555-8555-555555555555',
        promotora_id: '44444444-4444-4444-8444-444444444444',
        promotora_nombre: 'Promotora Zulia',
        promotora_email: '',
        cliente_nombre: 'Automercado Zulia',
        cliente_codigo: 'CLI-001',
        zona_direccion: 'RUTA-NORTE',
        fecha: '2026-11-19',
        turno: 'MAÑANA',
        hora_inicio: '09:00',
        hora_fin: '13:00',
        productos: ['Mortadela Asturias'],
        producto_resumen: 'Mortadela Asturias',
        cantidad_kilos: 4,
        personas_estimadas: 80,
        vendedor_fdv: 'Carlos Vendedor',
        observaciones: '',
        estado_ruta: 'ASIGNADA',
        checkin_at: null,
        checkout_at: null,
        aprobado_por: null,
        asignado_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    clients: [{ id: 'cli-1', codigo_cliente: 'CLI-001', nombre_comercial: 'Automercado Zulia' }],
    products: [{ id: 'prod-1', nombre: 'Mortadela Asturias' }],
    syncedAtIso: new Date().toISOString(),
  });

  const queued = await enqueuePortalAction({
    rutaId: '33333333-3333-4333-8333-333333333333',
    accion: 'CHECKIN',
    clienteNombre: 'Automercado Zulia',
    lat: 10.65,
    lng: -71.61,
    accuracyMeters: 12,
    nowMs: 1000,
  });

  // UUID v4 válido para idempotencia
  assert.match(queued.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  // Simular fallo de red -> se conserva en cola con attemptCount = 1 y backoff futuro
  const failRes = await flushPortalOfflineQueue(
    async () => {
      throw new Error('Failed to fetch');
    },
    { nowMs: 1000, randomFn: () => 0 }
  );
  assert.equal(failRes.failed, 1);
  assert.equal(failRes.remaining, 1);
  const [afterFail] = await listPendingPortalActions();
  assert.equal(afterFail?.attemptCount, 1);
  assert.ok((afterFail?.nextRetryAtMs ?? 0) > 1000);

  // Simular purga automática por expiración/revocación -> 0 residuos en snapshot, cola y sesión
  await purgePortalOfflineSensitiveData();
  assert.equal((await listPendingPortalActions()).length, 0);
  const snapAfter = await loadPortalOfflineSnapshot();
  assert.equal(snapAfter.routes.length, 0);
  assert.equal(snapAfter.clients.length, 0);
  assert.equal(snapAfter.products.length, 0);
  assert.equal(await loadPortalShiftSession(), null);
});

test('Certificador bloquea secretos de WhatsApp, VAPID y Shift Link bajo prefijo VITE_* y logger redacta ?t=', () => {
  for (const forbiddenKey of [
    'VITE_SHIFT_LINK_SECRET',
    'VITE_WHATSAPP_ACCESS_TOKEN',
    'VITE_VAPID_PRIVATE_KEY',
    'VITE_WEBHOOK_VERIFY_TOKEN',
  ]) {
    assert.throws(
      () => assertSafeEnvironment({ [forbiddenKey]: 'super-secret-value-1234567890' }),
      SecurityEnvViolationError
    );
  }

  const redacted = redactString(
    'GET https://trade-marketing-qi6j.onrender.com/portal?t=eyJ2IjoxfQ.abcdef1234567890 Shift secretToken1234567890'
  );
  assert.ok(!redacted.includes('eyJ2IjoxfQ'));
  assert.ok(!redacted.includes('secretToken1234567890'));
  assert.ok(redacted.includes('[REDACTED]'));
});
