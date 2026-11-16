import fs from 'node:fs';
import path from 'node:path';
import { TMP_DIR_PATH } from './env.mjs';

export const LEDGER_FILE_PATH = path.join(TMP_DIR_PATH, 'qa-ledger.json');

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR_PATH)) {
    fs.mkdirSync(TMP_DIR_PATH, { recursive: true });
  }
}

function createDefaultLedgerState() {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    active_run_ids: [],
    entries: [],
  };
}

export function readLedger() {
  ensureTmpDir();
  if (!fs.existsSync(LEDGER_FILE_PATH)) {
    return createDefaultLedgerState();
  }
  try {
    const raw = fs.readFileSync(LEDGER_FILE_PATH, 'utf8');
    if (!raw.trim()) return createDefaultLedgerState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return createDefaultLedgerState();
    }
    return {
      version: 1,
      updated_at: parsed.updated_at || new Date().toISOString(),
      active_run_ids: Array.isArray(parsed.active_run_ids) ? parsed.active_run_ids : [],
      entries: parsed.entries,
    };
  } catch {
    return createDefaultLedgerState();
  }
}

function writeLedgerAtomic(state) {
  ensureTmpDir();
  const payload = {
    ...state,
    updated_at: new Date().toISOString(),
  };
  const tempPath = `${LEDGER_FILE_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, LEDGER_FILE_PATH);
  return payload;
}

export function registerRunInLedger(runId) {
  const cleanRunId = String(runId || '').trim();
  if (!cleanRunId) throw new Error('registerRunInLedger requiere un runId válido.');
  const state = readLedger();
  if (!state.active_run_ids.includes(cleanRunId)) {
    state.active_run_ids.push(cleanRunId);
  }
  return writeLedgerAtomic(state);
}

/**
 * Registra inmediatamente en `qa-ledger.json` una entidad creada o archivo subido
 * ANTES de ejecutar el siguiente paso de la prueba.
 */
export function recordLedgerEntry({
  resource_type,
  schema = 'public',
  table_or_bucket,
  pk_column = 'id',
  id,
  run_id,
  meta = undefined,
}) {
  if (!resource_type || !table_or_bucket || !id || !run_id) {
    throw new Error(
      'recordLedgerEntry requiere obligatoriamente { resource_type, table_or_bucket, id, run_id }.'
    );
  }

  const normalizedEntry = {
    resource_type: String(resource_type),
    schema: String(schema),
    table_or_bucket: String(table_or_bucket),
    pk_column: String(pk_column),
    id: String(id),
    run_id: String(run_id),
    created_at: new Date().toISOString(),
    purged: false,
    purged_at: null,
    ...(meta ? { meta } : {}),
  };

  const state = readLedger();
  if (!state.active_run_ids.includes(normalizedEntry.run_id)) {
    state.active_run_ids.push(normalizedEntry.run_id);
  }

  const existingIdx = state.entries.findIndex(
    (e) =>
      e.resource_type === normalizedEntry.resource_type &&
      e.schema === normalizedEntry.schema &&
      e.table_or_bucket === normalizedEntry.table_or_bucket &&
      e.pk_column === normalizedEntry.pk_column &&
      e.id === normalizedEntry.id
  );

  if (existingIdx >= 0) {
    state.entries[existingIdx] = {
      ...state.entries[existingIdx],
      ...normalizedEntry,
      purged: false,
      purged_at: null,
    };
  } else {
    state.entries.push(normalizedEntry);
  }

  writeLedgerAtomic(state);
  return normalizedEntry;
}

export function markLedgerEntriesPurged({
  resource_type,
  schema,
  table_or_bucket,
  ids,
  run_id,
}) {
  const idSet = new Set((ids || []).map((v) => String(v)));
  const state = readLedger();
  const nowIso = new Date().toISOString();

  for (const entry of state.entries) {
    const matchesTarget =
      (!resource_type || entry.resource_type === resource_type) &&
      (!schema || entry.schema === schema) &&
      (!table_or_bucket || entry.table_or_bucket === table_or_bucket) &&
      (!run_id || entry.run_id === run_id) &&
      (idSet.size === 0 || idSet.has(String(entry.id)));

    if (matchesTarget) {
      entry.purged = true;
      entry.purged_at = nowIso;
    }
  }

  const remainingActiveRuns = new Set(
    state.entries.filter((e) => !e.purged).map((e) => e.run_id)
  );
  state.active_run_ids = state.active_run_ids.filter((r) => remainingActiveRuns.has(r));
  return writeLedgerAtomic(state);
}

export function getUnpurgedLedgerEntries(runId = null) {
  const state = readLedger();
  return state.entries.filter(
    (e) => !e.purged && (!runId || e.run_id === String(runId))
  );
}
