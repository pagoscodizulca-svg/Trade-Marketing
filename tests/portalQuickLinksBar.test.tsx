import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildSafeInternalPortalUrl,
  INTERNAL_ROUTES,
  PortalQuickLinksBar,
} from '../src/components/admin/PortalQuickLinksBar';

test('PortalQuickLinksBar · INTERNAL_ROUTES contiene exclusivamente rutas relativas permitidas', () => {
  assert.deepEqual(INTERNAL_ROUTES, {
    promotoras: '/portal',
    chofer: '/logistica/',
  });
  for (const path of Object.values(INTERNAL_ROUTES)) {
    assert.ok(path.startsWith('/'), `Ruta ${path} debe comenzar con /`);
    assert.ok(!path.startsWith('//'), `Ruta ${path} no puede ser protocol-relative`);
    assert.ok(!path.includes('?'), `Ruta ${path} no debe contener query params`);
    assert.ok(!path.includes('#'), `Ruta ${path} no debe contener hash`);
  }
});

test('PortalQuickLinksBar · buildSafeInternalPortalUrl genera URLs limpias sin fuga de query, hash ni tokens', () => {
  const prodOrigin = 'https://trade-marketing-qi6j.onrender.com';
  const promUrl = buildSafeInternalPortalUrl('promotoras', prodOrigin);
  const choferUrl = buildSafeInternalPortalUrl('chofer', prodOrigin);

  assert.equal(promUrl, 'https://trade-marketing-qi6j.onrender.com/portal');
  assert.equal(choferUrl, 'https://trade-marketing-qi6j.onrender.com/logistica/');

  // Aun si se pasara un string con query/hash en explicitOrigin, solo se usa parsedOrigin.origin (zero leakage)
  const pollutedOrigin =
    'https://trade-marketing-qi6j.onrender.com/admin?token=secret_jwt&tab=personal#session=123';
  assert.equal(
    buildSafeInternalPortalUrl('promotoras', pollutedOrigin),
    'https://trade-marketing-qi6j.onrender.com/portal'
  );
  assert.equal(
    buildSafeInternalPortalUrl('chofer', pollutedOrigin),
    'https://trade-marketing-qi6j.onrender.com/logistica/'
  );

  // Rechaza protocolos peligrosos o orígenes vacíos
  assert.throws(() => buildSafeInternalPortalUrl('promotoras', 'javascript:alert(1)'));
  assert.throws(() => buildSafeInternalPortalUrl('chofer', 'data:text/html,<h1>x</h1>'));
  assert.throws(() => buildSafeInternalPortalUrl('promotoras', 'file:///etc/passwd'));
  assert.throws(() => buildSafeInternalPortalUrl('promotoras', ''));
});

test('PortalQuickLinksBar · SSR renderiza únicamente dos botones nativos accesibles sin panel dinámico ni alertas', () => {
  const html = renderToStaticMarkup(<PortalQuickLinksBar />);

  assert.match(html, /data-testid="portal-quick-links-bar"/);
  assert.match(html, /data-testid="btn-copy-link-promotoras"/);
  assert.match(html, /data-testid="btn-copy-link-chofer"/);
  assert.match(html, /Copiar Link App Promotoras/);
  assert.match(html, /Copiar Link App Chofer/);
  assert.match(html, /aria-live="polite"/);

  // Exactamente 2 botones nativos <button type="button">
  const buttonMatches = html.match(/<button\s+type="button"/g) ?? [];
  assert.equal(buttonMatches.length, 2, 'Debe renderizar exactamente 2 botones nativos');

  // Cero rastros del panel antiguo
  for (const forbidden of [
    'Enlaces Dinámicos Firmados',
    'enlaces activos',
    'No se pudieron consultar los enlaces activos',
    'HMAC-SHA256',
    'Vigencia del enlace',
    'Actualizar',
  ]) {
    assert.ok(!html.includes(forbidden), `No debe renderizar texto obsoleto: ${forbidden}`);
  }
});
