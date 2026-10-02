// H15: Stop of a core solve that is starting or draining, and the pending stop of a
// click whose Start has not reached the server (stopSolve / startSolve in w27-solve.js).
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-stop-slot-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const w27 = await import('../w27-solve.js');
const slot = await import('../compute-slot.js');
const watch = await import('../wsl-case-watch.js');
const queue = await import('../server/compute-queue.ts');
const layout = await import('../project-layout.js');
const studyIo = await import('../study-io.js');
const { startSolve, stopSolve } = w27;
const { claimComputeSlot, computeSlotHolder, resetComputeSlotForTests, releaseComputeSlot, takeStartCancel } = slot;

const PID = 'proj-a';
const A = 's-lq2x8k9c-aaaaaa';
const B = 's-lq2x8k9c-bbbbbb';

/** Every process w27 starts (stop_solve.py and friends) and every case kill. */
const spawned = [];
const kills = [];

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  watch.setCaseProcsSpawnForTests(null);
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = 7;
  child.kill = () => {};
  setImmediate(() => child.emit('close', 0));
  return child;
}

beforeEach(() => {
  resetComputeSlotForTests();
  queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {} });
  spawned.length = 0;
  kills.length = 0;
  mock.method(cp, 'spawn', (cmd, args) => {
    spawned.push([cmd, ...(args || [])].join(' '));
    return fakeChild();
  });
  mock.method(cp, 'spawnSync', (cmd, args) => {
    spawned.push([cmd, ...(args || [])].join(' '));
    return { status: 0, stdout: '{"live": false}', stderr: '' };
  });
  syncBuiltinESMExports();
  watch.setCaseProcsSpawnForTests((cmd, args) => {
    kills.push(args.slice(1));
    return fakeChild();
  });
});

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

function seedRunningDoc(runId) {
  const dir = join(PROJECTS, PID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: PID, title: 'A' }));
  try {
    layout.createGeometryFolder(dir, { id: 'g1', name: 'G', original_filename: 'g.step' });
    layout.createStudyFolder(dir, 'g1', { id: 's1', name: 'Study 1' });
  } catch {
    /* already there */
  }
  return studyIo.persistRun(PID, 's1', { id: runId, run_id: runId, name: runId, simulation_id: 's1', status: 'running', pid: 999999, wsl_case: `cfddesk-w27-${runId}` });
}

describe('a Stop clicked while its Start is on the way', () => {
  it('stored under that click only; its Start is refused as stopped and takes no claim', async () => {
    const pending = stopSolve({ projectId: PID, runId: 'run_x', starting: true, startId: A });
    assert.deepEqual([pending.status, pending.bodyExtra.stopping, pending.bodyExtra.pending], [200, true, true]);
    const other = await startSolve({ projectId: PID, runId: 'run_x', startId: B });
    assert.notEqual(other.bodyExtra.code, 'stopped', 'another click starts');
    const mine = await startSolve({ projectId: PID, runId: 'run_x', startId: A });
    assert.equal(mine.status, 409);
    assert.deepEqual([mine.bodyExtra.code, mine.bodyExtra.stopped, mine.bodyExtra.error], ['stopped', true, 'Stopped before it started']);
    assert.equal(computeSlotHolder(), null);
    const again = await startSolve({ projectId: PID, runId: 'run_x', startId: A });
    assert.notEqual(again.bodyExtra.code, 'stopped', 'consumed once');
    assert.equal(computeSlotHolder(), null);
  });

  it('a Start refused busy, then its cancel, then a queue start of that run: not refused', async () => {
    const mesh = claimComputeSlot('mesh', { project_id: 'proj-b', mesh_id: 'm1' }, { phase: 'running' });
    const busy = await startSolve({ projectId: PID, runId: 'run_y', startId: A });
    assert.deepEqual([busy.status, busy.bodyExtra.code], [409, 'busy']);
    releaseComputeSlot(mesh.token);
    stopSolve({ projectId: PID, runId: 'run_y', starting: true, startId: A });
    const fromQueue = await startSolve({ projectId: PID, runId: 'run_y' });
    assert.notEqual(fromQueue.bodyExtra.code, 'stopped');
  });

  it('a cancel with no start_id stores nothing', () => {
    const r = stopSolve({ projectId: PID, runId: 'run_z', starting: true });
    assert.deepEqual([r.status, r.bodyExtra.stopping, r.bodyExtra.pending], [200, false, false]);
    for (const bad of ['bad id!', 'S-UPPER-0000000']) {
      const s = stopSolve({ projectId: PID, runId: 'run_z', starting: true, startId: bad });
      assert.equal(s.bodyExtra.pending, false);
    }
    assert.equal(takeStartCancel(A), false);
  });

  it('"cancel this start" never stops another run', () => {
    seedRunningDoc('run_other');
    const c = claimComputeSlot('solve', { project_id: PID, run_id: 'run_other' }, { phase: 'running' });
    const r = stopSolve({ projectId: PID, runId: 'run_mine', starting: true, startId: A });
    assert.deepEqual([r.status, r.bodyExtra.pending, r.bodyExtra.run_id], [200, true, 'run_mine']);
    const h = computeSlotHolder();
    assert.deepEqual([h.token, h.run_id, h.stop_requested], [c.token, 'run_other', false]);
    assert.deepEqual(spawned.filter((s) => s.includes('stop_solve.py')), [], 'no stop tool');
    const doc = JSON.parse(readFileSync(join(studyIo.runFolderOf(PID, 'run_other').dir, 'run.json'), 'utf8'));
    assert.equal(doc.status, 'running');
    assert.notEqual(doc.stop_requested, true);
    assert.equal(takeStartCancel(A), true, 'the pending stop of run_mine was kept');
  });
});

describe('Stop of the slot holder', () => {
  it('while starting: the claim is asked to stop; today’s code does not run', () => {
    queue.enqueueComputeJob({ kind: 'solve', run_id: 'run_s', project_id: PID });
    claimComputeSlot('solve', { project_id: PID, run_id: 'run_s' }, { phase: 'starting' });
    const r = stopSolve({ projectId: PID, runId: 'run_s' });
    assert.deepEqual([r.status, r.bodyExtra.stopping, r.bodyExtra.cancelled, r.bodyExtra.run_id], [200, true, true, 'run_s']);
    assert.equal(computeSlotHolder().stop_requested, true);
    assert.deepEqual(spawned, []);
    assert.deepEqual(queue.snapshotComputeQueue().items, [], 'its queued row goes too');
    // A cancel sent by the queue start's tab (starting, no start_id) does the same.
    resetComputeSlotForTests();
    claimComputeSlot('solve', { project_id: PID, run_id: 'run_s' }, { phase: 'starting' });
    const cancel = stopSolve({ projectId: PID, runId: 'run_s', starting: true });
    assert.deepEqual([cancel.bodyExtra.stopping, cancel.bodyExtra.cancelled], [true, true]);
    assert.equal(computeSlotHolder().stop_requested, true);
  });

  it('a Start of the run while its cancelled start still ends queues (busy), not "already solving"', async () => {
    const c = claimComputeSlot('solve', { project_id: PID, run_id: 'run_c' }, { phase: 'starting' });
    stopSolve({ projectId: PID, runId: 'run_c', starting: true });
    const again = await startSolve({ projectId: PID, runId: 'run_c', startId: B });
    assert.deepEqual([again.status, again.bodyExtra.code], [409, 'busy']);
    assert.match(again.bodyExtra.error, /already running/, 'the client queues it');
    assert.equal(computeSlotHolder().token, c.token, 'the cancelled start still holds the slot');
  });

  it('a "cancel this start" that reaches a run already started stops it: not "cancelled", the claim reads stopping', () => {
    seedRunningDoc('run_r');
    claimComputeSlot('solve', { project_id: PID, run_id: 'run_r' }, { phase: 'running' });
    // Today's Stop arms a 20 s force-kill timer: fake timers drop it at the end.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const r = stopSolve({ projectId: PID, runId: 'run_r', starting: true });
      assert.deepEqual([r.status, r.bodyExtra.stopping, r.bodyExtra.cancelled, r.bodyExtra.pending], [200, true, undefined, undefined]);
      assert.equal(computeSlotHolder().stop_requested, true, 'the Queue title reads (stopping)');
      const writeNow = spawned.filter((s) => s.includes('stop_solve.py') && !s.includes('--probe') && !s.includes('--force'));
      assert.equal(writeNow.length, 1, "today's Stop: write the current step");
    } finally {
      mock.timers.reset();
    }
  });

  it('while draining (a run the boot check follows): its doc is asked to stop and its WSL processes are killed once now', () => {
    const run = seedRunningDoc('run_d');
    claimComputeSlot('solve', { project_id: PID, run_id: 'run_d' }, { phase: 'draining' });
    const r = stopSolve({ projectId: PID, runId: 'run_d' });
    assert.deepEqual([r.status, r.bodyExtra.stopping, r.bodyExtra.stopped, r.bodyExtra.stale], [200, true, undefined, undefined]);
    assert.equal(JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')).stop_requested, true);
    assert.equal(computeSlotHolder().stop_requested, true);
    assert.deepEqual(kills, [['kill', '--wsl-case', 'cfddesk-w27-run_d', '--script', 'solve-run_d.sh']]);
    assert.deepEqual(spawned.filter((s) => s.includes('stop_solve.py')), [], 'never "stopped" without a kill');
    // Without a run id, the holder's run is meant.
    stopSolve({ projectId: PID });
    assert.equal(kills.length, 2);
  });

  it('a run of another project is not "mine"', () => {
    claimComputeSlot('solve', { project_id: 'proj-b', run_id: 'run_d' }, { phase: 'draining' });
    const r = stopSolve({ projectId: PID, runId: 'run_d', starting: true, startId: B });
    assert.equal(r.bodyExtra.pending, true);
    assert.equal(kills.length, 0);
    assert.equal(computeSlotHolder().stop_requested, false);
  });
});

describe('the route passes the click', () => {
  it('start_id to the start and the stop; starting to the stop (source scan)', () => {
    const src = readFileSync(new URL('../w27-solve.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /simulationId: body\.simulation_id \|\| u\.searchParams\.get\('simulation_id'\),\n\s+startId: body\.start_id,/);
    assert.match(src, /starting: body\.starting === true,\n\s+startId: body\.start_id,/);
  });
});
