// Replace the shipped kernel (workspace/kernel/mk32.*) from Windows while holding
// .cache/build.lock, the lock e2e runs (scripts/e2e.mjs) and builds hold, so no e2e
// run gets a new kernel halfway through and queued runs wait for this build:
//   node kernel-build/ship.mjs [build.sh args...]
// Runs kernel-build/build.sh in WSL (CAD_BUILD_ROOT and the pins as build.sh has
// them). Waits up to CAD_KERNEL_LOCK_WAIT seconds (default 3600) for the lock.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from '../scripts/lock.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wsl = (p) => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
};
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const release = await acquireLock(join(PLUGIN, '.cache', 'build.lock'), Number(process.env.CAD_KERNEL_LOCK_WAIT || 3600) * 1000, 'kernel-build/ship.mjs');
let code = 1;
try {
  const args = process.argv.slice(2).map(quote).join(' ');
  const cmd = `cd ${quote(wsl(PLUGIN))} && CAD_KERNEL_IGNORE_BUILD_LOCK=1 ./kernel-build/build.sh ${args}`;
  const r = spawnSync('wsl.exe', ['-e', 'bash', '-lc', cmd], { stdio: 'inherit' });
  code = r.status ?? 1;
} finally {
  release();
}
process.exit(code);
