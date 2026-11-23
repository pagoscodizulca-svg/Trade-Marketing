import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Request, Response } from 'express';
import {
  MARIA_EMAIL,
  MARIA_REGIONS,
  MARIA_ROLE,
  MARIA_SCOPE,
  MARIA_PRIMARY_SUCURSAL,
  buildMariaAuthPayload,
  buildMariaProfilePayload,
  readMariaSeedEnv,
} from '../scripts/seed-coordinadora-centro-andes.mjs';
import { extractVerifiedProfileFromAuthUser } from '../src/services/authService';
import {
  createMasterDataErpHandlers,
  type MasterDataErpGateway,
  type MasterDataErpSnapshot,
} from '../src/server/masterDataErpHandler';
import {
  createPromotorasHandlers,
  type PromotorasGateway,
  type PromotoraServerRecord,
} from '../src/server/promotorasHandler';
import type { AuthenticatedServerUser } from '../src/server/supabaseAdminAuth';
import { RegionGateSelector } from '../src/components/region/RegionGateSelector';
import { MasterEntitiesSyncPanel } from '../src/components/masters/MasterEntitiesSyncPanel';

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

function buildMariaActor(activeHeader: string | null = null): AuthenticatedServerUser {
  return {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    email: MARIA_EMAIL,
    appRole: 'coordinacion',
    sucursal: 'CENTRO',
    allowedRegions: ['CENTRO', 'ANDES'],
    activeSucursalHeader: activeHeader as any,
    isSuperAdmin: false,
    isCoordinatorOrAdmin: true,
    accessToken: 'jwt-test-token-maria-centro-andes-000001',
  };
}

function buildGreciaActor(): AuthenticatedServerUser {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'grecia01@codizulca.com',
    appRole: 'coordinacion',
    sucursal: 'ZULIA',
    allowedRegions: ['OCCIDENTE'],
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
    allowedRegions: null,
    activeSucursalHeader: null,
    isSuperAdmin: true,
    isCoordinatorOrAdmin: true,
    accessToken: 'jwt-test-token-admin-global-000001',
  };
}

function buildThreeRegionMasterSnapshot(): MasterDataErpSnapshot {
  return {
    source: 'supabase_erp_clientes',
    fetchedAtMs: Date.now(),
    regiones: [
      { id: OCCIDENTE_UUID, codigo: 'OCCIDENTE', nombre: 'OCCIDENTE', activo: true, created_at: '', updated_at: '' },
      { id: CENTRO_UUID, codigo: 'CENTRO', nombre: 'CENTRO', activo: true, created_at: '', updated_at: '' },
      { id: ANDES_UUID, codigo: 'ANDES', nombre: 'ANDES', activo: true, created_at: '', updated_at: '' },
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
        razon_social: 'SUPERMERCADO MARACAIBO EXCLUSIVO CA',
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
        id: 'cli-cen-1',
        codigo_cliente: 'CEN-001',
        rif: 'J-20000002-2',
        razon_social: 'AUTOMERCADO VALENCIA CENTRO CA',
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
        sucursal: 'CENTRO',
        vendedor_id: 'vend-cen-1',
        codigo_vendedor: 'V-CEN-1',
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        ultima_sincronizacion: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'cli-and-1',
        codigo_cliente: 'AND-001',
        rif: 'J-30000003-3',
        razon_social: 'ABASTO MERIDA ANDES CA',
        nombre_comercial: 'ABASTO MERIDA',
        canal: 'Supermercado',
        segmento: null,
        zona: 'MERIDA',
        ruta: 'R3',
        direccion: 'Mérida',
        ciudad: 'Mérida',
        estado: 'MERIDA',
        telefono: null,
        latitud: 8.59,
        longitud: -71.14,
        region_id: ANDES_UUID,
        sucursal: null,
        vendedor_id: 'vend-and-1',
        codigo_vendedor: 'V-AND-1',
        activo: true,
        metadata: { region_codigo: 'ANDES' },
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
        id: 'vend-cen-1',
        codigo_vendedor: 'V-CEN-1',
        nombre_completo: 'Vendedor Centro Valencia',
        documento_identidad: null,
        telefono: null,
        email: null,
        zona: 'CARABOBO',
        supervisor: 'Sup Centro',
        sucursal: 'CENTRO',
        region_id: CENTRO_UUID,
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        ultima_sincronizacion: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'vend-and-1',
        codigo_vendedor: 'V-AND-1',
        nombre_completo: 'Vendedor Andes Merida',
        documento_identidad: null,
        telefono: null,
        email: null,
        zona: 'MERIDA',
        supervisor: 'Sup Andes',
        sucursal: null,
        region_id: ANDES_UUID,
        activo: true,
        metadata: { region_codigo: 'ANDES' },
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
        id: 'sup-cen-1',
        codigo: 'SC-1',
        nombre: 'Supervisor Centro',
        email: null,
        telefono: null,
        zona: 'CARABOBO',
        activo: true,
        sucursal: 'CENTRO',
        region_id: CENTRO_UUID,
        metadata: { region_codigo: 'CENTRO' },
        created_at: '',
        updated_at: '',
      },
      {
        id: 'sup-and-1',
        codigo: 'SA-1',
        nombre: 'Supervisor Andes',
        email: null,
        telefono: null,
        zona: 'MERIDA',
        activo: true,
        sucursal: null,
        region_id: ANDES_UUID,
        metadata: { region_codigo: 'ANDES' },
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
      {
        id: '34',
        nombre_completo: 'Camila Andina',
        email: 'camila.andina@codizulca.com',
        telefono: '0414-7770001',
        ciudad: 'Mérida',
        estado: 'MERIDA',
        direccion: 'Av. Las Américas, Mérida',
        region: 'Andes',
        sucursal: null,
        region_id: ANDES_UUID,
        supervisor_id: null,
        categoria: 'Fijas',
        activo: true,
        metadata: { region_codigo: 'ANDES' },
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
        id: 'zona-cen-1',
        codigo: 'Z-CEN',
        nombre: 'Carabobo Valencia',
        ciudad: 'Valencia',
        estado: 'CARABOBO',
        sucursal: 'CENTRO',
        region_id: CENTRO_UUID,
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        created_at: '',
        updated_at: '',
      },
      {
        id: 'zona-and-1',
        codigo: 'Z-AND',
        nombre: 'Mérida Libertador',
        ciudad: 'Mérida',
        estado: 'MERIDA',
        sucursal: null,
        region_id: ANDES_UUID,
        activo: true,
        metadata: { region_codigo: 'ANDES' },
        created_at: '',
        updated_at: '',
      },
    ],
    sedesResumen: [
      { sucursal: 'ZULIA', total: 1, activos: 1, inactivos: 0, vendedoresActivos: 1, zonas: ['ZULIA'] },
      { sucursal: 'CENTRO', total: 1, activos: 1, inactivos: 0, vendedoresActivos: 1, zonas: ['CARABOBO'] },
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
      {
        region: 'ANDES',
        regionId: ANDES_UUID,
        regiSaba: false,
        priority: 3,
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
      totalErpRaw: 3,
      activosRealesUnicos: 3,
      rutasComercialesActivas: 3,
      excluidosTotal: 0,
      consolidadosDuplicados: 0,
      excluidosPorMotivo: {
        INACTIVO: 0,
        SIN_CODIGO: 0,
        CUENTA_ADMINISTRATIVA_O_VACANTE: 0,
        SIN_SUPERVISOR: 0,
        EXCLUIDO_FORECAST_ERP: 0,
      },
      porSede: { ZULIA: 1, VALENCIA: 0, CENTRO: 1, ORIENTE: 0, CAPITAL: 0 },
    },
    countsExact: {
      regiones: 3,
      productos: 1,
      clientesTotal: 3,
      clientesActivos: 3,
      clientesConGps: 3,
      promotoras: 3,
      supervisores: 3,
      cadenas: 0,
      zonas: 3,
      vendedores: 3,
    },
  };
}

test('seed-coordinadora-centro-andes valida variables fail-fast y construye payloads multi-región sin secretos en user_metadata', () => {
  assert.throws(
    () => readMariaSeedEnv({ SUPABASE_URL: 'https://example.supabase.co' }),
    /SUPABASE_SERVICE_ROLE_KEY.*MARIA_INITIAL_PASSWORD/
  );

  assert.throws(
    () =>
      readMariaSeedEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-key-unit-test',
        MARIA_INITIAL_PASSWORD: 'short',
      }),
    /al menos 8 caracteres/
  );

  const env = readMariaSeedEnv({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-key-unit-test',
    MARIA_INITIAL_PASSWORD: 'PlaceholderOnlyUnitTest123!',
    MARIA_DISPLAY_NAME: 'María',
  });
  assert.equal(env.displayName, 'María');

  const authPayload = buildMariaAuthPayload({
    password: env.initialPassword,
    displayName: env.displayName,
    centroRegionId: CENTRO_UUID,
    andesRegionId: ANDES_UUID,
  });
  assert.equal(authPayload.email, MARIA_EMAIL);
  assert.equal(authPayload.email_confirm, true);
  assert.equal(authPayload.app_metadata.role, MARIA_ROLE);
  assert.deepEqual(authPayload.app_metadata.regions, [...MARIA_REGIONS]);
  assert.deepEqual(authPayload.app_metadata.region_ids, [CENTRO_UUID, ANDES_UUID]);
  assert.equal(authPayload.app_metadata.sucursal, MARIA_PRIMARY_SUCURSAL);
  assert.equal(authPayload.app_metadata.scope, MARIA_SCOPE);
  assert.equal(authPayload.user_metadata.nombre_completo, 'María');
  // Jamás almacenar claims de autorización en user_metadata editable por el usuario
  assert.equal('role' in authPayload.user_metadata, false);
  assert.equal('region' in authPayload.user_metadata, false);
  assert.equal('regions' in authPayload.user_metadata, false);
  assert.equal('sucursal' in authPayload.user_metadata, false);

  const profilePayload = buildMariaProfilePayload({
    authUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    displayName: 'María',
    centroRegionId: CENTRO_UUID,
  });
  assert.equal(profilePayload.role, 'coordinador_trade');
  assert.deepEqual(profilePayload.regiones_asignadas, ['CENTRO', 'ANDES']);
  assert.equal(profilePayload.sucursal, 'CENTRO');
  assert.equal(profilePayload.is_active, true);
});

test('authService extrae assignedRegions=["CENTRO","ANDES"] para María e ignora user_metadata manipulado', () => {
  const mariaProfile = extractVerifiedProfileFromAuthUser({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    email: MARIA_EMAIL,
    app_metadata: {
      role: 'coordinador_trade',
      regions: ['CENTRO', 'ANDES'],
      region: 'Centro',
      sucursal: 'CENTRO',
      region_id: CENTRO_UUID,
      region_ids: [CENTRO_UUID, ANDES_UUID],
      scope: 'regional',
    },
    // Intento malicioso de escalar a super_admin u Occidente vía user_metadata
    user_metadata: {
      role: 'super_admin',
      app_role: 'super_admin',
      regions: ['OCCIDENTE', 'CENTRO', 'ANDES'],
      region: 'Occidente',
      sucursal: 'GLOBAL',
    },
  } as any);

  assert.ok(mariaProfile);
  assert.equal(mariaProfile.iamRole, 'coordinacion');
  assert.equal(mariaProfile.appRole, 'coordinadora');
  assert.deepEqual(mariaProfile.assignedRegions, ['CENTRO', 'ANDES']);
  assert.deepEqual(mariaProfile.assignedRegionLabels, ['Centro', 'Andes']);
  assert.equal(mariaProfile.sucursal, 'CENTRO');
  assert.equal(mariaProfile.canAccessTorreControl, true);

  // Retrocompatibilidad: Grecia sigue con assignedRegions = ['OCCIDENTE']
  const greciaProfile = extractVerifiedProfileFromAuthUser({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'grecia01@codizulca.com',
    app_metadata: {
      role: 'coordinador_trade',
      region: 'Occidente',
      sucursal: 'ZULIA',
      region_id: OCCIDENTE_UUID,
      scope: 'regional',
    },
    user_metadata: {
      regions: ['CENTRO', 'ANDES'],
    },
  } as any);

  assert.ok(greciaProfile);
  assert.deepEqual(greciaProfile.assignedRegions, ['OCCIDENTE']);
  assert.deepEqual(greciaProfile.assignedRegionLabels, ['Occidente']);
});

test('BFF /api/maestros aisla herméticamente a María en CENTRO+ANDES, rechaza OCCIDENTE con 403 y preserva a Grecia y Admin', async () => {
  const snapshot = buildThreeRegionMasterSnapshot();
  const gateway: MasterDataErpGateway = {
    async loadSnapshot() {
      return snapshot;
    },
  };
  const handlers = createMasterDataErpHandlers(gateway);

  // 1) Bootstrap para María -> SOLO CENTRO y ANDES, 0 OCCIDENTE en todos los arrays y resúmenes
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildMariaActor(), query: {} } as unknown as Request;
    await handlers.handleBootstrapMaestros(req, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as any;
    assert.deepEqual(body.regions, ['CENTRO', 'ANDES']);
    assert.equal(body.data.clientes.length, 2);
    assert.deepEqual(
      body.data.clientes.map((c: any) => c.codigo_cliente).sort(),
      ['AND-001', 'CEN-001']
    );
    assert.equal(body.data.vendedores.length, 2);
    assert.equal(body.data.supervisores.length, 2);
    assert.equal(body.data.promotoras.length, 2);
    assert.equal(body.data.zonas.length, 2);
    assert.deepEqual(
      body.data.regiones.map((r: any) => r.codigo).sort(),
      ['ANDES', 'CENTRO']
    );
    assert.deepEqual(
      body.resumenRegional.map((r: any) => r.region).sort(),
      ['ANDES', 'CENTRO']
    );
    // Catálogo global de productos permanece disponible
    assert.equal(body.data.productos.length, 1);
    // Cero menciones de Maracaibo/Occidente en la respuesta serializada
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('OCC-001'), false);
    assert.equal(serialized.includes('MARACAIBO'), false);
    assert.equal(serialized.includes('Nicole Godoy'), false);
  }

  // 2) Subfiltros válidos para María: ?region=CENTRO, ?region=ANDES, ?regions=CENTRO,ANDES
  for (const [query, expectedCodes] of [
    [{ region: 'CENTRO' }, ['CEN-001']],
    [{ region: 'ANDES' }, ['AND-001']],
    [{ regions: 'CENTRO,ANDES' }, ['AND-001', 'CEN-001']],
    [{ regionId: ANDES_UUID }, ['AND-001']],
  ] as const) {
    const { res, state } = createMockRes();
    const req = { authUser: buildMariaActor(), query } as unknown as Request;
    await handlers.handleListClientesMaestros(req, res);
    assert.equal(state.statusCode, 200, `Query válida falló: ${JSON.stringify(query)}`);
    const body = state.body as any;
    assert.deepEqual(
      body.data.map((c: any) => c.codigo_cliente).sort(),
      [...expectedCodes]
    );
  }

  // 3) Intentos adversariales IDOR hacia OCCIDENTE -> TODOS 403 FORBIDDEN_REGION_ACCESS
  const adversarialQueries = [
    { region: 'OCCIDENTE' },
    { regionId: OCCIDENTE_UUID },
    { regions: 'OCCIDENTE,CENTRO' },
    { sucursal: 'ZULIA' },
  ];
  for (const query of adversarialQueries) {
    const { res, state } = createMockRes();
    const req = { authUser: buildMariaActor(), query } as unknown as Request;
    await handlers.handleListClientesMaestros(req, res);
    assert.equal(state.statusCode, 403, `IDOR clientes debió ser 403: ${JSON.stringify(query)}`);
    assert.match(String((state.body as any)?.code ?? ''), /^FORBIDDEN_(REGION|SUCURSAL)_ACCESS$/);
  }

  // También rechaza en vendedores, promotoras, supervisores y zonas
  for (const [name, fn] of [
    ['vendedores', handlers.handleListVendedoresMaestros],
    ['promotoras', handlers.handleListPromotorasMaestras],
    ['supervisores', handlers.handleListSupervisoresMaestros],
    ['zonas', handlers.handleListZonasComerciales],
  ] as const) {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildMariaActor(),
      query: { region: 'OCCIDENTE' },
    } as unknown as Request;
    await fn(req, res);
    assert.equal(state.statusCode, 403, `IDOR ${name} debió ser 403`);
  }

  // 4) Retrocompatibilidad Grecia (OCCIDENTE únicamente): 0 Centro, 0 Andes, 403 al pedir ANDES
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildGreciaActor(), query: {} } as unknown as Request;
    await handlers.handleBootstrapMaestros(req, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as any;
    assert.deepEqual(
      body.data.clientes.map((c: any) => c.codigo_cliente),
      ['OCC-001']
    );
  }
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildGreciaActor(), query: { region: 'ANDES' } } as unknown as Request;
    await handlers.handleListClientesMaestros(req, res);
    assert.equal(state.statusCode, 403);
  }

  // 5) Retrocompatibilidad Admin Global: recibe las 3 regiones intactas
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildGlobalAdminActor(), query: {} } as unknown as Request;
    await handlers.handleBootstrapMaestros(req, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as any;
    assert.equal(body.data.clientes.length, 3);
    assert.equal(body.data.regiones.length, 3);
  }
});

test('BFF /api/promotoras aisla a María en CENTRO+ANDES y bloquea lectura/escritura en OCCIDENTE con 403', async () => {
  const rows: PromotoraServerRecord[] = [
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
      direccion: 'Los Guayos, Valencia',
      categoria: 'Fijas',
      activo: true,
      supervisor_id: null,
      region: 'Valencia',
      region_id: CENTRO_UUID,
      sucursal: 'VALENCIA',
    },
    {
      id: '33333333-0000-4000-8000-000000000003',
      nombre_completo: 'Camila Andina',
      email: 'camila.andina@codizulca.com',
      telefono: '0414-7770001',
      ciudad: 'Mérida',
      estado: 'MERIDA',
      direccion: 'Av. Las Américas, Mérida',
      categoria: 'Fijas',
      activo: true,
      supervisor_id: null,
      region: 'Andes',
      region_id: ANDES_UUID,
      sucursal: null,
    },
  ];

  const gateway: PromotorasGateway = {
    async resolveRegionIdByCode(code) {
      return code === 'OCCIDENTE' ? OCCIDENTE_UUID : code === 'CENTRO' ? CENTRO_UUID : ANDES_UUID;
    },
    async listPromotoras() {
      return rows;
    },
    async getPromotoraById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async createPromotora(payload) {
      return {
        id: '99999999-0000-4000-8000-000000000099',
        nombre_completo: String(payload.nombre_completo ?? ''),
        email: payload.email ? String(payload.email) : null,
        telefono: payload.telefono ? String(payload.telefono) : null,
        ciudad: payload.ciudad ? String(payload.ciudad) : null,
        estado: null,
        direccion: payload.direccion ? String(payload.direccion) : null,
        categoria: 'Fijas',
        activo: true,
        supervisor_id: null,
        region: (payload.region ? String(payload.region) : null) as PromotoraServerRecord['region'],
        region_id: payload.region_id ? String(payload.region_id) : null,
        sucursal: payload.sucursal ? String(payload.sucursal) : null,
      };
    },
    async updatePromotora(id, payload) {
      const target = rows.find((r) => r.id === id);
      if (!target) return null;
      return { ...target, ...(payload as any) };
    },
  };

  const handlers = createPromotorasHandlers({ gatewayFactory: () => gateway });

  // GET sin filtros -> devuelve Valencia/Centro + Andes, 0 Occidente
  {
    const { res, state } = createMockRes();
    const req = { authUser: buildMariaActor(), query: {}, headers: {} } as unknown as Request;
    await handlers.handleListPromotoras(req, res);
    assert.equal(state.statusCode, 200);
    const list = (state.body as any).items;
    assert.equal(list.length, 2);
    assert.equal(list.some((p: any) => p.nombre_completo === 'Nicole Godoy'), false);
    assert.equal(list.some((p: any) => p.nombre_completo === 'Paola Maldonado'), true);
    assert.equal(list.some((p: any) => p.nombre_completo === 'Camila Andina'), true);
  }

  // GET ?region=OCCIDENTE -> 403
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildMariaActor(),
      query: { region: 'OCCIDENTE' },
      headers: {},
    } as unknown as Request;
    await handlers.handleListPromotoras(req, res);
    assert.equal(state.statusCode, 403);
    assert.match(String((state.body as any)?.code ?? ''), /^FORBIDDEN_(REGION|SUCURSAL)_ACCESS$/);
  }

  // GET ?regionId=OCCIDENTE_UUID -> 403
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildMariaActor(),
      query: { regionId: OCCIDENTE_UUID },
      headers: {},
    } as unknown as Request;
    await handlers.handleListPromotoras(req, res);
    assert.equal(state.statusCode, 403);
  }

  // Header spoofing x-sucursal-activa: ZULIA -> 403
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildMariaActor('ZULIA'),
      query: {},
      headers: { 'x-sucursal-activa': 'ZULIA' },
    } as unknown as Request;
    await handlers.handleListPromotoras(req, res);
    assert.equal(state.statusCode, 403);
  }

  // POST en ANDES -> 201 OK
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildMariaActor(),
      body: {
        nombre_completo: 'Lucía Trujillo',
        region: 'Andes',
        region_id: ANDES_UUID,
        categoria: 'Fijas',
      },
    } as unknown as Request;
    await handlers.handleCreatePromotora(req, res);
    assert.equal(state.statusCode, 201);
  }

  // POST en OCCIDENTE -> 403 bloqueado
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildMariaActor(),
      body: {
        nombre_completo: 'Intento Occidente',
        region: 'Occidente',
        region_id: OCCIDENTE_UUID,
        categoria: 'Fijas',
      },
    } as unknown as Request;
    await handlers.handleCreatePromotora(req, res);
    assert.equal(state.statusCode, 403);
  }

  // PATCH sobre promotora de OCCIDENTE -> 403 bloqueado
  {
    const { res, state } = createMockRes();
    const req = {
      authUser: buildMariaActor(),
      params: { id: '11111111-0000-4000-8000-000000000001' },
      body: { nombre_completo: 'Hack Occidente' },
    } as unknown as Request;
    await handlers.handleUpdatePromotora(req, res);
    assert.equal(state.statusCode, 403);
  }
});

test('UI SSR: RegionGateSelector y MasterEntitiesSyncPanel exponen solo Centro y Andes para María y bloquean Occidente', () => {
  // 1) RegionGateSelector para María
  const mariaBarHtml = renderToStaticMarkup(
    React.createElement(RegionGateSelector, {
      mode: 'bar',
      canSwitchSucursal: false,
      assignedRegionCodes: ['CENTRO', 'ANDES'],
      activeSucursal: 'ASSIGNED',
      userEmail: MARIA_EMAIL,
      userRoleLabel: 'Coordinación Trade',
    })
  );
  assert.match(mariaBarHtml, /Regiones:\s*Centro y Andes/i);
  assert.match(mariaBarHtml, /Centro y Andes \(Mis Regiones\)/i);
  assert.match(mariaBarHtml, /Centro/i);
  assert.match(mariaBarHtml, /Andes/i);
  assert.doesNotMatch(mariaBarHtml, /Occidente/i);
  assert.doesNotMatch(mariaBarHtml, /Todas las Regiones/i);
  assert.doesNotMatch(mariaBarHtml, /Comparativo/i);

  // 2) RegionGateSelector para Grecia (regresión single-region bloqueada sin botones)
  const greciaBarHtml = renderToStaticMarkup(
    React.createElement(RegionGateSelector, {
      mode: 'bar',
      canSwitchSucursal: false,
      assignedRegionCodes: ['OCCIDENTE'],
      activeSucursal: 'OCCIDENTE',
      userEmail: 'grecia01@codizulca.com',
      userRoleLabel: 'Coordinación Trade',
    })
  );
  assert.match(greciaBarHtml, /Región:\s*Occidente/i);
  assert.doesNotMatch(greciaBarHtml, /<button\b/i);
  assert.doesNotMatch(greciaBarHtml, /<select\b/i);

  // 3) MasterEntitiesSyncPanel para María: ve Centro + Andes, 0 Occidente, 0 Cuarentena
  const snapshot = buildThreeRegionMasterSnapshot();
  const panelHtml = renderToStaticMarkup(
    React.createElement(MasterEntitiesSyncPanel, {
      qaOverride: {
        iamRole: 'coordinacion',
        userEmail: MARIA_EMAIL,
        sucursal: 'CENTRO',
        regionId: CENTRO_UUID,
        assignedRegionCodes: ['CENTRO', 'ANDES'],
        assignedRegions: ['Centro', 'Andes'],
        regiones: snapshot.regiones ?? [],
        productos: snapshot.productos ?? [],
        supervisores: snapshot.supervisores ?? [],
        promotoras: snapshot.promotoras ?? [],
        clientes: snapshot.clientes,
        initialTab: 'clientes',
      },
    })
  );
  assert.match(panelHtml, /Regiones:\s*Centro y Andes/i);
  assert.match(panelHtml, /CEN-001/i);
  assert.match(panelHtml, /AUTO VALENCIA/i);
  assert.match(panelHtml, /AND-001/i);
  assert.match(panelHtml, /ABASTO MERIDA/i);
  assert.doesNotMatch(panelHtml, /SUPER MARACAIBO/i);
  assert.doesNotMatch(panelHtml, /SUPERMERCADO MARACAIBO EXCLUSIVO CA/i);
  assert.doesNotMatch(panelHtml, /OCC-001/i);
  assert.doesNotMatch(panelHtml, /Sin Región Asignada/i);
  assert.doesNotMatch(panelHtml, /Todas las Regiones/i);
});

test('Auditoría estática de seguridad en migración SQL multi-región 20261202000100, .gitignore y .env.example', () => {
  const root = process.cwd();
  const migrationPath = path.join(
    root,
    'supabase',
    'migrations',
    '20261202000100_rls_multiregion_centro_andes.sql'
  );
  const mirrorPath = path.join(root, 'sql', 'rls_multiregion_centro_andes.sql');

  assert.equal(fs.existsSync(migrationPath), true, 'Falta migración SQL multi-región');
  assert.equal(fs.existsSync(mirrorPath), true, 'Falta espejo sql/rls_multiregion_centro_andes.sql');

  const sql = fs.readFileSync(migrationPath, 'utf8');
  const mirrorSql = fs.readFileSync(mirrorPath, 'utf8');
  assert.equal(sql, mirrorSql, 'La migración y su espejo en sql/ deben ser idénticos');

  // Reglas críticas de seguridad
  assert.doesNotMatch(sql, /\buser_metadata\b/i, 'PROHIBIDO usar user_metadata en SQL RLS');
  assert.doesNotMatch(sql, /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+COLUMN\b/i);

  // Helpers multi-región requeridos + defensas RESTRICTIVE + verificación
  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.current_user_regions\s*\(\)/i);
  assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.can_access_region\s*\(/i);
  assert.match(sql, /regiones_asignadas\s+TEXT\[\]/i);
  assert.match(sql, /SECURITY\s+DEFINER/i);
  assert.match(sql, /SET\s+search_path\s*=\s*public/i);
  assert.match(sql, /AS\s+RESTRICTIVE/i);
  assert.match(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION/i);
  assert.match(sql, /pg_policies/i);

  // .gitignore protege .env y .env.local
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.local$/m);

  // .env.example documenta claves vacías sin secretos reales
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /^MARIA_INITIAL_PASSWORD=$/m);
  assert.match(envExample, /^MARIA_DISPLAY_NAME=/m);
  assert.match(envExample, /^GRECIA_INITIAL_PASSWORD=$/m);
});
