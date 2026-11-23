import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import {
  computeClientesSummaryBySede,
  filterNormalizedErpClientes,
  mapErpTerritoryToOperativeSucursal,
  normalizeErpClientesDataset,
  normalizeErpVendedoresDataset,
  type ErpMasterDataset,
} from '../src/utils/erpMasterAdapter';
import {
  createMasterDataErpHandlers,
  resolveAuthorizedSucursalScope,
  type MasterDataErpGateway,
  type MasterDataErpSnapshot,
} from '../src/server/masterDataErpHandler';
import {
  clearMasterDataCaches,
  obtenerClientesMaestros,
  obtenerVendedoresMaestros,
} from '../src/services/masterDataSyncService';
import { createRateLimiter } from '../src/server/supabaseAdminAuth';
import { registerMasterDataErpRoutes } from '../server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MasterDataDatabase } from '../src/types/masterData';

const SAMPLE_ERP_DATASET: ErpMasterDataset = {
  regiones: [
    { id_regi: 'reg-occ', regi_desd: 'OCCIDENTE', regi_saba: true },
    { id_regi: 'reg-cen', regi_desd: 'CENTRO', regi_saba: false },
    { id_regi: 'reg-and', regi_desd: 'ANDES', regi_saba: false },
  ],
  sucursales: [
    { id_sucu: 'sucu-zul', sucu_desc: 'ZULIA', id_regi: 'reg-occ' },
    { id_sucu: 'sucu-fal', sucu_desc: 'FALCON', id_regi: 'reg-occ' },
    { id_sucu: 'sucu-tru', sucu_desc: 'TRUJILLO', id_regi: 'reg-occ' },
    { id_sucu: 'sucu-car', sucu_desc: 'CARABOBO', id_regi: 'reg-cen' },
    { id_sucu: 'sucu-cap', sucu_desc: 'DISTRITO CAPITAL', id_regi: 'reg-cen' },
    { id_sucu: 'sucu-ara', sucu_desc: 'ARAGUA', id_regi: 'reg-cen' },
  ],
  estados: [
    { id_esta: 'est-zul', esta_desc: 'ZULIA', id_regi: 'reg-occ' },
    { id_esta: 'est-fal', esta_desc: 'FALCON', id_regi: 'reg-occ' },
    { id_esta: 'est-car', esta_desc: 'CARABOBO', id_regi: 'reg-cen' },
    { id_esta: 'est-cap', esta_desc: 'DISTRITO CAPITAL', id_regi: 'reg-cen' },
    { id_esta: 'est-ara', esta_desc: 'ARAGUA', id_regi: 'reg-cen' },
  ],
  municipios: [
    { id_muni: 'mun-mcbo', muni_desc: 'MARACAIBO', id_esta: 'est-zul', id_regi: 'reg-occ' },
  ],
  supervisores: [
    { id_supe: 'sup-nel', supe_nomb: 'NELSON FINOL', supe_acti: true, id_regi: 'reg-occ' },
    { id_supe: 'sup-ali', supe_nomb: 'ALI PEREZ', supe_acti: true, id_regi: 'reg-occ' },
    { id_supe: 'sup-gre', supe_nomb: 'GREIDY HERNANDEZ', supe_acti: true, id_regi: 'reg-cen' },
  ],
  vendedores: [
    {
      id_vend: 'vend-001',
      vend_codi: '001',
      vend_nomb: 'MARIA BRICEÑO',
      vend_acti: true,
      id_sucu: 'sucu-zul',
      id_supe: 'sup-nel',
    },
    {
      id_vend: 'vend-011',
      vend_codi: '011',
      vend_nomb: 'OSCAR ORTIZ- CORO',
      vend_acti: true,
      id_sucu: 'sucu-fal',
      id_supe: 'sup-ali',
    },
    {
      id_vend: 'vend-501',
      vend_codi: '501',
      vend_nomb: 'MANUEL SEQUERA',
      vend_acti: true,
      id_sucu: 'sucu-car',
      id_supe: 'sup-gre',
    },
    {
      id_vend: 'vend-203',
      vend_codi: '203',
      vend_nomb: 'NICOLE ARIAS',
      vend_acti: true,
      id_sucu: 'sucu-cap',
      id_supe: 'sup-gre',
    },
    {
      id_vend: 'vend-404',
      vend_codi: '404',
      vend_nomb: 'LESLIE CORRALES',
      vend_acti: true,
      id_sucu: 'sucu-ara',
      id_supe: 'sup-gre',
    },
  ],
  tipificaciones: [
    { id_tipi: 'tip-sup', tipi_desc: 'Supermercados Independientes' },
    { id_tipi: 'tip-min', tipi_desc: 'MiniMarket' },
  ],
  clientes: [
    {
      id_clie: 'clie-329',
      clie_rif: '000329',
      clie_nomb: 'LA NUEVA CARNICERIA MARY LUIS, C.A.',
      id_esta: 'est-zul',
      id_muni: 'mun-mcbo',
      id_vend: 'vend-001',
      clie_regi: 'reg-occ',
      clie_acti: true,
      clie_lati: 10.6544,
      clie_long: -71.6302,
      id_tipi: 'tip-sup',
    },
    {
      id_clie: 'clie-332',
      clie_rif: '000332',
      clie_nomb: 'MINIMARKET I&F, C.A.',
      id_esta: 'est-zul',
      id_muni: null,
      id_vend: 'vend-001',
      clie_regi: 'reg-occ',
      clie_acti: false,
      id_tipi: 'tip-min',
    },
    {
      id_clie: 'clie-3216',
      clie_rif: '003216',
      clie_nomb: 'GRAN CAFE LARA, C.A',
      id_esta: 'est-fal',
      id_muni: null,
      id_vend: 'vend-011',
      clie_regi: 'reg-occ',
      clie_acti: true,
      id_tipi: 'tip-min',
    },
    {
      id_clie: 'clie-val-1',
      clie_rif: '005100',
      clie_nomb: 'AUTOMERCADO VALENCIA EXPRESS, C.A.',
      id_esta: 'est-car',
      id_muni: null,
      id_vend: 'vend-501',
      clie_regi: 'reg-cen',
      clie_acti: true,
      id_tipi: 'tip-sup',
    },
    {
      id_clie: 'clie-cap-1',
      clie_rif: '006100',
      clie_nomb: 'SUPERMERCADO CARACAS PLAZA, C.A.',
      id_esta: 'est-cap',
      id_muni: null,
      id_vend: 'vend-203',
      clie_regi: 'reg-cen',
      clie_acti: true,
      id_tipi: 'tip-sup',
    },
    {
      id_clie: 'clie-ara-1',
      clie_rif: '007100',
      clie_nomb: 'DISTRIBUIDORA MARACAY SUR, C.A.',
      id_esta: 'est-ara',
      id_muni: null,
      id_vend: 'vend-404',
      clie_regi: 'reg-cen',
      clie_acti: true,
      id_tipi: 'tip-min',
    },
  ],
};

test('ERP Adapter: mapea territorios ERP a las 5 sedes operativas sin perder clientes', () => {
  assert.equal(mapErpTerritoryToOperativeSucursal({ sucursalDesc: 'ZULIA' }), 'ZULIA');
  assert.equal(mapErpTerritoryToOperativeSucursal({ sucursalDesc: 'FALCON' }), 'ZULIA');
  assert.equal(mapErpTerritoryToOperativeSucursal({ sucursalDesc: 'TRUJILLO' }), 'ZULIA');
  assert.equal(mapErpTerritoryToOperativeSucursal({ sucursalDesc: 'CARABOBO' }), 'VALENCIA');
  assert.equal(mapErpTerritoryToOperativeSucursal({ sucursalDesc: 'DISTRITO CAPITAL' }), 'CAPITAL');
  assert.equal(mapErpTerritoryToOperativeSucursal({ sucursalDesc: 'ARAGUA' }), 'CENTRO');
  assert.equal(mapErpTerritoryToOperativeSucursal({ estadoDesc: 'ANZOATEGUI' }), 'ORIENTE');

  const clientes = normalizeErpClientesDataset(SAMPLE_ERP_DATASET);
  const vendedores = normalizeErpVendedoresDataset(SAMPLE_ERP_DATASET);
  assert.equal(clientes.length, 6);
  assert.equal(vendedores.length, 5);

  const resumen = computeClientesSummaryBySede(clientes);
  const bySede = Object.fromEntries(resumen.map((r) => [r.sucursal, r]));
  assert.equal(bySede.ZULIA.activos, 2); // Zulia activo + Falcón activo
  assert.equal(bySede.ZULIA.inactivos, 1);
  assert.equal(bySede.VALENCIA.activos, 1);
  assert.equal(bySede.CAPITAL.activos, 1);
  assert.equal(bySede.CENTRO.activos, 1);
  assert.equal(bySede.ORIENTE.activos, 0);

  // Búsqueda tolerante a ", C.A." y acentos
  const hitZulia = filterNormalizedErpClientes(clientes, {
    sucursal: 'ZULIA',
    busqueda: 'MARY LUIS, C.A.',
  });
  assert.equal(hitZulia.length, 1);
  assert.equal(hitZulia[0]?.codigo_cliente, '000329');
  assert.equal(hitZulia[0]?.zona, 'ZULIA · MARACAIBO');
  assert.equal(hitZulia[0]?.vendedor?.nombre_completo, 'MARIA BRICEÑO');
});

test('masterDataSyncService: hace fallback automático a tablas ERP cuando public.clientes no existe (PGRST205)', async () => {
  clearMasterDataCaches();
  const tableData: Record<string, unknown[]> = {
    Regiones: SAMPLE_ERP_DATASET.regiones,
    Sucursales: SAMPLE_ERP_DATASET.sucursales,
    Estados: SAMPLE_ERP_DATASET.estados,
    Municipios: SAMPLE_ERP_DATASET.municipios,
    Supervisores: SAMPLE_ERP_DATASET.supervisores,
    Tipificacion_Clientes: SAMPLE_ERP_DATASET.tipificaciones,
    Vendedores: SAMPLE_ERP_DATASET.vendedores,
    Clientes: SAMPLE_ERP_DATASET.clientes,
  };

  const mockClient = {
    from(table: string) {
      let rangeFrom = 0;
      let rangeTo = 999;
      const builder = {
        select() {
          return builder;
        },
        order() {
          return builder;
        },
        eq() {
          return builder;
        },
        ilike() {
          return builder;
        },
        or() {
          return builder;
        },
        range(from: number, to: number) {
          rangeFrom = from;
          rangeTo = to;
          return builder;
        },
        then<TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          const result =
            table === 'clientes' || table === 'vendedores'
              ? {
                  data: null,
                  error: {
                    code: 'PGRST205',
                    message: `Could not find the table 'public.${table}' in the schema cache`,
                  },
                }
              : {
                  data: (tableData[table] ?? []).slice(rangeFrom, rangeTo + 1),
                  error: null,
                };
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient<MasterDataDatabase>;

  const zuliaClients = await obtenerClientesMaestros({ sucursal: 'ZULIA', forzarRefresco: true }, mockClient);
  assert.equal(zuliaClients.length, 2);
  assert.ok(zuliaClients.every((c) => c.sucursal === 'ZULIA' && c.activo));

  const valenciaClients = await obtenerClientesMaestros({ sucursal: 'VALENCIA', forzarRefresco: true }, mockClient);
  assert.equal(valenciaClients.length, 1);
  assert.equal(valenciaClients[0]?.codigo_cliente, '005100');

  const capitalVendors = await obtenerVendedoresMaestros({ sucursal: 'CAPITAL', forzarRefresco: true }, mockClient);
  assert.equal(capitalVendors.length, 1);
  assert.equal(capitalVendors[0]?.nombre_completo, 'NICOLE ARIAS');
});

test('API /api/maestros/*: exige auth, aplica rate-limit antes de auth y aisla estrictamente por sede', async () => {
  const clientes = normalizeErpClientesDataset(SAMPLE_ERP_DATASET);
  const vendedores = normalizeErpVendedoresDataset(SAMPLE_ERP_DATASET);
  const snapshot: MasterDataErpSnapshot = {
    clientes,
    vendedores,
    sedesResumen: computeClientesSummaryBySede(clientes),
    fetchedAtMs: Date.now(),
    source: 'supabase_erp_clientes',
  };

  const fakeGateway: MasterDataErpGateway = {
    async loadSnapshot() {
      return snapshot;
    },
  };

  // Verificar resolveAuthorizedSucursalScope directamente
  const deniedCross = resolveAuthorizedSucursalScope(
    { id: 'u1', email: 'val@codizulca.com', appRole: 'coordinacion', sucursal: 'VALENCIA' },
    'ZULIA'
  );
  assert.equal(deniedCross.ok, false);
  if (!deniedCross.ok) {
    assert.equal(deniedCross.status, 403);
    assert.equal(deniedCross.code, 'FORBIDDEN_SUCURSAL_ACCESS');
  }

  const handlers = createMasterDataErpHandlers(fakeGateway);
  const app = express();
  const strictLimiter = createRateLimiter({
    name: 'test-maestros-erp',
    windowMs: 60_000,
    maxRequests: 8,
  });

  registerMasterDataErpRoutes(app, {
    rateLimiter: strictLimiter,
    authMiddleware: (req, res, next) => {
      const auth = String(req.headers.authorization || '');
      if (auth === 'Bearer token-zulia') {
        req.authUser = {
          id: 'u-zulia',
          email: 'zulia@codizulca.com',
          appRole: 'coordinacion',
          sucursal: 'ZULIA',
        };
        next();
        return;
      }
      if (auth === 'Bearer token-admin') {
        req.authUser = {
          id: 'u-admin',
          email: 'admin@codizulca.com',
          appRole: 'super_admin',
          sucursal: 'GLOBAL',
          isSuperAdmin: true,
        };
        next();
        return;
      }
      res.status(401).json({ error: 'No autorizado', code: 'AUTH_TOKEN_MISSING' });
    },
    listClientesHandler: handlers.handleListClientesMaestros,
    listVendedoresHandler: handlers.handleListVendedoresMaestros,
    sedesResumenHandler: handlers.handleGetSedesClientesResumen,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Sin auth -> 401
    const unauth = await fetch(`${base}/api/maestros/clientes`);
    assert.equal(unauth.status, 401);

    // 2. Coordinadora ZULIA -> solo clientes ZULIA
    const zuliaRes = await fetch(`${base}/api/maestros/clientes`, {
      headers: { Authorization: 'Bearer token-zulia' },
    });
    assert.equal(zuliaRes.status, 200);
    const zuliaJson = (await zuliaRes.json()) as { sucursal: string; total: number };
    assert.equal(zuliaJson.sucursal, 'ZULIA');
    assert.equal(zuliaJson.total, 2);

    // 3. Coordinadora ZULIA intenta consultar VALENCIA -> 403
    const crossRes = await fetch(`${base}/api/maestros/clientes?sucursal=VALENCIA`, {
      headers: { Authorization: 'Bearer token-zulia' },
    });
    assert.equal(crossRes.status, 403);

    // 4. Super Admin consulta VALENCIA y luego resumen de todas las sedes
    const adminVal = await fetch(`${base}/api/maestros/clientes?sucursal=VALENCIA`, {
      headers: { Authorization: 'Bearer token-admin' },
    });
    assert.equal(adminVal.status, 200);
    const adminValJson = (await adminVal.json()) as { sucursal: string; total: number };
    assert.equal(adminValJson.sucursal, 'VALENCIA');
    assert.equal(adminValJson.total, 1);

    const resumenRes = await fetch(`${base}/api/maestros/sedes-resumen?sucursal=ALL`, {
      headers: { Authorization: 'Bearer token-admin' },
    });
    assert.equal(resumenRes.status, 200);
    const resumenJson = (await resumenRes.json()) as { totalActivos: number };
    assert.equal(resumenJson.totalActivos, 5);

    // 5. Rate limiter dispara 429 ANTES de auth tras agotar cuota en /api/maestros/clientes (4 previas + 4 más = 8, 9a -> 429)
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/api/maestros/clientes`);
      assert.equal(r.status, 401);
    }
    const throttled = await fetch(`${base}/api/maestros/clientes`);
    assert.equal(throttled.status, 429);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
