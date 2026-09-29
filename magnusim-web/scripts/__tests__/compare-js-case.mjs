/**
 * Assert prepare_run output matches Incompressible Flow's goldens (js_steady, js_transient).
 * The goldens and their test live in the plugin (bundled-plugins/incompressible_flow/tests).
 *
 * Usage: node scripts/__tests__/compare-js-case.mjs
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
const TEST = join(PLUGIN_ROOT, 'tests', 'test_prepare_run_golden.py');

function main() {
  if (!existsSync(TEST)) {
    console.error('missing', TEST);
    process.exit(1);
  }
  const env = {
    ...process.env,
    PYTHONPATH: PY_ROOT + (process.env.PYTHONPATH ? pathSep() + process.env.PYTHONPATH : ''),
  };
  delete env.CFDDESK_UPDATE_GOLDEN;
  const r = spawnSync(
    PYTHON,
    ['-m', 'pytest', TEST, '-q', '--tb=short'],
    { cwd: PLUGIN_ROOT, env, encoding: 'utf8', windowsHide: true },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error('COMPARE FAIL: prepare_run golden pytest exited', r.status);
    process.exit(r.status == null ? 1 : r.status);
  }
  console.log('COMPARE OK (prepare_run vs js_steady|js_transient)');
}

function pathSep() {
  return process.platform === 'win32' ? ';' : ':';
}

main();
