// The validation set (validation/README.md): each case and variant planned in Python, sent to
// the app by the driver over its own routes (real meshes and solves in WSL), then evaluated
// against its published reference values into results/<case>/<variant>/result.json.
//
// Opt-in: every test skips unless MAGNUSIM_E2E_VALIDATION=1 (npm run test:validation sets it).
// No default suite runs this folder (scripts/e2e-suites.mjs: validation/ is "none"), nor CI.
// With the gate on, a PC without WSL and OpenFOAM fails instead of skipping.
// Knobs (npm run test:validation sets them from its options):
//   MAGNUSIM_VALIDATION_CASES=c1,c3        only these cases (ids or short names)
//   MAGNUSIM_VALIDATION_VARIANTS=standard  only these variants
//   MAGNUSIM_VALIDATION_CORES=4            the runs' Cores (default 8, the release run's)
//   MAGNUSIM_VALIDATION_COARSE=1           each case's coarse settings, into results-coarse/ (never committed)
//   MAGNUSIM_VALIDATION_MESH_ONLY=1        mesh and record the mesh facts, no solve
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON } from '../../scripts/python-env.js';
import { NO_WSL } from '../../e2e/toolchain.js';
import { runPlan } from './driver.mjs';

const VALIDATION = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(VALIDATION, '..');
const GATE = process.env.MAGNUSIM_E2E_VALIDATION === '1';
const WSL = process.env.MAGNUSIM_E2E_WSL === '1';
const COARSE = process.env.MAGNUSIM_VALIDATION_COARSE === '1';
const MESH_ONLY = process.env.MAGNUSIM_VALIDATION_MESH_ONLY === '1';
const CORES = Number(process.env.MAGNUSIM_VALIDATION_CORES) || 8;
const listOf = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** python -m magnusim_validation <args> (the app's Python, in validation/); its last stdout line as JSON. */
function py(args, { timeout = 600_000 } = {}) {
  const r = spawnSync(PYTHON, ['-m', 'magnusim_validation', ...args], { cwd: VALIDATION, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const lines = String(r.stdout || '').trim().split(/\r?\n/);
  let out = null;
  try {
    out = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* below */
  }
  if (r.status !== 0 || !out) throw new Error(`magnusim_validation ${args.join(' ')} failed (${r.status}): ${String(r.stderr || '').slice(-2000)}`);
  return out;
}

if (!GATE) {
  test('the validation set runs only when asked (npm run test:validation)', () => {
    test.skip(true, 'MAGNUSIM_E2E_VALIDATION is not 1');
  });
} else {
  const wantCases = listOf(process.env.MAGNUSIM_VALIDATION_CASES);
  const wantVariants = listOf(process.env.MAGNUSIM_VALIDATION_VARIANTS);
  const all = py(['list']);
  const runs = [];
  for (const c of all) {
    if (wantCases.length && !wantCases.some((w) => w === c.case || c.case.startsWith(`${w}_`))) continue;
    for (const v of c.variants) if (!wantVariants.length || wantVariants.includes(v)) runs.push({ case: c.case, title: c.title, variant: v });
  }
  test('the validation set has runs to make', () => {
    expect(runs.length, `no case matches MAGNUSIM_VALIDATION_CASES=${wantCases} / VARIANTS=${wantVariants}`).toBeGreaterThan(0);
  });
  for (const r of runs) {
    test(`${r.case} ${r.variant}: ${r.title}`, async ({ request }) => {
      expect(WSL, NO_WSL).toBe(true);
      test.setTimeout(4 * 3600_000);
      const dir = join(VALIDATION, COARSE ? 'results-coarse' : 'results', r.case, r.variant);
      // A run starts clean: the answers of an earlier run never mix with this one's.
      for (const old of ['raw', 'driver.json', 'result.json']) rmSync(join(dir, old), { recursive: true, force: true });
      const planned = py(['plan', r.case, r.variant, '--out', dir, '--cores', String(CORES), ...(COARSE ? ['--coarse'] : [])]);
      expect(planned.ok).toBe(true);
      let drove = null;
      let why = '';
      try {
        drove = await runPlan({ request, dir, webRoot: WEB, meshOnly: MESH_ONLY });
      } catch (e) {
        why = String((e && e.message) || e);
      }
      // Evaluate while the run's case folder is still there (each server start empties its projects root).
      const evaluated = py(['evaluate', dir, ...(why ? ['--failed', why.slice(0, 2000)] : [])]);
      const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
      const rows = (result.quantities || []).map((q) => `${q.key} ${q.value === null ? 'missing' : Number(q.value).toPrecision(5)} vs ${q.reference.value} (${q.error ? `${q.error.rel_pct.toFixed(2)} %` : '-'}, ${q.verdict})`);
      console.log(`RESULT ${r.case}/${r.variant}: ${result.status} ${result.status_detail || ''}\n  ${rows.join('\n  ')}`);
      test.info().annotations.push({ type: 'result', description: `${result.status}: ${rows.join('; ')}` });
      expect(existsSync(join(dir, 'result.json'))).toBe(true);
      // The run must produce its numbers; a locked quantity outside its tolerance fails it too.
      expect(evaluated.status, `${result.status_detail || why}`).toBe(MESH_ONLY ? 'mesh_only' : 'ok');
      expect(drove && drove.outcome, why).toBe(MESH_ONLY ? 'mesh_only' : 'done');
      const failedLocked = (result.quantities || []).filter((q) => q.verdict === 'fail');
      expect(failedLocked.map((q) => q.key), 'locked quantities outside their tolerance').toEqual([]);
    });
  }
}
