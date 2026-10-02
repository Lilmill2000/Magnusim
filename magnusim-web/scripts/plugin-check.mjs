// npm run plugin:check -- <plugin folder>... [--json] [--no-tests]
// Runs python/tools/plugin_check.py with the app's Python (scripts/python-env.js).
// Paths are relative to where npm was run from (INIT_CWD); globs such as
// bundled-plugins/* are expanded by the tool, as Windows shells do not.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { PYTHON, pyTool, WEB_ROOT } from './python-env.js';

const base = process.env.INIT_CWD || process.cwd();
const r = spawnSync(PYTHON, [pyTool('plugin_check.py'), '--base', base, ...process.argv.slice(2)], {
  cwd: WEB_ROOT,
  stdio: 'inherit',
  windowsHide: true,
});
if (r.error) {
  console.error(`plugin:check: could not run ${PYTHON}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
