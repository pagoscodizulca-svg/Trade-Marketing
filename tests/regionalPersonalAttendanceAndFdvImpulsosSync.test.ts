import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createMasterDataErpHandlers,
  resolveAuthorizedSucursalScope,
  type MasterDataErpGateway,
  type MasterDataErpSnapshot,
} from '../src/server/masterDataErpHandler';
import {
  createPromotorasHandlers,
  type PromotoraServerRecord,
  type PromotorasGateway,
} from '../src/server/promotorasHandler';
import {
  adaptImpulsoActividadToSurveyRows,
  createFdvImpulsosBridgeHandlers,
  type FdvImpulsosBridgeGateway,
  type ImpulsoActividadCanonicalItem,
} from '../src/server/fdvImpulsosBridgeHandler';
import { filterAttendanceViewModels } from '../src/components/field/AttendanceEvidenceSubTab';
import type { DailyPromotoraAttendanceViewModel } from '../src/types/attendanceEvidences';
import type { AuthenticatedServerUser } from '../src/server/supabaseAdminAuth';

function createMockRes() {
  const state: { statusCode: number; body: unknown; headers: Record<string, string> } = {
    statusCode: 200,
    body: null,
    headers: {},
  };
  const res = {
    setHeader(k: string, v: string) {
      state.headers[k.toLowerCase()] = v;
      return this;
    },
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

const REG_OCC_ID = 'd4b09e5c-76a9-4783-99e7-03b3854bbca8';
const REG_CEN_ID = '618284ba-9dea-4efb-9e6b-e429b8d8960d';

const ADMIN_CENTRO_ACTOR: AuthenticatedServerUser = {
  id: '13fcc651-99df-4760-84e0-7e62ccb53f12',
  email: 'admin@codizulca.com',
  appRole: 'super_admin',
  sucursal: 'GLOBAL',
  isSuperAdmin: true,
  isCoordinatorOrAdmin: true,
  activeSucursalHeader: 'CENTRO',
};

const ADMIN_OCC_ACTOR: AuthenticatedServerUser = {
  ...ADMIN_CENTRO_ACTOR,
  activeSucursalHeader: 'ZULIA',
};

const ADMIN_ALL_ACTOR: AuthenticatedServerUser = {
  ...ADMIN_CENTRO_ACTOR,
  activeSucursalHeader: null,
};

const GRECIA_OCC_ACTOR: AuthenticatedServerUser = {
  id: '447fbee6-6b89-46c7-b830-5194645ed534',
  email: 'grecia01@codizulca.com',
  appRole: 'coordinacion',
  sucursal: 'ZULIA',
  allowedRegions: ['OCCIDENTE'],
  isCoordinatorOrAdmin: true,
};

const MARIA_CEN_ACTOR: AuthenticatedServerUser = {
  id: '5cd175ce-3ffc-4a00-b2f3-a3577d0b29af',
  email: 'maria01@codizulca.com',
  appRole: 'coordinacion',
  sucursal: 'CENTRO',
  allowedRegions: ['CENTRO'],
  isCoordinatorOrAdmin: true,
};

test('Personal Centro y Occidente: x-sucursal-activa aísla estrictamente a super_admin sin mezclar sedes', async () => {
  const scopeCentro = resolveAuthorizedSucursalScope(ADMIN_CENTRO_ACTOR, undefined, undefined, undefined);
  assert.equal(scopeCentro.ok, true);
  if (scopeCentro.ok) {
    assert.equal(scopeCentro.region, 'CENTRO');
    assert.deepEqual(scopeCentro.regions, ['CENTRO']);
  }

  const scopeOcc = resolveAuthorizedSucursalScope(ADMIN_OCC_ACTOR, undefined, undefined, undefined);
  assert.equal(scopeOcc.ok, true);
  if (scopeOcc.ok) {
    assert.equal(scopeOcc.region, 'OCCIDENTE');
    assert.deepEqual(scopeOcc.regions, ['OCCIDENTE']);
  }

  const snapshot: MasterDataErpSnapshot = {
    regiones: [
      { id: REG_OCC_ID, codigo: 'OCCIDENTE', nombre: 'OCCIDENTE', activo: true, priority: 1, created_at: '', updated_at: '' },
      { id: REG_CEN_ID, codigo: 'CENTRO', nombre: 'CENTRO', activo: true, priority: 2, created_at: '', updated_at: '' },
    ],
    promotoras: [
      {
        id: '1',
        nombre_completo: 'Nicole Godoy',
        email: 'godoyaraujonicole@gmail.com',
        telefono: '0412-0000001',
        ciudad: 'Coro',
        estado: 'FALCON',
        direccion: 'Coro',
        region: 'Occidente',
        sucursal: 'ZULIA',
        region_id: REG_OCC_ID,
        supervisor_id: null,
        categoria: 'Fijas',
        activo: true,
        metadata: { region_codigo: 'OCCIDENTE' },
        created_at: '',
        updated_at: '',
      },
      {
        id: '25',
        nombre_completo: 'Paola Gabriela Maldonado Jaimes',
        email: 'paolamaldonado1805@gmail.com',
        telefono: '0412-0000025',
        ciudad: 'Valencia',
        estado: 'CARABOBO',
        direccion: 'Los Guayos, Valencia',
        region: 'Centro',
        sucursal: 'CENTRO',
        region_id: REG_CEN_ID,
        supervisor_id: null,
        categoria: 'Fijas',
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        created_at: '',
        updated_at: '',
      },
      {
        id: '45',
        nombre_completo: 'Raynellys Reyes',
        email: 'raynellysreyes31@gmail.com',
        telefono: '0412-0000045',
        ciudad: null,
        estado: null,
        direccion: null,
        region: 'Centro',
        sucursal: 'CENTRO',
        region_id: REG_CEN_ID,
        supervisor_id: null,
        categoria: 'Eventuales',
        activo: true,
        metadata: { region_codigo: 'CENTRO' },
        created_at: '',
        updated_at: '',
      },
    ],
    clientes: [],
    vendedores: [],
    vendedoresAuditoria: {
      totalErpRaw: 0,
      activosRealesUnicos: 0,
      rutasComercialesActivas: 0,
      excluidosTotal: 0,
      consolidadosDuplicados: 0,
      excluidosPorMotivo: {
        INACTIVO: 0,
        SIN_CODIGO: 0,
        CUENTA_ADMINISTRATIVA_O_VACANTE: 0,
        SIN_SUPERVISOR: 0,
        EXCLUIDO_FORECAST_ERP: 0,
      },
      porSede: { ZULIA: 0, VALENCIA: 0, CENTRO: 0, ORIENTE: 0, CAPITAL: 0 },
    },
    sedesResumen: [],
    fetchedAtMs: Date.now(),
    source: 'supabase_erp_clientes',
  };

  const fakeGateway: MasterDataErpGateway = {
    async loadSnapshot() {
      return snapshot;
    },
  };
  const handlers = createMasterDataErpHandlers(fakeGateway);

  // Admin en CENTRO recibe solo Fijas y Eventuales de CENTRO (0 Occidente)
  {
    const { res, state } = createMockRes();
    await handlers.handleListPromotorasMaestras({ authUser: ADMIN_CENTRO_ACTOR, query: {} } as unknown as Request, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as { total: number; data: Array<{ nombre_completo: string; categoria: string }> };
    assert.equal(body.total, 2);
    assert.deepEqual(
      body.data.map((p) => `${p.nombre_completo}:${p.categoria}`).sort(),
      ['Paola Gabriela Maldonado Jaimes:Fijas', 'Raynellys Reyes:Eventuales']
    );
  }

  // Admin en OCCIDENTE recibe solo Occidente (0 Centro)
  {
    const { res, state } = createMockRes();
    await handlers.handleListPromotorasMaestras({ authUser: ADMIN_OCC_ACTOR, query: {} } as unknown as Request, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as { total: number; data: Array<{ nombre_completo: string }> };
    assert.equal(body.total, 1);
    assert.equal(body.data[0]?.nombre_completo, 'Nicole Godoy');
  }

  // Admin en GLOBAL (sin header) recibe las 3
  {
    const { res, state } = createMockRes();
    await handlers.handleListPromotorasMaestras({ authUser: ADMIN_ALL_ACTOR, query: {} } as unknown as Request, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as { total: number };
    assert.equal(body.total, 3);
  }
});

test('/api/promotoras respeta x-sucursal-activa para super_admin sin mezclar Centro y Occidente', async () => {
  const rows: PromotoraServerRecord[] = [
    {
      id: '1',
      nombre_completo: 'Nicole Godoy',
      email: 'godoyaraujonicole@gmail.com',
      telefono: null,
      ciudad: 'Coro',
      estado: 'FALCON',
      direccion: 'Coro',
      region: 'Occidente',
      categoria: 'Fijas',
      region_id: REG_OCC_ID,
      sucursal: 'OCCIDENTE',
      supervisor_id: null,
      activo: true,
    },
    {
      id: '25',
      nombre_completo: 'Paola Maldonado',
      email: 'paolamaldonado1805@gmail.com',
      telefono: null,
      ciudad: 'Valencia',
      estado: 'CARABOBO',
      direccion: 'Valencia',
      region: 'Centro',
      categoria: 'Fijas',
      region_id: REG_CEN_ID,
      sucursal: 'CENTRO',
      supervisor_id: null,
      activo: true,
    },
  ];

  const fakeGw: PromotorasGateway = {
    async resolveRegionIdByCode(code) {
      return code === 'OCCIDENTE' ? REG_OCC_ID : code === 'CENTRO' ? REG_CEN_ID : null;
    },
    async listPromotoras(filters) {
      return filters.regionId ? rows.filter((r) => r.region_id === filters.regionId) : rows;
    },
    async getPromotoraById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async createPromotora() {
      throw new Error('not used');
    },
    async updatePromotora() {
      throw new Error('not used');
    },
  };

  const handlers = createPromotorasHandlers({ gatewayFactory: () => fakeGw, authSyncGateway: null });
  const { res, state } = createMockRes();
  await handlers.handleListPromotoras(
    {
      authUser: ADMIN_CENTRO_ACTOR,
      headers: { 'x-sucursal-activa': 'CENTRO' },
      query: {},
    } as unknown as Request,
    res
  );
  assert.equal(state.statusCode, 200);
  const body = state.body as { ok: boolean; items: PromotoraServerRecord[]; stats?: { total?: number } };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.nombre_completo, 'Paola Maldonado');
});

test('Informes -> Asistencias: Occidente jamás muestra fotos ni jornadas de Centro/Valencia y viceversa', () => {
  const mkVm = (id: string, nombre: string, region: 'Occidente' | 'Valencia'): DailyPromotoraAttendanceViewModel => ({
    key: `2026-11-24__${id}`,
    asistenciaId: `asist-${id}`,
    fechaJornada: '2026-11-24',
    fechaSlash: '24/11/2026',
    fechaLongEs: '24 de noviembre de 2026',
    promotoraId: id,
    promotoraNombre: nombre,
    promotoraInitials: nombre.slice(0, 2).toUpperCase(),
    promotoraEmail: `${id}@example.com`,
    pdvNombre: region === 'Occidente' ? 'Hiper Ahorro Cabimas' : 'Makro Valencia',
    zona: region === 'Occidente' ? 'CABIMAS' : 'Valencia',
    region,
    perfilAplicado: 'FIJA',
    perfilFuente: 'SNAPSHOT_HISTORICO',
    compliance: {
      perfilAplicado: 'FIJA',
      requiredCount: 2,
      uploadedCount: 1,
      status: 'INCOMPLETA',
      statusLabel: 'Incompleta',
      fractionLabel: '1/2',
    },
    evidencesBySlot: {},
  });

  const all = [
    mkVm('7', 'Maria de los Angeles Almarza Arandia', 'Occidente'),
    mkVm('25', 'Paola Gabriela Maldonado Jaimes', 'Valencia'),
    mkVm('29', 'Mariana Dos Ramos', 'Valencia'),
  ];

  const onlyOcc = filterAttendanceViewModels(all, {
    regionFilter: 'Occidente',
    allowedRegionCodes: ['OCCIDENTE'],
  });
  assert.equal(onlyOcc.length, 1);
  assert.equal(onlyOcc[0]?.promotoraNombre, 'Maria de los Angeles Almarza Arandia');

  const onlyCentro = filterAttendanceViewModels(all, {
    regionFilter: 'Centro',
    allowedRegionCodes: ['CENTRO'],
  });
  assert.equal(onlyCentro.length, 2);
  assert.ok(onlyCentro.every((v) => v.region === 'Valencia'));
});

test('Puente App de Vendedores (Impulsos_Actividades) <-> Módulo Degustación: aisla Occidente/Centro y sincroniza estados', async () => {
  const occEnvio = '11111111-1111-4111-8111-111111111111';
  const cenEnvio = '22222222-2222-4222-8222-222222222222';

  const items: ImpulsoActividadCanonicalItem[] = [
    {
      idImpu: occEnvio,
      idEnvio: occEnvio,
      tipo: 'DEGUSTACION',
      estado: 'PENDIENTE',
      fdes: '2026-11-26',
      fhas: '2026-11-26',
      hini: '09:00',
      hfin: '13:00',
      fechas: [{ fecha: '2026-11-26', hini: '09:00', hfin: '13:00' }],
      clienteId: 'clie-occ-1',
      clienteNombre: 'HIPER AHORRO CABIMAS, C.A.',
      clienteRif: 'J301234567',
      clienteEstado: 'ZULIA',
      clienteLat: 10.35,
      clienteLon: -71.42,
      vendedorId: 'vend-occ-1',
      vendedorCodigo: '001',
      vendedorNombre: 'MARIA BRICEÑO',
      sucursalDesc: 'ZULIA',
      region: 'OCCIDENTE',
      motivo: 'Apoyo en Sell Out General',
      productos: [{ codigo: '001464', nombre: 'MORT. NAVIDEÑA ASTURIAS XKG', um: 'KG', cant: 3 }],
      observaciones: 'Degustación solicitada por vendedor Occidente',
      impulsadora: null,
      telefono: null,
      resumen: null,
      cancelMotivo: null,
      createdAt: '2026-11-24T15:00:00.000Z',
      updatedAt: '2026-11-24T15:00:00.000Z',
    },
    {
      idImpu: cenEnvio,
      idEnvio: cenEnvio,
      tipo: 'DEGUSTACION',
      estado: 'PENDIENTE',
      fdes: '2026-11-27',
      fhas: '2026-11-27',
      hini: '14:00',
      hfin: '18:00',
      fechas: [{ fecha: '2026-11-27', hini: '14:00', hfin: '18:00' }],
      clienteId: 'clie-cen-1',
      clienteNombre: 'MAKRO VALENCIA, C.A.',
      clienteRif: 'J400274737',
      clienteEstado: 'CARABOBO',
      clienteLat: 10.18,
      clienteLon: -67.97,
      vendedorId: 'vend-cen-1',
      vendedorCodigo: '505',
      vendedorNombre: 'JASMIN VELAZQUEZ',
      sucursalDesc: 'CARABOBO',
      region: 'CENTRO',
      motivo: 'Nuevo SKU Lanzamiento',
      productos: [{ codigo: '001200', nombre: 'ARROZ BLANCO VENCAMPO 24X1KG', um: 'KG', cant: 2 }],
      observaciones: 'Solicitud Centro',
      impulsadora: null,
      telefono: null,
      resumen: null,
      cancelMotivo: null,
      createdAt: '2026-11-24T15:00:00.000Z',
      updatedAt: '2026-11-24T15:00:00.000Z',
    },
  ];

  // Verificar adaptación directa para Occidente
  const occAdapted = adaptImpulsoActividadToSurveyRows(items[0]!);
  assert.equal(occAdapted.length, 1);
  assert.equal(occAdapted[0]?.sucursal, 'OCCIDENTE');
  assert.equal(occAdapted[0]?.id, `impulso-${occEnvio}`);
  assert.equal(occAdapted[0]?.store, 'HIPER AHORRO CABIMAS, C.A.');

  const syncedCalls: Array<{ idEnvio: string; estado: string; promotora?: string }> = [];
  const fakeBridgeGw: FdvImpulsosBridgeGateway = {
    async listImpulsosActividades() {
      return items;
    },
    async syncImpulsoEstado(_actor, params) {
      syncedCalls.push({ idEnvio: params.idEnvio, estado: params.estado, promotora: params.promotoraNombre });
      return { ok: true, estado: params.estado };
    },
  };

  const bridgeHandlers = createFdvImpulsosBridgeHandlers(fakeBridgeGw);

  // Grecia (OCCIDENTE) solo recibe la solicitud de Occidente (0 Centro)
  {
    const { res, state } = createMockRes();
    await bridgeHandlers.handleListImpulsosDegustaciones({ authUser: GRECIA_OCC_ACTOR, query: {} } as unknown as Request, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as { total: number; data: Array<{ sucursal: string; store: string }> };
    assert.equal(body.total, 1);
    assert.equal(body.data[0]?.sucursal, 'OCCIDENTE');
    assert.equal(body.data[0]?.store, 'HIPER AHORRO CABIMAS, C.A.');
  }

  // María (CENTRO) solo recibe la solicitud de Centro (0 Occidente)
  {
    const { res, state } = createMockRes();
    await bridgeHandlers.handleListImpulsosDegustaciones({ authUser: MARIA_CEN_ACTOR, query: {} } as unknown as Request, res);
    assert.equal(state.statusCode, 200);
    const body = state.body as { total: number; data: Array<{ sucursal: string; store: string }> };
    assert.equal(body.total, 1);
    assert.equal(body.data[0]?.sucursal, 'CENTRO');
    assert.equal(body.data[0]?.store, 'MAKRO VALENCIA, C.A.');
  }

  // Grecia confirma su solicitud de Occidente -> sincroniza CONFIRMADA + promotora
  {
    const { res, state } = createMockRes();
    await bridgeHandlers.handleSyncImpulsoEstado(
      {
        authUser: GRECIA_OCC_ACTOR,
        params: { idEnvio: occEnvio },
        body: { estado: 'APROBADA', promotoraAsignada: 'Maria de los Angeles Almarza Arandia' },
      } as unknown as Request,
      res
    );
    assert.equal(state.statusCode, 200);
    assert.equal(syncedCalls.length, 1);
    assert.equal(syncedCalls[0]?.estado, 'CONFIRMADA');
    assert.equal(syncedCalls[0]?.promotora, 'Maria de los Angeles Almarza Arandia');
  }

  // Grecia intenta modificar una solicitud de CENTRO -> 403 FORBIDDEN_REGION_ACCESS
  {
    const { res, state } = createMockRes();
    await bridgeHandlers.handleSyncImpulsoEstado(
      {
        authUser: GRECIA_OCC_ACTOR,
        params: { idEnvio: cenEnvio },
        body: { estado: 'APROBADA', promotoraAsignada: 'Intento Cruzado' },
      } as unknown as Request,
      res
    );
    assert.equal(state.statusCode, 403);
    assert.equal((state.body as { code?: string }).code, 'FORBIDDEN_REGION_ACCESS');
  }
});
