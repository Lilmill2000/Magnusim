// H15 core bug 1, a core solve's side: the job log no longer held the server, but
// a core solve's own onEvent (then w27-solve.js startSolveBody) cut its output tail
// to 1 MB on every event, copying the whole megabyte each time. A fast core case
// (its relay sends about ten events a time step, one per solver line among them)
// kept the server from answering for the whole solve again, and throttled the
// solver. Core solves run on the step-list runner now (IF Item 7): here a fast
// case's events go through the runner to the 'solve' kind's handler, through spawnJob.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-solveflood-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const { spawnJob } = await import('../job-runner.js');
const { WEB_ROOT } = await import('../python-env.js');
await import('../w27-solve.js');

const KIND = 'test-solve-flood';
const ID = `${process.pid}-${Date.now()}`;
after(() => {
  rmSync(join(WEB_ROOT, '.cache', 'logs', KIND), { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

// One pimpleFoam time step as the relay sends it (ten events): two Courant
// events, the progress event, four residuals and three solver lines (`log`), one line each,
// flushed; a saved time every 1000 steps. `rate` steps a second.
const STREAM = join(ROOT, 'core_flood.py');
writeFileSync(
  STREAM,
  `import json, sys, time
steps, rate = int(sys.argv[1]), float(sys.argv[2])
seq = 0
def emit(ev):
    global seq
    seq += 1
    ev["seq"] = seq
    sys.stdout.write("MAGNUSIM_EVENT " + json.dumps(ev, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
emit({"event": "start", "run_id": "r1", "n_procs": 1, "app": "pimpleFoam"})
emit({"event": "stage", "stage": "solve"})
t0 = time.perf_counter()
for i in range(1, steps + 1):
    t = round(i * 0.001, 6)
    emit({"event": "courant", "mean": 0.12, "max": 0.5})
    emit({"event": "courant", "delta_t": 0.001})
    emit({"event": "progress", "time": t, "sim_time": t, "delta_t": 0.001, "co_max": 0.5, "co_mean": 0.12})
    emit({"event": "log", "line": "PIMPLE: iteration 1"})
    for f, v in (("Ux", 1.1 / i), ("Uy", 0.9 / i), ("p", 2.0 / i)):
        emit({"event": "residual", "time": t, "field": f, "initial": v, "fields": {f: v}})
    emit({"event": "log", "line": "time step continuity errors : sum local = 1e-09, global = 1e-19, cumulative = 1e-18"})
    emit({"event": "residual", "time": t, "field": "p", "initial": 0.5 / i, "fields": {"p": 0.5 / i}})
    emit({"event": "log", "line": "ExecutionTime = %.2f s  ClockTime = %d s" % (i * 0.0005, i // 2000)})
    if i % 1000 == 0:
        emit({"event": "time_saved", "t": t})
    wait = t0 + i / rate - time.perf_counter()
    if wait > 0:
        time.sleep(wait)
emit({"event": "result", "ok": True, "exit_code": 0})
`,
);

// IF Item 7: a core solve on the step-list runner. The same fast case's events go
// through the runner (its fold, at most four progress frames a second) to the 'solve'
// kind's handler (core-solve.js); the server stays free and every step is counted.
describe("a core solve on the runner (kind 'solve')", () => {
  it('keeps the event loop free under a fast case, counts every step and keeps the last residual of each step', { timeout: 300_000 }, async () => {
    const runner = await import('../foam-runner.js');
    const store = await import('../foam-store.js');
    const core = await import('../core-solve.js');
    const layout = await import('../project-layout.js');
    const io = await import('../study-io.js');
    const projects = join(ROOT, 'projects');
    const dir = join(projects, 'pf');
    mkdirSync(dir, { recursive: true });
    const g = layout.createGeometryFolder(dir, { id: 'g1', name: 'Part' });
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'pf', title: 'PF', geometries: [{ id: g.id, name: g.name }] }));
    layout.createStudyFolder(dir, g.id, { id: 's1', name: 'Study 1' });
    const folder = io.persistRun('pf', 's1', { id: 'rf', run_id: 'rf', name: 'Run 1', simulation_id: 's1', status: 'running' });
    const caseDir = join(folder.dir, 'case');
    mkdirSync(caseDir, { recursive: true });
    store.resetFoamStoreForTests({ filePath: join(ROOT, 'foam-cases.json') });
    const steps = 8000; // 2,000 steps a second for 4 s
    let closed;
    const done = new Promise((r) => (closed = r));
    runner.setFoamRunnerDepsForTests({
      // The relay's place: the stream above, through the real spawnJob.
      spawnJob: (opts) => spawnJob({ ...opts, kind: KIND, jobId: `runner-${ID}`, script: STREAM, args: [String(steps), '2000'], onClose: () => {
        opts.onClose();
        closed();
      } }),
      watchWslCaseGone: () => ({ cancel() {} }),
      killWslCase: () => {},
      probeWslCase: async () => 'dead',
      relayAlive: async () => false,
      killRelay: () => {},
      pushComputeNotice: () => {},
      specDir: () => join(ROOT, 'foam-specs'),
      hookNames: () => [],
      slotsHint: () => null,
    });
    const rec = store.createFoamRecord({
      kind: 'solve', project_id: 'pf', run_id: 'rf', run_name: 'Run 1', simulation_id: 's1', plugin: 'incompressible_flow',
      case_base: folder.dir, case_parts: ['case'], case_dir: caseDir, token: 'a1b2c3d4', wsl_case: 'cfddesk-w27-rf',
      wsl_root: '/home/tester/cases', app: 'pimpleFoam',
    });
    let last = Date.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);
    try {
      const out = runner.runFoamSteps({
        job_id: rec.id,
        claim: { kind: 'solve', project_id: 'pf', run_id: 'rf', name: 'Run 1', job_id: rec.id },
        case_base: folder.dir, case_parts: ['case'], case_dir: caseDir, plugin: 'incompressible_flow',
        wsl_case: 'cfddesk-w27-rf', wsl_root: '/home/tester/cases', token: 'a1b2c3d4', prepare: null, pre: [],
        n_procs: 1, slots_hint: null, run_id: 'rf', simulation_id: 's1',
        solver: { app: 'pimpleFoam', keep_frames: 'all', process_names: ['pimpleFoam'], stop_strategy: 'stopAt_writeNow', frame_fields: ['U', 'p'], parallel: 'none', analysis: 'incompressible_transient' },
      });
      assert.deepEqual(out, { ok: true });
      await done;
    } finally {
      clearInterval(timer);
    }
    worst = Math.max(worst, Date.now() - last);
    console.log(`[core runner flood] longest stall ${worst} ms`);
    assert.ok(worst < 1500, `the event loop stalled ${worst} ms while the core run flooded the runner`);
    // The relay is gone with no status file: the run drains, its live progress is whole.
    const live = core.liveSolveOf(rec.id);
    assert.ok(live, 'the run is followed');
    assert.equal(live.stage, 'solve');
    assert.equal(live.steps + 1, steps, 'every closed step is counted (the last is open)');
    assert.equal(live.current.t, steps * 0.001);
    assert.ok(live.series.length < steps, 'frames thinned their points');
    assert.equal(live.step_at.length, live.series.length, 'each point keeps its step number');
    assert.deepEqual(live.saved_times, Array.from({ length: steps / 1000 }, (_, i) => i + 1));
    // Each step's p: the last initial residual of the step (0.5/i), not the largest (2/i).
    for (const row of live.series) {
      const i = Math.round(row.t / 0.001);
      assert.ok(Math.abs(row.p - 0.5 / i) < 1e-12, `step ${i}: p ${row.p}`);
    }
    const doc = JSON.parse(readFileSync(join(folder.dir, 'run.json'), 'utf8'));
    assert.equal(doc.n_saved_times, steps / 1000);
    runner.finishFoam(rec.id, 'stopped', {});
    runner.setFoamRunnerDepsForTests(null);
    rmSync(join(WEB_ROOT, '.cache', 'logs', KIND, `runner-${ID}.jsonl`), { force: true });
  });
});
