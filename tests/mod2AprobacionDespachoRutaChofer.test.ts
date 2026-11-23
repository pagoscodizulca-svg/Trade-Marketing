import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MODULE2_PRODUCT_FILTER_OPTIONS,
  buildMatrixUpsertRowFromVisit,
  filterMatrixVisits,
  resolveMatrixRoutingFromRegion,
} from '../src/services/scheduleMatrixService';
import {
  normalizeRutaRole,
  normalizeRutaSucursal,
} from '../ruta-degustacion/src/services/supabaseAuth';
import type { ScheduledVisit } from '../src/types';

test('Cambio 1 · Filtro de productos en Módulo 2 tiene exactamente 5 opciones oficiales y cero SALCHICHAS', () => {
  assert.deepEqual(
    [...MODULE2_PRODUCT_FILTER_OPTIONS],
    ['TODOS', 'MORTADELA', 'VENCAMPO', 'ESPALDA', 'JAMON']
  );

  // Verificar que ScheduleMatrixView.tsx no contenga SALCHICHA / SALCHICHAS en la barra de filtros ni selectores
  const matrixSrc = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'schedule', 'ScheduleMatrixView.tsx'),
    'utf8'
  );
  assert.doesNotMatch(matrixSrc, /SALCHICH/i);
  assert.match(matrixSrc, /MODULE2_PRODUCT_FILTER_OPTIONS\.map/);

  // Verificar coincidencia insensible a mayúsculas, espacios y acentos (JAMON -> JAMÓN, VENCAMPO -> ARROZ)
  const sampleVisits: ScheduledVisit[] = [
    {
      id: 'v1',
      date: '2026-11-23',
      dayLabel: 'LUNES 23/11',
      shift: 'MAÑANA',
      storeId: 's1',
      storeName: 'PDV Uno',
      zone: 'VALENCIA',
      productFocus: 'JAMÓN COCIDO SUPERIOR',
      fillProductSelection: 'JAMÓN',
      promotoraId: '',
      promotoraName: 'Paola Maldonado',
      sellerName: 'Vendedor 1',
      plannedUnits: 2,
      mortadelaQty: 0,
      espaldaQty: 0,
      arrozQty: 0,
      azucarGrams: 0,
      lecheGrams: 0,
      rowHighlight: 'none',
      status: 'PENDIENTE',
    },
    {
      id: 'v2',
      date: '2026-11-23',
      dayLabel: 'LUNES 23/11',
      shift: 'TARDE',
      storeId: 's2',
      storeName: 'PDV Dos',
      zone: 'MARACAIBO',
      productFocus: 'ARROZ PRECOCIDO',
      fillProductSelection: 'ARROZ',
      promotoraId: '',
      promotoraName: 'Anyelit Ruiz',
      sellerName: 'Vendedor 2',
      plannedUnits: 1,
      mortadelaQty: 0,
      espaldaQty: 0,
      arrozQty: 1,
      azucarGrams: 600,
      lecheGrams: 600,
      rowHighlight: 'green',
      status: 'PENDIENTE',
    },
  ];

  const baseCriteria = {
    selectedDay: 'TODOS',
    matrixDateFrom: '',
    matrixDateTo: '',
    selectedShift: 'TODOS',
    searchQuery: '',
    currentWeekBounds: { mondayYmd: '2026-11-23', sundayYmd: '2026-11-29' },
    rollingWeekBounds: { mondayYmd: '2026-11-23', sundayYmd: '2026-11-29' },
    currentYearMonth: '2026-11',
  };

  const onlyJamon = filterMatrixVisits(sampleVisits, {
    ...baseCriteria,
    selectedProduct: 'JAMON',
  });
  assert.equal(onlyJamon.length, 1);
  assert.equal(onlyJamon[0]?.id, 'v1');

  const onlyVencampo = filterMatrixVisits(sampleVisits, {
    ...baseCriteria,
    selectedProduct: 'VENCAMPO',
  });
  assert.equal(onlyVencampo.length, 1);
  assert.equal(onlyVencampo[0]?.id, 'v2');
});

test('Cambios 2 y 3 · Enrutamiento regional determinista (Grecia -> Chofer Occidente; María Centro/Andes -> Chofer Valencia)', () => {
  assert.deepEqual(resolveMatrixRoutingFromRegion('Occidente', 'ZULIA'), {
    region: 'Occidente',
    sucursal: 'ZULIA',
    choferSede: 'OCCIDENTE',
  });

  assert.deepEqual(resolveMatrixRoutingFromRegion('Centro', 'CENTRO'), {
    region: 'Centro',
    sucursal: 'VALENCIA',
    choferSede: 'VALENCIA',
  });

  assert.deepEqual(resolveMatrixRoutingFromRegion('Andes', 'CENTRO'), {
    region: 'Andes',
    sucursal: 'VALENCIA',
    choferSede: 'VALENCIA',
  });

  const mariaVisit: ScheduledVisit = {
    id: 'vis_maria_1',
    date: '2026-11-24',
    dayLabel: 'MARTES 24/11',
    shift: 'MAÑANA',
    storeId: 's-andes',
    storeName: 'ABASTO MERIDA [QA-TEST]',
    zone: 'MÉRIDA',
    productFocus: 'MORTADELA',
    promotoraId: '',
    promotoraName: 'Paola Maldonado',
    sellerName: 'Vendedor Andes',
    plannedUnits: 2,
    mortadelaQty: 2,
    espaldaQty: 0,
    arrozQty: 0,
    azucarGrams: 0,
    lecheGrams: 0,
    rowHighlight: 'none',
    status: 'PENDIENTE',
  };

  const payload = buildMatrixUpsertRowFromVisit(mariaVisit, {
    promotoraEmail: 'paolamaldonado1805@gmail.com',
    region: 'Andes',
    sucursal: 'VALENCIA',
    choferSede: 'VALENCIA',
  });
  assert.equal(payload.region, 'Andes');
  assert.equal(payload.sucursal, 'VALENCIA');
  assert.equal(payload.chofer_sede, 'VALENCIA');

  // App Chofer reconoce rol `coordinador_trade` y territorios Occidente/Andes
  assert.equal(normalizeRutaRole('coordinador_trade'), 'coordinacion');
  assert.equal(normalizeRutaSucursal('Occidente', 'chofer'), 'ZULIA');
  assert.equal(normalizeRutaSucursal('Andes', 'chofer'), 'VALENCIA');
  assert.equal(normalizeRutaSucursal('Valencia', 'chofer'), 'VALENCIA');
});

test('Auditoría de seguridad e idempotencia en migración SQL 20261204000100 (espejo idéntico, cero DDL destructivo)', () => {
  const root = process.cwd();
  const migPath = path.join(
    root,
    'supabase',
    'migrations',
    '20261204000100_mod2_aprobacion_y_despacho_ruta_chofer.sql'
  );
  const sqlMirrorPath = path.join(root, 'sql', 'mod2_aprobacion_y_despacho_ruta_chofer.sql');

  assert.equal(fs.existsSync(migPath), true);
  assert.equal(fs.existsSync(sqlMirrorPath), true);

  const sql = fs.readFileSync(migPath, 'utf8');
  const mirror = fs.readFileSync(sqlMirrorPath, 'utf8');
  assert.equal(sql, mirror, 'La migración y su espejo en sql/ deben ser idénticos');

  const executableSql = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\r\n]*/g, '');

  assert.doesNotMatch(executableSql, /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.doesNotMatch(executableSql, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(executableSql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(executableSql, /\buser_metadata\b/i);
  assert.doesNotMatch(executableSql, /\bTO\s+anon\b/i);

  assert.match(sql, /degustacion_origen_id\s+UUID/i);
  assert.match(sql, /idx_cronograma_degustaciones_degustacion_origen_uniq/i);
  assert.match(sql, /idx_rutas_promotoras_cronograma_id_uniq/i);
  assert.match(sql, /idx_entregas_degustacion_cronograma_id_uniq/i);
  assert.match(sql, /CREATE TRIGGER trg_survey_aprobada_to_cronograma/i);
  assert.match(sql, /CREATE TRIGGER trg_cronograma_dispatch_ruta_y_chofer/i);
  assert.match(sql, /fn_trade_can_deliver_sede/i);
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path = public/i);
  assert.match(sql, /AS RESTRICTIVE/i);
});
