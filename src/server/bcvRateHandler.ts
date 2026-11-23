import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getCaracasIsoDate,
  isReasonableBcvRate,
  round4,
} from '../utils/bimonetaryPriceMath';
import {
  createUserScopedSupabaseClient,
  getAdminSupabaseClient,
} from './supabaseAdminAuth';
import { serverLogger } from './logger';

export type BcvRateSource = 'BCV_OFICIAL' | 'MANUAL_ADMIN' | 'RESPALDO';

export interface BcvRateDbRow {
  fecha: string;
  tasa_usd_ves: number;
  fuente: BcvRateSource;
  fetched_at: string;
  updated_by?: string | null;
}

export interface BcvRateGateway {
  getRateByDate(fecha: string): Promise<BcvRateDbRow | null>;
  getLatestRate(): Promise<BcvRateDbRow | null>;
  upsertRate(input: {
    fecha: string;
    tasa_usd_ves: number;
    fuente: BcvRateSource;
    updated_by?: string | null;
  }): Promise<BcvRateDbRow>;
}

const BCV_OFFICIAL_ENDPOINT = 'https://ve.dolarapi.com/v1/dolares/oficial';
const DEFAULT_BCV_TIMEOUT_MS = 6000;

const ManualBcvSchema = z.object({
  tasaUsdVes: z
    .number({ message: 'La tasa BCV debe ser un número válido.' })
    .refine((v) => isReasonableBcvRate(v), {
      message: 'La tasa BCV debe ser un valor finito entre 10 y 100.000 Bs/USD.',
    }),
  fecha: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Fecha inválida (use YYYY-MM-DD).')
    .optional(),
});

// Respaldo de caché diaria en memoria del servidor en caso de que la tabla aún no esté migrada
let inMemoryLatestBcv: BcvRateDbRow | null = null;

export function clearInMemoryBcvCacheForTests(): void {
  inMemoryLatestBcv = null;
}

function normalizeDbRow(raw: Record<string, unknown>): BcvRateDbRow | null {
  const fecha = String(raw.fecha ?? '').slice(0, 10);
  const tasa = Number(raw.tasa_usd_ves);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !isReasonableBcvRate(tasa)) {
    return null;
  }
  const rawFuente = String(raw.fuente ?? 'BCV_OFICIAL').trim().toUpperCase();
  const fuente: BcvRateSource =
    rawFuente === 'MANUAL_ADMIN'
      ? 'MANUAL_ADMIN'
      : rawFuente === 'RESPALDO'
        ? 'RESPALDO'
        : 'BCV_OFICIAL';
  return {
    fecha,
    tasa_usd_ves: round4(tasa),
    fuente,
    fetched_at: String(raw.fetched_at ?? new Date().toISOString()),
    updated_by: raw.updated_by ? String(raw.updated_by) : null,
  };
}

function createSupabaseBcvGateway(accessToken: string): BcvRateGateway | null {
  const adminClient = getAdminSupabaseClient();
  const readClient = adminClient || createUserScopedSupabaseClient(accessToken);
  if (!readClient) return null;

  return {
    async getRateByDate(fecha) {
      const { data, error } = await readClient
        .from('tasas_bcv')
        .select('fecha, tasa_usd_ves, fuente, fetched_at, updated_by')
        .eq('fecha', fecha)
        .limit(1);
      if (error || !Array.isArray(data) || data.length === 0) return null;
      return normalizeDbRow(data[0] as Record<string, unknown>);
    },

    async getLatestRate() {
      const { data, error } = await readClient
        .from('tasas_bcv')
        .select('fecha, tasa_usd_ves, fuente, fetched_at, updated_by')
        .order('fecha', { ascending: false })
        .limit(1);
      if (error || !Array.isArray(data) || data.length === 0) return null;
      return normalizeDbRow(data[0] as Record<string, unknown>);
    },

    async upsertRate(input) {
      const writeClient = adminClient || createUserScopedSupabaseClient(accessToken);
      const nowIso = new Date().toISOString();
      const payload = {
        fecha: input.fecha,
        tasa_usd_ves: round4(input.tasa_usd_ves),
        fuente: input.fuente,
        fetched_at: nowIso,
        updated_by: input.updated_by ?? null,
      };
      if (!writeClient) {
        return payload;
      }
      const { data, error } = await writeClient
        .from('tasas_bcv')
        .upsert(payload, { onConflict: 'fecha' })
        .select('fecha, tasa_usd_ves, fuente, fetched_at, updated_by')
        .limit(1);
      if (error) {
        const msg = String(error.message || '');
        if (error.code === '42P01' || error.code === 'PGRST205' || msg.includes('tasas_bcv')) {
          serverLogger.warn('tasas_bcv_table_not_migrated_fallback_memory', { code: error.code });
          return payload;
        }
        throw new Error(`No se pudo persistir la tasa BCV en Supabase (${error.message}).`);
      }
      const row = Array.isArray(data) && data[0] ? normalizeDbRow(data[0] as Record<string, unknown>) : null;
      return row ?? payload;
    },
  };
}

/**
 * Consulta la fuente oficial BCV con timeout estricto de 6s (AbortController)
 * y validación estricta de número finito en rango operativo razonable.
 */
export async function fetchOfficialBcvRateFromUpstream(options?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<number | null> {
  const fetchFn = options?.fetchImpl ?? fetch;
  const rawTimeout = Number(options?.timeoutMs ?? process.env.BCV_OFFICIAL_TIMEOUT_MS ?? DEFAULT_BCV_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 500 && rawTimeout <= 10000
    ? rawTimeout
    : DEFAULT_BCV_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchFn(BCV_OFFICIAL_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { promedio?: unknown; precio?: unknown };
    const candidate = Number(json?.promedio ?? json?.precio);
    if (!isReasonableBcvRate(candidate)) return null;
    return round4(candidate);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface BcvRateHandlerDeps {
  gatewayFactory?: (req: Request) => BcvRateGateway | null;
  upstreamFetcher?: () => Promise<number | null>;
  nowProvider?: () => Date;
}

export function createBcvRateHandlers(deps?: BcvRateHandlerDeps) {
  const resolveGateway = (req: Request): BcvRateGateway | null => {
    if (deps?.gatewayFactory) return deps.gatewayFactory(req);
    const token = req.authUser?.accessToken;
    if (!token) return null;
    return createSupabaseBcvGateway(token);
  };

  const fetchUpstream = deps?.upstreamFetcher ?? (() => fetchOfficialBcvRateFromUpstream());
  const getNow = deps?.nowProvider ?? (() => new Date());

  return {
    async handleGetBcvRate(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }

      const todayYmd = getCaracasIsoDate(getNow());
      const wantsRefresh =
        String(req.query.refresh ?? '').trim().toLowerCase() === 'true' &&
        Boolean(actor.isCoordinatorOrAdmin);
      const gateway = resolveGateway(req);

      try {
        // 1. Revisar caché oficial del día en `public.tasas_bcv` (si no se fuerza refresco)
        if (!wantsRefresh) {
          const cachedDb = gateway ? await gateway.getRateByDate(todayYmd).catch(() => null) : null;
          if (cachedDb) {
            inMemoryLatestBcv = cachedDb;
            res.setHeader('Cache-Control', 'private, max-age=300');
            res.status(200).json({
              ok: true,
              fecha: cachedDb.fecha,
              tasaUsdVes: cachedDb.tasa_usd_ves,
              fuente: cachedDb.fuente,
              fetchedAt: cachedDb.fetched_at,
              isFallback: false,
              fromCache: true,
            });
            return;
          }
          if (inMemoryLatestBcv && inMemoryLatestBcv.fecha === todayYmd) {
            res.setHeader('Cache-Control', 'private, max-age=300');
            res.status(200).json({
              ok: true,
              fecha: inMemoryLatestBcv.fecha,
              tasaUsdVes: inMemoryLatestBcv.tasa_usd_ves,
              fuente: inMemoryLatestBcv.fuente,
              fetchedAt: inMemoryLatestBcv.fetched_at,
              isFallback: false,
              fromCache: true,
            });
            return;
          }
        }

        // 2. Consultar fuente oficial BCV con timeout estricto (6s)
        const liveRate = await fetchUpstream();
        if (liveRate !== null && isReasonableBcvRate(liveRate)) {
          const saved: BcvRateDbRow = gateway
            ? await gateway
                .upsertRate({
                  fecha: todayYmd,
                  tasa_usd_ves: liveRate,
                  fuente: 'BCV_OFICIAL',
                  updated_by: actor.id,
                })
                .catch(() => ({
                  fecha: todayYmd,
                  tasa_usd_ves: liveRate,
                  fuente: 'BCV_OFICIAL' as const,
                  fetched_at: getNow().toISOString(),
                }))
            : {
                fecha: todayYmd,
                tasa_usd_ves: liveRate,
                fuente: 'BCV_OFICIAL',
                fetched_at: getNow().toISOString(),
              };

          inMemoryLatestBcv = saved;
          res.setHeader('Cache-Control', 'private, max-age=300');
          res.status(200).json({
            ok: true,
            fecha: saved.fecha,
            tasaUsdVes: saved.tasa_usd_ves,
            fuente: saved.fuente,
            fetchedAt: saved.fetched_at,
            isFallback: false,
            fromCache: false,
          });
          return;
        }

        // 3. Fuente externa caída: devolver automáticamente última tasa válida guardada (`isFallback: true`)
        const latestDb = gateway ? await gateway.getLatestRate().catch(() => null) : null;
        const fallbackRow = latestDb ?? inMemoryLatestBcv;
        if (fallbackRow) {
          inMemoryLatestBcv = fallbackRow;
          serverLogger.warn('bcv_rate_fallback_served', {
            requestedDate: todayYmd,
            fallbackDate: fallbackRow.fecha,
            fuente: fallbackRow.fuente,
          });
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).json({
            ok: true,
            fecha: fallbackRow.fecha,
            tasaUsdVes: fallbackRow.tasa_usd_ves,
            fuente: fallbackRow.fuente === 'MANUAL_ADMIN' ? 'MANUAL_ADMIN' : 'RESPALDO',
            fetchedAt: fallbackRow.fetched_at,
            isFallback: true,
            fromCache: true,
          });
          return;
        }

        res.status(503).json({
          error:
            'No se pudo obtener la tasa oficial BCV ni existe una tasa de respaldo guardada. Un Administrador Global puede registrar una tasa manual de contingencia.',
          code: 'BCV_RATE_UNAVAILABLE',
        });
      } catch (err) {
        serverLogger.error('bcv_rate_handler_error', {
          detail: err instanceof Error ? err.message : 'unknown',
        });
        res.status(500).json({
          error: 'Error interno consultando la tasa BCV oficial.',
          code: 'BCV_INTERNAL_ERROR',
        });
      }
    },

    async handleSetManualBcvRate(req: Request, res: Response): Promise<void> {
      const actor = req.authUser;
      if (!actor) {
        res.status(401).json({ error: 'Sesión requerida.', code: 'AUTH_TOKEN_MISSING' });
        return;
      }
      if (!actor.isSuperAdmin) {
        res.status(403).json({
          error: 'Solo un Administrador Global puede registrar una tasa BCV manual de contingencia.',
          code: 'FORBIDDEN_SUPER_ADMIN_ONLY',
        });
        return;
      }

      const parsed = ManualBcvSchema.safeParse({
        tasaUsdVes: Number(req.body?.tasaUsdVes),
        fecha: req.body?.fecha ? String(req.body.fecha).trim() : undefined,
      });
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message || 'Tasa BCV manual inválida.',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const targetDate = parsed.data.fecha ?? getCaracasIsoDate(getNow());
      const gateway = resolveGateway(req);

      try {
        const saved: BcvRateDbRow = gateway
          ? await gateway.upsertRate({
              fecha: targetDate,
              tasa_usd_ves: parsed.data.tasaUsdVes,
              fuente: 'MANUAL_ADMIN',
              updated_by: actor.id,
            })
          : {
              fecha: targetDate,
              tasa_usd_ves: round4(parsed.data.tasaUsdVes),
              fuente: 'MANUAL_ADMIN',
              fetched_at: getNow().toISOString(),
              updated_by: actor.id,
            };

        inMemoryLatestBcv = saved;
        serverLogger.info('bcv_manual_rate_saved', {
          fecha: saved.fecha,
          tasaUsdVes: saved.tasa_usd_ves,
          userId: actor.id,
        });
        res.status(200).json({
          ok: true,
          fecha: saved.fecha,
          tasaUsdVes: saved.tasa_usd_ves,
          fuente: saved.fuente,
          fetchedAt: saved.fetched_at,
          isFallback: false,
          fromCache: false,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'No se pudo guardar la tasa manual BCV.',
          code: 'BCV_MANUAL_SAVE_ERROR',
        });
      }
    },
  };
}

export const defaultBcvRateHandlers = createBcvRateHandlers();
