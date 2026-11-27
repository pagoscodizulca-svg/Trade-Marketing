import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  appendUnitTagToObservations,
  extractUnitFromObservations,
  formatQuantityUnitLabel,
  formatQuantityWithUnit,
  getNextScheduleQuantityUnit,
  inferDefaultScheduleQuantityUnit,
  normalizePortalExecutionUnit,
  normalizeProductQuantityUnit,
  resolveQuantityUnitFromInsumos,
} from '../src/utils/productQuantityUnit';
import {
  buildBatchFillPlan,
  buildMatrixUpsertRowFromVisit,
} from '../src/services/scheduleMatrixService';
import { PublicTokenPdvView } from '../src/components/portal/PublicTokenPdvView';
import { PortalInventarioTab } from '../src/components/portal/PortalInventarioTab';
import type { Store, User } from '../src/types';

test('productQuantityUnit normaliza, sugiere y etiqueta correctamente Unidad, Bulto, Kg y Caja', () => {
  assert.equal(normalizeProductQuantityUnit('BULTO'), 'BULTO');
  assert.equal(normalizeProductQuantityUnit('bultos'), 'BULTO');
  assert.equal(normalizeProductQuantityUnit('UND'), 'UNIDAD');
  assert.equal(normalizeProductQuantityUnit('Unidades'), 'UNIDAD');
  assert.equal(normalizeProductQuantityUnit('kg'), 'KG');
  assert.equal(normalizeProductQuantityUnit('CAJAS'), 'CAJA');
  assert.equal(normalizePortalExecutionUnit('BULTO'), 'BULTO');
  assert.equal(normalizePortalExecutionUnit('KG', 'UNIDAD'), 'UNIDAD');

  // Productos marcados como BULTO en el catálogo ERP no deben forzar BULTO por defecto en Módulo 2
  assert.equal(inferDefaultScheduleQuantityUnit(['BULTO']), 'UNIDAD');
  assert.equal(inferDefaultScheduleQuantityUnit(['BULTO', 'UND']), 'UNIDAD');
  assert.equal(inferDefaultScheduleQuantityUnit(['KG']), 'KG');

  assert.equal(formatQuantityUnitLabel('UNIDAD', 1), 'Unidad');
  assert.equal(formatQuantityUnitLabel('UNIDAD', 3), 'Unidades');
  assert.equal(formatQuantityUnitLabel('BULTO', 1), 'Bulto');
  assert.equal(formatQuantityUnitLabel('BULTO', 2), 'Bultos');
  assert.equal(formatQuantityWithUnit(2, 'BULTO'), '2 Bultos');
  assert.equal(formatQuantityWithUnit(1, 'UNIDAD'), '1 Unidad');

  assert.equal(getNextScheduleQuantityUnit('UNIDAD'), 'BULTO');
  assert.equal(getNextScheduleQuantityUnit('BULTO'), 'KG');
  assert.equal(getNextScheduleQuantityUnit('KG'), 'UNIDAD');

  // Etiquetado idempotente en observaciones (sin duplicar [Medida: ...])
  const taggedBulto = appendUnitTagToObservations('Cliente pidió exhibición extra', 'BULTO');
  assert.equal(taggedBulto, '[Medida: Bulto] Cliente pidió exhibición extra');

  const retouchedUnidad = appendUnitTagToObservations(taggedBulto, 'UNIDAD');
  assert.equal(retouchedUnidad, '[Medida: Unidad] Cliente pidió exhibición extra');

  const extracted = extractUnitFromObservations(retouchedUnidad);
  assert.equal(extracted.unit, 'UNIDAD');
  assert.equal(extracted.cleanText, 'Cliente pidió exhibición extra');

  assert.equal(resolveQuantityUnitFromInsumos({ unidad_cantidad: 'BULTO' }, null), 'BULTO');
  assert.equal(resolveQuantityUnitFromInsumos({}, '[Medida: Bulto] Nota'), 'BULTO');
});

test('buildBatchFillPlan y buildMatrixUpsertRowFromVisit persisten unidad_cantidad tanto en UNIDAD como en BULTO', () => {
  const stores: Store[] = [
    {
      id: 'st-comercasur',
      name: 'COMERCASUR',
      zone: 'MARACAIBO SUR',
      sellerName: 'VENDEDOR 1',
      clientCode: 'CLI-001',
    } as Store,
  ];
  const users: User[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'MARIA PROMOTORA',
      email: 'maria@codizulca.com',
      role: 'promotora',
    } as User,
  ];

  // 1) Producto cuyo catálogo ERP es BULTO, pero cargado por UNIDAD
  const planUnidad = buildBatchFillPlan({
    existingVisits: [],
    stores,
    users,
    storeIds: ['st-comercasur'],
    product: 'ARROZ BLANCO VENCAMPO 24X1KG',
    products: ['ARROZ BLANCO VENCAMPO 24X1KG'],
    quantityInput: '3',
    quantityUnit: 'UNIDAD',
    shift: 'MAÑANA',
    dayLabel: 'Viernes 27/11',
    date: '2026-11-27',
    promotoraName: 'MARIA PROMOTORA',
  });

  assert.equal(planUnidad.affectedVisits.length, 1);
  assert.equal(planUnidad.affectedVisits[0]?.quantityUnit, 'UNIDAD');
  const rowUnidad = buildMatrixUpsertRowFromVisit(planUnidad.affectedVisits[0]!, {
    region: 'Occidente',
    sucursal: 'ZULIA',
  });
  assert.equal(rowUnidad.cantidad_kilos, 3);
  assert.equal(rowUnidad.insumos_calculados.unidad_cantidad, 'UNIDAD');

  // 2) Segundo producto en el mismo cliente cargado por BULTO
  const planBulto = buildBatchFillPlan({
    existingVisits: planUnidad.nextVisits,
    stores,
    users,
    storeIds: ['st-comercasur'],
    product: 'LECHE EN POLVO VENCAMPO 10X1KG',
    products: ['LECHE EN POLVO VENCAMPO 10X1KG'],
    quantityInput: '1',
    quantityUnit: 'BULTO',
    shift: 'MAÑANA',
    dayLabel: 'Viernes 27/11',
    date: '2026-11-27',
    promotoraName: 'MARIA PROMOTORA',
  });

  assert.equal(planBulto.countCreated, 1);
  assert.equal(planBulto.affectedVisits[0]?.quantityUnit, 'BULTO');
  const rowBulto = buildMatrixUpsertRowFromVisit(planBulto.affectedVisits[0]!, {
    region: 'Occidente',
    sucursal: 'ZULIA',
  });
  assert.equal(rowBulto.cantidad_kilos, 1);
  assert.equal(rowBulto.insumos_calculados.unidad_cantidad, 'BULTO');
});

test('PromotoraRutaPortalView retira Lote del producto y Fecha de vencimiento, y ofrece control Por Unidad / Por Bulto', () => {
  const source = fs.readFileSync(
    path.resolve('src/components/portal/PromotoraRutaPortalView.tsx'),
    'utf8'
  );

  // No debe pedir ni validar lote ni fecha de vencimiento en el formulario de cierre PDV
  assert.doesNotMatch(source, /Lote del producto/i);
  assert.doesNotMatch(source, /Fecha de vencimiento/i);
  assert.doesNotMatch(source, /Indica el lote del producto degustado/i);

  // Debe exponer selector de unidad/bulto y conservar solo unidad abierta, muestras y ventas
  assert.match(source, /exec-unit-\$\{opt\.value\}/);
  assert.match(source, /PORTAL_EXECUTION_UNIT_OPTIONS/);
  assert.match(source, /Unidad abierta/);
  assert.match(source, /Bultos abiertos/);
  assert.match(source, /Muestras/);
  assert.match(source, /Ventas \(Unid\.\)/);
  assert.match(source, /Ventas \(Bultos\)/);
});

test('PublicTokenPdvView SSR omite Lote de Producto y renderiza selector Por Unidad / Por Bulto con Unidad Abierta, Muestras y Ventas', () => {
  const html = renderToStaticMarkup(
    React.createElement(PublicTokenPdvView, {
      token: 'tok_qa_public_pdv_1234567890abcdef',
      initialBootstrapForQa: {
        sucursal: 'OCCIDENTE',
        tiendas: [
          {
            id: 't-1',
            codigo_cliente: '001',
            nombre_comercial: 'SUPERMERCADO QA',
            ciudad: 'Maracaibo',
            estado: 'Zulia',
            zona: 'Norte',
            ruta: 'R-01',
            latitud: null,
            longitud: null,
            radio_geocerca_m: 250,
          },
        ],
        promotoras: [
          {
            id: 'p-1',
            nombre_completo: 'Promotora QA',
            categoria: 'Fijas',
          },
        ],
        productos: [
          {
            id: 'prod-1',
            codigo: '001578',
            nombre: 'ARROZ BLANCO VENCAMPO 24X1KG',
            categoria: 'NO REFRIGERADO · ARROZ',
            marca: 'VENCAMPO',
            unidad_medida: 'BULTO',
          },
        ],
        degustacionesAutorizadas: [],
        serverTime: '2026-11-27T15:00:00.000Z',
        fromOfflineCache: false,
      },
    })
  );

  assert.doesNotMatch(html, /Lote de Producto/i);
  assert.doesNotMatch(html, /Fecha de vencimiento/i);
  assert.match(html, /data-testid="pdv-unit-UNIDAD"/);
  assert.match(html, /data-testid="pdv-unit-BULTO"/);
  assert.match(html, /Por Unidad/);
  assert.match(html, /Por Bulto/);
  assert.match(html, /Unidad Abierta/);
  assert.match(html, /Muestras/);
  assert.match(html, /Ventas/);
});

test('PortalInventarioTab SSR renderiza selector Por Unidad / Por Bulto para control flexible de inventario', () => {
  const html = renderToStaticMarkup(
    React.createElement(PortalInventarioTab, {
      context: {
        promotoraId: 'p-1',
        promotoraRefId: null,
        authUserId: 'u-1',
        nombre: 'Promotora QA',
        correo: 'qa@codizulca.com',
        telefono: '',
        direccion: 'Maracaibo',
        categoria: 'Fijas',
        perfilAsistencia: 'FIJA',
        region: 'Occidente',
        sucursal: 'ZULIA',
        isManagerOrAdmin: false,
        isMerchandisingRole: false,
      },
      clients: [],
      products: [
        {
          id: 'prod-1',
          codigo: '001578',
          nombre: 'ARROZ BLANCO VENCAMPO 24X1KG',
          categoria: 'NO REFRIGERADO · ARROZ',
          presentacion: 'BULTO',
        },
      ],
      activeStore: 'SUPERMERCADO QA',
      onActiveStoreChange: () => undefined,
      onNotify: () => undefined,
    })
  );

  assert.match(html, /data-testid="portal-inv-unit-UNIDAD"/);
  assert.match(html, /data-testid="portal-inv-unit-BULTO"/);
  assert.match(html, /Por Unidad/);
  assert.match(html, /Por Bulto/);
});
