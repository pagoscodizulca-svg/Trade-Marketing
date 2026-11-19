import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import type { MasterDataDatabase, Cliente, CadenaComercial, ZonaComercial, Vendedor } from '../src/types/masterData';
import type { ScheduledVisit, Store, User } from '../src/types';
import {
  analyzeMigrations,
  formatIssues,
  type MigrationFile,
} from './support/sqlMigrationAnalyzer';
import { MOCK_PUBLIC_ANON_KEY } from './antigravity_audit/localMockInfra';
import {
  cambiarEstadoCadenaComercial,
  cambiarEstadoClienteMaestro,
  cambiarEstadoVendedorMaestro,
  cambiarEstadoZonaComercial,
  guardarCadenaComercial,
  guardarClienteMaestro,
  guardarVendedorMaestro,
  guardarZonaComercial,
  invalidarCacheMaestros,
  mapearClienteMaestroAStore,
  obtenerCadenasComerciales,
  obtenerZonasComerciales,
} from '../src/services/masterDataSyncService';
import {
  buildBatchFillPlan,
  buildMatrixUpsertRowFromVisit,
  classifyVisitsForLogicalCancel,
  filterMatrixVisits,
  mergeMasterStoresWithFallback,
  normalizeSearchText,
  persistMatrixLogicalCancel,
  persistMatrixUpsertBatch,
  resolveRealPromotoraForMatrix,
  UNASSIGNED_PROMOTORA_LABEL,
} from '../src/services/scheduleMatrixService';
import { MODULE_ALLOWED_ROLES } from '../src/components/common/Header';
import { runStaticCertification } from '../scripts/certifySchemaProduction';

const ROOT_DIR = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'supabase', 'migrations');
const HITO3_MIGRATION = '20261118000600_hito3_maestros_cadenas_zonas_y_rpc_matriz.sql';

const UUID_CADENA_1 = '11111111-1111-4111-8111-111111111101';
const UUID_ZONA_1 = '22222222-2222-4222-8222-222222222201';
const UUID_CLIENTE_1 = '33333333-3333-4333-8333-333333333301';
const UUID_VENDEDOR_1 = '44444444-4444-4444-8444-444444444401';
const UUID_PROM_1 = '55555555-5555-4555-8555-555555555501';
const UUID_PROM_2 = '55555555-5555-4555-8555-555555555502';
const UUID_CRON_1 = '66666666-6666-4666-8666-666666666601';
const UUID_CRON_2 = '66666666-6666-4666-8666-666666666602';
const UUID_CRON_HIST = '66666666-6666-4666-8666-666666666603';

function loadAllMigrations(): MigrationFile[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

async function startMockPostgrestServer(
  handler: (
    req: RecordedRequest,
    res: http.ServerResponse
  ) => void
): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsedBody: unknown = null;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }
      const recorded: RecordedRequest = {
        method: req.method || 'GET',
        url: req.url || '/',
        body: parsedBody,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function makeVisit(overrides: Partial<ScheduledVisit>): ScheduledVisit {
  return {
    id: UUID_CRON_1,
    cronogramaId: UUID_CRON_1,
    date: '2026-11-20',
    dayLabel: 'Viernes 20/11',
    shift: 'MAÑANA',
    storeId: UUID_CLIENTE_1,
    storeName: 'SUPER TIENDAS MARÍA PIÑA',
    zone: 'MARACAIBO NORTE',
    productFocus: 'MORTADELA',
    fillProductSelection: 'MORTADELA',
    fillQuantityInput: '2',
    promotoraId: UUID_PROM_1,
    promotoraName: 'María Piña',
    sellerName: 'CARLOS PÉREZ',
    plannedUnits: 2,
    mortadelaQty: 2,
    espaldaQty: 0,
    arrozQty: 0,
    azucarGrams: 0,
    lecheGrams: 0,
    status: 'PENDIENTE',
    ...overrides,
  };
}

test('Hito 3.1: Migración SQL 20261118000600 idempotente, RLS multi-sucursal y cero DELETE físico', () => {
  const migrations = loadAllMigrations();
  const hito3 = migrations.find((m) => m.name === HITO3_MIGRATION);
  assert.ok(hito3, `Debe existir la migración ${HITO3_MIGRATION}`);

  const analysis = analyzeMigrations(migrations);
  assert.equal(
    analysis.errors.length,
    0,
    `Todas las migraciones deben pasar el analizador sin errores:\n${formatIssues(analysis.errors)}`
  );

  // Certificador estático también debe aprobar con la migración 20 incluida
  const staticCert = runStaticCertification(MIGRATIONS_DIR);
  assert.equal(staticCert.passed, true, 'Certificador estático debe retornar passed=true');
  assert.ok(staticCert.migrationCount >= 20, 'Debe detectar al menos 20 migraciones SQL');

  const sql = hito3!.sql;

  // 1. Tablas maestras cadenas_comerciales y zonas con aislamiento multi-sucursal
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.cadenas_comerciales/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.zonas/i);
  assert.match(sql, /ALTER TABLE public\.cadenas_comerciales ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE public\.cadenas_comerciales FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE public\.zonas ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE public\.zonas FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.cadenas_comerciales FROM PUBLIC, anon/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.zonas FROM PUBLIC, anon/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.cadenas_comerciales TO authenticated/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.zonas TO authenticated/i);
  assert.doesNotMatch(
    sql,
    /GRANT[^\n;]*DELETE[^\n;]*(cadenas_comerciales|zonas)/i,
    'No debe otorgarse GRANT DELETE sobre maestros'
  );

  // 2. Extensión no destructiva de public.clientes
  assert.match(sql, /ALTER TABLE public\.clientes[\s\S]*ADD COLUMN IF NOT EXISTS cadena_id UUID/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS zona_id UUID/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS radio_geocerca_m INTEGER/i);
  assert.match(sql, /idx_clientes_cadena_id/i);
  assert.match(sql, /idx_clientes_zona_id/i);

  // 3. RPCs de matriz: upsert + cancelación lógica pura (cero DELETE)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_upsert_matriz_cronograma_lote/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_cancelar_matriz_cronograma_lote/i);
  assert.match(sql, /en_historial\s*=\s*true/i);
  assert.match(sql, /estado\s*=\s*'CANCELADA'/i);
  assert.doesNotMatch(
    sql,
    /DELETE\s+FROM\s+public\.(cronograma_degustaciones|rutas_promotoras|clientes|cadenas_comerciales|zonas)/i,
    'La migración Hito 3 jamás debe ejecutar DELETE físico sobre cronograma, rutas o maestros'
  );
});

test('Hito 3.2 (B-05): CRUD de Maestros (cadenas, zonas, clientes, vendedores) sin DELETE físico + mapeo Store + RBAC', async () => {
  invalidarCacheMaestros();

  const cadenasDb = new Map<string, CadenaComercial>();
  const zonasDb = new Map<string, ZonaComercial>();
  const clientesDb = new Map<string, Cliente>();
  const vendedoresDb = new Map<string, Vendedor>();

  const mock = await startMockPostgrestServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const p = parsedUrl.pathname;
    const body = (req.body || {}) as Record<string, unknown>;

    if (p.endsWith('/rest/v1/cadenas_comerciales')) {
      if (req.method === 'GET') {
        return sendJson(res, 200, Array.from(cadenasDb.values()));
      }
      if (req.method === 'POST') {
        const row: CadenaComercial = {
          id: UUID_CADENA_1,
          codigo: String(body.codigo),
          nombre: String(body.nombre),
          tipo_canal: String(body.tipo_canal || 'Supermercado'),
          sucursal: (body.sucursal as 'ZULIA' | 'VALENCIA') || 'ZULIA',
          activo: body.activo !== false,
          metadata: {},
          created_at: '2026-11-18T10:00:00Z',
          updated_at: '2026-11-18T10:00:00Z',
        };
        cadenasDb.set(row.id, row);
        return sendJson(res, 201, row);
      }
      if (req.method === 'PATCH') {
        const existing = cadenasDb.get(UUID_CADENA_1)!;
        const updated = { ...existing, ...body };
        cadenasDb.set(UUID_CADENA_1, updated as CadenaComercial);
        return sendJson(res, 200, updated);
      }
    }

    if (p.endsWith('/rest/v1/zonas')) {
      if (req.method === 'GET') {
        return sendJson(res, 200, Array.from(zonasDb.values()));
      }
      if (req.method === 'POST') {
        const row: ZonaComercial = {
          id: UUID_ZONA_1,
          codigo: String(body.codigo),
          nombre: String(body.nombre),
          ciudad: (body.ciudad as string | null) ?? null,
          estado: (body.estado as string | null) ?? null,
          sucursal: (body.sucursal as 'ZULIA' | 'VALENCIA') || 'ZULIA',
          activo: body.activo !== false,
          metadata: {},
          created_at: '2026-11-18T10:00:00Z',
          updated_at: '2026-11-18T10:00:00Z',
        };
        zonasDb.set(row.id, row);
        return sendJson(res, 201, row);
      }
      if (req.method === 'PATCH') {
        const existing = zonasDb.get(UUID_ZONA_1)!;
        const updated = { ...existing, ...body };
        zonasDb.set(UUID_ZONA_1, updated as ZonaComercial);
        return sendJson(res, 200, updated);
      }
    }

    if (p.endsWith('/rest/v1/clientes')) {
      if (req.method === 'POST') {
        const row: Cliente = {
          id: UUID_CLIENTE_1,
          codigo_cliente: String(body.codigo_cliente),
          rif: (body.rif as string | null) ?? null,
          razon_social: String(body.razon_social),
          nombre_comercial: (body.nombre_comercial as string | null) ?? null,
          canal: (body.canal as string | null) ?? null,
          segmento: (body.segmento as string | null) ?? null,
          zona: (body.zona as string | null) ?? null,
          ruta: (body.ruta as string | null) ?? null,
          direccion: (body.direccion as string | null) ?? null,
          ciudad: (body.ciudad as string | null) ?? null,
          estado: (body.estado as string | null) ?? null,
          telefono: (body.telefono as string | null) ?? null,
          latitud: (body.latitud as number | null) ?? null,
          longitud: (body.longitud as number | null) ?? null,
          cadena_id: (body.cadena_id as string | null) ?? null,
          zona_id: (body.zona_id as string | null) ?? null,
          radio_geocerca_m: Number(body.radio_geocerca_m ?? 150),
          sucursal: (body.sucursal as 'ZULIA' | 'VALENCIA') || 'ZULIA',
          vendedor_id: (body.vendedor_id as string | null) ?? null,
          codigo_vendedor: (body.codigo_vendedor as string | null) ?? null,
          activo: body.activo !== false,
          metadata: {},
          ultima_sincronizacion: '2026-11-18T10:00:00Z',
          created_at: '2026-11-18T10:00:00Z',
          updated_at: '2026-11-18T10:00:00Z',
        };
        clientesDb.set(row.id, row);
        return sendJson(res, 201, row);
      }
      if (req.method === 'PATCH') {
        const existing = clientesDb.get(UUID_CLIENTE_1)!;
        const updated = { ...existing, ...body };
        clientesDb.set(UUID_CLIENTE_1, updated as Cliente);
        return sendJson(res, 200, updated);
      }
    }

    if (p.endsWith('/rest/v1/vendedores')) {
      if (req.method === 'POST') {
        const row: Vendedor = {
          id: UUID_VENDEDOR_1,
          codigo_vendedor: String(body.codigo_vendedor),
          nombre_completo: String(body.nombre_completo),
          documento_identidad: (body.documento_identidad as string | null) ?? null,
          telefono: (body.telefono as string | null) ?? null,
          email: (body.email as string | null) ?? null,
          zona: (body.zona as string | null) ?? null,
          supervisor: (body.supervisor as string | null) ?? null,
          activo: body.activo !== false,
          metadata: {},
          ultima_sincronizacion: '2026-11-18T10:00:00Z',
          created_at: '2026-11-18T10:00:00Z',
          updated_at: '2026-11-18T10:00:00Z',
        };
        vendedoresDb.set(row.id, row);
        return sendJson(res, 201, row);
      }
      if (req.method === 'PATCH') {
        const existing = vendedoresDb.get(UUID_VENDEDOR_1)!;
        const updated = { ...existing, ...body };
        vendedoresDb.set(UUID_VENDEDOR_1, updated as Vendedor);
        return sendJson(res, 200, updated);
      }
    }

    return sendJson(res, 404, { message: `Route not mocked: ${req.method} ${p}` });
  });

  try {
    const client = createClient<MasterDataDatabase>(mock.baseUrl, MOCK_PUBLIC_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Cadenas Comerciales CRUD
    const cadena = await guardarCadenaComercial(
      {
        codigo: 'cad-01',
        nombre: 'Supermercados Fiorella',
        tipo_canal: 'Supermercado',
        sucursal: 'ZULIA',
      },
      client
    );
    assert.equal(cadena.codigo, 'CAD-01');
    const cadenasList = await obtenerCadenasComerciales({ forzarRefresco: true }, client);
    assert.equal(cadenasList.length, 1);
    const cadenaInactiva = await cambiarEstadoCadenaComercial(UUID_CADENA_1, false, client);
    assert.equal(cadenaInactiva.activo, false);

    // Zonas CRUD
    const zona = await guardarZonaComercial(
      {
        codigo: 'zn-mcbo-n',
        nombre: 'Maracaibo Norte',
        ciudad: 'Maracaibo',
        estado: 'Zulia',
        sucursal: 'ZULIA',
      },
      client
    );
    assert.equal(zona.codigo, 'ZN-MCBO-N');
    const zonasList = await obtenerZonasComerciales({ forzarRefresco: true }, client);
    assert.equal(zonasList.length, 1);
    const zonaInactiva = await cambiarEstadoZonaComercial(UUID_ZONA_1, false, client);
    assert.equal(zonaInactiva.activo, false);

    // Vendedores CRUD
    const vendedor = await guardarVendedorMaestro(
      {
        codigo_vendedor: 'v-010',
        nombre_completo: 'Carlos Pérez',
        zona: 'Maracaibo Norte',
        sucursal: 'ZULIA',
      },
      client
    );
    assert.equal(vendedor.codigo_vendedor, 'V-010');
    const vendedorInactivo = await cambiarEstadoVendedorMaestro(UUID_VENDEDOR_1, false, client);
    assert.equal(vendedorInactivo.activo, false);

    // Clientes CRUD con cadena_id, zona_id, GPS y radio_geocerca_m
    await assert.rejects(
      () =>
        guardarClienteMaestro(
          {
            codigo_cliente: 'CLI-BAD',
            razon_social: 'Cliente Radio Inválido',
            radio_geocerca_m: 10, // menor al mínimo 25 m
          },
          client
        ),
      /25 m/i,
      'Zod debe rechazar radio_geocerca_m < 25'
    );

    const cliente = await guardarClienteMaestro(
      {
        codigo_cliente: 'cli-100',
        razon_social: 'Inversiones Fiorella C.A.',
        nombre_comercial: 'Fiorella Amparo',
        canal: 'Supermercado',
        zona: 'Maracaibo Norte',
        ciudad: 'Maracaibo',
        latitud: 10.67123,
        longitud: -71.63542,
        cadena_id: UUID_CADENA_1,
        zona_id: UUID_ZONA_1,
        radio_geocerca_m: 250,
        vendedor_id: UUID_VENDEDOR_1,
        codigo_vendedor: 'V-010',
        sucursal: 'ZULIA',
      },
      client
    );
    assert.equal(cliente.radio_geocerca_m, 250);
    assert.equal(cliente.cadena_id, UUID_CADENA_1);
    assert.equal(cliente.zona_id, UUID_ZONA_1);

    const clienteInactivo = await cambiarEstadoClienteMaestro(UUID_CLIENTE_1, false, client);
    assert.equal(clienteInactivo.activo, false);

    // CERO peticiones HTTP DELETE en todo el flujo de maestros
    const deleteCalls = mock.requests.filter((r) => r.method === 'DELETE');
    assert.equal(deleteCalls.length, 0, 'Ninguna operación de maestros debe emitir HTTP DELETE');

    // Adaptador mapearClienteMaestroAStore
    const mappedStore = mapearClienteMaestroAStore(cliente, {
      cadenaNombre: 'Supermercados Fiorella',
      zonaNombre: 'Maracaibo Norte',
    });
    assert.equal(mappedStore.geofenceRadiusMeters, 250);
    assert.equal(mappedStore.cadenaId, UUID_CADENA_1);
    assert.equal(mappedStore.cadenaName, 'Supermercados Fiorella');
    assert.equal(mappedStore.zonaId, UUID_ZONA_1);
    assert.equal(mappedStore.sucursal, 'ZULIA');

    // mergeMasterStoresWithFallback prioriza maestros y deduplica por código y nombre normalizado
    const fallbackStores: Store[] = [
      {
        ...mappedStore,
        id: 'fallback_dup_code',
        name: 'FIORELLA AMPARO DUP',
        geofenceRadiusMeters: 0,
      },
      {
        ...mappedStore,
        id: 'fallback_dup_name',
        clientCode: 'OTHER-CODE',
        name: 'fiorella ámpáro', // coincide en NFD
      },
      {
        id: 'fallback_extra',
        name: 'Bodegón El Milagro',
        clientCode: 'CLI-999',
        address: 'Av. El Milagro',
        zone: 'Maracaibo Este',
        city: 'Maracaibo',
        latitude: null,
        longitude: null,
        geofenceRadiusMeters: 0,
        sellerName: 'ANA GÓMEZ',
        channel: 'Minimarket',
      },
    ];
    const merged = mergeMasterStoresWithFallback([mappedStore], fallbackStores);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!.id, UUID_CLIENTE_1);
    assert.equal(merged[0]!.geofenceRadiusMeters, 250);
    assert.equal(merged[1]!.id, 'fallback_extra');

    // Wiring y RBAC del módulo 'maestros'
    assert.deepEqual(
      [...MODULE_ALLOWED_ROLES.maestros].sort(),
      ['coordinacion', 'super_admin']
    );
    const appContextSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/context/AppContext.tsx'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
    const headerSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/common/Header.tsx'), 'utf8');
    assert.match(appContextSrc, /useMasterData\(/, 'AppContext debe consumir useMasterData');
    assert.match(appContextSrc, /mergeMasterStoresWithFallback\(/);
    assert.match(appSrc, /MasterDataManagementView/);
    assert.match(appSrc, /activeTab === 'maestros'/);
    assert.match(headerSrc, /id:\s*'maestros'/);
    assert.match(headerSrc, /<RoleGuard[^>]*allowedRoles=\{MODULE_ALLOWED_ROLES\[item\.id\]\}/);
  } finally {
    await mock.close();
  }
});

test('Hito 3.3 (B-06): Lógica pura de Matriz, búsqueda NFD, productos secundarios y cero IDs hardcodeados', () => {
  // 1. Verificación estática: cero usr_prom_01 ni st_custom_ en ScheduleMatrixView y AppContext
  const scheduleSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/schedule/ScheduleMatrixView.tsx'),
    'utf8'
  );
  const appContextSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/context/AppContext.tsx'),
    'utf8'
  );

  assert.doesNotMatch(
    scheduleSrc,
    /usr_prom_01|st_custom_/,
    'ScheduleMatrixView.tsx no debe contener IDs hardcodeados usr_prom_01 ni st_custom_'
  );
  assert.doesNotMatch(
    appContextSrc,
    /usr_prom_01|st_custom_/,
    'AppContext.tsx no debe contener IDs hardcodeados usr_prom_01 ni st_custom_'
  );

  // 2. Normalización NFD insensible a tildes
  assert.equal(normalizeSearchText('  María   Piña  '), 'maria pina');
  assert.equal(normalizeSearchText('Jamón Cocido'), 'jamon cocido');

  // 3. filterMatrixVisits: rango de fechas + productos secundarios (JAMON, SALCHICHA) + tildes
  const sampleVisits: ScheduledVisit[] = [
    makeVisit({
      id: UUID_CRON_1,
      date: '2026-11-19',
      storeName: 'Supermercados María Piña',
      productFocus: 'JAMON COCIDO SUPERIOR',
      fillProductSelection: 'JAMON',
      promotoraName: 'Sofía Ñáñez',
    }),
    makeVisit({
      id: UUID_CRON_2,
      date: '2026-11-25',
      storeName: 'Abasto La Concepción',
      productFocus: 'SALCHICHA VIENA',
      fillProductSelection: 'SALCHICHA',
      promotoraName: 'Laura Méndez',
    }),
  ];

  const baseCriteria = {
    selectedDay: 'TODOS',
    matrixDateFrom: '',
    matrixDateTo: '',
    selectedShift: 'TODOS',
    selectedProduct: 'TODOS',
    searchQuery: '',
    currentWeekBounds: { mondayYmd: '2026-11-16', sundayYmd: '2026-11-22' },
    rollingWeekBounds: { mondayYmd: '2026-11-16', sundayYmd: '2026-11-22' },
    currentYearMonth: '2026-11',
  };

  const byAccent = filterMatrixVisits(sampleVisits, {
    ...baseCriteria,
    searchQuery: 'maria pina',
  });
  assert.equal(byAccent.length, 1);
  assert.equal(byAccent[0]!.id, UUID_CRON_1);

  const bySecondaryProduct = filterMatrixVisits(sampleVisits, {
    ...baseCriteria,
    selectedProduct: 'SALCHICHA',
  });
  assert.equal(bySecondaryProduct.length, 1);
  assert.equal(bySecondaryProduct[0]!.id, UUID_CRON_2);

  const byDateRange = filterMatrixVisits(sampleVisits, {
    ...baseCriteria,
    matrixDateFrom: '18-11-2026',
    matrixDateTo: '21-11-2026',
  });
  assert.equal(byDateRange.length, 1);
  assert.equal(byDateRange[0]!.id, UUID_CRON_1);

  // 4. buildBatchFillPlan: sin usr_prom_01 y sin duplicar promotora en el mismo turno
  const users: User[] = [
    { id: UUID_PROM_1, name: 'María Piña', email: 'm@c.com', role: 'promotora', assignedZone: 'ZULIA' },
    { id: UUID_PROM_2, name: 'Laura Méndez', email: 'l@c.com', role: 'promotora', assignedZone: 'ZULIA' },
  ];
  const stores: Store[] = [
    {
      id: UUID_CLIENTE_1,
      name: 'Fiorella Amparo',
      clientCode: 'CLI-100',
      address: 'Av. Amparo',
      zone: 'MARACAIBO NORTE',
      city: 'Maracaibo',
      latitude: 10.67,
      longitude: -71.63,
      geofenceRadiusMeters: 250,
      sellerName: 'CARLOS PÉREZ',
      channel: 'Supermercado',
    },
    {
      id: '33333333-3333-4333-8333-333333333302',
      name: 'Fiorella 18 de Octubre',
      clientCode: 'CLI-101',
      address: '18 de Octubre',
      zone: 'MARACAIBO NORTE',
      city: 'Maracaibo',
      latitude: 10.68,
      longitude: -71.61,
      geofenceRadiusMeters: 150,
      sellerName: 'CARLOS PÉREZ',
      channel: 'Supermercado',
    },
    {
      id: '33333333-3333-4333-8333-333333333303',
      name: 'Fiorella Delicias',
      clientCode: 'CLI-102',
      address: 'Delicias',
      zone: 'MARACAIBO NORTE',
      city: 'Maracaibo',
      latitude: 10.66,
      longitude: -71.62,
      geofenceRadiusMeters: 150,
      sellerName: 'CARLOS PÉREZ',
      channel: 'Supermercado',
    },
  ];

  const plan = buildBatchFillPlan({
    existingVisits: [],
    stores,
    users,
    storeIds: stores.map((s) => s.id),
    product: 'MORTADELA',
    quantityInput: '2',
    shift: 'MAÑANA',
    dayLabel: 'Viernes 20/11',
    date: '2026-11-20',
  });

  assert.equal(plan.countCreated, 3);
  assert.equal(plan.countUpdated, 0);
  const assignedIds = plan.affectedVisits.map((v) => v.promotoraId);
  assert.deepEqual(assignedIds, [UUID_PROM_1, UUID_PROM_2, '']);
  assert.equal(plan.affectedVisits[2]!.promotoraName, UNASSIGNED_PROMOTORA_LABEL);

  const fallbackProm = resolveRealPromotoraForMatrix([], 'Inexistente');
  assert.equal(fallbackProm.promotoraId, '');
  assert.equal(fallbackProm.promotoraName, UNASSIGNED_PROMOTORA_LABEL);

  // 5. classifyVisitsForLogicalCancel separa activos, locales e históricos/completados
  const visitsForCancel: ScheduledVisit[] = [
    makeVisit({ id: UUID_CRON_1, cronogramaId: UUID_CRON_1, status: 'PENDIENTE', enHistorial: false }),
    makeVisit({ id: 'vis_local_temp_1', cronogramaId: undefined, status: 'PENDIENTE', enHistorial: false }),
    makeVisit({ id: UUID_CRON_HIST, cronogramaId: UUID_CRON_HIST, status: 'COMPLETADA', enHistorial: true }),
  ];
  const classified = classifyVisitsForLogicalCancel(visitsForCancel, [
    UUID_CRON_1,
    'vis_local_temp_1',
    UUID_CRON_HIST,
  ]);
  assert.deepEqual(classified.cancelableCronogramaIds, [UUID_CRON_1]);
  assert.deepEqual(classified.localOnlyIds, ['vis_local_temp_1']);
  assert.deepEqual(classified.preservedHistoricalIds, [UUID_CRON_HIST]);
});

test('Hito 3.4 (B-06): Persistencia RPC en Supabase, propagación de errores para reversión y cancelación lógica sin DELETE', async () => {
  let mode: 'rpc_ok' | 'rpc_conflict' | 'rpc_missing_fallback' = 'rpc_ok';

  const mock = await startMockPostgrestServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const p = parsedUrl.pathname;

    if (p.endsWith('/rest/v1/rpc/rpc_upsert_matriz_cronograma_lote')) {
      if (mode === 'rpc_conflict') {
        return sendJson(res, 409, {
          code: '23505',
          message: 'Conflicto: la promotora ya tiene una degustación activa en esa fecha y turno.',
        });
      }
      const body = req.body as { p_filas: Array<Record<string, unknown>> };
      const filas = (body.p_filas || []).map((f, idx) => ({
        id: idx === 0 ? UUID_CRON_1 : UUID_CRON_2,
        client_temp_id: f.client_temp_id ?? null,
        cliente_nombre: f.cliente_nombre,
        fecha: f.fecha,
        turno: f.turno,
        estado: f.promotora_id ? 'APROBADA' : 'PENDIENTE_APROBACION',
        promotora_id: f.promotora_id ?? null,
        promotora_nombre: f.promotora_id ? 'María Piña' : 'POR ASIGNAR',
        sucursal: 'ZULIA',
      }));
      return sendJson(res, 200, {
        ok: true,
        insertadas: filas.length,
        actualizadas: 0,
        filas,
      });
    }

    if (p.endsWith('/rest/v1/rpc/rpc_cancelar_matriz_cronograma_lote')) {
      if (mode === 'rpc_missing_fallback') {
        return sendJson(res, 404, {
          code: 'PGRST202',
          message: 'Could not find the function public.rpc_cancelar_matriz_cronograma_lote in the schema cache',
        });
      }
      const body = req.body as { p_ids: string[] };
      return sendJson(res, 200, {
        ok: true,
        canceladas: (body.p_ids || []).length,
        preservadas_historicas: 0,
        ids_cancelados: body.p_ids || [],
      });
    }

    if (p.endsWith('/rest/v1/cronograma_degustaciones') && req.method === 'PATCH') {
      const body = req.body as Record<string, unknown>;
      assert.equal(body.estado, 'CANCELADA');
      assert.equal(body.en_historial, true);
      return sendJson(res, 200, [{ id: UUID_CRON_1 }]);
    }

    if (p.endsWith('/rest/v1/rutas_promotoras') && req.method === 'PATCH') {
      const body = req.body as Record<string, unknown>;
      assert.equal(body.estado_ruta, 'CANCELADA');
      return sendJson(res, 200, [{ id: 'ruta-1' }]);
    }

    return sendJson(res, 404, { message: `Unhandled ${req.method} ${p}` });
  });

  try {
    const client = createClient(mock.baseUrl, MOCK_PUBLIC_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const rowPayload = buildMatrixUpsertRowFromVisit(
      makeVisit({ id: 'vis_pending_temp_1', cronogramaId: undefined }),
      { clientCode: 'CLI-100', clientTempId: 'vis_pending_temp_1' }
    );
    assert.equal(rowPayload.id, null);
    assert.equal(rowPayload.promotora_id, UUID_PROM_1);

    // 1. Upsert exitoso vía RPC
    mode = 'rpc_ok';
    const upsertRes = await persistMatrixUpsertBatch([rowPayload], client);
    assert.equal(upsertRes.ok, true);
    assert.equal(upsertRes.insertadas, 1);
    assert.equal(upsertRes.filas[0]!.id, UUID_CRON_1);
    assert.equal(upsertRes.filas[0]!.client_temp_id, 'vis_pending_temp_1');

    // 2. Conflicto / RLS -> lanza error para que AppContext ejecute rollback optimista
    mode = 'rpc_conflict';
    await assert.rejects(
      () => persistMatrixUpsertBatch([rowPayload], client),
      /Conflicto: la promotora ya tiene/i
    );

    // 3. Cancelación lógica vía RPC
    mode = 'rpc_ok';
    const cancelRpc = await persistMatrixLogicalCancel([UUID_CRON_1], 'CANCELACION_MATRIZ', client);
    assert.equal(cancelRpc.ok, true);
    assert.equal(cancelRpc.canceladas, 1);
    assert.deepEqual(cancelRpc.ids_cancelados, [UUID_CRON_1]);

    // 4. Respaldo lógico si la RPC aún no existe en una instancia previa (solo PATCH, 0 DELETE)
    mode = 'rpc_missing_fallback';
    const cancelFallback = await persistMatrixLogicalCancel(
      [UUID_CRON_1, UUID_CRON_2],
      'CANCELACION_MATRIZ',
      client
    );
    assert.equal(cancelFallback.ok, true);
    assert.equal(cancelFallback.canceladas, 1);
    assert.equal(cancelFallback.preservadas_historicas, 1);

    // Aserción de seguridad: CERO HTTP DELETE en todo el ciclo
    const deleteCalls = mock.requests.filter((r) => r.method === 'DELETE');
    assert.equal(deleteCalls.length, 0, 'persistMatrixLogicalCancel jamás debe emitir HTTP DELETE');
  } finally {
    await mock.close();
  }
});
