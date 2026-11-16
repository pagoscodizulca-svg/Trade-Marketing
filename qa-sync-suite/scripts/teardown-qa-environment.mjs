import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadAdminQaEnv, redactSensitive } from './lib/env.mjs';
import {
  getUnpurgedLedgerEntries,
  markLedgerEntriesPurged,
  readLedger,
} from './lib/ledger.mjs';
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

function uniqueNonEmptyStrings(values) {
  return [...new Set((values || []).map((v) => String(v || '').trim()).filter(Boolean))];
}

/**
 * Elimina únicamente por coincidencia exacta de ID (`WHERE pk IN (...)`).
 * PROHIBIDO ejecutar DELETE masivo sin filtro.
 */
async function deleteExactByIds(adminClient, pacer, table, pkColumn, ids) {
  const cleanIds = uniqueNonEmptyStrings(ids);
  if (cleanIds.length === 0) return 0;

  await pacer.pace();
  const { data, error } = await adminClient
    .from(table)
    .delete()
    .in(pkColumn, cleanIds)
    .select(pkColumn);

  if (error) {
    if (isMissingTableOrColError(error)) return 0;
    throw new Error(
      `Error borrando por ID exacto en public.${table}: ${redactSensitive(error.message)}`
    );
  }
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Barrido adicional de seguridad por etiqueta exacta `[QA-SYNC-TEST:${runId}]`
 * para capturar duplicados generados en pruebas de idempotencia o triggers automáticos.
 */
async function findIdsByTagColumn(adminClient, pacer, table, pkColumn, filterColumn, runTag) {
  const cleanTag = String(runTag || '').trim();
  if (!cleanTag || !cleanTag.startsWith('[QA-SYNC-TEST:QA_SYNC_')) {
    return [];
  }

  await pacer.pace();
  const { data, error } = await adminClient
    .from(table)
    .select(pkColumn)
    .ilike(filterColumn, `%${cleanTag}%`);

  if (error) {
    if (isMissingTableOrColError(error)) return [];
    throw new Error(
      `Error buscando residuos por tag en public.${table}.${filterColumn}: ${redactSensitive(
        error.message
      )}`
    );
  }
  return uniqueNonEmptyStrings((data || []).map((r) => r?.[pkColumn]));
}

async function findIdsByForeignKeys(adminClient, pacer, table, pkColumn, fkColumn, fkValues) {
  const cleanFkVals = uniqueNonEmptyStrings(fkValues);
  if (cleanFkVals.length === 0) return [];

  await pacer.pace();
  const { data, error } = await adminClient
    .from(table)
    .select(pkColumn)
    .in(fkColumn, cleanFkVals);

  if (error) {
    if (isMissingTableOrColError(error)) return [];
    throw new Error(
      `Error buscando hijos FK en public.${table}.${fkColumn}: ${redactSensitive(error.message)}`
    );
  }
  return uniqueNonEmptyStrings((data || []).map((r) => r?.[pkColumn]));
}

/**
 * Ejecuta la purga total Cero-Residuos respetando estrictamente el
 * ORDEN INVERSO DE LLAVES FORÁNEAS (Pasos A -> B -> C -> D -> E).
 * Prohibido usar TRUNCATE, DROP o DELETE sin filtro.
 */
export async function teardownQaEnvironment({ runId = null } = {}) {
  const adminEnv = loadAdminQaEnv('teardown-qa-environment.mjs');
  const pacer = createRequestPacer(adminEnv.rateLimitRps);

  const adminClient = createClient(adminEnv.supabaseUrl, adminEnv.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const ledger = readLedger();
  const unpurged = getUnpurgedLedgerEntries(runId);

  const targetRunIds = uniqueNonEmptyStrings([
    ...(runId ? [runId] : []),
    ...ledger.active_run_ids,
    ...unpurged.map((e) => e.run_id),
  ]).filter((r) => /^QA_SYNC_[0-9]+_[A-F0-9]+$/.test(r));

  const ledgerIdsFor = (resourceType, tableOrBucket) =>
    uniqueNonEmptyStrings(
      unpurged
        .filter(
          (e) => e.resource_type === resourceType && e.table_or_bucket === tableOrBucket
        )
        .map((e) => e.id)
    );

  const qaStaffIds = ledgerIdsFor('db_row', 'staff');
  const qaAuthUserIds = ledgerIdsFor('auth_user', 'users');

  const summary = {
    targetRunIds,
    stepA_storageObjectsRemoved: 0,
    stepB_childrenDeleted: {
      asistencia_evidencias: 0,
      asistencias_jornada: 0,
      rutas_promotoras: 0,
      trazabilidad_login: 0,
    },
    stepC_tastingAndInboxDeleted: {
      cronograma_degustaciones: 0,
      cargas_archivos: 0,
      surveys: 0,
    },
    stepD_catalogsDeleted: {
      clientes: 0,
      clients: 0,
      vendedores: 0,
    },
    stepE_identitiesDeleted: {
      staff: 0,
      profiles: 0,
      auth_users: 0,
    },
  };

  // =========================================================================
  // PASO A: Objetos de prueba en buckets de Supabase Storage (`asistencia-evidencias`)
  // =========================================================================
  const storagePaths = ledgerIdsFor('storage_object', 'asistencia-evidencias');
  if (storagePaths.length > 0) {
    await pacer.pace();
    const { data, error } = await adminClient.storage
      .from('asistencia-evidencias')
      .remove(storagePaths);
    if (error && !/Bucket not found|not found/i.test(error.message || '')) {
      throw new Error(
        `Error en Paso A (Storage asistencia-evidencias): ${redactSensitive(error.message)}`
      );
    }
    summary.stepA_storageObjectsRemoved += Array.isArray(data)
      ? data.length
      : storagePaths.length;
    markLedgerEntriesPurged({
      resource_type: 'storage_object',
      table_or_bucket: 'asistencia-evidencias',
      ids: storagePaths,
    });
  }

  // =========================================================================
  // PASO B: Tablas hijas operativas (ANTES de `staff` por ON DELETE RESTRICT)
  // =========================================================================
  const jornadaIdsFromStaff = await findIdsByForeignKeys(
    adminClient,
    pacer,
    'asistencias_jornada',
    'id',
    'promotora_id',
    qaStaffIds
  );
  const jornadaTagIds = [];
  for (const rId of targetRunIds) {
    const found = await findIdsByTagColumn(
      adminClient,
      pacer,
      'asistencias_jornada',
      'id',
      'pdv_nombre',
      `[QA-SYNC-TEST:${rId}]`
    );
    jornadaTagIds.push(...found);
  }
  const allJornadaIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'asistencias_jornada'),
    ...jornadaIdsFromStaff,
    ...jornadaTagIds,
  ]);

  const evidenciaIdsFromJornadas = await findIdsByForeignKeys(
    adminClient,
    pacer,
    'asistencia_evidencias',
    'id',
    'asistencia_id',
    allJornadaIds
  );
  const allEvidenciaIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'asistencia_evidencias'),
    ...evidenciaIdsFromJornadas,
  ]);

  summary.stepB_childrenDeleted.asistencia_evidencias = await deleteExactByIds(
    adminClient,
    pacer,
    'asistencia_evidencias',
    'id',
    allEvidenciaIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'asistencia_evidencias',
    ids: allEvidenciaIds,
  });

  summary.stepB_childrenDeleted.asistencias_jornada = await deleteExactByIds(
    adminClient,
    pacer,
    'asistencias_jornada',
    'id',
    allJornadaIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'asistencias_jornada',
    ids: allJornadaIds,
  });

  const rutaIdsFromStaff = await findIdsByForeignKeys(
    adminClient,
    pacer,
    'rutas_promotoras',
    'id',
    'promotora_id',
    qaStaffIds
  );
  const rutaTagIds = [];
  for (const rId of targetRunIds) {
    const found = await findIdsByTagColumn(
      adminClient,
      pacer,
      'rutas_promotoras',
      'id',
      'cliente_nombre',
      `[QA-SYNC-TEST:${rId}]`
    );
    rutaTagIds.push(...found);
  }
  const allRutaIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'rutas_promotoras'),
    ...rutaIdsFromStaff,
    ...rutaTagIds,
  ]);

  summary.stepB_childrenDeleted.rutas_promotoras = await deleteExactByIds(
    adminClient,
    pacer,
    'rutas_promotoras',
    'id',
    allRutaIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'rutas_promotoras',
    ids: allRutaIds,
  });

  const trazaTagIds = [];
  for (const rId of targetRunIds) {
    const found = await findIdsByTagColumn(
      adminClient,
      pacer,
      'trazabilidad_login',
      'id',
      'usuario',
      `[QA-SYNC-TEST:${rId}]`
    );
    trazaTagIds.push(...found);
  }
  const allTrazaIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'trazabilidad_login'),
    ...trazaTagIds,
  ]);
  summary.stepB_childrenDeleted.trazabilidad_login = await deleteExactByIds(
    adminClient,
    pacer,
    'trazabilidad_login',
    'id',
    allTrazaIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'trazabilidad_login',
    ids: allTrazaIds,
  });

  // =========================================================================
  // PASO C: Módulo de Degustaciones (`cronograma_degustaciones`) y Bandeja (`surveys`)
  // =========================================================================
  const cronIdsFromStaff = await findIdsByForeignKeys(
    adminClient,
    pacer,
    'cronograma_degustaciones',
    'id',
    'promotora_id',
    qaStaffIds
  );
  const cronTagIds = [];
  for (const rId of targetRunIds) {
    const byClient = await findIdsByTagColumn(
      adminClient,
      pacer,
      'cronograma_degustaciones',
      'id',
      'cliente_nombre',
      `[QA-SYNC-TEST:${rId}]`
    );
    const byObs = await findIdsByTagColumn(
      adminClient,
      pacer,
      'cronograma_degustaciones',
      'id',
      'observaciones',
      `[QA-SYNC-TEST:${rId}]`
    );
    cronTagIds.push(...byClient, ...byObs);
  }
  const allCronogramaIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'cronograma_degustaciones'),
    ...cronIdsFromStaff,
    ...cronTagIds,
  ]);

  summary.stepC_tastingAndInboxDeleted.cronograma_degustaciones = await deleteExactByIds(
    adminClient,
    pacer,
    'cronograma_degustaciones',
    'id',
    allCronogramaIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'cronograma_degustaciones',
    ids: allCronogramaIds,
  });

  const cargaTagIds = [];
  for (const rId of targetRunIds) {
    const found = await findIdsByTagColumn(
      adminClient,
      pacer,
      'cargas_archivos',
      'id',
      'nombre_archivo',
      `[QA-SYNC-TEST:${rId}]`
    );
    cargaTagIds.push(...found);
  }
  const allCargaIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'cargas_archivos'),
    ...cargaTagIds,
  ]);
  summary.stepC_tastingAndInboxDeleted.cargas_archivos = await deleteExactByIds(
    adminClient,
    pacer,
    'cargas_archivos',
    'id',
    allCargaIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'cargas_archivos',
    ids: allCargaIds,
  });

  const surveyTagIds = [];
  for (const rId of targetRunIds) {
    const byStore = await findIdsByTagColumn(
      adminClient,
      pacer,
      'surveys',
      'id',
      'store',
      `[QA-SYNC-TEST:${rId}]`
    );
    const byComments = await findIdsByTagColumn(
      adminClient,
      pacer,
      'surveys',
      'id',
      'comments',
      `[QA-SYNC-TEST:${rId}]`
    );
    surveyTagIds.push(...byStore, ...byComments);
  }
  const allSurveyIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'surveys'),
    ...surveyTagIds,
  ]);

  summary.stepC_tastingAndInboxDeleted.surveys = await deleteExactByIds(
    adminClient,
    pacer,
    'surveys',
    'id',
    allSurveyIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'surveys',
    ids: allSurveyIds,
  });

  // =========================================================================
  // PASO D: Cliente de Prueba ficticio y catálogos auxiliares (`clientes`, `vendedores`)
  // =========================================================================
  const clienteTagIds = [];
  const legacyClientTagIds = [];
  const vendedorTagIds = [];

  for (const rId of targetRunIds) {
    const c1 = await findIdsByTagColumn(
      adminClient,
      pacer,
      'clientes',
      'id',
      'razon_social',
      `[QA-SYNC-TEST:${rId}]`
    );
    const c2 = await findIdsByTagColumn(
      adminClient,
      pacer,
      'clients',
      'id',
      'business_name',
      `[QA-SYNC-TEST:${rId}]`
    );
    const v1 = await findIdsByTagColumn(
      adminClient,
      pacer,
      'vendedores',
      'id',
      'nombre_completo',
      `[QA-SYNC-TEST:${rId}]`
    );
    clienteTagIds.push(...c1);
    legacyClientTagIds.push(...c2);
    vendedorTagIds.push(...v1);
  }

  const allClienteIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'clientes'),
    ...clienteTagIds,
  ]);
  summary.stepD_catalogsDeleted.clientes = await deleteExactByIds(
    adminClient,
    pacer,
    'clientes',
    'id',
    allClienteIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'clientes',
    ids: allClienteIds,
  });

  const allLegacyClientIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'clients'),
    ...legacyClientTagIds,
  ]);
  summary.stepD_catalogsDeleted.clients = await deleteExactByIds(
    adminClient,
    pacer,
    'clients',
    'id',
    allLegacyClientIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'clients',
    ids: allLegacyClientIds,
  });

  const allVendedorIds = uniqueNonEmptyStrings([
    ...ledgerIdsFor('db_row', 'vendedores'),
    ...vendedorTagIds,
  ]);
  summary.stepD_catalogsDeleted.vendedores = await deleteExactByIds(
    adminClient,
    pacer,
    'vendedores',
    'id',
    allVendedorIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'vendedores',
    ids: allVendedorIds,
  });

  // =========================================================================
  // PASO E: Perfiles públicos (`staff`, `profiles`) y cuentas en `auth.users`
  // =========================================================================
  const staffTagIds = [];
  for (const rId of targetRunIds) {
    const s1 = await findIdsByTagColumn(
      adminClient,
      pacer,
      'staff',
      'id',
      'name',
      `[QA-SYNC-TEST:${rId}]`
    );
    staffTagIds.push(...s1);
  }
  const allStaffIds = uniqueNonEmptyStrings([...qaStaffIds, ...staffTagIds]);
  summary.stepE_identitiesDeleted.staff = await deleteExactByIds(
    adminClient,
    pacer,
    'staff',
    'id',
    allStaffIds
  );
  markLedgerEntriesPurged({
    resource_type: 'db_row',
    table_or_bucket: 'staff',
    ids: allStaffIds,
  });

  // También descubrir posibles usuarios QA huérfanos en auth.users pertenecientes a targetRunIds
  await pacer.pace();
  const discoveredAuthIds = [...qaAuthUserIds];
  const listRes = await adminClient.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (!listRes.error && Array.isArray(listRes.data?.users)) {
    for (const u of listRes.data.users) {
      const email = String(u.email || '').toLowerCase();
      const metaRunId = u.app_metadata?.qa_run_id || u.user_metadata?.qa_run_id;
      const isQaDomain = email.endsWith('@qa-sync.codizulca.internal');
      if (isQaDomain && (targetRunIds.length === 0 || targetRunIds.includes(metaRunId))) {
        discoveredAuthIds.push(u.id);
      }
    }
  }
  const allAuthUserIds = uniqueNonEmptyStrings(discoveredAuthIds);

  // Si existe tabla `public.profiles` vinculada a `auth.users`, limpiar por ID exacto
  if (allAuthUserIds.length > 0) {
    summary.stepE_identitiesDeleted.profiles = await deleteExactByIds(
      adminClient,
      pacer,
      'profiles',
      'id',
      allAuthUserIds
    );
  }

  for (const uid of allAuthUserIds) {
    await pacer.pace();
    const { error } = await adminClient.auth.admin.deleteUser(uid);
    if (error && !/User not found|not found/i.test(error.message || '')) {
      throw new Error(
        `Error eliminando usuario Auth QA (${uid}): ${redactSensitive(error.message)}`
      );
    }
    summary.stepE_identitiesDeleted.auth_users += 1;
    markLedgerEntriesPurged({
      resource_type: 'auth_user',
      schema: 'auth',
      table_or_bucket: 'users',
      ids: [uid],
    });
  }

  return summary;
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const runIdArgIdx = process.argv.indexOf('--run-id');
  const explicitRunId = runIdArgIdx >= 0 ? process.argv[runIdArgIdx + 1] : null;

  teardownQaEnvironment({ runId: explicitRunId })
    .then((summary) => {
      console.log('=== [TEARDOWN CERO-RESIDUOS COMPLETADO] ===');
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((err) => {
      console.error('[TEARDOWN ERROR]', redactSensitive(err?.stack || err?.message || err));
      process.exit(1);
    });
}
