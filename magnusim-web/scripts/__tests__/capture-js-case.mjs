/**
 * Dev-only: refresh Incompressible Flow's goldens (js_steady, js_transient) from
 * what prepare_run writes now. The goldens and their tests live in the plugin
 * (bundled-plugins/incompressible_flow/tests); compare-js-case.mjs checks them.
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
const PLUGIN_ROOT = join(WEB_ROOT, 'bundled-plugins', 'incompressible_flow');
// Every test that writes a golden in update mode.
const TESTS = ['test_prepare_run_golden.py', 'test_write_case_golden.py', 'test_transient.py'].map((f) =>
  join(PLUGIN_ROOT, 'tests', f),
);

function main() {
  const missing = TESTS.filter((t) => !existsSync(t));
  if (missing.length) {
    console.error('missing', missing.join(', '));
    process.exit(1);
  }
  const env = {
    ...process.env,
    PYTHONPATH: PY_ROOT + (process.env.PYTHONPATH ? (process.platform === 'win32' ? ';' : ':') + process.env.PYTHONPATH : ''),
    CFDDESK_UPDATE_GOLDEN: '1',
  };
  const r = spawnSync(
    PYTHON,
    ['-m', 'pytest', ...TESTS, '-q', '--tb=short'],
    { cwd: PLUGIN_ROOT, env, encoding: 'utf8', windowsHide: true },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error('CAPTURE FAIL: update-golden pytest exited', r.status);
    process.exit(r.status == null ? 1 : r.status);
  }
  console.log('CAPTURE OK (goldens refreshed from prepare_run; check git diff before committing them)');
}

main();
