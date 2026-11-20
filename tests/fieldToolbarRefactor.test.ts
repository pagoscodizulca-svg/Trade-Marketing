import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT_DIR = process.cwd();
const FIELD_VIEW_PATH = path.join(ROOT_DIR, 'src', 'components', 'field', 'FieldPromotoraView.tsx');
const UPLOAD_MODAL_PATH = path.join(
  ROOT_DIR,
  'src',
  'components',
  'field',
  'MultiFormatTastingUploadModal.tsx'
);

test('FieldPromotoraView · Barra superior contiene exactamente 3 botones en orden y cero controles descartados', () => {
  const source = fs.readFileSync(FIELD_VIEW_PATH, 'utf8').replace(/\r\n/g, '\n');

  // 1. Orden exacto de izquierda a derecha en la barra de acciones
  const idxAuth = source.indexOf('data-testid="btn-toolbar-export-auth-pdf"');
  const idxEnlaces = source.indexOf('data-testid="btn-toolbar-enlaces"');
  const idxGlobal = source.indexOf('data-testid="btn-toolbar-export-global-pdf"');

  assert.ok(idxAuth > 0, 'Debe existir el botón Exportar PDF Autorización');
  assert.ok(idxEnlaces > 0, 'Debe existir el botón Enlaces');
  assert.ok(idxGlobal > 0, 'Debe existir el botón Exportar Informe Global (PDF)');
  assert.ok(
    idxAuth < idxEnlaces && idxEnlaces < idxGlobal,
    'El orden exacto debe ser: 1) Exportar PDF Autorización, 2) Enlaces, 3) Exportar Informe Global (PDF)'
  );

  // Extraer bloque exacto de la barra de acciones y verificar que hay exactamente 3 <button>
  const toolbarStart = source.indexOf('data-testid="degustaciones-toolbar-actions"');
  assert.ok(toolbarStart > 0, 'Debe existir el contenedor degustaciones-toolbar-actions');
  const toolbarEnd = source.indexOf('</div>\n            </div>', toolbarStart);
  assert.ok(toolbarEnd > toolbarStart, 'Debe cerrar el contenedor de la barra superior');
  const toolbarSnippet = source.slice(toolbarStart, toolbarEnd);

  const buttonTags = toolbarSnippet.match(/<button\b/g) ?? [];
  assert.equal(buttonTags.length, 3, 'La barra superior debe renderizar exactamente 3 botones');
  assert.match(toolbarSnippet, /Exportar PDF Autorización/);
  assert.match(toolbarSnippet, /<span>Enlaces<\/span>/);
  assert.match(toolbarSnippet, /Exportar Informe Global \(PDF\)/);
  assert.match(toolbarSnippet, /aria-busy=\{isExportingAuthPdf\}/);
  assert.match(toolbarSnippet, /aria-busy=\{isExportingMonthlyPdf\}/);

  // 2. Ausencia total de controles descartados, modales e imports muertos
  for (const forbidden of [
    'PDF Vista Actual',
    'Cargar Archivo (Excel / CSV / PDF)',
    '+ Enviar Solicitud FDV',
    'Ciclo ISO (',
    'MultiFormatTastingUploadModal',
    'isMultiFormatUploadOpen',
    'syncedStoreItemsForUpload',
    'isSimulateSellerAppOpen',
    'handleSendFromSellerApp',
    'createSupabaseSellerDegustacionRequest',
    'exportTastingSchedulePdf',
    'getCaracasWeekCycleBounds',
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `FieldPromotoraView.tsx no debe contener código retirado: ${forbidden}`
    );
  }

  assert.equal(
    fs.existsSync(UPLOAD_MODAL_PATH),
    false,
    'MultiFormatTastingUploadModal.tsx (<input type="file">) debe haberse eliminado del cliente'
  );
});

test('FieldPromotoraView · Scroll accesible en botón Enlaces y preservación interna de Ciclo ISO', () => {
  const source = fs.readFileSync(FIELD_VIEW_PATH, 'utf8');

  // Scroll accesible con ref tipado, requestAnimationFrame, prefers-reduced-motion y focus sin mutar href
  assert.match(source, /useRef<HTMLElement \| null>\(null\)/);
  assert.match(source, /window\.requestAnimationFrame/);
  assert.match(source, /prefers-reduced-motion:\s*reduce/);
  assert.match(source, /scrollIntoView\(\{/);
  assert.match(source, /focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /data-testid="field-portal-links-section"/);
  assert.ok(!source.includes('window.location.href'), 'No debe manipular window.location.href');

  // Lógica interna de Ciclo ISO intacta para ambos reportes PDF y consultas
  assert.match(source, /useLiveVenezuelaClock\(\)/);
  assert.match(source, /isTastingInPastCaracasWeek/);
  assert.match(source, /partitionTastingsByCaracasWeek/);
  assert.match(source, /FEATURE_FLAGS\.ENABLE_MODULO1_CICLO_ISO_BADGE/);
});
