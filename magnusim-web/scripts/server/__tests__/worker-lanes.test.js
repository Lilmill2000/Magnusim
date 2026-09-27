import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerClient, isDataLaneMethod } from '../worker.ts';

// A stand-in for `python -m cfddesk.worker`: answers in order, one at a time,
// and takes `sleep` seconds on the slow volume/CAD methods.
const FAKE_WORKER = `
import json, os, sys, time
seen = set()
for line in sys.stdin:
    req = json.loads(line)
    m = req["method"]
    # "drop": the first copy of this request is lost on the way in (never answered).
    if (req.get("params") or {}).get("drop") and req["id"] not in seen:
        seen.add(req["id"])
        continue
    if m.startswith("cad.") or (m.startswith("filter.") and m != "filter.validate"):
        time.sleep(float((req.get("params") or {}).get("sleep", 0)))
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": {"method": m, "pid": os.getpid()}}) + "\\n")
    sys.stdout.flush()
`;

describe('worker lanes', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'magnusim-worker-lanes-'));
    mkdirSync(join(dir, 'cfddesk', 'worker'), { recursive: true });
    writeFileSync(join(dir, 'cfddesk', '__init__.py'), '');
    writeFileSync(join(dir, 'cfddesk', 'worker', '__init__.py'), '');
    writeFileSync(join(dir, 'cfddesk', 'worker', '__main__.py'), FAKE_WORKER);
  });
  // Killed workers can hold their cwd for a moment on Windows.
  after(async () => {
    for (let i = 0; ; i += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (i >= 50) throw err;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });

  it('sends volume and CAD calls to the data lane, project calls to the main worker', () => {
    for (const m of ['filter.case_field', 'filter.particle_trace', 'filter.warmup_volume', 'filter.release_volume', 'cad.preview']) {
      assert.equal(isDataLaneMethod(m), true, m);
    }
    for (const m of ['runs.upsert', 'project.tree', 'filter.validate', 'mesh.set', 'project.hydrate']) {
      assert.equal(isDataLaneMethod(m), false, m);
    }
  });

  it('a run sidecar write does not wait behind a slow field export', async () => {
    const worker = new WorkerClient({
      cwd: dir,
      timeoutMs: 1500,
      dataLane: new WorkerClient({ cwd: dir, name: 'data-worker' }),
    });
    try {
      const slow = worker.call('filter.case_field', { sleep: 4 }, 10_000);
      const t0 = Date.now();
      const write = await worker.call('runs.upsert', { run_id: 'r1' });
      assert.equal(write.method, 'runs.upsert');
      assert.ok(Date.now() - t0 < 1500, 'runs.upsert answered while the export was still running');
      const exported = await slow;
      assert.notEqual(exported.pid, write.pid, 'export ran in a separate process');
    } finally {
      worker.stop();
    }
  });

  it('a registry change reloads the data lane too, once it is running', async () => {
    const lane = new WorkerClient({ cwd: dir, name: 'data-worker' });
    const seen = [];
    const call = lane.call.bind(lane);
    lane.call = (m, p, t) => {
      seen.push(m);
      return call(m, p, t);
    };
    const worker = new WorkerClient({ cwd: dir, dataLane: lane });
    try {
      await worker.call('plugins.disable', { key: 'x' });
      assert.deepEqual(seen, [], 'an idle data lane is not started just to reload');
      await worker.call('filter.case_field', {});
      await worker.call('plugins.enable', { key: 'x' });
      assert.deepEqual(seen, ['filter.case_field', 'registry.reload']);
    } finally {
      worker.stop();
    }
  });

  it('without a data lane the same write times out and names the call holding the worker', async () => {
    const worker = new WorkerClient({ cwd: dir, timeoutMs: 1500 });
    try {
      await worker.call('worker.ping');
      const slow = worker.call('filter.case_field', { sleep: 3 }, 10_000);
      await assert.rejects(worker.call('runs.upsert', { run_id: 'r1' }), /worker RPC timeout: runs\.upsert .*busy with filter\.case_field/);
      await slow;
    } finally {
      worker.stop();
    }
  });

  it('a request the worker never received is sent again once a later one is answered', async () => {
    const lane = new WorkerClient({ cwd: dir, name: 'data-worker', timeoutMs: 20_000 });
    try {
      await lane.call('worker.ping');
      const t0 = Date.now();
      const lost = lane.call('filter.case_field', { drop: true });
      const later = await lane.call('filter.case_field', {});
      assert.equal(later.method, 'filter.case_field');
      const got = await lost;
      assert.equal(got.method, 'filter.case_field');
      assert.ok(Date.now() - t0 < 5000, 'answered after a resend, not at the timeout');
    } finally {
      lane.stop();
    }
  });

  it('a lost request with nothing sent after it is found by a ping and sent again', async () => {
    const lane = new WorkerClient({ cwd: dir, name: 'data-worker', timeoutMs: 20_000 });
    try {
      await lane.call('worker.ping');
      const t0 = Date.now();
      const got = await lane.call('filter.case_field', { drop: true });
      assert.equal(got.method, 'filter.case_field');
      assert.ok(Date.now() - t0 < 8000, 'answered after the probe, not at the timeout');
    } finally {
      lane.stop();
    }
  });

  it('a data lane call that never answers restarts that worker, so later calls are not stuck behind it', async () => {
    const lane = new WorkerClient({ cwd: dir, name: 'data-worker', restartOnTimeout: true, backoffMs: [50] });
    try {
      const first = await lane.call('filter.case_field', {});
      // Stuck far past its timeout (a result file rewritten under the reader).
      await assert.rejects(lane.call('filter.case_field', { sleep: 60 }, 800), /worker RPC timeout: filter\.case_field/);
      const t0 = Date.now();
      const next = await lane.call('filter.case_field', {}, 10_000);
      assert.ok(Date.now() - t0 < 8000, 'the next export did not wait out the stuck one');
      assert.notEqual(next.pid, first.pid, 'a fresh worker process answered');
    } finally {
      lane.stop();
    }
  });
});
