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
} from '../compute-queue.ts';

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

  it('refuses a solve enqueue when Air is not assigned', () => {
    const out = enqueueComputeJob(solve('r1'), { hasMaterial: false });
    assert.equal(out.ok, false);
    assert.match(String(out.error), /Air/);
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

  it('holds on ok:false so later jobs cannot jump', async () => {
    resetComputeQueueForTests({
      filePath,
      items: [mesh('m1'), mesh('m2')],
      deps: {
        isBusy: () => false,
        startMesh: () => ({ ok: false }),
      },
    });
    await kickComputeQueue();
    assert.deepEqual(
      snapshotComputeQueue().items.map((r) => r.mesh_id),
      ['m1', 'm2'],
    );
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
    });
    assert.deepEqual(
      startResultFromEngine({ ok: false, status: 409, bodyExtra: { error: 'This run already finished.' } }),
      { ok: false, skip: true },
    );
  });

  it('maps 404 to missing', () => {
    assert.deepEqual(startResultFromEngine({ ok: false, status: 404, bodyExtra: { error: 'Run not found' } }), {
      ok: false,
      missing: true,
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
