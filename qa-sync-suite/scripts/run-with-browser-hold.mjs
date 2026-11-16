import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const suiteRoot = path.resolve(__dirname, '..');

const child = spawn(
  process.execPath,
  ['--test', path.join(suiteRoot, 'tests', 'qa-sync-suite.spec.mjs')],
  {
    cwd: suiteRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      QA_HOLD_FOR_BROWSER: 'true',
    },
  }
);

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
