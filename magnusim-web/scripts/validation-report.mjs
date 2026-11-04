// npm run validation:report: VALIDATION.md and the public page (docs/validation/ at the
// repository's root) from the validation set's committed results, with the app's Python.
//   npm run validation:report               write them
//   npm run validation:report -- --check    exit 1 when either is not what the results give
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PYTHON, WEB_ROOT } from './python-env.js';

const args = ['-m', 'magnusim_validation', 'report', ...(process.argv.includes('--check') ? ['--check'] : [])];
const r = spawnSync(PYTHON, args, { cwd: join(WEB_ROOT, 'validation'), stdio: 'inherit', windowsHide: true });
if (r.error) {
  console.error(`validation:report: could not run ${PYTHON}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
