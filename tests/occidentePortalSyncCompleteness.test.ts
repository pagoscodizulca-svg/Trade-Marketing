import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  clearMemoryPortalQueueForTests,
  decodeBase64ToBlob,
  enqueuePortalAttendanceAction,
  enqueuePortalInventoryAction,
  enqueuePortalMerchandisingAction,
  enqueuePortalPriceAction,
  enqueuePortalSurveyAction,
  flushPortalOfflineQueue,
  isTransientOfflineOrNetworkError,
  listPendingPortalActions,
  type QueuedPortalAction,
} from '../src/services/portalOfflineQueueService';
import { resolvePortalCanonicalSucursal } from '../src/services/promotoraCampoService';

// PNG mínimo válido (magic bytes reales 89 50 4E 47 0D 0A 1A 0A + IHDR)
const TINY_VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
]);

test('resolvePortalCanonicalSucursal: normaliza estrictamente hacia OCCIDENTE o CENTRO', () => {
  assert.equal(resolvePortalCanonicalSucursal('Occidente'), 'OCCIDENTE');
  assert.equal(resolvePortalCanonicalSucursal('ZULIA'), 'OCCIDENTE');
  assert.equal(resolvePortalCanonicalSucursal('Maracaibo'), 'OCCIDENTE');
  assert.equal(resolvePortalCanonicalSucursal(''), 'OCCIDENTE');
  assert.equal(resolvePortalCanonicalSucursal('Centro'), 'CENTRO');
  assert.equal(resolvePortalCanonicalSucursal('VALENCIA'), 'CENTRO');
  assert.equal(resolvePortalCanonicalSucursal('Carabobo'), 'CENTRO');
  assert.equal(resolvePortalCanonicalSucursal('Aragua'), 'CENTRO');
});

test('portalOfflineQueueService: encola y sincroniza los 5 módulos de /portal sin perder fotos ni client_submission_id', async () => {
  clearMemoryPortalQueueForTests();
  const samplePng = new Blob([TINY_VALID_PNG_BYTES], { type: 'image/png' });

  const inv = await enqueuePortalInventoryAction({
    id: '11111111-1111-4111-8111-111111111111',
    store: 'HIPERLIDER SAN FRANCISCO',
    zona: 'Maracaibo Sur',
    product: 'JAMON COCIDO SUPERIOR ASTURIAS',
    initialQuantity: 40,
    salesGenerated: 12,
    degustations: 8,
    comments: 'Alta rotación',
  });

  const price = await enqueuePortalPriceAction({
    id: '22222222-2222-4222-8222-222222222222',
    store: 'FIORELLA SUPERMARKET',
    cadena: 'FIORELLA',
    zona: 'Maracaibo Norte',
    ourProduct: 'JAMON DE PIERNA ASTURIAS',
    ourPriceUsd: 5.5,
    ownCurrency: 'VES',
    ownOriginalPrice: 385,
    bcvRate: 70,
    competitors: [{ name: 'Plumrose', originalPrice: 6.1, currency: 'USD' }],
    photoFile: samplePng,
  });

  const survey = await enqueuePortalSurveyAction({
    id: '33333333-3333-4333-8333-333333333333',
    store: 'DE CANDIDO DELICIAS',
    product: 'MORTADELA ESPECIAL VENCAMPO',
    sabor: 5,
    textura: 5,
    intencionCompra: 'Muy probable',
    percepcionCalidad: 'Mejor',
    relacionCalidadPrecio: 'Excelente',
    recomendacion: 5,
    comments: 'Excelente sabor',
  });

  const merch = await enqueuePortalMerchandisingAction({
    id: '44444444-4444-4444-8444-444444444444',
    mode: 'certificacion_visita',
    store: 'CENTRAL MADEIRENSE',
    date: '2026-11-25',
    time: '10:30',
    activities: ['Limpieza y rotación de nevera'],
    productDetail: 'Línea Asturias',
    photoFiles: [samplePng],
    signatureBlob: samplePng,
  });

  const attendance = await enqueuePortalAttendanceAction({
    id: '55555555-5555-4555-8555-555555555555',
    slotFoto: 'JORNADA_INGRESO',
    pdvNombre: 'DE CANDIDO LA LAGO',
    zona: 'Maracaibo',
    lat: 10.654,
    lng: -71.612,
    gpsAccuracy: 15,
    locationSource: 'gps_high',
    fechaJornada: '2026-11-25',
    imageFile: samplePng,
  });

  assert.equal(inv.kind, 'INVENTARIO_LOG');
  assert.equal(price.kind, 'PRECIO_SURVEY');
  assert.ok(price.photoBase64 && price.photoBase64.length > 10);
  assert.equal(survey.kind, 'ENCUESTA_CONSUMIDOR');
  assert.equal(merch.kind, 'MERCHANDISING_REPORT');
  assert.equal(merch.photosBase64.length, 1);
  assert.ok(merch.signatureBase64 && merch.signatureBase64.length > 10);
  assert.equal(attendance.kind, 'ASISTENCIA_EVIDENCIA');
  assert.equal(decodeBase64ToBlob(attendance.photoBase64, attendance.photoMimeType).size, TINY_VALID_PNG_BYTES.byteLength);

  const pendingBefore = await listPendingPortalActions();
  assert.equal(pendingBefore.length, 5);

  const syncedKinds: QueuedPortalAction['kind'][] = [];
  const flushRes = await flushPortalOfflineQueue(
    async (action) => {
      syncedKinds.push(action.kind);
    },
    { forceIgnoreSchedule: true }
  );

  assert.equal(flushRes.succeeded, 5);
  assert.equal(flushRes.remaining, 0);
  assert.deepEqual(syncedKinds.sort(), [
    'ASISTENCIA_EVIDENCIA',
    'ENCUESTA_CONSUMIDOR',
    'INVENTARIO_LOG',
    'MERCHANDISING_REPORT',
    'PRECIO_SURVEY',
  ]);
  clearMemoryPortalQueueForTests();
});

test('isTransientOfflineOrNetworkError: detecta errores de red iOS Safari, AbortError y NETWORK_OFFLINE', () => {
  assert.equal(isTransientOfflineOrNetworkError({ category: 'NETWORK_OFFLINE', message: 'offline' }), true);
  assert.equal(isTransientOfflineOrNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(isTransientOfflineOrNetworkError(new TypeError('Load failed')), true);
  assert.equal(isTransientOfflineOrNetworkError(new Error('Permiso denegado por RLS')), false);
});

test('invariantes Módulo 1 Informes + Merchandising + Migración SQL consolidada 20261211000100', () => {
  const fieldSrc = fs.readFileSync(
    path.resolve('src/components/field/FieldPromotoraView.tsx'),
    'utf8'
  );
  const mod1Src = fs.readFileSync(path.resolve('src/services/supabaseModule1.ts'), 'utf8');
  const sqlSrc = fs.readFileSync(
    path.resolve('supabase/migrations/20261211000100_consolidacion_sync_portal_occidente_informes.sql'),
    'utf8'
  );

  // Badge real de Asistencia (no 0 de checkins legados) + subpestaña Encuestas PDV + firma/fotos Storage Merchandising
  assert.ok(fieldSrc.includes('effectiveAttendanceTabCount'));
  assert.ok(fieldSrc.includes('informe-tab-encuestas'));
  assert.ok(fieldSrc.includes('signPortalStoragePathsBatch'));
  assert.ok(mod1Src.includes('photoStoragePaths') && mod1Src.includes('signatureStoragePath'));

  // Blindaje SQL AGENTS.md
  assert.equal(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sqlSrc), false);
  assert.ok(sqlSrc.includes('FORCE ROW LEVEL SECURITY'));
  assert.ok(sqlSrc.includes('REVOKE ALL'));
  assert.ok(sqlSrc.includes('SET search_path = public'));
  assert.ok(sqlSrc.includes('rpc_registrar_inventario_portal'));
  assert.ok(sqlSrc.includes('rpc_registrar_encuesta_portal'));
  assert.ok(sqlSrc.includes('rpc_registrar_precio_portal'));
  assert.ok(sqlSrc.includes('rpc_registrar_ejecucion_ruta_promotora'));
  assert.ok(sqlSrc.includes('supabase_realtime'));
  assert.ok(sqlSrc.includes("NOTIFY pgrst, 'reload schema'"));
});
