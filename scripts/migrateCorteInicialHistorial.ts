import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_FDV_RENDER_API_URL,
  fetchFdvPlanificadorRenderDegustaciones,
  mergeSupabaseAndRenderDegustacionRows,
  normalizeCanonicalFdvId,
  resolveFdvRequestLifecycle,
  safeJsonParseObject,
  sanitizeFdvText,
} from '../src/services/fdvDegustacionesAdapter';
import type { RawSupabaseSurvey } from '../src/services/supabaseModule1';
import { MOTIVO_CORTE_INICIAL, resolveCanonicalEventDateYmd } from '../src/utils/weeklyTastingCutoffEngine';

// Carga silenciosa de entorno sin imprimir ni exponer ningún secreto
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

type CliMode = 'dry-run' | 'apply' | 'rollback';

interface RollbackManifestEntry {
  id: string;
  table: 'surveys' | 'cronograma_degustaciones';
  prevEnHistorial: boolean;
  prevArchivadoEn: string | null;
  prevMotivoArchivo: string | null;
}

interface RollbackManifest {
  cutoffReason: string;
  appliedAtIso: string;
  materializedRenderSurveyIds: string[];
  entries: RollbackManifestEntry[];
}

const DEFAULT_MANIFEST_PATH = process.env.CORTE_HISTORIAL_MANIFEST_PATH
  ? path.resolve(process.env.CORTE_HISTORIAL_MANIFEST_PATH)
  : path.resolve(
      process.env.USERPROFILE || process.cwd(),
      '.gemini',
      'antigravity',
      'brain',
      '8ebf5091-4ec0-40b7-a374-7c5387d48d87',
      'scratch',
      'corte_inicial_rollback_manifest.json'
    );

function resolveCliMode(argv: string[]): CliMode {
  if (argv.includes('--apply')) return 'apply';
  if (argv.includes('--rollback')) return 'rollback';
  return 'dry-run';
}

function createMigrationSupabaseClient(): SupabaseClient {
  const rawUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1\/?$/, '');
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  ).trim();

  if (!rawUrl || !key) {
    throw new Error(
      'Variables de entorno de Supabase no configuradas. Configure SUPABASE_URL y clave en .env.local.'
    );
  }

  return createClient(rawUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function detectNativeHistorialColumn(
  client: SupabaseClient,
  table: 'surveys' | 'cronograma_degustaciones'
): Promise<{ tableAccessible: boolean; hasNativeColumn: boolean }> {
  const probe = await client.from(table).select('id,en_historial').limit(1);
  if (!probe.error) {
    return { tableAccessible: true, hasNativeColumn: true };
  }
  const msg = `${probe.error.code || ''} ${probe.error.message || ''}`.toLowerCase();
  if (msg.includes('en_historial') || probe.error.code === '42703' || probe.error.code === 'PGRST204') {
    const tableProbe = await client.from(table).select('id').limit(1);
    return { tableAccessible: !tableProbe.error, hasNativeColumn: false };
  }
  return { tableAccessible: false, hasNativeColumn: false };
}

function isRowArchived(
  row: { en_historial?: unknown; comments?: unknown },
  commentsObj?: Record<string, unknown>
): boolean {
  if (typeof row.en_historial === 'boolean') {
    return row.en_historial;
  }
  const c = commentsObj ?? safeJsonParseObject<Record<string, unknown>>(row.comments);
  return c.en_historial === true;
}

function resolveEstadoLabel(commentsObj: Record<string, unknown>): string {
  const isFromSellerApp = Boolean(
    commentsObj.source === 'vendedor_app' || commentsObj.vendedor || commentsObj.degustacionId
  );
  return resolveFdvRequestLifecycle({
    rawEstado: commentsObj.estado || commentsObj.status,
    isFromSellerApp,
    ymd: '2026-11-12',
    todayYmd: '2026-11-12',
  }).canonicalEstado;
}

function countByStatus(rows: Array<{ comments?: unknown }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const c = safeJsonParseObject<Record<string, unknown>>(r.comments);
    const est = resolveEstadoLabel(c);
    counts[est] = (counts[est] || 0) + 1;
  }
  return counts;
}

async function fetchAllDegustacionSurveys(
  client: SupabaseClient,
  hasNativeColumn: boolean
): Promise<Array<RawSupabaseSurvey & { en_historial?: boolean; archivado_en?: string | null; motivo_archivo?: string | null }>> {
  const selectCols = hasNativeColumn
    ? 'id,type,date,store,promoter,product,comments,creatorId,created_at,en_historial,archivado_en,motivo_archivo'
    : 'id,type,date,store,promoter,product,comments,creatorId,created_at';

  const { data, error } = await client
    .from('surveys')
    .select(selectCols)
    .eq('type', 'Degustacion')
    .order('created_at', { ascending: false })
    .limit(4000);

  if (error) {
    throw new Error(`Error consultando public.surveys (Degustacion): ${error.message}`);
  }

  return (data || []) as unknown as Array<
    RawSupabaseSurvey & {
      en_historial?: boolean;
      archivado_en?: string | null;
      motivo_archivo?: string | null;
    }
  >;
}

async function fetchRenderRowsWithWarmupRetry(): Promise<RawSupabaseSurvey[]> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const rows = await fetchFdvPlanificadorRenderDegustaciones({
      endpointUrl: DEFAULT_FDV_RENDER_API_URL,
      timeoutMs: 25_000,
      forceRefresh: true,
    });
    if (rows.length > 0) {
      return rows;
    }
  }
  return [];
}

async function runMigration(): Promise<void> {
  const mode = resolveCliMode(process.argv.slice(2));
  const client = createMigrationSupabaseClient();
  const isoNow = new Date().toISOString();

  console.log('======================================================================');
  console.log(`CORTE INICIAL DE HISTORIAL DE DEGUSTACIONES • MODO: --${mode}`);
  console.log('======================================================================');

  const [surveysCap, cronogramaCap, renderRows] = await Promise.all([
    detectNativeHistorialColumn(client, 'surveys'),
    detectNativeHistorialColumn(client, 'cronograma_degustaciones'),
    fetchRenderRowsWithWarmupRetry(),
  ]);

  if (!surveysCap.tableAccessible) {
    throw new Error('No se pudo acceder a public.surveys con las credenciales configuradas.');
  }

  const dbSurveys = await fetchAllDegustacionSurveys(client, surveysCap.hasNativeColumn);
  const { renderOnlyRows } = mergeSupabaseAndRenderDegustacionRows(dbSurveys, renderRows);

  const activeSurveys = dbSurveys.filter((r) => !isRowArchived(r));
  const archivedSurveys = dbSurveys.filter((r) => isRowArchived(r));

  let cronogramaActiveIds: Array<{
    id: string;
    en_historial?: boolean;
    archivado_en?: string | null;
    motivo_archivo?: string | null;
  }> = [];
  let cronogramaArchivedCount = 0;

  if (cronogramaCap.tableAccessible && cronogramaCap.hasNativeColumn) {
    const { data: cronRows } = await client
      .from('cronograma_degustaciones')
      .select('id,en_historial,archivado_en,motivo_archivo')
      .limit(4000);
    const typedCron = (cronRows || []) as Array<{
      id: string;
      en_historial?: boolean;
      archivado_en?: string | null;
      motivo_archivo?: string | null;
    }>;
    cronogramaActiveIds = typedCron.filter((r) => !r.en_historial);
    cronogramaArchivedCount = typedCron.filter((r) => Boolean(r.en_historial)).length;
  }

  console.log('[DIAGNÓSTICO PREVIO - CERO PII]');
  console.log(
    JSON.stringify(
      {
        surveys_columna_nativa_en_historial: surveysCap.hasNativeColumn,
        cronograma_tabla_accesible: cronogramaCap.tableAccessible,
        cronograma_columna_nativa_en_historial: cronogramaCap.hasNativeColumn,
        surveys_total: dbSurveys.length,
        surveys_activas_a_archivar: activeSurveys.length,
        surveys_ya_en_historial: archivedSurveys.length,
        surveys_activas_por_estado: countByStatus(activeSurveys),
        render_fdv_total: renderRows.length,
        render_fdv_sin_espejo_supabase: renderOnlyRows.length,
        cronograma_activas_a_archivar: cronogramaActiveIds.length,
        cronograma_ya_en_historial: cronogramaArchivedCount,
      },
      null,
      2
    )
  );

  if (mode === 'dry-run') {
    console.log(
      '[DRY-RUN COMPLETADO] Simulación exitosa (0 escrituras realizadas). Ejecute con --apply para aplicar el corte inicial.'
    );
    return;
  }

  if (mode === 'rollback') {
    // 1. Intentar RPC transaccional si está instalada en PostgreSQL
    const rpcRollback = await client.rpc('revertir_corte_historial_degustaciones', {
      p_motivo: MOTIVO_CORTE_INICIAL,
    });
    if (!rpcRollback.error && rpcRollback.data) {
      console.log('[RPC ROLLBACK EJECUTADA]', JSON.stringify(rpcRollback.data));
    }

    // 2. Restaurar también espejo JSON y manifiesto local determinista (sin DELETE)
    let manifest: RollbackManifest | null = null;
    if (fs.existsSync(DEFAULT_MANIFEST_PATH)) {
      manifest = JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8')) as RollbackManifest;
    }

    const targetSurveyIds = new Set<string>(
      manifest
        ? manifest.entries.filter((e) => e.table === 'surveys').map((e) => e.id)
        : dbSurveys
            .filter((r) => {
              const c = safeJsonParseObject<Record<string, unknown>>(r.comments);
              return (r.motivo_archivo || c.motivo_archivo) === MOTIVO_CORTE_INICIAL;
            })
            .map((r) => r.id)
    );

    let revertedSurveys = 0;
    for (const row of dbSurveys) {
      if (!targetSurveyIds.has(row.id)) continue;
      const c = safeJsonParseObject<Record<string, unknown>>(row.comments);
      if ((row.motivo_archivo || c.motivo_archivo) !== MOTIVO_CORTE_INICIAL) continue;

      const nextComments: Record<string, unknown> = { ...c };
      delete nextComments.en_historial;
      delete nextComments.archivado_en;
      delete nextComments.motivo_archivo;

      const patchPayload: Record<string, unknown> = {
        comments: JSON.stringify(nextComments),
      };
      if (surveysCap.hasNativeColumn) {
        patchPayload.en_historial = false;
        patchPayload.archivado_en = null;
        patchPayload.motivo_archivo = null;
      }

      const { error: updErr } = await client.from('surveys').update(patchPayload).eq('id', row.id);
      if (!updErr) {
        revertedSurveys += 1;
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          modo: 'rollback',
          surveys_revertidas: revertedSurveys,
        },
        null,
        2
      )
    );
    return;
  }

  // =========================================================================
  // MODO `--apply`: MATERIALIZACIÓN RENDER + CORTE INICIAL IDEMPOTENTE
  // =========================================================================
  const materializedRenderSurveyIds: string[] = [];

  for (const row of renderOnlyRows) {
    const commentsObj = safeJsonParseObject<Record<string, unknown>>(row.comments);
    const canonicalId = normalizeCanonicalFdvId(commentsObj.degustacionId || commentsObj.id, row.id);
    if (!canonicalId) continue;

    const eventYmd =
      resolveCanonicalEventDateYmd(row.date || commentsObj.date) || isoNow.slice(0, 10);

    const enrichedComments: Record<string, unknown> = {
      ...commentsObj,
      en_historial: true,
      archivado_en: isoNow,
      motivo_archivo: MOTIVO_CORTE_INICIAL,
    };

    const insertPayload: Record<string, unknown> = {
      type: 'Degustacion',
      date: eventYmd,
      store: sanitizeFdvText(row.store, 180) || 'Cliente PDV',
      promoter: sanitizeFdvText(row.promoter, 140) || 'Fuerza de Ventas',
      product: sanitizeFdvText(row.product, 220) || 'Portafolio Codizulca',
      comments: JSON.stringify(enrichedComments),
      creatorId: sanitizeFdvText(row.creatorId, 140) || 'Fuerza de Ventas',
      created_at: row.created_at || isoNow,
    };

    if (surveysCap.hasNativeColumn) {
      insertPayload.en_historial = true;
      insertPayload.archivado_en = isoNow;
      insertPayload.motivo_archivo = MOTIVO_CORTE_INICIAL;
    }

    const { data: insData, error: insErr } = await client
      .from('surveys')
      .insert(insertPayload)
      .select('id')
      .limit(1);

    if (!insErr && insData && insData[0]?.id) {
      materializedRenderSurveyIds.push(String(insData[0].id));
    }
  }

  // Respaldar manifiesto de reversión libre de PII antes de actualizar
  const manifestEntries: RollbackManifestEntry[] = [
    ...activeSurveys.map((r) => {
      const c = safeJsonParseObject<Record<string, unknown>>(r.comments);
      return {
        id: r.id,
        table: 'surveys' as const,
        prevEnHistorial: isRowArchived(r, c),
        prevArchivadoEn: (r.archivado_en ?? (c.archivado_en as string | null) ?? null) || null,
        prevMotivoArchivo:
          (r.motivo_archivo ?? (c.motivo_archivo as string | null) ?? null) || null,
      };
    }),
    ...cronogramaActiveIds.map((cRow) => ({
      id: cRow.id,
      table: 'cronograma_degustaciones' as const,
      prevEnHistorial: Boolean(cRow.en_historial),
      prevArchivadoEn: cRow.archivado_en ?? null,
      prevMotivoArchivo: cRow.motivo_archivo ?? null,
    })),
  ];

  fs.mkdirSync(path.dirname(DEFAULT_MANIFEST_PATH), { recursive: true });
  const manifest: RollbackManifest = {
    cutoffReason: MOTIVO_CORTE_INICIAL,
    appliedAtIso: isoNow,
    materializedRenderSurveyIds,
    entries: manifestEntries,
  };
  fs.writeFileSync(DEFAULT_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  // Intentar RPC transaccional en PostgreSQL si ya fue aplicada
  const rpcApply = await client.rpc('ejecutar_corte_historial_degustaciones', {
    p_motivo: MOTIVO_CORTE_INICIAL,
    p_dry_run: false,
  });
  const rpcExecuted = !rpcApply.error && Boolean(rpcApply.data);

  // Sincronizar espejo JSON `comments.en_historial` (+ columnas nativas si existen) preservando `estado` y todos los campos
  let updatedSurveysCount = 0;
  const BATCH_SIZE = 15;
  for (let i = 0; i < activeSurveys.length; i += BATCH_SIZE) {
    const chunk = activeSurveys.slice(i, i + BATCH_SIZE);
    await Promise.all(
      chunk.map(async (row) => {
        const prevComments = safeJsonParseObject<Record<string, unknown>>(row.comments);
        const nextComments: Record<string, unknown> = {
          ...prevComments,
          en_historial: true,
          archivado_en: isoNow,
          motivo_archivo: MOTIVO_CORTE_INICIAL,
        };

        const patchPayload: Record<string, unknown> = {
          comments: JSON.stringify(nextComments),
        };
        if (surveysCap.hasNativeColumn) {
          patchPayload.en_historial = true;
          patchPayload.archivado_en = isoNow;
          patchPayload.motivo_archivo = MOTIVO_CORTE_INICIAL;
        }

        const { error: updErr } = await client
          .from('surveys')
          .update(patchPayload)
          .eq('id', row.id);
        if (updErr) {
          throw new Error(`Fallo al archivar survey ${row.id}: ${updErr.message}`);
        }
        updatedSurveysCount += 1;
      })
    );
  }

  let updatedCronogramaCount = 0;
  if (cronogramaCap.tableAccessible && cronogramaCap.hasNativeColumn && cronogramaActiveIds.length > 0) {
    for (const cRow of cronogramaActiveIds) {
      const { error: cronErr } = await client
        .from('cronograma_degustaciones')
        .update({
          en_historial: true,
          archivado_en: isoNow,
          motivo_archivo: MOTIVO_CORTE_INICIAL,
        })
        .eq('id', cRow.id);
      if (cronErr) {
        throw new Error(`Fallo al archivar cronograma ${cRow.id}: ${cronErr.message}`);
      }
      updatedCronogramaCount += 1;
    }
  }

  // Verificación post-corte en vivo
  const postSurveys = await fetchAllDegustacionSurveys(client, surveysCap.hasNativeColumn);
  const { mergedRows: postMerged } = mergeSupabaseAndRenderDegustacionRows(postSurveys, renderRows);
  const postActiveMerged = postMerged.filter((r) => {
    const c = safeJsonParseObject<Record<string, unknown>>(r.comments);
    const est = resolveEstadoLabel(c);
    if (est === 'RECHAZADA' || est === 'CANCELADA') return false;
    return !isRowArchived(r as RawSupabaseSurvey & { en_historial?: boolean }, c);
  });
  const postArchivedMerged = postMerged.filter((r) => {
    const c = safeJsonParseObject<Record<string, unknown>>(r.comments);
    const est = resolveEstadoLabel(c);
    if (est === 'RECHAZADA' || est === 'CANCELADA') return false;
    return isRowArchived(r as RawSupabaseSurvey & { en_historial?: boolean }, c);
  });

  console.log('[RESULTADO CORTE INICIAL - VERIFICACIÓN POST-APLICACIÓN]');
  console.log(
    JSON.stringify(
      {
        ok: postActiveMerged.length === 0,
        rpc_transaccional_disponible: rpcExecuted,
        render_materializadas: materializedRenderSurveyIds.length,
        surveys_archivadas_en_corte: updatedSurveysCount,
        cronograma_archivadas_en_corte: updatedCronogramaCount,
        activas_visibles_post_corte: postActiveMerged.length,
        en_historial_post_corte: postArchivedMerged.length,
        estados_preservados_en_historial: countByStatus(postArchivedMerged),
      },
      null,
      2
    )
  );

  if (postActiveMerged.length !== 0) {
    throw new Error(
      `Verificación fallida: quedaron ${postActiveMerged.length} degustaciones activas tras el corte.`
    );
  }
}

runMigration().catch((err) => {
  console.error('[ERROR EN MIGRACIÓN DE CORTE INICIAL]:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
