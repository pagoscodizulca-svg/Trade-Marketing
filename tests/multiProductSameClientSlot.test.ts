import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ScheduledVisit, Store, User } from '../src/types';
import {
  buildBatchFillPlan,
  isSameStoreReference,
  normalizeVisitProductSignature,
} from '../src/services/scheduleMatrixService';

const UUID_PROM_1 = '11111111-1111-4111-8111-111111111101';
const UUID_PROM_2 = '11111111-1111-4111-8111-111111111102';
const UUID_COMERCASUR = '33333333-3333-4333-8333-333333333310';
const UUID_OTRA_TIENDA = '33333333-3333-4333-8333-333333333320';

const USERS: User[] = [
  { id: UUID_PROM_1, name: 'María Piña', email: 'maria@codizulca.com', role: 'promotora', assignedZone: 'ZULIA' },
  { id: UUID_PROM_2, name: 'Laura Méndez', email: 'laura@codizulca.com', role: 'promotora', assignedZone: 'ZULIA' },
];

const STORES: Store[] = [
  {
    id: UUID_COMERCASUR,
    name: 'COMERCASUR',
    clientCode: 'CLI-CM-01',
    address: 'Av. Principal Sur',
    zone: 'SAN FRANCISCO',
    city: 'Maracaibo',
    latitude: 10.58,
    longitude: -71.64,
    geofenceRadiusMeters: 200,
    sellerName: 'MARIANA CHACIN',
    channel: 'Supermercado',
  },
  {
    id: UUID_OTRA_TIENDA,
    name: 'FIORELLA AMPARO',
    clientCode: 'CLI-FA-02',
    address: 'Av. Amparo',
    zone: 'MARACAIBO NORTE',
    city: 'Maracaibo',
    latitude: 10.67,
    longitude: -71.63,
    geofenceRadiusMeters: 200,
    sellerName: 'JUAN HERNANDEZ',
    channel: 'Supermercado',
  },
];

test('normalizeVisitProductSignature y isSameStoreReference normalizan acentos y orden', () => {
  assert.equal(
    normalizeVisitProductSignature(['MORTADELA ASTURIAS', 'JAMÓN DE PIERNA']),
    normalizeVisitProductSignature('jamon de pierna + mortadela asturias')
  );
  assert.notEqual(
    normalizeVisitProductSignature('MORTADELA ASTURIAS'),
    normalizeVisitProductSignature('ARROZ VENCAMPO')
  );

  assert.equal(
    isSameStoreReference({ storeId: UUID_COMERCASUR, storeName: 'COMERCASUR' }, { storeId: UUID_COMERCASUR }),
    true
  );
  assert.equal(
    isSameStoreReference({ storeId: 'legacy_1', storeName: 'Comercasur' }, { storeName: 'COMERCASUR' }),
    true
  );
  assert.equal(
    isSameStoreReference({ storeId: UUID_COMERCASUR, storeName: 'COMERCASUR' }, { storeId: UUID_OTRA_TIENDA, storeName: 'FIORELLA AMPARO' }),
    false
  );
});

test('buildBatchFillPlan permite 2 productos diferentes para el MISMO cliente (Comercasur) en la misma fecha y turno sin sobrescribir', () => {
  // 1. Primera degustación en COMERCASUR (MAÑANA, 2026-11-27): MORTADELA ASTURIAS
  const plan1 = buildBatchFillPlan({
    existingVisits: [],
    stores: STORES,
    users: USERS,
    storeIds: [UUID_COMERCASUR],
    product: 'MORTADELA ASTURIAS',
    products: ['MORTADELA ASTURIAS'],
    quantityInput: '2',
    shift: 'MAÑANA',
    dayLabel: 'Viernes 27/11',
    date: '2026-11-27',
  });

  assert.equal(plan1.countCreated, 1);
  assert.equal(plan1.countUpdated, 0);
  assert.equal(plan1.nextVisits.length, 1);
  assert.equal(plan1.nextVisits[0]!.storeName, 'COMERCASUR');
  assert.equal(plan1.nextVisits[0]!.productFocus, 'MORTADELA ASTURIAS');
  assert.equal(plan1.nextVisits[0]!.promotoraId, UUID_PROM_1);

  // 2. Segunda degustación en COMERCASUR a la MISMA hora/turno (MAÑANA, 2026-11-27) con PRODUCTO DIFERENTE: ARROZ VENCAMPO
  const plan2 = buildBatchFillPlan({
    existingVisits: plan1.nextVisits,
    stores: STORES,
    users: USERS,
    storeIds: [UUID_COMERCASUR],
    product: 'ARROZ VENCAMPO',
    products: ['ARROZ VENCAMPO'],
    quantityInput: '1',
    shift: 'MAÑANA',
    dayLabel: 'Viernes 27/11',
    date: '2026-11-27',
  });

  assert.equal(plan2.countCreated, 1, 'Debe crear una segunda fila para el segundo producto');
  assert.equal(plan2.countUpdated, 0, 'NO debe sobrescribir la degustación existente del primer producto');
  assert.equal(plan2.nextVisits.length, 2, 'Deben coexistir ambas degustaciones en COMERCASUR');

  const mortadelaRow = plan2.nextVisits.find((v) => v.productFocus === 'MORTADELA ASTURIAS');
  const arrozRow = plan2.nextVisits.find((v) => v.productFocus === 'ARROZ VENCAMPO');
  assert.ok(mortadelaRow, 'La fila original de MORTADELA ASTURIAS debe permanecer intacta');
  assert.ok(arrozRow, 'La nueva fila de ARROZ VENCAMPO debe haberse creado');
  assert.notEqual(mortadelaRow.id, arrozRow.id, 'Ambas filas deben tener IDs independientes');
  assert.equal(mortadelaRow.promotoraId, UUID_PROM_1);
  assert.equal(arrozRow.promotoraId, UUID_PROM_2, 'En modo AUTO debe asignar la siguiente promotora disponible');

  // 3. Si se vuelve a cargar el MISMO producto (MORTADELA ASTURIAS) para COMERCASUR en el mismo turno, actualiza solo esa fila y respeta la de ARROZ VENCAMPO
  const plan3 = buildBatchFillPlan({
    existingVisits: plan2.nextVisits,
    stores: STORES,
    users: USERS,
    storeIds: [UUID_COMERCASUR],
    product: 'MORTADELA ASTURIAS',
    products: ['MORTADELA ASTURIAS'],
    quantityInput: '4',
    shift: 'MAÑANA',
    dayLabel: 'Viernes 27/11',
    date: '2026-11-27',
  });

  assert.equal(plan3.countUpdated, 1);
  assert.equal(plan3.countCreated, 0);
  assert.equal(plan3.nextVisits.length, 2);
  const mortadelaUpdated = plan3.nextVisits.find((v) => v.productFocus === 'MORTADELA ASTURIAS')!;
  const arrozUntouched = plan3.nextVisits.find((v) => v.productFocus === 'ARROZ VENCAMPO')!;
  assert.equal(mortadelaUpdated.plannedUnits, 4);
  assert.equal(arrozUntouched.id, arrozRow.id);
});

test('buildBatchFillPlan permite asignar explícitamente la MISMA promotora en 2 productos del mismo cliente, pero no en otro cliente', () => {
  const existingAtComercasur: ScheduledVisit[] = [
    {
      id: '44444444-4444-4444-8444-444444444401',
      cronogramaId: '44444444-4444-4444-8444-444444444401',
      date: '2026-11-27',
      dayLabel: 'Viernes 27/11',
      shift: 'MAÑANA',
      storeId: UUID_COMERCASUR,
      storeName: 'COMERCASUR',
      zone: 'SAN FRANCISCO',
      productFocus: 'MORTADELA ASTURIAS',
      selectedProducts: ['MORTADELA ASTURIAS'],
      promotoraId: UUID_PROM_1,
      promotoraName: 'María Piña',
      sellerName: 'MARIANA CHACIN',
      plannedUnits: 2,
      mortadelaQty: 2,
      espaldaQty: 0,
      arrozQty: 0,
      azucarGrams: 0,
      lecheGrams: 0,
      status: 'PENDIENTE',
    },
  ];

  // Misma promotora explícita en el MISMO cliente (COMERCASUR) con otro producto -> conservada
  const sameStorePlan = buildBatchFillPlan({
    existingVisits: existingAtComercasur,
    stores: STORES,
    users: USERS,
    storeIds: [UUID_COMERCASUR],
    product: 'ESPALDA ASTURIAS',
    products: ['ESPALDA ASTURIAS'],
    quantityInput: '2',
    shift: 'MAÑANA',
    dayLabel: 'Viernes 27/11',
    date: '2026-11-27',
    promotoraName: 'María Piña',
  });

  assert.equal(sameStorePlan.countCreated, 1);
  assert.equal(sameStorePlan.affectedVisits[0]!.promotoraId, UUID_PROM_1);
  assert.equal(sameStorePlan.affectedVisits[0]!.promotoraName, 'María Piña');

  // Misma promotora explícita en OTRO cliente (FIORELLA AMPARO) en la misma jornada -> no duplica, reasigna libre
  const otherStorePlan = buildBatchFillPlan({
    existingVisits: existingAtComercasur,
    stores: STORES,
    users: USERS,
    storeIds: [UUID_OTRA_TIENDA],
    product: 'ESPALDA ASTURIAS',
    products: ['ESPALDA ASTURIAS'],
    quantityInput: '2',
    shift: 'MAÑANA',
    dayLabel: 'Viernes 27/11',
    date: '2026-11-27',
    promotoraName: 'María Piña',
  });

  assert.equal(otherStorePlan.countCreated, 1);
  assert.equal(otherStorePlan.affectedVisits[0]!.promotoraId, UUID_PROM_2);
});

test('Migración SQL 20261212000100 permite múltiples productos por cliente/turno preservando RLS y cero DDL destructivo', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261212000100_permitir_multiples_productos_mismo_cliente_turno.sql'
  );
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const mirrorSql = fs.readFileSync(
    path.resolve(process.cwd(), 'sql/permitir_multiples_productos_mismo_cliente_turno.sql'),
    'utf8'
  );
  assert.equal(sql, mirrorSql, 'La copia sql/ debe coincidir byte-a-byte con supabase/migrations/');

  const sqlWithoutComments = sql.replace(/--[^\n]*/g, '');

  assert.match(sqlWithoutComments, /DROP INDEX IF EXISTS public\.idx_cronograma_deg_tienda_fecha_turno_active/i);
  assert.match(sqlWithoutComments, /CREATE UNIQUE INDEX IF NOT EXISTS idx_cronograma_deg_tienda_fecha_turno_producto_active/i);
  assert.match(sqlWithoutComments, /lower\(btrim\(COALESCE\(producto_resumen,\s*''\)\)\)/i);
  assert.match(sqlWithoutComments, /CREATE OR REPLACE FUNCTION public\.rpc_upsert_matriz_cronograma_lote/i);
  assert.match(sqlWithoutComments, /AND lower\(btrim\(COALESCE\(c\.producto_resumen,\s*''\)\)\)\s*=\s*lower\(v_producto_resumen\)/i);
  assert.match(sqlWithoutComments, /CREATE OR REPLACE FUNCTION public\.fn_validate_and_enrich_cronograma_degustacion/i);
  assert.match(sqlWithoutComments, /SET search_path = public/i);
  assert.match(sqlWithoutComments, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sqlWithoutComments, /FORCE ROW LEVEL SECURITY/i);
  assert.match(sqlWithoutComments, /REVOKE ALL ON TABLE public\.cronograma_degustaciones FROM PUBLIC, anon/i);
  assert.match(sqlWithoutComments, /DROP POLICY IF EXISTS rls_multisede_select ON public\.cronograma_degustaciones/i);
  assert.match(sqlWithoutComments, /NOTIFY pgrst,\s*'reload schema'/i);
  assert.doesNotMatch(sqlWithoutComments, /DISABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(sqlWithoutComments, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\bDROP\s+COLUMN\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\bTRUNCATE\b/i);
});
