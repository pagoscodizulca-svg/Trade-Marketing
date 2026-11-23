import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { analyzeMigrations, formatIssues, type MigrationFile } from './support/sqlMigrationAnalyzer';
import { runStaticCertification } from '../scripts/certifySchemaProduction';
import { LRUCache } from '../src/utils/lruCache';
import {
  ALLOWED_REGIONS,
  PROMOTORA_CATEGORIAS,
  PromotoraCategoriaStrictSchema,
  PromotoraFilterSchema,
  PromotoraUpsertSchema,
  REGIONAL_SYNC_PRIORITY_QUEUE,
  computePromotorasCategoryStats,
  filterPromotorasByRegionAndCategory,
} from '../src/utils/regionalSyncClassifier';
import {
  RegionalAuthorizationError,
  assertRegionalProfileAccess,
  clearMasterDataCaches,
  coincideBusquedaComercialNormalizada,
  configureMasterDataCaches,
  construirFiltroOrBusquedaClientes,
  getMasterDataCacheMetrics,
  invalidarCacheMaestros,
  obtenerCatalogoRegionesOficiales,
  obtenerClientesMaestros,
  obtenerClientesPorPerfilRegional,
  sanitizarTerminoBusquedaComercial,
  sincronizarClientesPorPerfilRegional,
  type AllowedRegionCode,
  type MasterDataDatabase,
} from '../src/services/masterDataSyncService';
import {
  createPromotorasHandlers,
  type PromotoraServerRecord,
  type PromotorasGateway,
} from '../src/server/promotorasHandler';
import { createMemoryRateLimitStore, createRateLimiter } from '../src/server/supabaseAdminAuth';
import { registerPromotorasRoutes } from '../server';
import { MasterEntitiesSyncPanel } from '../src/components/masters/MasterEntitiesSyncPanel';
import { SucursalPersonalModule } from '../src/components/admin/SucursalPersonalModule';
import { startLocalMockInfra } from './antigravity_audit/localMockInfra';
import { createClient } from '@supabase/supabase-js';

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const PHASE2_SQL_FILE = '20261125000100_fase2_regiones_clientes_y_promotoras_categorias.sql';

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * Cliente Supabase simulado en memoria para probar:
 *  - resolución dinámica de `"Regiones"` (`id_regi`, `regi_desd`, `regi_saba`),
 *  - upsert idempotente por `codigo_cliente`,
 *  - fallos parciales por lote y consultas filtradas por `region_id`.
 */
function createInMemoryRegionalSupabaseMock(options?: {
  failBatchPredicate?: (rows: Array<Record<string, unknown>>) => boolean;
}) {
  // UUIDs sintéticos generados únicamente dentro del entorno de pruebas
  const regionesTable = [
    {
      id_regi: '11111111-1111-4111-8111-000000000003',
      created_at: '2026-01-01T00:00:00Z',
      regi_desd: 'ANDES',
      regi_saba: false,
    },
    {
      id_regi: '11111111-1111-4111-8111-000000000002',
      created_at: '2026-01-01T00:00:00Z',
      regi_desd: 'CENTRO',
      regi_saba: false,
    },
    {
      id_regi: '11111111-1111-4111-8111-000000000001',
      created_at: '2026-01-01T00:00:00Z',
      regi_desd: 'OCCIDENTE',
      regi_saba: true,
    },
    // Fila no oficial que debe ser ignorada por el catálogo estricto
    {
      id_regi: '11111111-1111-4111-8111-000000000099',
      created_at: '2026-01-01T00:00:00Z',
      regi_desd: 'ORIENTE',
      regi_saba: false,
    },
  ];

  const clientesByCode = new Map<string, Record<string, unknown>>();
  let idCounter = 1;
  let regionesSelectCalls = 0;
  let clientesSelectCalls = 0;
  const upsertLog: Array<{ regionIds: string[]; count: number }> = [];

  const client = {
    from(table: string) {
      if (table === 'Regiones') {
        return {
          select() {
            regionesSelectCalls += 1;
            return Promise.resolve({ data: [...regionesTable], error: null });
          },
        };
      }

      if (table === 'clientes') {
        return {
          upsert(rows: Array<Record<string, unknown>>) {
            if (options?.failBatchPredicate?.(rows)) {
              return Promise.resolve({
                data: null,
                error: { message: 'Simulated partial batch constraint error' },
              });
            }
            upsertLog.push({
              regionIds: Array.from(new Set(rows.map((r) => String(r.region_id ?? '')))),
              count: rows.length,
            });
            for (const row of rows) {
              const code = String(row.codigo_cliente);
              const existing = clientesByCode.get(code);
              clientesByCode.set(code, {
                id: existing?.id ?? `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`,
                ...existing,
                ...row,
              });
            }
            return Promise.resolve({ data: rows, error: null });
          },
          select() {
            clientesSelectCalls += 1;
            const filters: Array<(r: Record<string, unknown>) => boolean> = [];
            const builder: Record<string, unknown> = {
              order() {
                return builder;
              },
              range() {
                return builder;
              },
              eq(col: string, val: unknown) {
                filters.push((r) => r[col] === val);
                return builder;
              },
              ilike(col: string, pat: string) {
                const needle = pat.replace(/%/g, '').toLowerCase();
                filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle));
                return builder;
              },
              or(expr: string) {
                // Evalúa comodines simples preservando comillas dobles PostgREST
                filters.push((r) => {
                  const hay = `${r.codigo_cliente ?? ''} ${r.razon_social ?? ''} ${r.nombre_comercial ?? ''} ${r.rif ?? ''}`;
                  const m = expr.match(/razon_social\.ilike\.("([^"]+)"|([^,]+))/);
                  const rawPat = (m?.[2] ?? m?.[3] ?? '').replace(/^%|%$/g, '');
                  const regexStr = rawPat
                    .replace(/[.*+?^${}()|[\]]/g, '\\$&')
                    .replace(/\\%/g, '%')
                    .replace(/\\_/g, '_')
                    .replace(/%/g, '.*');
                  return new RegExp(regexStr, 'i').test(hay);
                });
                return builder;
              },
              then(resolve: (val: unknown) => void) {
                const out = Array.from(clientesByCode.values()).filter((r) =>
                  filters.every((fn) => fn(r))
                );
                resolve({ data: out, error: null });
              },
            };
            return builder;
          },
        };
      }

      throw new Error(`Tabla no esperada en mock: ${table}`);
    },
  } as unknown as SupabaseClient<MasterDataDatabase>;

  return {
    client,
    clientesByCode,
    upsertLog,
    getRegionesSelectCalls: () => regionesSelectCalls,
    getClientesSelectCalls: () => clientesSelectCalls,
    regionIdsByCode: {
      OCCIDENTE: '11111111-1111-4111-8111-000000000001',
      CENTRO: '11111111-1111-4111-8111-000000000002',
      ANDES: '11111111-1111-4111-8111-000000000003',
    } as Record<AllowedRegionCode, string>,
  };
}

// =============================================================================
// 1. CACHÉ LRU ACOTADA, TTL, MÉTRICAS E INVALIDACIÓN SELECTIVA
// =============================================================================
test('Fase 2 · Tarea 1A: Caché LRU acotada, TTL y estabilidad tras 5.000+ operaciones', async (t) => {
  await t.test('expulsa exactamente el elemento menos usado recientemente (LRU) y respeta TTL', () => {
    let clock = 100_000;
    const cache = new LRUCache<string, number>({
      maxItems: 3,
      ttlMs: 1_000,
      now: () => clock,
    });

    cache.set('A', 1);
    cache.set('B', 2);
    cache.set('C', 3);

    // Acceder a 'A' renueva su recencia -> el menos usado ahora es 'B'
    assert.equal(cache.get('A'), 1);

    cache.set('D', 4);
    assert.equal(cache.has('B'), false, 'B debe haber sido expulsado por política LRU');
    assert.equal(cache.get('A'), 1);
    assert.equal(cache.get('C'), 3);
    assert.equal(cache.get('D'), 4);
    assert.equal(cache.size, 3);

    // Expiración TTL
    clock += 1_001;
    assert.equal(cache.get('A'), undefined, 'Entrada expirada por TTL debe devolverse como undefined');
    assert.equal(cache.size, 2);

    const metrics = cache.getMetrics();
    assert.ok(metrics.hits >= 4);
    assert.ok(metrics.misses >= 1);
    assert.ok(metrics.evictions >= 2);
  });

  await t.test('mantiene memoria acotada (size <= maxItems) tras 5.500 operaciones', () => {
    const cache = new LRUCache<string, { payload: string }>({
      maxItems: 200,
      ttlMs: 300_000,
    });

    for (let i = 0; i < 5_500; i++) {
      cache.set(`key:${i}`, { payload: `cliente-${i}` });
      if (i % 5 === 0) {
        cache.get(`key:${Math.max(0, i - 10)}`);
      }
      assert.ok(cache.size <= 200, `size nunca puede superar maxItems (actual: ${cache.size})`);
    }

    const metrics = cache.getMetrics();
    assert.equal(metrics.size, 200);
    assert.ok(metrics.evictions >= 5_300, `Debe registrar >= 5300 expulsiones (actual: ${metrics.evictions})`);
    assert.ok(metrics.hits > 0);
  });

  await t.test('invalidarCacheMaestros(region) invalida solo la región indicada preservando otras regiones', async () => {
    clearMasterDataCaches();
    configureMasterDataCaches({ maxItems: 200, ttlMs: 300_000 });
    const mockDb = createInMemoryRegionalSupabaseMock();

    await sincronizarClientesPorPerfilRegional(
      {
        actorProfile: { role: 'super_admin', assignedRegion: null, isGlobalAdmin: true },
        clientesPorRegion: {
          OCCIDENTE: [{ codigo_cliente: 'OCC-1', razon_social: 'EMPRESA OCCIDENTE, C.A.' }],
          CENTRO: [{ codigo_cliente: 'CEN-1', razon_social: 'EMPRESA CENTRO, C.A.' }],
        },
      },
      mockDb.client
    );

    const callsBefore = mockDb.getClientesSelectCalls();
    await obtenerClientesMaestros(
      { region: 'OCCIDENTE', regionId: mockDb.regionIdsByCode.OCCIDENTE },
      mockDb.client
    );
    await obtenerClientesMaestros(
      { region: 'CENTRO', regionId: mockDb.regionIdsByCode.CENTRO },
      mockDb.client
    );
    assert.equal(mockDb.getClientesSelectCalls(), callsBefore + 2);

    // Segundo acceso debe servir de caché (0 queries nuevas)
    await obtenerClientesMaestros(
      { region: 'OCCIDENTE', regionId: mockDb.regionIdsByCode.OCCIDENTE },
      mockDb.client
    );
    await obtenerClientesMaestros(
      { region: 'CENTRO', regionId: mockDb.regionIdsByCode.CENTRO },
      mockDb.client
    );
    assert.equal(mockDb.getClientesSelectCalls(), callsBefore + 2);

    // Invalidación dirigida solo a OCCIDENTE -> CENTRO sigue cacheado
    invalidarCacheMaestros('OCCIDENTE');
    await obtenerClientesMaestros(
      { region: 'CENTRO', regionId: mockDb.regionIdsByCode.CENTRO },
      mockDb.client
    );
    assert.equal(
      mockDb.getClientesSelectCalls(),
      callsBefore + 2,
      'CENTRO debe permanecer en caché tras invalidar solo OCCIDENTE'
    );

    await obtenerClientesMaestros(
      { region: 'OCCIDENTE', regionId: mockDb.regionIdsByCode.OCCIDENTE },
      mockDb.client
    );
    assert.equal(
      mockDb.getClientesSelectCalls(),
      callsBefore + 3,
      'OCCIDENTE debe re-consultar tras invalidación dirigida'
    );

    const snapshot = getMasterDataCacheMetrics();
    assert.ok(snapshot.clientes.size <= snapshot.clientes.maxItems);
    assert.ok(snapshot.total.hits >= 3);
  });
});

// =============================================================================
// 2. BÚSQUEDA SEGURA DE RAZONES SOCIALES (", C.A.", "CA") Y ANTI-INYECCIÓN
// =============================================================================
test('Fase 2 · Tarea 1B: Búsqueda comercial con ", C.A." y defensa contra inyección PostgREST', async (t) => {
  const infra = await startLocalMockInfra(0);
  t.after(async () => {
    await infra.close();
  });

  await t.test('encuentra coincidencias con "EMPRESA DEMO, C.A.", "EMPRESA DEMO CA" y ", C.A."', async () => {
    infra.resetSeedData();
    infra.tables.clientes.push(
      {
        id: 'ffff3333-3333-4333-8333-333333333333',
        codigo_cliente: 'CLI-DEMO',
        rif: 'J-50123456-7',
        razon_social: 'EMPRESA DEMO, C.A.',
        nombre_comercial: 'EMPRESA DEMO',
        canal: 'Mayorista',
        zona: 'VALENCIA',
        activo: true,
        metadata: {},
      },
      {
        id: 'ffff4444-4444-4444-8444-444444444444',
        codigo_cliente: 'CLI-INACT',
        rif: 'J-50999999-9',
        razon_social: 'EMPRESA OCULTA INACTIVA, C.A.',
        nombre_comercial: 'OCULTA',
        canal: 'Mayorista',
        zona: 'VALENCIA',
        activo: false,
        metadata: {},
      }
    );

    const sbClient = createClient<MasterDataDatabase>(infra.baseUrl, 'sb_publishable_local_test', {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const exactWithComma = await obtenerClientesMaestros(
      { busqueda: 'EMPRESA DEMO, C.A.', forzarRefresco: true },
      sbClient
    );
    assert.equal(exactWithComma.length, 1);
    assert.equal(exactWithComma[0]!.codigo_cliente, 'CLI-DEMO');

    const withoutPunctuation = await obtenerClientesMaestros(
      { busqueda: 'EMPRESA DEMO CA', forzarRefresco: true },
      sbClient
    );
    assert.equal(withoutPunctuation.length, 1);
    assert.equal(withoutPunctuation[0]!.codigo_cliente, 'CLI-DEMO');

    const onlySuffix = await obtenerClientesMaestros(
      { busqueda: ', C.A.', forzarRefresco: true },
      sbClient
    );
    assert.ok(
      onlySuffix.some((c) => c.codigo_cliente === 'CLI-DEMO'),
      'Buscar ", C.A." debe encontrar "EMPRESA DEMO, C.A."'
    );
    assert.ok(
      onlySuffix.every((c) => c.activo === true),
      'Jamás debe retornar clientes inactivos'
    );

    assert.equal(coincideBusquedaComercialNormalizada('DISTRIBUIDORA Z, C.A.', 'DISTRIBUIDORA Z CA'), true);
    assert.equal(coincideBusquedaComercialNormalizada('DISTRIBUIDORA Z, C.A.', ', C.A.'), true);
  });

  await t.test('neutraliza payloads maliciosos de sintaxis PostgREST sin filtrar filas no autorizadas', async () => {
    const attacks = [
      'DEMO,id.neq.0',
      'DEMO),activo.eq.false,razon_social.ilike.("X',
      '"),id.neq.0;DROP TABLE clientes;--',
      '100%_test*\\"',
    ];

    for (const payload of attacks) {
      const sanitized = sanitizarTerminoBusquedaComercial(payload);
      assert.ok(!sanitized.includes('(') && !sanitized.includes(')'), `Sin paréntesis: ${sanitized}`);
      assert.ok(!sanitized.includes('"'), `Sin comillas dobles: ${sanitized}`);
      assert.ok(!sanitized.includes(';'), `Sin punto y coma: ${sanitized}`);
      assert.ok(!/id\.neq\.0|activo\.eq\.false/i.test(sanitized), `Sin operador inyectado: ${sanitized}`);

      const orExpr = construirFiltroOrBusquedaClientes(payload);
      assert.ok(!/,id\.neq\.0|,activo\.eq\.false/i.test(orExpr), `Filtro .or() seguro: ${orExpr}`);
    }

    // Ejecución real contra el servidor mock PostgREST verificando cero filtración de inactivos
    const sbClient = createClient<MasterDataDatabase>(infra.baseUrl, 'sb_publishable_local_test', {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const res = await obtenerClientesMaestros(
      { busqueda: 'DEMO),activo.eq.false,id.neq.0("', forzarRefresco: true },
      sbClient
    );
    assert.ok(res.every((c) => c.activo === true), 'Inyección jamás debe exponer registros inactivos');
  });
});

// =============================================================================
// 3. SINCRONIZACIÓN REGIONAL POR PERFILES (SOLO OCCIDENTE -> CENTRO -> ANDES)
// =============================================================================
test('Fase 2 · Tarea 2: Sincronización regional idempotente, prioridad y autorización por perfil', async (t) => {
  await t.test('resuelve dinámicamente "Regiones" (id_regi y regi_saba) descartando regiones no permitidas', async () => {
    clearMasterDataCaches();
    const mockDb = createInMemoryRegionalSupabaseMock();

    const catalog = await obtenerCatalogoRegionesOficiales(mockDb.client, { forzarRefresco: true });
    assert.deepEqual(Array.from(catalog.keys()), [...ALLOWED_REGIONS]);
    assert.equal(catalog.get('OCCIDENTE')?.regi_saba, true);
    assert.equal(catalog.get('CENTRO')?.regi_saba, false);
    assert.equal(catalog.get('ANDES')?.regi_saba, false);
    assert.equal(catalog.has('ORIENTE' as AllowedRegionCode), false);
    assert.equal(mockDb.getRegionesSelectCalls(), 1);

    // Segunda lectura usa caché LRU con TTL
    await obtenerCatalogoRegionesOficiales(mockDb.client);
    assert.equal(mockDb.getRegionesSelectCalls(), 1);
  });

  await t.test('procesa estrictamente OCCIDENTE -> CENTRO -> ANDES, es 100% idempotente y aísla errores parciales', async () => {
    clearMasterDataCaches();
    const mockDb = createInMemoryRegionalSupabaseMock();
    const executionOrder: AllowedRegionCode[] = [];

    const payloadClientes = {
      ANDES: [
        { codigo_cliente: 'AND-001', razon_social: 'COMERCIAL LOS ANDES, C.A.' },
      ],
      ORIENTE: [
        { codigo_cliente: 'ORI-999', razon_social: 'NO DEBE PROCESARSE, C.A.' },
      ],
      CENTRO: [
        { codigo_cliente: 'CEN-001', razon_social: 'DISTRIBUIDORA VALENCIA, C.A.' },
        { codigo_cliente: 'CEN-002', razon_social: 'SUPERMERCADO CARABOBO, C.A.' },
      ],
      OCCIDENTE: [
        { codigo_cliente: 'OCC-001', razon_social: 'INVERSIONES MARACAIBO, C.A.' },
        { codigo_cliente: 'OCC-001', razon_social: 'INVERSIONES MARACAIBO, C.A.' }, // duplicado intra-lote
        { codigo_cliente: 'OCC-002', razon_social: 'ABASTO ZULIA, S.A.' },
      ],
      CAPITAL: [
        { codigo_cliente: 'CAP-999', razon_social: 'FUERA DE CATALOGO, C.A.' },
      ],
    };

    const run1 = await sincronizarClientesPorPerfilRegional(
      {
        actorProfile: { role: 'super_admin', assignedRegion: null, isGlobalAdmin: true },
        clientesPorRegion: payloadClientes,
        batchSize: 1,
        onRegionStart: (r) => executionOrder.push(r),
      },
      mockDb.client
    );

    assert.deepEqual(executionOrder, [...REGIONAL_SYNC_PRIORITY_QUEUE]);
    assert.deepEqual(run1.ordenPrioridadEjecutado, ['OCCIDENTE', 'CENTRO', 'ANDES']);
    assert.ok(run1.regionesOmitidasNoPermitidas.includes('ORIENTE'));
    assert.ok(run1.regionesOmitidasNoPermitidas.includes('CAPITAL'));
    assert.equal(run1.totales.procesados, 5);
    assert.equal(run1.totales.insertadosOActualizados, 5);
    assert.equal(run1.totales.omitidos, 1, 'Debe omitir el duplicado intra-lote OCC-001');
    assert.equal(run1.totales.errores, 0);
    assert.equal(mockDb.clientesByCode.size, 5);

    // Verificar sellado dinámico de id_regi y flag regi_saba
    const occRow = mockDb.clientesByCode.get('OCC-001')!;
    assert.equal(occRow.region_id, mockDb.regionIdsByCode.OCCIDENTE);
    assert.equal((occRow.metadata as Record<string, unknown>).regi_saba, true);

    const cenRow = mockDb.clientesByCode.get('CEN-001')!;
    assert.equal(cenRow.region_id, mockDb.regionIdsByCode.CENTRO);
    assert.equal((cenRow.metadata as Record<string, unknown>).regi_saba, false);

    // Segunda ejecución con exactamente los mismos datos -> 100% idempotente (0 duplicados)
    const run2 = await sincronizarClientesPorPerfilRegional(
      {
        actorProfile: { role: 'super_admin', assignedRegion: null, isGlobalAdmin: true },
        clientesPorRegion: payloadClientes,
        batchSize: 2,
      },
      mockDb.client
    );
    assert.equal(run2.totales.errores, 0);
    assert.equal(mockDb.clientesByCode.size, 5, 'La segunda ejecución no debe crear duplicados');

    // Control de error parcial por lote sin abortar el resto de lotes/regiones
    const partialFailMock = createInMemoryRegionalSupabaseMock({
      failBatchPredicate: (rows) => rows.some((r) => r.codigo_cliente === 'OCC-BAD'),
    });
    const partialReport = await sincronizarClientesPorPerfilRegional(
      {
        actorProfile: { role: 'super_admin', assignedRegion: null, isGlobalAdmin: true },
        clientesPorRegion: {
          OCCIDENTE: [
            { codigo_cliente: 'OCC-BAD', razon_social: 'LOTE FALLIDO, C.A.' },
            { codigo_cliente: 'OCC-OK', razon_social: 'LOTE EXITOSO, C.A.' },
          ],
          CENTRO: [{ codigo_cliente: 'CEN-OK', razon_social: 'CENTRO EXITOSO, C.A.' }],
        },
        batchSize: 1,
      },
      partialFailMock.client
    );
    assert.equal(partialReport.totales.errores, 1);
    assert.equal(partialReport.totales.insertadosOActualizados, 2);
    assert.equal(partialFailMock.clientesByCode.has('OCC-OK'), true);
    assert.equal(partialFailMock.clientesByCode.has('CEN-OK'), true);
  });

  await t.test('bloquea con 403 si un perfil regional restringido intenta consultar o sincronizar otra región', async () => {
    const mockDb = createInMemoryRegionalSupabaseMock();
    const coordOccidente = {
      role: 'coordinacion',
      assignedRegion: 'OCCIDENTE' as AllowedRegionCode,
    };
    const sinRegion = {
      role: 'coordinacion',
      assignedRegion: null,
    };

    assert.throws(
      () => assertRegionalProfileAccess(coordOccidente, ['CENTRO']),
      (err: unknown) => err instanceof RegionalAuthorizationError && err.statusCode === 403
    );
    assert.throws(
      () => assertRegionalProfileAccess(coordOccidente, ['OCCIDENTE', 'CENTRO']),
      (err: unknown) => err instanceof RegionalAuthorizationError && err.statusCode === 403
    );
    assert.throws(
      () => assertRegionalProfileAccess(sinRegion, ['OCCIDENTE']),
      (err: unknown) => err instanceof RegionalAuthorizationError && err.statusCode === 403
    );

    await assert.rejects(
      () =>
        sincronizarClientesPorPerfilRegional(
          {
            actorProfile: coordOccidente,
            clientesPorRegion: {
              CENTRO: [{ codigo_cliente: 'CEN-999', razon_social: 'PROHIBIDO, C.A.' }],
            },
          },
          mockDb.client
        ),
      (err: unknown) => err instanceof RegionalAuthorizationError && err.statusCode === 403
    );

    await assert.rejects(
      () =>
        obtenerClientesPorPerfilRegional(
          coordOccidente,
          { region: 'ANDES' },
          mockDb.client
        ),
      (err: unknown) => err instanceof RegionalAuthorizationError && err.statusCode === 403
    );

    // Sí puede sincronizar y consultar su propia región (OCCIDENTE)
    const ownSync = await sincronizarClientesPorPerfilRegional(
      {
        actorProfile: coordOccidente,
        clientesPorRegion: {
          OCCIDENTE: [{ codigo_cliente: 'OCC-OWN', razon_social: 'PROPIO OCCIDENTE, C.A.' }],
        },
      },
      mockDb.client
    );
    assert.equal(ownSync.totales.insertadosOActualizados, 1);

    const ownRows = await obtenerClientesPorPerfilRegional(
      coordOccidente,
      { region: 'OCCIDENTE', forzarRefresco: true },
      mockDb.client
    );
    assert.equal(ownRows.length, 1);
    assert.equal(ownRows[0]!.codigo_cliente, 'OCC-OWN');
  });
});

// =============================================================================
// 4. DIVISIÓN COMPLETA DE PROMOTORAS (Fijas / Eventuales / Merchandising)
// =============================================================================
test('Fase 2 · Tarea 3: Promotoras (Zod, filtros regionales combinados, REST y UI SSR)', async (t) => {
  await t.test('Zod acepta únicamente Fijas, Eventuales y Merchandising y rechaza valores inválidos', () => {
    for (const valid of PROMOTORA_CATEGORIAS) {
      assert.equal(PromotoraCategoriaStrictSchema.parse(valid), valid);
    }

    for (const invalid of ['fija', 'eventual', 'merchandising', 'Temporal', 'VIP', '', null, 123]) {
      assert.equal(
        PromotoraCategoriaStrictSchema.safeParse(invalid).success,
        false,
        `Categoría inválida debe rechazarse: ${String(invalid)}`
      );
    }

    assert.equal(
      PromotoraUpsertSchema.safeParse({
        nombre_completo: 'María Pérez',
        categoria: 'Merchandising',
        region: 'OCCIDENTE',
      }).success,
      true
    );

    assert.equal(
      PromotoraUpsertSchema.safeParse({
        nombre_completo: 'María Pérez',
        categoria: 'Invalida',
        region: 'OCCIDENTE',
      }).success,
      false
    );

    assert.equal(
      PromotoraFilterSchema.safeParse({ categoria: 'Otra', region: 'OCCIDENTE' }).success,
      false
    );
    assert.equal(
      PromotoraFilterSchema.safeParse({ categoria: 'Fijas', region: 'ORIENTE' }).success,
      false
    );
  });

  await t.test('filtros combinados por región + categoría y contadores estadísticos exactos', () => {
    const dataset = [
      { id: '1', nombre_completo: 'Ana Zulia', categoria: 'Fijas', sucursal: 'ZULIA', activo: true },
      { id: '2', nombre_completo: 'Bea Zulia', categoria: 'Eventuales', sucursal: 'ZULIA', activo: true },
      { id: '3', nombre_completo: 'Caro Zulia', categoria: 'Merchandising', sucursal: 'ZULIA', activo: true },
      { id: '4', nombre_completo: 'Dina Valencia', categoria: 'Fijas', sucursal: 'VALENCIA', activo: true },
      { id: '5', nombre_completo: 'Eva Valencia', categoria: 'Merchandising', sucursal: 'CENTRO', activo: true },
      { id: '6', nombre_completo: 'Flor Mérida', categoria: 'Eventuales', estado: 'Mérida', activo: true },
    ];

    const stats = computePromotorasCategoryStats(dataset);
    assert.equal(stats.total, 6);
    assert.equal(stats.Fijas, 2);
    assert.equal(stats.Eventuales, 2);
    assert.equal(stats.Merchandising, 2);
    assert.equal(stats.porRegion.OCCIDENTE.total, 3);
    assert.equal(stats.porRegion.CENTRO.total, 2);
    assert.equal(stats.porRegion.ANDES.total, 1);

    const onlyOccEventuales = filterPromotorasByRegionAndCategory(dataset, {
      region: 'OCCIDENTE',
      categoria: 'Eventuales',
    });
    assert.equal(onlyOccEventuales.length, 1);
    assert.equal(onlyOccEventuales[0]!.nombre_completo, 'Bea Zulia');

    const onlyCentroMerch = filterPromotorasByRegionAndCategory(dataset, {
      region: 'CENTRO',
      categoria: 'Merchandising',
    });
    assert.equal(onlyCentroMerch.length, 1);
    assert.equal(onlyCentroMerch[0]!.nombre_completo, 'Eva Valencia');
  });

  await t.test('endpoints REST /api/promotoras validan Zod, categorías, aislamiento regional y stats', async () => {
    const regionIds: Record<AllowedRegionCode, string> = {
      OCCIDENTE: '11111111-1111-4111-8111-000000000001',
      CENTRO: '11111111-1111-4111-8111-000000000002',
      ANDES: '11111111-1111-4111-8111-000000000003',
    };
    const rows: PromotoraServerRecord[] = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
        nombre_completo: 'Laura Occidente',
        email: 'laura@codizulca.com',
        telefono: null,
        ciudad: 'Maracaibo',
        estado: 'Zulia',
        direccion: null,
        categoria: 'Fijas',
        region_id: regionIds.OCCIDENTE,
        sucursal: 'ZULIA',
        supervisor_id: null,
        activo: true,
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
        nombre_completo: 'Sofía Centro',
        email: 'sofia@codizulca.com',
        telefono: null,
        ciudad: 'Valencia',
        estado: 'Carabobo',
        direccion: null,
        categoria: 'Merchandising',
        region_id: regionIds.CENTRO,
        sucursal: 'CENTRO',
        supervisor_id: null,
        activo: true,
      },
    ];

    const gateway: PromotorasGateway = {
      async resolveRegionIdByCode(code) {
        return regionIds[code] ?? null;
      },
      async listPromotoras(filters) {
        return rows.filter((r) => {
          if (filters.soloActivas && !r.activo) return false;
          if (filters.categoria && r.categoria !== filters.categoria) return false;
          if (filters.regionId && r.region_id !== filters.regionId) return false;
          return true;
        });
      },
      async getPromotoraById(id) {
        return rows.find((r) => r.id === id) ?? null;
      },
      async createPromotora(payload) {
        const created: PromotoraServerRecord = {
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(rows.length + 1).padStart(12, '0')}`,
          nombre_completo: String(payload.nombre_completo),
          email: (payload.email as string | null) ?? null,
          telefono: (payload.telefono as string | null) ?? null,
          ciudad: (payload.ciudad as string | null) ?? null,
          estado: (payload.estado as string | null) ?? null,
          direccion: (payload.direccion as string | null) ?? null,
          categoria: payload.categoria as 'Fijas' | 'Eventuales' | 'Merchandising',
          region_id: (payload.region_id as string | null) ?? null,
          sucursal: (payload.sucursal as string | null) ?? null,
          supervisor_id: (payload.supervisor_id as string | null) ?? null,
          activo: payload.activo !== false,
        };
        rows.push(created);
        return created;
      },
      async updatePromotora(id, payload) {
        const idx = rows.findIndex((r) => r.id === id);
        rows[idx] = { ...rows[idx]!, ...(payload as Partial<PromotoraServerRecord>) };
        return rows[idx]!;
      },
    };

    const handlers = createPromotorasHandlers({ gatewayFactory: () => gateway });
    const app = express();
    app.use(express.json());
    registerPromotorasRoutes(app, {
      rateLimiter: createRateLimiter({
        name: 'test-promotoras',
        windowMs: 60_000,
        maxRequests: 50,
        store: createMemoryRateLimitStore(),
      }),
      authMiddleware: (req, _res, next) => {
        const roleHeader = String(req.headers['x-test-role'] || 'coordinacion');
        const sucursalHeader = String(req.headers['x-test-sucursal'] || 'ZULIA');
        req.authUser = {
          id: '99999999-9999-4999-8999-999999999999',
          email: 'tester@codizulca.com',
          appRole: roleHeader,
          sucursal: sucursalHeader as 'ZULIA' | 'GLOBAL',
          isSuperAdmin: roleHeader === 'super_admin',
          isCoordinatorOrAdmin: true,
          isReadOnlyViewer: false,
          accessToken: 'mock-token',
        };
        next();
      },
      listHandler: handlers.handleListPromotoras,
      createHandler: handlers.handleCreatePromotora,
      updateHandler: handlers.handleUpdatePromotora,
    });

    const srv = await listen(app);
    try {
      // 1. Categoría inválida -> 400
      const badCreate = await fetch(`${srv.base}/api/promotoras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'super_admin', 'x-test-sucursal': 'GLOBAL' },
        body: JSON.stringify({ nombre_completo: 'Test Invalida', categoria: 'Temporal', region: 'OCCIDENTE' }),
      });
      assert.equal(badCreate.status, 400);

      // 2. Creación válida Eventuales en OCCIDENTE -> 201
      const okCreate = await fetch(`${srv.base}/api/promotoras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'coordinacion', 'x-test-sucursal': 'ZULIA' },
        body: JSON.stringify({ nombre_completo: 'Daniela Eventual', categoria: 'Eventuales', region: 'OCCIDENTE' }),
      });
      assert.equal(okCreate.status, 201);
      const createdJson = (await okCreate.json()) as { item: PromotoraServerRecord };
      assert.equal(createdJson.item.categoria, 'Eventuales');
      assert.equal(createdJson.item.region_id, regionIds.OCCIDENTE);

      // 3. Coordinadora de OCCIDENTE intentando consultar CENTRO -> 403
      const forbiddenList = await fetch(`${srv.base}/api/promotoras?region=CENTRO`, {
        headers: { 'x-test-role': 'coordinacion', 'x-test-sucursal': 'ZULIA' },
      });
      assert.equal(forbiddenList.status, 403);

      // 4. Filtro combinado en OCCIDENTE + Eventuales -> 200 con stats
      const filteredList = await fetch(
        `${srv.base}/api/promotoras?region=OCCIDENTE&categoria=Eventuales`,
        { headers: { 'x-test-role': 'coordinacion', 'x-test-sucursal': 'ZULIA' } }
      );
      assert.equal(filteredList.status, 200);
      const listJson = (await filteredList.json()) as {
        items: PromotoraServerRecord[];
        stats: { total: number; Eventuales: number };
      };
      assert.equal(listJson.items.length, 1);
      assert.equal(listJson.items[0]!.nombre_completo, 'Daniela Eventual');
      assert.equal(listJson.stats.Eventuales, 1);

      // 5. PATCH cambiando categoría a Merchandising -> 200
      const patchOk = await fetch(`${srv.base}/api/promotoras/${createdJson.item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'coordinacion', 'x-test-sucursal': 'ZULIA' },
        body: JSON.stringify({ categoria: 'Merchandising' }),
      });
      assert.equal(patchOk.status, 200);
      const patchJson = (await patchOk.json()) as { item: PromotoraServerRecord };
      assert.equal(patchJson.item.categoria, 'Merchandising');
    } finally {
      await srv.close();
    }
  });

  await t.test('UI SSR de MasterEntitiesSyncPanel y SucursalPersonalModule muestran Fijas, Eventuales y Merchandising', () => {
    const htmlMaster = renderToStaticMarkup(
      React.createElement(MasterEntitiesSyncPanel, {
        qaOverride: {
          iamRole: 'super_admin',
          sucursal: 'GLOBAL',
          initialTab: 'promotoras',
          regiones: [
            {
              id: '11111111-1111-4111-8111-000000000001',
              codigo: 'ZULIA',
              nombre: 'Occidente (Zulia)',
              activo: true,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          ],
          productos: [],
          supervisores: [],
          clientes: [],
          promotoras: [
            {
              id: 'p1',
              nombre_completo: 'María Fija',
              email: 'fija@codizulca.com',
              telefono: null,
              ciudad: 'Maracaibo',
              estado: 'Zulia',
              direccion: null,
              sucursal: 'ZULIA',
              region_id: '11111111-1111-4111-8111-000000000001',
              supervisor_id: null,
              categoria: 'Fijas',
              activo: true,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
            {
              id: 'p2',
              nombre_completo: 'Carla Eventual',
              email: 'eventual@codizulca.com',
              telefono: null,
              ciudad: 'Maracaibo',
              estado: 'Zulia',
              direccion: null,
              sucursal: 'ZULIA',
              region_id: '11111111-1111-4111-8111-000000000001',
              supervisor_id: null,
              categoria: 'Eventuales',
              activo: true,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
            {
              id: 'p3',
              nombre_completo: 'Luis Merch',
              email: 'merch@codizulca.com',
              telefono: null,
              ciudad: 'Maracaibo',
              estado: 'Zulia',
              direccion: null,
              sucursal: 'ZULIA',
              region_id: '11111111-1111-4111-8111-000000000001',
              supervisor_id: null,
              categoria: 'Merchandising',
              activo: true,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          ],
        },
      })
    );

    assert.match(htmlMaster, /filter-promotoras-categoria-Fijas/);
    assert.match(htmlMaster, /filter-promotoras-categoria-Eventuales/);
    assert.match(htmlMaster, /filter-promotoras-categoria-Merchandising/);
    assert.match(htmlMaster, /María Fija/);
    assert.match(htmlMaster, /Carla Eventual/);
    assert.match(htmlMaster, /Luis Merch/);

    const htmlSucursal = renderToStaticMarkup(
      React.createElement(SucursalPersonalModule, {
        lockedSucursal: 'ZULIA',
        viewerIamRole: 'coordinacion',
        initialBundle: {
          sucursal: 'ZULIA',
          staff: [
            { id: 's1', name: 'Ana Fija', role: 'Promotora Fija', email: 'a@codizulca.com', status: 'Activo', categoria: 'Fijas', sucursal: 'ZULIA' },
            { id: 's2', name: 'Bety Eventual', role: 'Promotora Eventual', email: 'b@codizulca.com', status: 'Activo', categoria: 'Eventuales', sucursal: 'ZULIA' },
            { id: 's3', name: 'Cami Merch', role: 'Promotor Merchandising', email: 'c@codizulca.com', status: 'Activo', categoria: 'Merchandising', sucursal: 'ZULIA' },
          ],
          clientes: [],
          profiles: [],
          cadenas: [],
          portal_accesos: [],
        },
      })
    );
    assert.match(htmlSucursal, /sucursal-filter-categoria-Fijas/);
    assert.match(htmlSucursal, /sucursal-filter-categoria-Eventuales/);
    assert.match(htmlSucursal, /sucursal-filter-categoria-Merchandising/);
  });
});

// =============================================================================
// 5. MIGRACIÓN SQL FASE 2 (IDEMPOTENTE, SIN DDL DESTRUCTIVO, SIN UUIDS QUEMADOS)
// =============================================================================
test('Fase 2 · Migración SQL 20261125000100: certificador estático, CHECK promotoras y RPC', () => {
  const files: MigrationFile[] = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));

  const analysis = analyzeMigrations(files);
  assert.equal(analysis.errors.length, 0, formatIssues(analysis.errors));

  const cert = runStaticCertification(MIGRATIONS_DIR);
  assert.equal(cert.passed, true, JSON.stringify(cert.checks.filter((c) => !c.passed)));

  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, PHASE2_SQL_FILE), 'utf8');
  const executableSql = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  assert.doesNotMatch(executableSql, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(
    executableSql,
    /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i,
    'No deben existir UUIDs hardcodeados en la migración SQL'
  );
  assert.match(executableSql, /chk_promotoras_categoria_oficial/);
  assert.match(executableSql, /CHECK\s*\(\s*categoria\s+IN\s*\('Fijas',\s*'Eventuales',\s*'Merchandising'\)\s*\)/);
  assert.match(executableSql, /rpc_buscar_clientes_maestros/);
  assert.match(executableSql, /SECURITY INVOKER/);
  assert.match(executableSql, /public\."Regiones"/);
});
