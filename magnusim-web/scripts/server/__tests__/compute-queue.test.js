import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetComputeQueueForTests,
  enqueueComputeJob,
  mergeComputeQueueItems,
  removeComputeJob,
  dropComputeJobsForMesh,
  reorderComputeQueue,
  snapshotComputeQueue,
  kickComputeQueue,
  startResultFromEngine,
  queueKickAfterStart,
  queueHasMeshDepViolation,
  enqueueMeshWhenBusy,
  computeQueueFileFor,
} from '../compute-queue.ts';

process.env.MAGNUSIM_QUEUE_QUIET = '1';

const dir = mkdtempSync(join(tmpdir(), 'cfd-compute-queue-'));
const filePath = join(dir, 'compute-queue.json');

function mesh(id, extra = {}) {
  return { kind: 'mesh', mesh_id: id, project_id: extra.project_id || 'p1', name: extra.name || id, ...extra };
}

function solve(id, extra = {}) {
  return {
    kind: 'solve',
    run_id: id,
    mesh_id: extra.mesh_id || 'm1',
    project_id: extra.project_id || 'p1',
    name: extra.name || id,
    ...extra,
  };
}

beforeEach(() => {
  resetComputeQueueForTests({ filePath, items: [], deps: {} });
});

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('compute-queue persist', () => {
  it('round-trips items through the disk file', () => {
    enqueueComputeJob(mesh('m1'));
    enqueueComputeJob(solve('r1', { mesh_id: 'm1' }));
    resetComputeQueueForTests({ filePath, reload: true, deps: {} });
    const snap = snapshotComputeQueue();
    assert.equal(snap.items.length, 2);
    assert.equal(snap.items[0].mesh_id, 'm1');
    assert.equal(snap.items[1].run_id, 'r1');
  });
});

describe('compute-queue order', () => {
  it('puts a mesh generate before solves that use it', () => {
    enqueueComputeJob(solve('r1', { mesh_id: 'm1' }));
    enqueueComputeJob(mesh('m1'));
    assert.deepEqual(
      snapshotComputeQueue().items.map((r) => r.kind + ':' + (r.kind === 'mesh' ? r.mesh_id : r.run_id)),
      ['mesh:m1', 'solve:r1'],
    );
  });

  it('rejects a drag that puts a run above its mesh', () => {
    enqueueComputeJob(mesh('m1'));
    enqueueComputeJob(solve('r1', { mesh_id: 'm1' }));
    const ids = snapshotComputeQueue().items.map((r) => r.id).reverse();
    const next = reorderComputeQueue(ids);
    assert.equal(next.ok, false);
    assert.equal(snapshotComputeQueue().items[0].kind, 'mesh');
  });

  it('merge leftover session shards without duplicating', () => {
    enqueueComputeJob(mesh('m1'));
    mergeComputeQueueItems([mesh('m1'), mesh('m2')]);
    assert.deepEqual(
      snapshotComputeQueue().items.map((r) => r.mesh_id),
      ['m1', 'm2'],
    );
  });

  it('drops a deleted mesh and solves waiting on it', () => {
    enqueueComputeJob(mesh('m1'));
    enqueueComputeJob(solve('r1', { mesh_id: 'm1' }));
    enqueueComputeJob(mesh('m2'));
    dropComputeJobsForMesh('m1');
    assert.deepEqual(
      snapshotComputeQueue().items.map((r) => r.mesh_id),
      ['m2'],
    );
  });

  it('refuses a solve enqueue when no fluid is assigned', () => {
    const out = enqueueComputeJob(solve('r1'), { hasMaterial: false });
    assert.equal(out.ok, false);
    assert.match(String(out.error), /Assign a fluid/);
    assert.equal(snapshotComputeQueue().items.length, 0);
  });
});

describe('compute-queue kick', () => {
  it('does not start while a job is live', async () => {
    let started = 0;
    resetComputeQueueForTests({
      filePath,
      items: [mesh('m1')],
      deps: {
        isBusy: () => true,
        startMesh: () => {
          started += 1;
          return { ok: true };
        },
      },
    });
    await kickComputeQueue();
    assert.equal(started, 0);
    assert.equal(snapshotComputeQueue().items.length, 1);
  });

  it('dequeues after a successful start that takes the slot', async () => {
    let busy = false;
    resetComputeQueueForTests({
      filePath,
      items: [mesh('m1'), mesh('m2')],
      deps: {
        isBusy: () => busy,
        startMesh: () => {
          busy = true;
          return { ok: true };
        },
      },
    });
    await kickComputeQueue();
    assert.deepEqual(
      snapshotComputeQueue().items.map((r) => r.mesh_id),
      ['m2'],
    );
  });

  it('a job that still cannot start after its retries leaves the queue with its reason, and the next one starts', async () => {
    // Holding it at the head forever stalled every job behind it in every
    // project, with the slot idle and nothing telling the user why.
    let busy = false;
    let refusals = 0;
    const started = [];
    resetComputeQueueForTests({
      filePath,
      holdRetryMs: 5,
      items: [solve('r-bad', { mesh_id: 'm-ungenerated' }), mesh('m2', { project_id: 'p2' })],
      deps: {
        isBusy: () => busy,
        startSolve: () => {
          refusals += 1;
          return { ok: false, error: 'Generate "Fine" before using it on a run' };
        },
        startMesh: (item) => {
          started.push(item.mesh_id);
          busy = true;
          return { ok: true };
        },
      },
    });
    await kickComputeQueue();
    assert.deepEqual(started, [], 'first refusal keeps its place and retries');
    assert.deepEqual(snapshotComputeQueue().items.map((r) => r.run_id || r.mesh_id), ['r-bad', 'm2']);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(refusals, 4);
    assert.deepEqual(started, ['m2']);
    const snap = snapshotComputeQueue();
    assert.deepEqual(snap.items, []);
    assert.equal(snap.failed.length, 1);
    assert.equal(snap.failed[0].run_id, 'r-bad');
    assert.match(snap.failed[0].error, /Generate "Fine"/);
    assert.deepEqual(snapshotComputeQueue('p1').failed.map((f) => f.run_id), ['r-bad']);
    assert.deepEqual(snapshotComputeQueue('p2').failed, []);
  });

  it('a run refused for a moment right after its mesh finished starts on a retry', async () => {
    let meshReady = false;
    const started = [];
    resetComputeQueueForTests({
      filePath,
      holdRetryMs: 5,
      items: [solve('r1', { mesh_id: 'm1' }), mesh('m9')],
      deps: {
        isBusy: () => started.length > 0,
        startSolve: (item) => {
          if (!meshReady) return { ok: false, error: 'Generate "m1" before using it on a run' };
          started.push(item.run_id);
          return { ok: true };
        },
        startMesh: (item) => {
          started.push(item.mesh_id);
          return { ok: true };
        },
      },
    });
    await kickComputeQueue();
    meshReady = true;
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(started, ['r1']);
    assert.deepEqual(snapshotComputeQueue().failed, []);
  });

  it('a kick from one project still starts the head of the whole queue', async () => {
    const started = [];
    resetComputeQueueForTests({
      filePath,
      items: [mesh('mA', { project_id: 'pA' }), mesh('mB', { project_id: 'pB' })],
      deps: {
        isBusy: () => started.length > 0,
        startMesh: (item) => {
          started.push(item.mesh_id);
          return { ok: true };
        },
      },
    });
    const snap = await kickComputeQueue('pB');
    assert.deepEqual(started, ['mA']);
    assert.deepEqual(snap.items.map((r) => [r.mesh_id, r.position]), [['mB', 1]]);
  });

  it('reordering one project keeps the other project jobs where they were', () => {
    resetComputeQueueForTests({
      filePath,
      items: [mesh('mB', { project_id: 'pB' }), mesh('mA1', { project_id: 'pA' }), mesh('mA2', { project_id: 'pA' })],
    });
    const [, a1, a2] = snapshotComputeQueue().items;
    reorderComputeQueue([a2.id, a1.id]);
    assert.deepEqual(snapshotComputeQueue().items.map((r) => r.mesh_id), ['mB', 'mA2', 'mA1']);
  });

  it('runs queue first come, first served, and still behind their own queued mesh', () => {
    resetComputeQueueForTests({ filePath, items: [] });
    enqueueComputeJob(mesh('mB', { project_id: 'pB' }));
    enqueueComputeJob(mesh('m1'));
    enqueueComputeJob(solve('r-early', { mesh_id: 'm1' }));
    enqueueComputeJob(mesh('mB2', { project_id: 'pB' }));
    enqueueComputeJob(solve('r-late', { mesh_id: 'm1' }));
    enqueueComputeJob(solve('r-gen', { mesh_id: 'm-generating-now' }), { meshGenerating: true });
    assert.deepEqual(
      snapshotComputeQueue().items.map((r) => r.run_id || r.mesh_id),
      ['mB', 'm1', 'r-early', 'mB2', 'r-late', 'r-gen'],
    );
  });

  it('without a project the snapshot lists every row with its position', () => {
    resetComputeQueueForTests({ filePath, items: [mesh('m1', { project_id: 'pA' }), mesh('m2', { project_id: 'pB' })] });
    for (const arg of [undefined, null, '']) {
      assert.deepEqual(snapshotComputeQueue(arg).items.map((r) => [r.mesh_id, r.position]), [['m1', 1], ['m2', 2]]);
    }
  });

  it('skips a missing job and starts the next', async () => {
    const started = [];
    resetComputeQueueForTests({
      filePath,
      items: [mesh('gone'), mesh('m2')],
      deps: {
        isBusy: () => false,
        startMesh: (item) => {
          if (item.mesh_id === 'gone') return { ok: false, missing: true };
          started.push(item.mesh_id);
          return { ok: true };
        },
      },
    });
    await kickComputeQueue();
    assert.deepEqual(started, ['m2']);
    assert.equal(snapshotComputeQueue().items.length, 0);
  });

  it('waits when the head solve still needs a live mesh', async () => {
    let started = 0;
    resetComputeQueueForTests({
      filePath,
      items: [solve('r1', { mesh_id: 'm1' })],
      deps: {
        isBusy: () => false,
        meshIsGenerating: (id) => id === 'm1',
        startSolve: () => {
          started += 1;
          return { ok: true };
        },
      },
    });
    await kickComputeQueue();
    assert.equal(started, 0);
    assert.equal(snapshotComputeQueue().items[0].run_id, 'r1');
  });

  it('remove by mesh id or queue id', () => {
    const a = enqueueComputeJob(mesh('m1')).item;
    enqueueComputeJob(mesh('m2'));
    removeComputeJob('mesh', 'm2');
    assert.equal(snapshotComputeQueue().items.length, 1);
    removeComputeJob(null, a.id);
    assert.equal(snapshotComputeQueue().items.length, 0);
  });
});

describe('startResultFromEngine', () => {
  it('maps 409 to busy unless the run already finished', () => {
    assert.deepEqual(startResultFromEngine({ ok: false, status: 409, bodyExtra: { error: 'already running' } }), {
      ok: false,
      busy: true,
      error: 'already running',
    });
    assert.deepEqual(
      startResultFromEngine({ ok: false, status: 409, bodyExtra: { error: 'This run already finished.' } }),
      { ok: false, skip: true, error: 'This run already finished.' },
    );
  });

  it('maps 404 to missing', () => {
    assert.deepEqual(startResultFromEngine({ ok: false, status: 404, bodyExtra: { error: 'Run not found' } }), {
      ok: false,
      missing: true,
      error: 'Run not found',
    });
  });
});

describe('queueKickAfterStart / dep helpers', () => {
  it('holds validation failures', () => {
    assert.equal(queueKickAfterStart({ ok: false }, false), 'hold');
    assert.equal(queueKickAfterStart({ ok: true }, true), 'dequeue');
  });

  it('detects a run above its mesh', () => {
    assert.equal(
      queueHasMeshDepViolation([
        { id: 's', kind: 'solve', run_id: 'r', mesh_id: 'm' },
        { id: 'm', kind: 'mesh', mesh_id: 'm' },
      ]),
      true,
    );
  });
});

describe('compute-queue across projects', () => {
  it('keeps the same mesh id from two projects as two jobs', () => {
    enqueueComputeJob(mesh('mesh_1', { project_id: 'pA' }));
    enqueueComputeJob(mesh('mesh_1', { project_id: 'pB' }));
    assert.deepEqual(
      snapshotComputeQueue().items.map((r) => r.project_id),
      ['pA', 'pB'],
    );
  });

  it('removes and drops only within the given project', () => {
    enqueueComputeJob(mesh('mesh_1', { project_id: 'pA' }));
    enqueueComputeJob(mesh('mesh_1', { project_id: 'pB' }));
    removeComputeJob('mesh', 'mesh_1', 'pB');
    assert.deepEqual(snapshotComputeQueue().items.map((r) => r.project_id), ['pA']);
    enqueueComputeJob(mesh('mesh_1', { project_id: 'pB' }));
    dropComputeJobsForMesh('mesh_1', 'pA');
    assert.deepEqual(snapshotComputeQueue().items.map((r) => r.project_id), ['pB']);
  });

  it('a project snapshot shows the job it waits on in another project, and its place in line', () => {
    resetComputeQueueForTests({
      filePath,
      items: [mesh('m1', { project_id: 'pA' }), mesh('mesh_1', { project_id: 'pB' })],
      deps: { live: () => ({ kind: 'mesh', mesh_id: 'mesh_1', project_id: 'pA', project_title: 'Project A' }) },
    });
    const snap = snapshotComputeQueue('pB');
    assert.equal(snap.live, null, 'live stays scoped to the asked project');
    assert.equal(snap.busy.project_id, 'pA');
    assert.equal(snap.busy.project_title, 'Project A');
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0].position, 2);
  });

  it('a solve waits only for the live mesh in its own project', async () => {
    const started = [];
    resetComputeQueueForTests({
      filePath,
      items: [solve('r1', { mesh_id: 'mesh_1', project_id: 'pB' })],
      deps: {
        isBusy: () => false,
        meshIsGenerating: (id, projectId) => id === 'mesh_1' && projectId === 'pA',
        startSolve: (item) => {
          started.push(item.run_id);
          return { ok: true };
        },
      },
    });
    await kickComputeQueue();
    assert.deepEqual(started, ['r1']);
  });
});

describe('compute-queue merge of leftover browser rows', () => {
  it('does not re-add the job that is running now', () => {
    resetComputeQueueForTests({
      filePath,
      items: [],
      deps: { live: () => ({ kind: 'mesh', mesh_id: 'mesh_1', project_id: 'pB' }) },
    });
    mergeComputeQueueItems([mesh('mesh_1', { project_id: 'pB' }), mesh('mesh_1', { project_id: 'pC' })]);
    assert.deepEqual(snapshotComputeQueue().items.map((r) => r.project_id), ['pC']);
  });
});

describe('enqueueMeshWhenBusy (POST /api/mesh/generate queue_if_busy)', () => {
  const req = { mesh_id: 'mesh_1', project_id: 'pB', simulation_id: 'sim_1', name: 'Mesh 1', settings: { fineness: 3 } };

  it('lets the generate start when nothing is running', () => {
    assert.equal(enqueueMeshWhenBusy(req, null), null);
    assert.equal(snapshotComputeQueue().items.length, 0);
  });

  it('queues behind a mesh in another project, with the settings to start it later', () => {
    const live = { kind: 'mesh', mesh_id: 'mesh_1', project_id: 'pA' };
    resetComputeQueueForTests({ filePath, items: [], deps: { live: () => live } });
    const out = enqueueMeshWhenBusy(req, live);
    assert.equal(out.status, 202);
    assert.equal(out.body.queued, true);
    assert.equal(out.body.busy.project_id, 'pA');
    assert.deepEqual(out.body.items.map((r) => [r.project_id, r.mesh_id, r.position]), [['pB', 'mesh_1', 1]]);
    const row = snapshotComputeQueue().items[0];
    assert.equal(row.simulation_id, 'sim_1');
    assert.deepEqual(row.settings, { fineness: 3 });
  });

  it('queues behind a running solve', () => {
    const out = enqueueMeshWhenBusy(req, { kind: 'solve', run_id: 'r9', project_id: 'pA' });
    assert.equal(out.status, 202);
    assert.equal(snapshotComputeQueue().items.length, 1);
  });

  it('does not queue the mesh that is already the live job', () => {
    assert.equal(enqueueMeshWhenBusy(req, { kind: 'mesh', mesh_id: 'mesh_1', project_id: 'pB' }), null);
    assert.equal(snapshotComputeQueue().items.length, 0);
  });

  it('a second click does not add a second row', () => {
    const live = { kind: 'mesh', mesh_id: 'm9', project_id: 'pA' };
    enqueueMeshWhenBusy(req, live);
    enqueueMeshWhenBusy(req, live);
    assert.equal(snapshotComputeQueue().items.length, 1);
  });

  it('the queued mesh starts once the slot frees', async () => {
    enqueueMeshWhenBusy(req, { kind: 'mesh', mesh_id: 'mesh_1', project_id: 'pA' });
    const started = [];
    let busy = true;
    resetComputeQueueForTests({
      filePath,
      items: snapshotComputeQueue().items,
      deps: {
        isBusy: () => busy,
        startMesh: (item) => {
          started.push([item.project_id, item.mesh_id, item.settings && item.settings.fineness]);
          busy = true;
          return { ok: true };
        },
      },
    });
    await kickComputeQueue();
    assert.deepEqual(started, []);
    busy = false;
    await kickComputeQueue();
    assert.deepEqual(started, [['pB', 'mesh_1', 3]]);
    assert.equal(snapshotComputeQueue().items.length, 0);
  });
});

describe('computeQueueFileFor', () => {
  it('gives each projects root its own queue file', () => {
    const a = computeQueueFileFor(join(dir, 'root-a'));
    const b = computeQueueFileFor(join(dir, 'root-b'));
    assert.notEqual(a, b);
    assert.match(a, /compute-queue-[0-9a-f]{10}\.json$/);
  });
});
