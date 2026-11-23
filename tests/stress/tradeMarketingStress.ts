/**
 * Suite de Pruebas de Estrés Locales — Sistema de Trade Marketing (Fase 4)
 * Ejecución sugerida: npx tsx tests/stress/tradeMarketingStress.ts
 *
 * Modos de ejecución:
 *   - Por defecto (aislado 100 % local en 127.0.0.1): levanta el mock local de Supabase y el
 *     servidor Express real (`server.ts`) en puertos efímeros `127.0.0.1:0` y ejecuta los 5
 *     escenarios sobre las rutas y servicios reales de Trade Marketing sin tocar producción.
 *   - Externo local (`STRESS_EXTERNAL_SERVER=1 API_BASE_URL=http://127.0.0.1:3000`): apunta a
 *     una instancia Express local ya levantada por el usuario.
 *
 * REGLA DE SEGURIDAD: Bloquea ejecución si API_BASE_URL no es local (localhost/127.0.0.1/::1).
 */

import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  MOCK_ACTORS,
  MOCK_CRON_SECRET,
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
  startLocalMockInfra,
  type LocalMockInfraInstance,
} from '../antigravity_audit/localMockInfra';

interface ScenarioConfig {
  name: string;
  totalRequests: number;
  concurrency: number;
  maxP95Ms: number;
  expectedStatuses: number[];
  requestFactory: (index: number) => Promise<Response>;
}

interface ScenarioReport {
  name: string;
  total: number;
  ok: number;
  unexpected: number;
  statusCounts: Record<number, number>;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  throughputRps: number;
  heapDeltaMb: number;
  passed: boolean;
}

const USE_EXTERNAL_SERVER = process.env.STRESS_EXTERNAL_SERVER === '1';
const CONFIGURED_BASE_URL = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3000').replace(
  /\/+$/,
  ''
);
const CONFIGURED_AUTH_TOKEN = process.env.STRESS_TEST_AUTH_TOKEN ?? '';
const REQUEST_TIMEOUT_MS = Number(process.env.STRESS_TIMEOUT_MS ?? 8000);
const ALLOWED_REGIONS = ['OCCIDENTE', 'CENTRO', 'ANDES'] as const;

// PNG 1x1 válido (magic bytes reales 89 50 4E 47 0D 0A 1A 0A) para pruebas binarias de evidencias
const VALID_1X1_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex'
);

function makeDistinctValidPng(seed: number): Buffer {
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(seed, 0);
  return Buffer.concat([VALID_1X1_PNG, trailer]);
}

function encodeBase64UrlJson(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function assertLocalTarget(urlString: string): void {
  const parsed = new URL(urlString);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(
      `[SEGURIDAD] Pruebas de estrés bloqueadas: "${parsed.hostname}" no es un entorno local. ` +
        'Nunca ejecutes pruebas de carga masivas contra producción.'
    );
  }
}

async function fetchWithTimeout(
  baseUrl: string,
  path: string,
  authToken: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    if (authToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${authToken}`);
    }
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  );
  return Number(sortedValues[idx]!.toFixed(2));
}

async function runScenario(config: ScenarioConfig): Promise<ScenarioReport> {
  const latencies: number[] = [];
  const statusCounts: Record<number, number> = {};
  let ok = 0;
  let unexpected = 0;
  let cursor = 0;

  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  const worker = async (): Promise<void> => {
    while (true) {
      const current = cursor++;
      if (current >= config.totalRequests) break;

      const t0 = performance.now();
      try {
        const res = await config.requestFactory(current);
        // Consumir cuerpo para liberar sockets y evitar fugas de conexión
        await res.arrayBuffer();
        const elapsed = performance.now() - t0;
        latencies.push(elapsed);

        statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
        if (config.expectedStatuses.includes(res.status)) {
          ok++;
        } else {
          unexpected++;
        }
      } catch {
        latencies.push(performance.now() - t0);
        statusCounts[0] = (statusCounts[0] ?? 0) + 1;
        unexpected++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(config.concurrency, config.totalRequests) }, () => worker())
  );

  const totalSec = Math.max((performance.now() - startedAt) / 1000, 0.001);
  const heapAfter = process.memoryUsage().heapUsed;
  const sorted = [...latencies].sort((a, b) => a - b);

  const p50Ms = percentile(sorted, 50);
  const p95Ms = percentile(sorted, 95);
  const p99Ms = percentile(sorted, 99);
  const heapDeltaMb = Number(((heapAfter - heapBefore) / (1024 * 1024)).toFixed(2));

  const passed = unexpected === 0 && p95Ms <= config.maxP95Ms;

  return {
    name: config.name,
    total: config.totalRequests,
    ok,
    unexpected,
    statusCounts,
    p50Ms,
    p95Ms,
    p99Ms,
    throughputRps: Number((config.totalRequests / totalSec).toFixed(2)),
    heapDeltaMb,
    passed,
  };
}

function seedStressFixtures(mock: LocalMockInfraInstance): {
  promotoraId: string;
  fechaJornada: string;
  initialStoragePath: string;
} {
  const occidenteId = '10101010-1010-4010-8010-101010101010';
  const centroId = '20202020-2020-4020-8020-202020202020';
  const andesId = '30303030-3030-4030-8030-303030303030';

  const regionIds = [occidenteId, centroId, andesId];
  const regionNames = ['OCCIDENTE', 'CENTRO', 'ANDES'];
  const sucursales = ['ZULIA', 'VALENCIA', 'ZULIA'];

  // Poblar clientes realistas con ", C.A." y caracteres especiales en las 3 regiones reales
  const clientSeedNames = [
    'INVERSIONES DEL ZULIA, C.A.',
    'DISTRIBUIDORA ZULIA, C.A.',
    'COMERCIAL VALENCIA, C.A.',
    'SUPERMERCADO DEGUSTACIÓN CAFÉ, C.A.',
    'ABASTO MÉRIDA ANDES, C.A.',
    'HIPERMERCADO LA ÑAPA, C.A.',
  ];

  for (let i = 0; i < 45; i++) {
    const rIdx = i % 3;
    const baseName = clientSeedNames[i % clientSeedNames.length]!;
    mock.tables.clientes.push({
      id: crypto.randomUUID(),
      codigo_cliente: `STRESS-CLI-${String(i + 1).padStart(3, '0')}`,
      rif: `J-4000${String(1000 + i)}-1`,
      razon_social: `${baseName} (${i + 1})`,
      nombre_comercial: `${baseName.replace(/,\s*C\.A\./i, '')} ${i + 1}`,
      canal: 'Supermercado',
      ciudad: regionNames[rIdx],
      estado: regionNames[rIdx],
      sucursal: sucursales[rIdx],
      region_id: regionIds[rIdx],
      region_codigo: regionNames[rIdx],
      activo: true,
      vendedor_id: mock.tables.vendedores[0]?.id ?? null,
      created_at: '2026-11-10T10:00:00.000Z',
    });
  }

  // Poblar historial de degustaciones variado (status + shift + ", C.A." + tildes)
  for (let i = 0; i < 30; i++) {
    const turno = i % 2 === 0 ? 'MAÑANA' : 'TARDE';
    const estado = i % 3 === 0 ? 'REALIZADA' : i % 3 === 1 ? 'APROBADA' : 'PENDIENTE';
    const store = clientSeedNames[i % clientSeedNames.length]!;
    mock.tables.surveys.push({
      id: crypto.randomUUID(),
      type: 'Degustacion',
      date: `2026-11-${String((i % 20) + 1).padStart(2, '0')}`,
      fecha_evento: `2026-11-${String((i % 20) + 1).padStart(2, '0')}`,
      store,
      promoter: 'María Piña',
      product: i % 2 === 0 ? 'Degustación Café Asturias' : 'Mortadela Especial',
      creatorId: 'CARLOS PEÑA',
      leido_trade: true,
      en_historial: true,
      comments: JSON.stringify({
        isTasting: true,
        source: 'vendedor_app',
        degustacionId: `deg-stress-hist-${i + 1}`,
        cliente: store,
        vendedor: 'CARLOS PEÑA',
        date: `2026-11-${String((i % 20) + 1).padStart(2, '0')}`,
        turno,
        estado,
        status: estado.toLowerCase(),
        products: [i % 2 === 0 ? 'Degustación Café Asturias' : 'Mortadela Especial'],
        kilos: 3,
        en_historial: true,
      }),
      created_at: `2026-11-${String((i % 20) + 1).padStart(2, '0')}T12:00:00.000Z`,
    });
  }

  // Sembrar jornada + evidencia v1 para el escenario 4 (reemplazo concurrente TOCTOU)
  const promotoraId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fechaJornada = '2026-11-16';
  const jornadaId = '77771111-1111-4111-8111-111111111111';
  const evidenceId = '77772222-2222-4222-8222-222222222222';
  const initialStoragePath = `asistencia/${fechaJornada}/${promotoraId}/JORNADA_INGRESO_11111111-1111-4111-8111-111111111111-1794840000000.png`;

  mock.tables.asistencias_jornada.push({
    id: jornadaId,
    fecha_jornada: fechaJornada,
    promotora_id: promotoraId,
    promotora_nombre: 'María Piña',
    perfil_aplicado: 'FIJA',
    pdv_nombre: 'SUPERMERCADO FIORELLA (NORTE)',
    zona: 'MARACAIBO NORTE',
    sucursal: 'ZULIA',
    opened_at_server: '2026-11-16T12:00:00.000Z',
    updated_at_server: '2026-11-16T12:00:00.000Z',
    opened_by_uid: MOCK_ACTORS.coordinadora.id,
  });

  mock.tables.asistencia_evidencias.push({
    id: evidenceId,
    asistencia_id: jornadaId,
    slot_foto: 'JORNADA_INGRESO',
    storage_bucket: 'asistencia-evidencias',
    storage_path: initialStoragePath,
    mime_type: 'image/png',
    tamano_bytes: VALID_1X1_PNG.byteLength,
    sha256_hex: crypto.createHash('sha256').update(VALID_1X1_PNG).digest('hex'),
    ancho_px: 1,
    alto_px: 1,
    pdv_nombre: 'SUPERMERCADO FIORELLA (NORTE)',
    lat: 10.65,
    lng: -71.62,
    gps_accuracy: 10,
    sucursal: 'ZULIA',
    capturado_en_servidor: '2026-11-16T12:00:00.000Z',
    cargado_por_uid: MOCK_ACTORS.coordinadora.id,
    cargado_por_rol: 'coordinadora',
    version: 1,
    updated_at: '2026-11-16T12:00:00.000Z',
  });

  mock.storageObjects.set(`asistencia-evidencias/${initialStoragePath}`, {
    bucket: 'asistencia-evidencias',
    mimeType: 'image/png',
    size: VALID_1X1_PNG.byteLength,
    sha256: crypto.createHash('sha256').update(VALID_1X1_PNG).digest('hex'),
  });

  return { promotoraId, fechaJornada, initialStoragePath };
}

async function main(): Promise<void> {
  assertLocalTarget(CONFIGURED_BASE_URL);

  let mock: LocalMockInfraInstance | null = null;
  let serverClose: (() => Promise<void>) | null = null;
  let activeApiBaseUrl = CONFIGURED_BASE_URL;
  let activeAuthToken = CONFIGURED_AUTH_TOKEN;

  try {
    if (!USE_EXTERNAL_SERVER) {
      // Modo aislado 100 % local (loopback): cero tráfico saliente a producción
      mock = await startLocalMockInfra(0);
      process.env.AUDIT_MOCK_BASE_URL = mock.baseUrl;
      process.env.VITE_SUPABASE_URL = mock.baseUrl;
      process.env.SUPABASE_URL = mock.baseUrl;
      process.env.VITE_SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
      process.env.SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY = MOCK_PUBLIC_ANON_KEY;
      process.env.SUPABASE_PUBLISHABLE_KEY = MOCK_PUBLIC_ANON_KEY;
      process.env.VITE_SUPABASE_MASTER_URL = '';
      process.env.VITE_SUPABASE_MASTER_ANON_KEY = '';
      process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;
      process.env.CRON_SECRET = MOCK_CRON_SECRET;
      process.env.APP_TIMEZONE = 'America/Caracas';
      process.env.MASTER_DATA_CACHE_MAX_ITEMS = '30';
      process.env.MASTER_DATA_CACHE_TTL_MS = '300000';

      const { app } = await import('../../server');
      const httpServer = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => httpServer.once('listening', () => resolve()));
      const port = (httpServer.address() as AddressInfo).port;
      activeApiBaseUrl = `http://127.0.0.1:${port}`;
      assertLocalTarget(activeApiBaseUrl);
      activeAuthToken = activeAuthToken || MOCK_ACTORS.admin.token;

      serverClose = () =>
        new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
    }

    const fixture = mock
      ? seedStressFixtures(mock)
      : {
          promotoraId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          fechaJornada: '2026-11-16',
          initialStoragePath: '',
        };

    // Importar servicios reales DESPUÉS de fijar las variables de entorno loopback
    const [weeklyMod, masterMod] = await Promise.all([
      import('../../src/services/degustacionesWeeklyCycleService'),
      import('../../src/services/masterDataSyncService'),
    ]);

    console.log(
      `\n🚀 Iniciando pruebas de estrés locales (${USE_EXTERNAL_SERVER ? 'externo' : 'aislado 127.0.0.1'}) contra ${activeApiBaseUrl}\n`
    );

    const queriesCa = [
      'INVERSIONES, C.A.',
      'DISTRIBUIDORA ZULIA, C.A.',
      'COMERCIAL VALENCIA, C.A.',
      'Degustación Café',
      'Merida Andes',
    ];

    const evidenceUploadPath = process.env.STRESS_EVIDENCE_PATH ?? '/api/asistencia/evidencias';
    const rateLimitProbePath = process.env.STRESS_RATELIMIT_PATH ?? '/api/asistencia/evidencias';

    let toctouWinnerPath: string | null = null;

    const scenarios: ScenarioConfig[] = [
      {
        name: '1. Historial filtrado (statusFilter + shiftFilter + searchQuery)',
        totalRequests: 80,
        concurrency: 10,
        maxP95Ms: 600,
        expectedStatuses: [200],
        requestFactory: async (i) => {
          const q = queriesCa[i % queriesCa.length]!;
          const shiftFilter = i % 2 === 0 ? 'MAÑANA' : 'TARDE';
          const statusFilter = i % 3 === 0 ? 'APROBADA' : 'PENDIENTE';
          const result = await weeklyMod.queryServerPaginatedHistorialSurveys(
            {
              page: 1,
              pageSize: 20,
              statusFilter,
              shiftFilter,
              searchQuery: q,
            },
            { referenceNow: '2026-11-23T12:00:00.000Z' }
          );
          return new Response(JSON.stringify({ total: result.totalCount }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
      {
        name: '2. Búsqueda masiva razones sociales (", C.A.") y caché LRU',
        totalRequests: 150,
        concurrency: 15,
        maxP95Ms: 400,
        expectedStatuses: [200],
        requestFactory: async (i) => {
          const region = ALLOWED_REGIONS[i % ALLOWED_REGIONS.length]!;
          // Mezcla términos repetidos (cache hits) y 40 variantes distintas (evictions acotadas en LRU max=30)
          const term =
            i % 3 === 0
              ? queriesCa[i % queriesCa.length]!
              : `${queriesCa[i % queriesCa.length]!} ${i % 40}`;
          const rows = await masterMod.obtenerClientesMaestros({
            region,
            busqueda: term,
          });
          return new Response(JSON.stringify({ count: rows.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
      {
        name: '3. Sincronización regional priorizada (OCCIDENTE -> CENTRO -> ANDES)',
        totalRequests: 12,
        concurrency: 3,
        maxP95Ms: 2500,
        expectedStatuses: [200],
        requestFactory: async (i) => {
          const region = ALLOWED_REGIONS[i % ALLOWED_REGIONS.length]!;
          const syncSummary = await masterMod.sincronizarClientesPorPerfilRegional({
            actorProfile: {
              userId: MOCK_ACTORS.admin.id,
              role: 'super_admin',
              assignedRegion: null,
              isGlobalAdmin: true,
            },
            clientesPorRegion: {
              [region]: [
                {
                  codigo_cliente: `STRESS-SYNC-${region}-${i + 1}`,
                  rif: `J-5000${String(1000 + i)}-2`,
                  razon_social: `COMERCIAL ${region} ESTRÉS ${i + 1}, C.A.`,
                  nombre_comercial: `${region} ESTRÉS ${i + 1}`,
                  canal: 'Supermercado',
                  ciudad: region === 'OCCIDENTE' ? 'Maracaibo' : region === 'CENTRO' ? 'Valencia' : 'Mérida',
                  estado: region === 'OCCIDENTE' ? 'Zulia' : region === 'CENTRO' ? 'Carabobo' : 'Mérida',
                },
              ],
            },
            regionesObjetivo: [region],
            batchSize: 50,
          });
          // Además verificar lectura concurrente de promotoras segmentadas en servidor Express real
          const promoRes = await fetchWithTimeout(
            activeApiBaseUrl,
            `/api/promotoras?region=${encodeURIComponent(region)}`,
            activeAuthToken
          );
          if (!promoRes.ok) {
            return promoRes;
          }
          await promoRes.arrayBuffer();
          return new Response(
            JSON.stringify({ regiones: syncSummary.ordenPrioridadEjecutado }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        },
      },
      {
        name: '4. Concurrencia TOCTOU en reemplazo simultáneo de evidencias',
        totalRequests: 12,
        concurrency: 12,
        maxP95Ms: 1500,
        // Esperamos exactamente 1 éxito (200) y 11 conflictos controlados (409)
        expectedStatuses: [200, 409],
        requestFactory: async (i) => {
          if (mock) {
            // Inyectar ligera latencia de RTT para forzar solapamiento real de la ventana TOCTOU
            mock.faultInjection.artificialDelayMs = 15;
          }
          const metaHeader = encodeBase64UrlJson({
            promotoraId: fixture.promotoraId,
            fechaJornada: fixture.fechaJornada,
            slotFoto: 'JORNADA_INGRESO',
            pdvNombre: `PDV ESTRÉS CONCURRENTE #${i + 1}`,
            expectedVersion: 1,
          });
          const res = await fetchWithTimeout(activeApiBaseUrl, evidenceUploadPath, activeAuthToken, {
            method: 'POST',
            headers: {
              'Content-Type': 'image/png',
              'X-Asistencia-Meta': metaHeader,
              'x-sucursal-activa': 'ZULIA',
            },
            body: new Uint8Array(makeDistinctValidPng(i + 1)),
          });
          if (res.status === 200) {
            const clone = res.clone();
            const json = (await clone.json().catch(() => null)) as
              | { evidencia?: { storagePath?: string } }
              | null;
            if (json?.evidencia?.storagePath) {
              toctouWinnerPath = json.evidencia.storagePath;
            }
          }
          return res;
        },
      },
      {
        name: '5. Ráfaga Rate Limiter previo a requireAttendanceActorAuth (espera 429)',
        totalRequests: 60,
        concurrency: 20,
        maxP95Ms: 300,
        expectedStatuses: [401, 403, 429],
        requestFactory: () => {
          if (mock) {
            mock.faultInjection.artificialDelayMs = 0;
          }
          return fetchWithTimeout(activeApiBaseUrl, rateLimitProbePath, '', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer invalid-token-rate-limit-probe-1234567890',
              'Content-Type': 'image/png',
            },
            body: new Uint8Array(VALID_1X1_PNG),
          });
        },
      },
    ];

    const reports: ScenarioReport[] = [];
    let lruMetricsPeak = masterMod.getMasterDataCacheMetrics().clientes;
    for (let idx = 0; idx < scenarios.length; idx++) {
      const scenario = scenarios[idx]!;
      const report = await runScenario(scenario);
      reports.push(report);
      if (idx === 1) {
        lruMetricsPeak = { ...masterMod.getMasterDataCacheMetrics().clientes };
      }
      if (mock) {
        mock.faultInjection.artificialDelayMs = 0;
      }
    }

    console.table(
      reports.map((r) => ({
        Escenario: r.name,
        Total: r.total,
        OK: r.ok,
        Fallos: r.unexpected,
        'P50(ms)': r.p50Ms,
        'P95(ms)': r.p95Ms,
        'P99(ms)': r.p99Ms,
        RPS: r.throughputRps,
        'Heap Δ(MB)': r.heapDeltaMb,
        Estado: r.passed ? 'PASS' : 'FAIL',
      }))
    );

    const cacheMetricsFinal = masterMod.getMasterDataCacheMetrics().clientes;
    console.log('📊 Observabilidad Caché LRU (Clientes — pico Escenario 2):', lruMetricsPeak);
    console.log('🧹 Caché LRU tras invalidación de sincronización regional (Escenario 3):', {
      size: cacheMetricsFinal.size,
      maxItems: cacheMetricsFinal.maxItems,
    });

    // Validación explícita TOCTOU (Escenario 4)
    const toctouReport = reports[3]!;
    const toctouWinners = toctouReport.statusCounts[200] ?? 0;
    const toctouConflicts = toctouReport.statusCounts[409] ?? 0;
    let toctouConsistent = toctouWinners === 1 && toctouConflicts === toctouReport.total - 1;
    if (mock) {
      const dbRows = mock.tables.asistencia_evidencias.length;
      const storageCount = mock.storageObjects.size;
      const winnerExistsInStorage = toctouWinnerPath
        ? mock.storageObjects.has(`asistencia-evidencias/${toctouWinnerPath}`)
        : false;
      const oldDeleted = !mock.storageObjects.has(
        `asistencia-evidencias/${fixture.initialStoragePath}`
      );
      console.log('🔒 Integridad TOCTOU BD <-> Storage:', {
        ganadores200: toctouWinners,
        conflictos409: toctouConflicts,
        filasBD: dbRows,
        objetosStorage: storageCount,
        objetosHuerfanos: storageCount - dbRows,
        archivoGanadorIntacto: winnerExistsInStorage,
        archivoAnteriorLimpiado: oldDeleted,
      });
      toctouConsistent =
        toctouConsistent &&
        dbRows === 1 &&
        storageCount === 1 &&
        winnerExistsInStorage &&
        oldDeleted;
    }

    // Validación explícita LRU acotada (Escenario 2)
    const lruBounded =
      lruMetricsPeak.size <= lruMetricsPeak.maxItems &&
      lruMetricsPeak.hits > 0 &&
      lruMetricsPeak.evictions > 0 &&
      cacheMetricsFinal.size === 0;
    if (!lruBounded) {
      console.error('⚠️ ALERTA DE MEMORIA: La caché LRU no respetó su límite o no registró hits.');
    }

    // Validación explícita de que el rate limiter realmente disparó 429 en el escenario 5
    const rateLimitReport = reports[reports.length - 1]!;
    const triggered429 = (rateLimitReport.statusCounts[429] ?? 0) > 0;
    console.log('🛡️ Distribución HTTP Rate Limiter (Escenario 5):', rateLimitReport.statusCounts);
    if (!triggered429) {
      console.error(
        '\n⚠️ ALERTA DE SEGURIDAD: El escenario 5 no devolvió ningún HTTP 429. ' +
          'Verifica que el rate limiter corra antes de requireAttendanceActorAuth y su umbral.'
      );
    }

    const allPassed =
      reports.every((r) => r.passed) && triggered429 && toctouConsistent && lruBounded;
    if (!allPassed) {
      console.error('\n❌ Algunos escenarios incumplieron el SLA o los controles de seguridad.');
      process.exitCode = 1;
    } else {
      console.log('\n✅ Todos los escenarios de estrés pasaron dentro del SLA y sin fugas.');
    }
  } finally {
    if (serverClose) {
      await serverClose();
    }
    if (mock) {
      await mock.close();
    }
  }
}

main().catch((err) => {
  console.error(
    '❌ Error fatal ejecutando pruebas de estrés:',
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
