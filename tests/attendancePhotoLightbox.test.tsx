import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttendancePhotoLightbox } from '../src/components/field/AttendanceEvidenceSubTab';

const ROOT = process.cwd();

test('AttendancePhotoLightbox · centra la foto de la promotora en el viewport sin scroll', () => {
  const html = renderToStaticMarkup(
    <AttendancePhotoLightbox
      inlineForSsr={true}
      onClose={() => undefined}
      lightboxState={{
        title: '1. Ingreso a la jornada laboral',
        promotoraNombre: 'María José Pérez',
        perfilAplicado: 'FIJA',
        complianceLabel: '2/2 · Completa',
        pdvNombre: 'Hipermercado Delicias',
        fechaFormateada: '26/11/2026',
        horaCaracasCompleta: '08:05:12 a. m. (UTC-4)',
        imageUrl: 'https://example.invalid/foto-ingreso.webp',
        mapsUrl: 'https://maps.google.com/?q=10.65,-71.63',
        gpsLabel: '10.650000, -71.630000',
      }}
    />
  );

  assert.match(html, /data-testid="attendance-photo-lightbox"/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /fixed inset-0/);
  assert.match(html, /h-\[100dvh\]/);
  assert.match(html, /flex items-center justify-center/);
  assert.match(html, /overflow-hidden/);
  assert.match(html, /cz-obsidian-anchor/);
  assert.match(html, /object-contain/);
  assert.match(html, /max-h-\[calc\(92dvh-3\.5rem\)\]/);
  assert.match(html, /https:\/\/example\.invalid\/foto-ingreso\.webp/);
  assert.match(html, /María José Pérez/);
  assert.match(html, /Cerrar vista ampliada de evidencia/);
});

test('Lightbox Portal y CSS · ningún contenedor de pestaña atrapa position:fixed ni obliga a scrollear', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
  const enterRuleMatch = css.match(/\.cz-tab-panel-enter\s*\{([^}]*)\}/);
  assert.ok(enterRuleMatch, 'Debe existir la regla .cz-tab-panel-enter en src/index.css');

  const enterRuleBody = enterRuleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(
    enterRuleBody,
    /animation:\s*cz-tab-panel-fade-slide\s+150ms[^;]*backwards\s*;/,
    '.cz-tab-panel-enter debe usar fill-mode backwards para liberar transform al terminar los 150ms'
  );
  assert.doesNotMatch(
    enterRuleBody,
    /\b(both|forwards)\b/,
    '.cz-tab-panel-enter no debe retener transform permanentemente con both/forwards'
  );
  assert.doesNotMatch(
    enterRuleBody,
    /will-change\s*:/,
    '.cz-tab-panel-enter no debe dejar will-change: transform persistente que cree un containing block para position:fixed'
  );

  for (const relPath of [
    'src/components/field/AttendanceEvidenceSubTab.tsx',
    'src/components/field/FieldPromotoraView.tsx',
    'src/components/field/PriceComparisonReportSubTab.tsx',
  ]) {
    const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    assert.match(
      src,
      /import\s*\{\s*createPortal\s*\}\s*from\s*'react-dom'/,
      `${relPath} debe importar createPortal desde react-dom`
    );
    assert.match(
      src,
      /createPortal\([^)]*document\.body\)/,
      `${relPath} debe montar su visor de fotos en document.body vía createPortal`
    );
    assert.match(
      src,
      /document\.body\.style\.overflow\s*=\s*'hidden'/,
      `${relPath} debe bloquear el scroll del fondo mientras el visor fotográfico está abierto`
    );
  }
});
