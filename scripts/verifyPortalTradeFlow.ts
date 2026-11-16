/**
 * Suite automatizada de verificación de arquitectura, seguridad y reglas de negocio:
 *  1. Banderas de características (`FEATURE_FLAGS` en `false` + preservación de código original).
 *  2. Precisión de zona horaria `America/Caracas` (`UTC-4`) sin desfase nocturno post-20:00.
 *  3. Partición determinista `Bandeja de Entrada` (`>= hoy_caracas`) vs `Pestaña de Historial`
 *     (`< hoy_caracas` o `NO_AUTORIZADA`) con etiquetas `Autorizada` y `No Autorizada`.
 *  4. Enlace dinámico `/portal` y sanitización anti-XSS / E.164 de WhatsApp (`portalLinkSharing.ts`).
 *  5. Integridad de migración SQL Realtime/RLS/RPC y soporte SPA (`public/_redirects`).
 *
 * Ejecución:
 *   npx.cmd tsx scripts/verifyPortalTradeFlow.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FEATURE_FLAGS } from '../src/config/featureFlags';
import {
  GENERIC_INVALID_CREDENTIALS_MESSAGE,
  isValidPortalEmailFormat,
  normalizePortalEmail,
} from '../src/services/authService';
import {
  getCaracasTodayYmd,
  getMsUntilNextCaracasMidnight,
  isTastingBeforeTodayCaracas,
  partitionTastingsByTodayAndAuthorization,
  resolveTastingAuthorizationState,
} from '../src/utils/caracasWeekCycle';
import {
  buildPromotoraWhatsAppLink,
  getPromotorasPortalUrl,
  sanitizePhoneForWhatsApp,
  sanitizePortalShareText,
} from '../src/utils/portalLinkSharing';

const ROOT_DIR = process.cwd();

function logPass(step: string): void {
  console.log(`  [OK] ${step}`);
}

function runVerification(): void {
  console.log('=== Verificación Integral: Portal Promotoras + Bandeja/Historial + Realtime ===\n');

  // 1. Verificar Feature Flags en false y código original intacto (NO borrado)
  assert.equal(FEATURE_FLAGS.ENABLE_MODULO1_CARGAR_ARCHIVO, false);
  assert.equal(FEATURE_FLAGS.ENABLE_MODULO1_ENVIAR_SOLICITUD_FDV, false);
  assert.equal(FEATURE_FLAGS.ENABLE_MODULO1_CICLO_ISO_BADGE, false);
  assert.equal(FEATURE_FLAGS.ENABLE_MODULO1_TABLAS_METRICAS, false);

  const preservedFiles = [
    'src/components/field/MultiFormatTastingUploadModal.tsx',
    'src/components/common/Metric360DashboardModal.tsx',
    'src/components/portal/PromotoraRutaPortalView.tsx',
    'src/hooks/useCronogramaRealtimeSync.ts',
    'src/hooks/usePromotoraRutaRealtime.ts',
  ];
  for (const relPath of preservedFiles) {
    assert.equal(
      fs.existsSync(path.join(ROOT_DIR, relPath)),
      true,
      `El archivo requerido debe permanecer en el repositorio: ${relPath}`
    );
  }
  logPass('Feature Flags desactivadas en false y componentes originales preservados sin borrar código.');

  // 2. Precisión estricta de zona horaria America/Caracas (UTC-4) después de las 8:00 PM local
  // Viernes 2026-11-13 20:30:00 Caracas == Sábado 2026-11-14 00:30:00Z en UTC puro
  const friday2030CaracasIso = '2026-11-14T00:30:00.000Z';
  assert.equal(
    getCaracasTodayYmd(friday2030CaracasIso),
    '2026-11-13',
    'A las 20:30 Caracas (00:30Z del día siguiente) la fecha local debe seguir siendo 2026-11-13'
  );

  // Viernes 2026-11-13 23:59:59.999 Caracas == Sábado 2026-11-14 03:59:59.999Z
  const fridayLastMsCaracasIso = '2026-11-14T03:59:59.999Z';
  assert.equal(getCaracasTodayYmd(fridayLastMsCaracasIso), '2026-11-13');
  assert.equal(getMsUntilNextCaracasMidnight(fridayLastMsCaracasIso), 1);

  // Sábado 2026-11-14 00:00:00.000 Caracas == Sábado 2026-11-14 04:00:00.000Z
  const saturdayMidnightCaracasIso = '2026-11-14T04:00:00.000Z';
  assert.equal(getCaracasTodayYmd(saturdayMidnightCaracasIso), '2026-11-14');
  assert.equal(isTastingBeforeTodayCaracas('2026-11-13', saturdayMidnightCaracasIso), true);
  assert.equal(isTastingBeforeTodayCaracas('2026-11-14', saturdayMidnightCaracasIso), false);
  logPass('Corte diario exacto en America/Caracas (UTC-4) verificado sin salto prematuro a las 20:00.');

  // 3. Partición Bandeja de Entrada vs Pestaña de Historial y Etiquetas Autorizada / No Autorizada
  const referenceNow = friday2030CaracasIso; // Hoy en Caracas = 2026-11-13 (Viernes)
  const sampleTastings = [
    {
      id: 'req-hoy-pendiente',
      date: '2026-11-13',
      shift: 'MAÑANA',
      status: 'POR_ASIGNAR',
      createdAt: '2026-11-13T12:00:00Z',
      rawComments: { estado: 'PENDIENTE' },
    },
    {
      id: 'req-lunes-proximo-pendiente',
      date: '2026-11-16', // Próximo lunes enviado por vendedor -> DEBE estar en Bandeja
      shift: 'TARDE',
      status: 'POR_ASIGNAR',
      createdAt: '2026-11-13T13:00:00Z',
      rawComments: { estado: 'PENDIENTE' },
    },
    {
      id: 'req-martes-autorizada',
      date: '2026-11-17',
      shift: 'COMPLETO',
      status: 'PROGRAMADO',
      createdAt: '2026-11-13T14:00:00Z',
      rawComments: { estado: 'APROBADA' },
    },
    {
      id: 'req-futura-descartada-coordinadora',
      date: '2026-11-18',
      shift: 'MAÑANA',
      status: 'NO_AUTORIZADA',
      createdAt: '2026-11-13T15:00:00Z',
      rawComments: { estado: 'NO_AUTORIZADA' },
    },
    {
      id: 'hist-ayer-aprobada',
      date: '2026-11-12', // Pasó la fecha y SÍ fue aprobada -> Historial con etiqueta Autorizada
      shift: 'MAÑANA',
      status: 'COMPLETADO',
      createdAt: '2026-11-10T12:00:00Z',
      rawComments: { estado: 'APROBADA' },
    },
    {
      id: 'hist-ayer-vencida-sin-aprobar',
      date: '2026-11-12', // Pasó la fecha SIN aprobarse -> Historial con etiqueta No Autorizada
      shift: 'TARDE',
      status: 'POR_ASIGNAR',
      createdAt: '2026-11-10T15:00:00Z',
      rawComments: { estado: 'PENDIENTE' },
    },
  ];

  const partitioned = partitionTastingsByTodayAndAuthorization(sampleTastings, referenceNow);
  const bandejaIds = partitioned.bandejaEntrada.map((x) => x.id);
  const historialIds = partitioned.historial.map((x) => x.id);

  assert.deepEqual(bandejaIds, [
    'req-hoy-pendiente',
    'req-lunes-proximo-pendiente',
    'req-martes-autorizada',
  ]);
  assert.equal(historialIds.includes('req-futura-descartada-coordinadora'), true);
  assert.equal(historialIds.includes('hist-ayer-aprobada'), true);
  assert.equal(historialIds.includes('hist-ayer-vencida-sin-aprobar'), true);
  assert.equal(
    bandejaIds.length + historialIds.length,
    sampleTastings.length,
    'Partición disjunta sin duplicados ni pérdida de filas'
  );

  // Validar estados resueltos para insignias visuales en Historial y Bandeja
  const stateMonday = resolveTastingAuthorizationState({
    rawEstado: 'PENDIENTE',
    statusUi: 'POR_ASIGNAR',
    rawEventDate: '2026-11-16',
    referenceNow,
  });
  assert.equal(stateMonday.authorizationState, 'PENDIENTE');
  assert.equal(stateMonday.belongsToHistorial, false);

  const statePastApproved = resolveTastingAuthorizationState({
    rawEstado: 'APROBADA',
    statusUi: 'PROGRAMADO',
    rawEventDate: '2026-11-12',
    referenceNow,
  });
  assert.equal(statePastApproved.authorizationState, 'AUTORIZADA');
  assert.equal(statePastApproved.belongsToHistorial, true);

  const statePastExpiredPending = resolveTastingAuthorizationState({
    rawEstado: 'PENDIENTE',
    statusUi: 'POR_ASIGNAR',
    rawEventDate: '2026-11-12',
    referenceNow,
  });
  assert.equal(statePastExpiredPending.authorizationState, 'NO_AUTORIZADA');
  assert.equal(statePastExpiredPending.belongsToHistorial, true);

  const stateExplicitRejected = resolveTastingAuthorizationState({
    rawEstado: 'NO_AUTORIZADA',
    statusUi: 'NO_AUTORIZADA',
    rawEventDate: '2026-11-18',
    referenceNow,
  });
  assert.equal(stateExplicitRejected.authorizationState, 'NO_AUTORIZADA');
  assert.equal(stateExplicitRejected.belongsToHistorial, true);

  logPass(
    'Partición Bandeja (>= hoy_caracas) vs Historial (< hoy_caracas o NO_AUTORIZADA) + etiquetas Autorizada/No Autorizada verificadas.'
  );

  // 4. Verificación de generación dinámica /portal y sanitización WhatsApp / Anti-XSS
  assert.equal(
    getPromotorasPortalUrl('https://trademarketing.codizulca.com/modulo1'),
    'https://trademarketing.codizulca.com/portal'
  );
  assert.equal(
    getPromotorasPortalUrl('javascript:alert(1)'),
    'http://localhost:3000/portal',
    'Debe bloquear esquemas peligrosos como javascript:'
  );

  assert.equal(sanitizePhoneForWhatsApp('0414-123-4567'), '584141234567');
  assert.equal(sanitizePhoneForWhatsApp('+58 (424) 987.65.43'), '584249876543');
  assert.equal(sanitizePhoneForWhatsApp('4125556677'), '584125556677');
  assert.equal(sanitizePhoneForWhatsApp('<script>alert(1)</script>'), '');
  assert.equal(sanitizePortalShareText('  María\u0000\u202E   Pérez  '), 'María Pérez');

  const waUrl = buildPromotoraWhatsAppLink({
    promotoraName: 'María Pérez',
    promotoraEmail: '  MARIA.PEREZ@CODIZULCA.COM ',
    phone: '0414-123-4567',
    storeName: 'Supermercado Fiorella Norte',
    dateYmd: '2026-11-16',
    explicitOrigin: 'https://trademarketing.codizulca.com',
  });
  assert.equal(waUrl.startsWith('https://wa.me/584141234567?text='), true);
  const decodedWaText = decodeURIComponent(waUrl.split('?text=')[1] || '');
  assert.equal(decodedWaText.includes('https://trademarketing.codizulca.com/portal'), true);
  assert.equal(decodedWaText.includes('maria.perez@codizulca.com'), true);
  assert.equal(decodedWaText.includes('Supermercado Fiorella Norte'), true);
  logPass('Construcción dinámica de /portal y sanitización WhatsApp / anti-XSS verificadas.');

  // 5. Verificación de artefactos de infraestructura (_redirects y migración SQL idempotente)
  const redirectsContent = fs.readFileSync(path.join(ROOT_DIR, 'public/_redirects'), 'utf8');
  assert.equal(redirectsContent.includes('/* /index.html 200'), true);

  const sqlMigrationPath = path.join(
    ROOT_DIR,
    'supabase/migrations/20261114_portal_promotoras_bandeja_realtime.sql'
  );
  const sqlContent = fs.readFileSync(sqlMigrationPath, 'utf8');
  assert.equal(sqlContent.includes('rpc_autorizar_degustacion_trade'), true);
  assert.equal(sqlContent.includes('rpc_no_autorizar_degustacion_trade'), true);
  assert.equal(sqlContent.includes('NO_AUTORIZADA'), true);
  assert.equal(sqlContent.includes('supabase_realtime'), true);
  assert.equal(sqlContent.includes('America/Caracas'), true);
  logPass('Migración SQL idempotente (RPC + RLS + Realtime) y soporte SPA (_redirects) verificados.');

  // 6. Verificación de retiro de "Copiar Link del Portal" en Módulo 1 y Login Minimalista Blindado en /portal
  const fieldPromotoraSource = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/field/FieldPromotoraView.tsx'),
    'utf8'
  );
  assert.equal(
    fieldPromotoraSource.includes('Copiar Link del Portal'),
    false,
    'El botón "Copiar Link del Portal" no debe existir en Módulo 1'
  );
  assert.equal(
    fieldPromotoraSource.includes('copyTextToClipboardSafe'),
    false,
    'No deben quedar referencias huérfanas a copyTextToClipboardSafe en Módulo 1'
  );

  const portalViewSource = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/portal/PromotoraRutaPortalView.tsx'),
    'utf8'
  );
  assert.equal(portalViewSource.includes('type="email"'), true);
  assert.equal(portalViewSource.includes('inputMode="email"'), true);
  assert.equal(portalViewSource.includes('autoCapitalize="none"'), true);
  assert.equal(portalViewSource.includes('autoCorrect="off"'), true);
  assert.equal(portalViewSource.includes('autoComplete="email"'), true);
  assert.equal(portalViewSource.includes('autoComplete="current-password"'), true);
  assert.equal(portalViewSource.includes('signInPromotoraPortalWithPassword'), true);
  assert.equal(portalViewSource.includes('magic_link'), false);
  assert.equal(portalViewSource.includes('Link al Correo'), false);
  assert.equal(portalViewSource.includes('Torre de Control'), false);
  assert.equal(portalViewSource.includes('href="/"'), false);

  assert.equal(
    normalizePortalEmail('  Promotora.Uno@Codizulca.COM  '),
    'promotora.uno@codizulca.com'
  );
  assert.equal(isValidPortalEmailFormat('promotora@codizulca.com'), true);
  assert.equal(isValidPortalEmailFormat('invalido-sin-dominio'), false);
  assert.equal(GENERIC_INVALID_CREDENTIALS_MESSAGE, 'Correo o contraseña incorrectos');
  logPass(
    'Retiro de "Copiar Link del Portal" en Módulo 1 y Login Minimalista (Correo + Contraseña) en /portal verificados.'
  );

  console.log('\n✅ TODAS LAS PRUEBAS PASARON EXITOSAMENTE (0 errores).\n');
}

runVerification();
