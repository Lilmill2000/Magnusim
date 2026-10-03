// IF Item 7: a core study's solve on the step-list runner (runner kind 'solve').
// The real Start (w27-solve.js startSolve), runner (foam-runner.js) and core-solve.js,
// with the runner's outside calls faked (no relay is started, no WSL is reached) and a
// stand-in worker (validate_ready, run_normalize, analysis.plan_run):
//   - Start plans the run on the worker and hands it to the runner: the record, the spec
//     and the run doc carry the run, its study, its analysis and its prepare job; the
//     Start's claim is the run's;
//   - a plan that fails or is not ready marks the run failed with prepare_run's texts and
//     its analysis's fix, and nothing runs; a Stop while it is planned leaves it as it was;
//   - frames make the run doc's stage, residuals (each step's last initial residual),
//     Courant number, Δt, saved frames and ranks;
//   - each end (done, stopped, failed, lost with and without frames) makes the status and
//     the note the old run path wrote, calls the Start's onDone and frees the slot;
//   - a doc that says running when its record has ended is written as ended on read.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-core-solve-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const w27 = await import('../w27-solve.js');
const runner = await import('../foam-runner.js');
const store = await import('../foam-store.js');
const slot = await import('../compute-slot.js');
const queue = await import('../server/compute-queue.ts');
const layout = await import('../project-layout.js');
const io = await import('../study-io.js');
const core = await import('../core-solve.js');
const hooks = await import('../solve-hooks.js');
const { attachWorkerBridge } = await import('../py-json.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PID = 'p1';
const SID = 's1';
const MID = 'm1';
const FRAME_WAIT = 320; // one progress frame per 250 ms

after(() => {
  runner.resetFoamRunnerForTests();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

/** @type {any} */
let fx;

function seedProject() {
  const dir = join(PROJECTS, PID);
  if (existsSync(join(dir, 'project.json'))) return dir;
  mkdirSync(dir, { recursive: true });
  const g = layout.createGeometryFolder(dir, { id: 'g1', name: 'Part' });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: PID, title: 'P1', geometries: [{ id: g.id, name: g.name }], active_geometry_id: g.id }));
  layout.createStudyFolder(dir, g.id, { id: SID, name: 'Study 1' });
  writeFileSync(join(dir, 'simulations.json'), JSON.stringify({ active_id: SID, simulations: [{ id: SID, name: 'Study 1', geometry_id: g.id }] }));
  io.persistOneMeshAt(dir, SID, { id: MID, name: 'Mesh 1', simulation_id: SID });
  const meshDir = io.meshFolderOf(PID, MID, SID).dir;
  const caseDir = join(meshDir, 'case');
  const poly = join(caseDir, 'constant', 'polyMesh');
  mkdirSync(poly, { recursive: true });
  for (const name of ['points', 'faces', 'owner', 'neighbour', 'boundary']) writeFileSync(join(poly, name), `${name}\n`);
  io.persistOneMeshAt(dir, SID, { id: MID, name: 'Mesh 1', simulation_id: SID, case_dir: caseDir, live_mesh_result: { status: 'done', case_dir: caseDir, n_cells: 8, n_points: 27 } });
  return dir;
}

let serial = 0;
function draftRun(extra = {}) {
  serial += 1;
  const rid = `r${serial}`;
  io.persistRun(PID, SID, { id: rid, run_id: rid, name: `Run ${serial}`, simulation_id: SID, mesh_id: MID, status: 'draft', time_dependency: 'Steady-state', endTime: 100, writeInterval: 50, ...extra });
  return rid;
}

const runDoc = (rid) => JSON.parse(readFileSync(join(io.runFolderOf(PID, rid, SID).dir, 'run.json'), 'utf8'));
const caseOf = (rid) => join(io.runFolderOf(PID, rid, SID).dir, 'case');

function planAnswer(over = {}) {
  return {
    ok: true,
    analysis_key: 'incompressible_steady',
    plugin: 'incompressible_flow',
    app: 'simpleFoam',
    time_dependency: 'Steady-state',
    launch: {
      app: 'simpleFoam',
      keep_frames: 'latest',
      process_names: ['simpleFoam'],
      stop_strategy: 'stopAt_writeNow',
      parallel: true,
      log_parser: { module: 'incompressible_flow.parser', name: 'IncompressibleParser' },
      frame_fields: ['U', 'p'],
      kinematic_fields: ['p'],
      serial_below_cells: 200000,
      prepare_job: 'incompressible_flow.write_run_case',
    },
    prepare_job: 'incompressible_flow.write_run_case',
    serial_below_cells: 200000,
    plan: { ok: true, run_id: 'x', solver: 'simpleFoam', bcs: [{ name: 'Inlet', patch: 'inlet' }], wall_default: 'No-slip', note_detail: '', physics_label: 'k-omega SST', algorithm: 'SIMPLE' },
    prepare: {
      key: 'incompressible_flow.write_run_case',
      tool: 'incompressible_flow/jobs/write_run_case.py',
      scope: 'study',
      args_from_params: ['run_id', 'mesh_id', 'time_dependency', 'n_procs', 'transient'],
      plugin: 'incompressible_flow',
      tool_path: 'C:/plugins/incompressible_flow/incompressible_flow/jobs/write_run_case.py',
      runtime: 'core',
      python: null,
      cwd: null,
    },
    ...over,
  };
}

beforeEach(() => {
  seedProject();
  rmSync(join(ROOT, 'foam-cases.json'), { force: true });
  slot.resetComputeSlotForTests();
  queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {} });
  store.resetFoamStoreForTests({ filePath: join(ROOT, 'foam-cases.json') });
  runner.resetFoamRunnerForTests();
  core.resetCoreSolvesForTests();
  hooks.setSolveHookNamesForTests([]);
  // What resetFoamRunnerForTests dropped: the kinds registered at import.
  runner.registerStepRunKind('solve', { onEvent: core.onCoreSolveEvent, onEnd: core.onCoreSolveEnd });
  fx = { spawned: [], watches: [], kills: [], plans: [], plan: () => planAnswer(), planGate: null };
  runner.setFoamRunnerDepsForTests({
    spawnJob: (opts) => {
      fx.spawned.push(opts);
      return { child: { pid: 4242 }, jobLog: { path: join(ROOT, 'logs', `${opts.jobId}.jsonl`) } };
    },
    watchWslCaseGone: (opts) => {
      fx.watches.push(opts);
      return { cancel() {} };
    },
    killWslCase: (opts) => fx.kills.push(opts),
    probeWslCase: async () => 'dead',
    relayAlive: async () => true,
    killRelay: () => {},
    pushComputeNotice: () => {},
    slotsHint: () => null,
    hookNames: () => [],
    specDir: () => join(ROOT, 'foam-specs'),
  });
  attachWorkerBridge(async (method, params) => {
    if (method === 'analysis.validate_ready') return { ready: true, issues: [] };
    if (method === 'analysis.run_normalize') return { settings: { end_time: 100, write_interval: 50, ...(params && params.settings) } };
    if (method === 'analysis.plan_run') {
      fx.plans.push(params);
      if (fx.planGate) await fx.planGate;
      return fx.plan(params);
    }
    return { ok: true };
  });
});

afterEach(() => {
  // A run a test left running ends here (its doc is written stopped), so the next test's reads see none.
  for (const rec of store.listFoamRecords({ status: ['queued', 'running'] })) runner.finishFoam(rec.id, 'stopped', {});
  runner.setFoamRunnerDepsForTests(null);
  w27.invalidateLiveSolveCache();
});

async function start(rid, extra = {}) {
  const done = [];
  const out = await w27.startSolve({ projectId: PID, runId: rid, simulationId: SID, onDone: (r) => done.push(r), ...extra });
  return { out, done };
}

/** The relay's events for one simpleFoam step as its log parser sends them. */
function step(t, { p = [0.5, 0.2], ux = 0.3, co = null } = {}) {
  const evs = [];
  if (co) evs.push({ event: 'courant', mean: co.mean, max: co.max }, ...(co.dt ? [{ event: 'courant', delta_t: co.dt }] : []));
  evs.push({ event: 'progress', time: t });
  evs.push({ event: 'residual', field: 'Ux', initial: ux });
  for (const v of p) evs.push({ event: 'residual', field: 'p', initial: v });
  return evs;
}

function relay(evs) {
  const onEvent = fx.spawned[fx.spawned.length - 1].onEvent;
  for (const ev of evs) onEvent(ev);
}

function writeStatus(rid, doc) {
  writeFileSync(join(caseOf(rid), '.magnusim-run.json'), JSON.stringify(doc));
}

function saveFrame(rid, t) {
  const d = join(caseOf(rid), String(t));
  mkdirSync(d, { recursive: true });
  for (const f of ['U', 'p']) writeFileSync(join(d, f), 'x');
}

describe('Start hands a core solve to the runner', () => {
  it('plans on the worker; the record, spec, claim and run doc name the run, its study, analysis and prepare job', async () => {
    const rid = draftRun();
    const { out } = await start(rid);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(out.status, 202);
    assert.deepEqual(fx.plans.map((p) => [p.project_id, p.simulation_id, p.run_id, p.mesh_id, p.time_dependency]), [[PID, SID, rid, MID, 'Steady-state']]);
    const job = out.bodyExtra.runner_job_id;
    assert.match(job, /^fc-/);
    const rec = store.readFoamRecord(job);
    assert.deepEqual(
      [rec.kind, rec.status, rec.run_id, rec.run_name, rec.simulation_id, rec.plugin, rec.app, rec.wsl_case, rec.case_dir, rec.prepare.job],
      ['solve', 'running', rid, 'Run 1', SID, 'incompressible_flow', 'simpleFoam', `cfddesk-w27-${rid}`, caseOf(rid), 'incompressible_flow.write_run_case'],
    );
    assert.match(rec.token, /^[0-9a-f]{8}$/);
    // The spec the relay reads.
    const spec = JSON.parse(readFileSync(join(ROOT, 'foam-specs', `${job}.json`), 'utf8'));
    assert.deepEqual([spec.kind, spec.run_id, spec.simulation_id, spec.case_parts, spec.solver.analysis, spec.solver.parallel, spec.n_procs], ['solve', rid, SID, ['case'], 'incompressible_steady', 'mpirun', 1]);
    assert.deepEqual(spec.prepare.args, ['--run-id', rid, '--mesh-id', MID, '--time-dependency', 'Steady-state', '--n-procs', '1']);
    assert.equal(spec.prepare.env.MAGNUSIM_CASE_DIR, caseOf(rid));
    assert.equal(spec.prepare.env.MAGNUSIM_SIMULATION_ID, SID);
    assert.equal(spec.prepare.env.MAGNUSIM_JOB_ID, job);
    assert.equal(fx.spawned.length, 1);
    assert.match(fx.spawned[0].script, /run_foam_case\.py$/);
    // The Start's claim is the run's now.
    const h = slot.computeSlotHolder();
    assert.deepEqual([h.kind, h.phase, h.run_id, h.job_id, h.name], ['solve', 'running', rid, job, 'Run 1']);
    // The run doc.
    const doc = runDoc(rid);
    assert.deepEqual(
      [doc.status, doc.runner_job_id, doc.solve_protocol, doc.pid, doc.wsl_case, doc.path_kind, doc.analysis_key, doc.n_procs],
      ['running', job, 'runner', null, `cfddesk-w27-${rid}`, 'simpleFoam', 'incompressible_steady', 1],
    );
    assert.match(doc.wsl_case_path, new RegExp(`/cfddesk-w27-${rid}$`));
    assert.match(doc.note, /^simpleFoam serial — (.+ \/ )?k-omega SST \/ SIMPLE$/);
    assert.match(doc.log_jsonl_path, new RegExp(`${job}\\.jsonl$`));
    assert.deepEqual(doc.bcs, [{ name: 'Inlet', patch: 'inlet' }]);
    assert.equal(doc.prepare_run.app, 'simpleFoam');
    // Delete waits for the run to end.
    assert.match(String((await w27.deleteCatalogRun(PID, rid, SID)).error), /Stop the run before deleting it/);
  });

  it('a big mesh runs on every rank the PC offers (serial_below_cells)', async () => {
    const rid = draftRun();
    fx.plan = () => planAnswer({ serial_below_cells: 4 });
    const { out } = await start(rid);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    const spec = JSON.parse(readFileSync(join(ROOT, 'foam-specs', `${out.bodyExtra.runner_job_id}.json`), 'utf8'));
    assert.equal(spec.n_procs, (await import('../ranks.js')).hardwareRankCap());
    assert.match(runDoc(rid).note, /^simpleFoam (\d+ ranks|serial)/);
  });

  it('a not-ready plan: the run is failed with the analysis text and fix, nothing runs, the slot is free', async () => {
    const rid = draftRun();
    fx.plan = () => ({ ok: false, not_ready: true, error: 'Set the inlet velocity', fix: { go: 'bcs' }, patches: [{ op: 'x' }] });
    const { out } = await start(rid);
    assert.deepEqual([out.ok, out.status, out.bodyExtra.error], [false, 500, 'Failed to prepare solve case: Set the inlet velocity']);
    assert.deepEqual(out.bodyExtra.fix, { go: 'bcs' });
    assert.deepEqual(out.bodyExtra.patches, [{ op: 'x' }]);
    const doc = runDoc(rid);
    assert.deepEqual([doc.status, doc.note, doc.error], ['failed', 'Failed to prepare solve case: Set the inlet velocity', 'Failed to prepare solve case: Set the inlet velocity']);
    assert.deepEqual(doc.fix, { go: 'bcs' });
    assert.equal(fx.spawned.length, 0);
    assert.deepEqual(store.listFoamRecords(), []);
    assert.equal(slot.computeSlotHolder(), null);
  });

  it('a plan for the other time dependency is refused with today’s text', async () => {
    const rid = draftRun();
    fx.plan = () => planAnswer({ time_dependency: 'Transient', app: 'pimpleFoam' });
    const { out } = await start(rid);
    assert.equal(out.bodyExtra.error, 'The case was written for a Transient run (pimpleFoam), but this run is Steady-state.');
    assert.equal(runDoc(rid).status, 'failed');
    assert.equal(fx.spawned.length, 0);
  });

  it('a Stop while the run is planned: "Stopped before it started", the run as it was, no record', async () => {
    const rid = draftRun();
    let open;
    fx.planGate = new Promise((r) => (open = r));
    const started = start(rid);
    for (let i = 0; i < 400 && !fx.plans.length; i += 1) await sleep(5);
    assert.equal(fx.plans.length, 1, 'the plan was asked for');
    const stop = w27.stopSolve({ projectId: PID, runId: rid });
    assert.equal(stop.bodyExtra.cancelled, true);
    open();
    const { out } = await started;
    assert.deepEqual([out.status, out.bodyExtra.code], [409, 'stopped']);
    assert.equal(runDoc(rid).status, 'draft');
    assert.equal(fx.spawned.length, 0);
    assert.deepEqual(store.listFoamRecords(), []);
    assert.equal(slot.computeSlotHolder(), null);
  });
});

describe('frames make the run doc', () => {
  it('stage, residuals (the last of a step), Courant number and Δt of the step on, saved frames and ranks', async () => {
    const rid = draftRun();
    const { out } = await start(rid);
    const job = out.bodyExtra.runner_job_id;
    const run = () => w27.getRunStatus(PID, rid, SID).body.run;
    relay([{ event: 'stage', stage: 'prepare' }]);
    console.log('DBG', JSON.stringify({ disk: runDoc(rid).has_results, run: w27.getRunStatus(PID, rid, SID).body.run.has_results, n: w27.getRunStatus(PID, rid, SID).body.run.n_saved_times, row: w27.getRunStatus(PID, rid, SID).body.runs.find((r) => r.id === rid).has_results }));
    assert.equal(run().stage, 'prepare');
    relay([{ event: 'stage', stage: 'copy_to_wsl' }]);
    assert.equal(run().stage, 'copy');
    relay([{ event: 'ranks', n_procs: 2 }]);
    assert.equal(runDoc(rid).n_procs, 2);
    assert.match(runDoc(rid).note, /^simpleFoam 2 ranks — /);
    relay([{ event: 'stage', stage: 'solve' }]);
    relay([
      ...step(1, { p: [0.5, 0.2], co: { mean: 0.11, max: 0.5, dt: 0.001 } }),
      ...step(2, { p: [0.4, 0.1], co: { mean: 0.12, max: 0.6, dt: 0.002 } }),
      ...step(3, { p: [0.3, 0.05], co: { mean: 0.13, max: 0.7, dt: 0.003 } }),
    ]);
    await sleep(FRAME_WAIT);
    // A frame went out (step 3 still open): its residuals are each field's last of the step.
    relay(step(4, { p: [0.2, 0.01], co: { mean: 0.14, max: 0.8, dt: 0.004 } }));
    await sleep(FRAME_WAIT);
    const r = run();
    assert.equal(r.stage, 'solve');
    assert.equal(r.iteration, 4, 'the step the solver is on');
    assert.equal(r.n_steps, 4);
    assert.deepEqual([r.co_mean, r.co_max, r.delta_t], [0.14, 0.8, 0.004], "the open step's Courant block (printed before its Time line)");
    const byT = Object.fromEntries(r.residuals.map((row) => [row.t, row]));
    assert.equal(byT[1].p, 0.2, 'the last p residual of step 1, not the largest');
    assert.equal(byT[2].p, 0.1);
    assert.equal(byT[3].p, 0.05);
    // A saved frame: the doc's counts.
    saveFrame(rid, 50);
    relay([{ event: 'time_saved', t: 50 }]);
    const doc = runDoc(rid);
    assert.deepEqual([doc.has_results, doc.n_saved_times, doc.last_saved_iteration, doc.stage], [true, 1, 50, 'solve']);
    // Home's card reads the live step.
    const summary = w27.projectSolveSummary(PID);
    assert.deepEqual([summary.simulating, summary.iteration], [true, 4]);
    // Draining and stopping keep the stage shown.
    relay([{ event: 'stage', stage: 'reconstruct' }]);
    assert.equal(run().stage, 'reconstruct');
    assert.equal(store.readFoamRecord(job).status, 'running');
  });
});

describe('the end', () => {
  /** Start a run, solve two steps (a frame saved at 50 when `frames`), then end it as `how`. */
  async function endAs(how, { frames = true } = {}) {
    const rid = draftRun();
    const { out, done } = await start(rid);
    const job = out.bodyExtra.runner_job_id;
    relay([{ event: 'stage', stage: 'solve' }, ...step(1), ...step(2)]);
    if (frames) {
      saveFrame(rid, 50);
      relay([{ event: 'time_saved', t: 50 }]);
    }
    writeFileSync(join(caseOf(rid), 'log.simpleFoam'), 'Time = 1\nTime = 2\nEnd\n');
    const spawn = fx.spawned[fx.spawned.length - 1];
    if (how === 'stopped') {
      const s = w27.stopSolve({ projectId: PID, runId: rid });
      assert.equal(s.bodyExtra.stopping, true);
      assert.equal(store.readFoamRecord(job).stop.level, 'graceful');
    }
    if (how === 'lost') {
      writeStatus(rid, { wsl_reached: true, stage: 'solve' });
      spawn.onExit(0);
      spawn.onClose();
      const w = fx.watches[fx.watches.length - 1];
      w.onGone();
      w.release();
    } else {
      const outcome =
        how === 'done'
          ? { ok: true, phase: 'solve', exit_code: 0 }
          : how === 'stopped'
            ? { ok: false, phase: 'solve', stopped: true, exit_code: 0 }
            : { ok: false, phase: 'solve', exit_code: 1 };
      writeStatus(rid, { outcome, clean: true, exit_code: outcome.exit_code, n_procs: 1 });
      spawn.onExit(0);
      spawn.onClose();
    }
    return { rid, job, done, doc: runDoc(rid) };
  }

  const table = [
    ['done', {}, 'done', 'simpleFoam finished. Results are in the run folder.', null],
    ['stopped', {}, 'stopped', 'Run stopped. Results up to iteration 50 are available.', null],
    ['stopped', { frames: false }, 'stopped', 'Run stopped before the first saved iteration.', null],
    ['failed', {}, 'failed', 'simpleFoam failed (exit 1).', null],
    [
      'lost',
      {},
      'stopped',
      'The app lost track of this case while it ran. Results saved before then are in the case folder.',
      'The app lost track of this case while it ran. Results saved before then are in the case folder',
    ],
    [
      'lost',
      { frames: false },
      'failed',
      'The app lost track of this case while it ran. Results saved before then are in the case folder.',
      'The app lost track of this case while it ran. Results saved before then are in the case folder',
    ],
  ];
  for (const [how, opts, status, note, error] of table) {
    it(`${how}${opts.frames === false ? ' (no frame saved)' : ''} → ${status}: "${note}"`, async () => {
      const { rid, done, doc } = await endAs(how, opts);
      assert.deepEqual([doc.status, doc.note, doc.error ?? null], [status, note, error]);
      assert.equal(doc.pid, null);
      assert.equal(doc.has_results, opts.frames !== false);
      assert.ok(doc.residuals.length >= 1, 'the residuals the run plotted are kept');
      assert.match(String(doc.log_excerpt), /End\n$/, "the tail of the solver's log");
      assert.equal(slot.computeSlotHolder(), null, 'the slot is free');
      assert.deepEqual(done.map((d) => [d.status, d.run_id]), [[status, rid]]);
      assert.equal(core.liveSolveOf(doc.runner_job_id), null);
      // Now it can be deleted.
      assert.equal((await w27.deleteCatalogRun(PID, rid, SID)).ok, true);
    });
  }

  it('a run started again shows none of its last attempt: no steps, residuals, Courant number or relay files', async () => {
    const { rid, doc } = await endAs('stopped');
    assert.ok(doc.residuals.length && doc.iteration > 0, 'the last attempt left progress');
    w27.patchRunDocIfPresent(PID, rid, { co_mean: 0.4, co_max: 0.9, delta_t: 0.01 });
    assert.ok(existsSync(join(caseOf(rid), '.magnusim-run.json')));
    writeFileSync(join(caseOf(rid), '.magnusim-ran'), JSON.stringify({ job_id: doc.runner_job_id, token: 'old00000' }));
    const before = fx.spawned.length;
    const { out } = await start(rid);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(fx.spawned.length, before + 1);
    // The relay files of the last attempt were gone before this one was spawned.
    assert.equal(existsSync(join(caseOf(rid), '.magnusim-run.json')), false);
    assert.equal(existsSync(join(caseOf(rid), '.magnusim-ran')), false);
    const disk = runDoc(rid);
    assert.deepEqual(
      [disk.iteration, disk.sim_time, disk.n_steps, disk.residuals, disk.co_mean, disk.co_max, disk.delta_t, disk.solve_started_at, disk.has_results],
      [0, 0, 0, [], null, null, null, null, false],
    );
    const row = w27.getRunStatus(PID, rid, SID).body.runs.find((r) => r.id === rid);
    assert.deepEqual([row.status, row.iteration], ['running', 0]);
    const run = w27.getRunStatus(PID, rid, SID).body.run;
    assert.deepEqual([run.iteration, run.residuals, run.co_mean, run.co_max, run.delta_t], [0, [], undefined, undefined, undefined]);
    // While its case is written the last attempt's frames are not this one's; the prepare step removes them.
    relay([{ event: 'stage', stage: 'prepare' }]);
    const writing = w27.getRunStatus(PID, rid, SID).body.run;
    assert.deepEqual([writing.stage, writing.iteration, writing.has_results], ['prepare', 0, false]);
    assert.equal(runDoc(rid).has_results, false, 'nothing of the last attempt was written back');
    rmSync(join(caseOf(rid), '50'), { recursive: true, force: true });
    // Its own progress shows once it reports.
    relay([{ event: 'stage', stage: 'solve' }, ...step(1, { co: { mean: 0.2, max: 0.3, dt: 0.005 } }), ...step(2)]);
    await sleep(FRAME_WAIT);
    const now = w27.getRunStatus(PID, rid, SID).body.run;
    assert.deepEqual([now.stage, now.iteration, now.co_mean], ['solve', 2, 0.2]);
  });

  it('a doc still running when its record ended (the server stopped between the writes) reads as ended', async () => {
    const { rid, doc } = await endAs('done');
    w27.patchRunDocIfPresent(PID, rid, { status: 'running', note: 'simpleFoam serial' });
    const shown = w27.getRunStatus(PID, rid, SID).body.run;
    assert.equal(shown.status, 'done');
    assert.equal(runDoc(rid).status, 'done', 'and written so');
    assert.equal(runDoc(rid).note, doc.note);
  });

  it('a record the store no longer has: the old probe decides (no spawn here, the doc is left)', async () => {
    const rid = draftRun({ status: 'running', runner_job_id: 'fc-gone00-000000', wsl_case: '' });
    const shown = w27.getRunStatus(PID, rid, SID).body.run;
    assert.notEqual(shown.status, 'running', 'no record, no pid, no WSL case: reaped');
  });
});
