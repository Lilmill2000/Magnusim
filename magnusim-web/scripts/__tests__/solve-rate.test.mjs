// This PC's solve rate (RH2): a finished run adds its own (solve seconds / (steps · cells per
// rank · outer loops)) to the machine settings, the newest 20 kept; the rate is their median,
// Run_2's 1.4e-5 s with none. Python's pc_solve_rate reads the same settings to the same rate.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-solve-rate-'));
const LOCAL = join(ROOT, 'local.json');
process.env.MAGNUSIM_LOCAL_JSON = LOCAL;
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');

const { DEFAULT_S_PER_CELL_STEP, RATE_SAMPLES_MAX, pcSolveRate, recordSolveRate, runSolveRate, solveRateSample } = await import('../solve-rate.js');
const { resetPrefsCache } = await import('../prefs.js');
const { PYTHON, WEB_ROOT } = await import('../python-env.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** Equal to 1 part in 1e9. */
const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)), `${a} != ${b}`);

/** Run_2 as it would have ended: 0.6 s per step, 625,000 cells on 15 ranks, PISO (1 outer loop). */
const RUN2 = {
  status: 'done',
  n_steps: 1000,
  phases: { solve: 600 },
  n_procs: 15,
  mesh_source: { n_cells: 625000 },
  health: { n_outer: 1, rates: { co_max_per_s: 9.0e4, s_per_step: 0.6, n_outer: 1 } },
};

describe("this PC's solve rate", () => {
  it("a run's rate is solve seconds over steps, cells per rank and outer loops (Run_2: about 1.4e-5 s)", () => {
    assert.ok(Math.abs(runSolveRate(RUN2) - 1.44e-5) < 1e-7);
    near(solveRateSample({ solve_s: 600, steps: 1000, cells: 625000, ranks: 15, n_outer: 3 }), 600 / (1000 * (625000 / 15) * 3));
    // A continued run: this attempt's steps only.
    near(runSolveRate({ ...RUN2, n_steps: 1500, continued: { steps_before: 500 } }), runSolveRate(RUN2));
    // The outer loops from the health hints; steady runs (no n_outer) count 1.
    near(runSolveRate({ ...RUN2, health: { n_outer: 3 } }), runSolveRate(RUN2) / 3);
    near(runSolveRate({ ...RUN2, health: null }), runSolveRate(RUN2));
  });

  it('only a finished run with every number gives a rate', () => {
    assert.equal(runSolveRate({ ...RUN2, status: 'stopped' }), null);
    assert.equal(runSolveRate({ ...RUN2, phases: {} }), null);
    assert.equal(runSolveRate({ ...RUN2, mesh_source: null }), null);
    assert.equal(runSolveRate({ ...RUN2, n_steps: 0 }), null);
    assert.equal(solveRateSample({ solve_s: -1, steps: 1, cells: 1 }), null);
  });

  it("with no finished run it is Run_2's rate; then the median of the kept runs, the newest 20", () => {
    assert.deepEqual(pcSolveRate({}), { s_per_cell_step: DEFAULT_S_PER_CELL_STEP, runs: 0, source: 'default' });
    assert.deepEqual(pcSolveRate({ solve_rate: { samples: [{ s_per_cell_step: 'x' }] } }), { s_per_cell_step: 1.4e-5, runs: 0, source: 'default' });
    assert.deepEqual(pcSolveRate({ solve_rate: { samples: [{ s_per_cell_step: 3e-5 }, { s_per_cell_step: 1e-5 }, { s_per_cell_step: 2e-5 }] } }), { s_per_cell_step: 2e-5, runs: 3, source: 'measured' });
    near(pcSolveRate({ solve_rate: { samples: [{ s_per_cell_step: 1e-5 }, { s_per_cell_step: 2e-5 }] } }).s_per_cell_step, 1.5e-5);
    const many = Array.from({ length: 25 }, (_, i) => ({ s_per_cell_step: (i + 1) * 1e-6 }));
    // The newest 20 (6e-6 .. 25e-6): their median.
    const newest = pcSolveRate({ solve_rate: { samples: many } });
    assert.deepEqual([newest.runs, newest.source], [RATE_SAMPLES_MAX, 'measured']);
    near(newest.s_per_cell_step, 15.5e-6);
  });

  it('a finished run is added to the machine settings (no name or path kept), and the oldest go past 20', () => {
    writeFileSync(LOCAL, JSON.stringify({ port: 9999, units: 'Metric' }));
    resetPrefsCache();
    const sample = recordSolveRate({ ...RUN2, name: 'Run_2', case_dir: 'C:\\x' }, { now: () => '2026-11-03T12:00:00Z' });
    assert.deepEqual(sample, { s_per_cell_step: 1.44e-5, cells: 625000, ranks: 15, steps: 1000, at: '2026-11-03T12:00:00Z' });
    const doc = JSON.parse(readFileSync(LOCAL, 'utf8'));
    assert.equal(doc.port, 9999);
    assert.deepEqual(doc.solve_rate.samples, [sample]);
    assert.ok(!JSON.stringify(doc).includes('Run_2') && !JSON.stringify(doc).includes('C:'));
    assert.equal(recordSolveRate({ ...RUN2, status: 'failed' }), null);
    for (let i = 0; i < 24; i += 1) recordSolveRate({ ...RUN2, phases: { solve: 600 + i } });
    const kept = JSON.parse(readFileSync(LOCAL, 'utf8')).solve_rate.samples;
    assert.equal(kept.length, RATE_SAMPLES_MAX);
    assert.equal(kept.at(-1).s_per_cell_step, Number((623 / (1000 * (625000 / 15))).toPrecision(4)));
  });

  it("Python's pc_solve_rate reads the same settings to the same rate", () => {
    const doc = JSON.parse(readFileSync(LOCAL, 'utf8'));
    const code = [
      'import json, sys',
      'sys.path.insert(0, "python/sdk")',
      'from magnusim_sdk.run_estimate import pc_solve_rate',
      'print(json.dumps(pc_solve_rate(json.load(open(sys.argv[1])))))',
    ].join('\n');
    const r = spawnSync(PYTHON, ['-c', code, LOCAL], { cwd: WEB_ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const py = JSON.parse(r.stdout);
    const js = pcSolveRate(doc);
    assert.equal(py.runs, js.runs);
    assert.equal(py.source, 'measured');
    assert.ok(Math.abs(py.s_per_cell_step - js.s_per_cell_step) < 1e-15);
  });
});
