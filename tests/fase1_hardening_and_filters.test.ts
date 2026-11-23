import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { analyzeMigrations, formatIssues, type MigrationFile } from './support/sqlMigrationAnalyzer';
import { runStaticCertification } from '../scripts/certifySchemaProduction';
import {
  isWildcardAllFilter,
  queryServerPaginatedHistorialSurveys,
  sanitizePostgrestOrToken,
} from '../src/services/degustacionesWeeklyCycleService';
import { fetchLiveBcvRate, resolveBcvFetchTimeoutMs } from '../src/services/supabaseModule1';
import {
  extractDegustacionesFromPdfBuffer,
  PdfExtractionError,
  resolveAiExtractorTimeoutMs,
} from '../src/server/pdfDegustacionesExtractor';
import { createMemoryRateLimitStore, createRateLimiter } from '../src/server/supabaseAdminAuth';
import { createLogger } from '../src/server/logger';
import {
  createGracefulShutdownController,
  registerProcessShutdownHandlers,
  resolveShutdownTimeoutMs,
  validateServerEnvConfig,
} from '../src/server/gracefulShutdown';
import { app as prodApp, registerAttendanceEvidenceRoutes } from '../server';

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const PHASE1_SQL_FILE = '20261124000100_fase1_audit_discrepancies_y_filtros_historial.sql';

interface RecordedQueryOp {
  method: string;
  args: unknown[];
}

function createMockSupabaseSurveyClient(options?: {
  failFirstWithUndefinedColumn?: boolean;
  rows?: Array<Record<string, unknown>>;
}): {
  client: SupabaseClient;
  queryBatches: RecordedQueryOp[][];
} {
  const queryBatches: RecordedQueryOp[][] = [];
  let callIndex = 0;

  const client = {
    from(table: string) {
      const ops: RecordedQueryOp[] = [{ method: 'from', args: [table] }];
      queryBatches.push(ops);
      const currentCall = callIndex++;

      const builder: Record<string, (...args: unknown[]) => unknown> = {
        select: (...args) => {
          ops.push({ method: 'select', args });
          return builder;
        },
        eq: (...args) => {
          ops.push({ method: 'eq', args });
          return builder;
        },
        lt: (...args) => {
          ops.push({ method: 'lt', args });
          return builder;
        },
        gte: (...args) => {
          ops.push({ method: 'gte', args });
          return builder;
        },
        lte: (...args) => {
          ops.push({ method: 'lte', args });
          return builder;
        },
        ilike: (...args) => {
          ops.push({ method: 'ilike', args });
          return builder;
        },
        or: (...args) => {
          ops.push({ method: 'or', args });
          return builder;
        },
        order: (...args) => {
          ops.push({ method: 'order', args });
          return builder;
        },
        range: async (...args) => {
          ops.push({ method: 'range', args });
          if (options?.failFirstWithUndefinedColumn && currentCall === 0) {
            return {
              data: null,
              count: null,
              error: { code: '42703', message: 'column surveys.fecha_evento does not exist' },
            };
          }
          const rows = options?.rows ?? [];
          return { data: rows, count: rows.length, error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, queryBatches };
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// =============================================================================
// 1. MIGRACIÓN SQL FASE 1 (audit_logs, discrepancy_alerts, "Regiones" RLS, índices)
// =============================================================================
test('Fase 1 · Tarea 1: Migración SQL idempotente, RLS y compatibilidad estática', async (t) => {
  await t.test('la cadena completa de migraciones pasa analizador estático y certificador sin errores', () => {
    const files: MigrationFile[] = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));

    const analysis = analyzeMigrations(files);
    assert.equal(analysis.errors.length, 0, formatIssues(analysis.errors));
    assert.ok(analysis.tables.has('audit_logs'), 'public.audit_logs debe existir en el esquema resultante');
    assert.ok(
      analysis.tables.has('discrepancy_alerts'),
      'public.discrepancy_alerts debe existir en el esquema resultante'
    );

    const cert = runStaticCertification(MIGRATIONS_DIR);
    assert.equal(cert.passed, true, JSON.stringify(cert.checks.filter((c) => !c.passed)));
  });

  await t.test('contiene columnas requeridas, RLS forzoso, soporte service_role, "Regiones" y cero DDL destructivo', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, PHASE1_SQL_FILE), 'utf8');
    const sqlWithoutComments = sql
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    // Tablas idempotentes y cero DDL destructivo en sentencias ejecutables
    assert.match(sqlWithoutComments, /CREATE TABLE IF NOT EXISTS public\.audit_logs/i);
    assert.match(sqlWithoutComments, /CREATE TABLE IF NOT EXISTS public\.discrepancy_alerts/i);
    assert.doesNotMatch(sqlWithoutComments, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);

    // RLS forzoso + revocación anon + soporte service_role
    assert.match(sql, /ALTER TABLE public\.audit_logs ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.audit_logs FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.discrepancy_alerts ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.discrepancy_alerts FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.audit_logs FROM PUBLIC, anon/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.discrepancy_alerts FROM PUBLIC, anon/);
    assert.match(sql, /CREATE POLICY audit_logs_service_role_all[\s\S]*TO service_role/);
    assert.match(sql, /CREATE POLICY discrepancy_alerts_service_role_all[\s\S]*TO service_role/);

    // Identificador exacto "Regiones"(id_regi) + 3 regiones válidas sin UUIDs hardcodeados
    assert.match(sql, /REFERENCES public\."Regiones"\s*\(id_regi\)/);
    assert.match(sql, /regi_desd[\s\S]*'OCCIDENTE',\s*'CENTRO',\s*'ANDES'/);
    assert.doesNotMatch(
      sql,
      /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i,
      'No se deben hardcodear UUIDs en la migración SQL'
    );

    // Índices compuestos recomendados
    assert.match(sql, /idx_audit_logs_region_created_at/);
    assert.match(sql, /idx_discrepancy_alerts_status_sev_created/);
    assert.match(sql, /idx_cronograma_deg_historial_estado_turno_fecha/);
    assert.match(sql, /idx_surveys_deg_store_product_fecha/);
  });
});

// =============================================================================
// 2. FILTROS COMPLETOS Y SANITIZADOS EN SERVIDOR (degustacionesWeeklyCycleService)
// =============================================================================
test('Fase 1 · Tarea 2: statusFilter, shiftFilter y searchQuery sanitizado en servidor', async (t) => {
  await t.test('aplica statusFilter, shiftFilter y searchQuery (comments, store, product) en consulta primaria', async () => {
    const { client, queryBatches } = createMockSupabaseSurveyClient({
      rows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          type: 'Degustacion',
          date: '2026-10-10',
          fecha_evento: '2026-10-10',
          store: 'Central Madeirense',
          product: 'MORTADELA',
          comments: JSON.stringify({ estado: 'NO_AUTORIZADA', turno: 'TARDE' }),
        },
      ],
    });

    const res = await queryServerPaginatedHistorialSurveys(
      {
        page: 1,
        pageSize: 25,
        statusFilter: 'NO_AUTORIZADA',
        shiftFilter: 'TARDE',
        searchQuery: 'Central',
      },
      { clientOverride: client, referenceNow: '2026-11-16T15:00:00Z' }
    );

    assert.equal(res.rows.length, 1);
    assert.equal(res.totalCount, 1);
    assert.equal(res.usedIndexedFechaEventoColumn, true);

    const ops = queryBatches[0]!;
    const orCalls = ops.filter((o) => o.method === 'or').map((o) => String(o.args[0]));
    const ilikeCalls = ops.filter((o) => o.method === 'ilike').map((o) => o.args);

    assert.ok(
      orCalls.some((c) => c.includes('NO_AUTORIZADA') && c.includes('motivo_archivo.eq.NO_AUTORIZADA')),
      'statusFilter=NO_AUTORIZADA debe aplicarse vía .or()'
    );
    assert.ok(
      ilikeCalls.some(([col, pat]) => col === 'comments' && String(pat).includes('TARDE')),
      'shiftFilter=TARDE debe aplicarse vía .ilike(comments, %TARDE%)'
    );
    assert.ok(
      orCalls.some(
        (c) =>
          c === 'comments.ilike.%Central%,store.ilike.%Central%,product.ilike.%Central%'
      ),
      'searchQuery debe buscar simultáneamente en comments, store y product'
    );
  });

  await t.test('respeta valores comodín opcionales (TODOS, TODAS, all, vacío) sin emitir filtros extra', async () => {
    assert.equal(isWildcardAllFilter('TODOS'), true);
    assert.equal(isWildcardAllFilter('all'), true);
    assert.equal(isWildcardAllFilter(''), true);
    assert.equal(isWildcardAllFilter('TARDE'), false);

    const { client, queryBatches } = createMockSupabaseSurveyClient();
    await queryServerPaginatedHistorialSurveys(
      {
        page: 1,
        pageSize: 25,
        statusFilter: 'all',
        shiftFilter: 'TODOS',
        productFilter: 'all',
        sellerFilter: 'TODOS',
        promotoraFilter: 'TODAS',
        searchQuery: '   ',
      },
      { clientOverride: client, referenceNow: '2026-11-16T15:00:00Z' }
    );

    const ops = queryBatches[0]!;
    assert.equal(ops.filter((o) => o.method === 'ilike').length, 0);
    // Solo puede existir el .or() base de ventana historial (cuando ENABLE_MODULO1_CICLO_ISO_BADGE es false)
    const searchOrs = ops
      .filter((o) => o.method === 'or')
      .map((o) => String(o.args[0]))
      .filter((expr) => expr.includes('store.ilike.') || expr.includes('TARDE') || expr.includes('PENDIENTE'));
    assert.equal(searchOrs.length, 0);
  });

  await t.test('neutraliza intentos de inyección PostgREST con comas, paréntesis, puntos y comodines LIKE', async () => {
    const malicious = 'foo),id.neq.0,type.eq.Hacked(100%_test*;"bar"';
    const sanitized = sanitizePostgrestOrToken(malicious);

    assert.ok(!sanitized.includes(','), 'No debe conservar comas');
    assert.ok(!sanitized.includes('(') && !sanitized.includes(')'), 'No debe conservar paréntesis');
    assert.ok(!sanitized.includes('.'), 'No debe conservar puntos de operador PostgREST');
    assert.ok(!sanitized.includes('"') && !sanitized.includes('*'), 'No debe conservar comillas ni asteriscos');
    assert.ok(sanitized.includes('100\\%\\_test'), 'Debe escapar comodines % y _');

    const { client, queryBatches } = createMockSupabaseSurveyClient();
    await queryServerPaginatedHistorialSurveys(
      {
        page: 1,
        pageSize: 25,
        searchQuery: malicious,
      },
      { clientOverride: client, referenceNow: '2026-11-16T15:00:00Z' }
    );

    const searchOr = queryBatches[0]!
      .filter((o) => o.method === 'or')
      .map((o) => String(o.args[0]))
      .find((expr) => expr.includes('store.ilike.'));

    assert.ok(searchOr, 'Debe emitir cláusula .or() de búsqueda');
    const clauses = searchOr!.split(',');
    assert.equal(clauses.length, 3, 'Un payload con comas JAMÁS debe inyectar una 4.ª cláusula PostgREST');
    assert.ok(clauses[0]!.startsWith('comments.ilike.%'));
    assert.ok(clauses[1]!.startsWith('store.ilike.%'));
    assert.ok(clauses[2]!.startsWith('product.ilike.%'));

    // Entrada compuesta únicamente por metacaracteres no debe emitir un .or() vacío/roto
    const { client: client2, queryBatches: batches2 } = createMockSupabaseSurveyClient();
    await queryServerPaginatedHistorialSurveys(
      { page: 1, pageSize: 25, searchQuery: ',,,()...***;;;' },
      { clientOverride: client2, referenceNow: '2026-11-16T15:00:00Z' }
    );
    const brokenSearchOr = batches2[0]!
      .filter((o) => o.method === 'or')
      .map((o) => String(o.args[0]))
      .find((expr) => expr.includes('store.ilike.'));
    assert.equal(brokenSearchOr, undefined);
  });

  await t.test('aplica statusFilter, shiftFilter y searchQuery también en el fallback por columna `date`', async () => {
    const { client, queryBatches } = createMockSupabaseSurveyClient({
      failFirstWithUndefinedColumn: true,
      rows: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          type: 'Degustacion',
          date: '2026-10-05',
          store: 'Supermercados Fiorella',
          product: 'ESPALDA',
          comments: JSON.stringify({ estado: 'PROGRAMADA', turno: 'MAÑANA' }),
        },
      ],
    });

    const res = await queryServerPaginatedHistorialSurveys(
      {
        page: 1,
        pageSize: 25,
        statusFilter: 'PROGRAMADO',
        shiftFilter: 'MAÑANA',
        searchQuery: 'Fiorella',
      },
      { clientOverride: client, referenceNow: '2026-11-16T15:00:00Z' }
    );

    assert.equal(res.usedIndexedFechaEventoColumn, false);
    assert.equal(queryBatches.length, 2);

    const fallbackOrs = queryBatches[1]!
      .filter((o) => o.method === 'or')
      .map((o) => String(o.args[0]));

    assert.ok(fallbackOrs.some((c) => c.includes('PROGRAMAD')));
    assert.ok(fallbackOrs.some((c) => c.includes('MAÑANA') && c.includes('MANANA')));
    assert.ok(
      fallbackOrs.some(
        (c) =>
          c === 'comments.ilike.%Fiorella%,store.ilike.%Fiorella%,product.ilike.%Fiorella%'
      )
    );
  });
});

// =============================================================================
// 3. TIMEOUTS CON AbortController (fetchLiveBcvRate + pdfDegustacionesExtractor)
// =============================================================================
test('Fase 1 · Tarea 3: Timeouts con AbortController en BCV y Extractor PDF IA', async (t) => {
  await t.test('fetchLiveBcvRate aborta limpiamente al superar el timeout y devuelve null sin colgar', async () => {
    const prevEnv = process.env.BCV_FETCH_TIMEOUT_MS;
    process.env.BCV_FETCH_TIMEOUT_MS = '35';
    try {
      assert.equal(resolveBcvFetchTimeoutMs(), 35);

      let signalAborted = false;
      const hangingFetch: typeof fetch = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            signalAborted = true;
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });

      const started = Date.now();
      const rate = await fetchLiveBcvRate({ fetchImpl: hangingFetch });
      const elapsed = Date.now() - started;

      assert.equal(rate, null);
      assert.equal(signalAborted, true, 'AbortController debe disparar abort sobre fetch');
      assert.ok(elapsed < 1000, `Debe abortar rápido (~35ms), tardó ${elapsed}ms`);
    } finally {
      if (prevEnv === undefined) delete process.env.BCV_FETCH_TIMEOUT_MS;
      else process.env.BCV_FETCH_TIMEOUT_MS = prevEnv;
    }
  });

  await t.test('fetchLiveBcvRate devuelve tasa redondeada cuando responde antes del timeout', async () => {
    const fastFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ promedio: 68.456 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const rate = await fetchLiveBcvRate({ timeoutMs: 2000, fetchImpl: fastFetch });
    assert.equal(rate, 68.46);
  });

  await t.test('pdfDegustacionesExtractor (OpenAI) aborta con HTTP 504 AI_EXTRACTION_TIMEOUT al exceder timeout', async () => {
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevOpenAi = process.env.OPENAI_API_KEY;
    const prevTimeout = process.env.AI_EXTRACTOR_TIMEOUT_MS;

    delete process.env.GEMINI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-mock-openai-key-for-unit-test';
    process.env.AI_EXTRACTOR_TIMEOUT_MS = '40';

    try {
      assert.equal(resolveAiExtractorTimeoutMs(), 40);
      let aborted = false;
      const hangingFetch: typeof fetch = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });

      const fakePdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
      await assert.rejects(
        () => extractDegustacionesFromPdfBuffer(fakePdf, { fetchImpl: hangingFetch }),
        (err: unknown) => {
          assert.ok(err instanceof PdfExtractionError);
          assert.equal(err.statusCode, 504);
          assert.equal(err.code, 'AI_EXTRACTION_TIMEOUT');
          assert.ok(!err.message.includes('sk-mock-openai-key'));
          return true;
        }
      );
      assert.equal(aborted, true, 'El fetch de OpenAI debe recibir y ejecutar AbortSignal');
    } finally {
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenAi;
      if (prevTimeout === undefined) delete process.env.AI_EXTRACTOR_TIMEOUT_MS;
      else process.env.AI_EXTRACTOR_TIMEOUT_MS = prevTimeout;
    }
  });

  await t.test('pdfDegustacionesExtractor (Gemini) propaga abortSignal, corta por timeout y redacta llaves en errores', async () => {
    const prevGemini = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaMockSecretKeyUnitTest123456';

    try {
      let receivedSignal: AbortSignal | undefined;
      const fakePdf = Buffer.from('%PDF-1.7\n%%EOF', 'ascii');

      await assert.rejects(
        () =>
          extractDegustacionesFromPdfBuffer(fakePdf, {
            timeoutMs: 40,
            geminiClientFactory: () => ({
              models: {
                generateContent: ({ config }) => {
                  receivedSignal = config?.abortSignal;
                  return new Promise(() => {
                    // Simula petición externa colgada
                  });
                },
              },
            }),
          }),
        (err: unknown) => {
          assert.ok(err instanceof PdfExtractionError);
          assert.equal(err.statusCode, 504);
          assert.equal(err.code, 'AI_EXTRACTION_TIMEOUT');
          assert.ok(!err.message.includes('AIzaMockSecretKeyUnitTest123456'));
          return true;
        }
      );

      assert.ok(receivedSignal, 'Gemini debe recibir config.abortSignal');
      assert.equal(receivedSignal!.aborted, true, 'abortSignal de Gemini debe quedar abortado');

      // Verificar sanitización de API key en error genérico
      await assert.rejects(
        () =>
          extractDegustacionesFromPdfBuffer(fakePdf, {
            timeoutMs: 1000,
            geminiClientFactory: () => ({
              models: {
                generateContent: async () => {
                  throw new Error('Upstream rejected key AIzaMockSecretKeyUnitTest123456');
                },
              },
            }),
          }),
        (err: unknown) => {
          assert.ok(err instanceof PdfExtractionError);
          assert.equal(err.code, 'AI_EXTRACTION_FAILED');
          assert.ok(!err.message.includes('AIzaMockSecretKeyUnitTest123456'));
          assert.ok(err.message.includes('[REDACTED_API_KEY]'));
          return true;
        }
      );
    } finally {
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
    }
  });
});

// =============================================================================
// 4. ORDEN DE MIDDLEWARES EN server.ts (Rate Limiter ANTES de Auth)
// =============================================================================
test('Fase 1 · Tarea 4A: Rate Limiter se ejecuta estrictamente ANTES de requireAttendanceActorAuth', async (t) => {
  await t.test('retorna HTTP 429 antes de invocar authMiddleware en /api/asistencia/evidencias y /signed-urls', async () => {
    let authCalls = 0;
    const authSpy: express.RequestHandler = (_req, _res, next) => {
      authCalls += 1;
      next();
    };

    const uploadLimiter = createRateLimiter({
      name: 'test-att-upload',
      windowMs: 60_000,
      maxRequests: 2,
      store: createMemoryRateLimitStore(),
    });
    const signedUrlLimiter = createRateLimiter({
      name: 'test-att-signed',
      windowMs: 60_000,
      maxRequests: 1,
      store: createMemoryRateLimitStore(),
    });

    const testApp = express();
    registerAttendanceEvidenceRoutes(testApp, {
      uploadRateLimiter: uploadLimiter,
      signedUrlRateLimiter: signedUrlLimiter,
      authMiddleware: authSpy,
      uploadHandler: (_req, res) => {
        res.status(201).json({ ok: true });
      },
      signedUrlsHandler: (_req, res) => {
        res.status(200).json({ ok: true });
      },
    });

    const srv = await listen(testApp);
    try {
      // Ruta 1: /api/asistencia/evidencias (límite 2)
      const r1 = await fetch(`${srv.base}/api/asistencia/evidencias`, { method: 'POST' });
      const r2 = await fetch(`${srv.base}/api/asistencia/evidencias`, { method: 'POST' });
      const r3 = await fetch(`${srv.base}/api/asistencia/evidencias`, { method: 'POST' });
      const r4 = await fetch(`${srv.base}/api/asistencia/evidencias`, { method: 'POST' });

      assert.equal(r1.status, 201);
      assert.equal(r2.status, 201);
      assert.equal(r3.status, 429);
      assert.equal(r4.status, 429);
      const body3 = (await r3.json()) as { code?: string };
      assert.equal(body3.code, 'RATE_LIMIT_EXCEEDED');
      assert.equal(
        authCalls,
        2,
        'requireAttendanceActorAuth NO debe invocarse en las peticiones bloqueadas con 429'
      );

      // Ruta 2: /api/asistencia/evidencias/signed-urls (límite 1)
      authCalls = 0;
      const s1 = await fetch(`${srv.base}/api/asistencia/evidencias/signed-urls`, { method: 'POST' });
      const s2 = await fetch(`${srv.base}/api/asistencia/evidencias/signed-urls`, { method: 'POST' });

      assert.equal(s1.status, 200);
      assert.equal(s2.status, 429);
      assert.equal(
        authCalls,
        1,
        'En /signed-urls el rate limiter también debe bloquear con 429 antes de llamar a auth'
      );
    } finally {
      await srv.close();
    }
  });

  await t.test('el router productivo de server.ts registra el rate limiter antes de requireAttendanceActorAuth', () => {
    const routerStack = (
      prodApp as unknown as {
        _router?: {
          stack?: Array<{
            route?: {
              path?: string;
              stack?: Array<{ handle?: { name?: string } }>;
            };
          }>;
        };
      }
    )._router?.stack;

    assert.ok(Array.isArray(routerStack), 'El router de Express en server.ts debe estar inicializado');

    for (const targetPath of ['/api/asistencia/evidencias', '/api/asistencia/evidencias/signed-urls']) {
      const layer = routerStack!.find((l) => l.route?.path === targetPath);
      assert.ok(layer?.route?.stack, `Ruta ${targetPath} debe existir en server.ts`);
      const names = layer!.route!.stack!.map((s) => s.handle?.name || '');
      const authIdx = names.indexOf('requireAttendanceActorAuth');
      assert.ok(authIdx > 0, `En ${targetPath}, el rate limiter debe preceder a requireAttendanceActorAuth (stack: ${names.join(', ')})`);
    }
  });
});

// =============================================================================
// 5. APAGADO ORDENADO (GRACEFUL SHUTDOWN) Y VALIDACIÓN DE ENTORNO
// =============================================================================
test('Fase 1 · Tarea 4B: Graceful Shutdown idempotente y validación de entorno al arranque', async (t) => {
  await t.test('ejecuta cierre ordenado en SIGTERM sin doble ejecución (isShuttingDown) y exit(0)', async () => {
    const logLines: string[] = [];
    const logger = createLogger({
      minLevel: 'info',
      sink: { write: (l) => logLines.push(l) },
    });

    let closeCalls = 0;
    let cleanupCalls = 0;
    const exitCodes: number[] = [];

    const controller = createGracefulShutdownController({
      getServer: () => ({
        close(cb) {
          closeCalls += 1;
          setTimeout(() => cb(), 10);
        },
        closeIdleConnections() {
          // no-op
        },
      }),
      cleanup: async () => {
        cleanupCalls += 1;
      },
      logger,
      forceExitTimeoutMs: 2000,
      exit: (code) => {
        exitCodes.push(code);
      },
    });

    assert.equal(controller.isShuttingDown(), false);
    const [codeA, codeB] = await Promise.all([
      controller.shutdown('SIGTERM'),
      controller.shutdown('SIGINT'),
    ]);

    assert.equal(controller.isShuttingDown(), true);
    assert.equal(codeA, 0);
    assert.equal(codeB, 0);
    assert.equal(closeCalls, 1, 'server.close() solo debe invocarse una vez');
    assert.equal(cleanupCalls, 1, 'cleanup() solo debe invocarse una vez');
    assert.deepEqual(exitCodes, [0]);
    assert.ok(logLines.some((l) => l.includes('graceful_shutdown_duplicate_ignored')));
  });

  await t.test('en uncaughtException redacta secretos en logs y sale con código 1', async () => {
    const logLines: string[] = [];
    const logger = createLogger({
      minLevel: 'info',
      sink: { write: (l) => logLines.push(l) },
    });
    const fakeProc = new EventEmitter();
    const exitCodes: number[] = [];

    const controller = createGracefulShutdownController({
      getServer: () => ({
        close(cb) {
          cb();
        },
      }),
      logger,
      forceExitTimeoutMs: 2000,
      exit: (code) => exitCodes.push(code),
    });

    const dispose = registerProcessShutdownHandlers(controller, fakeProc);
    try {
      fakeProc.emit('uncaughtException', new Error('crash con sb_secret_supersecreto9999'));
      // Esperar resolución asíncrona del cierre
      await new Promise((r) => setTimeout(r, 30));

      assert.deepEqual(exitCodes, [1]);
      assert.ok(logLines.some((l) => l.includes('fatal_process_error_initiating_shutdown')));
      assert.ok(
        logLines.every((l) => !l.includes('supersecreto9999')),
        'Los logs de shutdown jamás deben exponer secretos'
      );
    } finally {
      dispose();
    }
  });

  await t.test('fuerza salida con código 1 al vencer timeout si server.close() se queda colgado', async () => {
    const logLines: string[] = [];
    const logger = createLogger({
      minLevel: 'info',
      sink: { write: (l) => logLines.push(l) },
    });
    const exitCodes: number[] = [];

    const controller = createGracefulShutdownController({
      getServer: () => ({
        close() {
          // Simula conexión keep-alive que nunca cierra
        },
      }),
      logger,
      forceExitTimeoutMs: 40,
      exit: (code) => exitCodes.push(code),
    });

    const started = Date.now();
    const code = await controller.shutdown('SIGTERM');
    const elapsed = Date.now() - started;

    assert.equal(code, 1);
    assert.deepEqual(exitCodes, [1]);
    assert.ok(elapsed < 1000, `Timeout forzado debe dispararse rápidamente (~40ms), tardó ${elapsed}ms`);
    assert.ok(logLines.some((l) => l.includes('graceful_shutdown_forced_exit')));
    assert.equal(resolveShutdownTimeoutMs(undefined, { SHUTDOWN_TIMEOUT_MS: '5000' }), 5000);
  });

  await t.test('validateServerEnvConfig bloquea llaves secretas en VITE_* sin registrar el secreto', () => {
    const logLines: string[] = [];
    const logger = createLogger({
      minLevel: 'info',
      sink: { write: (l) => logLines.push(l) },
    });

    const bad = validateServerEnvConfig(
      {
        VITE_SUPABASE_URL: 'https://apaxdgxtaoeyswlfblgi.supabase.co/rest/v1',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_valor_prohibido_12345',
        BCV_FETCH_TIMEOUT_MS: 'no-es-numero',
      },
      { isProduction: true, logger }
    );

    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 1);
    assert.ok(bad.warnings.length >= 2);
    assert.ok(logLines.every((l) => !l.includes('valor_prohibido_12345')));

    const good = validateServerEnvConfig(
      {
        VITE_SUPABASE_URL: 'https://apaxdgxtaoeyswlfblgi.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_demo',
        BCV_FETCH_TIMEOUT_MS: '10000',
        AI_EXTRACTOR_TIMEOUT_MS: '45000',
        SHUTDOWN_TIMEOUT_MS: '10000',
      },
      { isProduction: true, logger }
    );
    assert.equal(good.ok, true);
    assert.equal(good.warnings.length, 0);
  });
});
