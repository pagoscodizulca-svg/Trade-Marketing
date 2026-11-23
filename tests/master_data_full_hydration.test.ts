import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  normalizeRegionName,
  REGIONAL_SYNC_PRIORITY_QUEUE,
} from '../src/utils/regionalSyncClassifier';
import {
  buildAuditedErpVendedoresDataset,
  computeClientesSummaryBySede,
  computeMasterEntitiesSummaryByRegion,
  normalizeErpCadenasDataset,
  normalizeErpClientesDataset,
  normalizeErpProductosDataset,
  normalizeErpPromotorasDataset,
  normalizeErpRegionesDataset,
  normalizeErpSupervisoresDataset,
  normalizeErpZonasDataset,
  type ErpMasterDataset,
} from '../src/utils/erpMasterAdapter';
import {
  createMasterDataErpHandlers,
  loadErpMasterSnapshotFromClient,
  type MasterDataErpGateway,
} from '../src/server/masterDataErpHandler';
import { createRateLimiter } from '../src/server/supabaseAdminAuth';
import { registerMasterDataErpRoutes } from '../server';
import {
  clearMasterCatalogCaches,
  obtenerProductosMaestros,
  obtenerPromotorasMaestras,
  obtenerRegionesMaestras,
  obtenerSupervisoresMaestros,
} from '../src/services/masterCatalogSyncService';
import {
  clearMasterDataCaches,
  obtenerCadenasComerciales,
  obtenerClientesMaestros,
  obtenerZonasComerciales,
} from '../src/services/masterDataSyncService';
import { sanitizeLegacyRegionalStorage } from '../src/services/sessionCacheHygiene';
import type { MasterDataDatabase } from '../src/types/masterData';

const REG_OCC_ID = 'd4b09e5c-76a9-4783-99e7-03b3854bbca8';
const REG_CEN_ID = '618284ba-9dea-4efb-9e6b-e429b8d8960d';
const REG_AND_ID = 'cdb5248d-03a1-4b85-9953-e303b4e35dde';

const FULL_ERP_FIXTURE: ErpMasterDataset = {
  regiones: [
    { id_regi: REG_CEN_ID, regi_desd: 'CENTRO', regi_saba: false, created_at: '2026-09-24T00:00:00Z' },
    { id_regi: REG_AND_ID, regi_desd: 'ANDES', regi_saba: false, created_at: '2026-09-24T00:00:00Z' },
    { id_regi: REG_OCC_ID, regi_desd: 'OCCIDENTE', regi_saba: true, created_at: '2026-09-24T00:00:00Z' },
  ],
  sucursales: [
    { id_sucu: 'sucu-zulia', sucu_desc: 'ZULIA', id_regi: REG_OCC_ID },
    { id_sucu: 'sucu-falcon', sucu_desc: 'FALCON', id_regi: REG_OCC_ID },
    { id_sucu: 'sucu-carabobo', sucu_desc: 'CARABOBO', id_regi: REG_CEN_ID },
    { id_sucu: 'sucu-capital', sucu_desc: 'DISTRITO CAPITAL', id_regi: REG_CEN_ID },
  ],
  estados: [
    { id_esta: 'est-zulia', esta_desc: 'ZULIA', id_regi: REG_OCC_ID },
    { id_esta: 'est-carabobo', esta_desc: 'CARABOBO', id_regi: REG_CEN_ID },
    { id_esta: 'est-merida', esta_desc: 'MERIDA', id_regi: REG_AND_ID },
  ],
  municipios: [
    { id_muni: 'mun-mcbo', muni_desc: 'MARACAIBO', id_esta: 'est-zulia', id_regi: REG_OCC_ID },
    { id_muni: 'mun-val', muni_desc: 'VALENCIA', id_esta: 'est-carabobo', id_regi: REG_CEN_ID },
  ],
  supervisores: [
    { id_supe: 'sup-1', supe_nomb: 'JOHNATAN SOTO', supe_acti: true, id_regi: REG_OCC_ID },
    { id_supe: 'sup-2', supe_nomb: 'GREIDY HERNANDEZ', supe_acti: true, id_regi: REG_CEN_ID },
  ],
  vendedores: [
    { id_vend: 'v-1', vend_codi: '001', vend_nomb: 'MARIA BRICEÑO', vend_acti: true, id_sucu: 'sucu-zulia', id_supe: 'sup-1' },
    { id_vend: 'v-2', vend_codi: '020', vend_nomb: 'CARLOS PEREZ', vend_acti: true, id_sucu: 'sucu-carabobo', id_supe: 'sup-2' },
    { id_vend: 'v-ofi', vend_codi: '999', vend_nomb: 'OFICINA ZULIA', vend_acti: true, id_sucu: 'sucu-zulia', id_supe: 'sup-1' },
  ],
  tipificaciones: [
    { id_tipi: 'tip-1', tipi_desc: 'Tiendas Cadenas Regionales' },
    { id_tipi: 'tip-2', tipi_desc: 'Supermercados Independientes' },
  ],
  canalesComercializacion: [
    { id_cana: 'can-1', cana_desc: 'CUENTAS CLAVES' },
  ],
  productos: [
    { id_prod: 'p-1', prod_codi: '001599', prod_desc: 'MORT. NAVIDEÑA SALPICAO X KG', prod_unid: 'KG', prod_acti: true },
    { id_prod: 'p-2', prod_codi: '001642', prod_desc: 'ARVEJAS VENCAMPO 25 UND X 400GR', prod_unid: 'BULTO', prod_acti: true },
  ],
  vwProductosDetalle: [
    {
      id_prod: 'p-1',
      codigo: '001599',
      producto: 'MORT. NAVIDEÑA SALPICAO X KG',
      activo: true,
      marca: 'SALPICAO',
      marca_propia: true,
      familia: 'ESPALDAS AHUMADAS',
      grupo: 'ENTEROS',
      regiones: 'ANDES, CENTRO, OCCIDENTE',
      n_regiones: 3,
    },
    {
      id_prod: 'p-2',
      codigo: '001642',
      producto: 'ARVEJAS VENCAMPO 25 UND X 400GR',
      activo: true,
      marca: 'VENCAMPO',
      marca_propia: true,
      familia: 'ARVEJAS',
      grupo: 'NO REFRIGERADO',
      regiones: 'ANDES, OCCIDENTE',
      n_regiones: 2,
    },
  ],
  promotoras: [
    { id: 1, nombre_completo: 'NICOLE GODOY', direccion: 'CORO', correo: 'nicole@codizulca.com', categoria: 'Fijas', activo: true },
    { id: 25, nombre_completo: 'Paola Maldonado', direccion: 'Los Guayos, Valencia', correo: 'paola@codizulca.com', categoria: 'Eventuales', activo: true },
    { id: 31, nombre_completo: 'Osverlys Vera', direccion: 'El Paraíso, Caracas', correo: 'osverlys@codizulca.com', categoria: 'Merchandising', activo: true },
    { id: 23, nombre_completo: 'JOSE BARROSO', direccion: null, correo: null, categoria: 'Fijas', activo: true },
  ],
  clientes: [
    {
      id_clie: 'cli-prin',
      clie_rif: 'J-30111222-1',
      clie_nomb: 'ALKOSTO DONDE COMPRAR ES GANAR, C.A.',
      id_esta: 'est-zulia',
      id_muni: 'mun-mcbo',
      id_vend: 'v-1',
      clie_regi: REG_OCC_ID,
      clie_acti: true,
      clie_lati: 10.6544,
      clie_long: -71.6305,
      id_tipi: 'tip-1',
      id_clie_prin: 'cli-prin',
    },
    {
      id_clie: 'cli-occ-2',
      clie_rif: 'J-40111222-9',
      clie_nomb: 'INVERSIONES LA COROMOTO, C.A.',
      id_esta: 'est-zulia',
      id_muni: 'mun-mcbo',
      id_vend: 'v-1',
      clie_regi: REG_OCC_ID,
      clie_acti: true,
      clie_lati: 0,
      clie_long: 0, // Null island debe filtrarse como sin GPS
      id_tipi: 'tip-2',
    },
    {
      id_clie: 'cli-cen-1',
      clie_rif: 'J-50111222-8',
      clie_nomb: 'AUTOMERCADO VALENCIA SUR, C.A.',
      id_esta: 'est-carabobo',
      id_muni: 'mun-val',
      id_vend: 'v-2',
      clie_regi: REG_CEN_ID,
      clie_acti: true,
      clie_lati: 10.162,
      clie_long: -68.0076,
      id_tipi: 'tip-2',
    },
  ],
};

test('normalizeRegionName(): SSoT estricta de 3 regiones (OCCIDENTE, CENTRO, ANDES) + traducción segura de alias', () => {
  assert.deepEqual([...REGIONAL_SYNC_PRIORITY_QUEUE], ['OCCIDENTE', 'CENTRO', 'ANDES']);

  assert.equal(normalizeRegionName('OCCIDENTE'), 'OCCIDENTE');
  assert.equal(normalizeRegionName('  zulia '), 'OCCIDENTE');
  assert.equal(normalizeRegionName('Sucursal Zulia'), 'OCCIDENTE');
  assert.equal(normalizeRegionName('CORO'), 'OCCIDENTE');
  assert.equal(normalizeRegionName('SAN FRANCISCO'), 'OCCIDENTE');

  assert.equal(normalizeRegionName('CENTRO'), 'CENTRO');
  assert.equal(normalizeRegionName('Valencia'), 'CENTRO');
  assert.equal(normalizeRegionName('El Paraíso, Caracas'), 'CENTRO');
  assert.equal(normalizeRegionName('Turmero, Maracay'), 'CENTRO');

  assert.equal(normalizeRegionName('ANDES'), 'ANDES');
  assert.equal(normalizeRegionName('Mérida'), 'ANDES');

  assert.equal(normalizeRegionName('ORIENTE'), null);
  assert.equal(normalizeRegionName('GLOBAL'), null);
  assert.equal(normalizeRegionName(''), null);
  assert.equal(normalizeRegionName(null), null);
});

test('Hidratación de las 9 Entidades Maestras + paginación >1,000 filas sin truncamiento y GPS real', async () => {
  // Generar 2,450 clientes para verificar paginación automática (> 1,000 filas por página PostgREST)
  const pagedClientes = Array.from({ length: 2450 }, (_, idx) => ({
    id_clie: `cli-page-${idx + 1}`,
    clie_rif: `J-${String(10000000 + idx)}`,
    clie_nomb: idx === 0 ? 'SUPERMERCADO MÉRIDA EXPRESS, C.A.' : `PDV ACTIVO ${idx + 1}, C.A.`,
    id_esta: idx % 2 === 0 ? 'est-zulia' : 'est-carabobo',
    id_muni: idx % 2 === 0 ? 'mun-mcbo' : 'mun-val',
    id_vend: idx % 2 === 0 ? 'v-1' : 'v-2',
    clie_regi: idx % 2 === 0 ? REG_OCC_ID : REG_CEN_ID,
    clie_acti: true,
    clie_lati: idx < 1500 ? 10.65 : idx < 1600 ? 0 : null,
    clie_long: idx < 1500 ? -71.63 : idx < 1600 ? 0 : null,
    id_tipi: 'tip-1',
    id_clie_prin: idx < 5 ? 'cli-page-1' : null,
  }));

  const tableStore: Record<string, unknown[]> = {
    Regiones: FULL_ERP_FIXTURE.regiones,
    Sucursales: FULL_ERP_FIXTURE.sucursales,
    Estados: FULL_ERP_FIXTURE.estados,
    Municipios: FULL_ERP_FIXTURE.municipios,
    Supervisores: FULL_ERP_FIXTURE.supervisores,
    Vendedores: FULL_ERP_FIXTURE.vendedores,
    Forecast_Vendedores_Excluidos: [],
    Tipificacion_Clientes: FULL_ERP_FIXTURE.tipificaciones,
    Canal_Comercializacion: FULL_ERP_FIXTURE.canalesComercializacion!,
    Clientes: pagedClientes,
    Productos: FULL_ERP_FIXTURE.productos!,
    vw_productos_detalle: FULL_ERP_FIXTURE.vwProductosDetalle!,
    promotoras: FULL_ERP_FIXTURE.promotoras!,
  };

  let clientRangeCalls = 0;
  const mockAdminClient = {
    from(table: string) {
      let fromIdx = 0;
      let toIdx = 999;
      const builder = {
        select() {
          return builder;
        },
        range(from: number, to: number) {
          fromIdx = from;
          toIdx = to;
          if (table === 'Clientes') clientRangeCalls += 1;
          return builder;
        },
        then<TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: { data: unknown; error: null; count: number }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          const all = tableStore[table] ?? [];
          return Promise.resolve({
            data: all.slice(fromIdx, toIdx + 1),
            error: null,
            count: all.length,
          }).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  const snap = await loadErpMasterSnapshotFromClient(mockAdminClient);

  // Verificación de paginación: 2,450 filas requieren exactamente 3 páginas de 1,000 (0-999, 1000-1999, 2000-2999)
  assert.equal(clientRangeCalls, 3);
  assert.equal(snap.clientes.length, 2450);
  assert.equal(snap.countsExact?.clientesActivos, 2450);
  assert.equal(snap.countsExact?.clientesConGps, 1500, 'Debe excluir Null Island (0, 0) y nulls del conteo GPS');

  // Exactamente 3 regiones ordenadas OCCIDENTE -> CENTRO -> ANDES
  assert.deepEqual(
    snap.regiones?.map((r) => r.codigo),
    ['OCCIDENTE', 'CENTRO', 'ANDES']
  );
  assert.equal(snap.regiones?.[0]?.regi_saba, true);
  assert.equal(snap.regiones?.[1]?.regi_saba, false);

  // Resto de las 9 entidades maestras pobladas (> 0)
  assert.equal(snap.productos?.length, 2);
  assert.equal(snap.productos?.[0]?.unidad_medida, 'BULTO'); // ARVEJAS ordenado alfabéticamente primero
  assert.equal(snap.supervisores?.length, 2);
  assert.equal(snap.promotoras?.length, 4);
  assert.equal(snap.vendedores.length, 2, 'OFICINA ZULIA debe quedar depurada');
  assert.ok((snap.cadenas?.length ?? 0) >= 2);
  assert.ok((snap.zonas?.length ?? 0) >= 2);

  // Promotoras: correo leído + región resuelta desde dirección (Caracas -> CENTRO, Coro -> OCCIDENTE; null -> cuarentena)
  const promByName = new Map(snap.promotoras!.map((p) => [p.nombre_completo, p]));
  assert.equal(promByName.get('NICOLE GODOY')?.email, 'nicole@codizulca.com');
  assert.equal(promByName.get('NICOLE GODOY')?.region_id, REG_OCC_ID);
  assert.equal(promByName.get('Osverlys Vera')?.region_id, REG_CEN_ID);
  assert.equal(promByName.get('Osverlys Vera')?.categoria, 'Merchandising');
  assert.equal(promByName.get('JOSE BARROSO')?.region_id, null);
});

test('Endpoints BFF /api/maestros/*: sirven las 9 entidades, filtran por OCCIDENTE/CENTRO/ANDES y bloquean cruce (403)', async () => {
  const regiones = normalizeErpRegionesDataset(FULL_ERP_FIXTURE.regiones);
  const productos = normalizeErpProductosDataset(
    FULL_ERP_FIXTURE.productos,
    FULL_ERP_FIXTURE.vwProductosDetalle
  );
  const supervisores = normalizeErpSupervisoresDataset(
    FULL_ERP_FIXTURE.supervisores,
    FULL_ERP_FIXTURE.regiones
  );
  const promotoras = normalizeErpPromotorasDataset(
    FULL_ERP_FIXTURE.promotoras!,
    FULL_ERP_FIXTURE.regiones
  );
  const cadenas = normalizeErpCadenasDataset(FULL_ERP_FIXTURE);
  const zonas = normalizeErpZonasDataset(FULL_ERP_FIXTURE);
  const clientes = normalizeErpClientesDataset(FULL_ERP_FIXTURE);
  const { vendedores, auditoria: vendedoresAuditoria } =
    buildAuditedErpVendedoresDataset(FULL_ERP_FIXTURE);

  const gateway: MasterDataErpGateway = {
    async loadSnapshot() {
      return {
        regiones,
        productos,
        supervisores,
        promotoras,
        cadenas,
        zonas,
        clientes,
        vendedores,
        vendedoresAuditoria,
        sedesResumen: computeClientesSummaryBySede(clientes, vendedores),
        resumenRegional: computeMasterEntitiesSummaryByRegion({
          regiones,
          clientes,
          promotoras,
          supervisores,
          vendedores,
          cadenas,
          zonas,
        }),
        fetchedAtMs: Date.now(),
        source: 'supabase_erp_clientes',
      };
    },
  };

  const handlers = createMasterDataErpHandlers(gateway);
  const app = express();
  registerMasterDataErpRoutes(app, {
    rateLimiter: createRateLimiter({ name: 'test-full-maestros', windowMs: 60_000, maxRequests: 60 }),
    authMiddleware: (req, res, next) => {
      const auth = String(req.headers.authorization || '');
      if (auth === 'Bearer admin-jwt') {
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
      if (auth === 'Bearer occ-jwt') {
        req.authUser = {
          id: 'u-occ',
          email: 'coord.occ@codizulca.com',
          appRole: 'coordinacion',
          sucursal: 'ZULIA',
        };
        next();
        return;
      }
      res.status(401).json({ error: 'Token requerido', code: 'AUTH_TOKEN_MISSING' });
    },
    listClientesHandler: handlers.handleListClientesMaestros,
    listVendedoresHandler: handlers.handleListVendedoresMaestros,
    sedesResumenHandler: handlers.handleGetSedesClientesResumen,
    bootstrapHandler: handlers.handleBootstrapMaestros,
    listRegionesHandler: handlers.handleListRegionesMaestras,
    listProductosHandler: handlers.handleListProductosMaestros,
    listSupervisoresHandler: handlers.handleListSupervisoresMaestros,
    listPromotorasHandler: handlers.handleListPromotorasMaestras,
    listCadenasHandler: handlers.handleListCadenasComerciales,
    listZonasHandler: handlers.handleListZonasComerciales,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Bootstrap global (admin): devuelve todas las 9 entidades pobladas
    const bootRes = await fetch(`${base}/api/maestros/bootstrap`, {
      headers: { Authorization: 'Bearer admin-jwt' },
    });
    assert.equal(bootRes.status, 200);
    const bootJson = (await bootRes.json()) as {
      counts: Record<string, number>;
      data: Record<string, unknown[]>;
    };
    assert.equal(bootJson.counts.regiones, 3);
    assert.equal(bootJson.counts.productos, 2);
    assert.equal(bootJson.counts.clientesActivos, 3);
    assert.equal(bootJson.counts.clientesConGps, 2);
    assert.equal(bootJson.counts.promotoras, 4);
    assert.equal(bootJson.counts.supervisores, 2);
    assert.equal(bootJson.counts.vendedores, 2);
    assert.ok(bootJson.counts.cadenas >= 2);
    assert.ok(bootJson.counts.zonas >= 2);

    // 2. Filtro por región CENTRO (admin)
    const centroCli = await fetch(`${base}/api/maestros/clientes?region=CENTRO`, {
      headers: { Authorization: 'Bearer admin-jwt' },
    });
    assert.equal(centroCli.status, 200);
    const centroJson = (await centroCli.json()) as { total: number; conGps: number };
    assert.equal(centroJson.total, 1);
    assert.equal(centroJson.conGps, 1);

    // 3. Filtro por región ANDES (admin): 0 clientes, 2 productos nacionales siguen visibles
    const andesCli = await fetch(`${base}/api/maestros/clientes?region=ANDES`, {
      headers: { Authorization: 'Bearer admin-jwt' },
    });
    assert.equal(andesCli.status, 200);
    assert.equal(((await andesCli.json()) as { total: number }).total, 0);

    const prodsRes = await fetch(`${base}/api/maestros/productos`, {
      headers: { Authorization: 'Bearer admin-jwt' },
    });
    assert.equal(prodsRes.status, 200);
    assert.equal(((await prodsRes.json()) as { total: number }).total, 2);

    // 4. Búsqueda con ", C.A." e insensible a tildes
    const searchRes = await fetch(
      `${base}/api/maestros/clientes?busqueda=${encodeURIComponent('ALKOSTO DONDE COMPRAR ES GANAR, C.A.')}`,
      { headers: { Authorization: 'Bearer admin-jwt' } }
    );
    assert.equal(searchRes.status, 200);
    assert.equal(((await searchRes.json()) as { total: number }).total, 1);

    // 5. Aislamiento fail-closed: coordinadora de OCCIDENTE intentando leer CENTRO -> 403
    const crossRegion = await fetch(`${base}/api/maestros/clientes?region=CENTRO`, {
      headers: { Authorization: 'Bearer occ-jwt' },
    });
    assert.equal(crossRegion.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Cero errores silenciados: servicios propagan fallos HTTP/RLS en lugar de devolver []', async () => {
  clearMasterCatalogCaches();
  clearMasterDataCaches();

  const failingClient = {
    from() {
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
        range() {
          return builder;
        },
        then<TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: { data: null; error: { code: string; message: string } }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          return Promise.resolve({
            data: null,
            error: { code: '42501', message: 'permission denied for table Regiones' },
          }).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient<MasterDataDatabase>;

  await assert.rejects(
    () => obtenerRegionesMaestras({ forzarRefresco: true, client: failingClient }),
    /permission denied/i
  );
  await assert.rejects(
    () => obtenerProductosMaestros({ forzarRefresco: true, client: failingClient }),
    /permission denied/i
  );
  await assert.rejects(
    () => obtenerSupervisoresMaestros({ forzarRefresco: true, client: failingClient }),
    /permission denied/i
  );
  await assert.rejects(
    () => obtenerPromotorasMaestras({ forzarRefresco: true, client: failingClient }),
    /permission denied/i
  );
  await assert.rejects(
    () => obtenerClientesMaestros({ forzarRefresco: true }, failingClient),
    /permission denied/i
  );
  await assert.rejects(
    () => obtenerCadenasComerciales({ forzarRefresco: true }, failingClient),
    /permission denied/i
  );
  await assert.rejects(
    () => obtenerZonasComerciales({ forzarRefresco: true }, failingClient),
    /permission denied/i
  );
});

test('sanitizeLegacyRegionalStorage(): limpia claves legadas ZULIA/vacías preservando tema y sesión Auth', () => {
  const makeMockStorage = (initial: Record<string, string>): Storage => {
    const map = new Map(Object.entries(initial));
    return {
      get length() {
        return map.size;
      },
      clear() {
        map.clear();
      },
      getItem(k: string) {
        return map.get(k) ?? null;
      },
      key(i: number) {
        return Array.from(map.keys())[i] ?? null;
      },
      removeItem(k: string) {
        map.delete(k);
      },
      setItem(k: string, v: string) {
        map.set(k, v);
      },
    };
  };

  const ls = makeMockStorage({
    'codizulca.ui_theme': 'dark',
    'codizulca.supabase.auth.v1': '{"access_token":"keep"}',
    'trade.active_sucursal': 'ZULIA',
    'trade.master_clientes_cache': '[]',
  });
  const ss = makeMockStorage({
    'sede_activa_legacy': 'VALENCIA',
  });

  const report = sanitizeLegacyRegionalStorage({ localStorageImpl: ls, sessionStorageImpl: ss });
  assert.ok(report.removedKeys.includes('trade.active_sucursal'));
  assert.ok(report.removedKeys.includes('trade.master_clientes_cache'));
  assert.ok(report.removedKeys.includes('sede_activa_legacy'));
  assert.equal(ls.getItem('codizulca.ui_theme'), 'dark');
  assert.equal(ls.getItem('codizulca.supabase.auth.v1'), '{"access_token":"keep"}');
});
