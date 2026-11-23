import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClientePortalAccesosManager } from '../src/components/admin/ClientePortalAccesosManager';
import { CadenaLogoUploaderModal } from '../src/components/admin/CadenaLogoUploaderModal';
import { SucursalPersonalModule } from '../src/components/admin/SucursalPersonalModule';
import { ClienteReadOnlyPortalView } from '../src/components/cliente/ClienteReadOnlyPortalView';
import { ErrorBoundary } from '../src/components/common/ErrorBoundary';
import { RegionalComparisonTab } from '../src/components/dashboard/RegionalComparisonTab';
import { IncidenciaQuickModal } from '../src/components/portal/IncidenciaQuickModal';
import { RegionGateSelector } from '../src/components/region/RegionGateSelector';
import { AnimatedTabContainer, SlidingTabRail } from '../src/components/ui/AnimatedTabContainer';
import { ControlRoomThemeToggle } from '../src/components/ui/ControlRoomThemeToggle';
import { ThemeModeProvider, UI_THEME_STORAGE_KEY } from '../src/context/ThemeModeContext';
import { esClaveAuth } from '../ruta-degustacion/src/services/cleanSync';
import { computeCadenaInitials, isSafeLocalLogoSrc } from '../src/services/cadenaLogoService';
import { isPreservedKey } from '../src/services/cleanSync';
import type { ClientePortalResumen } from '../src/services/clientePortalService';
import { SLA_HOURS_BY_SEVERIDAD } from '../src/services/popIncidenciasService';
import {
  PORTAL_OFFLINE_IDB_NAME,
  clearMemoryPortalQueueForTests,
  encodeBinaryToBase64,
  enqueuePortalIncidenciaOffline,
  listPendingPortalActions,
} from '../src/services/portalOfflineQueueService';
import type { RegionalComparisonRow } from '../src/services/regionesService';
import {
  buildDocxReportBuffer,
  buildExecutiveWorkbookBuffer,
  neutralizeFormulaInjection,
} from '../src/utils/excelWordExport';

// PNG 1x1 válido (68 bytes) para verificar magic bytes e ingesta offline
const VALID_1X1_PNG_BYTES = Uint8Array.from(
  Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
    'hex'
  )
);

const FIVE_HUB_COMPARISON_ROWS: RegionalComparisonRow[] = [
  {
    region_id: '11111111-1111-4111-8111-111111111101',
    region_codigo: 'ZULIA',
    region_nombre: 'Zulia',
    clientes_activos: 140,
    promotoras_activas: 22,
    vendedores_activos: 18,
    rutas_programadas: 120,
    rutas_completadas: 111,
    cumplimiento_rutas_pct: 92.5,
    degustaciones_programadas: 45,
    degustaciones_ejecutadas: 42,
    muestras_entregadas: 3400,
    ventas_asistidas: 610,
    presupuesto_asignado_usd: 12500,
    presupuesto_ejecutado_usd: 11250,
    ejecucion_presupuestaria_pct: 90.0,
    requisiciones_mp07_total: 14,
    requisiciones_conciliadas: 13,
    pop_items_activos: 28,
    pop_stock_critico_count: 2,
    incidencias_totales: 10,
    incidencias_abiertas: 1,
    incidencias_en_sla_count: 9,
    cumplimiento_sla_pct: 90.0,
  },
  {
    region_id: '11111111-1111-4111-8111-111111111102',
    region_codigo: 'VALENCIA',
    region_nombre: 'Valencia',
    clientes_activos: 95,
    promotoras_activas: 16,
    vendedores_activos: 14,
    rutas_programadas: 90,
    rutas_completadas: 81,
    cumplimiento_rutas_pct: 90.0,
    degustaciones_programadas: 32,
    degustaciones_ejecutadas: 29,
    muestras_entregadas: 2250,
    ventas_asistidas: 420,
    presupuesto_asignado_usd: 9000,
    presupuesto_ejecutado_usd: 7920,
    ejecucion_presupuestaria_pct: 88.0,
    requisiciones_mp07_total: 10,
    requisiciones_conciliadas: 9,
    pop_items_activos: 24,
    pop_stock_critico_count: 1,
    incidencias_totales: 8,
    incidencias_abiertas: 1,
    incidencias_en_sla_count: 7,
    cumplimiento_sla_pct: 87.5,
  },
  {
    region_id: '11111111-1111-4111-8111-111111111103',
    region_codigo: 'CENTRO',
    region_nombre: 'Centro',
    clientes_activos: 82,
    promotoras_activas: 12,
    vendedores_activos: 11,
    rutas_programadas: 75,
    rutas_completadas: 66,
    cumplimiento_rutas_pct: 88.0,
    degustaciones_programadas: 26,
    degustaciones_ejecutadas: 23,
    muestras_entregadas: 1850,
    ventas_asistidas: 335,
    presupuesto_asignado_usd: 7500,
    presupuesto_ejecutado_usd: 6450,
    ejecucion_presupuestaria_pct: 86.0,
    requisiciones_mp07_total: 8,
    requisiciones_conciliadas: 8,
    pop_items_activos: 20,
    pop_stock_critico_count: 0,
    incidencias_totales: 5,
    incidencias_abiertas: 0,
    incidencias_en_sla_count: 5,
    cumplimiento_sla_pct: 100.0,
  },
  {
    region_id: '11111111-1111-4111-8111-111111111104',
    region_codigo: 'ORIENTE',
    region_nombre: 'Oriente',
    clientes_activos: 74,
    promotoras_activas: 11,
    vendedores_activos: 10,
    rutas_programadas: 64,
    rutas_completadas: 56,
    cumplimiento_rutas_pct: 87.5,
    degustaciones_programadas: 20,
    degustaciones_ejecutadas: 18,
    muestras_entregadas: 1420,
    ventas_asistidas: 260,
    presupuesto_asignado_usd: 6800,
    presupuesto_ejecutado_usd: 5780,
    ejecucion_presupuestaria_pct: 85.0,
    requisiciones_mp07_total: 7,
    requisiciones_conciliadas: 6,
    pop_items_activos: 18,
    pop_stock_critico_count: 3,
    incidencias_totales: 6,
    incidencias_abiertas: 2,
    incidencias_en_sla_count: 5,
    cumplimiento_sla_pct: 83.3,
  },
  {
    region_id: '11111111-1111-4111-8111-111111111105',
    region_codigo: 'CAPITAL',
    region_nombre: 'Capital',
    clientes_activos: 118,
    promotoras_activas: 19,
    vendedores_activos: 16,
    rutas_programadas: 100,
    rutas_completadas: 94,
    cumplimiento_rutas_pct: 94.0,
    degustaciones_programadas: 38,
    degustaciones_ejecutadas: 36,
    muestras_entregadas: 2980,
    ventas_asistidas: 540,
    presupuesto_asignado_usd: 11000,
    presupuesto_ejecutado_usd: 10120,
    ejecucion_presupuestaria_pct: 92.0,
    requisiciones_mp07_total: 12,
    requisiciones_conciliadas: 12,
    pop_items_activos: 26,
    pop_stock_critico_count: 1,
    incidencias_totales: 9,
    incidencias_abiertas: 0,
    incidencias_en_sla_count: 9,
    cumplimiento_sla_pct: 100.0,
  },
];

test('Compuerta G3/G4 · Smoke SSR de Renderizado UI + Invariantes de Seguridad (6 Componentes)', async (t) => {
  await t.test('a) ErrorBoundary: renderiza hijos normales y fallback seguro sin filtrar error.message ni error.stack', () => {
    const normalHtml = renderToStaticMarkup(
      <ErrorBoundary>
        <main data-testid="torre-safe-children">Torre de Control Operativa</main>
      </ErrorBoundary>
    );
    assert.match(normalHtml, /data-testid="torre-safe-children"/);
    assert.match(normalHtml, /Torre de Control Operativa/);
    assert.ok(!normalHtml.includes('Ocurrió un error inesperado'));

    const sensitiveError = new Error(
      'FATAL db_conn=postgresql://svc_admin:topsecret999@10.0.0.15:5432/codizulca'
    );
    sensitiveError.stack =
      'Error: FATAL db_conn=postgresql://svc_admin:topsecret999@10.0.0.15:5432/codizulca\n    at internalQuery (/srv/app/db.ts:44:11)';

    const derivedState = ErrorBoundary.getDerivedStateFromError();
    assert.equal(derivedState.hasError, true);
    assert.match(derivedState.errorId, /^ERR-[A-Z0-9]+-[A-Z0-9]{4}$/);

    const boundaryInstance = new ErrorBoundary({
      children: React.createElement('div', null, 'No debe mostrarse'),
    });
    boundaryInstance.state = derivedState;

    const fallbackHtml = renderToStaticMarkup(
      boundaryInstance.render() as React.ReactElement
    );
    assert.match(fallbackHtml, /role="alert"/);
    assert.match(fallbackHtml, /Ocurrió un error inesperado/);
    assert.ok(fallbackHtml.includes(derivedState.errorId), 'Debe mostrar código de referencia seguro');
    assert.match(fallbackHtml, /Reintentar/);
    assert.match(fallbackHtml, /Recargar/);
    assert.ok(!fallbackHtml.includes('topsecret999'), 'Jamás debe filtrar error.message');
    assert.ok(!fallbackHtml.includes('internalQuery'), 'Jamás debe filtrar error.stack');
    assert.ok(!fallbackHtml.includes('No debe mostrarse'));
  });

  await t.test('b) RegionGateSelector: modo gate (3 regiones reales OCCIDENTE/CENTRO/ANDES + Todas + Comparativo) para super_admin/contraloria y modo bar bloqueado para coordinacion', () => {
    const gateHtml = renderToStaticMarkup(
      <RegionGateSelector
        mode="gate"
        canSwitchSucursal={true}
        activeSucursal="OCCIDENTE"
        userRoleLabel="Contraloría"
        userEmail="contraloria@codizulca.com"
        onSelectSucursal={() => undefined}
        onOpenComparativo={() => undefined}
      />
    );

    assert.match(gateHtml, /data-testid="region-gate-selector"/);
    assert.match(gateHtml, /data-testid="region-gate-card-ALL"/);
    assert.match(gateHtml, /data-testid="region-gate-comparativo-btn"/);
    assert.match(gateHtml, /Comparativo/);

    for (const code of ['OCCIDENTE', 'CENTRO', 'ANDES'] as const) {
      assert.match(gateHtml, new RegExp(`data-testid="region-gate-card-${code}"`));
      assert.ok(gateHtml.includes(`Región ${code}`), `Falta tarjeta para Región ${code}`);
    }

    const lockedBarHtml = renderToStaticMarkup(
      <RegionGateSelector
        mode="bar"
        canSwitchSucursal={false}
        activeSucursal="ZULIA"
        userRoleLabel="Coordinación"
        userEmail="coord.zulia@codizulca.com"
      />
    );

    assert.match(lockedBarHtml, /data-testid="region-bar-locked-badge"/);
    assert.match(lockedBarHtml, /Región asignada por correo: Región OCCIDENTE/);
    assert.ok(
      !lockedBarHtml.includes('data-testid="region-bar-select"'),
      'Sin selector desplegable en modo bloqueado'
    );
    assert.ok(!lockedBarHtml.includes('region-bar-btn-'), 'Sin botones de cambio de sede en modo bloqueado');
    assert.ok(!lockedBarHtml.includes('region-bar-comparativo-btn'), 'Sin botón Comparativo para coordinación');
    assert.ok(!/<button\b/i.test(lockedBarHtml), 'Cero botones interactivos en barra bloqueada');
    assert.ok(!/<select\b/i.test(lockedBarHtml), 'Cero selectores en barra bloqueada');

    const rutaGateSource = fs.readFileSync(
      path.join(process.cwd(), 'ruta-degustacion', 'src', 'components', 'auth', 'RutaAuthGate.tsx'),
      'utf8'
    );
    assert.ok(
      rutaGateSource.includes('(Zulia, Valencia, Centro, Oriente y Capital)'),
      'RutaAuthGate (/logistica/) debe listar las 5 sucursales oficiales'
    );
    assert.ok(
      !rutaGateSource.includes('(Zulia / Valencia)'),
      'RutaAuthGate (/logistica/) no debe mostrar el texto legado de solo 2 sucursales'
    );

    const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    assert.ok(
      appSource.includes("key={`${profile.userId}:${profile.sucursal || 'GLOBAL'}`}"),
      'App.tsx debe remontar AppProvider al cambiar de cuenta o sucursal autenticada'
    );
  });

  await t.test('c) RegionalComparisonTab: renderiza 5 hubs lado a lado, KPIs ejecutivos y botones .xlsx / .pdf', () => {
    const html = renderToStaticMarkup(
      <RegionalComparisonTab
        initialRows={FIVE_HUB_COMPARISON_ROWS}
        initialPeriodoInicio="2026-11-01"
        initialPeriodoFin="2026-11-30"
        isAuthorized={true}
        generatedBy="Auditoría Nacional"
        onSelectSucursalToInspect={() => undefined}
      />
    );

    assert.match(html, /data-testid="regional-comparison-tab"/);
    assert.match(html, /data-testid="regional-comparison-cards"/);
    assert.match(html, /data-testid="regional-comparison-table"/);

    for (const [code, name] of [
      ['ZULIA', 'Zulia'],
      ['VALENCIA', 'Valencia'],
      ['CENTRO', 'Centro'],
      ['ORIENTE', 'Oriente'],
      ['CAPITAL', 'Capital'],
    ] as const) {
      assert.match(html, new RegExp(`data-testid="regional-card-${code}"`));
      assert.ok(html.includes(name), `Debe renderizar región ${name}`);
    }

    // KPIs: cumplimiento de rutas, degustaciones, presupuesto MP-07, POP crítico y SLA incidencias
    assert.match(html, /Cumplimiento de Rutas/);
    assert.match(html, /Degustaciones/);
    assert.match(html, /MP-07/);
    assert.match(html, /POP Crítico/);
    assert.match(html, /SLA/);
    assert.match(html, /Consolidado Nacional/);

    // Botones de exportación .xlsx y .pdf presentes
    assert.match(html, /data-testid="comparativo-export-xlsx"/);
    assert.match(html, /\.xlsx/);
    assert.match(html, /data-testid="comparativo-export-pdf"/);
    assert.match(html, /\.pdf/);

    // Control de acceso: rol no autorizado recibe pantalla denegada
    const deniedHtml = renderToStaticMarkup(
      <RegionalComparisonTab initialRows={FIVE_HUB_COMPARISON_ROWS} isAuthorized={false} />
    );
    assert.match(deniedHtml, /data-testid="regional-comparison-denied"/);
    assert.ok(!deniedHtml.includes('data-testid="regional-comparison-table"'));
  });

  await t.test('d) SucursalPersonalModule: coordinacion aislada a Zulia vs super_admin con 5 módulos + ClientePortalAccesosManager', () => {
    const coordinatorHtml = renderToStaticMarkup(
      <SucursalPersonalModule
        viewerIamRole="coordinacion"
        lockedSucursal="ZULIA"
        initialBundle={{
          sucursal: 'ZULIA',
          region_id: '11111111-1111-4111-8111-111111111101',
          staff: [
            {
              id: 'aaaaaaaa-1111-4111-8111-111111111111',
              name: 'María González Zulia',
              role: 'Promotora Fija',
              email: 'maria.zulia@codizulca.com',
              status: 'Activo',
              auth_user_id: '99999999-1111-4111-8111-111111111111',
              sucursal: 'ZULIA',
            },
            {
              id: 'bbbbbbbb-2222-4222-8222-222222222222',
              name: 'Intrusa Valencia Filtrada',
              role: 'Promotora Fija',
              email: 'intrusa.valencia@codizulca.com',
              status: 'Activo',
              sucursal: 'VALENCIA',
            },
          ],
          clientes: [
            {
              id: 'cccccccc-1111-4111-8111-111111111111',
              codigo_cliente: 'ZUL-001',
              nombre_comercial: 'HIPERMERCADO MARACAIBO NORTE',
              ciudad: 'Maracaibo',
              estado: 'Zulia',
              activo: true,
              sucursal: 'ZULIA',
            },
          ],
          cadenas: [],
          profiles: [],
          portal_accesos: [],
        }}
      />
    );

    assert.match(coordinatorHtml, /data-testid="sucursal-personal-module-zulia"/);
    assert.match(coordinatorHtml, /Módulo Personal Zulia/);
    assert.match(coordinatorHtml, /data-testid="locked-sucursal-badge"/);
    assert.match(coordinatorHtml, /data-testid="portal-quick-links-bar"/);
    assert.match(coordinatorHtml, /data-testid="btn-copy-link-promotoras"/);
    assert.match(coordinatorHtml, /data-testid="btn-copy-link-chofer"/);
    assert.ok(!coordinatorHtml.includes('Enlaces Dinámicos Firmados'));
    assert.ok(!coordinatorHtml.includes('enlaces activos'));
    assert.ok(!coordinatorHtml.includes('No se pudieron consultar los enlaces activos'));
    assert.ok(coordinatorHtml.includes('María González Zulia'));
    assert.ok(
      !coordinatorHtml.includes('Intrusa Valencia Filtrada'),
      'Cero mezcla: registros de otra sucursal se descartan estrictamente'
    );
    assert.ok(
      !coordinatorHtml.includes('sucursal-modules-switcher'),
      'Coordinación no debe ver conmutador de las otras 4 sucursales'
    );
    for (const forbiddenHub of ['valencia', 'centro', 'oriente', 'capital']) {
      assert.ok(
        !coordinatorHtml.includes(`hub-module-tab-${forbiddenHub}`),
        `Coordinación Zulia no debe ver pestaña ${forbiddenHub}`
      );
    }

    const superAdminHtml = renderToStaticMarkup(
      <SucursalPersonalModule
        viewerIamRole="super_admin"
        selectedSucursal="VALENCIA"
        initialBundle={{
          sucursal: 'VALENCIA',
          region_id: '11111111-1111-4111-8111-111111111102',
          staff: [],
          clientes: [],
          cadenas: [],
          profiles: [],
          portal_accesos: [],
        }}
      />
    );

    assert.match(superAdminHtml, /data-testid="sucursal-modules-switcher"/);
    for (const [slug, title] of [
      ['zulia', 'Módulo Personal Zulia'],
      ['valencia', 'Módulo Personal Valencia'],
      ['centro', 'Módulo Personal Centro'],
      ['oriente', 'Módulo Personal Oriente'],
      ['capital', 'Módulo Personal Capital'],
    ] as const) {
      assert.match(superAdminHtml, new RegExp(`data-testid="hub-module-tab-${slug}"`));
      assert.ok(superAdminHtml.includes(title), `super_admin debe ver ${title}`);
    }
    assert.match(superAdminHtml, /data-testid="cliente-portal-accesos-valencia"/);
  });

  await t.test('e) ClientePortalAccesosManager: renderiza clientes, PDVs/cadenas regionales y accesos activos/revocados sin mezcla', () => {
    const userOrienteId = '22222222-2222-4222-8222-222222222201';
    const pdvOrienteId = '33333333-3333-4333-8333-333333333301';
    const cadenaOrienteId = '44444444-4444-4444-8444-444444444401';

    const html = renderToStaticMarkup(
      <ClientePortalAccesosManager
        sucursal="ORIENTE"
        regionId="11111111-1111-4111-8111-111111111104"
        initialData={{
          clienteUsers: [
            {
              id: userOrienteId,
              email: 'compras.plc@cliente-oriente.com',
              full_name: 'Comprador Oriente PLC',
              role: 'cliente',
              sucursal: 'ORIENTE',
            },
            {
              id: '22222222-2222-4222-8222-222222222202',
              email: 'vendedor.oriente@codizulca.com',
              full_name: 'Vendedor Interno No Cliente',
              role: 'vendedor',
              sucursal: 'ORIENTE',
            },
            {
              id: '22222222-2222-4222-8222-222222222203',
              email: 'cliente.zulia@otro-hub.com',
              full_name: 'Cliente Otra Región Zulia',
              role: 'cliente',
              sucursal: 'ZULIA',
            },
          ],
          clientes: [
            {
              id: pdvOrienteId,
              codigo_cliente: 'ORI-101',
              nombre_comercial: 'AUTOMERCADO PUERTO LA CRUZ',
              activo: true,
              sucursal: 'ORIENTE',
            },
            {
              id: '33333333-3333-4333-8333-333333333399',
              codigo_cliente: 'CAP-999',
              nombre_comercial: 'AUTOMERCADO CARACAS FILTRADO',
              activo: true,
              sucursal: 'CAPITAL',
            },
          ],
          cadenas: [
            {
              id: cadenaOrienteId,
              codigo: 'CAD-ORI',
              nombre: 'RED SUPERMERCADOS ORIENTE',
              activo: true,
              sucursal: 'ORIENTE',
            },
          ],
          accesos: [
            {
              id: '55555555-5555-4555-8555-555555555501',
              user_id: userOrienteId,
              cliente_id: pdvOrienteId,
              cadena_id: null,
              activo: true,
              notas: 'Acceso auditado PDV PLC',
              sucursal: 'ORIENTE',
            },
            {
              id: '55555555-5555-4555-8555-555555555502',
              user_id: userOrienteId,
              cliente_id: null,
              cadena_id: cadenaOrienteId,
              activo: false,
              notas: 'Acceso cadena vencido',
              sucursal: 'ORIENTE',
            },
          ],
        }}
      />
    );

    assert.match(html, /data-testid="cliente-portal-accesos-oriente"/);
    assert.match(html, /1 activos \/ 2 total/);
    assert.ok(html.includes('Comprador Oriente PLC'));
    assert.ok(html.includes('compras.plc@cliente-oriente.com'));
    assert.ok(html.includes('AUTOMERCADO PUERTO LA CRUZ (ORI-101)'));
    assert.ok(html.includes('RED SUPERMERCADOS ORIENTE'));
    assert.ok(html.includes('Activo'));
    assert.ok(html.includes('Revocado'));
    assert.ok(html.includes('Revocar'));
    assert.ok(html.includes('Reactivar'));

    // Aislamiento estricto por rol y por sucursal
    assert.ok(!html.includes('Vendedor Interno No Cliente'));
    assert.ok(!html.includes('Cliente Otra Región Zulia'));
    assert.ok(!html.includes('AUTOMERCADO CARACAS FILTRADO'));
  });

  await t.test('f) IncidenciaQuickModal + cola offline codizulca_portal_offline_v1 + sellado regional .xlsx/.docx', async () => {
    const closedHtml = renderToStaticMarkup(
      <IncidenciaQuickModal isOpen={false} onClose={() => undefined} />
    );
    assert.equal(closedHtml, '');

    assert.deepEqual(SLA_HOURS_BY_SEVERIDAD, {
      BAJA: 72,
      MEDIA: 24,
      ALTA: 12,
      CRITICA: 4,
    });

    const openHtml = renderToStaticMarkup(
      <IncidenciaQuickModal
        isOpen={true}
        onClose={() => undefined}
        defaultPdvNombre="SUPERMERCADO FIORELLA"
        sucursal="ZULIA"
        defaultSeveridad="CRITICA"
      />
    );

    assert.match(openHtml, /data-testid="incidencia-quick-modal"/);
    assert.match(openHtml, /role="dialog"/);
    assert.match(openHtml, /aria-modal="true"/);
    for (const sev of ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'] as const) {
      assert.match(openHtml, new RegExp(`data-testid="severidad-btn-${sev}"`));
    }
    for (const sla of ['72h', '24h', '12h', '4h'] as const) {
      assert.ok(openHtml.includes(sla), `Debe renderizar SLA ${sla}`);
    }
    assert.match(openHtml, /SLA: 4h/);
    assert.match(openHtml, /id="incidencia-photo-input"/);
    assert.match(openHtml, /type="file"/);
    assert.match(openHtml, /accept="image\/jpeg,image\/png,image\/webp"/);

    // Verificación unitaria de enqueuePortalIncidenciaOffline (codizulca_portal_offline_v1)
    assert.equal(PORTAL_OFFLINE_IDB_NAME, 'codizulca_portal_offline_v1');
    clearMemoryPortalQueueForTests();
    try {
      const pngBase64 = encodeBinaryToBase64(VALID_1X1_PNG_BYTES);
      const queued = await enqueuePortalIncidenciaOffline({
        pdvNombre: 'SUPERMERCADO FIORELLA NORTE',
        tipoIncidencia: 'MATERIAL_POP_DANADO',
        severidad: 'ALTA',
        descripcion: 'Hablador de nevera fracturado en pasillo central',
        sucursal: 'ZULIA',
        reportadoPorNombre: 'María González',
        photoBase64: pngBase64,
        photoMimeType: 'image/png',
      });

      assert.equal(queued.kind, 'INCIDENCIA_PDV');
      assert.equal(queued.sucursal, 'ZULIA');
      assert.equal(queued.severidad, 'ALTA');
      assert.equal(queued.photoMimeType, 'image/png');

      const pending = await listPendingPortalActions();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.id, queued.id);

      // Bloqueo de SVG malicioso disfrazado de imagen en cola offline
      const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64');
      await assert.rejects(
        () =>
          enqueuePortalIncidenciaOffline({
            pdvNombre: 'SUPERMERCADO FIORELLA NORTE',
            tipoIncidencia: 'OTRO',
            severidad: 'BAJA',
            descripcion: 'Intento de adjuntar SVG bloqueado',
            photoBase64: svgBase64,
          }),
        /bloqueado por seguridad/i
      );
    } finally {
      clearMemoryPortalQueueForTests();
    }

    // Verificación de neutralizeFormulaInjection + estampado de región activa en .xlsx y .docx
    assert.equal(neutralizeFormulaInjection('=CMD|" /C calc"!A0'), '\'=CMD|" /C calc"!A0');
    assert.equal(neutralizeFormulaInjection('+SUM(A1:A5)'), "'+SUM(A1:A5)");
    assert.equal(neutralizeFormulaInjection('-2+5'), "'-2+5");
    assert.equal(neutralizeFormulaInjection('@HYPERLINK("http://x")'), '\'@HYPERLINK("http://x")');
    assert.equal(neutralizeFormulaInjection('\tcalc'), "'\tcalc");
    assert.equal(neutralizeFormulaInjection('Sucursal Zulia'), 'Sucursal Zulia');

    const xlsxBuf = await buildExecutiveWorkbookBuffer({
      title: 'Auditoría Regional de Incidencias',
      generatedBy: 'Contraloría CODIZULCA',
      generatedAtIso: '2026-11-19T12:00:00.000Z',
      regionLabel: 'Sucursal Zulia',
      sheets: [
        {
          name: 'Incidencias Zulia',
          headers: ['PDV', 'Observación'],
          rows: [['=HYPERLINK("https://evil.invalid")', '+1+1']],
        },
      ],
    });

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const rawArrayBuffer =
      xlsxBuf instanceof Uint8Array
        ? (xlsxBuf.buffer.slice(xlsxBuf.byteOffset, xlsxBuf.byteOffset + xlsxBuf.byteLength) as ArrayBuffer)
        : xlsxBuf;
    await wb.xlsx.load(rawArrayBuffer);
    const ws = wb.getWorksheet('Incidencias Zulia');
    assert.ok(ws, 'Debe existir la hoja Incidencias Zulia');
    assert.equal(ws!.getRow(3).getCell(1).value, 'Región / Sucursal Activa: Sucursal Zulia');
    assert.equal(ws!.getRow(5).getCell(1).value, '\'=HYPERLINK("https://evil.invalid")');
    assert.equal(ws!.getRow(5).getCell(2).value, "'+1+1");

    const docxBytes = await buildDocxReportBuffer({
      title: 'Informe Ejecutivo Regional',
      regionLabel: 'Sucursal Capital',
      metadata: [['Auditor', 'Dirección Nacional']],
      sections: [{ heading: '1. Cobertura', paragraphs: ['Sin desviaciones.'] }],
    });

    const JSZip = (await import('jszip')).default;
    const docxZip = await JSZip.loadAsync(docxBytes);
    const documentXml = await docxZip.file('word/document.xml')!.async('string');
    assert.ok(
      documentXml.includes('Región / Sucursal Activa: Sucursal Capital'),
      'El documento .docx debe estampar la Región / Sucursal Activa en portada'
    );
  });

  await t.test('f) v1.8.0: Alternancia default <-> control-room, cleanSync, AnimatedTabContainer (GPU + reduced-motion) y Co-Branding B2B en /cliente', () => {
    // 1. Preservación garantizada de `codizulca.ui_theme` en ambos cleanSync.ts
    assert.equal(UI_THEME_STORAGE_KEY, 'codizulca.ui_theme');
    assert.equal(isPreservedKey(UI_THEME_STORAGE_KEY), true);
    assert.equal(esClaveAuth(UI_THEME_STORAGE_KEY), true);

    // 2. Renderizado SSR de ControlRoomThemeToggle en Modo Día Ejecutivo vs Modo Sala de Control
    const dayToggleHtml = renderToStaticMarkup(
      <ThemeModeProvider initialMode="default">
        <ControlRoomThemeToggle />
      </ThemeModeProvider>
    );
    assert.match(dayToggleHtml, /data-testid="control-room-theme-toggle"/);
    assert.match(dayToggleHtml, /data-theme-state="default"/);
    assert.match(dayToggleHtml, /aria-pressed="false"/);
    assert.match(dayToggleHtml, /Día Ejecutivo/);

    const controlRoomToggleHtml = renderToStaticMarkup(
      <ThemeModeProvider initialMode="control-room">
        <ControlRoomThemeToggle />
      </ThemeModeProvider>
    );
    assert.match(controlRoomToggleHtml, /data-theme-state="control-room"/);
    assert.match(controlRoomToggleHtml, /aria-pressed="true"/);
    assert.match(controlRoomToggleHtml, /Sala de Control/);

    // 3. AnimatedTabContainer + SlidingTabRail (modo GPU vs prefers-reduced-motion)
    const gpuTabHtml = renderToStaticMarkup(
      <div>
        <SlidingTabRail
          ariaLabel="Pestañas prueba"
          activeTab="comparativo"
          onSelectTab={() => undefined}
          tabs={[
            { id: 'sucursal', label: 'Sucursal Activa' },
            { id: 'comparativo', label: 'Comparativo por Región' },
          ]}
        />
        <AnimatedTabContainer tabKey="comparativo" reducedMotion={false}>
          <p>Contenido GPU</p>
        </AnimatedTabContainer>
      </div>
    );
    assert.match(gpuTabHtml, /data-motion="gpu"/);
    assert.match(gpuTabHtml, /cz-tab-panel-enter/);
    assert.match(gpuTabHtml, /role="tablist"/);

    const reducedMotionHtml = renderToStaticMarkup(
      <AnimatedTabContainer tabKey="comparativo" reducedMotion={true}>
        <p>Contenido Accesible Sin Desplazamiento</p>
      </AnimatedTabContainer>
    );
    assert.match(reducedMotionHtml, /data-motion="reduced"/);
    assert.match(reducedMotionHtml, /cz-tab-panel-static/);
    assert.ok(!reducedMotionHtml.includes('cz-tab-panel-enter'));

    // 4. CadenaLogoUploaderModal con vista previa dual Día Ejecutivo + Sala de Control
    const uploaderHtml = renderToStaticMarkup(
      <CadenaLogoUploaderModal
        isOpen={true}
        inlineForSsr={true}
        cadena={{
          id: '71000000-0000-4000-8000-000000000005',
          codigo: 'CAD-CAPITAL',
          nombre: 'Excelsior Gama Capital',
          sucursal: 'CAPITAL',
          hasLogo: false,
        }}
        onClose={() => undefined}
      />
    );
    assert.match(uploaderHtml, /data-testid="cobrand-preview-default"/);
    assert.match(uploaderHtml, /data-testid="cobrand-preview-control-room"/);
    assert.match(uploaderHtml, /Excelsior Gama Capital/);

    // 5. Co-Branding en /cliente: CON logotipo válido (cápsula h-9 max-w-[160px]) vs SIN logotipo (monograma limpio)
    const validPngDataUri = `data:image/png;base64,${Buffer.from(VALID_1X1_PNG_BYTES).toString('base64')}`;
    assert.equal(isSafeLocalLogoSrc(validPngDataUri), true);
    assert.equal(isSafeLocalLogoSrc('blob:http://localhost:4188/abc-123'), true);
    assert.equal(isSafeLocalLogoSrc('https://evil.example.com/tracker.png'), false);
    assert.equal(isSafeLocalLogoSrc('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), false);
    assert.equal(computeCadenaInitials('Excelsior Gama Capital', 'CAD-CAP'), 'EG');

    const samplePortalData: ClientePortalResumen = {
      pdvs: [
        {
          id: '80000000-0000-4000-8000-000000000005',
          codigoCliente: 'CLI-CAP-001',
          nombreComercial: 'Excelsior Gama Chacao',
          cadenaId: '71000000-0000-4000-8000-000000000005',
          cadenaCodigo: 'CAD-CAPITAL',
          cadenaNombre: 'Excelsior Gama Capital',
          cadenaHasLogo: true,
          cadenaLogoMimeType: 'image/png',
          cadenaLogoUpdatedAt: '2026-11-19T12:00:00Z',
          ciudad: 'Caracas',
          estado: 'Distrito Capital',
          sucursal: 'CAPITAL',
        },
      ],
      cadenasBranding: [
        {
          id: '71000000-0000-4000-8000-000000000005',
          codigo: 'CAD-CAPITAL',
          nombre: 'Excelsior Gama Capital',
          tipoCanal: 'Supermercado',
          sucursal: 'CAPITAL',
          hasLogo: true,
          logoMimeType: 'image/png',
          logoUpdatedAt: '2026-11-19T12:00:00Z',
        },
      ],
      activaciones: [],
      kpis: {
        totalPdvs: 1,
        totalActivaciones: 0,
        completadas: 0,
        programadas: 0,
        muestras: 0,
        ventasAsistidas: 0,
        cumplimientoPct: 0,
      },
    };

    const withLogoHtml = renderToStaticMarkup(
      <ThemeModeProvider initialMode="control-room">
        <ClienteReadOnlyPortalView
          initialData={samplePortalData}
          initialLogoPreviewSrc={validPngDataUri}
        />
      </ThemeModeProvider>
    );
    assert.match(withLogoHtml, /data-testid="cliente-cobrand-logo-capsule"/);
    assert.match(withLogoHtml, /cz-cobrand-capsule h-9 max-w-\[160px\]/);
    assert.match(withLogoHtml, /data-testid="cliente-cobrand-secondary-img"/);
    assert.ok(!withLogoHtml.includes('data-testid="cliente-cobrand-typographic-badge"'));

    // Sin logotipo (o si alguien intentara pasar una URL externa maliciosa): cae limpiamente en insignia tipográfica
    const withoutLogoHtml = renderToStaticMarkup(
      <ThemeModeProvider initialMode="control-room">
        <ClienteReadOnlyPortalView
          initialData={{
            ...samplePortalData,
            cadenasBranding: [{ ...samplePortalData.cadenasBranding[0]!, hasLogo: false }],
          }}
          initialLogoPreviewSrc="https://external-attacker.invalid/logo.png"
        />
      </ThemeModeProvider>
    );
    assert.match(withoutLogoHtml, /data-testid="cliente-cobrand-typographic-badge"/);
    assert.match(withoutLogoHtml, />EG</);
    assert.match(withoutLogoHtml, /Excelsior Gama Capital/);
    assert.ok(!withoutLogoHtml.includes('external-attacker.invalid'));
    assert.ok(!withoutLogoHtml.includes('data-testid="cliente-cobrand-secondary-img"'));
  });
});
