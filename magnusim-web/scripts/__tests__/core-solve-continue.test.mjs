// F6: Continue a finished or stopped core run (w27-solve.js continueSolve) on the real
// runner (foam-runner.js) and core-solve.js, the runner's outside calls faked (no relay,
// no WSL) and a stand-in worker, as core-solve-runner.test.mjs does:
//   - the restart flag reaches the relay's spec (solver.restart) and the case writer
//     (the prepare job's --restart {end_time, write_interval});
//   - the run keeps its frames, residuals, steps, log parts and attempt history; its
//     new steps count on from the old total and its residuals are continuous;
//   - a plain Start of a finished run still says it finished; a Continue that cannot
//     start (no saved result, a writer that cannot continue, bad input) leaves the run
//     as it ended;
//   - RH3 (numerics at Continue): a fresh Start records the numerics it starts with
//     (numerics_used); a Continue writes its case with them (restart.numerics), or, once the
//     study's numerics differ, with the ones the caller chose: "as_was" or "new" (the run's
//     record replaced, an applied numerics entry); without a choice it is refused
//     choose_numerics and nothing starts or queues; a run with no record goes on as before.
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
/** A restart without the numerics it goes on with and whether it keeps them (RH3; checked on their own). */
const withoutNumerics = (r) => {
  const { numerics, keep_numerics, ...rest } = r || {};
  return rest;
};
/** The prepare job's --restart, without its numerics. */
const restartOf = (spec) => withoutNumerics(JSON.parse(argOf(spec, '--restart')));

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
    assert.deepEqual(restartOf(spec), { end_time: 150, write_interval: 50 });
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
    assert.deepEqual(restartOf(specOf(out.bodyExtra.runner_job_id)), { end_time: 150, write_interval: 50 });
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

  it('a run that converged (F5: done, its converged set) continues past its convergence, its stops off', async () => {
    /** The runner's job log of the latest attempt says it converged (its parser's event). */
    const convergedAt = (job, time) => {
      const path = store.readFoamRecord(job).log_path;
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify({ event: 'converged', by: 'residuals', time }) + '\n');
    };
    const rid = draftRun();
    let { out } = await start(rid);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    relay([{ event: 'stage', stage: 'solve' }, ...step(60)]);
    await sleep(FRAME_WAIT);
    saveFrame(rid, 60);
    relay([{ event: 'time_saved', t: 60 }]);
    convergedAt(out.bodyExtra.runner_job_id, 60);
    endRun(rid, 'done');
    const ended = runDoc(rid);
    assert.deepEqual([ended.status, ended.converged], ['done', { by: 'residuals', iteration: 60 }]);
    // Offered Continue: where it continues from, as for any finished run.
    assert.equal(w27.getRunStatus(PID, rid, SID).body.run.continue_from, 60);

    ({ out } = await cont(rid, { extraIterations: 40 }));
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    // Past its convergence: the case writer is told to leave its stops out, and the plan
    // is made for that case.
    assert.deepEqual(restartOf(specOf(out.bodyExtra.runner_job_id)), { end_time: 100, write_interval: 50, stops_off: true });
    assert.deepEqual(withoutNumerics(fx.plans[fx.plans.length - 1].restart), { end_time: 100, write_interval: 50, stops_off: true });
    // The new attempt has not converged; the earlier one's end is kept with it.
    let doc = runDoc(rid);
    assert.deepEqual([doc.status, doc.converged, doc.continued.stops_off], ['running', null, true]);
    assert.deepEqual(doc.attempts.map((a) => [a.status, a.converged, a.stops_off]), [['done', { by: 'residuals', iteration: 60 }, false]]);
    assert.equal(w27.getRunStatus(PID, rid, SID).body.run.converged, null);
    relay([{ event: 'stage', stage: 'solve' }, ...step(61), ...step(100)]);
    await sleep(FRAME_WAIT);
    saveFrame(rid, 100);
    relay([{ event: 'time_saved', t: 100 }]);
    endRun(rid, 'done');
    doc = runDoc(rid);
    assert.deepEqual([doc.status, doc.last_saved_iteration, doc.n_steps], ['done', 100, 3]);
    assert.ok(!doc.converged, 'ran to its end past convergence: no converged end');
    // A later Continue goes on past it too, and the part that ran with its stops off says so.
    ({ out } = await cont(rid, { extraIterations: 10 }));
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(JSON.parse(argOf(specOf(out.bodyExtra.runner_job_id), '--restart')).stops_off, true);
    doc = runDoc(rid);
    assert.deepEqual(doc.attempts.map((a) => a.stops_off), [false, true]);
    relay([{ event: 'stage', stage: 'solve' }, ...step(101)]);
    await sleep(FRAME_WAIT);
    endRun(rid, 'done');
  });

  it('a run that did not converge keeps its stops when it continues', async () => {
    const rid = await solvedRun('done');
    const { out } = await cont(rid, { extraIterations: 10 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal('stops_off' in JSON.parse(argOf(specOf(out.bodyExtra.runner_job_id), '--restart')), false);
    assert.equal(runDoc(rid).continued.stops_off, false);
    relay([{ event: 'stage', stage: 'solve' }, ...step(101)]);
    await sleep(FRAME_WAIT);
    endRun(rid, 'done');
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
    // Starting it again deletes its results: refused until the person was asked (runReopen.ts),
    // the run left as it ended.
    const refused = await start(rid);
    assert.deepEqual([refused.out.status, refused.out.bodyExtra.code, refused.out.bodyExtra.final], [409, 'overwrites_results', true]);
    assert.equal(runDoc(rid).status, 'stopped');
    assert.ok(existsSync(join(caseOf(rid), '100')), 'its frames stay');
    const again = await start(rid, { overwrite: true });
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

  it("solve.sh's frame_not_back (the last saved time did not come back) lands in the run's warnings", async () => {
    const rid = await solvedRun('done');
    const { out } = await cont(rid, { extraIterations: 10 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    relay([{ event: 'warning', code: 'frame_not_back', message: 'The latest saved time (110) did not come back' }]);
    const want = [
      {
        code: 'frame_not_back',
        message: 'The results of the last saved time did not come back to Windows. The case is kept in WSL for a day (its WSL case folder)',
      },
    ];
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
    assert.deepEqual(restartOf(spec), { end_time: 130, write_interval: 50 });
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
    assert.deepEqual(restartOf(spec), { end_time: 2, write_interval: 0.25 });
    const tr = JSON.parse(argOf(spec, '--transient'));
    assert.deepEqual([tr.end_time, tr.write_count], [2, 8]);
    assert.deepEqual([fx.plans.at(-1).transient.end_time, fx.plans.at(-1).transient.write_count], [2, 8]);
  });
});

// A2 (run health spec RH1 commit 2): a stopped run's Max Courant, outer and pressure correctors
// and Max time step can wait for Continue (at_continue): its results stay, the run records the
// change (continue_changes, the merge rule), and the Continue that starts writes the case with it
// and stamps it applied. Without a choice the route refuses (choose_restart); other keys, a
// failed run and a run with no saved time cannot wait (not_continue_settings).
describe('A2: a change for when a stopped run continues', () => {
  const BLOCK = { end_time: 1, write_count: 4, max_co: 100, n_outer_correctors: 1, n_correctors: 2, max_delta_t: 0.25 };
  /** The study's mode (its folder's id.json, as the study catalog walks it). */
  const studyMode = (td) => {
    const idPath = join(layout.findStudy(join(PROJECTS, PID), SID).dir, 'id.json');
    writeFileSync(idPath, JSON.stringify({ ...JSON.parse(readFileSync(idPath, 'utf8')), time_dependency: td }));
  };
  // A transient run's A2 needs its study to be Transient still (runReopen.ts runEditState).
  beforeEach(() => studyMode('Transient'));
  afterEach(() => studyMode(undefined));
  const transientPlan = () =>
    planAnswer({
      analysis_key: 'incompressible_transient',
      app: 'pimpleFoam',
      time_dependency: 'Transient',
      launch: { ...planAnswer().launch, app: 'pimpleFoam', keep_frames: 'all', process_names: ['pimpleFoam'] },
      plan: { ...planAnswer().plan, solver: 'pimpleFoam', transient_control: { ...BLOCK, write_interval: 0.25 } },
    });

  /** A transient run stopped with its result at t = 0.5 (a saved time Continue goes on from). */
  async function stoppedTransient() {
    fx.plan = transientPlan;
    const rid = draftRun({ time_dependency: 'Transient', transient: { ...BLOCK } });
    const { out } = await start(rid);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    relay([{ event: 'stage', stage: 'solve' }, ...step(0.25), ...step(0.5)]);
    await sleep(FRAME_WAIT);
    saveFrame(rid, 0.5);
    relay([{ event: 'time_saved', t: 0.5 }]);
    endRun(rid, 'stopped');
    assert.equal(runDoc(rid).status, 'stopped');
    // The settings it solved with (the stand-in plan resolves none of its own).
    io.persistRun(PID, SID, { id: rid, run_id: rid, transient: { ...BLOCK } });
    return rid;
  }
  const update = (rid, body) => w27.updateRunSettings(PID, { run_id: rid, simulation_id: SID, ...body });

  it('no choice: refused choose_restart with the question; at_continue keeps the results and records the change', async () => {
    const rid = await stoppedTransient();
    const name = runDoc(rid).name;
    let out = await update(rid, { transient: { ...BLOCK, max_co: 5 } });
    assert.deepEqual([out.status, out.code, out.title], [409, 'choose_restart', `Change "${name}"?`]);
    assert.equal(out.error, `Max Courant 100 → 5. "${name}" has results up to t = 0.5 s. Start over deletes its results; Use when continuing keeps them.`);
    assert.equal(runDoc(rid).transient.max_co, 100);
    out = await update(rid, { transient: { ...BLOCK, max_co: 5 }, at_continue: true });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.at_continue, true);
    assert.equal(out.reopened, undefined);
    let doc = runDoc(rid);
    assert.deepEqual([doc.status, doc.transient.max_co, existsSync(join(caseOf(rid), '0.5'))], ['stopped', 5, true]);
    assert.equal(doc.continue_changes.length, 1);
    assert.deepEqual(
      { ...doc.continue_changes[0], at: 'x' },
      { from_t: 0.5, from_iteration: null, at: 'x', by: 'person', kind: 'settings', changes: [{ key: 'transient.max_co', from: 100, to: 5 }], applied_at: null },
    );
    // The study's default for new runs follows a stopped run's change, as before.
    assert.equal(w27.getSimulationControl(PID, SID).transient.max_co, 5);
    // The Assistant joins it: a new key with its stored value as from; by becomes both.
    out = await update(rid, { transient: { ...BLOCK, max_co: 5, n_outer_correctors: 3 }, at_continue: true, by: 'assistant' });
    assert.equal(out.ok, true, JSON.stringify(out));
    doc = runDoc(rid);
    assert.equal(doc.continue_changes[0].by, 'both');
    assert.deepEqual(doc.continue_changes[0].changes, [
      { key: 'transient.max_co', from: 100, to: 5 },
      { key: 'transient.n_outer_correctors', from: 1, to: 3 },
    ]);
    // A key set back leaves it; the last one gone takes the entry with it.
    await update(rid, { transient: { ...BLOCK, max_co: 100, n_outer_correctors: 3 }, at_continue: true });
    assert.deepEqual(runDoc(rid).continue_changes[0].changes, [{ key: 'transient.n_outer_correctors', from: 1, to: 3 }]);
    await update(rid, { transient: { ...BLOCK }, at_continue: true });
    assert.deepEqual(runDoc(rid).continue_changes, []);
  });

  it('not_continue_settings: another key, a failed run, no saved time; other keys keep the two-way question, and a start-over clears the record', async () => {
    const rid = await stoppedTransient();
    let out = await update(rid, { transient: { ...BLOCK, max_co: 5, end_time: 2 }, at_continue: true });
    assert.deepEqual([out.status, out.code], [409, 'not_continue_settings']);
    assert.equal(out.error, 'Only Max Courant, the outer and pressure correctors and Max time step can wait for Continue. Simulation time needs Start over or a new run.');
    // A mix, or any other solve key, without a choice: the two-way question (overwrites_results).
    out = await update(rid, { transient: { ...BLOCK, max_co: 5, end_time: 2 } });
    assert.deepEqual([out.status, out.code], [409, 'overwrites_results']);
    // A waiting change, then a start-over: the record goes with the results.
    out = await update(rid, { transient: { ...BLOCK, max_co: 5 }, at_continue: true });
    assert.equal(out.ok, true, JSON.stringify(out));
    out = await update(rid, { transient: { ...BLOCK, max_co: 7 }, overwrite: true });
    assert.equal(out.ok, true, JSON.stringify(out));
    const doc = runDoc(rid);
    assert.deepEqual([doc.status, doc.continue_changes, doc.transient.max_co], ['draft', undefined, 7]);
    // A failed run, and a stopped run with no saved time, never wait for Continue.
    const failed = draftRun({ status: 'failed', time_dependency: 'Transient', transient: { ...BLOCK }, has_results: true, n_saved_times: 1, last_saved_iteration: 0.5 });
    out = await update(failed, { transient: { ...BLOCK, max_co: 5 }, at_continue: true });
    assert.deepEqual([out.status, out.code], [409, 'not_continue_settings']);
    assert.match(out.error, /^A failed run does not continue/);
    const empty = draftRun({ status: 'stopped', time_dependency: 'Transient', transient: { ...BLOCK }, n_steps: 40 });
    out = await update(empty, { transient: { ...BLOCK, max_co: 5 }, at_continue: true });
    assert.deepEqual([out.status, out.code], [409, 'not_continue_settings']);
    assert.match(out.error, /has no saved time to continue from/);
    // Its change without a choice starts it over, asked first (it has steps to lose).
    out = await update(empty, { transient: { ...BLOCK, max_co: 5 } });
    assert.deepEqual([out.status, out.code], [409, 'overwrites_results']);
  });

  it('the Continue that starts writes its case with the change and stamps it applied', async () => {
    const rid = await stoppedTransient();
    // The analysis's normalizer: the settings over the block they change (as run_normalize does).
    attachWorkerBridge(async (method, params) => {
      if (method === 'analysis.validate_ready') return { ready: true, issues: [] };
      if (method === 'analysis.run_normalize') return { settings: { ...(params && params.base), ...(params && params.settings) } };
      if (method === 'analysis.plan_run') {
        fx.plans.push(params);
        return fx.plan(params);
      }
      return { ok: true };
    });
    const out0 = await update(rid, { transient: { ...BLOCK, max_co: 5, n_outer_correctors: 3 }, at_continue: true });
    assert.equal(out0.ok, true, JSON.stringify(out0));
    const { out } = await cont(rid, { endTime: 2 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    const tr = JSON.parse(argOf(specOf(out.bodyExtra.runner_job_id), '--transient'));
    assert.deepEqual([tr.max_co, tr.n_outer_correctors, tr.end_time], [5, 3, 2]);
    assert.deepEqual([fx.plans.at(-1).transient.max_co, fx.plans.at(-1).transient.n_outer_correctors], [5, 3]);
    const doc = runDoc(rid);
    assert.equal(doc.continue_changes.length, 1);
    assert.equal(typeof doc.continue_changes[0].applied_at, 'string');
    assert.deepEqual(doc.continue_changes[0].changes.map((c) => c.key), ['transient.max_co', 'transient.n_outer_correctors']);
  });

  it('a change for Continue keeps the block the run solved with: Continue saves as often as it did, and new runs get the settings as typed', async () => {
    const rid = await stoppedTransient();
    // As its Start worked it out (control_to_web): the write interval Continue reads, the auto time steps.
    const solved = { ...BLOCK, write_interval: 0.25, delta_t: 0.004, adjust_time_step: true, source: { delta_t: 'auto', max_delta_t: 'auto' }, estimate: { delta_t: 0.004, steps: 250 } };
    io.persistRun(PID, SID, { id: rid, run_id: rid, transient: solved });
    // The analysis's normalizer as it is: the settings over the stored block, only its own keys kept.
    const KEYS = ['end_time', 'write_count', 'time_step_mode', 'max_co', 'delta_t', 'max_delta_t', 'time_scheme', 'n_outer_correctors', 'n_correctors', 'n_non_orth_correctors', 'average_from'];
    attachWorkerBridge(async (method, params) => {
      if (method === 'analysis.validate_ready') return { ready: true, issues: [] };
      if (method === 'analysis.run_normalize') {
        const raw = { ...(params && params.base), ...(params && params.settings) };
        return { settings: Object.fromEntries(KEYS.filter((k) => k in raw).map((k) => [k, raw[k]])) };
      }
      if (method === 'analysis.plan_run') {
        fx.plans.push(params);
        return fx.plan(params);
      }
      return { ok: true };
    });
    // The page sends its whole block: the change, and what its Start worked out as it was.
    const out0 = await update(rid, { transient: { ...solved, max_co: 5 }, at_continue: true });
    assert.equal(out0.ok, true, JSON.stringify(out0));
    const doc = runDoc(rid);
    assert.deepEqual(doc.transient, { ...solved, max_co: 5 });
    assert.deepEqual(doc.continue_changes[0].changes, [{ key: 'transient.max_co', from: 100, to: 5 }]);
    // New runs start with the settings as typed: what the Start worked out stays blank there.
    const study = w27.getSimulationControl(PID, SID).transient;
    assert.deepEqual([study.max_co, study.delta_t, study.max_delta_t, 'source' in study, 'estimate' in study, 'adjust_time_step' in study], [5, null, null, false, false, false]);
    // A Max time step typed for Continue is the person's from then on.
    const out1 = await update(rid, { transient: { ...solved, max_co: 5, max_delta_t: 0.1 }, at_continue: true });
    assert.equal(out1.ok, true, JSON.stringify(out1));
    assert.deepEqual([runDoc(rid).transient.max_delta_t, runDoc(rid).transient.source, runDoc(rid).transient.write_interval], [0.1, { delta_t: 'auto', max_delta_t: 'user' }, 0.25]);
    assert.equal(w27.getSimulationControl(PID, SID).transient.max_delta_t, 0.1);
    // Continue to 2 s saves every 0.25 s as before: 8 frames.
    const { out } = await cont(rid, { endTime: 2 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    const spec = specOf(out.bodyExtra.runner_job_id);
    assert.deepEqual(restartOf(spec), { end_time: 2, write_interval: 0.25 });
    const tr = JSON.parse(argOf(spec, '--transient'));
    assert.deepEqual([tr.end_time, tr.write_count, tr.max_co, tr.max_delta_t], [2, 8, 5, 0.1]);
  });

  it("a study now Steady-state: a transient run's change starts it over (the two-way question), never waits for Continue", async () => {
    const rid = await stoppedTransient();
    studyMode('Steady-state');
    let out = await update(rid, { transient: { ...BLOCK, max_co: 5 } });
    assert.deepEqual([out.status, out.code], [409, 'overwrites_results']);
    out = await update(rid, { transient: { ...BLOCK, max_co: 5 }, at_continue: true });
    assert.deepEqual([out.status, out.code], [409, 'not_continue_settings']);
    assert.equal(out.error, `"${runDoc(rid).name}" solved Transient; its study is now Steady-state: a change of its settings starts it over as a Steady-state run.`);
    assert.deepEqual([runDoc(rid).status, runDoc(rid).transient.max_co, runDoc(rid).continue_changes], ['stopped', 100, undefined]);
  });

  it("a steady run's Continue never uses the four: their change starts it over, and cannot wait for Continue", async () => {
    const rid = await solvedRun('stopped');
    let out = await update(rid, { transient: { max_co: 5 } });
    assert.deepEqual([out.status, out.code], [409, 'overwrites_results']);
    out = await update(rid, { transient: { max_co: 5 }, at_continue: true });
    assert.deepEqual([out.status, out.code], [409, 'not_continue_settings']);
    assert.match(out.error, /solved Steady-state: its Continue goes on in iterations/);
    assert.equal(runDoc(rid).continue_changes, undefined);
  });

  it('continuedRunFields stamps the waiting change applied, and leaves an applied one as it was', () => {
    const waiting = { from_t: 0.5, from_iteration: null, at: 'a', by: 'person', kind: 'settings', changes: [{ key: 'transient.max_co', from: 100, to: 5 }], applied_at: null };
    const earlier = { ...waiting, at: 'z', applied_at: 'old' };
    const f = w27.continuedRunFields({ status: 'stopped', n_steps: 4, continue_changes: [earlier, waiting] }, { from: 0.5, times: [0.5], at: 'now' });
    assert.deepEqual(f.continue_changes.map((e) => e.applied_at), ['old', 'now']);
    assert.equal('continue_changes' in w27.continuedRunFields({ status: 'stopped' }, { from: 0.5, times: [0.5] }), false);
  });
});

// RH3 (run health spec 5.3): numerics at Continue. A fresh Start records the numerics its run
// starts with (numerics_used: every numerics setting of its analysis and mode, raw); a Continue
// writes its case with the numerics it goes on with (the prepare job's and the plan's
// restart.numerics, which the core puts over the study record): what it started with, or once the
// study's numerics differ, the caller's choice; without one it is refused and nothing starts or queues.
describe('RH3: numerics at Continue', () => {
  const REGISTRY = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'generated', 'registry.json'), 'utf8'));
  const keysOf = (analysis) => Object.keys(REGISTRY.analysis.find((a) => a.key === analysis).numerics_schema.properties);
  /** The study's settings (its folder's id.json, as the study catalog walks it). */
  const studyIdPath = () => join(layout.findStudy(join(PROJECTS, PID), SID).dir, 'id.json');
  let idBefore = '';
  const studySet = (values) => {
    const doc = JSON.parse(readFileSync(studyIdPath(), 'utf8'));
    for (const [k, v] of Object.entries(values)) {
      if (v === null) delete doc[k];
      else doc[k] = v;
    }
    writeFileSync(studyIdPath(), JSON.stringify(doc));
  };
  beforeEach(() => {
    idBefore = readFileSync(studyIdPath(), 'utf8');
    studySet({ relax_p: 0.3 });
  });
  afterEach(() => writeFileSync(studyIdPath(), idBefore));
  const numericsArg = (out) => JSON.parse(argOf(specOf(out.bodyExtra.runner_job_id), '--restart')).numerics;

  it('a fresh Start records every numerics setting of its analysis and mode, raw: Incompressible Flow steady and transient, Heat Transfer steady and transient', async () => {
    const rid = await solvedRun('stopped');
    const used = runDoc(rid).numerics_used;
    assert.deepEqual([used.analysis, used.mode, typeof used.at], ['incompressible_steady', 'steady', 'string']);
    assert.deepEqual(Object.keys(used.values).sort(), keysOf('incompressible_steady').sort());
    for (const k of ['numerics_preset', 'residual_u', 'residual_p', 'simplec', 'relax_u', 'relax_p', 'n_non_orthogonal']) assert.ok(k in used.values, k);
    // Raw: the stored value, blanks as null (the preset's).
    assert.deepEqual([used.values.relax_p, used.values.relax_u, used.values.grad_limiter], [0.3, null, null]);
    // The run panel's read has it too (the Assistant reads run.status).
    assert.deepEqual(w27.getRunStatus(PID, rid, SID).body.run.numerics_used, used);
    // Each analysis and mode: its own settings, RH3's included.
    const ifT = w27.startNumerics({ analysis_type: 'incompressible_steady', relax_p: 0.3 }, true);
    assert.deepEqual([ifT.analysis, ifT.mode, Object.keys(ifT.values).sort()], ['incompressible_transient', 'transient', keysOf('incompressible_transient').sort()]);
    assert.ok(!('relax_p' in ifT.values), "a transient run's PIMPLE loops are its run's settings, not the study's relaxation");
    assert.ok(['grad_limiter', 'momentum_convection', 'p_tolerance', 'velocity_limit'].every((k) => k in ifT.values));
    const htS = w27.startNumerics({ analysis_type: 'heat_transfer_steady', relax_h: 0.5 }, false);
    assert.deepEqual([htS.analysis, htS.mode, Object.keys(htS.values).sort()], ['heat_transfer_steady', 'steady', keysOf('heat_transfer_steady').sort()]);
    for (const k of ['numerics_preset', 'relax_u', 'relax_p', 'relax_h', 'residual_target', 'n_non_orthogonal']) assert.ok(k in htS.values, k);
    assert.equal(htS.values.relax_h, 0.5);
    const htT = w27.startNumerics({ analysis_type: 'heat_transfer_steady' }, true);
    assert.deepEqual([htT.analysis, htT.mode, Object.keys(htT.values).sort()], ['heat_transfer_transient', 'transient', keysOf('heat_transfer_transient').sort()]);
    for (const k of ['numerics_preset', 'n_non_orthogonal', 'energy_convection']) assert.ok(k in htT.values, k);
    assert.ok(!('relax_h' in htT.values));
  });

  it('no difference: Continue asks nothing and writes its case with what it started with', async () => {
    const rid = await solvedRun('stopped');
    const used = runDoc(rid).numerics_used;
    const { out } = await cont(rid, { extraIterations: 20 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    const sent = numericsArg(out);
    assert.deepEqual(Object.keys(sent).sort(), Object.keys(used.values).sort());
    assert.deepEqual([sent.relax_p, sent.relax_u], [0.3, null]);
    // The plan is made for the same case.
    assert.deepEqual(fx.plans.at(-1).restart.numerics, sent);
    assert.deepEqual(runDoc(rid).numerics_used, used);
    assert.equal((runDoc(rid).continue_changes || []).some((e) => e.kind === 'numerics'), false);
  });

  it('differences and no choice: 409 choose_numerics with the differences and the words, nothing starts or queues (a busy PC too)', async () => {
    const rid = await solvedRun('stopped');
    studySet({ relax_p: 0.2, relax_u: 0.5 });
    const before = fx.spawned.length;
    const name = runDoc(rid).name;
    let { out } = await cont(rid, { extraIterations: 20 });
    assert.deepEqual([out.ok, out.status, out.bodyExtra.code], [false, 409, 'choose_numerics']);
    // A blank reads its field's default (Relaxation U 0.7), as the person's question says it.
    assert.equal(out.bodyExtra.error, `The study's numerics changed after "${name}" started: Relaxation U 0.7 → 0.5, Relaxation p 0.3 → 0.2.`);
    assert.deepEqual(
      out.bodyExtra.differences.map(({ key, label, from, to }) => ({ key, label, from, to })),
      [
        { key: 'relax_u', label: 'Relaxation U', from: null, to: 0.5 },
        { key: 'relax_p', label: 'Relaxation p', from: 0.3, to: 0.2 },
      ],
    );
    assert.equal(fx.spawned.length, before);
    assert.deepEqual([runDoc(rid).status, slot.computeSlotHolder()], ['stopped', null]);
    // Another job holds the PC: still refused, never queued.
    const held = slot.claimComputeSlot('mesh', { project_id: PID, name: 'Mesh 1' });
    assert.equal(held.ok, true);
    try {
      ({ out } = await cont(rid, { extraIterations: 20 }));
      assert.deepEqual([out.status, out.bodyExtra.code], [409, 'choose_numerics']);
      assert.deepEqual(queue.snapshotComputeQueue().items, []);
    } finally {
      slot.releaseComputeSlot(held.token);
    }
    // An answer that is neither: refused as bad input.
    ({ out } = await cont(rid, { extraIterations: 20, numerics: 'newest' }));
    assert.deepEqual([out.status, out.bodyExtra.code], [400, 'bad_request']);
  });

  it('"as_was": its case is written with what it started with, and its record stays', async () => {
    const rid = await solvedRun('stopped');
    const used = runDoc(rid).numerics_used;
    studySet({ relax_p: 0.2 });
    const { out } = await cont(rid, { extraIterations: 20, numerics: 'as_was' });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(numericsArg(out).relax_p, 0.3);
    assert.equal(fx.plans.at(-1).restart.numerics.relax_p, 0.3);
    const doc = runDoc(rid);
    assert.deepEqual(doc.numerics_used, used);
    assert.equal((doc.continue_changes || []).some((e) => e.kind === 'numerics'), false);
  });

  it('"new": its case is written with the study\'s numerics, its record replaced, and the change recorded applied (the person\'s, or the Assistant\'s)', async () => {
    const rid = await solvedRun('stopped');
    studySet({ relax_p: 0.2 });
    let { out } = await cont(rid, { extraIterations: 20, numerics: 'new' });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(numericsArg(out).relax_p, 0.2);
    let doc = runDoc(rid);
    assert.equal(doc.numerics_used.values.relax_p, 0.2);
    assert.deepEqual(Object.keys(doc.numerics_used.values).sort(), keysOf('incompressible_steady').sort());
    const entry = doc.continue_changes.find((e) => e.kind === 'numerics');
    assert.deepEqual(
      { ...entry, at: 'x', applied_at: typeof entry.applied_at },
      {
        from_t: null,
        from_iteration: 100,
        at: 'x',
        by: 'person',
        kind: 'numerics',
        changes: [{ key: 'relax_p', label: 'Relaxation p', from: 0.3, to: 0.2, text: 'Relaxation p 0.3 → 0.2' }],
        applied_at: 'string',
      },
    );
    relay([{ event: 'stage', stage: 'solve' }, ...step(101)]);
    await sleep(FRAME_WAIT);
    saveFrame(rid, 120);
    relay([{ event: 'time_saved', t: 120 }]);
    endRun(rid, 'stopped');
    // Nothing differs now: the next Continue asks nothing and goes on with 0.2.
    ({ out } = await cont(rid, { extraIterations: 10 }));
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(numericsArg(out).relax_p, 0.2);
    relay([{ event: 'stage', stage: 'solve' }, ...step(121)]);
    await sleep(FRAME_WAIT);
    saveFrame(rid, 130);
    relay([{ event: 'time_saved', t: 130 }]);
    endRun(rid, 'stopped');
    // The Assistant's "new", queued while the PC was busy: the row keeps it, and the run records who.
    studySet({ relax_p: 0.15 });
    const queued = await w27.startQueuedSolve({ project_id: PID, run_id: rid, simulation_id: SID, settings: { continue: { extra_iterations: 10, numerics: 'new', by: 'assistant' } } });
    assert.equal(queued.ok, true, JSON.stringify(queued.bodyExtra));
    doc = runDoc(rid);
    assert.equal(doc.numerics_used.values.relax_p, 0.15);
    assert.deepEqual(
      doc.continue_changes.filter((e) => e.kind === 'numerics').map((e) => [e.by, e.from_iteration, e.changes.map((c) => c.text)]),
      [
        ['person', 100, ['Relaxation p 0.3 → 0.2']],
        ['assistant', 130, ['Relaxation p 0.2 → 0.15']],
      ],
    );
    endRun(rid, 'stopped');
    // A queued Continue the study changed under since it was queued leaves the queue with the question.
    studySet({ relax_p: 0.1 });
    const stale = await w27.startQueuedSolve({ project_id: PID, run_id: rid, simulation_id: SID, settings: { continue: { extra_iterations: 10 } } });
    assert.deepEqual([stale.ok, stale.status, stale.bodyExtra.code, stale.bodyExtra.final], [false, 409, 'choose_numerics', true]);
    assert.equal(queue.startResultFromEngine(stale).final, true);
  });

  it('only the core writes the record: a run update that sends one is saved without it, and asks nothing', async () => {
    const rid = await solvedRun('stopped');
    const used = runDoc(rid).numerics_used;
    const out = await w27.updateRunSettings(PID, { run_id: rid, simulation_id: SID, cores: 2, numerics_used: { analysis: 'x', mode: 'steady', at: 'y', values: { relax_p: 0.9 } } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual([runDoc(rid).numerics_used, runDoc(rid).cores, runDoc(rid).status], [used, 2, 'stopped']);
  });

  it('before RH3: a run with no record continues with the study\'s numerics and asks nothing', async () => {
    const rid = await solvedRun('stopped');
    const rec = runDoc(rid);
    delete rec.numerics_used;
    writeFileSync(join(io.runFolderOf(PID, rid, SID).dir, 'run.json'), JSON.stringify(rec));
    studySet({ relax_p: 0.2 });
    const { out } = await cont(rid, { extraIterations: 20 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal('numerics' in JSON.parse(argOf(specOf(out.bodyExtra.runner_job_id), '--restart')), false);
    assert.equal(runDoc(rid).numerics_used, undefined);
  });

  it('a start over drops the record; its fresh Start records the study\'s numerics then', async () => {
    const rid = await solvedRun('stopped');
    studySet({ relax_p: 0.2 });
    const r = await w27.reopenCatalogRun(PID, { run_id: rid, simulation_id: SID, overwrite: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(runDoc(rid).numerics_used, undefined);
    const { out } = await start(rid);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(runDoc(rid).numerics_used.values.relax_p, 0.2);
  });
});

// RH3 (the validation set's pipes, 2026-11-06): "Numerics as written" of a started run is what its
// case was written with, recorded then (numerics_used.written: the analysis's plan's rows), never
// what today's writer would write from its numerics. A Continue that goes on with what the run had
// keeps its record and tells the case writer to keep its schemes and saved walls (keep_numerics);
// one with the study's new numerics records the Continue's plan rows. The route's answer for a
// started run is its record, or one row saying it has none (a run started before they were
// recorded). Fails on the code before it: no record, no keep_numerics, and the rows rebuilt with
// today's writer.
describe('RH3: what a started run was written with', () => {
  const studyIdPath = () => join(layout.findStudy(join(PROJECTS, PID), SID).dir, 'id.json');
  let idBefore = '';
  const studySet = (values) => {
    const doc = JSON.parse(readFileSync(studyIdPath(), 'utf8'));
    for (const [k, v] of Object.entries(values)) {
      if (v === null) delete doc[k];
      else doc[k] = v;
    }
    writeFileSync(studyIdPath(), JSON.stringify(doc));
  };
  const rows = (tag) => [
    { group: 'Schemes', label: 'Gradient limiter', value: `limitedGradU ${tag}`, source: 'preset', preset: 'Robust' },
    { group: 'Stays fixed', label: 'Wall treatment', value: `nut ${tag}`, source: 'fixed' },
  ];
  const restartArg = (out) => JSON.parse(argOf(specOf(out.bodyExtra.runner_job_id), '--restart'));
  /** The worker's run check: rows from the run's numerics as today's writer writes them. */
  const TODAY = [{ group: 'Stays fixed', label: 'Wall treatment', value: 'nut today', source: 'fixed' }];
  beforeEach(() => {
    idBefore = readFileSync(studyIdPath(), 'utf8');
    studySet({ relax_p: 0.3 });
    fx.plan = () => planAnswer({ plan: { ...planAnswer().plan, numerics: rows('at start') } });
    attachWorkerBridge(async (method, params) => {
      if (method === 'analysis.validate_ready') return { ready: true, issues: [] };
      if (method === 'analysis.run_normalize') return { settings: { end_time: 100, write_interval: 50, ...(params && params.settings) } };
      if (method === 'analysis.plan_run') {
        fx.plans.push(params);
        return fx.plan(params);
      }
      if (method === 'analysis.run_check') return { ok: true, checked: true, checks: [], estimate: null, numerics: TODAY };
      return { ok: true };
    });
  });
  afterEach(() => writeFileSync(studyIdPath(), idBefore));

  it("a fresh Start records its plan's rows as what its case is written with, not in prepare_run", async () => {
    const rid = await solvedRun('stopped');
    const doc = runDoc(rid);
    assert.deepEqual(doc.numerics_used.written, rows('at start'));
    assert.equal('numerics' in doc.prepare_run, false);
    // The route answers the record, whatever today's writer would write (the check's rows).
    const pc = await w27.precheckRun(PID, rid, {}, SID);
    assert.deepEqual([pc.ok, pc.numerics, pc.numerics_recorded], [true, rows('at start'), true]);
    // As the case is written now (what a fake Start records): the check's own rows.
    assert.deepEqual((await w27.precheckRun(PID, rid, {}, SID, { asWritten: true })).numerics, TODAY);
  });

  it('a Continue that goes on with what the run had keeps its record and tells the writer to keep its schemes and saved walls', async () => {
    const rid = await solvedRun('stopped');
    const used = runDoc(rid).numerics_used;
    fx.plan = () => planAnswer({ plan: { ...planAnswer().plan, numerics: rows('today') } });
    let { out } = await cont(rid, { extraIterations: 20 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(restartArg(out).keep_numerics, true);
    assert.equal(fx.plans.at(-1).restart.keep_numerics, true);
    assert.deepEqual(runDoc(rid).numerics_used, used);
    endRun(rid, 'stopped');
    // "as_was" after a study change: the same.
    studySet({ relax_p: 0.2 });
    ({ out } = await cont(rid, { extraIterations: 20, numerics: 'as_was' }));
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(restartArg(out).keep_numerics, true);
    assert.deepEqual(runDoc(rid).numerics_used, used);
    assert.deepEqual((await w27.precheckRun(PID, rid, {}, SID)).numerics, rows('at start'));
  });

  it("a Continue with the study's new numerics records that Continue's plan rows, and its case is written afresh", async () => {
    const rid = await solvedRun('stopped');
    studySet({ relax_p: 0.2 });
    fx.plan = () => planAnswer({ plan: { ...planAnswer().plan, numerics: rows('new') } });
    const { out } = await cont(rid, { extraIterations: 20, numerics: 'new' });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal('keep_numerics' in restartArg(out), false);
    const used = runDoc(rid).numerics_used;
    assert.deepEqual([used.values.relax_p, used.written], [0.2, rows('new')]);
    assert.deepEqual((await w27.precheckRun(PID, rid, {}, SID)).numerics, rows('new'));
  });

  it("a Start or a Continue with new numerics whose plan reports no rows records false: the run says its analysis did not report them, never rows rebuilt with today's writer", async () => {
    // An analysis without rows (a third-party one), or one whose rows failed (numerics_error).
    fx.plan = () => planAnswer({ plan: { ...planAnswer().plan, numerics_error: 'no rows' } });
    const rid = await solvedRun('stopped');
    assert.equal(runDoc(rid).numerics_used.written, false);
    let pc = await w27.precheckRun(PID, rid, {}, SID);
    assert.deepEqual([pc.numerics, pc.numerics_recorded, pc.numerics_unrecorded], [w27.NUMERICS_NOT_REPORTED.map((r) => ({ ...r })), false, 'not_reported']);
    assert.match(pc.numerics[0].value, /^This run's analysis did not report what its case was written with, so it is not shown here/);
    // A Continue that keeps its numerics keeps that record.
    fx.plan = () => planAnswer({ plan: { ...planAnswer().plan, numerics: rows('kept') } });
    let { out } = await cont(rid, { extraIterations: 20 });
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    endRun(rid, 'stopped');
    assert.equal(runDoc(rid).numerics_used.written, false);
    // A Continue with the study's new numerics whose plan reports none: false again.
    studySet({ relax_p: 0.2 });
    fx.plan = () => planAnswer({ plan: { ...planAnswer().plan } });
    ({ out } = await cont(rid, { extraIterations: 20, numerics: 'new' }));
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.deepEqual([runDoc(rid).numerics_used.values.relax_p, runDoc(rid).numerics_used.written], [0.2, false]);
    assert.equal((await w27.precheckRun(PID, rid, {}, SID)).numerics_unrecorded, 'not_reported');
    // A run started before rows were recorded says that instead.
    const runJson = join(io.runFolderOf(PID, rid, SID).dir, 'run.json');
    const doc = runDoc(rid);
    const { written: _w, ...older } = doc.numerics_used;
    writeFileSync(runJson, JSON.stringify({ ...doc, numerics_used: older }));
    assert.equal((await w27.precheckRun(PID, rid, {}, SID)).numerics_unrecorded, 'before');
  });

  it('a run started before its rows were recorded says so; one whose rows are being recorded shows them as written now; a draft its study\'s', async () => {
    const rid = await solvedRun('stopped');
    const runJson = join(io.runFolderOf(PID, rid, SID).dir, 'run.json');
    const doc = runDoc(rid);
    const { written: _w, ...older } = doc.numerics_used;
    writeFileSync(runJson, JSON.stringify({ ...doc, numerics_used: older }));
    let pc = await w27.precheckRun(PID, rid, {}, SID);
    assert.deepEqual([pc.numerics, pc.numerics_recorded], [w27.NUMERICS_NOT_RECORDED.map((r) => ({ ...r })), false]);
    assert.match(pc.numerics[0].value, /^This run started before the app recorded what its case was written with, so it is not shown here/);
    writeFileSync(runJson, JSON.stringify({ ...doc, numerics_used: { ...older, written: null } }));
    pc = await w27.precheckRun(PID, rid, {}, SID);
    assert.deepEqual([pc.numerics, 'numerics_recorded' in pc], [TODAY, false]);
    const draft = draftRun();
    pc = await w27.precheckRun(PID, draft, {}, SID);
    assert.deepEqual([pc.numerics, 'numerics_recorded' in pc], [TODAY, false]);
  });
});
