import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MasterEntitiesSyncPanel } from '../src/components/masters/MasterEntitiesSyncPanel';
import { TradeAuthGate } from '../src/components/auth/TradeAuthGate';
import {
  canManageNationalProducts,
  canManageRegiones,
  canTriageQuarantinedRecords,
  hasAssignedRegionalScope,
} from '../src/utils/permissions';
import {
  purgeAllSessionCaches,
  registerMemoryCachePurgeCallback,
} from '../src/services/sessionCacheHygiene';
import {
  normalizeProductoMasterRow,
  normalizePromotoraMasterRow,
  normalizeRegionMasterRow,
  normalizeSupervisorMasterRow,
} from '../src/services/masterCatalogSyncService';
import type { VerifiedAuthProfile } from '../src/services/authService';
import type {
  ClienteConVendedor,
  ProductoMaestro,
  PromotoraMaestra,
  RegionMaestra,
  SupervisorMaestro,
} from '../src/types/masterData';

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'supabase/migrations/20261123000100_master_entities_sync_rls_fail_closed.sql'
);

const REGION_ZULIA_ID = '10000000-0000-4000-8000-000000000001';
const REGION_VALENCIA_ID = '10000000-0000-4000-8000-000000000002';

const SAMPLE_REGIONES: RegionMaestra[] = [
  {
    id: REGION_ZULIA_ID,
    codigo: 'ZULIA',
    nombre: 'Zulia',
    activo: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: REGION_VALENCIA_ID,
    codigo: 'VALENCIA',
    nombre: 'Valencia',
    activo: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const SAMPLE_PRODUCTOS: ProductoMaestro[] = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    codigo: 'PROD-AST-01',
    nombre: 'Mortadela Especial Asturias 0.900kg',
    categoria: 'Embutidos',
    marca: 'Asturias',
    unidad_medida: 'KG',
    activo: true,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    codigo: 'PROD-AST-02',
    nombre: 'Jamón Cocido Superior Asturias 2.5kg',
    categoria: 'Embutidos',
    marca: 'Asturias',
    unidad_medida: 'KG',
    activo: true,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const SAMPLE_SUPERVISORES: SupervisorMaestro[] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    codigo: 'SUP-ZUL-01',
    nombre: 'Supervisor Zulia Norte',
    email: 'sup.zulia@codizulca.com',
    telefono: '04141111111',
    zona: 'Maracaibo Norte',
    sucursal: 'ZULIA',
    region_id: REGION_ZULIA_ID,
    activo: true,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    codigo: 'SUP-VAL-01',
    nombre: 'Supervisor Valencia Centro',
    email: 'sup.valencia@codizulca.com',
    telefono: '04142222222',
    zona: 'Naguanagua',
    sucursal: 'VALENCIA',
    region_id: REGION_VALENCIA_ID,
    activo: true,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '30000000-0000-4000-8000-000000000003',
    codigo: 'SUP-LEG-99',
    nombre: 'Supervisor Histórico Ambiguo',
    email: 'sup.ambiguo@codizulca.com',
    telefono: null,
    zona: 'Av. Bolívar',
    sucursal: null,
    region_id: null,
    activo: true,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const SAMPLE_PROMOTORAS: PromotoraMaestra[] = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    nombre_completo: 'María González (Zulia)',
    email: 'maria.zulia@codizulca.com',
    telefono: '04143333333',
    ciudad: 'Maracaibo',
    estado: 'Zulia',
    direccion: 'Av. 5 de Julio',
    sucursal: 'ZULIA',
    region_id: REGION_ZULIA_ID,
    supervisor_id: SAMPLE_SUPERVISORES[0]!.id,
    activo: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000002',
    nombre_completo: 'Carla Méndez (Valencia)',
    email: 'carla.valencia@codizulca.com',
    telefono: '04144444444',
    ciudad: 'Valencia',
    estado: 'Carabobo',
    direccion: 'Av. Universidad',
    sucursal: 'VALENCIA',
    region_id: REGION_VALENCIA_ID,
    supervisor_id: SAMPLE_SUPERVISORES[1]!.id,
    activo: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '40000000-0000-4000-8000-000000000003',
    nombre_completo: 'Promotora Legacy Sin Región',
    email: 'prom.cuarentena@codizulca.com',
    telefono: null,
    ciudad: null,
    estado: null,
    direccion: 'Sin dirección',
    sucursal: null,
    region_id: null,
    supervisor_id: null,
    activo: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const SAMPLE_CLIENTES: ClienteConVendedor[] = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    codigo_cliente: 'ZUL-001',
    rif: 'J-30111222-1',
    razon_social: 'HIPERMERCADO MARACAIBO NORTE C.A.',
    nombre_comercial: 'HIPERMERCADO MARACAIBO NORTE',
    canal: 'Supermercado',
    segmento: 'A',
    zona: 'Maracaibo Norte',
    ruta: 'R01',
    direccion: 'Av. 5 de Julio, Maracaibo',
    ciudad: 'Maracaibo',
    estado: 'Zulia',
    telefono: null,
    latitud: null,
    longitud: null,
    sucursal: 'ZULIA',
    region_id: REGION_ZULIA_ID,
    vendedor_id: null,
    codigo_vendedor: null,
    activo: true,
    metadata: {},
    ultima_sincronizacion: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    codigo_cliente: 'VAL-014',
    rif: 'J-30222333-2',
    razon_social: 'AUTOMERCADO NAGUANAGUA CENTRAL C.A.',
    nombre_comercial: 'AUTOMERCADO NAGUANAGUA CENTRAL',
    canal: 'Supermercado',
    segmento: 'A',
    zona: 'Naguanagua',
    ruta: 'R14',
    direccion: 'Av. Universidad, Valencia',
    ciudad: 'Valencia',
    estado: 'Carabobo',
    telefono: null,
    latitud: null,
    longitud: null,
    sucursal: 'VALENCIA',
    region_id: REGION_VALENCIA_ID,
    vendedor_id: null,
    codigo_vendedor: null,
    activo: true,
    metadata: {},
    ultima_sincronizacion: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '50000000-0000-4000-8000-000000000003',
    codigo_cliente: 'LEG-999',
    rif: 'J-30999888-9',
    razon_social: 'COMERCIAL HISTÓRICO AMBIGUO C.A.',
    nombre_comercial: 'COMERCIAL HISTÓRICO SIN REGIÓN',
    canal: 'Mayorista',
    segmento: null,
    zona: 'Centro',
    ruta: null,
    direccion: 'Dirección ambigua histórica',
    ciudad: null,
    estado: null,
    telefono: null,
    latitud: null,
    longitud: null,
    sucursal: null,
    region_id: null,
    vendedor_id: null,
    codigo_vendedor: null,
    activo: true,
    metadata: {},
    ultima_sincronizacion: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

test('SQL Invariantes · 20261123000100 opera sobre instancias existentes sin CREATE TABLE, con fail-closed, anti-cruce y Realtime', () => {
  assert.equal(fs.existsSync(MIGRATION_PATH), true, 'Debe existir la migración 20261123000100');
  const rawSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const executableSql = rawSql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');

  // Cero creación de tablas nuevas (usa las instancias ya existentes en apaxdgxtaoeyswlfblgi)
  assert.ok(!/\bCREATE\s+TABLE\b/i.test(executableSql), 'NO debe crear tablas nuevas');
  // Cero DISABLE RLS, cero políticas TO anon, cero secretos, cero user_metadata
  assert.ok(!/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(executableSql), 'PROHIBIDO deshabilitar RLS');
  assert.ok(!/CREATE\s+POLICY[\s\S]{0,200}\bTO\s+anon\b/i.test(executableSql), 'PROHIBIDO abrir a anon');
  assert.ok(!/raw_user_meta_data\s*->>/i.test(executableSql), 'PROHIBIDO leer raw_user_meta_data');
  assert.ok(!/encrypted_password|crypt\(|gen_salt\(/i.test(executableSql), 'PROHIBIDO quemar contraseñas');

  // Funciones canónicas SECURITY DEFINER con search_path = public, auth
  assert.match(executableSql, /CREATE OR REPLACE FUNCTION public\.is_super_admin\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = public, auth/);
  assert.match(executableSql, /v_auth_email <> 'admin@codizulca\.com'/);
  assert.match(executableSql, /CREATE OR REPLACE FUNCTION public\.current_user_region_id\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = public, auth/);
  assert.match(executableSql, /REVOKE ALL ON FUNCTION public\.current_user_region_id\(\) FROM PUBLIC, anon/);

  // Triggers obligatorios: anti-escalamiento en profiles, BEFORE INSERT region_id, anti-cruce regional
  assert.match(executableSql, /CREATE TRIGGER trg_guard_profiles_self_escalation/);
  assert.match(executableSql, /CREATE OR REPLACE FUNCTION public\.fn_enforce_master_region_before_write\(\)/);
  assert.match(executableSql, /CROSS_REGION_LINK_FORBIDDEN/);
  assert.match(executableSql, /REGION_CONTEXT_REQUIRED/);

  // Políticas RLS exactas en productos (nacional) y regiones (aislada) y 3 maestras regionales
  assert.match(executableSql, /CREATE POLICY productos_select_national_catalog[\s\S]*public\.is_super_admin\(\)[\s\S]*public\.current_user_region_id\(\)\)\s+IS NOT NULL/);
  assert.match(executableSql, /CREATE POLICY productos_insert_super_admin[\s\S]*public\.is_super_admin\(\)/);
  assert.match(executableSql, /CREATE POLICY regiones_select_isolated[\s\S]*id = \(SELECT public\.current_user_region_id\(\)\)/);
  assert.match(executableSql, /_select_region_strict/);
  assert.match(executableSql, /_delete_super_admin_only/);

  // Publicación Realtime nativa de las 5 entidades maestras
  assert.match(executableSql, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.%I/);
  assert.match(executableSql, /'regiones'[\s\S]*'supervisores'[\s\S]*'promotoras'[\s\S]*'clientes'[\s\S]*'productos'/);
});

test('Escenario Adversario 1 (Coordinadora Zulia) · Solo ve Zulia + productos en solo lectura; 0 filas de Valencia y 0 filas en cuarentena', () => {
  const zuliaProfile = {
    iamRole: 'coordinacion' as const,
    sucursal: 'ZULIA' as const,
    regionId: REGION_ZULIA_ID,
  };
  assert.equal(hasAssignedRegionalScope(zuliaProfile), true);
  assert.equal(canManageNationalProducts(zuliaProfile), false);
  assert.equal(canManageRegiones(zuliaProfile), false);
  assert.equal(canTriageQuarantinedRecords(zuliaProfile), false);

  // 1a. Pestaña Productos (Catálogo Nacional Compartido en Solo Lectura)
  const prodHtml = renderToStaticMarkup(
    <MasterEntitiesSyncPanel
      qaOverride={{
        iamRole: 'coordinacion',
        sucursal: 'ZULIA',
        regionId: REGION_ZULIA_ID,
        regiones: SAMPLE_REGIONES,
        productos: SAMPLE_PRODUCTOS,
        supervisores: SAMPLE_SUPERVISORES,
        promotoras: SAMPLE_PROMOTORAS,
        clientes: SAMPLE_CLIENTES,
        initialTab: 'productos',
      }}
    />
  );
  assert.match(prodHtml, /data-testid="master-locked-region-badge"/);
  assert.match(prodHtml, /Sucursal Zulia/);
  assert.match(prodHtml, /data-testid="productos-readonly-badge"/);
  assert.match(prodHtml, /Mortadela Especial Asturias 0\.900kg/);
  assert.match(prodHtml, /Jamón Cocido Superior Asturias 2\.5kg/);
  // Controles de edición de productos y selector global completamente desmontados del DOM
  assert.ok(!prodHtml.includes('btn-nuevo-producto'), 'Coordinadora NO debe ver botón crear producto');
  assert.ok(!prodHtml.includes('btn-edit-producto-'), 'Coordinadora NO debe ver botón editar producto');
  assert.ok(!prodHtml.includes('btn-toggle-producto-'), 'Coordinadora NO debe ver botón desactivar producto');
  assert.ok(!prodHtml.includes('master-scope-select'), 'Coordinadora NO debe ver selector de otras regiones');
  assert.ok(!prodHtml.includes('master-quarantine-badge'), 'Coordinadora NO debe ver cuarentena');

  // 1b. Pestaña Clientes: solo Zulia, 0 Valencia, 0 cuarentena
  const cliHtml = renderToStaticMarkup(
    <MasterEntitiesSyncPanel
      qaOverride={{
        iamRole: 'coordinacion',
        sucursal: 'ZULIA',
        regionId: REGION_ZULIA_ID,
        regiones: SAMPLE_REGIONES,
        productos: SAMPLE_PRODUCTOS,
        supervisores: SAMPLE_SUPERVISORES,
        promotoras: SAMPLE_PROMOTORAS,
        clientes: SAMPLE_CLIENTES,
        initialTab: 'clientes',
      }}
    />
  );
  assert.match(cliHtml, /HIPERMERCADO MARACAIBO NORTE/);
  assert.ok(!cliHtml.includes('AUTOMERCADO NAGUANAGUA CENTRAL'), 'Zulia JAMÁS debe ver clientes de Valencia');
  assert.ok(!cliHtml.includes('COMERCIAL HISTÓRICO SIN REGIÓN'), 'Zulia JAMÁS debe ver clientes en cuarentena NULL');
});

test('Escenario Adversario 2 (Otra Sucursal: Valencia) · Solo ve Valencia + productos solo lectura; 0 filas de Zulia ni cuarentena', () => {
  const cliHtml = renderToStaticMarkup(
    <MasterEntitiesSyncPanel
      qaOverride={{
        iamRole: 'coordinacion',
        sucursal: 'VALENCIA',
        regionId: REGION_VALENCIA_ID,
        regiones: SAMPLE_REGIONES,
        productos: SAMPLE_PRODUCTOS,
        supervisores: SAMPLE_SUPERVISORES,
        promotoras: SAMPLE_PROMOTORAS,
        clientes: SAMPLE_CLIENTES,
        initialTab: 'clientes',
      }}
    />
  );
  assert.match(cliHtml, /Sucursal Valencia/);
  assert.match(cliHtml, /AUTOMERCADO NAGUANAGUA CENTRAL/);
  assert.ok(!cliHtml.includes('HIPERMERCADO MARACAIBO NORTE'), 'Valencia JAMÁS debe ver clientes de Zulia');
  assert.ok(!cliHtml.includes('COMERCIAL HISTÓRICO SIN REGIÓN'), 'Valencia JAMÁS debe ver cuarentena');

  const promHtml = renderToStaticMarkup(
    <MasterEntitiesSyncPanel
      qaOverride={{
        iamRole: 'coordinacion',
        sucursal: 'VALENCIA',
        regionId: REGION_VALENCIA_ID,
        regiones: SAMPLE_REGIONES,
        productos: SAMPLE_PRODUCTOS,
        supervisores: SAMPLE_SUPERVISORES,
        promotoras: SAMPLE_PROMOTORAS,
        clientes: SAMPLE_CLIENTES,
        initialTab: 'promotoras',
      }}
    />
  );
  assert.match(promHtml, /Carla Méndez \(Valencia\)/);
  assert.ok(!promHtml.includes('María González (Zulia)'), 'Valencia JAMÁS debe ver promotoras de Zulia');
  assert.ok(!promHtml.includes('Promotora Legacy Sin Región'), 'Valencia JAMÁS debe ver promotoras en cuarentena');
});

test('Escenario Adversario 3 (Usuario Regional sin region_id) · Pantalla segura Fail-Closed con 0 datos expuestos', () => {
  const unassignedProfile: VerifiedAuthProfile = {
    userId: '66666666-6666-4666-8666-666666666666',
    email: 'nueva.coord@codizulca.com',
    displayName: 'Coordinadora Pendiente',
    appRole: 'coordinadora',
    iamRole: 'coordinacion',
    sucursal: null,
    regionId: null,
    rawAppRole: 'coordinacion',
    legacyRole: 'jefe_trade',
    staffId: null,
    isCoordinatorOrAdmin: true,
    canAccessTorreControl: true,
    mustChangePassword: false,
  };

  assert.equal(hasAssignedRegionalScope(unassignedProfile), false);

  let childrenRendered = false;
  const gateHtml = renderToStaticMarkup(
    <TradeAuthGate initialProfileForQa={unassignedProfile}>
      {() => {
        childrenRendered = true;
        return <div data-testid="secret-dashboard-data">DATOS CONFIDENCIALES</div>;
      }}
    </TradeAuthGate>
  );

  assert.equal(childrenRendered, false, 'NO debe montar hijos ni disparar consultas si falta region_id');
  assert.match(gateHtml, /data-testid="unassigned-region-screen"/);
  assert.match(gateHtml, /Sin Región Asignada/);
  assert.ok(!gateHtml.includes('DATOS CONFIDENCIALES'));
});

test('Escenario Adversario 4 (admin@codizulca.com) · Acceso global, Todas las Regiones, Cuarentena y CRUD productos', () => {
  const adminProfile = {
    iamRole: 'super_admin' as const,
    sucursal: 'GLOBAL' as const,
    regionId: null,
  };
  assert.equal(hasAssignedRegionalScope(adminProfile), true);
  assert.equal(canManageNationalProducts(adminProfile), true);
  assert.equal(canManageRegiones(adminProfile), true);
  assert.equal(canTriageQuarantinedRecords(adminProfile), true);

  const adminProdHtml = renderToStaticMarkup(
    <MasterEntitiesSyncPanel
      qaOverride={{
        iamRole: 'super_admin',
        userEmail: 'admin@codizulca.com',
        sucursal: 'GLOBAL',
        regiones: SAMPLE_REGIONES,
        productos: SAMPLE_PRODUCTOS,
        supervisores: SAMPLE_SUPERVISORES,
        promotoras: SAMPLE_PROMOTORAS,
        clientes: SAMPLE_CLIENTES,
        isRealtimeConnected: true,
        initialTab: 'productos',
        initialScope: 'ALL',
      }}
    />
  );
  assert.match(adminProdHtml, /data-testid="master-scope-select"/);
  assert.match(adminProdHtml, /Todas las Regiones/);
  assert.match(adminProdHtml, /Sin Región Asignada \(3\)/);
  assert.match(adminProdHtml, /data-testid="master-quarantine-badge"/);
  assert.match(adminProdHtml, /data-testid="btn-nuevo-producto"/);
  assert.match(adminProdHtml, /data-testid="btn-edit-producto-20000000-0000-4000-8000-000000000001"/);
  assert.match(adminProdHtml, /Realtime Activo/);

  // Vista Cuarentena (`UNASSIGNED`) en Clientes: muestra registro con region_id = NULL y botón Asignar
  const adminQuarantineHtml = renderToStaticMarkup(
    <MasterEntitiesSyncPanel
      qaOverride={{
        iamRole: 'super_admin',
        userEmail: 'admin@codizulca.com',
        sucursal: 'GLOBAL',
        regiones: SAMPLE_REGIONES,
        productos: SAMPLE_PRODUCTOS,
        supervisores: SAMPLE_SUPERVISORES,
        promotoras: SAMPLE_PROMOTORAS,
        clientes: SAMPLE_CLIENTES,
        initialTab: 'clientes',
        initialScope: 'UNASSIGNED',
      }}
    />
  );
  assert.match(adminQuarantineHtml, /COMERCIAL HISTÓRICO SIN REGIÓN/);
  assert.match(adminQuarantineHtml, /data-testid="btn-assign-region-cliente-50000000-0000-4000-8000-000000000003"/);
  assert.ok(!adminQuarantineHtml.includes('HIPERMERCADO MARACAIBO NORTE'));
});

test('Escenario Adversario 5 (Higiene Total de Caché + Normalizadores Adaptativos) · Purga memoria, Web Storage e IndexedDB preservando tema', async () => {
  let memoryPurged = false;
  const unregister = registerMemoryCachePurgeCallback(() => {
    memoryPurged = true;
  });

  const mockLocal = createMemoryStorage({
    'codizulca.ui_theme': 'control-room',
    'app_clean_sync_version': 'production-v1',
    'codizulca.supabase.auth.v1': '{"access_token":"jwt-session"}',
    'codizulca.ruta.profile.v1': '{"sucursal":"ZULIA"}',
    'codizulca_trade_cache_zulia': 'sensitive-data',
  });
  const mockSession = createMemoryStorage({
    'rutadegustacion:v1:modo': 'oficina',
    'temp_filter': 'zulia',
  });
  const deletedDbs: string[] = [];
  const mockIdb = {
    deleteDatabase(name: string) {
      deletedDbs.push(name);
      const req = { onsuccess: null as null | (() => void), onerror: null, onblocked: null };
      queueMicrotask(() => req.onsuccess?.());
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  try {
    // 1. Cambio de región: purga cachés de datos e IndexedDB pero preserva token Auth y tema visual
    const regionReport = await purgeAllSessionCaches({
      reason: 'region_switch',
      preserveAuthSession: true,
      localStorageImpl: mockLocal,
      sessionStorageImpl: mockSession,
      indexedDbImpl: mockIdb,
    });
    assert.equal(memoryPurged, true);
    assert.equal(regionReport.sessionStorageCleared, true);
    assert.equal(mockLocal.getItem('codizulca.ui_theme'), 'control-room');
    assert.ok(mockLocal.getItem('codizulca.supabase.auth.v1'), 'region_switch conserva sesión Auth');
    assert.equal(mockLocal.getItem('codizulca_trade_cache_zulia'), null);
    assert.equal(mockLocal.getItem('codizulca.ruta.profile.v1'), null);
    assert.ok(deletedDbs.includes('codizulca_portal_offline_v1'));
    assert.ok(deletedDbs.includes('rutadegustacion-offline'));

    // 2. Cierre de sesión: purga también el token Auth y conserva únicamente el tema visual
    const signOutReport = await purgeAllSessionCaches({
      reason: 'sign_out',
      preserveAuthSession: false,
      localStorageImpl: mockLocal,
      sessionStorageImpl: mockSession,
      indexedDbImpl: mockIdb,
    });
    assert.equal(signOutReport.reason, 'sign_out');
    assert.equal(mockLocal.getItem('codizulca.supabase.auth.v1'), null, 'sign_out purga token Auth');
    assert.equal(mockLocal.getItem('codizulca.ui_theme'), 'control-room', 'conserva tema dark');

    // 3. Normalizadores adaptativos de columnas existentes en apaxdgxtaoeyswlfblgi
    assert.equal(
      normalizeProductoMasterRow({ id: 'p1', sku: 'sku-09', descripcion: 'Chorizo Ahumado', unidad: 'kg' }).codigo,
      'SKU-09'
    );
    assert.equal(
      normalizeSupervisorMasterRow({ id: 's1', nombre_completo: 'Ana Pérez', correo: 'ANA@CODIZULCA.COM' }).email,
      'ana@codizulca.com'
    );
    assert.equal(
      normalizePromotoraMasterRow({ id: 'pr1', nombre: 'Lucía Rivas', correo: 'LUCIA@CODIZULCA.COM' }).nombre_completo,
      'Lucía Rivas'
    );
    assert.equal(
      normalizeRegionMasterRow({ id: 'r1', codigo: 'zulia', nombre: 'Zulia' }).codigo,
      'ZULIA'
    );
  } finally {
    unregister();
  }
});
