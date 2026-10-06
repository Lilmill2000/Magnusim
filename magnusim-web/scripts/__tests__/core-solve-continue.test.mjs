// F6: Continue a finished or stopped core run (w27-solve.js continueSolve) on the real
// runner (foam-runner.js) and core-solve.js, the runner's outside calls faked (no relay,
// no WSL) and a stand-in worker, as core-solve-runner.test.mjs does:
//   - the restart flag reaches the relay's spec (solver.restart) and the case writer
//     (the prepare job's --restart {end_time, write_interval});
//   - the run keeps its frames, residuals, steps, log parts and attempt history; its
//     new steps count on from the old total and its residuals are continuous;
//   - a plain Start of a finished run still says it finished; a Continue that cannot
//     start (no saved result, a writer that cannot continue, bad input) leaves the run
//     as it ended.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-core-continue-'));
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
      args_from_params: ['run_id', 'mesh_id', 'time_dependency', 'n_procs', 'transient', 'restart'],
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

async function cont(rid, extra = {}) {
  const done = [];
  const out = await w27.continueSolve({ projectId: PID, runId: rid, simulationId: SID, onDone: (r) => done.push(r), ...extra });
  return { out, done };
}

const specOf = (job) => JSON.parse(readFileSync(join(ROOT, 'foam-specs', `${job}.json`), 'utf8'));
const argOf = (spec, name) => {
  const i = spec.prepare.args.indexOf(name);
  return i >= 0 ? spec.prepare.args[i + 1] : undefined;
};

/** End the latest spawned run as `how` (its relay's final status). */
function endRun(rid, how = 'done') {
  const outcome =
    how === 'done'
      ? { ok: true, phase: 'solve', exit_code: 0 }
      : how === 'stopped'
        ? { ok: false, phase: 'solve', stopped: true, exit_code: 0 }
        : { ok: false, phase: 'solve', exit_code: 1 };
  if (how === 'stopped') w27.stopSolve({ projectId: PID, runId: rid });
  writeStatus(rid, { outcome, clean: true, exit_code: outcome.exit_code, n_procs: 1 });
  const spawn = fx.spawned[fx.spawned.length - 1];
  spawn.onExit(0);
  spawn.onClose();
}

/** A steady run solved to iteration 100 (steps 99 and 100; frames 50 and 100), ended as `how`. */
async function solvedRun(how = 'done') {
  const rid = draftRun();
  const { out } = await start(rid);
  assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
  relay([{ event: 'stage', stage: 'solve' }, ...step(99, { p: [0.5, 0.4] }), ...step(100, { p: [0.3, 0.2] })]);
  await sleep(FRAME_WAIT);
  for (const t of [50, 100]) {
    saveFrame(rid, t);
    relay([{ event: 'time_saved', t }]);
  }
  endRun(rid, how);
  return rid;
}

describe('Continue (F6)', () => {
  it('a finished run continues from its last saved result: restart in the spec and the prepare job, its progress kept and counted on', async () => {
    const rid = await solvedRun('done');
    const ended = runDoc(rid);
    assert.deepEqual([ended.status, ended.n_steps, ended.last_saved_iteration], ['done', 2, 100]);
    // Start still says it finished: Continue is its own action.
    const again = await start(rid);
    assert.deepEqual([again.out.status, again.out.bodyExtra.error], [409, 'This run already finished. Create a new run to solve again.']);
    // The panel is told where Continue starts from.
    assert.equal(w27.getRunStatus(PID, rid, SID).body.run.continue_from, 100);

    const before = fx.spawned.length;
    const { out } = await cont(rid, { extraIterations: 50 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(fx.spawned.length, before + 1);
    const job = out.bodyExtra.runner_job_id;
    assert.notEqual(job, ended.runner_job_id);
    // The flag reaches the relay's spec, and the case writer is told how far.
    const spec = specOf(job);
    assert.equal(spec.solver.restart, true);
    assert.deepEqual(JSON.parse(argOf(spec, '--restart')), { end_time: 150, write_interval: 50 });
    assert.equal(store.readFoamRecord(job).restart, true);
    // Nothing of the run so far was removed; its doc keeps it.
    assert.ok(existsSync(join(caseOf(rid), '50', 'U')) && existsSync(join(caseOf(rid), '100', 'U')));
    const doc = runDoc(rid);
    assert.deepEqual(
      [doc.status, doc.stage, doc.has_results, doc.n_saved_times, doc.last_saved_iteration, doc.iteration, doc.n_steps, doc.endTime, doc.error, doc.finished_at],
      ['running', 'starting', true, 2, 100, 100, 2, 150, null, null],
    );
    assert.deepEqual(doc.residuals.map((r) => r.t), [99, 100]);
    assert.deepEqual([doc.continued.from_time, doc.continued.steps_before], [100, 2]);
    assert.deepEqual(doc.continued.log_paths, [ended.log_path]);
    assert.equal(doc.attempts.length, 1);
    assert.deepEqual([doc.attempts[0].status, doc.attempts[0].runner_job_id, doc.attempts[0].end_time], ['done', ended.runner_job_id, 100]);
    // The study's own settings stay as they were.
    assert.notEqual(w27.getSimulationControl(PID, SID).endTime, 150);

    // While its case is written its frames are still shown.
    relay([{ event: 'stage', stage: 'prepare' }]);
    let run = w27.getRunStatus(PID, rid, SID).body.run;
    assert.deepEqual([run.has_results, run.n_saved_times, run.n_steps], [true, 2, 2]);
    // Its own steps: counted on from 2 (the relay counts from 0), residuals continuous.
    relay([{ event: 'stage', stage: 'solve' }, ...step(101, { p: [0.2, 0.1] }), ...step(102, { p: [0.1, 0.05] }), ...step(103)]);
    await sleep(FRAME_WAIT);
    run = w27.getRunStatus(PID, rid, SID).body.run;
    assert.deepEqual([run.iteration, run.n_steps], [103, 5]);
    assert.deepEqual(run.residuals.map((r) => r.t).slice(0, 4), [99, 100, 101, 102]);
    saveFrame(rid, 150);
    relay([{ event: 'time_saved', t: 150 }]);
    assert.deepEqual([runDoc(rid).n_saved_times, runDoc(rid).last_saved_iteration], [3, 150]);

    endRun(rid, 'done');
    const fin = runDoc(rid);
    assert.deepEqual([fin.status, fin.n_steps, fin.n_saved_times, fin.last_saved_iteration], ['done', 5, 3, 150]);
    assert.deepEqual(fin.residuals.map((r) => r.t), [99, 100, 101, 102, 103]);
    assert.equal(fin.attempts.length, 1);
    assert.equal(fin.continued.from_time, 100);
    assert.equal(slot.computeSlotHolder(), null, 'the slot is free');
    // Read back after the end (the job log of this attempt only): still the whole run.
    const shown = w27.getRunStatus(PID, rid, SID).body.run;
    assert.equal(shown.n_steps, 5);
    assert.deepEqual(shown.residuals.map((r) => r.t).slice(0, 2), [99, 100]);
  });

  it('a stopped run continues too; a second continue keeps every part', async () => {
    const rid = await solvedRun('stopped');
    assert.equal(runDoc(rid).status, 'stopped');
    let { out } = await cont(rid, { extraIterations: 20 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    relay([{ event: 'stage', stage: 'solve' }, ...step(101), ...step(102)]);
    await sleep(FRAME_WAIT);
    saveFrame(rid, 120);
    relay([{ event: 'time_saved', t: 120 }]);
    endRun(rid, 'done');
    const first = runDoc(rid);
    assert.equal(first.n_steps, 4);
    ({ out } = await cont(rid, { extraIterations: 30 }));
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.deepEqual(JSON.parse(argOf(specOf(out.bodyExtra.runner_job_id), '--restart')), { end_time: 150, write_interval: 50 });
    const doc = runDoc(rid);
    assert.deepEqual([doc.continued.from_time, doc.continued.steps_before, doc.attempts.map((a) => a.status)], [120, 4, ['stopped', 'done']]);
    assert.equal(doc.continued.log_paths.length, 2);
    assert.ok(doc.continued.elapsed_before_s >= 0);
    relay([{ event: 'stage', stage: 'solve' }, ...step(121)]);
    await sleep(FRAME_WAIT);
    endRun(rid, 'done');
    const fin = runDoc(rid);
    assert.equal(fin.n_steps, 5);
    assert.deepEqual(fin.residuals.map((r) => r.t), [99, 100, 101, 102, 121]);
  });

  it('a continued run that stopped and is started from the beginning is a fresh run: no restart, its parts dropped', async () => {
    const rid = await solvedRun('stopped');
    const { out } = await cont(rid, { extraIterations: 20 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    relay([{ event: 'stage', stage: 'solve' }, ...step(101)]);
    await sleep(FRAME_WAIT);
    endRun(rid, 'stopped');
    assert.equal(runDoc(rid).status, 'stopped');
    assert.ok(runDoc(rid).continued);
    const again = await start(rid);
    assert.equal(again.out.ok, true, JSON.stringify(again.out.bodyExtra));
    const spec = specOf(again.out.bodyExtra.runner_job_id);
    assert.equal('restart' in spec.solver, false);
    assert.equal(argOf(spec, '--restart'), undefined);
    const doc = runDoc(rid);
    assert.deepEqual([doc.continued, doc.attempts, doc.n_steps, doc.residuals, doc.has_results], [null, null, 0, [], false]);
  });

  it("solve.sh's warning (the earlier log could not be kept) reaches the run, with the host's text", async () => {
    const rid = await solvedRun('done');
    const { out } = await cont(rid, { extraIterations: 10 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.deepEqual(runDoc(rid).warnings, []);
    relay([
      { event: 'warning', code: 'log_kept', message: 'anything the script says' },
      { event: 'warning', code: 'log_kept', message: 'again' },
      { event: 'warning', code: 'not_a_code', message: 'ignored' },
    ]);
    const want = [{ code: 'log_kept', message: 'The earlier solver log could not be kept' }];
    assert.deepEqual(runDoc(rid).warnings, want);
    assert.deepEqual(w27.getRunStatus(PID, rid, SID).body.run.warnings, want);
    endRun(rid, 'done');
    assert.deepEqual(runDoc(rid).warnings, want, 'kept when the run ends');
  });

  it('queued as a Start is: the row keeps its Continue, and the queue starts it as one', async () => {
    const rid = await solvedRun('done');
    // The row the Run panel queues while another job runs (its settings.continue).
    const queued = queue.enqueueComputeJob({ kind: 'solve', run_id: rid, simulation_id: SID, project_id: PID, mesh_id: MID, settings: { continue: { extra_iterations: 30 } } });
    assert.equal(queued.ok, true, queued.error);
    assert.deepEqual(queued.item.settings, { continue: { extra_iterations: 30 } });
    // The queue's start (live-routes' startSolve hook): a Continue, not a Start.
    const out = await w27.startQueuedSolve(queued.item);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    const spec = specOf(out.bodyExtra.runner_job_id);
    assert.equal(spec.solver.restart, true);
    assert.deepEqual(JSON.parse(argOf(spec, '--restart')), { end_time: 130, write_interval: 50 });
    assert.equal(runDoc(rid).continued.from_time, 100);
    endRun(rid, 'done');
    // A plain row of a finished run is still a Start: "already finished", it leaves the queue.
    const plain = await w27.startQueuedSolve({ project_id: PID, run_id: rid, simulation_id: SID, settings: null });
    assert.deepEqual(queue.startResultFromEngine(plain), { ok: false, skip: true, error: plain.bodyExtra.error });
    // A queued Continue waiting cannot help (its saved results gone) leaves the queue with its reason.
    for (const t of ['50', '100', '130']) rmSync(join(caseOf(rid), t), { recursive: true, force: true });
    const gone = await w27.startQueuedSolve({ project_id: PID, run_id: rid, simulation_id: SID, settings: { continue: { extra_iterations: 30 } } });
    assert.deepEqual(queue.startResultFromEngine(gone), {
      ok: false,
      final: true,
      error: "This run can't continue: its case folder has no saved result. Add a run to solve again.",
    });
    assert.equal(runDoc(rid).status, 'done');
  });

  it('refused, the run left as it ended: no saved result, no extra iterations, a draft, a running run', async () => {
    const rid = await solvedRun('done');
    let { out } = await cont(rid, { extraIterations: 0 });
    assert.deepEqual([out.status, out.bodyExtra.error], [400, 'Enter how many more iterations to run (1 or more).']);
    for (const t of ['50', '100']) rmSync(join(caseOf(rid), t), { recursive: true, force: true });
    assert.equal(w27.getRunStatus(PID, rid, SID).body.run.continue_from, null);
    ({ out } = await cont(rid, { extraIterations: 50 }));
    assert.deepEqual(
      [out.status, out.bodyExtra.code, out.bodyExtra.error],
      [409, 'no_saved_time', "This run can't continue: its case folder has no saved result. Add a run to solve again."],
    );
    assert.equal(runDoc(rid).status, 'done');
    const draft = draftRun();
    ({ out } = await cont(draft, { extraIterations: 50 }));
    assert.deepEqual([out.status, out.bodyExtra.code], [409, 'not_continuable']);
    const live = draftRun();
    await start(live);
    ({ out } = await cont(live, { extraIterations: 50 }));
    assert.equal(out.status, 409);
    const spawned = fx.spawned.length;
    assert.equal(fx.spawned.length, spawned);
  });

  it("an analysis whose case writer cannot continue: refused, the run left as it ended", async () => {
    const rid = await solvedRun('done');
    const plain = planAnswer();
    fx.plan = () => ({ ...plain, prepare: { ...plain.prepare, args_from_params: ['run_id', 'mesh_id', 'time_dependency', 'n_procs', 'transient'] } });
    const before = fx.spawned.length;
    const { out } = await cont(rid, { extraIterations: 50 });
    assert.deepEqual([out.ok, out.status, out.bodyExtra.error], [false, 409, "This run's analysis cannot continue a run. Add a run to solve again."]);
    assert.equal(fx.spawned.length, before);
    const doc = runDoc(rid);
    assert.deepEqual([doc.status, doc.n_steps, doc.attempts ?? null], ['done', 2, null]);
    assert.equal(slot.computeSlotHolder(), null);
  });

  it('a transient run continues to a later end time, saving as often as it did', async () => {
    fx.plan = () =>
      planAnswer({
        analysis_key: 'incompressible_transient',
        app: 'pimpleFoam',
        time_dependency: 'Transient',
        launch: { ...planAnswer().launch, app: 'pimpleFoam', keep_frames: 'all', process_names: ['pimpleFoam'] },
        plan: { ...planAnswer().plan, solver: 'pimpleFoam', transient_control: { end_time: 1, write_interval: 0.25, write_count: 4 } },
      });
    const rid = draftRun({ time_dependency: 'Transient', transient: { end_time: 1, write_count: 4 } });
    const { out: started } = await start(rid);
    assert.equal(started.ok, true, JSON.stringify(started.bodyExtra));
    relay([{ event: 'stage', stage: 'solve' }, ...step(0.5), ...step(1)]);
    await sleep(FRAME_WAIT);
    for (const t of [0.5, 1]) {
      saveFrame(rid, t);
      relay([{ event: 'time_saved', t }]);
    }
    endRun(rid, 'done');
    assert.deepEqual(runDoc(rid).transient.write_interval, 0.25);
    let { out } = await cont(rid, { endTime: 1 });
    assert.deepEqual([out.status, out.bodyExtra.error], [400, 'Enter an end time after t = 1 s (the last saved result).']);
    ({ out } = await cont(rid, { endTime: 2 }));
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    const spec = specOf(out.bodyExtra.runner_job_id);
    assert.equal(spec.solver.restart, true);
    assert.deepEqual(JSON.parse(argOf(spec, '--restart')), { end_time: 2, write_interval: 0.25 });
    const tr = JSON.parse(argOf(spec, '--transient'));
    assert.deepEqual([tr.end_time, tr.write_count], [2, 8]);
    assert.deepEqual([fx.plans.at(-1).transient.end_time, fx.plans.at(-1).transient.write_count], [2, 8]);
  });
});
