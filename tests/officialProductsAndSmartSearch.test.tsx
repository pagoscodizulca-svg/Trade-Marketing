import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  OFFICIAL_PORTAL_PRODUCT_OPTIONS,
  OFFICIAL_TRADE_PRODUCTS_CATALOG,
  OFFICIAL_TRADE_PRODUCTS_MAESTROS,
  applyOfficialTradeProductsCatalog,
} from '../src/data/officialTradeProductsCatalog';
import { OFFICIAL_RUTA_PRODUCTS } from '../ruta-degustacion/src/data/officialTradeProducts';
import { normalizeErpProductosDataset } from '../src/utils/erpMasterAdapter';
import {
  SmartSearchCombobox,
  filterSmartComboboxOptions,
} from '../src/components/common/SmartSearchCombobox';
import {
  PortalProductSelector,
  filterPortalProductsSmart,
} from '../src/components/portal/PortalCatalogSelectors';

test('Catálogo oficial de productos · exactamente 152 artículos vigentes sincronizados entre Dashboard, Portal y Logística', () => {
  assert.equal(OFFICIAL_TRADE_PRODUCTS_CATALOG.length, 152);
  assert.equal(OFFICIAL_TRADE_PRODUCTS_MAESTROS.length, 152);
  assert.equal(OFFICIAL_PORTAL_PRODUCT_OPTIONS.length, 152);
  assert.equal(OFFICIAL_RUTA_PRODUCTS.length, 152);

  const uniqueCodes = new Set(OFFICIAL_TRADE_PRODUCTS_CATALOG.map((p) => p.codigo));
  assert.equal(uniqueCodes.size, 152, 'Todos los códigos ERP deben ser únicos');

  // Paridad exacta de códigos entre Trade Marketing y ruta-degustacion
  const rutaCodes = new Set(OFFICIAL_RUTA_PRODUCTS.map((p) => p.codigo));
  assert.deepEqual(rutaCodes, uniqueCodes);

  // Verificar extremos y artículos actualizados del CSV
  assert.ok(OFFICIAL_TRADE_PRODUCTS_MAESTROS.some((p) => p.codigo === '000008' && p.nombre === 'POLLO EBENEZER POR KG'));
  assert.ok(OFFICIAL_TRADE_PRODUCTS_MAESTROS.some((p) => p.codigo === '001662' && p.categoria === 'CONFITERIA · VARIOS'));
  assert.ok(OFFICIAL_TRADE_PRODUCTS_MAESTROS.some((p) => p.codigo === '001671' && p.nombre === 'MORT NAVIDEÑA TIPO TENDER ASTURIAS X KG'));
  assert.ok(OFFICIAL_TRADE_PRODUCTS_MAESTROS.some((p) => p.codigo === '001672' && p.nombre === 'MORT NAVIDEÑA DE PAVO TIPO TENDER ASTURIAS X KG'));
});

test('normalizeErpProductosDataset · filtra obsoletos del ERP y preserva UUIDs reales de los artículos oficiales', () => {
  const normalized = normalizeErpProductosDataset(
    [
      { id_prod: 'uuid-old', prod_codi: '000006', prod_desc: 'TENDER OBSOLETO', prod_unid: 'KG', prod_acti: true },
      { id_prod: 'uuid-1464', prod_codi: '001464', prod_desc: 'MORT. NAVIDEÑA ASTURIAS XKG', prod_unid: 'KG', prod_acti: true },
      { id_prod: 'uuid-1671', prod_codi: '001671', prod_desc: 'MORT. COCIDA NAVIDEÑA TIPO TENDER X KG', prod_unid: 'KG', prod_acti: true },
    ],
    []
  );

  assert.equal(normalized.length, 2, 'El artículo obsoleto 000006 debe quedar fuera del catálogo vigente');
  const p1464 = normalized.find((p) => p.codigo === '001464');
  const p1671 = normalized.find((p) => p.codigo === '001671');
  assert.equal(p1464?.id, 'uuid-1464');
  assert.equal(p1464?.nombre, 'MORT DE NAVIDEÑA ASTURIAS XKG');
  assert.equal(p1464?.categoria, 'ENTEROS · ESPALD AHUM');
  assert.equal(p1671?.id, 'uuid-1671');
  assert.equal(p1671?.nombre, 'MORT NAVIDEÑA TIPO TENDER ASTURIAS X KG');
  assert.equal(p1671?.categoria, 'ENTEROS · JAMONES');

  // Fallback completo al catálogo oficial cuando la entrada viene vacía
  const fallback = applyOfficialTradeProductsCatalog([], { fallbackToFullCatalogIfEmpty: true });
  assert.equal(fallback.length, 152);
});

test('Buscador inteligente Dashboard (SmartSearchCombobox) · filtra al instante productos y promotoras sin tildes ni ceros', () => {
  const productOptions = OFFICIAL_TRADE_PRODUCTS_MAESTROS.map((p) => ({
    value: p.nombre,
    label: p.nombre,
    sublabel: `${p.codigo} • ${p.categoria}`,
    badge: p.unidad_medida,
    keywords: `${p.codigo} ${p.codigo.replace(/^0+/, '')} ${p.categoria ?? ''} ${p.marca ?? ''}`,
  }));

  // Búsqueda por código sin ceros a la izquierda
  const byShortCode = filterSmartComboboxOptions(productOptions, '8');
  assert.equal(byShortCode[0]?.value, 'POLLO EBENEZER POR KG');

  // Búsqueda multi-término sin tildes/ñ
  const byAccentFree = filterSmartComboboxOptions(productOptions, 'dona flora queso');
  assert.equal(byAccentFree.length, 1);
  assert.equal(byAccentFree[0]?.value, 'QUESO MOZARELLA EN BARRA DOÑA FLORA');

  // Búsqueda de promotoras
  const promOptions = [
    { value: 'AUTO', label: 'Asignación Automática (Disponible)' },
    { value: 'MARÍA JOSÉ PÉREZ', label: 'MARÍA JOSÉ PÉREZ' },
    { value: 'NICOLE GODOY', label: 'NICOLE GODOY' },
  ];
  const promMatch = filterSmartComboboxOptions(promOptions, 'maria perez');
  assert.equal(promMatch.length, 1);
  assert.equal(promMatch[0]?.value, 'MARÍA JOSÉ PÉREZ');

  // Renderizado SSR accesible del combobox
  const html = renderToStaticMarkup(
    <SmartSearchCombobox
      testId="qa-smart-combo"
      value="POLLO EBENEZER POR KG"
      onChange={() => undefined}
      options={productOptions}
    />
  );
  assert.match(html, /role="combobox"/);
  assert.match(html, /data-testid="qa-smart-combo"/);
  assert.match(html, /POLLO EBENEZER POR KG/);
});

test('Buscador inteligente Portal de Promotoras (PortalProductSelector) · respaldo de 152 SKUs y búsqueda multi-término', () => {
  const portalOptions = OFFICIAL_PORTAL_PRODUCT_OPTIONS.map((p) => ({
    id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    categoria: p.categoria,
    presentacion: p.presentacion,
  }));

  const byCode = filterPortalProductsSmart(portalOptions, '1599');
  assert.equal(byCode[0]?.codigo, '001599');
  assert.equal(byCode[0]?.nombre, 'MORT. NAVIDEÑA SALPICAO X KG');

  const byTokens = filterPortalProductsSmart(portalOptions, 'nectar manzana 500ml');
  assert.equal(byTokens.length, 1);
  assert.equal(byTokens[0]?.codigo, '001249');

  const html = renderToStaticMarkup(
    <PortalProductSelector
      value=""
      onChange={() => undefined}
      products={[]}
      testIdPrefix="qa-portal-prod"
    />
  );
  assert.match(html, /data-testid="qa-portal-prod-search"/);
  assert.match(html, /152 SKUs/);
});
