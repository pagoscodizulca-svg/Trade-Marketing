import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFdvRequestLifecycle } from '../src/services/fdvDegustacionesAdapter';
import {
  MOTIVO_CORTE_INICIAL,
  paginateHistorialItems,
  selectActiveDegustacionesTabItems,
  selectHistorialTabItems,
} from '../src/utils/weeklyTastingCutoffEngine';

function runFase1Verification(): void {
  console.log('======================================================================');
  console.log('VERIFICACIÓN AUTOMATIZADA FASE 1 • HISTORIAL LÓGICO DE DEGUSTACIONES');
  console.log('======================================================================');

  // 1. Separación estricta entre `Degustaciones` (enHistorial = false) e `Historial` (enHistorial = true)
  const sampleItems = [
    {
      id: 'hist-1',
      date: '2026-11-05',
      shift: 'MAÑANA',
      status: 'PENDIENTE',
      enHistorial: true,
      isArchived: true,
      archivadoEn: '2026-11-12T19:00:00.000Z',
      motivoArchivo: MOTIVO_CORTE_INICIAL,
    },
    {
      id: 'hist-2',
      date: '2026-11-10',
      shift: 'TARDE',
      status: 'PROGRAMADO',
      enHistorial: true,
      isArchived: true,
      archivadoEn: '2026-11-12T19:00:00.000Z',
      motivoArchivo: MOTIVO_CORTE_INICIAL,
    },
    {
      id: 'hist-3',
      date: '2026-11-08',
      shift: 'MAÑANA',
      status: 'COMPLETADO',
      enHistorial: true,
      isArchived: true,
      archivadoEn: '2026-11-12T19:00:00.000Z',
      motivoArchivo: MOTIVO_CORTE_INICIAL,
    },
    {
      id: 'act-tarde',
      date: '2026-11-16',
      shift: 'TARDE',
      status: 'PROGRAMADO',
      enHistorial: false,
      isArchived: false,
    },
    {
      id: 'act-manana',
      date: '2026-11-16',
      shift: 'MAÑANA',
      status: 'PENDIENTE',
      enHistorial: false,
      isArchived: false,
    },
    {
      id: 'act-jueves',
      date: '2026-11-19',
      shift: 'MAÑANA',
      status: 'PENDIENTE',
      enHistorial: false,
      isArchived: false,
    },
  ];

  const activeTab = selectActiveDegustacionesTabItems(sampleItems);
  const historialTab = selectHistorialTabItems(sampleItems);

  assert.deepEqual(
    activeTab.map((i) => i.id),
    ['act-manana', 'act-tarde', 'act-jueves'],
    'La pestaña Degustaciones debe contener solo enHistorial=false en orden cronológico ascendente'
  );

  assert.deepEqual(
    historialTab.map((i) => i.id),
    ['hist-2', 'hist-3', 'hist-1'],
    'La pestaña Historial debe contener solo enHistorial=true en orden de fecha descendente'
  );
  console.log('✓ [1/4] Separación estricta de pestañas y ordenamiento cronológico/descendente verificados.');

  // 2. Preservación íntegra de estados operativos originales al pasar a Historial
  const lifecyclePendingArchived = resolveFdvRequestLifecycle({
    rawEstado: 'SOLICITADA',
    isFromSellerApp: true,
    ymd: '2026-11-14',
    todayYmd: '2026-11-12',
    enHistorial: true,
  });
  assert.equal(lifecyclePendingArchived.canonicalEstado, 'SOLICITADA');
  assert.equal(lifecyclePendingArchived.uiStatus, 'PENDIENTE');
  assert.equal(lifecyclePendingArchived.enHistorial, true);
  assert.equal(lifecyclePendingArchived.isArchived, true);
  assert.equal(lifecyclePendingArchived.isEligibleForModule2, false);

  const lifecycleApprovedArchived = resolveFdvRequestLifecycle({
    rawEstado: 'APROBADA',
    isFromSellerApp: true,
    ymd: '2026-11-14',
    todayYmd: '2026-11-12',
    enHistorial: true,
  });
  assert.equal(lifecycleApprovedArchived.canonicalEstado, 'APROBADA');
  assert.equal(lifecycleApprovedArchived.uiStatus, 'PROGRAMADO');
  assert.equal(lifecycleApprovedArchived.enHistorial, true);
  assert.equal(lifecycleApprovedArchived.isArchived, true);

  const lifecycleCompletedArchived = resolveFdvRequestLifecycle({
    rawEstado: 'REALIZADA',
    isFromSellerApp: true,
    ymd: '2026-11-10',
    todayYmd: '2026-11-12',
    enHistorial: true,
  });
  assert.equal(lifecycleCompletedArchived.canonicalEstado, 'COMPLETADA');
  assert.equal(lifecycleCompletedArchived.uiStatus, 'COMPLETADO');
  assert.equal(lifecycleCompletedArchived.enHistorial, true);
  console.log('✓ [2/4] Preservación de estados operativos originales en Historial verificada.');

  // 3. Paginación defensiva en Historial
  const sixtyThreeItems = Array.from({ length: 63 }, (_, idx) => ({ id: `row-${idx + 1}` }));
  const p1 = paginateHistorialItems(sixtyThreeItems, 1, 25);
  assert.equal(p1.items.length, 25);
  assert.equal(p1.startIndex, 1);
  assert.equal(p1.endIndex, 25);
  assert.equal(p1.totalPages, 3);

  const p3 = paginateHistorialItems(sixtyThreeItems, 99, 25);
  assert.equal(p3.page, 3);
  assert.equal(p3.items.length, 13);
  assert.equal(p3.startIndex, 51);
  assert.equal(p3.endIndex, 63);

  const pEmpty = paginateHistorialItems([], 1, 25);
  assert.equal(pEmpty.items.length, 0);
  assert.equal(pEmpty.startIndex, 0);
  assert.equal(pEmpty.endIndex, 0);
  assert.equal(pEmpty.totalPages, 1);
  console.log('✓ [3/4] Paginación defensiva de Historial (25/pág, límites y estado vacío) verificada.');

  // 4. Auditoría estática de seguridad (cero DELETE/TRUNCATE/DROP y cero XSS)
  const rootDir = process.cwd();
  const sqlFase1 = fs.readFileSync(
    path.join(rootDir, 'supabase', 'migrations', '20261112000200_fase1_historial_degustaciones.sql'),
    'utf8'
  );
  assert.equal(
    /\b(?:DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE)\s+(?:public\.)?(?:surveys|cronograma_degustaciones)\b/i.test(
      sqlFase1
    ),
    false,
    'Prohibido DELETE/TRUNCATE/DROP sobre tablas de degustaciones'
  );
  assert.ok(sqlFase1.includes('en_historial'), 'Debe definir columna aditiva en_historial');
  assert.ok(sqlFase1.includes('CORTE_INICIAL'), 'Debe registrar motivo CORTE_INICIAL');

  const viewSource = fs.readFileSync(
    path.join(rootDir, 'src', 'components', 'field', 'FieldPromotoraView.tsx'),
    'utf8'
  );
  assert.equal(
    /dangerouslySetInnerHTML|\.innerHTML\s*=|v-html/.test(viewSource),
    false,
    'Prohibido uso de dangerouslySetInnerHTML / innerHTML / v-html'
  );
  assert.ok(
    viewSource.includes('Sin degustaciones activas para esta semana'),
    'Debe renderizar el estado vacío limpio requerido'
  );
  console.log('✓ [4/4] Auditoría estática de seguridad SQL y prevención XSS verificada.');
  console.log('======================================================================');
  console.log('FASE 1 VERIFICADA CON ÉXITO (100% PASS)');
  console.log('======================================================================');
}

runFase1Verification();
