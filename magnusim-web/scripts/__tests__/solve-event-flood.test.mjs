// H15 core bug 1, a core solve's side: the job log no longer held the server, but
// a core solve's own onEvent (w27-solve.js startSolveBody) still cut its output
// tail to 1 MB on every event, copying the whole megabyte each time. A fast core
// case (its relay sends about ten events a time step, one per solver line among
// them) kept the server from answering for the whole solve again, and throttled
// the solver. Here the real onEvent (coreSolveEvents, with the run's tail and live
// progress) takes a core relay's events at a fast case's rate, through spawnJob.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-solveflood-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const { spawnJob } = await import('../job-runner.js');
const { WEB_ROOT } = await import('../python-env.js');
const { RUN_TAIL_CHARS, coreSolveEvents, createRunTail, newProgressState } = await import('../w27-solve.js');

const KIND = 'test-solve-flood';
const ID = `${process.pid}-${Date.now()}`;
after(() => {
  rmSync(join(WEB_ROOT, '.cache', 'logs', KIND), { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

// One pimpleFoam time step as run_solve.py relays it (ten events): two Courant
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

describe("a core solve's onEvent", () => {
  it('keeps the event loop free while a fast case floods it, and keeps the run tail and progress', { timeout: 300_000 }, async () => {
    const steps = 8000; // 2,000 steps a second: about 20,000 events a second for 4 s
    const seen = { wslStart: false, result: false };
    const tail = createRunTail();
    const live = { progress: newProgressState() };
    const saved = [];
    const onEvent = coreSolveEvents({ seen, tail, run: () => live, saved: (run) => saved.push(run.progress.saved_times.at(-1)) });
    let events = 0;
    let lastEvent = null;

    let last = Date.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
      const { child } = spawnJob({
        kind: KIND,
        jobId: `core-${ID}`,
        script: STREAM,
        args: [String(steps), '2000'],
        onEvent: (ev) => {
          events += 1;
          lastEvent = ev;
          onEvent(ev);
        },
      });
      child.on('close', (c) => setImmediate(() => resolve(c)));
    });
    clearInterval(timer);
    worst = Math.max(worst, Date.now() - last);
    const wall = Date.now() - t0;
    console.log(`[core flood] ${events} events in ${wall} ms, longest stall ${worst} ms`);
    assert.equal(code, 0);
    // The bug: about 30 s with no timer at all on this PC (a 1 MB copy per event).
    assert.ok(worst < 1500, `the event loop stalled ${worst} ms while the core run flooded`);
    assert.equal(events, 2 + steps * 10 + steps / 1000 + 1, 'every event reached onEvent');

    // The marks, the live progress and the saved times, as before.
    assert.deepEqual(seen, { wslStart: true, result: true });
    assert.equal(live.progress.stage, 'solve');
    assert.equal(live.progress.series.length + 1, steps, 'every step is in the live progress');
    assert.equal(live.progress.current.t, steps * 0.001);
    assert.deepEqual(saved, Array.from({ length: steps / 1000 }, (_, i) => (i + 1)));
    // The tail: the newest RUN_TAIL_CHARS of the output, ending with the last event.
    const text = tail.text();
    assert.equal(text.length, RUN_TAIL_CHARS);
    assert.ok(text.endsWith(JSON.stringify(lastEvent) + '\n'), text.slice(-200));
    assert.ok(text.includes('ExecutionTime = 4.00 s  ClockTime = 4 s\n'), 'the last solver line is in the tail');
  });

  it('startSolveBody hands spawnJob coreSolveEvents, with the run tail', () => {
    const src = readFileSync(new URL('../w27-solve.js', import.meta.url), 'utf8');
    const start = src.indexOf('async function startSolveBody(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(body.includes('onEvent: coreSolveEvents({'), "startSolveBody's onEvent is coreSolveEvents");
    assert.ok(body.includes('tail: runTail,'), 'with the run tail');
    assert.ok(!/\.slice\(-1024 \* 1024\)/.test(body), 'no per-event 1 MB cut in startSolveBody');
  });
});

describe('createRunTail', () => {
  it('holds exactly the newest characters of the output, solver lines as they came', () => {
    const max = 10_000;
    const tail = createRunTail(max);
    let full = '';
    for (let i = 1; i <= 5000; i++) {
      const ev = i % 3 ? { event: 'residual', seq: i, initial: 1 / i } : { event: 'log', line: `line ${i}` };
      tail.push(ev);
      full += ev.event === 'log' ? `line ${i}\n` : JSON.stringify(ev) + '\n';
      if (i % 997 === 0) assert.equal(tail.text(), full.slice(-max), `after ${i} events`);
    }
    assert.equal(tail.text(), full.slice(-max));
    const short = createRunTail(max);
    short.push({ event: 'log', line: 'only one' });
    assert.equal(short.text(), 'only one\n');
  });
});
