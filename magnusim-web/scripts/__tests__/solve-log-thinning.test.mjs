// H15 core bug 1, the reading side: a run's job log is read back when its live
// progress is thin (a finished run, a run adopted after a restart: w27-solve.js
// enrichRunDoc -> parseSolveProgress). The log now keeps a thinned copy of a fast
// run's steps (job-runner.js createLogThinner), so the progress read back must stay
// what the full log gave. The run is a core solve's real event stream: OpenFOAM
// lines through the analysis's log parser (magnusim_sdk.progress), relayed as
// run_solve.py relays them (stream_events_to_stdout), through spawnJob.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-logthin-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const { createLogThinner, spawnJob } = await import('../job-runner.js');
const { MAX_LOG_BYTES } = await import('../log.js');
const { WEB_ROOT } = await import('../python-env.js');
const { RUN_LOG_READ_MAX, parseSolveProgress, readLogProgress } = await import('../w27-solve.js');

const KIND = 'test-log-thinning';
const ANALYSIS = 'incompressible_transient';
const DT = 0.001;
// Job logs are appended to: this run's own file names.
const ID = `${process.pid}-${Date.now()}`;
after(() => {
  rmSync(join(WEB_ROOT, '.cache', 'logs', KIND), { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

// A pimpleFoam run as solve.sh prints it: its stage, saved-time and result lines,
// and per time step the Courant number, deltaT, Time, three solved fields (p
// twice) and two other lines; a saved time every `every` steps.
const STREAM = join(ROOT, 'core_stream.py');
writeFileSync(
  STREAM,
  `import json, sys
sys.path.insert(0, sys.argv[3])
from cfddesk.wsl.solve_run import stream_events_to_stdout
from magnusim_sdk.progress import ProgressParser
steps, every = int(sys.argv[1]), int(sys.argv[2])
def ev(**f):
    return "MAGNUSIM_EVENT " + json.dumps(f)
def lines():
    yield ev(event="start", run_id="r1", n_procs=1, app="pimpleFoam")
    yield ev(event="stage", stage="copy_to_wsl", t_wall=100.0)
    yield ev(event="stage", stage="solve", parallel=False, app="pimpleFoam", t_wall=101.0)
    yield "Starting time loop"
    for i in range(1, steps + 1):
        t = round(i * ${DT}, 6)
        r = 1.0 / (1.0 + i * 0.003) * (1.0 + 0.2 * ((i * 7919) % 13) / 13.0)
        yield "Courant Number mean: %.6g max: %.6g" % (0.1 + (i % 11) * 0.003, 0.5 + (i % 17) * 0.01)
        yield "deltaT = ${DT}"
        yield "Time = %s" % t
        yield ""
        yield "PIMPLE: iteration 1"
        yield "smoothSolver:  Solving for Ux, Initial residual = %.6g, Final residual = 1e-07, No Iterations 2" % (r * 1.1)
        yield "smoothSolver:  Solving for Uy, Initial residual = %.6g, Final residual = 1e-07, No Iterations 2" % (r * 0.9)
        yield "GAMG:  Solving for p, Initial residual = %.6g, Final residual = 1e-06, No Iterations 7" % (r * 2.0)
        yield "time step continuity errors : sum local = 1e-09, global = 1e-19, cumulative = 1e-18"
        yield "GAMG:  Solving for p, Initial residual = %.6g, Final residual = 1e-07, No Iterations 5" % (r * 0.5)
        yield "ExecutionTime = %.2f s  ClockTime = %d s" % (i * 0.01, i // 100)
        if i % every == 0:
            yield ev(event="time_saved", t=t)
    yield "End"
    yield ev(event="stage", stage="solve_end", exit_code=0, t_wall=150.0)
    yield ev(event="stage", stage="copy", t_wall=151.0)
    yield ev(event="stage", stage="cleanup", t_wall=152.0)
    yield ev(event="result", ok=True, exit_code=0, t_wall=152.5)
class Proc:
    stdout = (line + "\\n" for line in lines())
    def wait(self):
        return 0
stream_events_to_stdout(Proc(), ProgressParser())
`,
);

/** A core run through spawnJob: its events (what the old log held, row for row) and its log. */
function runCore(jobId, steps, every) {
  return new Promise((resolve) => {
    const events = [];
    const { child, jobLog } = spawnJob({
      kind: KIND,
      jobId,
      script: STREAM,
      args: [String(steps), String(every), join(WEB_ROOT, 'python')],
      onEvent: (ev) => events.push(ev),
    });
    child.on('close', (code) => setImmediate(() => resolve({ code, events, path: jobLog.path })));
  });
}

/** The full log: one row per event, as spawnJob wrote it before. */
const fullLog = (events) => events.map((ev) => JSON.stringify({ level: 'info', msg: ev.event, ...ev })).join('\n');

/** A snapshot without its parse time (each parse stamps its own). */
const comparable = (snap) => {
  const rest = { ...snap };
  delete rest.solve_started_at;
  return rest;
};

describe('progress read back from a thinned job log', () => {
  it('a run below the thinning: exactly what the full log gave', { timeout: 180_000 }, async () => {
    const { code, events, path } = await runCore(`core-small-${ID}`, 3000, 100);
    assert.equal(code, 0);
    const text = readFileSync(path, 'utf8');
    assert.ok(!text.includes('"log_thinned"'), 'nothing left out');
    const full = parseSolveProgress(fullLog(events), ANALYSIS);
    assert.equal(full.n_steps, 3000);
    assert.equal(full.residuals.length, 200);
    assert.deepEqual(comparable(parseSolveProgress(text, ANALYSIS)), comparable(full));
  });

  it('a long run: the same stage, time, steps, Courant, saved times and phases; residual points of the same steps', { timeout: 300_000 }, async () => {
    const steps = 30_000;
    const { code, events, path } = await runCore(`core-long-${ID}`, steps, 500);
    assert.equal(code, 0);
    const text = readFileSync(path, 'utf8');
    const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const exit = rows.find((r) => r.msg === 'exit');
    assert.ok(exit.log_thinned && exit.log_thinned.steps === steps && exit.log_thinned.steps_written < steps / 2, JSON.stringify(exit.log_thinned));
    const stride = 1 + Math.max(...rows.map((r) => r.thinned || 0));
    assert.ok(stride >= 4, `the log left out up to ${stride - 1} steps in a row`);

    const full = parseSolveProgress(fullLog(events), ANALYSIS);
    const thin = parseSolveProgress(text, ANALYSIS);
    assert.equal(full.n_steps, steps);
    for (const key of ['stage', 'iteration', 'sim_time', 'n_steps', 'co_max', 'co_mean', 'delta_t', 'live_saved_times', 'phases']) {
      assert.deepEqual(thin[key], full[key], key);
    }
    // 200 points, the first and last the same; each one a step at most half the
    // stride from the full log's, with that step's own values.
    assert.equal(thin.residuals.length, full.residuals.length);
    assert.deepEqual(thin.residuals[0], full.residuals[0]);
    assert.deepEqual(thin.residuals.at(-1), full.residuals.at(-1));
    const stepAt = new Map();
    let cur = null;
    for (const ev of events) {
      if (ev.event === 'progress') {
        cur = { co_mean: ev.co_mean, co_max: ev.co_max };
        stepAt.set(ev.time, cur);
      } else if (ev.event === 'residual' && cur) cur[ev.field] = ev.initial;
    }
    let same = 0;
    for (let i = 0; i < full.residuals.length; i++) {
      const a = thin.residuals[i];
      const b = full.residuals[i];
      if (a.t === b.t) {
        assert.deepEqual(a, b, `point ${i}`);
        same += 1;
        continue;
      }
      assert.ok(Math.abs(a.t - b.t) <= (stride / 2) * DT + 1e-9, `point ${i}: t ${a.t} for ${b.t}`);
      const own = stepAt.get(a.t);
      assert.ok(own, `point ${i} is a step of the run`);
      assert.deepEqual(a, { t: a.t, U: Math.max(own.Ux, own.Uy), p: own.p, co_mean: own.co_mean, co_max: own.co_max }, `point ${i}`);
    }
    // Where the log kept every step (the first part of the run) the points are the same steps.
    assert.ok(same >= 30, `${same} points at the same steps`);
    // Small: the old log (one row per event, as log.js wrote it) was over 3 times larger.
    const oldSize = events.reduce(
      (n, ev) => n + Buffer.byteLength(JSON.stringify({ ts: new Date().toISOString(), kind: KIND, job_id: `core-long-${ID}`, level: 'info', msg: ev.event, ...ev })) + 1,
      0,
    );
    const size = statSync(path).size;
    assert.ok(size * 3 < oldSize, `${size} bytes, the old log ${oldSize}`);
  });

  it('a log over the size bound is not read back (it held the server for seconds)', () => {
    const big = join(ROOT, 'old-run.jsonl');
    writeFileSync(big, '{"event":"progress","time":1,"sim_time":1}\n');
    truncateSync(big, RUN_LOG_READ_MAX + 1);
    assert.equal(readLogProgress(big, ANALYSIS), null);
    const small = join(ROOT, 'run.jsonl');
    writeFileSync(small, '{"event":"stage","stage":"solve"}\n{"event":"progress","time":1,"sim_time":1}\n');
    assert.equal(readLogProgress(small, ANALYSIS).sim_time, 1);
  });

  it('the read bound is a fixed size, and a capped log (with its end rows) is under it', () => {
    assert.ok(RUN_LOG_READ_MAX <= 72 * 1024 * 1024, `RUN_LOG_READ_MAX ${RUN_LOG_READ_MAX}`);
    assert.ok(RUN_LOG_READ_MAX >= MAX_LOG_BYTES + 256 * 1024, 'a capped log is read back');
  });

  it('a run log read again after it grew gives the new progress; an unchanged one the same', () => {
    // enrichRunDoc reads a run's log while its live progress is thin (early in a
    // run), and again once the run has ended: the second read must not be the first.
    const f = join(ROOT, 'growing.jsonl');
    writeFileSync(f, '{"event":"stage","stage":"solve"}\n{"event":"progress","time":1,"sim_time":1}\n');
    const first = readLogProgress(f, ANALYSIS);
    assert.deepEqual([first.sim_time, first.n_steps], [1, 1]);
    appendFileSync(f, '{"event":"progress","time":2,"sim_time":2}\n{"event":"progress","time":3,"sim_time":3}\n');
    const grown = readLogProgress(f, ANALYSIS);
    assert.deepEqual([grown.sim_time, grown.n_steps], [3, 3]);
    const again = readLogProgress(f, ANALYSIS);
    assert.deepEqual(again, grown);
    assert.deepEqual(comparable(again), comparable(parseSolveProgress(readFileSync(f, 'utf8'), ANALYSIS)));
    // Each read is the caller's own copy.
    again.residuals.push({ t: 99 });
    again.sim_time = 99;
    assert.deepEqual(readLogProgress(f, ANALYSIS), grown);
  });

  it('enrichRunDoc reads run logs only through readLogProgress', () => {
    const src = readFileSync(new URL('../w27-solve.js', import.meta.url), 'utf8');
    const start = src.indexOf('function enrichRunDoc(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.ok(body.includes('readLogProgress(logPath'), 'enrichRunDoc reads the log through readLogProgress');
    assert.ok(!/readFileSync\(/.test(body), 'enrichRunDoc reads a whole log file itself');
  });
});

// A job whose output stops right after a step the log leaves out: a solver killed
// or crashed, with no stage or result after its last step. The step it held must
// be in the file: written before the exit row (and onExit) when the output ended
// by then, or when stdout ends for output that comes after the exit.
//   end     the steps, then it ends
//   hang    the steps, then it waits to be killed
//   linger  the steps, then it exits while a child keeps its stdout open 1.5 s
//   late    it exits at once; a child it started sends every step after that
const HELD_STEPS = 30_001;
const HELD = join(ROOT, 'held.cjs');
writeFileSync(
  HELD,
  `const { spawn } = require('node:child_process');
const [mode, steps] = [process.argv[2], Number(process.argv[3])];
function flood() {
  const out = ['MAGNUSIM_EVENT ' + JSON.stringify({ event: 'stage', stage: 'solve' })];
  for (let i = 1; i <= steps; i++) {
    const t = i / 1000;
    out.push('MAGNUSIM_EVENT ' + JSON.stringify({ event: 'courant', mean: 0.1, max: 0.5 }));
    out.push('MAGNUSIM_EVENT ' + JSON.stringify({ event: 'progress', time: t, sim_time: t }));
    out.push('MAGNUSIM_EVENT ' + JSON.stringify({ event: 'residual', time: t, field: 'Ux', initial: 1 / i }));
    out.push('MAGNUSIM_EVENT ' + JSON.stringify({ event: 'residual', time: t, field: 'p', initial: 2 / i }));
  }
  process.stdout.write(out.join('\\n') + '\\n');
}
const child = (args) => spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true }).unref();
if (mode === 'end') {
  flood();
  setTimeout(() => {}, 300);
} else if (mode === 'hang') {
  flood();
  setInterval(() => {}, 1000);
} else if (mode === 'linger') {
  flood();
  setTimeout(() => child(['sleep']), 300);
} else if (mode === 'late') child(['end', String(steps)]);
else if (mode === 'sleep') setTimeout(() => {}, 1500);
`,
);

/**
 * Run held.cjs in `mode` through spawnJob: the file as onExit saw it, and as it
 * is once every pipe has closed.
 */
function runHeld(mode) {
  return new Promise((resolve) => {
    const total = 1 + HELD_STEPS * 4;
    let seen = 0;
    let atExit = null;
    let exitedFirst = false;
    const { child, jobLog } = spawnJob({
      kind: KIND,
      jobId: `held-${mode}-${ID}`,
      python: process.execPath,
      script: HELD,
      args: [mode, String(HELD_STEPS)],
      onEvent: () => {
        seen += 1;
        if (seen === total && mode === 'hang') child.kill();
      },
      onExit: (code, signal) => {
        atExit = { code, signal, seen, text: readFileSync(jobLog.path, 'utf8') };
      },
    });
    child.stdout.once('end', () => {
      exitedFirst = !!atExit;
    });
    child.on('close', () => setImmediate(() => resolve({ atExit, exitedFirst, total, seen, text: readFileSync(jobLog.path, 'utf8') })));
  });
}

/** The last step in a log's text, and the progress read back from it. */
function lastStepOf(text) {
  const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const progress = rows.filter((r) => r.msg === 'progress');
  const snap = parseSolveProgress(text, ANALYSIS);
  return { last: progress.length ? progress[progress.length - 1].time : null, n_steps: snap.n_steps, sim_time: snap.sim_time };
}

describe('a job whose output stops on a step the log left out', () => {
  const full = { last: HELD_STEPS / 1000, n_steps: HELD_STEPS, sim_time: HELD_STEPS / 1000 };

  it('this stream ends on a step the log holds back (so the end is what writes it)', () => {
    const thin = createLogThinner();
    let lastBeforeEnd = false;
    thin.event({ event: 'stage', stage: 'solve' });
    for (let i = 1; i <= HELD_STEPS; i++) {
      const t = i / 1000;
      const rows = [
        ...thin.event({ event: 'courant', mean: 0.1, max: 0.5 }),
        ...thin.event({ event: 'progress', time: t, sim_time: t }),
        ...thin.event({ event: 'residual', time: t, field: 'Ux', initial: 1 / i }),
        ...thin.event({ event: 'residual', time: t, field: 'p', initial: 2 / i }),
      ];
      if (i === HELD_STEPS) lastBeforeEnd = rows.some(([msg, f]) => msg === 'progress' && f.time === t);
    }
    assert.equal(lastBeforeEnd, false);
    assert.ok(thin.end().some(([msg, f]) => msg === 'progress' && f.time === HELD_STEPS / 1000));
  });

  it('it ends: the last step is in the file when onExit runs', { timeout: 120_000 }, async () => {
    const { atExit, total } = await runHeld('end');
    assert.equal(atExit.code, 0);
    assert.equal(atExit.seen, total, 'every event was read before the exit');
    assert.deepEqual(lastStepOf(atExit.text), full);
  });

  it('it is killed: the last step is in the file when onExit runs', { timeout: 120_000 }, async () => {
    const { atExit, total } = await runHeld('hang');
    assert.notEqual(atExit.code, 0);
    assert.equal(atExit.seen, total);
    assert.deepEqual(lastStepOf(atExit.text), full);
  });

  it('it exits while a child keeps its stdout: the last step is in the file when onExit runs', { timeout: 120_000 }, async () => {
    const { atExit, exitedFirst, total } = await runHeld('linger');
    assert.ok(exitedFirst, 'the exit came before stdout ended');
    assert.equal(atExit.seen, total);
    assert.deepEqual(lastStepOf(atExit.text), full);
  });

  it('every step comes after the exit: the last step is in the file once stdout ends', { timeout: 120_000 }, async () => {
    const { atExit, exitedFirst, seen, total, text } = await runHeld('late');
    assert.ok(exitedFirst);
    assert.ok(atExit.seen < total, `the last step came after the exit (${atExit.seen} of ${total} events by then)`);
    assert.equal(seen, total);
    assert.deepEqual(lastStepOf(text), full);
  });
});

describe('createLogThinner', () => {
  it('a very long run: the rows grow with the log of its length', () => {
    const thin = createLogThinner();
    let rows = 0;
    const steps = 400_000;
    for (let i = 1; i <= steps; i++) {
      rows += thin.event({ event: 'courant', mean: 0.1, max: 0.5 }).length;
      rows += thin.event({ event: 'progress', time: i, sim_time: i }).length;
      rows += thin.event({ event: 'residual', field: 'Ux', initial: 1 / i }).length;
      rows += thin.event({ event: 'residual', field: 'p', initial: 2 / i }).length;
      rows += thin.event({ event: 'log', line: 'ExecutionTime' }).length;
    }
    rows += thin.end().length;
    const stats = thin.stats();
    assert.equal(stats.steps, steps);
    // 2,000,000 rows unthinned.
    assert.ok(rows < 200_000, `${rows} rows`);
  });
});
