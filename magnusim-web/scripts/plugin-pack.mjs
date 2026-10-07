// npm run plugin:pack -- <plugin key or folder> [--out <folder>] [--no-tests] [--json]
// Runs python/tools/plugin_pack.py with the app's Python (scripts/python-env.js): it
// checks the plugin (plugin:check), then writes dist/<key>-v<version>.zip and its
// .sha256, for Settings > Plugins > Install plugin from zip. Paths are relative to
// where npm was run from (INIT_CWD).
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { PYTHON, pyTool, WEB_ROOT } from './python-env.js';

const base = process.env.INIT_CWD || process.cwd();
const r = spawnSync(PYTHON, [pyTool('plugin_pack.py'), '--base', base, ...process.argv.slice(2)], {
  cwd: WEB_ROOT,
  stdio: 'inherit',
  windowsHide: true,
});
if (r.error) {
  console.error(`plugin:pack: could not run ${PYTHON}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
