// H15: a core solve's drain and Stop of a run an earlier version left running (its
// doc has no runner_job_id): the doc writes the boot check's drain makes, the probe
// a read of such a doc starts (wsl-case-watch, never the old stop tool), and the
// ranks a core run gets (scripts/w27-solve.js runRanks, scripts/ranks.js).
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-drain-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';

const w27 = await import('../w27-solve.js');
const layout = await import('../project-layout.js');
const studyIo = await import('../study-io.js');
const watch = await import('../wsl-case-watch.js');
const { patchRunDocIfPresent, runDocStopRequested } = w27;

after(() => {
  watch.setCaseProcsSpawnForTests(null);
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

function seedRun(pid = 'proj-a', runId = 'run_1') {
  const dir = join(PROJECTS, pid);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'geometries'))) {
    const g = layout.createGeometryFolder(dir, { id: 'g1', name: 'G', original_filename: 'g.step' });
    layout.createStudyFolder(dir, 'g1', { id: 's1', name: 'Study 1' });
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: pid, title: pid, geometries: [{ id: g.id, name: g.name }], active_geometry_id: g.id }));
    writeFileSync(join(dir, 'simulations.json'), JSON.stringify({ active_id: 's1', simulations: [{ id: 's1', name: 'Study 1', geometry_id: g.id }] }));
  }
  return studyIo.persistRun(pid, 's1', { id: runId, run_id: runId, name: 'Run 1', simulation_id: 's1', status: 'running', wsl_case: `cfddesk-w27-${runId}` });
}

describe('run doc writes of a drain', () => {
  it('patchRunDocIfPresent merges into run.json and never creates a folder', () => {
    const run = seedRun('proj-a', 'run_1');
    const out = patchRunDocIfPresent('proj-a', 'run_1', { draining: true });
    assert.equal(out.draining, true);
    assert.equal(JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')).draining, true);
    assert.equal(JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')).name, 'Run 1');
    rmSync(run.dir, { recursive: true, force: true });
    assert.equal(patchRunDocIfPresent('proj-a', 'run_1', { draining: false }), null);
    assert.ok(!existsSync(run.dir), 'no folder made again');
    assert.equal(studyIo.runFolderOf('proj-a', 'run_1'), null, 'no run of that id anywhere');
    assert.equal(patchRunDocIfPresent('no-project', 'run_9', { x: 1 }), null);
    assert.ok(!existsSync(join(PROJECTS, 'no-project')));
  });

  it('runDocStopRequested: the doc says so; a deleted run counts as a stop; an unreadable doc does not', () => {
    const run = seedRun('proj-b', 'run_2');
    assert.equal(runDocStopRequested('proj-b', 'run_2'), false);
    patchRunDocIfPresent('proj-b', 'run_2', { stop_requested: true });
    assert.equal(runDocStopRequested('proj-b', 'run_2'), true);
    writeFileSync(join(run.dir, 'run.json'), '{not json');
    // findRun reads id.json; the doc itself is unreadable.
    assert.equal(runDocStopRequested('proj-b', 'run_2'), false);
    rmSync(run.dir, { recursive: true, force: true });
    assert.equal(runDocStopRequested('proj-b', 'run_2'), true);
  });
});

/** A wsl_case_procs.py probe that answers `state` ('live' or 'dead'). */
function probeChild(state) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.emit('data', JSON.stringify({ ok: true, live: state === 'live' }) + '\n');
    child.emit('close', 0);
  });
  return child;
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

describe('a run an earlier version left running (no runner record)', () => {
  it('a read probes its case copy with wsl_case_procs (never the old stop tool) and reaps it once a probe finds it gone', async () => {
    seedRun('proj-c', 'run_l');
    const calls = [];
    let state = 'live';
    watch.setCaseProcsSpawnForTests((cmd, args) => {
      calls.push(args.slice(1));
      return probeChild(state);
    });
    const status = () => (w27.getRunStatus('proj-c', 'run_l', 's1').body.runs.find((r) => r.id === 'run_l') || {}).status;
    try {
      assert.equal(status(), 'running');
      await settle();
      assert.deepEqual(calls, [['probe', '--wsl-case', 'cfddesk-w27-run_l', '--script', 'solve-run_l.sh']], 'one probe per read, by the case id and solve-<run>.sh');
      // Live: still running; the next read probes again.
      state = 'dead';
      assert.equal(status(), 'running');
      await settle();
      assert.equal(calls.length, 2);
      // Gone: reaped, written to its run.json.
      assert.equal(status(), 'failed');
      const doc = JSON.parse(readFileSync(join(studyIo.runFolderOf('proj-c', 'run_l').dir, 'run.json'), 'utf8'));
      assert.deepEqual([doc.status, doc.pid], ['failed', null]);
      assert.match(doc.note, /^Solver process is gone\./);
    } finally {
      watch.setCaseProcsSpawnForTests(null);
    }
  });
});

// ---- the ranks of a core run (runRanks: serial_below_cells, else the cap) ----

/** resolveNProcs as it was at c6ffe2f (HEAD before H15): the rule runRanks keeps. */
const OLD_RESOLVE = `function resolveNProcs(nCells, opts) {
  const n = Number(nCells) || 0;
  const threshold = opts && opts.transient ? TRANSIENT_LARGE_MESH_CELLS : LARGE_MESH_CELLS;
  if (n > 0 && n < threshold) return 1;
  const logical = Math.max(1, (cpus() || []).length);
  let nProcs;
  if (PHYSICAL_CORES >= 1) nProcs = Math.max(2, Math.min(PHYSICAL_CORES, logical));
  else nProcs = Math.max(2, logical >= 8 ? Math.floor(logical / 2) : logical);
  const hw = hardwarePrefs();
  const cap = hw && Number(hw.n_procs);
  if (Number.isFinite(cap) && cap >= 1) nProcs = Math.min(nProcs, Math.floor(cap));
  const savedSlots = hw && Number(hw.wsl_mpi_slots);
  const liveSlots = probeWslMpiSlots(WSL_DISTRO);
  const slots = liveSlots >= 1 ? liveSlots : Number.isFinite(savedSlots) && savedSlots >= 1 ? Math.floor(savedSlots) : 0;
  if (slots >= 1) nProcs = Math.min(nProcs, slots);
  return Math.max(1, nProcs);
}`;

const SRC = readFileSync(join(HERE, '..', 'w27-solve.js'), 'utf8').replace(/\r\n/g, '\n');
const RANKS = readFileSync(join(HERE, '..', 'ranks.js'), 'utf8').replace(/\r\n/g, '\n');

function fnSource(name, from) {
  const start = from.indexOf(name);
  assert.ok(start >= 0, name);
  return from.slice(start, from.indexOf('\n}\n', start) + 2).replace(/^export function/, 'function');
}

describe('runRanks', () => {
  it("gives the old resolveNProcs ranks (fake cpus and prefs; the relay clamps by WSL's own slots)", () => {
    assert.match(SRC, /const LEGACY_SERIAL_BELOW_CELLS = Object\.freeze\(\{ steady: 200000, transient: 50000 \}\);/);
    const runRanks = fnSource('export function runRanks(', SRC);
    const cap = fnSource('export function hardwareRankCap(', RANKS);
    const saved = fnSource('export function savedWslSlots(', RANKS);
    const coresSetting = fnSource('export function runCoresSetting(', RANKS);
    // runRanks asks WSL nothing: no probe, no synchronous spawn.
    assert.ok(!/probeWslMpiSlots|spawnSync|spawn\(/.test(runRanks + cap + saved));
    const oldFn = (env) =>
      new Function('env', `const { cpus, hardwarePrefs, probeWslMpiSlots, PHYSICAL_CORES } = env;
        const TRANSIENT_LARGE_MESH_CELLS = 50000, LARGE_MESH_CELLS = 200000, WSL_DISTRO = 'Ubuntu';
        ${OLD_RESOLVE}
        return resolveNProcs;`)(env);
    const newFn = (env) =>
      new Function('env', `const { cpus, hardwarePrefs, PHYSICAL_CORES } = env;
        const LEGACY_SERIAL_BELOW_CELLS = Object.freeze({ steady: 200000, transient: 50000 });
        ${cap}
        ${saved}
        ${coresSetting}
        ${runRanks}
        return runRanks;`)(env);
    let checked = 0;
    for (const logical of [1, 2, 4, 8, 16, 32]) {
      for (const physical of [0, 1, 4, 16]) {
        for (const hw of [null, { n_procs: 3 }, { n_procs: 0 }, { wsl_mpi_slots: 6 }, { n_procs: 12, wsl_mpi_slots: 4 }]) {
          for (const cells of [0, 1000, 60000, 300000]) {
            for (const transient of [false, true]) {
              const env = { cpus: () => new Array(logical).fill({}), hardwarePrefs: () => hw, probeWslMpiSlots: () => 0, PHYSICAL_CORES: physical };
              const want = oldFn(env)(cells, { transient });
              const why = JSON.stringify({ logical, physical, hw, cells, transient });
              // An analysis that declares no serial_below_cells (before API 1.5): the old rule.
              assert.equal(newFn(env)(cells, { transient }), want, why);
              assert.equal(newFn(env)(cells, { transient, serialBelowCells: null }), want, why);
              // A run whose Cores is Auto (unset) keeps it.
              assert.equal(newFn(env)(cells, { transient, cores: null }), want, why);
              assert.equal(newFn(env)(cells, { transient, cores: undefined }), want, why);
              // Incompressible Flow declares the same numbers.
              assert.equal(newFn(env)(cells, { transient, serialBelowCells: transient ? 50000 : 200000, parallel: true }), want, why);
              // Its own number wins; a launch that is not parallel is serial.
              assert.equal(newFn(env)(cells, { transient, serialBelowCells: 0 }), oldFn(env)(0, { transient }), why);
              assert.equal(newFn(env)(cells, { transient, parallel: false }), 1, why);
              checked += 1;
            }
          }
        }
      }
    }
    assert.ok(checked > 900);
  });

  it('is the rule Start uses', () => {
    const start = SRC.indexOf('async function startSolveOnRunner(');
    const body = SRC.slice(start, SRC.indexOf('\n}\n', start));
    assert.match(
      body,
      /const nProcs = runRanks\(ready\.mesh\.n_cells, \{\s*transient: isTransient,\s*serialBelowCells: plan\.serial_below_cells,\s*parallel: launch\.parallel,\s*cores: draft && draft\.cores,\s*\}\);/,
    );
    assert.equal(w27.runRanks(1000, { transient: false }), 1);
    assert.ok(w27.runRanks(300000, { transient: false }) >= 1);
  });
});
