// npm run test:physics: the quick physics checks (docs/TESTING.md). Incompressible Flow's case
// writer on blockMesh grids, solved in WSL, against published values in a few minutes:
// bundled-plugins/incompressible_flow/tests/test_physics_quick_wsl.py (pytest -m "wsl and
// physics", with the app's own Python). The full e2e tier (npm run test:e2e) runs them first;
// the per-commit fast tier and CI (no WSL) never do.
// Without WSL and OpenFOAM they are skipped and say why, as the WSL e2e tests are;
// MAGNUSIM_E2E_WSL=1 fails instead, MAGNUSIM_E2E_WSL=0 skips them on purpose. They wait for the
// PC's WSL test lock first (e2e/support/wsl-lock.mjs; MAGNUSIM_E2E_LOCK=0 skips it).
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireWslLock } from '../e2e/support/wsl-lock.mjs';
import { openFoamInWsl } from '../e2e/toolchain.js';
import { PY_ROOT, PYTHON } from './python-env.js';

/** The checks, from python/ (the app's pytest settings). */
export const PHYSICS_TESTS = '../bundled-plugins/incompressible_flow/tests/test_physics_quick_wsl.py';

/** pytest's arguments: the checks only, their numbers printed (-s). */
export function physicsArgs(extra = []) {
  return ['-m', 'pytest', '-q', '-s', '-p', 'no:cacheprovider', '-m', 'wsl and physics', PHYSICS_TESTS, ...extra];
}

/**
 * Whether to run them: `{ run: true }`, or `{ run: false, code, why }` (code 0: skipped, 1: the
 * toolchain was insisted on and is missing). `found` asks WSL for OpenFOAM (only when needed).
 */
export function physicsPlan(env = process.env, found = openFoamInWsl) {
  const flag = String(env.MAGNUSIM_E2E_WSL ?? env.CFDDESK_E2E_WSL ?? '').trim();
  if (flag === '0') return { run: false, code: 0, why: 'skipped: MAGNUSIM_E2E_WSL=0' };
  if (found()) return { run: true };
  if (flag === '1') return { run: false, code: 1, why: 'MAGNUSIM_E2E_WSL=1 but WSL with OpenFOAM v2606 was not found' };
  return { run: false, code: 0, why: 'skipped: WSL with OpenFOAM v2606 was not found' };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const plan = physicsPlan(env);
  if (!plan.run) {
    console.log(`[physics] ${plan.why}`);
    return plan.code;
  }
  const args = physicsArgs(argv);
  const release = env.MAGNUSIM_E2E_LOCK === '0' ? null : await acquireWslLock({ what: 'npm run test:physics' });
  try {
    console.log(`[physics] ${PYTHON} ${args.join(' ')} (in python/)`);
    const r = spawnSync(PYTHON, args, { cwd: PY_ROOT, env, stdio: 'inherit', windowsHide: true });
    if (r.error) {
      console.error(`[physics] could not run ${PYTHON}: ${r.error.message}`);
      return 1;
    }
    return r.status ?? 1;
  } finally {
    release?.();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
