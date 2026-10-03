// Link job records and the queue after a restart (host API 1.5, gate:l2-store and the
// stored-queue part of gate:l2-slot): records on globalThis written to their own file per
// projects root, ids gl-…, a stored queue that keeps geometry rows, the boot reconcile
// (queued kept with its row and staging; running → "Stopped by a restart"; queued without
// a row → "Lost from the queue"; a geometry row without a record leaves with a notice),
// staging folders nothing needs removed at boot, the queue's leave and change dispatch by
// a row's kind, and the start's refusals (busy, final when its input is gone).
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-link-store-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_QUEUE_QUIET = '1';

const store = await import('../../link-store.js');
const queue = await import('../compute-queue.ts');
const slot = await import('../../compute-slot.js');
const job = await import('../link-job.js');
const foamStore = await import('../../foam-store.js');
const foamRunner = await import('../../foam-runner.js');

after(() => rmSync(ROOT, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STORE_FILE = join(ROOT, 'link-jobs.json');
const QUEUE_FILE = join(ROOT, 'compute-queue.json');

function project(pid) {
  mkdirSync(join(PROJECTS, pid), { recursive: true });
  writeFileSync(join(PROJECTS, pid, 'project.json'), JSON.stringify({ id: pid, title: pid }));
}

function staged(pid, id) {
  const dir = join(PROJECTS, pid, '.magnusim-staging', `link-${id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ job: id }));
  return dir;
}

function update(pid, fields = {}) {
  return store.createLinkRecord({
    op: 'update',
    project_id: pid,
    plugin: 'link-demo',
    study_id: 'st-1',
    study_title: 'Demo 1',
    geometry_id: 'geom-1',
    geometry_name: 'Demo 1',
    source_version: 2,
    based_on_rev: 1,
    row_name: 'Update Demo 1 from Demo 1',
    ...fields,
  });
}

function geometryRow(rec, id = `q-${rec.id.slice(-6)}`) {
  return { id, kind: 'geometry', project_id: rec.project_id, name: 'Update Demo 1 from Demo 1', job_id: rec.id, geometry: { plugin: 'link-demo', study_id: 'st-1', geometry_id: 'geom-1' } };
}

const deps = () => ({
  isBusy: () => slot.computeSlotHolder() !== null,
  startGeometry: (row) => job.startGeometryUpdate(row),
  runFirst: () => job.linkRunFirst(),
  onLeave: (row, reason, error) => (row.kind === 'geometry' ? job.onLinkQueueLeave(row, reason, error) : foamRunner.onQueueLeave(row, reason, error)),
  onChange: () => {
    foamRunner.onQueueChange();
    job.onLinkQueueChange();
  },
  holdsRow: (row) => slot.holderIsRow(slot.computeSlotHolder(), row),
});
/** The queue with these rows and the dispatch live-routes wires. */
function resetQueue(items = [], opts = {}) {
  queue.resetComputeQueueForTests({ filePath: QUEUE_FILE, items, deps: deps(), ...opts });
}

beforeEach(() => {
  store.resetLinkStoreForTests({ filePath: STORE_FILE, root: PROJECTS });
  rmSync(STORE_FILE, { force: true });
  slot.resetComputeSlotForTests();
  job.resetLinkJobsForTests();
  foamRunner.resetFoamRunnerForTests();
  foamStore.resetFoamStoreForTests({ filePath: join(ROOT, 'foam.json'), root: PROJECTS });
  resetQueue([]);
});

describe('the store', () => {
  it('ids match LINK_JOB_RE; records live on the process and in their own file per projects root', async () => {
    project('s1');
    const rec = update('s1');
    assert.match(rec.id, store.LINK_JOB_RE);
    assert.equal(rec.status, 'queued');
    assert.ok(JSON.parse(readFileSync(STORE_FILE, 'utf8')).records.some((r) => r.id === rec.id));
    const v2 = await import('../../link-store.js?v=2');
    assert.equal(v2.readLinkRecord(rec.id).status, 'queued', 'a second module instance shares the records');
    v2.updateLinkRecord(rec.id, { stage: 'reading' });
    assert.equal(store.readLinkRecord(rec.id).stage, 'reading');
    assert.notEqual(store.linkStoreFileFor(PROJECTS), store.linkStoreFileFor(join(ROOT, 'other')));
    // A record of another projects root is not read.
    store.resetLinkStoreForTests({ filePath: STORE_FILE, root: join(ROOT, 'other') });
    assert.equal(store.readLinkRecord(rec.id), null);
  });

  it('the stored queue keeps geometry rows; a browser merge or the generic POST cannot add one', () => {
    project('s2');
    const rec = update('s2');
    resetQueue([geometryRow(rec, 'q-geo')]);
    resetQueue([], { reload: true });
    const items = queue.snapshotComputeQueue().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'geometry');
    assert.deepEqual(items[0].geometry, { plugin: 'link-demo', study_id: 'st-1', geometry_id: 'geom-1' });
    assert.equal(queue.enqueueComputeJob(geometryRow(update('s2', { source_version: 3 }), 'q-x')).ok, false);
    const merged = queue.mergeComputeQueueItems([geometryRow(update('s2', { source_version: 4 }), 'q-y')]);
    assert.equal(merged.items.filter((r) => r.kind === 'geometry').length, 1);
    // The default name and the notice name a geometry update, never a plugin case or a run.
    queue.pushComputeNotice({ kind: 'geometry', project_id: 's2', error: 'lost' });
    assert.equal(queue.snapshotComputeQueue('s2').failed[0].name, 'Geometry update');
    assert.equal(queue.snapshotComputeQueue('s2').failed[0].kind, 'geometry');
  });
});

describe('after a restart', () => {
  it('queued with its row and staging stays queued; running fails; queued without a row fails; a row with no record leaves with a notice', () => {
    project('r1');
    const kept = update('r1');
    staged('r1', kept.id);
    const running = update('r1', { source_version: 5 });
    store.updateLinkRecord(running.id, { status: 'running' });
    const rowless = update('r1', { source_version: 6 });
    staged('r1', rowless.id);
    const ghost = { ...geometryRow({ id: 'gl-ghost0-abcdef', project_id: 'r1' }, 'q-ghost') };
    resetQueue([geometryRow(kept, 'q-kept'), ghost]);
    job.reconcileLinkJobs();
    assert.equal(store.readLinkRecord(kept.id).status, 'queued');
    assert.deepEqual([store.readLinkRecord(running.id).status, store.readLinkRecord(running.id).error], ['failed', 'Stopped by a restart']);
    assert.deepEqual([store.readLinkRecord(rowless.id).status, store.readLinkRecord(rowless.id).error], ['failed', 'Lost from the queue']);
    const snap = queue.snapshotComputeQueue('r1');
    assert.deepEqual(snap.items.map((r) => r.id), ['q-kept']);
    assert.equal(snap.failed.length, 1);
    assert.equal(snap.failed[0].name, 'Update Demo 1 from Demo 1');
    assert.equal(snap.failed[0].reason, 'dropped');
  });

  it('staging nothing needs is removed at boot; a queued record keeps its own; a journal keeps its own', async () => {
    project('r2');
    const kept = update('r2');
    const keptDir = staged('r2', kept.id);
    const orphan = staged('r2', 'gl-orphan-123456');
    const gdir = join(PROJECTS, 'r2', 'geometries', 'Geometry_Demo_1');
    mkdirSync(join(gdir, 'link'), { recursive: true });
    writeFileSync(join(gdir, 'id.json'), JSON.stringify({ id: 'geom-j', name: 'Demo 1' }));
    const journalDir = staged('r2', 'gl-journl-654321');
    writeFileSync(join(gdir, 'link', 'commit.json'), JSON.stringify({ job: 'gl-journl-654321', phase: 'apply', staging: '.magnusim-staging/link-gl-journl-654321', moves: [] }));
    job.scanLinkJournals();
    assert.deepEqual(job.pendingRecoveries().map((p) => p.geometryId), ['geom-j'], 'the journal goes to the recovery');
    await sleep(500);
    assert.equal(existsSync(keptDir), true);
    assert.equal(existsSync(journalDir), true);
    assert.equal(existsSync(orphan), false);
  });
});

describe("the queue's side", () => {
  it('removing a geometry row cancels its record; a foam row removed beside it still goes to the step-list runner', () => {
    project('q1');
    const rec = update('q1');
    staged('q1', rec.id);
    const foam = foamStore.createFoamRecord({ project_id: 'q1', plugin: 'foam-demo', study_id: 'st-2', study_title: 'Case', case_rel: 'c1' });
    resetQueue([geometryRow(rec, 'q-g'), { id: 'q-f', kind: 'foam', project_id: 'q1', name: 'Case', job_id: foam.id, foam: { plugin: 'foam-demo', study_id: 'st-2' } }]);
    queue.removeComputeJob(null, 'q-g', 'q1');
    assert.deepEqual([store.readLinkRecord(rec.id).status, store.readLinkRecord(rec.id).code], ['cancelled', 'cancelled']);
    assert.equal(existsSync(join(PROJECTS, 'q1', '.magnusim-staging', `link-${rec.id}`)), false, 'its staging goes');
    queue.removeComputeJob(null, 'q-f', 'q1');
    assert.equal(foamStore.readFoamRecord(foam.id).status, 'stopped');
  });

  it('a superseded record leaves with no second ending; the job ahead leaving sends queued {ahead}', () => {
    project('q2');
    const a = update('q2');
    const b = update('q2', { source_version: 3, study_id: 'st-9' });
    resetQueue([geometryRow(a, 'q-a'), geometryRow(b, 'q-b')]);
    store.updateLinkRecord(b.id, { row_id: 'q-b' });
    store.updateLinkRecord(a.id, { row_id: 'q-a', status: 'superseded' });
    job.onLinkQueueChange();
    const before = store.recentLinkEvents(b.id).map((e) => e.ev);
    assert.deepEqual(before.at(-1), { event: 'queued', ahead: 1 });
    queue.dropComputeRows(['q-a'], 'superseded', 'skipped');
    assert.equal(store.readLinkRecord(a.id).status, 'superseded', 'no second ending');
    assert.deepEqual(store.recentLinkEvents(b.id).map((e) => e.ev).at(-1), { event: 'queued', ahead: 0 });
  });

  it("the start: busy while the slot is held; final, with a notice, when its saved input is gone", async () => {
    project('q3');
    const rec = update('q3');
    resetQueue([geometryRow(rec, 'q-lost')]);
    const held = slot.claimComputeSlot('mesh', { project_id: 'q3', mesh_id: 'm1' });
    assert.deepEqual(job.startGeometryUpdate(geometryRow(rec, 'q-lost')), { busy: true });
    slot.releaseComputeSlot(held.token);
    await queue.kickComputeQueue();
    const snap = queue.snapshotComputeQueue('q3');
    assert.equal(snap.items.length, 0);
    assert.equal(snap.failed.length, 1);
    assert.equal(snap.failed[0].error, 'Update Demo 1 from Demo 1 lost its saved input. Update it again');
    assert.equal(store.readLinkRecord(rec.id).status, 'failed');
    assert.equal(slot.computeSlotHolder(), null, 'no claim taken');
  });

  it('the claim carries the geometry id; holderIsRow matches a geometry claim by its job', () => {
    const c = slot.claimComputeSlot('geometry', { project_id: 'q4', job_id: 'gl-abcdef-123456', geometry_id: 'geom-7', name: 'Update X from Y' });
    const h = slot.computeSlotHolder();
    assert.equal(h.geometry_id, 'geom-7');
    assert.equal(slot.holderIsRow(h, { kind: 'geometry', project_id: 'q4', job_id: 'gl-abcdef-123456' }), true);
    assert.equal(slot.holderIsRow(h, { kind: 'foam', project_id: 'q4', job_id: 'gl-abcdef-123456' }), false);
    assert.equal(slot.projectBusyMessage(h, 'q4'), 'A geometry in this project is updating. Try again when it has finished.');
    slot.releaseComputeSlot(c.token);
  });
});
