// Build, then run the e2e specs, holding .cache/build.lock for the whole run so
// no build (another e2e run, or npm run build) rewrites workspace/ mid-test.
//   node scripts/e2e.mjs [playwright args...]     e.g. node scripts/e2e.mjs e2e/cad-p1-scaffold.spec.ts
// Waits up to CAD_E2E_WAIT_MS (default 10 min) for another run to finish.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = await acquireLock(join(ROOT, '.cache', 'build.lock'), Number(process.env.CAD_E2E_WAIT_MS || 600_000));
let code = 1;
try {
  const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CAD_BUILD_LOCK_HELD: String(process.pid) } });
  if (b.status !== 0) {
    code = b.status ?? 1;
  } else {
    const cli = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
    const t = spawnSync(process.execPath, [cli, 'test', '-c', 'e2e/playwright.config.ts', ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit', env: process.env });
    code = t.status ?? 1;
  }
} finally {
  release();
}
process.exit(code);
