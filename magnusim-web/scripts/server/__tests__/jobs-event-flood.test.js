// H15 core bug 1, a plugin job's side: JobManager wrote the whole job file (its
// last 400 events, pretty-printed) for every event a job sent, so a plugin job that
// sends events as fast as a small solver case does kept the server from answering.
// Now a running job's events are written at most every EVENT_PERSIST_MS, its end
// at once. The job here is a real Python process started by spawnPython; it runs
// several EVENT_PERSIST_MS periods, so the periodic write is what is checked.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_PERSIST_MS, JobManager } from '../jobs.ts';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KIND = 'test-jobs-flood';
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-jobsflood-'));
after(() => {
  rmSync(join(WEB, '.cache', 'logs', KIND), { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

// Nine events a time step (two Courant, progress, four residuals, two solver
// lines), each with `seq`, one line each, flushed; `rate` steps a second.
const FLOOD = join(ROOT, 'flood.py');
writeFileSync(
  FLOOD,
  `import json, sys, time
steps, rate = int(sys.argv[1]), float(sys.argv[2])
seq = 0
def emit(ev):
    global seq
    seq += 1
    ev["seq"] = seq
    sys.stdout.write("MAGNUSIM_EVENT " + json.dumps(ev, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
t0 = time.perf_counter()
for i in range(1, steps + 1):
    t = round(i * 0.005, 6)
    emit({"event": "courant", "mean": 0.12, "max": 0.5})
    emit({"event": "courant", "delta_t": 0.005})
    emit({"event": "progress", "time": t, "sim_time": t})
    for f in ("Ux", "Uy", "p", "p"):
        emit({"event": "residual", "time": t, "field": f, "initial": 1.0 / i})
    emit({"event": "log", "line": "time step continuity errors : sum local = 1e-09"})
    emit({"event": "log", "line": "ExecutionTime = 1 s  ClockTime = 1 s"})
    wait = t0 + i / rate - time.perf_counter()
    if wait > 0:
        time.sleep(wait)
`,
);

test('a plugin job that floods events leaves the event loop free; its file follows it while it runs and ends with its last events', { timeout: 300_000 }, async () => {
  const steps = 8000; // 2,000 steps a second: about 18,000 events a second for 4 s
  // Each write of the job file (the app server also hands it to the worker each time).
  let persists = 0;
  const jobs = new JobManager({ cacheDir: join(ROOT, 'cache'), onPersist: () => (persists += 1) });
  const job = jobs.create(KIND, { project_id: 'p1' }, 'p1');
  const file = join(ROOT, 'cache', 'jobs', `${job.id}.json`);
  let seen = 0;
  let lastSeq = 0;
  jobs.onEvents(job.id).on('event', (ev) => {
    seen += 1;
    if (ev && ev.seq !== undefined) lastSeq = ev.seq;
  });
  /** [time, the newest seq seen by then], every 10 ms. */
  const history = [];
  /** The job file read while the job runs: [when, the seq seen then, the file's newest seq, its status]. */
  const reads = [];
  let last = Date.now();
  let worst = 0;
  let firstAt = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
    history.push([now, lastSeq]);
    if (lastSeq && !firstAt) firstAt = now;
    // From two EVENT_PERSIST_MS periods in, every 250 ms while it runs.
    if (firstAt && now - firstAt > 2 * EVENT_PERSIST_MS && (!reads.length || now - reads[reads.length - 1][0] >= 250) && lastSeq < steps * 9) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const own = saved.events.filter((ev) => ev.seq !== undefined).map((ev) => ev.seq);
      reads.push([now, lastSeq, own.length ? own[own.length - 1] : 0, saved.status]);
    }
  }, 10);
  const t0 = Date.now();
  const child = jobs.spawnPython(job.id, FLOOD, [String(steps), '2000']);
  await new Promise((done) => child.on('close', () => setImmediate(done)));
  clearInterval(timer);
  const wall = Date.now() - t0;
  worst = Math.max(worst, Date.now() - last);
  console.log(`[jobs flood] ${seen} events in ${wall} ms, stall ${worst} ms, ${persists} file writes, ${reads.length} reads while it ran`);
  // One write per EVENT_PERSIST_MS while it runs (plus its creation, start and end), not one per event.
  assert.ok(persists <= Math.ceil(wall / EVENT_PERSIST_MS) + 8, `${persists} job file writes in ${wall} ms`);
  // The bug: no timer for most of a minute (one file write of ~100 KB per event).
  assert.ok(worst < 1500, `the event loop stalled ${worst} ms while the job ran`);
  assert.equal(seen, 1 + steps * 9 + 1, 'start, every event of the job, its end');

  // While it ran, the file held its recent events: never older than about
  // EVENT_PERSIST_MS (with room for a slow PC), and it said running.
  assert.ok(reads.length >= 4, `${reads.length} reads while the job ran`);
  for (const [at, , inFile, status] of reads) {
    assert.equal(status, 'running');
    const before = history.filter(([t]) => t <= at - EVENT_PERSIST_MS - 750);
    const due = before.length ? before[before.length - 1][1] : 0;
    assert.ok(inFile >= due && inFile > 0, `the job file held seq ${inFile}; seq ${due} had come ${EVENT_PERSIST_MS + 750} ms before`);
  }

  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.status, 'done');
  assert.equal(saved.events.length, 400);
  const own = saved.events.filter((ev) => ev.seq !== undefined).map((ev) => ev.seq);
  assert.equal(own.at(-1), steps * 9, "the job's last event is in its file");
  assert.ok(saved.events.some((ev) => ev.event === 'result' && ev.status === 'done'));
});
