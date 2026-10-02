// H15 core bug 1: a fast plugin case kept the app server from answering for its
// whole solve. spawnJob wrote one log row per event with appendFileSync
// (scripts/log.js): a small case's relay sends about ten events a time step,
// thousands of steps a second, and the event loop did nothing else while it ran
// (390 MB of log for one cavity run). Now rows are queued and appended in batches,
// a fast job's rows are thinned (job-runner.js createLogThinner), and a file is
// capped. These tests run a real job that floods events through spawnJob. The
// thinning keeps the end of the output whole (a failing tool's traceback), and
// the cap holds across batches.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-logflood-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const { createLogThinner, spawnJob } = await import('../job-runner.js');
const { MAX_LOG_BYTES, createJobLogger } = await import('../log.js');
const { WEB_ROOT } = await import('../python-env.js');

const KIND = 'test-log-flood';
// Job logs are appended to: this run's own file names.
const ID = `${process.pid}-${Date.now()}`;
after(() => {
  rmSync(join(WEB_ROOT, '.cache', 'logs', KIND), { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

// One time step as the relay sent it (the 20x20 cavity): two Courant events, the
// progress event, four residuals, two solver lines; a saved time every 1000 steps.
// Every event carries `seq`, one line each, flushed (as the relay writes them).
const FLOOD = join(ROOT, 'flood.py');
writeFileSync(
  FLOOD,
  `import json, sys
steps = int(sys.argv[1])
seq = 0
def emit(ev):
    global seq
    seq += 1
    ev["seq"] = seq
    sys.stdout.write("MAGNUSIM_EVENT " + json.dumps(ev, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
emit({"event": "stage", "stage": "solve"})
for i in range(1, steps + 1):
    t = round(i * 0.005, 6)
    emit({"event": "courant", "mean": 0.12, "max": 0.5})
    emit({"event": "courant", "delta_t": 0.005})
    emit({"event": "progress", "time": t, "sim_time": t, "delta_t": 0.005, "co_max": 0.5, "co_mean": 0.12})
    for f, v in (("Ux", 1.1 / i), ("Uy", 0.9 / i), ("p", 2.0 / i), ("p", 0.5 / i)):
        emit({"event": "residual", "time": t, "field": f, "initial": v, "fields": {f: v}})
    emit({"event": "log", "line": "time step continuity errors : sum local = 1e-09, global = 1e-19, cumulative = 1e-18"})
    emit({"event": "log", "line": "ExecutionTime = %.2f s  ClockTime = %d s" % (i * 0.0005, i // 2000)})
    if i % 1000 == 0:
        emit({"event": "time_saved", "t": t})
emit({"event": "result", "ok": True})
`,
);

/** The longest the event loop went without running a 10 ms timer, while `work` ran. */
async function longestStall(work) {
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  try {
    const result = await work();
    return { worst: Math.max(worst, Date.now() - last), result };
  } finally {
    clearInterval(timer);
  }
}

/**
 * Run the flood through spawnJob. `atExit` is what a reader sees right after the
 * job ends (read inside onExit), with the events onEvent had by then; it resolves
 * once every pipe has closed.
 */
function runFlood(jobId, steps) {
  return new Promise((resolve) => {
    const seen = [];
    let atExit = null;
    const { child, jobLog } = spawnJob({
      kind: KIND,
      jobId,
      script: FLOOD,
      args: [String(steps)],
      onEvent: (ev) => seen.push(ev),
      onExit: (code) => {
        atExit = { code, text: readFileSync(jobLog.path, 'utf8'), seen: seen.length };
      },
    });
    child.on('close', () => setImmediate(() => resolve({ seen, atExit, path: jobLog.path })));
  });
}

const rowsOf = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('a job that floods events', () => {
  it('leaves the event loop free; every event reaches onEvent in order; the log is in order, complete at the end and small', { timeout: 300_000 }, async () => {
    const steps = 22_000; // about 200,000 events
    const { worst, result } = await longestStall(() => runFlood(`flood-big-${ID}`, steps));
    const { seen, atExit, path } = result;
    // The bug: about 35 s with no timer at all on this PC (one appendFileSync per event).
    assert.ok(worst < 1500, `the event loop stalled ${worst} ms while the job ran`);

    // Every event reaches onEvent, in order.
    const total = 2 + steps * 9 + Math.floor(steps / 1000);
    assert.equal(seen.length, total);
    assert.ok(seen.every((ev, i) => ev.seq === i + 1), 'onEvent got the events out of order');

    // The file a reader sees right after the job ends: in order, the end there.
    assert.equal(atExit.code, 0);
    const rows = rowsOf(atExit.text);
    assert.equal(rows[0].msg, 'spawn');
    const seqs = rows.filter((r) => r.seq !== undefined).map((r) => r.seq);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'log rows out of order');
    const exit = rows[rows.length - 1];
    assert.equal(exit.msg, 'exit');
    if (atExit.seen === total) {
      assert.equal(rows[rows.length - 2].msg, 'result', 'the last event is in the file when onExit runs');
    }
    // Thinned: every step counted, the last step and the step before each saved time there.
    assert.deepEqual(
      { steps: exit.log_thinned.steps, lines: exit.log_thinned.lines },
      { steps, lines: steps * 2 },
    );
    assert.ok(exit.log_thinned.steps_written < steps * 0.6, JSON.stringify(exit.log_thinned));
    // Solver lines: the first 10,000, then one in 100 of the steps written (not none).
    const logRows = rows.filter((r) => r.msg === 'log').length;
    assert.equal(logRows, exit.log_thinned.lines_written);
    assert.ok(logRows > 10_000 + 20 && logRows < 10_000 + (steps * 2 - 10_000) / 100, `${logRows} solver lines written`);
    const progress = rows.filter((r) => r.msg === 'progress');
    assert.equal(progress.length, exit.log_thinned.steps_written);
    assert.equal(progress.length + progress.reduce((n, r) => n + (r.thinned || 0), 0), steps, 'thinned counts add up to every step');
    assert.equal(progress[progress.length - 1].time, Math.round(steps * 0.005 * 1e6) / 1e6, 'the last step is in the file');
    let lastStep = null;
    let savedTimes = 0;
    for (const r of rows) {
      if (r.msg === 'progress') lastStep = r;
      if (r.msg !== 'time_saved') continue;
      savedTimes += 1;
      assert.equal(lastStep && lastStep.time, r.t, 'the step before a saved time is in the file');
    }
    assert.equal(savedTimes, Math.floor(steps / 1000));
    // Smaller than the old log (one row per event: about 40 MB here, 390 MB for a
    // 200,000-step run), and growing slower the longer the run.
    const size = statSync(path).size;
    const oldSize = seen.reduce(
      (n, ev) => n + Buffer.byteLength(JSON.stringify({ ts: new Date().toISOString(), kind: KIND, job_id: `flood-big-${ID}`, level: 'info', msg: ev.event, ...ev })) + 1,
      0,
    );
    console.log(`[flood] ${seen.length} events, stall ${worst} ms, log ${size} bytes (old ${oldSize}), ${JSON.stringify(exit.log_thinned)}`);
    assert.ok(size * 1.8 < oldSize, `log is ${size} bytes, the old one ${oldSize}`);
  });

  it('a job below the thinning: every event has its row, in order, when onExit runs', { timeout: 120_000 }, async () => {
    const { seen, atExit } = await runFlood(`flood-small-${ID}`, 300);
    assert.equal(seen.length, 2 + 300 * 9);
    const rows = rowsOf(atExit.text);
    const seqs = rows.filter((r) => r.seq !== undefined).map((r) => r.seq);
    // Everything onEvent had by the exit is in the file, in order.
    assert.deepEqual(seqs.slice(0, atExit.seen), Array.from({ length: atExit.seen }, (_, i) => i + 1));
    assert.equal(rows[rows.length - 1].msg, 'exit');
    assert.equal(rows[rows.length - 1].log_thinned, undefined);
    assert.equal(rows.filter((r) => r.thinned).length, 0);
  });

  it('a job that prints a lot, then fails: its traceback is in the log when onExit runs', { timeout: 120_000 }, async () => {
    // A plugin tool (or run_solve.py, whose stderr only this log keeps) printing
    // past the thinning, then raising. The thinning kept 1 line in 100 to the end,
    // so the traceback was lost.
    const tool = join(ROOT, 'fails.py');
    writeFileSync(
      tool,
      `for i in range(1, 12001):
    print("working on item %d" % i, flush=True)
def boom():
    raise RuntimeError("the plugin tool failed: bad input in case.json")
boom()
`,
    );
    const atExit = await new Promise((resolve) => {
      const { jobLog } = spawnJob({
        kind: KIND,
        jobId: `fails-${ID}`,
        script: tool,
        onExit: (code) => resolve({ code, text: readFileSync(jobLog.path, 'utf8') }),
      });
    });
    assert.equal(atExit.code, 1);
    const rows = rowsOf(atExit.text);
    const exit = rows[rows.length - 1];
    assert.equal(exit.msg, 'exit');
    const out = rows.filter((r) => r.msg === 'stdout').map((r) => r.line);
    // The traceback (stderr), whole. It can be read before the end of stdout.
    const tb = out.filter((line) => !line.startsWith('working on item '));
    assert.equal(tb[0], 'Traceback (most recent call last):', JSON.stringify(tb));
    assert.ok(tb.some((line) => line.includes(', in boom')), JSON.stringify(tb));
    assert.equal(tb.at(-1), 'RuntimeError: the plugin tool failed: bad input in case.json');
    // stdout thinned (the first 10,000 lines, then one in 100), its last 256 lines whole.
    assert.equal(exit.log_thinned.lines, 12_000 + tb.length);
    assert.equal(exit.log_thinned.lines_written, out.length);
    const items = out.filter((line) => line.startsWith('working on item ')).map((line) => Number(line.slice(16)));
    assert.ok(items.length < 10_400, `${items.length} of 12000 stdout lines written`);
    assert.deepEqual(items.slice(-256), Array.from({ length: 256 }, (_, i) => 11_745 + i));
    assert.ok(items.every((n, i) => i === 0 || n > items[i - 1]), 'stdout lines in order');
  });
});

describe('createLogThinner: output lines', () => {
  const lineOf = ([msg, fields]) => (msg === 'stdout' ? Number(fields.line.slice(1)) : msg);

  it('the first linesFull, then one in linesEvery; the last tailLines after the last other row, whole', () => {
    const thin = createLogThinner();
    const got = [];
    for (let n = 1; n <= 15_000; n++) got.push(...thin.line(`l${n}`).map(lineOf));
    got.push(...thin.event({ event: 'stage', stage: 'solve' }).map(lineOf));
    for (let n = 15_001; n <= 30_000; n++) got.push(...thin.line(`l${n}`).map(lineOf));
    got.push(...thin.end().map(lineOf));
    const want = [];
    for (let n = 1; n <= 15_000; n++) if (n <= 10_000 || n % 100 === 0) want.push(n);
    want.push('stage');
    for (let n = 15_001; n <= 30_000; n++) if (n % 100 === 0 || n > 30_000 - 256) want.push(n);
    assert.deepEqual(got, want);
    assert.deepEqual(thin.stats(), { steps: 0, steps_written: 0, lines: 30_000, lines_written: want.length - 1 });
  });

  it("a left-out step's newest lines are kept, with the step, at the end", () => {
    // Full rows for 4 steps (progress, residual), then one step in 2: step 5 is left out.
    const thin = createLogThinner({ stepRowsFull: 8, stepRowsOctave: 1000 });
    const rows = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(...thin.event({ event: 'progress', time: i }));
      rows.push(...thin.event({ event: 'residual', time: i, field: 'p', initial: 1 / i }));
    }
    for (let n = 1; n <= 1000; n++) rows.push(...thin.line(`l${n}`));
    assert.equal(rows.length, 8, 'step 5 and its lines wait');
    const end = thin.end();
    assert.deepEqual(end.slice(0, 2).map(([msg, f]) => [msg, f.time]), [['progress', 5], ['residual', 5]]);
    assert.deepEqual(end.slice(2).map(lineOf), Array.from({ length: 256 }, (_, i) => 745 + i));
  });

  it("stderr lines are no step's: read during a left-out step, before the rest of stdout, they are still written", () => {
    // A traceback on stderr is read while stdout still holds the solver's last steps.
    const thin = createLogThinner({ stepRowsFull: 8, stepRowsOctave: 1000 });
    const rows = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(...thin.event({ event: 'progress', time: i }));
      rows.push(...thin.event({ event: 'residual', time: i, field: 'p', initial: 1 / i }));
    }
    for (const line of ['eTraceback', 'eFile', 'eRuntimeError']) rows.push(...thin.line(line, 'stderr'));
    for (let i = 6; i <= 9; i++) {
      rows.push(...thin.event({ event: 'progress', time: i }));
      rows.push(...thin.event({ event: 'residual', time: i, field: 'p', initial: 1 / i }));
    }
    rows.push(...thin.end());
    const lines = rows.filter(([msg]) => msg === 'stdout').map(([, f]) => f.line);
    assert.deepEqual(lines, ['eTraceback', 'eFile', 'eRuntimeError']);
    // Past linesFull, stderr's last tailLines are written whole at the end.
    const many = createLogThinner({ linesFull: 10, tailLines: 5 });
    const got = [];
    for (let n = 1; n <= 300; n++) got.push(...many.line(`l${n}`, n > 290 ? 'stderr' : 'stdout'));
    got.push(...many.event({ event: 'stage', stage: 'solve' }));
    got.push(...many.end());
    // stdout: 1-10, then 1 in 100 (its tail, 286-290, thinned before the stage row);
    // stderr waits in its own tail: its last 5 lines, at the end.
    assert.deepEqual(got.map(lineOf), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 200, 'stage', 296, 297, 298, 299, 300]);
  });
});

describe('job log files (log.js)', () => {
  it('a capped file says so and still gets the end rows, in order', () => {
    const log = createJobLogger(KIND, `capped-${ID}`, { maxBytes: 64 * 1024 });
    for (let i = 1; i <= 2000; i++) log.info('residual', { event: 'residual', seq: i });
    log.warn('late_warning', { seq: 2001 });
    log.info('exit', { code: 1, seq: 2002 });
    log.flush();
    const text = readFileSync(log.path, 'utf8');
    assert.ok(Buffer.byteLength(text) < 64 * 1024 + 4096, `${Buffer.byteLength(text)} bytes`);
    const rows = rowsOf(text);
    assert.equal(rows.filter((r) => r.msg === 'log_capped').length, 1);
    const capped = rows.findIndex((r) => r.msg === 'log_capped');
    assert.deepEqual(rows.slice(capped + 1).map((r) => r.msg), ['late_warning', 'exit']);
    assert.ok(rows[rows.length - 1].dropped_rows > 1000);
    const seqs = rows.filter((r) => r.seq !== undefined).map((r) => r.seq);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  });

  it('a cap above the batch size holds across batches: one capped row, then only the end rows', () => {
    const max = 1024 * 1024; // four 256 KB batches are written before the cap
    const log = createJobLogger(KIND, `capped-big-${ID}`, { maxBytes: max });
    const pad = 'x'.repeat(200);
    for (let i = 1; i <= 20_000; i++) log.info('residual', { event: 'residual', seq: i, pad });
    log.warn('late_warning', { seq: 20_001 });
    log.info('exit', { code: 0, seq: 20_002 });
    log.flush();
    const size = statSync(log.path).size;
    assert.ok(size <= max + 4096 && size > max - 1024, `${size} bytes for a ${max}-byte cap (5 MB of rows)`);
    const rows = rowsOf(readFileSync(log.path, 'utf8'));
    assert.equal(rows.filter((r) => r.msg === 'log_capped').length, 1);
    const capped = rows.findIndex((r) => r.msg === 'log_capped');
    assert.deepEqual(rows.slice(capped + 1).map((r) => r.msg), ['late_warning', 'exit']);
    assert.equal(rows.at(-1).dropped_rows, 20_000 - capped, 'every row before the cap is a residual; the rest were dropped');
  });

  it('a logger made without a size is capped at MAX_LOG_BYTES, which stays 64 MB at most', () => {
    assert.ok(MAX_LOG_BYTES > 0 && MAX_LOG_BYTES <= 64 * 1024 * 1024, `MAX_LOG_BYTES ${MAX_LOG_BYTES}`);
    const log = createJobLogger(KIND, `default-cap-${ID}`);
    const pad = 'y'.repeat(1024 * 1024);
    const rows = Math.ceil(MAX_LOG_BYTES / pad.length) + 8;
    try {
      for (let i = 1; i <= rows; i++) log.info('big', { seq: i, pad });
      log.info('exit', { code: 0 });
      log.flush();
      const size = statSync(log.path).size;
      assert.ok(size <= MAX_LOG_BYTES + 4096 && size > MAX_LOG_BYTES - 2 * pad.length, `${size} bytes`);
      const fd = openSync(log.path, 'r');
      const end = Buffer.alloc(1024);
      readSync(fd, end, 0, end.length, size - end.length);
      closeSync(fd);
      const last = end.toString('utf8').trim().split('\n').slice(-2).map((line) => JSON.parse(line));
      assert.deepEqual(last.map((r) => r.msg), ['log_capped', 'exit']);
      assert.equal(last[0].max_bytes, MAX_LOG_BYTES);
    } finally {
      rmSync(log.path, { force: true });
    }
  });

  it('queued rows reach the file within a few batch periods, without flush() or an exit', async () => {
    const log = createJobLogger(KIND, `timer-${ID}`);
    for (let i = 1; i <= 50; i++) log.info('progress', { seq: i });
    await new Promise((r) => setTimeout(r, 600));
    const rows = existsSync(log.path) ? rowsOf(readFileSync(log.path, 'utf8')) : [];
    assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('two loggers of one file keep the order rows were written in', () => {
    const a = createJobLogger(KIND, `shared-${ID}`);
    const b = createJobLogger(KIND, `shared-${ID}`);
    for (let i = 1; i <= 200; i += 2) {
      a.info('a', { seq: i });
      b.info('b', { seq: i + 1 });
    }
    b.flush();
    const seqs = rowsOf(readFileSync(a.path, 'utf8')).map((r) => r.seq);
    assert.deepEqual(seqs, Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it('rows still queued are written when the process exits', () => {
    const code = `const { createJobLogger } = await import(${JSON.stringify(pathToFileURL(join(WEB_ROOT, 'scripts', 'log.js')).href)});
const log = createJobLogger(${JSON.stringify(KIND)}, ${JSON.stringify(`at-exit-${ID}`)});
for (let i = 1; i <= 1000; i++) log.info('row', { seq: i });
process.exit(0);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const rows = rowsOf(readFileSync(join(WEB_ROOT, '.cache', 'logs', KIND, `at-exit-${ID}.jsonl`), 'utf8'));
    assert.equal(rows.length, 1000);
    assert.equal(rows[999].seq, 1000);
  });
});
