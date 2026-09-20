/**
 * Dev-only: refresh Python golden fixtures from prepare_run / web_case.
 * Phase 1 land6: no longer calls writeSolveCase.
 *
 * Usage: node scripts/__tests__/capture-js-case.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON } from '../python-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '../..');
const PY_ROOT = join(WEB_ROOT, 'python');
const TEST = join(PY_ROOT, 'tests', 'unit', 'test_prepare_run_golden.py');

function main() {
  if (!existsSync(TEST)) {
    console.error('missing', TEST);
    process.exit(1);
  }
  const env = {
    ...process.env,
    PYTHONPATH: PY_ROOT + (process.env.PYTHONPATH ? (process.platform === 'win32' ? ';' : ':') + process.env.PYTHONPATH : ''),
    CFDDESK_UPDATE_GOLDEN: '1',
  };
  const r = spawnSync(
    PYTHON,
    ['-m', 'pytest', TEST, '-q', '--tb=short'],
    { cwd: PY_ROOT, env, encoding: 'utf8', windowsHide: true },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error('CAPTURE FAIL: update-golden pytest exited', r.status);
    process.exit(r.status == null ? 1 : r.status);
  }
  console.log('CAPTURE OK (goldens refreshed via prepare_run / web_case)');
}

main();
