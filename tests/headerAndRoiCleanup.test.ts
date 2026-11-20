import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT_DIR = process.cwd();
const APP_PATH = path.join(ROOT_DIR, 'src', 'App.tsx');
const FIELD_VIEW_PATH = path.join(ROOT_DIR, 'src', 'components', 'field', 'FieldPromotoraView.tsx');
const SYNC_BADGE_PATH = path.join(ROOT_DIR, 'src', 'components', 'common', 'SyncStatusBadge.tsx');
const FEASIBILITY_UTIL_PATH = path.join(ROOT_DIR, 'src', 'utils', 'tastingFeasibility.ts');
const WEEK_CALENDAR_PATH = path.join(ROOT_DIR, 'src', 'utils', 'weekCalendar.ts');

test('Header Cleanup · App.tsx desmonta los 7 controles del encabezado y conserva identidad de marca y RBAC', () => {
  const appSource = fs.readFileSync(APP_PATH, 'utf8');

  // Identidad de marca intacta y semántica
  assert.match(appSource, /data-testid="dashboard-top-header"/);
  assert.match(appSource, /data-testid="dashboard-brand-logo"/);
  assert.match(appSource, /data-testid="dashboard-rif-badge"/);
  assert.match(appSource, /CODIZULCA C\.A\./);
  assert.match(appSource, /RIF: J-07011928-0/);

  // Auth / RBAC preservados
  assert.match(appSource, /TradeAuthGate/);
  assert.match(appSource, /RoleGuard/);

  // Los 7 controles retirados no existen ni importados ni montados en App.tsx
  for (const forbidden of [
    'Campo & Merchandising',
    'ControlRoomThemeToggle',
    'SyncStatusBadge',
    '<DegustacionesNotificationBell',
    'useLiveVenezuelaClock',
    'Sem. {liveClock',
    'Hoy: {liveClock',
    'href="/portal"',
    'handleOpenDegustacionNotification',
  ]) {
    assert.ok(!appSource.includes(forbidden), `App.tsx no debe contener: ${forbidden}`);
  }
  assert.ok(
    !/import\s*\{[^}]*\bDegustacionesNotificationBell\b/.test(appSource),
    'App.tsx no debe importar el símbolo DegustacionesNotificationBell'
  );

  assert.equal(
    fs.existsSync(SYNC_BADGE_PATH),
    false,
    'SyncStatusBadge.tsx debe haberse eliminado por falta de consumidores'
  );
  assert.equal(
    fs.existsSync(WEEK_CALENDAR_PATH),
    true,
    'weekCalendar.ts debe conservarse intacto para filtros y exportadores PDF'
  );
});

test('ROI Cleanup · FieldPromotoraView.tsx desmonta tarjeta de Factibilidad/ROI y conserva utilidad compartida', () => {
  const fieldSource = fs.readFileSync(FIELD_VIEW_PATH, 'utf8');

  for (const forbidden of [
    'Factibilidad vs. Costo de Productos Degustados',
    'COSTO PROD. DEGUSTADOS',
    'Costo Prod. Degustados',
    'Ventas Directas Logradas',
    'Balance Neto (Venta - Costo)',
    'Multiplicador / ROI',
    'displayedFeasibility',
    'evaluateTastingFeasibility',
  ]) {
    assert.ok(
      !fieldSource.includes(forbidden),
      `FieldPromotoraView.tsx no debe exponer/renderizar: ${forbidden}`
    );
  }

  assert.equal(
    fs.existsSync(FEASIBILITY_UTIL_PATH),
    true,
    'tastingFeasibility.ts debe conservarse para ExecutiveDashboard (Módulo 4) y pruebas financieras'
  );
});
