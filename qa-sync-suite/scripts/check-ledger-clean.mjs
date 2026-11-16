import { getUnpurgedLedgerEntries, LEDGER_FILE_PATH, readLedger } from './lib/ledger.mjs';

function readStdinSync() {
  try {
    return Buffer.from(
      // fd 0 lectura síncrona cuando es invocado como hook Stop
      (() => {
        const fs = process.getBuiltinModule('node:fs');
        return fs.readFileSync(0);
      })()
    ).toString('utf8');
  } catch {
    return '';
  }
}

const isCliMode = process.argv.includes('--cli');

if (isCliMode) {
  const ledger = readLedger();
  const unpurged = getUnpurgedLedgerEntries();
  console.log(
    JSON.stringify(
      {
        ledgerFile: LEDGER_FILE_PATH,
        totalEntries: ledger.entries.length,
        unpurgedCount: unpurged.length,
        activeRunIds: ledger.active_run_ids,
        status: unpurged.length === 0 ? 'CLEAN' : 'DIRTY_UNPURGED_RESIDUES',
      },
      null,
      2
    )
  );
  process.exit(unpurged.length === 0 ? 0 : 1);
} else {
  const rawInput = readStdinSync();
  let hookInput = {};
  if (rawInput.trim()) {
    try {
      hookInput = JSON.parse(rawInput);
    } catch {
      hookInput = {};
    }
  }

  const unpurged = getUnpurgedLedgerEntries();
  const continuationActive = Boolean(hookInput?.continuationActive);
  const terminationReason = String(hookInput?.terminationReason || '');

  if (
    unpurged.length > 0 &&
    !continuationActive &&
    terminationReason !== 'USER_CANCELED'
  ) {
    const tables = [...new Set(unpurged.map((e) => `${e.schema}.${e.table_or_bucket}`))];
    process.stdout.write(
      JSON.stringify({
        decision: 'continue',
        reason: `ALERTA CERO-RESIDUOS: Quedan ${unpurged.length} entradas sin purgar en qa-sync-suite/.tmp/qa-ledger.json (${tables.join(', ')}). Ejecuta obligatoriamente scripts/teardown-qa-environment.mjs y scripts/verify-zero-residue.mjs antes de finalizar.`,
      })
    );
  } else {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  }
}
