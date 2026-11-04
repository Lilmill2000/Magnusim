// RH2: the pre-run check in Node (spec 4.3, 4.6). POST /api/run/precheck (w27 precheckRun) asks
// the worker's analysis.run_check (on the data lane) with the run's settings and the proposed ones
// over them, and merges this PC's numbers in: the run's Cores, the ranks cap, this PC's solve rate.
// The ranks Python gives a run follow runRanks' rule; checks_kept is a free run key that saves
// through run.update (the page's Keep as set and setup_edit's run update) and never asks to
// overwrite.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-run-precheck-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';
// Three finished runs on this PC: the measured rate is their median.
writeFileSync(process.env.MAGNUSIM_LOCAL_JSON, JSON.stringify({ solve_rate: { samples: [{ s_per_cell_step: 3e-5 }, { s_per_cell_step: 1e-5 }, { s_per_cell_step: 2e-5 }] } }));

const w27 = await import('../w27-solve.js');
const layout = await import('../project-layout.js');
const io = await import('../study-io.js');
const py = await import('../py-json.js');
const { resetPrefsCache } = await import('../prefs.js');
const { isDataLaneMethod } = await import('../server/worker.ts');
const { FREE_KEYS, runEditState, solveChanged } = await import('../../src/workbench/runReopen.ts');
const { PYTHON, WEB_ROOT } = await import('../python-env.js');

after(() => {
  py.attachWorkerBridge(null);
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

const PID = 'p1';
const SID = 's1';
function seed() {
  const dir = join(PROJECTS, PID);
  mkdirSync(dir, { recursive: true });
  const g = layout.createGeometryFolder(dir, { id: 'g1', name: 'Part' });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: PID, title: 'P1', geometries: [{ id: g.id, name: g.name }], active_geometry_id: g.id }));
  layout.createStudyFolder(dir, g.id, { id: SID, name: 'Study 1', time_dependency: 'Transient' });
  writeFileSync(join(dir, 'simulations.json'), JSON.stringify({ active_id: SID, simulations: [{ id: SID, name: 'Study 1', geometry_id: g.id, time_dependency: 'Transient' }] }));
  io.persistRun(PID, SID, {
    id: 'r1',
    run_id: 'r1',
    name: 'Run_2',
    simulation_id: SID,
    status: 'draft',
    time_dependency: 'Transient',
    mesh_id: 'm1',
    cores: 4,
    transient: { end_time: 10, write_count: 60, max_co: 100, n_outer_correctors: 1, n_correctors: 2 },
  });
}
seed();

describe('POST /api/run/precheck (precheckRun)', () => {
  it('asks analysis.run_check on the data lane with the run settings, the proposed ones over them, its Cores and this PC rate', async () => {
    resetPrefsCache?.();
    const calls = [];
    py.attachWorkerBridge(async (method, params) => {
      calls.push([method, params]);
      return {
        ok: true,
        analysis_key: 'incompressible_transient',
        checked: true,
        checks: [{ code: 'piso_high_co', level: 'warn', text: 'Max Courant 100 with 1 outer corrector.' }],
        estimate: { line: 'Δt ≈ 1.1e-5 s', steps: 900000 },
        ranks: 4,
        kept: [],
      };
    });
    const out = await w27.precheckRun(PID, 'r1', { transient: { n_outer_correctors: 3, max_co: 5 } }, SID);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(calls.length, 1);
    const [method, params] = calls[0];
    assert.equal(method, 'analysis.run_check');
    assert.equal(isDataLaneMethod(method), true, 'the data lane: it reads files only');
    assert.equal(params.run_id, 'r1');
    assert.equal(params.simulation_id, SID);
    assert.equal(params.mesh_id, 'm1');
    assert.equal(params.time_dependency, 'Transient');
    // The run's own settings with the proposed ones over them; nothing saved.
    assert.equal(params.settings.max_co, 5);
    assert.equal(params.settings.n_outer_correctors, 3);
    assert.equal(params.settings.end_time, 10);
    // This PC: the run's Cores, the ranks cap, the median of its finished runs' rates.
    assert.equal(params.cores, 4);
    assert.equal(params.rank_cap, w27.precheckRankCap());
    assert.ok(Math.abs(params.s_per_cell_step - 2e-5) < 1e-15);
    assert.equal(params.rate_source, 'measured');
    // The answer carries what was merged in.
    assert.deepEqual(out.rate, { s_per_cell_step: params.s_per_cell_step, runs: 3, source: 'measured' });
    assert.equal(out.rank_cap, params.rank_cap);
    assert.equal(out.ranks, 4);
    assert.equal(out.settings.max_co, 5);
    assert.equal(out.time_dependency, 'Transient');
    // Without proposed values: the run's own.
    calls.length = 0;
    await w27.precheckRun(PID, 'r1', {}, SID);
    assert.equal(calls[0][1].settings.max_co, 100);
    // A run that is not there.
    const none = await w27.precheckRun(PID, 'nope', {}, SID);
    assert.equal(none.ok, false);
  });

  it("Python's ranks follow runRanks' rule (Cores, then the analysis's serial threshold, at most the cap)", () => {
    const cap = w27.precheckRankCap();
    const table = [
      [1_000, { cores: null, serial: 50_000, parallel: true, transient: true }],
      [625_221, { cores: null, serial: 50_000, parallel: true, transient: true }],
      [625_221, { cores: 4, serial: 50_000, parallel: true, transient: true }],
      [625_221, { cores: 1, serial: 50_000, parallel: true, transient: true }],
      [625_221, { cores: 999, serial: 50_000, parallel: true, transient: true }],
      [30_000, { cores: null, serial: 20_000, parallel: true, transient: true }],
      [625_221, { cores: 8, serial: 50_000, parallel: false, transient: true }],
      [150_000, { cores: null, serial: null, parallel: true, transient: false }],
    ];
    const code = [
      'import json, sys',
      'sys.path[:0] = ["python", "python/sdk"]',
      'from cfddesk.project.run_check import check_ranks',
      'cap = int(sys.argv[1])',
      'rows = json.loads(sys.argv[2])',
      'print(json.dumps([check_ranks(n, cores=o["cores"], rank_cap=cap, serial_below_cells=o["serial"], parallel=o["parallel"], transient=o["transient"]) for n, o in rows]))',
    ].join('\n');
    const r = spawnSync(PYTHON, ['-c', code, String(cap), JSON.stringify(table)], { cwd: WEB_ROOT, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const pyRanks = JSON.parse(r.stdout);
    const jsRanks = table.map(([n, o]) => w27.runRanks(n, { cores: o.cores, serialBelowCells: o.serial, parallel: o.parallel, transient: o.transient }));
    assert.deepEqual(pyRanks, jsRanks);
  });
});

describe('checks_kept: a free run key', () => {
  it('is a free key, never a solve one, so it never asks to overwrite a run with results', () => {
    assert.ok(FREE_KEYS.includes('checks_kept'));
    const stopped = { status: 'stopped', n_saved_times: 3, last_saved_iteration: 0.5, transient: { max_co: 100 }, time_dependency: 'Transient' };
    assert.deepEqual(solveChanged(stopped, { checks_kept: ['piso_high_co'] }), []);
    assert.ok(['free', 'continues', 'overwrite', 'draft', 'new_run', 'locked'].includes(runEditState(stopped)));
  });

  it('round-trips through run.update (the page and setup_edit post it there), cleaned, and leaves the solve settings alone', async () => {
    py.attachWorkerBridge(async () => ({ ok: true }));
    const r = await w27.updateRunSettings(PID, { run_id: 'r1', simulation_id: SID, checks_kept: ['piso_high_co', 'piso_high_co', 'Bad Code', 'still_start'] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.run.checks_kept, ['piso_high_co', 'still_start']);
    // As stored on the run (what the page and the Assistant read back).
    const back = await w27.updateRunSettings(PID, { run_id: 'r1', simulation_id: SID, name: 'Run_2' });
    assert.deepEqual(back.run.checks_kept, ['piso_high_co', 'still_start']);
    assert.equal(back.run.transient.max_co, 100);
    // [] keeps none.
    const cleared = await w27.updateRunSettings(PID, { run_id: 'r1', simulation_id: SID, checks_kept: [] });
    assert.deepEqual(cleared.run.checks_kept, []);
    assert.deepEqual(w27.cleanChecksKept(['a', 'a', '9x', ' long_run ', 42]), ['a', 'long_run']);
  });
});
