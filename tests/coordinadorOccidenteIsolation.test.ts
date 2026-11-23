import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  COORDINADORA_EMAIL,
  COORDINADORA_REGION,
  COORDINADORA_ROLE,
  COORDINADORA_SCOPE,
  COORDINADORA_SUCURSAL,
  buildCoordinadoraAuthPayload,
  buildCoordinadoraProfilePayload,
  readCoordinadoraSeedEnv,
} from '../scripts/seed-coordinadora-occidente.mjs';
import {
  normalizeManagedUserRole,
  normalizeSucursalCodigo,
} from '../src/services/userManagementService';
import { extractVerifiedProfileFromAuthUser } from '../src/services/authService';
import {
  createMasterDataErpHandlers,
  type MasterDataErpGateway,
  type MasterDataErpSnapshot,
} from '../src/server/masterDataErpHandler';
import {
  createPromotorasHandlers,
  type PromotorasGateway,
} from '../src/server/promotorasHandler';
import type { AuthenticatedServerUser } from '../src/server/supabaseAdminAuth';

const OCCIDENTE_UUID = '11111111-1111-4111-8111-111111111111';
const CENTRO_UUID = '22222222-2222-4222-8222-222222222222';
const ANDES_UUID = '33333333-3333-4333-8333-333333333333';

function createMockRes() {
  const state = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
  };
  const res = {
    setHeader(key: string, value: string) {
      state.headers[key.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  } as unknown as Response;

  return { res, state };
}

function buildGreciaActor(): AuthenticatedServerUser {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: COORDINADORA_EMAIL,
    appRole: 'coordinacion',
    sucursal: 'ZULIA',
    activeSucursalHeader: 'ZULIA',
    isSuperAdmin: false,
    isCoordinatorOrAdmin: true,
    accessToken: 'jwt-test-token-grecia-occidente-000001',
  };
}

function buildGlobalAdminActor(): AuthenticatedServerUser {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    email: 'admin@codizulca.com',
    appRole: 'super_admin',
    sucursal: 'GLOBAL',
    activeSucursalHeader: null,
    isSuperAdmin: true,
    isCoordinatorOrAdmin: true,
    accessToken: 'jwt-test-token-admin-global-000001',
  };
}

function buildFixtureMasterSnapshot(): MasterDataErpSnapshot {
  return {
    source: 'supabase_erp_clientes',
    fetchedAtMs: Date.now(),
    regiones: [
      { id: OCCIDENTE_UUID, codigo: 'OCCIDENTE', nombre: 'Occidente', activo: true, created_at: '', updated_at: '' },
      { id: CENTRO_UUID, codigo: 'CENTRO', nombre: 'Centro / Valencia', activo: true, created_at: '', updated_at: '' },
      { id: ANDES_UUID, codigo: 'ANDES', nombre: 'Andes', activo: true, created_at: '', updated_at: '' },
    ],
    productos: [
      {
        id: 'prod-1',
        codigo: 'AST-01',
        nombre: 'Mortadela Asturias 1Kg',
        categoria: 'Embutidos',
        marca: 'ASTURIAS',
        unidad_medida: 'KG',
        activo: true,
        created_at: '',
        updated_at: '',
        metadata: {},
      },
    ],
    clientes: [
      {
        id: 'cli-occ-1',
        codigo_cliente: 'OCC-001',
        rif: 'J-10000001-1',
        razon_social: 'SUPERMERCADO MARACAIBO CA',
        nombre_comercial: 'SUPER MARACAIBO',
        canal: 'Supermercado',
        segmento: null,
        zona: 'ZULIA',
        ruta: 'R1',
        direccion: 'Maracaibo',
        ciudad: 'Maracaibo',
        estado: 'ZULIA',
        telefono: null,
        latitud: 10.65,
        longitud: -71.63,
        region_id: OCCIDENTE_UUID,
        sucursal: 'ZULIA',
        vendedor_id: 'vend-occ-1',
        codigo_vendedor: 'V-OCC-1',
        activo: true,
        metadata: { region_codigo: 'OCCIDENTE' },
        ultima_sincronizacion: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'cli-val-1',
        codigo_cliente: 'VAL-001',
        rif: 'J-20000002-2',
        razon_social: 'AUTOMERCADO VALENCIA CA',
        nombre_comercial: 'AUTO VALENCIA',
        canal: 'Supermercado',
        segmento: null,
        zona: 'CARABOBO',
        ruta: 'R2',
        direccion: 'Valencia',
        ciudad: 'Valencia',
        estado: 'CARABOBO',
        telefono: null,
        latitud: 10.18,
        longitud: -68.0,
        region_id: CENTRO_UUID,
        sucursal: 'VALENCIA',
        vendedor_id: 'vend-val-1',
        codigo_vendedor: 'V-VAL-1',
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        ultima_sincronizacion: null,
        created_at: '',
        updated_at: '',
      },
    ],
    vendedores: [
      {
        id: 'vend-occ-1',
        codigo_vendedor: 'V-OCC-1',
        nombre_completo: 'Vendedor Occidente',
        documento_identidad: null,
        telefono: null,
        email: null,
        zona: 'ZULIA',
        supervisor: 'Sup Occidente',
        sucursal: 'ZULIA',
        region_id: OCCIDENTE_UUID,
        activo: true,
        metadata: { region_codigo: 'OCCIDENTE' },
        ultima_sincronizacion: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'vend-val-1',
        codigo_vendedor: 'V-VAL-1',
        nombre_completo: 'Vendedor Valencia',
        documento_identidad: null,
        telefono: null,
        email: null,
        zona: 'CARABOBO',
        supervisor: 'Sup Valencia',
        sucursal: 'VALENCIA',
        region_id: CENTRO_UUID,
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        ultima_sincronizacion: null,
        created_at: '',
        updated_at: '',
      },
    ],
    supervisores: [
      {
        id: 'sup-occ-1',
        codigo: 'SO-1',
        nombre: 'Supervisor Occidente',
        email: null,
        telefono: null,
        zona: 'ZULIA',
        activo: true,
        sucursal: 'ZULIA',
        region_id: OCCIDENTE_UUID,
        metadata: { region_codigo: 'OCCIDENTE' },
        created_at: '',
        updated_at: '',
      },
      {
        id: 'sup-val-1',
        codigo: 'SV-1',
        nombre: 'Supervisor Valencia',
        email: null,
        telefono: null,
        zona: 'CARABOBO',
        activo: true,
        sucursal: 'VALENCIA',
        region_id: CENTRO_UUID,
        metadata: { region_codigo: 'CENTRO' },
        created_at: '',
        updated_at: '',
      },
    ],
    promotoras: [
      {
        id: '1',
        nombre_completo: 'Nicole Godoy',
        email: 'godoyaraujonicole@gmail.com',
        telefono: '0412-4392024',
        ciudad: 'Coro',
        estado: 'FALCON',
        direccion: 'Coro',
        region: 'Occidente',
        sucursal: 'ZULIA',
        region_id: OCCIDENTE_UUID,
        supervisor_id: null,
        categoria: 'Fijas',
        activo: true,
        metadata: { region_codigo: 'OCCIDENTE' },
        created_at: '',
        updated_at: '',
      },
      {
        id: '25',
        nombre_completo: 'Paola Maldonado',
        email: 'paolamaldonado1805@gmail.com',
        telefono: '0414-5816686',
        ciudad: 'Valencia',
        estado: 'CARABOBO',
        direccion: 'Los Guayos, Valencia',
        region: 'Valencia',
        sucursal: 'VALENCIA',
        region_id: CENTRO_UUID,
        supervisor_id: null,
        categoria: 'Fijas',
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        created_at: '',
        updated_at: '',
      },
    ],
    cadenas: [],
    zonas: [
      {
        id: 'zona-occ-1',
        codigo: 'Z-OCC',
        nombre: 'Zulia Norte',
        ciudad: 'Maracaibo',
        estado: 'ZULIA',
        sucursal: 'ZULIA',
        region_id: OCCIDENTE_UUID,
        activo: true,
        metadata: { region_codigo: 'OCCIDENTE' },
        created_at: '',
        updated_at: '',
      },
      {
        id: 'zona-val-1',
        codigo: 'Z-VAL',
        nombre: 'Carabobo Valencia',
        ciudad: 'Valencia',
        estado: 'CARABOBO',
        sucursal: 'VALENCIA',
        region_id: CENTRO_UUID,
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        created_at: '',
        updated_at: '',
      },
    ],
    sedesResumen: [
      { sucursal: 'ZULIA', total: 1, activos: 1, inactivos: 0, vendedoresActivos: 1, zonas: ['ZULIA'] },
      { sucursal: 'VALENCIA', total: 1, activos: 1, inactivos: 0, vendedoresActivos: 1, zonas: ['CARABOBO'] },
    ],
    resumenRegional: [
      {
        region: 'OCCIDENTE',
        regionId: OCCIDENTE_UUID,
        regiSaba: true,
        priority: 1,
        clientesTotal: 1,
        clientesActivos: 1,
        clientesConGps: 1,
        promotoras: 1,
        supervisores: 1,
        vendedores: 1,
        cadenas: 0,
        zonas: 1,
      },
      {
        region: 'CENTRO',
        regionId: CENTRO_UUID,
        regiSaba: false,
        priority: 2,
        clientesTotal: 1,
        clientesActivos: 1,
        clientesConGps: 1,
        promotoras: 1,
        supervisores: 1,
        vendedores: 1,
        cadenas: 0,
        zonas: 1,
      },
    ],
    vendedoresAuditoria: {
      totalErpRaw: 2,
      activosRealesUnicos: 2,
      rutasComercialesActivas: 2,
      excluidosTotal: 0,
      consolidadosDuplicados: 0,
      excluidosPorMotivo: {
        INACTIVO: 0,
        SIN_CODIGO: 0,
        CUENTA_ADMINISTRATIVA_O_VACANTE: 0,
        SIN_SUPERVISOR: 0,
        EXCLUIDO_FORECAST_ERP: 0,
      },
      porSede: { ZULIA: 1, VALENCIA: 1, CENTRO: 0, ORIENTE: 0, CAPITAL: 0 },
    },
    countsExact: {
      regiones: 3,
      productos: 1,
      clientesTotal: 2,
      clientesActivos: 2,
      clientesConGps: 2,
      promotoras: 2,
      supervisores: 2,
      cadenas: 0,
      zonas: 2,
      vendedores: 2,
    },
  };
}

test('seed-coordinadora-occidente valida variables de entorno fail-fast y construye payloads sin secretos en metadata', () => {
  assert.throws(
    () => readCoordinadoraSeedEnv({ SUPABASE_URL: 'https://example.supabase.co' }),
    /SUPABASE_SERVICE_ROLE_KEY.*GRECIA_INITIAL_PASSWORD/
  );

  assert.throws(
    () =>
      readCoordinadoraSeedEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-key-placeholder',
        GRECIA_INITIAL_PASSWORD: 'short',
      }),
    /al menos 8 caracteres/
  );

  const authPayload = buildCoordinadoraAuthPayload({
    password: 'placeholder-only-for-unit-test',
    regionId: OCCIDENTE_UUID,
  });
  assert.equal(authPayload.email, COORDINADORA_EMAIL);
  assert.equal(authPayload.email_confirm, true);
  assert.equal(authPayload.app_metadata.role, COORDINADORA_ROLE);
  assert.equal(authPayload.app_metadata.region, COORDINADORA_REGION);
  assert.equal(authPayload.app_metadata.sucursal, COORDINADORA_SUCURSAL);
  assert.equal(authPayload.app_metadata.scope, COORDINADORA_SCOPE);
  assert.equal(authPayload.app_metadata.region_id, OCCIDENTE_UUID);
  assert.equal(authPayload.user_metadata.nombre_completo, 'Grecia');
  assert.equal('role' in authPayload.user_metadata, false);
  assert.equal('region' in authPayload.user_metadata, false);

  const profilePayload = buildCoordinadoraProfilePayload({
    authUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    regionId: OCCIDENTE_UUID,
  });
  assert.equal(profilePayload.role, 'coordinador_trade');
  assert.equal(profilePayload.region, 'Occidente');
  assert.equal(profilePayload.sucursal, 'ZULIA');
  assert.equal(profilePayload.is_active, true);
});

test('authService y userManagementService reconocen coordinador_trade + Occidente e ignoran user_metadata manipulado', () => {
  assert.equal(normalizeManagedUserRole('coordinador_trade'), 'coordinacion');
  assert.equal(normalizeSucursalCodigo('Occidente'), 'ZULIA');
  assert.equal(normalizeSucursalCodigo('Región Occidente'), 'ZULIA');

  const profile = extractVerifiedProfileFromAuthUser({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'grecia01@codizulca.com',
    app_metadata: {
      role: 'coordinador_trade',
      region: 'Occidente',
      sucursal: 'ZULIA',
      region_id: OCCIDENTE_UUID,
      scope: 'regional',
    },
    // Intento malicioso simulado en user_metadata editable por cliente: DEBE ser ignorado
    user_metadata: {
      role: 'super_admin',
      app_role: 'super_admin',
      region: 'Valencia',
      sucursal: 'GLOBAL',
    },
  } as any);

  assert.ok(profile);
  assert.equal(profile.iamRole, 'coordinacion');
  assert.equal(profile.appRole, 'coordinadora');
  assert.equal(profile.sucursal, 'ZULIA');
  assert.equal(profile.regionLabel, 'Occidente');
  assert.equal(profile.regionId, OCCIDENTE_UUID);
  assert.equal(profile.canAccessTorreControl, true);
});

test('BFF /api/maestros aisla estrictamente a Grecia en OCCIDENTE y rechaza IDOR ?regionId=CENTRO con 403', async () => {
  const snapshot = buildFixtureMasterSnapshot();
  const gateway: MasterDataErpGateway = {
    async loadSnapshot() {
      return snapshot;
    },
  };
  const handlers = createMasterDataErpHandlers(gateway);

  // 1) Bootstrap para Grecia -> 0 registros de Valencia/Centro ni en data ni en resúmenes
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildGreciaActor(), query: {} } as unknown as Request;
    await handlers.handleBootstrapMaestros(req, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as any;
    assert.equal(body.region, 'OCCIDENTE');
    assert.deepEqual(
      body.data.regiones.map((r: any) => r.codigo),
      ['OCCIDENTE']
    );
    assert.deepEqual(
      body.data.clientes.map((c: any) => c.codigo_cliente),
      ['OCC-001']
    );
    assert.deepEqual(
      body.data.vendedores.map((v: any) => v.codigo_vendedor),
      ['V-OCC-1']
    );
    assert.deepEqual(
      body.data.promotoras.map((p: any) => p.nombre_completo),
      ['Nicole Godoy']
    );
    assert.deepEqual(
      body.data.zonas.map((z: any) => z.codigo),
      ['Z-OCC']
    );
    assert.deepEqual(
      body.resumenRegional.map((r: any) => r.region),
      ['OCCIDENTE']
    );
    assert.deepEqual(
      body.sedesResumen.map((s: any) => s.sucursal),
      ['ZULIA']
    );
    assert.equal(body.vendedoresAuditoria.porSede.ZULIA, 1);
    assert.equal(body.vendedoresAuditoria.porSede.VALENCIA, 0);
    assert.equal(body.vendedoresAuditoria.porSede.CENTRO, 0);
  }

  // 2) Ataque IDOR: Grecia intenta consultar ?regionId=<CENTRO_UUID> en clientes -> 403
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildGreciaActor(),
      query: { regionId: CENTRO_UUID },
    } as unknown as Request;
    await handlers.handleListClientesMaestros(req, res);
    assert.equal(state.statusCode, 403);
    assert.equal((state.body as any).code, 'FORBIDDEN_REGION_ACCESS');
  }

  // 3) Ataque IDOR: Grecia intenta consultar ?region=CENTRO en vendedores -> 403
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildGreciaActor(),
      query: { region: 'CENTRO' },
    } as unknown as Request;
    await handlers.handleListVendedoresMaestros(req, res);
    assert.equal(state.statusCode, 403);
    assert.equal((state.body as any).code, 'FORBIDDEN_REGION_ACCESS');
  }

  // 4) Admin Global conserva visibilidad total de OCCIDENTE, CENTRO y ANDES sin regresiones
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildGlobalAdminActor(), query: {} } as unknown as Request;
    await handlers.handleBootstrapMaestros(req, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as any;
    assert.equal(body.data.regiones.length, 3);
    assert.equal(body.data.clientes.length, 2);
    assert.equal(body.data.promotoras.length, 2);
  }
});

test('BFF /api/promotoras rechaza spoofing de cabecera x-sucursal-activa: VALENCIA y ?regionId=CENTRO', async () => {
  const gateway: PromotorasGateway = {
    async resolveRegionIdByCode(code) {
      return code === 'OCCIDENTE' ? OCCIDENTE_UUID : code === 'CENTRO' ? CENTRO_UUID : ANDES_UUID;
    },
    async listPromotoras() {
      return [
        {
          id: '11111111-0000-4000-8000-000000000001',
          nombre_completo: 'Nicole Godoy',
          email: 'godoyaraujonicole@gmail.com',
          telefono: '0412-4392024',
          ciudad: 'Coro',
          estado: 'FALCON',
          direccion: 'Coro',
          categoria: 'Fijas',
          activo: true,
          supervisor_id: null,
          region: 'Occidente',
          region_id: OCCIDENTE_UUID,
          sucursal: 'ZULIA',
        },
        {
          id: '22222222-0000-4000-8000-000000000002',
          nombre_completo: 'Paola Maldonado',
          email: 'paolamaldonado1805@gmail.com',
          telefono: '0414-5816686',
          ciudad: 'Valencia',
          estado: 'CARABOBO',
          direccion: 'Valencia',
          categoria: 'Fijas',
          activo: true,
          supervisor_id: null,
          region: 'Valencia',
          region_id: CENTRO_UUID,
          sucursal: 'VALENCIA',
        },
      ];
    },
    async getPromotoraById() {
      return null;
    },
    async createPromotora(payload) {
      return payload as any;
    },
    async updatePromotora(_id, payload) {
      return payload as any;
    },
  };

  const handlers = createPromotorasHandlers({ gatewayFactory: () => gateway });

  // 1) Spoofing de header `x-sucursal-activa: VALENCIA` por Grecia -> 403
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: { ...buildGreciaActor(), activeSucursalHeader: 'VALENCIA' },
      headers: { 'x-sucursal-activa': 'VALENCIA' },
      query: {},
    } as unknown as Request;
    await handlers.handleListPromotoras(req, res);
    assert.equal(state.statusCode, 403);
    assert.equal((state.body as any).code, 'FORBIDDEN_REGION_ACCESS');
  }

  // 2) IDOR `?regionId=CENTRO_UUID` por Grecia -> 403
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildGreciaActor(),
      headers: {},
      query: { regionId: CENTRO_UUID },
    } as unknown as Request;
    await handlers.handleListPromotoras(req, res);
    assert.equal(state.statusCode, 403);
    assert.equal((state.body as any).code, 'FORBIDDEN_REGION_ACCESS');
  }

  // 3) Consulta legítima de Grecia -> solo retorna Occidente
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildGreciaActor(),
      headers: {},
      query: {},
    } as unknown as Request;
    await handlers.handleListPromotoras(req, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as any;
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].nombre_completo, 'Nicole Godoy');
  }
});

test('Migración SQL y espejo SQL Editor cumplen reglas críticas de seguridad (cero user_metadata, cero DISABLE RLS)', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261201000100_rls_coordinador_occidente.sql'
  );
  const sqlEditorPath = path.resolve(process.cwd(), 'sql/rls_coordinador_occidente.sql');

  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  const mirrorSql = fs.readFileSync(sqlEditorPath, 'utf8');

  assert.equal(migrationSql, mirrorSql, 'El archivo en sql/ debe ser espejo exacto de la migración');
  assert.equal(/user_metadata/i.test(migrationSql), false, 'Prohibido usar user_metadata en RLS');
  assert.equal(
    /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(migrationSql),
    false,
    'Prohibido desactivar RLS'
  );
  assert.equal(
    /^\s*(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/im.test(migrationSql),
    false,
    'Prohibidas sentencias DDL/DML destructivas'
  );
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.current_user_role\(\)/);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.current_user_region\(\)/);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION public\.is_global_admin\(\)/);
  assert.match(migrationSql, /SECURITY DEFINER/);
  assert.match(migrationSql, /SET search_path = public/);
  assert.match(migrationSql, /AS RESTRICTIVE/);
  assert.match(migrationSql, /FROM pg_policies/);
});
