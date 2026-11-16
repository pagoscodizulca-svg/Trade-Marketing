import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  MOCK_ACTORS,
  MOCK_CRON_SECRET,
  MOCK_PUBLIC_ANON_KEY,
  MOCK_SERVICE_ROLE_KEY,
  startLocalMockInfra,
} from './localMockInfra';

const VALID_1X1_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex'
);

interface StressStageMetrics {
  scenario: string;
  endpoint: string;
  concurrency: number;
  totalRequests: number;
  wallDurationMs: number;
  throughputRps: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  status2xx: number;
  status4xx: number;
  status429: number;
  status5xx: number;
  socketErrors: number;
  runnerHeapDeltaMb: number;
  runnerRssMb: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  upstreamMockCallsDelta: number;
  notes?: string;
}

function computePercentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1)
  );
  return Number(sortedAsc[idx]!.toFixed(2));
}

function encodeMetaHeader(meta: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(meta), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function waitForHealthReady(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((res) => setTimeout(res, 120));
  }
  throw new Error(`Servidor Express local no respondió en ${baseUrl} tras ${timeoutMs}ms`);
}

async function spawnIsolatedExpressServer(
  port: number,
  mockBaseUrl: string
): Promise<{ child: ChildProcess; stop: () => Promise<void> }> {
  const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
  const guardPath = './tests/antigravity_audit/networkEgressGuard.mjs';

  const child = spawn(
    process.execPath,
    [tsxCli, '--import', guardPath, 'server.ts'],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        SKIP_CHOFER_SERVER: 'true',
        AUDIT_MOCK_BASE_URL: mockBaseUrl,
        VITE_SUPABASE_URL: mockBaseUrl,
        SUPABASE_URL: mockBaseUrl,
        VITE_SUPABASE_ANON_KEY: MOCK_PUBLIC_ANON_KEY,
        SUPABASE_ANON_KEY: MOCK_PUBLIC_ANON_KEY,
        VITE_SUPABASE_MASTER_URL: '',
        VITE_SUPABASE_MASTER_ANON_KEY: '',
        SUPABASE_SERVICE_ROLE_KEY: MOCK_SERVICE_ROLE_KEY,
        CRON_SECRET: MOCK_CRON_SECRET,
        GEMINI_API_KEY: '',
        OPENAI_API_KEY: '',
        APP_TIMEZONE: 'America/Caracas',
      },
    }
  );

  let stderrLog = '';
  child.stderr?.on('data', (chunk) => {
    stderrLog += chunk.toString();
  });

  try {
    await waitForHealthReady(`http://127.0.0.1:${port}`);
  } catch (err) {
    child.kill();
    throw new Error(`${(err as Error).message}. Stderr: ${stderrLog.slice(0, 400)}`);
  }

  return {
    child,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.killed || child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
          resolve();
        }, 1500);
      }),
  };
}

async function runConcurrentBurst(params: {
  scenario: string;
  endpoint: string;
  concurrency: number;
  mockRecordedArray: Array<unknown>;
  executeOne: (index: number) => Promise<number>; // returns HTTP status code
  notes?: string;
}): Promise<StressStageMetrics> {
  if (global.gc) global.gc();
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const mockBefore = params.mockRecordedArray.length;

  const latencies: number[] = [];
  let status2xx = 0;
  let status4xx = 0;
  let status429 = 0;
  let status5xx = 0;
  let socketErrors = 0;

  const wallStart = performance.now();

  await Promise.all(
    Array.from({ length: params.concurrency }, async (_, idx) => {
      const reqStart = performance.now();
      try {
        const status = await params.executeOne(idx);
        const elapsed = performance.now() - reqStart;
        latencies.push(elapsed);
        if (status >= 200 && status < 300) status2xx++;
        else if (status >= 400 && status < 500) {
          status4xx++;
          if (status === 429) status429++;
        } else if (status >= 500) {
          status5xx++;
        }
      } catch {
        const elapsed = performance.now() - reqStart;
        latencies.push(elapsed);
        socketErrors++;
      }
    })
  );

  const wallDurationMs = Number((performance.now() - wallStart).toFixed(2));
  const cpuDelta = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg =
    sorted.length > 0
      ? Number((sorted.reduce((acc, v) => acc + v, 0) / sorted.length).toFixed(2))
      : 0;

  return {
    scenario: params.scenario,
    endpoint: params.endpoint,
    concurrency: params.concurrency,
    totalRequests: params.concurrency,
    wallDurationMs,
    throughputRps:
      wallDurationMs > 0
        ? Number(((params.concurrency / wallDurationMs) * 1000).toFixed(2))
        : 0,
    avgLatencyMs: avg,
    p50LatencyMs: computePercentile(sorted, 50),
    p95LatencyMs: computePercentile(sorted, 95),
    p99LatencyMs: computePercentile(sorted, 99),
    maxLatencyMs: sorted.length > 0 ? Number(sorted[sorted.length - 1]!.toFixed(2)) : 0,
    status2xx,
    status4xx,
    status429,
    status5xx,
    socketErrors,
    runnerHeapDeltaMb: Number(
      ((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2)
    ),
    runnerRssMb: Number((memAfter.rss / (1024 * 1024)).toFixed(2)),
    cpuUserMs: Number((cpuDelta.user / 1000).toFixed(2)),
    cpuSystemMs: Number((cpuDelta.system / 1000).toFixed(2)),
    upstreamMockCallsDelta: params.mockRecordedArray.length - mockBefore,
    notes: params.notes,
  };
}

async function main() {
  console.log('======================================================================');
  console.log(' PASO 4 — PRUEBAS DE ESTRÉS CONTROLADAS LOCALES (10 / 50 / 100 CONC.)');
  console.log(' Destino exclusivo: 127.0.0.1 (Cero tráfico a producción)');
  console.log('======================================================================');

  const mock = await startLocalMockInfra(0);
  process.env.AUDIT_MOCK_BASE_URL = mock.baseUrl;
  process.env.VITE_SUPABASE_URL = mock.baseUrl;
  process.env.SUPABASE_URL = mock.baseUrl;
  process.env.VITE_SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
  process.env.SUPABASE_ANON_KEY = MOCK_PUBLIC_ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = MOCK_SERVICE_ROLE_KEY;
  process.env.CRON_SECRET = MOCK_CRON_SECRET;

  const allMetrics: StressStageMetrics[] = [];
  const tiers = [10, 50, 100] as const;

  let cronLockoutProof: {
    unauthorizedBurstSent: number;
    legitimateCronStatusAfterBurst: number;
  } | null = null;

  try {
    // ------------------------------------------------------------------------
    // ESCENARIO A: GET /api/health (Sonda TCP síncrona por request a :5174)
    // ------------------------------------------------------------------------
    {
      const srvPort = 4191;
      const srv = await spawnIsolatedExpressServer(srvPort, mock.baseUrl);
      try {
        for (const c of tiers) {
          const m = await runConcurrentBurst({
            scenario: 'Health Check + Sonda TCP :5174',
            endpoint: 'GET /api/health',
            concurrency: c,
            mockRecordedArray: mock.recordedRequests,
            executeOne: async () => {
              const r = await fetch(`http://127.0.0.1:${srvPort}/api/health`);
              await r.arrayBuffer();
              return r.status;
            },
            notes: 'Cada GET /api/health abre un net.Socket() hacia 127.0.0.1:5174 (isPortListening)',
          });
          allMetrics.push(m);
          console.log(
            `[A] GET /api/health (${c} conc) -> avg=${m.avgLatencyMs}ms p95=${m.p95LatencyMs}ms p99=${m.p99LatencyMs}ms rps=${m.throughputRps} 2xx=${m.status2xx} err=${m.socketErrors}`
          );
        }
      } finally {
        await srv.stop();
      }
    }

    // ------------------------------------------------------------------------
    // ESCENARIO B: POST /api/asistencia/evidencias (Magic Bytes + SHA-256 + Zod + Storage + Upsert)
    // Se reinicia instancia local por escalón para medir limpiamente el límite de 40 req/5min
    // ------------------------------------------------------------------------
    for (const c of tiers) {
      mock.resetSeedData();
      const srvPort = 4192;
      const srv = await spawnIsolatedExpressServer(srvPort, mock.baseUrl);
      try {
        const metaHeader = encodeMetaHeader({
          fechaJornada: '2026-11-16',
          promotoraId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          slotFoto: 'JORNADA_INGRESO',
          pdvNombre: 'SUPERMERCADO FIORELLA (NORTE)',
          zona: 'MARACAIBO NORTE',
          anchoPx: 1200,
          altoPx: 900,
        });

        const m = await runConcurrentBurst({
          scenario: 'Carga Binaria Evidencia Fotográfica + RBAC + Storage',
          endpoint: 'POST /api/asistencia/evidencias',
          concurrency: c,
          mockRecordedArray: mock.recordedRequests,
          executeOne: async () => {
            const r = await fetch(`http://127.0.0.1:${srvPort}/api/asistencia/evidencias`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${MOCK_ACTORS.promotoraFija.token}`,
                'Content-Type': 'image/png',
                'X-Asistencia-Meta': metaHeader,
              },
              body: VALID_1X1_PNG,
            });
            await r.arrayBuffer();
            return r.status;
          },
          notes: 'Rate limiter = 40 req/5min, pero requireAttendanceActorAuth se ejecuta ANTES del rate limiter',
        });
        allMetrics.push(m);
        console.log(
          `[B] POST /api/asistencia/evidencias (${c} conc) -> avg=${m.avgLatencyMs}ms p95=${m.p95LatencyMs}ms p99=${m.p99LatencyMs}ms 2xx=${m.status2xx} 429=${m.status429} upstreamCalls=${m.upstreamMockCallsDelta}`
        );
      } finally {
        await srv.stop();
      }
    }

    // ------------------------------------------------------------------------
    // ESCENARIO C: POST /api/asistencia/evidencias/signed-urls (Batch 60 UUIDs)
    // ------------------------------------------------------------------------
    for (const c of tiers) {
      mock.resetSeedData();
      // Seed 60 valid evidences for promotoraFija
      const jornadaId = '55559999-9999-4999-8999-999999999999';
      mock.tables.asistencias_jornada.push({
        id: jornadaId,
        fecha_jornada: '2026-11-16',
        promotora_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promotora_nombre: 'María Piña',
        perfil_aplicado: 'FIJA',
      });
      const batchIds: string[] = [];
      for (let i = 0; i < 60; i++) {
        const evId = crypto.randomUUID();
        const stPath = `asistencia/2026-11-16/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/JORNADA_INGRESO_${evId}.png`;
        batchIds.push(evId);
        mock.tables.asistencia_evidencias.push({
          id: evId,
          asistencia_id: jornadaId,
          slot_foto: 'JORNADA_INGRESO',
          storage_bucket: 'asistencia-evidencias',
          storage_path: stPath,
          mime_type: 'image/png',
          tamano_bytes: 68,
        });
        mock.storageObjects.set(`asistencia-evidencias/${stPath}`, {
          bucket: 'asistencia-evidencias',
          mimeType: 'image/png',
          size: 68,
          sha256: 'a'.repeat(64),
        });
      }

      const srvPort = 4193;
      const srv = await spawnIsolatedExpressServer(srvPort, mock.baseUrl);
      try {
        const jsonPayload = JSON.stringify({ evidenciaIds: batchIds });
        const m = await runConcurrentBurst({
          scenario: 'Generación Lote 60 Signed URLs + Anti-IDOR Join',
          endpoint: 'POST /api/asistencia/evidencias/signed-urls',
          concurrency: c,
          mockRecordedArray: mock.recordedRequests,
          executeOne: async () => {
            const r = await fetch(
              `http://127.0.0.1:${srvPort}/api/asistencia/evidencias/signed-urls`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${MOCK_ACTORS.coordinadora.token}`,
                  'Content-Type': 'application/json',
                },
                body: jsonPayload,
              }
            );
            await r.arrayBuffer();
            return r.status;
          },
          notes: 'Rate limiter = 60 req/60s; procesa 60 UUIDs por solicitud',
        });
        allMetrics.push(m);
        console.log(
          `[C] POST /api/asistencia/evidencias/signed-urls (${c} conc) -> avg=${m.avgLatencyMs}ms p95=${m.p95LatencyMs}ms p99=${m.p99LatencyMs}ms 2xx=${m.status2xx} 429=${m.status429}`
        );
      } finally {
        await srv.stop();
      }
    }

    // ------------------------------------------------------------------------
    // ESCENARIO D: POST /api/cron/degustaciones-cierre-semanal (Fallback N+1 + Bloqueo 429)
    // ------------------------------------------------------------------------
    {
      mock.resetSeedData();
      // Seed 120 unarchived past degustaciones and force fallback SDK loop (N+1 sequential updates)
      mock.faultInjection.forceRpcMissing.add('ejecutar_cierre_dominical_degustaciones');
      for (let i = 0; i < 120; i++) {
        mock.tables.surveys.push({
          id: crypto.randomUUID(),
          type: 'Degustacion',
          date: '2026-11-10',
          fecha_evento: '2026-11-10',
          store: `PDV CARGA ${i + 1}`,
          promoter: 'CARLOS PEÑA',
          product: 'MORTADELA ASTURIAS',
          comments: JSON.stringify({ date: '2026-11-10', estado: 'SOLICITADA', en_historial: false }),
          created_at: '2026-11-10T12:00:00Z',
        });
      }

      const srvPort = 4194;
      const srv = await spawnIsolatedExpressServer(srvPort, mock.baseUrl);
      try {
        // First prove the 6-request unauthenticated rate-limiter DoS on the legitimate Cron trigger!
        for (let k = 0; k < 6; k++) {
          await fetch(`http://127.0.0.1:${srvPort}/api/cron/degustaciones-cierre-semanal`, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer invalid-attacker-token',
              'Content-Type': 'application/json',
            },
            body: '{}',
          });
        }
        const legitAfterSpam = await fetch(
          `http://127.0.0.1:${srvPort}/api/cron/degustaciones-cierre-semanal`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${MOCK_CRON_SECRET}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ forceRun: true }),
          }
        );
        cronLockoutProof = {
          unauthorizedBurstSent: 6,
          legitimateCronStatusAfterBurst: legitAfterSpam.status,
        };
        console.log(
          `[D-SEC] Prueba bloqueo Cron por orden de middleware: 6 peticiones sin credencial -> Cron legítimo recibió HTTP ${legitAfterSpam.status}`
        );
      } finally {
        await srv.stop();
        mock.faultInjection.forceRpcMissing.delete('ejecutar_cierre_dominical_degustaciones');
      }
    }

    // Also run 10, 50, 100 concurrency tiers on /api/cron/degustaciones-cierre-semanal
    for (const c of tiers) {
      mock.resetSeedData();
      const srvPort = 4195;
      const srv = await spawnIsolatedExpressServer(srvPort, mock.baseUrl);
      try {
        const m = await runConcurrentBurst({
          scenario: 'Cron Cierre Semanal (Reconciliación Render + RPC)',
          endpoint: 'POST /api/cron/degustaciones-cierre-semanal',
          concurrency: c,
          mockRecordedArray: mock.recordedRequests,
          executeOne: async () => {
            const r = await fetch(
              `http://127.0.0.1:${srvPort}/api/cron/degustaciones-cierre-semanal`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${MOCK_CRON_SECRET}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ forceRun: true }),
              }
            );
            await r.arrayBuffer();
            return r.status;
          },
          notes: 'weeklyCronRateLimiter = 6 req/60s; las primeras 6 ejecutan reconciliación completa y el resto corta en 429',
        });
        allMetrics.push(m);
        console.log(
          `[D] POST /api/cron/degustaciones-cierre-semanal (${c} conc) -> avg=${m.avgLatencyMs}ms p95=${m.p95LatencyMs}ms p99=${m.p99LatencyMs}ms 2xx=${m.status2xx} 429=${m.status429}`
        );
      } finally {
        await srv.stop();
      }
    }

    // ------------------------------------------------------------------------
    // ESCENARIO E: Estrés sobre Consultas Pesadas de Filtrado y Paginación (2,500 filas)
    // ------------------------------------------------------------------------
    {
      mock.resetSeedData();
      for (let i = 0; i < 2500; i++) {
        mock.tables.clientes.push({
          id: crypto.randomUUID(),
          codigo_cliente: `CLI-STRESS-${String(i + 1).padStart(4, '0')}`,
          rif: `J-${String(300000000 + i)}`,
          razon_social: `COMERCIALIZADORA ZULIANA ${i + 1} C.A.`,
          nombre_comercial: `PDV ZULIA ${i + 1}`,
          canal: i % 2 === 0 ? 'Supermercado' : 'Mayorista',
          zona: i % 3 === 0 ? 'MARACAIBO NORTE' : 'SAN FRANCISCO',
          ruta: `RUTA ${(i % 8) + 1}`,
          vendedor_id: 'eeee1111-1111-4111-8111-111111111111',
          codigo_vendedor: 'V001',
          activo: true,
        });
        mock.tables.surveys.push({
          id: crypto.randomUUID(),
          type: 'Degustacion',
          date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
          fecha_evento: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
          store: `PDV ZULIA ${i + 1}`,
          promoter: i % 2 === 0 ? 'María Piña' : 'Scarleth Núñez',
          product: i % 3 === 0 ? 'MORTADELA ASTURIAS' : 'ARROZ VENCAMPO',
          en_historial: true,
          comments: JSON.stringify({
            cliente: `PDV ZULIA ${i + 1}`,
            vendedor: 'CARLOS PEÑA',
            estado: 'COMPLETADA',
            turno: i % 2 === 0 ? 'MAÑANA' : 'TARDE',
          }),
          created_at: '2026-10-28T12:00:00Z',
        });
      }

      const masterSyncSvc = await import('../../src/services/masterDataSyncService');
      const weeklyCycleSvc = await import('../../src/services/degustacionesWeeklyCycleService');

      for (const c of tiers) {
        const m = await runConcurrentBurst({
          scenario: 'Filtrado Pesado Paginado Multi-Tabla (2,500 Clientes + 2,500 Surveys)',
          endpoint: 'SDK obtenerClientesMaestros + queryServerPaginatedHistorialSurveys',
          concurrency: c,
          mockRecordedArray: mock.recordedRequests,
          executeOne: async (idx) => {
            if (idx % 2 === 0) {
              const rows = await masterSyncSvc.obtenerClientesMaestros({
                zona: 'MARACAIBO NORTE',
                busqueda: `ZULIA ${(idx % 50) + 1}`,
                forzarRefresco: true,
              });
              return rows.length >= 0 ? 200 : 500;
            } else {
              const page = await weeklyCycleSvc.queryServerPaginatedHistorialSurveys(
                {
                  page: (idx % 10) + 1,
                  pageSize: 25,
                  productFilter: 'MORTADELA',
                  searchQuery: 'CARLOS',
                },
                { referenceNow: '2026-11-16T15:00:00Z' }
              );
              return page.rows.length >= 0 ? 200 : 500;
            }
          },
          notes: 'Cada obtenerClientesMaestros sin filtro estrecho pagina de 1000 en 1000 filas',
        });
        allMetrics.push(m);
        console.log(
          `[E] Filtrado/Paginación 2,500 regs (${c} conc) -> avg=${m.avgLatencyMs}ms p95=${m.p95LatencyMs}ms p99=${m.p99LatencyMs}ms rps=${m.throughputRps} heapDelta=${m.runnerHeapDeltaMb}MB`
        );
      }
    }

    const outDir = path.resolve('tests/antigravity_audit/results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'step4_stress_results.json'),
      JSON.stringify(
        {
          executedAt: new Date().toISOString(),
          targetHost: '127.0.0.1',
          cronLockoutProof,
          metrics: allMetrics,
        },
        null,
        2
      ),
      'utf8'
    );
    console.log('\n✓ Métricas de estrés guardadas en tests/antigravity_audit/results/step4_stress_results.json');
  } finally {
    await mock.close();
  }
}

void main();
