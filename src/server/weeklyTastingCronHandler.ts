import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { NextFunction, Request, Response } from 'express';
import {
  DEFAULT_FDV_RENDER_API_URL,
  fetchFdvPlanificadorRenderDegustaciones,
  mergeSupabaseAndRenderDegustacionRows,
  normalizeCanonicalFdvId,
  safeJsonParseObject,
  sanitizeFdvText,
} from '../services/fdvDegustacionesAdapter';
import type { RawSupabaseSurvey } from '../services/supabaseModule1';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  MOTIVO_CIERRE_DOMINGO_9PM,
  resolveCanonicalEventDateYmd,
  resolveSundayCutoffContext,
  sanitizeTimeZoneOrDefault,
} from '../utils/weeklyTastingCutoffEngine';

const MIN_CRON_SECRET_LENGTH = 16;

function getServerSupabaseUrl(): string {
  const raw = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  return raw.replace(/\/rest\/v1\/?$/, '');
}

function getServerSupabaseWriteClient(): SupabaseClient | null {
  const url = getServerSupabaseUrl();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  ).trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Valida en tiempo constante (`crypto.timingSafeEqual`) la cabecera `Authorization: Bearer <CRON_SECRET>`.
 * Hashea ambos valores con SHA-256 (32 bytes fijos) antes de comparar para no filtrar siquiera la longitud
 * del secreto mediante canales laterales de tiempo (*timing attacks*).
 */
export function verifyCronBearerAuthorization(
  authorizationHeader: string | undefined,
  configuredSecret: string | undefined
): boolean {
  const cleanSecret = typeof configuredSecret === 'string' ? configuredSecret.trim() : '';
  if (cleanSecret.length < MIN_CRON_SECRET_LENGTH) {
    return false;
  }

  if (typeof authorizationHeader !== 'string') {
    return false;
  }

  const trimmedHeader = authorizationHeader.trim();
  if (!/^bearer\s+/i.test(trimmedHeader)) {
    return false;
  }

  const providedToken = trimmedHeader.replace(/^bearer\s+/i, '').trim();
  if (!providedToken) {
    return false;
  }

  const providedDigest = crypto.createHash('sha256').update(providedToken, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(cleanSecret, 'utf8').digest();

  const digestsMatch = crypto.timingSafeEqual(providedDigest, expectedDigest);
  const lengthsMatch =
    Buffer.byteLength(providedToken, 'utf8') === Buffer.byteLength(cleanSecret, 'utf8');

  return digestsMatch && lengthsMatch;
}

/**
 * Middleware Express exclusivo de backend para autenticar disparadores programados de Cron.
 * Rechaza con `401 Unauthorized` cualquier petición sin credencial válida.
 */
export function requireCronSecretAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = process.env.CRON_SECRET;
  const authHeader =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;

  if (!verifyCronBearerAuthorization(authHeader, configuredSecret)) {
    res.status(401).json({
      error: 'No autorizado para ejecutar tareas programadas de cierre.',
      code: 'CRON_UNAUTHORIZED',
    });
    return;
  }

  next();
}

async function materializeEligibleRenderOnlyRows(
  client: SupabaseClient,
  fechaCorteDomingo: string
): Promise<number> {
  try {
    const [renderRows, dbRes] = await Promise.all([
      fetchFdvPlanificadorRenderDegustaciones({
        endpointUrl: DEFAULT_FDV_RENDER_API_URL,
        timeoutMs: 25_000,
        forceRefresh: true,
      }),
      client
        .from('surveys')
        .select('id,type,date,store,promoter,product,comments,creatorId,created_at')
        .eq('type', 'Degustacion')
        .limit(2000),
    ]);

    if (dbRes.error || renderRows.length === 0) return 0;

    const existingRows = (dbRes.data || []) as unknown as RawSupabaseSurvey[];
    const { renderOnlyRows } = mergeSupabaseAndRenderDegustacionRows(existingRows, renderRows);

    let insertedCount = 0;
    for (const row of renderOnlyRows) {
      const commentsObj = safeJsonParseObject<Record<string, unknown>>(row.comments);
      const eventYmd = resolveCanonicalEventDateYmd(row.date || commentsObj.date);
      if (!eventYmd || eventYmd > fechaCorteDomingo) {
        continue;
      }

      const canonicalId = normalizeCanonicalFdvId(commentsObj.degustacionId || commentsObj.id, row.id);
      if (!canonicalId) continue;

      const enrichedComments = {
        ...commentsObj,
        en_historial: false,
      };

      const { error: insErr } = await client.from('surveys').insert({
        type: 'Degustacion',
        date: eventYmd,
        store: sanitizeFdvText(row.store, 180) || 'Cliente PDV',
        promoter: sanitizeFdvText(row.promoter, 140) || 'Fuerza de Ventas',
        product: sanitizeFdvText(row.product, 220) || 'Portafolio Codizulca',
        comments: JSON.stringify(enrichedComments),
        creatorId: sanitizeFdvText(row.creatorId, 140) || 'Fuerza de Ventas',
        created_at: row.created_at || new Date().toISOString(),
      });

      if (!insErr) {
        insertedCount += 1;
      }
    }
    return insertedCount;
  } catch {
    return 0;
  }
}

/**
 * Controlador de cierre automático dominical (9:00 PM `America/Caracas`).
 * Invoca primero la función transaccional nativa en PostgreSQL (`ejecutar_cierre_dominical_degustaciones`)
 * y, si el esquema SQL aún no tuviera la RPC instalada en un entorno local, aplica el respaldo idempotente vía SDK.
 */
export async function handleWeeklyTastingCutoffCron(req: Request, res: Response): Promise<void> {
  const configuredTz = sanitizeTimeZoneOrDefault(
    process.env.APP_TIMEZONE || DEFAULT_BUSINESS_TIMEZONE
  );
  const forceRun = Boolean(req.body && (req.body as { forceRun?: unknown }).forceRun === true);
  const now = new Date();
  const ctx = resolveSundayCutoffContext(now, configuredTz, forceRun);

  if (!forceRun && !ctx.isWithinScheduledWindow) {
    res.status(200).json({
      ok: true,
      skipped_outside_window: true,
      timezone: ctx.timeZone,
      local_timestamp: ctx.localFormattedTimestamp,
      fecha_corte: ctx.fechaCorteDomingo,
      registros_archivados: 0,
    });
    return;
  }

  const client = getServerSupabaseWriteClient();
  if (!client) {
    res.status(503).json({
      ok: false,
      estado: 'ERROR',
      code: 'SUPABASE_NOT_CONFIGURED',
      error: 'Credenciales de servidor de Supabase no configuradas.',
    });
    return;
  }

  await materializeEligibleRenderOnlyRows(client, ctx.fechaCorteDomingo);

  const { data: rpcResult, error: rpcError } = await client.rpc(
    'ejecutar_cierre_dominical_degustaciones',
    {
      p_now: ctx.executedAtIso,
      p_timezone: ctx.timeZone,
      p_force_run: forceRun,
    }
  );

  if (!rpcError && rpcResult) {
    res.status(200).json(rpcResult);
    return;
  }

  // Respaldo no destructivo e idempotente vía SDK si la RPC aún no ha sido desplegada en BD
  try {
    const { data: rows, error: selErr } = await client
      .from('surveys')
      .select('id,date,comments')
      .eq('type', 'Degustacion')
      .limit(3000);

    if (selErr) {
      res.status(500).json({
        ok: false,
        estado: 'ERROR',
        fecha_corte: ctx.fechaCorteDomingo,
        registros_archivados: 0,
        code: 'DB_QUERY_FAILED',
      });
      return;
    }

    let archivedCount = 0;
    for (const r of (rows || []) as Array<{ id: string; date?: string; comments?: unknown }>) {
      const c = safeJsonParseObject<Record<string, unknown>>(r.comments);
      if (c.en_historial === true) continue;
      const eventYmd = resolveCanonicalEventDateYmd(r.date || c.date);
      if (!eventYmd || eventYmd > ctx.fechaCorteDomingo) continue;

      const nextComments = {
        ...c,
        en_historial: true,
        archivado_en: ctx.executedAtIso,
        motivo_archivo: MOTIVO_CIERRE_DOMINGO_9PM,
      };

      const { error: updErr } = await client
        .from('surveys')
        .update({ comments: JSON.stringify(nextComments) })
        .eq('id', r.id);

      if (!updErr) {
        archivedCount += 1;
      }
    }

    res.status(200).json({
      ok: true,
      estado: 'OK',
      idempotent_noop: archivedCount === 0,
      fecha_corte: ctx.fechaCorteDomingo,
      registros_archivados: archivedCount,
      timezone: ctx.timeZone,
    });
  } catch {
    res.status(500).json({
      ok: false,
      estado: 'ERROR',
      fecha_corte: ctx.fechaCorteDomingo,
      registros_archivados: 0,
      code: 'INTERNAL_CUTOFF_ERROR',
    });
  }
}
