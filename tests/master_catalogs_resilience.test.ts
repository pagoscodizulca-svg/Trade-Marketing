import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MasterDataDatabase } from '../src/types/masterData';
import {
  MASTER_SELECT_COLUMNS,
  MasterDataDiagnosticError,
  classifyMasterDataError,
  clearMasterCatalogRuntimeCaches,
  deduplicateMasterRequest,
  executeWithSessionRefreshRetry,
  fetchPaginatedPostgrestTable,
  loadSharedDirectErpDataset,
  redactMasterDataSecrets,
  requireAuthenticatedMasterToken,
} from '../src/services/masterCatalogsService';
import {
  clearMasterDataCaches,
  loadMasterCatalogs,
  refreshMasterCatalogs,
} from '../src/services/masterDataSyncService';
import {
  ServerMasterDataError,
  createDefaultMasterDataErpGateway,
  createMasterDataErpHandlers,
  invalidateMasterDataErpServerCache,
  type MasterDataErpGateway,
} from '../src/server/masterDataErpHandler';
import {
  createRateLimiter,
  getAdminSupabaseClient,
  isValidServerServiceRoleKey,
} from '../src/server/supabaseAdminAuth';
import { registerMasterDataErpRoutes } from '../server';
import { calculateMultiProductSupplies } from '../src/utils/productionSuppliesCalculator';
import { buildBatchFillPlan, buildMatrixUpsertRowFromVisit } from '../src/services/scheduleMatrixService';

function buildUnsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature_placeholder_for_unit_test`;
}

function createAuthMockClient(options: {
  initialToken?: string | null;
  refreshedToken?: string | null;
  onRefresh?: () => void;
}): SupabaseClient {
  let currentToken = options.initialToken ?? null;
  return {
    auth: {
      async getSession() {
        return {
          data: {
            session: currentToken ? { access_token: currentToken } : null,
          },
          error: null,
        };
      },
      async refreshSession() {
        options.onRefresh?.();
        currentToken = options.refreshedToken ?? null;
        return {
          data: {
            session: currentToken ? { access_token: currentToken } : null,
          },
          error: currentToken ? null : { message: 'Refresh failed' },
        };
      },
    },
  } as unknown as SupabaseClient;
}

test('Anti-anon gate: bloquea lectura cuando no existe sesión autenticada y clasifica AUTH_REQUIRED', async () => {
  const unauthClient = createAuthMockClient({ initialToken: null });
  let queryExecuted = false;

  await assert.rejects(
    async () => {
      await requireAuthenticatedMasterToken(unauthClient, 'clientes', {
        enforceInNodeTest: true,
      });
      queryExecuted = true;
    },
    (err: unknown) => {
      assert.ok(err instanceof MasterDataDiagnosticError);
      assert.equal(err.categoryCode, 'AUTH_REQUIRED');
      assert.equal(err.status, 401);
      assert.equal(err.entity, 'clientes');
      return true;
    }
  );
  assert.equal(queryExecuted, false, 'Nunca debe ejecutar consulta PostgREST sin JWT authenticated');
});

test('Reintento único de sesión: refresca 1 vez ante 401/JWT expired y evita bucles infinitos', async () => {
  const expiredToken = buildUnsignedJwt({
    role: 'authenticated',
    sub: 'user-1',
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const freshToken = buildUnsignedJwt({
    role: 'authenticated',
    sub: 'user-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  let refreshCount = 0;
  let attempts = 0;
  const client = createAuthMockClient({
    initialToken: expiredToken,
    refreshedToken: freshToken,
    onRefresh: () => {
      refreshCount += 1;
    },
  });

  const result = await executeWithSessionRefreshRetry(
    client,
    'vendedores',
    async (token) => {
      attempts += 1;
      if (attempts === 1) {
        assert.equal(token, expiredToken);
        throw { code: 'PGRST301', status: 401, message: 'JWT expired' };
      }
      assert.equal(token, freshToken);
      return ['ok'];
    },
    { enforceInNodeTest: true }
  );

  assert.deepEqual(result, ['ok']);
  assert.equal(refreshCount, 1);
  assert.equal(attempts, 2);

  // Caso fallido: si refreshSession devuelve null, falla limpiamente con AUTH_REQUIRED
  let failedRefreshCalls = 0;
  const failingClient = createAuthMockClient({
    initialToken: expiredToken,
    refreshedToken: null,
    onRefresh: () => {
      failedRefreshCalls += 1;
    },
  });

  await assert.rejects(
    async () => {
      await executeWithSessionRefreshRetry(
        failingClient,
        'clientes',
        async () => {
          throw { code: 'PGRST301', status: 401, message: 'JWT expired' };
        },
        { enforceInNodeTest: true }
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof MasterDataDiagnosticError);
      assert.equal(err.categoryCode, 'AUTH_REQUIRED');
      assert.equal(err.status, 401);
      return true;
    }
  );
  assert.equal(failedRefreshCalls, 1);
});

test('Clasificación de errores y redacción de secretos en diagnóstico seguro', () => {
  const jwt = buildUnsignedJwt({ role: 'authenticated', sub: 'u-123' });
  const rawSensitive = `Bearer ${jwt} sb_secret_FAKE1234567890 sb_publishable_PUB99999 postgres://user:pass@db.internal:5432/postgres`;
  const redacted = redactMasterDataSecrets(rawSensitive);

  assert.ok(!redacted.includes(jwt));
  assert.ok(!redacted.includes('sb_secret_FAKE1234567890'));
  assert.ok(!redacted.includes('sb_publishable_PUB99999'));
  assert.ok(!redacted.includes('user:pass@db.internal'));

  assert.equal(
    classifyMasterDataError({ code: '42501', message: 'permission denied for table Clientes' }, { entity: 'clientes' })
      .categoryCode,
    'RLS_42501'
  );
  assert.equal(
    classifyMasterDataError({ code: 'PGRST205', message: 'Could not find the table public.clientes' }, { entity: 'clientes' })
      .categoryCode,
    'SCHEMA_PGRST'
  );
  assert.equal(
    classifyMasterDataError({ status: 503, code: 'MASTER_DATA_UPSTREAM_ERROR', message: 'upstream' }, { entity: 'zonas' })
      .categoryCode,
    'UPSTREAM_503'
  );
  assert.equal(
    classifyMasterDataError(new TypeError('Failed to fetch'), { entity: 'cadenas' }).categoryCode,
    'NETWORK_ERR'
  );
  assert.equal(
    classifyMasterDataError({ code: 'ENV_MISSING', message: 'Falta VITE_SUPABASE_URL' }, { entity: 'vendedores' })
      .categoryCode,
    'ENV_MISSING'
  );
});

test('Paginación determinística > 1,000 filas: lee 2,450 filas sin recorte con .order() y .range()', async () => {
  const totalRows = 2450;
  const allRows = Array.from({ length: totalRows }, (_, i) => ({
    id_clie: `clie-${String(i + 1).padStart(5, '0')}`,
    clie_nomb: `CLIENTE ${i + 1}`,
  }));

  const recordedRanges: Array<[number, number]> = [];
  const recordedOrders: Array<{ col: string; asc: boolean }> = [];

  const mockClient = {
    from(table: string) {
      assert.equal(table, 'Clientes');
      return {
        select(cols: string) {
          assert.equal(cols, MASTER_SELECT_COLUMNS.erpClientes);
          return {
            order(col: string, opts: { ascending: boolean }) {
              recordedOrders.push({ col, asc: opts.ascending });
              return {
                async range(from: number, to: number) {
                  recordedRanges.push([from, to]);
                  return {
                    data: allRows.slice(from, to + 1),
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient<MasterDataDatabase>;

  const rows = await fetchPaginatedPostgrestTable<{ id_clie: string; clie_nomb: string }>(
    mockClient,
    {
      table: 'Clientes',
      select: MASTER_SELECT_COLUMNS.erpClientes,
      orderBy: 'id_clie',
      entity: 'clientes',
    }
  );

  assert.equal(rows.length, totalRows);
  assert.deepEqual(recordedRanges, [
    [0, 999],
    [1000, 1999],
    [2000, 2999],
  ]);
  assert.equal(recordedOrders.length, 3);
  assert.ok(recordedOrders.every((o) => o.col === 'id_clie' && o.asc === true));
  assert.equal(rows[0]?.id_clie, 'clie-00001');
  assert.equal(rows[2449]?.id_clie, 'clie-02450');
});

test('Deduplicación en vuelo, caché ERP compartida de 5 min y purga limpia en clearMasterCatalogRuntimeCaches', async () => {
  clearMasterDataCaches();
  clearMasterCatalogRuntimeCaches();

  // 1. Deduplicación directa de llamadas concurrentes
  let factoryExecutions = 0;
  const [r1, r2, r3] = await Promise.all([
    deduplicateMasterRequest('same-key', async () => {
      factoryExecutions += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return 'shared-result';
    }),
    deduplicateMasterRequest('same-key', async () => {
      factoryExecutions += 1;
      return 'should-not-run';
    }),
    deduplicateMasterRequest('same-key', async () => {
      factoryExecutions += 1;
      return 'should-not-run-2';
    }),
  ]);
  assert.equal(r1, 'shared-result');
  assert.equal(r2, 'shared-result');
  assert.equal(r3, 'shared-result');
  assert.equal(factoryExecutions, 1);

  // 2. loadSharedDirectErpDataset deduplica 4 llamadas paralelas y cachea resultado hasta purga
  const tableHits = new Map<string, number>();
  const erpMockClient = {
    from(table: string) {
      return {
        select() {
          return {
            order() {
              return {
                async range(from: number) {
                  tableHits.set(table, (tableHits.get(table) ?? 0) + 1);
                  if (from > 0) return { data: [], error: null };
                  if (table === 'Regiones') {
                    return { data: [{ id_regi: 'r1', regi_desd: 'OCCIDENTE', regi_saba: true }], error: null };
                  }
                  if (table === 'Vendedores') {
                    return {
                      data: [{ id_vend: 'v1', vend_codi: '001', vend_nomb: 'ANA', vend_acti: true, id_sucu: 's1', id_supe: null }],
                      error: null,
                    };
                  }
                  if (table === 'Clientes') {
                    return {
                      data: [
                        {
                          id_clie: 'c1',
                          clie_rif: 'J-1',
                          clie_nomb: 'CENTRAL MADEIRENSE',
                          id_esta: 'e1',
                          id_vend: 'v1',
                          id_muni: 'm1',
                          clie_regi: 'r1',
                          clie_acti: true,
                          clie_lati: 10.65,
                          clie_long: -71.63,
                          id_tipi: 't1',
                          id_clie_prin: 'c1',
                        },
                      ],
                      error: null,
                    };
                  }
                  return { data: [], error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient<MasterDataDatabase>;

  const [d1, d2, d3, d4] = await Promise.all([
    loadSharedDirectErpDataset(erpMockClient, { useSingletonCache: true }),
    loadSharedDirectErpDataset(erpMockClient, { useSingletonCache: true }),
    loadSharedDirectErpDataset(erpMockClient, { useSingletonCache: true }),
    loadSharedDirectErpDataset(erpMockClient, { useSingletonCache: true }),
  ]);

  assert.equal(tableHits.get('Clientes'), 1, 'Las 4 consultas paralelas deben compartir 1 sola lectura ERP de Clientes');
  assert.equal(d1.clientes.length, 1);
  assert.equal(d2.clientes.length, 1);
  assert.equal(d3.clientes.length, 1);
  assert.equal(d4.clientes.length, 1);

  // Cache hit subsecuente (0 consultas nuevas)
  await loadSharedDirectErpDataset(erpMockClient, { useSingletonCache: true });
  assert.equal(tableHits.get('Clientes'), 1);

  // Purga (simula SIGNED_OUT) -> próxima lectura sí vuelve a consultar
  clearMasterCatalogRuntimeCaches();
  await loadSharedDirectErpDataset(erpMockClient, { useSingletonCache: true });
  assert.equal(tableHits.get('Clientes'), 2);
});

test('Resiliencia parcial en loadMasterCatalogs / refreshMasterCatalogs con Promise.allSettled', async () => {
  clearMasterDataCaches();
  const makeQueryChain = (resolver: () => Promise<{ data: unknown[] | null; error: unknown | null }>) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.order = self;
    chain.range = () => chain;
    chain.eq = self;
    chain.ilike = self;
    chain.or = self;
    chain.then = (resolve: (val: unknown) => void, reject: (err: unknown) => void) =>
      resolver().then(resolve, reject);
    return chain;
  };

  const mockClient = {
    from(table: string) {
      return {
        select(cols: string) {
          assert.ok(cols !== '*', `No debe emitir select('*') sobre ${table}`);
          return makeQueryChain(async () => {
            if (table === 'vendedores') {
              return {
                data: [
                  {
                    id: '11111111-1111-4111-8111-111111111111',
                    codigo_vendedor: 'V001',
                    nombre_completo: 'CARLOS PEREZ',
                    zona: 'ZULIA',
                    activo: true,
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                  },
                ],
                error: null,
              };
            }
            if (table === 'clientes') {
              return {
                data: [
                  {
                    id: '22222222-2222-4222-8222-222222222222',
                    codigo_cliente: 'C001',
                    razon_social: 'AUTOMERCADO ZULIA C.A.',
                    zona: 'MARACAIBO',
                    activo: true,
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                  },
                ],
                error: null,
              };
            }
            if (table === 'cadenas_comerciales') {
              return {
                data: [
                  {
                    id: '33333333-3333-4333-8333-333333333333',
                    codigo: 'CAD-01',
                    nombre: 'FIORELLA',
                    tipo_canal: 'SUPERMERCADO',
                    activo: true,
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                  },
                ],
                error: null,
              };
            }
            if (table === 'zonas') {
              return {
                data: null,
                error: { code: '42501', message: 'permission denied for table zonas' },
              };
            }
            return { data: [], error: null };
          });
        },
      };
    },
  } as unknown as SupabaseClient<MasterDataDatabase>;

  const result = await loadMasterCatalogs({ supabaseClient: mockClient });
  assert.equal(result.ok, false);
  assert.equal(result.vendedores.length, 1);
  assert.equal(result.clientes.length, 1);
  assert.equal(result.cadenas.length, 1);
  assert.equal(result.zonas.length, 0);
  assert.equal(result.errorCodes.zonas, 'RLS_42501');
  assert.equal(result.primaryErrorCode, 'RLS_42501');
  assert.ok(result.errors.zonas?.includes('permission denied'));
  assert.equal(result.errors.clientes, undefined);

  const refreshed = await refreshMasterCatalogs({ supabaseClient: mockClient });
  assert.equal(refreshed.clientes.length, 1);
  assert.equal(refreshed.errorCodes.zonas, 'RLS_42501');
});

test('BFF Express: propaga código estructurado (RLS_42501 / ENV_MISSING) sin catch silencioso ni filtración de secretos', async () => {
  const failingGateway: MasterDataErpGateway = {
    async loadSnapshot() {
      throw new ServerMasterDataError({
        message: 'permission denied for table Clientes (token Bearer eyJabc.def.ghi)',
        categoryCode: 'RLS_42501',
        technicalCode: '42501',
        httpStatus: 403,
        table: 'Clientes',
      });
    },
  };

  const handlers = createMasterDataErpHandlers(failingGateway);

  const app = express();
  app.use(express.json());
  registerMasterDataErpRoutes(app, {
    rateLimiter: createRateLimiter({ name: 'test-resilience', windowMs: 60_000, maxRequests: 100 }),
    authMiddleware: (req, _res, next) => {
      req.authUser = {
        id: 'user-auth-1',
        email: 'coord@empresa.com',
        appRole: 'super_admin',
        sucursal: 'GLOBAL',
        isSuperAdmin: true,
        accessToken: buildUnsignedJwt({ role: 'authenticated', sub: 'user-auth-1' }),
      };
      next();
    },
    bootstrapHandler: handlers.handleBootstrapMaestros,
    listRegionesHandler: handlers.handleListRegionesMaestras,
    listProductosHandler: handlers.handleListProductosMaestros,
    listSupervisoresHandler: handlers.handleListSupervisoresMaestros,
    listPromotorasHandler: handlers.handleListPromotorasMaestras,
    listCadenasHandler: handlers.handleListCadenasComerciales,
    listZonasHandler: handlers.handleListZonasComerciales,
    listClientesHandler: handlers.handleListClientesMaestros,
    listVendedoresHandler: handlers.handleListVendedoresMaestros,
    sedesResumenHandler: handlers.handleGetSedesClientesResumen,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${baseUrl}/api/maestros/clientes`, {
      headers: { Authorization: 'Bearer dummy-token' },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.code, 'RLS_42501');
    assert.equal(body.technicalCode, '42501');
    assert.equal(body.entity, 'clientes');
    assert.equal(typeof body.error, 'string');
    assert.ok(!JSON.stringify(body).includes('eyJabc.def.ghi'), 'Nunca filtrar tokens en respuesta HTTP');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('BFF default gateway: funciona sin SUPABASE_SERVICE_ROLE_KEY usando JWT del usuario bajo RLS', async () => {
  invalidateMasterDataErpServerCache();

  const receivedAuthHeaders: string[] = [];
  const mockPostgrest = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    receivedAuthHeaders.push(auth);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const tablePath = decodeURIComponent(url.pathname.replace(/^\/rest\/v1\//, ''));

    res.setHeader('Content-Type', 'application/json');
    if (tablePath === 'Regiones') {
      res.end(JSON.stringify([{ id_regi: 'reg-1', regi_desd: 'OCCIDENTE', regi_saba: true }]));
      return;
    }
    if (tablePath === 'Sucursales') {
      res.end(JSON.stringify([{ id_sucu: 's-1', sucu_desc: 'ZULIA', id_regi: 'reg-1' }]));
      return;
    }
    if (tablePath === 'Supervisores') {
      res.end(
        JSON.stringify([{ id_supe: 'sup-1', supe_nomb: 'NELSON FINOL', supe_acti: true, id_regi: 'reg-1' }])
      );
      return;
    }
    if (tablePath === 'Vendedores') {
      res.end(
        JSON.stringify([
          { id_vend: 'v-1', vend_codi: '001', vend_nomb: 'MARIA', vend_acti: true, id_sucu: 's-1', id_supe: 'sup-1' },
        ])
      );
      return;
    }
    if (tablePath === 'Clientes') {
      res.end(
        JSON.stringify([
          {
            id_clie: 'c-1',
            clie_rif: 'J-001',
            clie_nomb: 'SUPERMERCADO ZULIA',
            id_esta: null,
            id_vend: 'v-1',
            id_muni: null,
            clie_regi: 'reg-1',
            clie_acti: true,
            clie_lati: 10.65,
            clie_long: -71.63,
            id_tipi: null,
            id_clie_prin: null,
          },
        ])
      );
      return;
    }
    res.end(JSON.stringify([]));
  });

  await new Promise<void>((resolve) => mockPostgrest.listen(0, '127.0.0.1', resolve));
  const pgAddr = mockPostgrest.address();
  assert.ok(pgAddr && typeof pgAddr === 'object');

  const prevUrl = process.env.SUPABASE_URL;
  const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevPub = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const prevAnon = process.env.SUPABASE_ANON_KEY;

  process.env.SUPABASE_URL = `http://127.0.0.1:${pgAddr.port}`;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test_only_key';
  delete process.env.SUPABASE_ANON_KEY;

  const userJwt = buildUnsignedJwt({ role: 'authenticated', sub: 'user-rls-test' });

  try {
    const gateway = createDefaultMasterDataErpGateway(60_000);
    const snap = await gateway.loadSnapshot({
      forceRefresh: true,
      accessToken: userJwt,
      userId: 'user-rls-test',
    });

    assert.equal(snap.clientes.length, 1);
    assert.equal(snap.vendedores.length, 1);
    assert.ok(receivedAuthHeaders.length >= 3);
    assert.ok(
      receivedAuthHeaders.every((h) => h === `Bearer ${userJwt}`),
      'Todas las consultas del fallback deben enviar el Authorization: Bearer <userJwt> bajo RLS'
    );
  } finally {
    invalidateMasterDataErpServerCache();
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevService;
    if (prevPub === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = prevPub;
    if (prevAnon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = prevAnon;
    await new Promise<void>((resolve) => mockPostgrest.close(() => resolve()));
  }
});

test('Guardia anti-anon en servidor: rechaza llaves públicas/anon en SUPABASE_SERVICE_ROLE_KEY y degrada a JWT authenticated bajo RLS', async () => {
  const anonJwt = buildUnsignedJwt({ role: 'anon', iss: 'supabase' });
  const serviceJwt = buildUnsignedJwt({ role: 'service_role', iss: 'supabase' });

  assert.equal(isValidServerServiceRoleKey('sb_publishable_fake_public_key_123456', 'https://demo.supabase.co'), false);
  assert.equal(isValidServerServiceRoleKey(anonJwt, 'https://demo.supabase.co'), false);
  assert.equal(isValidServerServiceRoleKey('placeholder_key', 'https://demo.supabase.co'), false);
  assert.equal(isValidServerServiceRoleKey('sb_secret_real_server_key_1234567890', 'https://demo.supabase.co'), true);
  assert.equal(isValidServerServiceRoleKey(serviceJwt, 'https://demo.supabase.co'), true);

  const prevUrl = process.env.SUPABASE_URL;
  const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    process.env.SUPABASE_URL = 'https://apaxdgxtaoeyswlfblgi.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_publishable_wrongly_placed_in_service_key_12345';
    assert.equal(
      getAdminSupabaseClient(),
      null,
      'Nunca debe crear adminClient con una llave sb_publishable_* (causaría 42501 anon)'
    );

    process.env.SUPABASE_SERVICE_ROLE_KEY = anonJwt;
    assert.equal(
      getAdminSupabaseClient(),
      null,
      'Nunca debe crear adminClient con un JWT anon (causaría 42501 anon)'
    );
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevService;
  }
});

test('Módulo 2 Multiselección de Productos: agrega insumos y persiste productos[] sin exceder límites Zod', () => {
  const chosen = [
    'MORTADELA ASTURIAS 0.900 KG',
    'ARROZ BLANCO VENCAMPO 24X1KG',
    'ESPALDA AHUMADA ASTURIAS',
  ];
  const calc = calculateMultiProductSupplies(chosen, '2');
  assert.equal(calc.mortadelaQty, 2);
  assert.equal(calc.arrozQty, 2);
  assert.equal(calc.espaldaQty, 2);
  assert.equal(calc.azucarGrams, 1200);
  assert.equal(calc.lecheGrams, 1200);
  assert.equal(calc.plannedUnits, 6);
  assert.equal(calc.rowHighlight, 'green');
  assert.equal(calc.productFocus, chosen.join(' + '));

  const plan = buildBatchFillPlan({
    existingVisits: [],
    stores: [
      {
        id: 'store-1',
        clientCode: 'C-001',
        name: 'SUPERMERCADO ZULIA C.A.',
        address: 'MARACAIBO',
        zone: 'ZULIA',
        city: 'MARACAIBO',
        latitude: 10.65,
        longitude: -71.63,
        geofenceRadiusMeters: 150,
        sellerName: 'MARIA BRICEÑO',
        channel: 'Supermercado',
      },
    ],
    users: [],
    storeIds: ['store-1'],
    product: chosen.join(' + '),
    products: chosen,
    quantityInput: '2',
    shift: 'MAÑANA',
    dayLabel: 'Lunes 23/11',
    date: '2026-11-23',
  });

  assert.equal(plan.countCreated, 1);
  const createdVisit = plan.affectedVisits[0]!;
  assert.deepEqual(createdVisit.selectedProducts, chosen);

  // También verifica truncado seguro de producto_resumen (<= 160 chars) con muchos productos seleccionados
  const manyProducts = Array.from({ length: 10 }, (_, i) => `PRODUCTO DE DEGUSTACION EXTENSO NUMERO ${i + 1}`);
  const row = buildMatrixUpsertRowFromVisit({
    ...createdVisit,
    selectedProducts: manyProducts,
    productFocus: manyProducts.join(' + '),
  });
  assert.equal(row.productos.length, 10);
  assert.ok(row.producto_resumen.length <= 160);
});

test('Auditoría estática de migración SQL y script ejecutable (solo authenticated, sin anon, sin DDL destructivo)', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261129000100_fix_catalogos_maestros_rls_authenticated.sql'
  );
  const standalonePath = path.resolve(process.cwd(), 'sql/fix_catalogos_maestros_rls.sql');

  for (const filePath of [migrationPath, standalonePath]) {
    assert.ok(fs.existsSync(filePath), `Debe existir ${filePath}`);
    const sql = fs.readFileSync(filePath, 'utf8');
    const sqlWithoutComments = sql
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\r\n]*/g, '');

    assert.match(sqlWithoutComments, /GRANT\s+USAGE\s+ON\s+SCHEMA\s+public\s+TO\s+authenticated/i);
    assert.match(sqlWithoutComments, /REVOKE\s+ALL\s+ON\s+TABLE[\s\S]+FROM\s+PUBLIC,\s*anon/i);
    assert.match(sqlWithoutComments, /GRANT\s+SELECT\s+ON\s+TABLE[\s\S]+TO\s+authenticated/i);
    assert.match(sqlWithoutComments, /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    assert.match(sqlWithoutComments, /FOR\s+SELECT\s+TO\s+authenticated/i);
    assert.match(sqlWithoutComments, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i);

    assert.doesNotMatch(
      sqlWithoutComments,
      /\bFOR\s+SELECT\s+TO\s+(anon|public)\b/i,
      'Prohibido abrir políticas a anon/public'
    );
    assert.doesNotMatch(
      sqlWithoutComments,
      /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
      'Prohibido desactivar RLS'
    );
    assert.doesNotMatch(
      sqlWithoutComments,
      /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bTRUNCATE\b/i,
      'Prohibido DDL destructivo'
    );
    assert.doesNotMatch(
      sqlWithoutComments,
      /\buser_metadata\b/i,
      'Prohibido usar user_metadata para autorización'
    );
    assert.doesNotMatch(
      sqlWithoutComments,
      /\bauth\.role\s*\(\)/i,
      'Prohibido usar auth.role() deprecado'
    );
  }

  const standaloneSql = fs.readFileSync(standalonePath, 'utf8');
  assert.match(standaloneSql, /FROM\s+pg_policies/i, 'El script debe incluir verificación de pg_policies');
  assert.match(standaloneSql, /information_schema\.role_table_grants/i, 'El script debe verificar grants anon vs authenticated');
  assert.match(standaloneSql, /COUNT\(\*\)/i, 'El script debe incluir conteo COUNT(*) por tabla');
});
