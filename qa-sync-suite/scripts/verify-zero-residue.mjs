import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  loadAdminQaEnv,
  redactSensitive,
  REPORTS_DIR_PATH,
} from './lib/env.mjs';
import { getUnpurgedLedgerEntries, readLedger } from './lib/ledger.mjs';
import { createRequestPacer } from './lib/rateLimiter.mjs';

function isMissingTableOrColError(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    code === 'PGRST204' ||
    code === '42703' ||
    /does not exist|schema cache|Could not find/i.test(msg)
  );
}

async function countTagMatches(adminClient, pacer, table, column, pattern) {
  await pacer.pace();
  const { count, error } = await adminClient
    .from(table)
    .select('*', { count: 'exact', head: true })
    .ilike(column, pattern);

  if (error) {
    if (isMissingTableOrColError(error)) {
      return { supported: false, count: 0 };
    }
    throw new Error(
      `Error auditando cero residuos en public.${table}.${column}: ${redactSensitive(
        error.message
      )}`
    );
  }
  return { supported: true, count: Number(count || 0) };
}

/**
 * Audita exhaustivamente todas las tablas involucradas, Storage y `auth.users`
 * para certificar que existen **0 registros** con `[QA-SYNC-TEST` / `RUN_ID` y **0 usuarios QA**.
 */
export async function verifyZeroResidue({ runId = null } = {}) {
  const adminEnv = loadAdminQaEnv('verify-zero-residue.mjs');
  const pacer = createRequestPacer(adminEnv.rateLimitRps);

  const adminClient = createClient(adminEnv.supabaseUrl, adminEnv.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const ledger = readLedger();
  const unpurgedLedgerEntries = getUnpurgedLedgerEntries(runId);

  const tableChecks = [
    { table: 'asistencia_evidencias', column: 'pdv_nombre' },
    { table: 'asistencias_jornada', column: 'pdv_nombre' },
    { table: 'rutas_promotoras', column: 'cliente_nombre' },
    { table: 'trazabilidad_login', column: 'usuario' },
    { table: 'cronograma_degustaciones', column: 'cliente_nombre' },
    { table: 'cronograma_degustaciones', column: 'observaciones' },
    { table: 'cargas_archivos', column: 'nombre_archivo' },
    { table: 'surveys', column: 'store' },
    { table: 'surveys', column: 'comments' },
    { table: 'clientes', column: 'razon_social' },
    { table: 'clients', column: 'business_name' },
    { table: 'vendedores', column: 'nombre_completo' },
    { table: 'staff', column: 'name' },
  ];

  const verifiedCounts = {};

  for (const check of tableChecks) {
    const key = `public.${check.table}(${check.column})`;
    const globalRes = await countTagMatches(
      adminClient,
      pacer,
      check.table,
      check.column,
      '%[QA-SYNC-TEST%'
    );
    let total = globalRes.count;

    if (runId && globalRes.supported) {
      const runRes = await countTagMatches(
        adminClient,
        pacer,
        check.table,
        check.column,
        `%${runId}%`
      );
      total = Math.max(total, runRes.count);
    }

    verifiedCounts[key] = {
      tableExists: globalRes.supported,
      remainingRecords: total,
    };
  }

  // Auditar Storage (`asistencia-evidencias`) verificando que ningún path registrado siga existiendo
  const storageEntries = ledger.entries.filter(
    (e) =>
      e.resource_type === 'storage_object' &&
      e.table_or_bucket === 'asistencia-evidencias' &&
      (!runId || e.run_id === runId)
  );
  let remainingStorageObjects = 0;

  for (const st of storageEntries) {
    const dir = path.posix.dirname(st.id);
    const base = path.posix.basename(st.id);
    await pacer.pace();
    const { data, error } = await adminClient.storage
      .from('asistencia-evidencias')
      .list(dir, { search: base, limit: 10 });
    if (!error && Array.isArray(data)) {
      if (data.some((item) => item.name === base)) {
        remainingStorageObjects += 1;
      }
    }
  }

  verifiedCounts['storage.asistencia-evidencias'] = {
    checkedPaths: storageEntries.length,
    remainingRecords: remainingStorageObjects,
  };

  // Auditar `auth.users` buscando cualquier cuenta `@qa-sync.codizulca.internal` o tag `[QA-SYNC-TEST`
  await pacer.pace();
  let remainingQaAuthUsers = 0;
  const listUsersRes = await adminClient.auth.admin.listUsers({ page: 1, perPage: 500 });
  if (listUsersRes.error) {
    throw new Error(
      `Error auditando auth.users: ${redactSensitive(listUsersRes.error.message)}`
    );
  }
  for (const u of listUsersRes.data?.users || []) {
    const email = String(u.email || '').toLowerCase();
    const fullName = String(u.user_metadata?.full_name || '');
    const metaRun = String(u.app_metadata?.qa_run_id || '');
    const matchesQa =
      email.endsWith('@qa-sync.codizulca.internal') ||
      fullName.includes('[QA-SYNC-TEST') ||
      (runId && metaRun === runId);
    if (matchesQa) {
      remainingQaAuthUsers += 1;
    }
  }

  verifiedCounts['auth.users(@qa-sync.codizulca.internal)'] = {
    tableExists: true,
    remainingRecords: remainingQaAuthUsers,
  };

  const totalDbAndStorageRemaining = Object.values(verifiedCounts).reduce(
    (acc, item) => acc + Number(item.remainingRecords || 0),
    0
  );

  const clean =
    totalDbAndStorageRemaining === 0 && unpurgedLedgerEntries.length === 0;

  const report = {
    auditedAt: new Date().toISOString(),
    runIdChecked: runId || 'ALL_RUNS',
    clean,
    unpurgedLedgerEntries: unpurgedLedgerEntries.length,
    totalRemainingResidues: totalDbAndStorageRemaining,
    verifiedCounts,
  };

  if (!fs.existsSync(REPORTS_DIR_PATH)) {
    fs.mkdirSync(REPORTS_DIR_PATH, { recursive: true });
  }
  fs.writeFileSync(
    path.join(REPORTS_DIR_PATH, 'zero-residue-audit.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );

  return report;
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const runIdArgIdx = process.argv.indexOf('--run-id');
  const explicitRunId = runIdArgIdx >= 0 ? process.argv[runIdArgIdx + 1] : null;

  verifyZeroResidue({ runId: explicitRunId })
    .then((report) => {
      console.log('=== [ACTA DE AUDITORIA CERO-RESIDUOS] ===');
      console.log(JSON.stringify(report, null, 2));
      if (!report.clean) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('[VERIFY ERROR]', redactSensitive(err?.stack || err?.message || err));
      process.exit(1);
    });
}
