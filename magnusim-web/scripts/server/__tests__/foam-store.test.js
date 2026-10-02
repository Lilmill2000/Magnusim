// H15: the step-list runner's records (scripts/foam-store.js).
import { after, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-foamstore-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');

const store = await import('../../foam-store.js');
const {
  FOAM_JOB_RE,
  createFoamRecord,
  emitFoamEvent,
  foamEventBus,
  foamStoreFileFor,
  listFoamRecords,
  newFoamJobId,
  readFoamRecord,
  recentFoamEvents,
  recentFoamPoints,
  resetFoamStoreForTests,
  thinPoints,
  updateFoamRecord,
  writeFoamStore,
} = store;

const FILE = join(ROOT, 'foam-cases.json');

after(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  mock.timers.reset();
  rmSync(FILE, { force: true });
  resetFoamStoreForTests({ filePath: FILE });
});

const base = (extra = {}) => ({ project_id: 'p1', plugin: 'foam-demo', study_id: 's1', case_rel: 'cases/c1', case_dir: 'C:/x', case_base: 'C:/b', token: 'aabbccdd', wsl_case: 'cfddesk-pf-foam-demo-s1-aabbccdd', wsl_root: '/r', ...extra });

describe('foam store', () => {
  it('ids, the file per projects root', () => {
    assert.match(newFoamJobId(), FOAM_JOB_RE);
    assert.notEqual(newFoamJobId(), newFoamJobId());
    assert.match(foamStoreFileFor(PROJECTS), /foam-cases-[0-9a-f]{10}\.json$/);
    assert.notEqual(foamStoreFileFor(PROJECTS), foamStoreFileFor(join(ROOT, 'other')));
  });

  it('a record is written at once and read back after a restart; copies only', () => {
    const rec = createFoamRecord(base());
    assert.equal(rec.status, 'queued');
    assert.equal(rec.seq, 0);
    assert.ok(existsSync(FILE));
    rec.status = 'tampered';
    assert.equal(readFoamRecord(rec.id).status, 'queued');
    updateFoamRecord(rec.id, { status: 'running', stage: 'starting' });
    resetFoamStoreForTests({ filePath: FILE });
    const back = readFoamRecord(rec.id);
    assert.equal(back.status, 'running');
    assert.equal(back.stage, 'starting');
    assert.equal(back.project_id, 'p1');
  });

  it('only this projects root: records of another root in the file are invisible', () => {
    const rec = createFoamRecord(base());
    const doc = JSON.parse(readFileSync(FILE, 'utf8'));
    doc.records.push({ ...doc.records[0], id: 'fc-zzzzzzzz-999999', projects_root: 'c:/somewhere/else' });
    writeFileSync(FILE, JSON.stringify(doc));
    resetFoamStoreForTests({ filePath: FILE });
    assert.deepEqual(listFoamRecords().map((r) => r.id), [rec.id]);
    assert.equal(readFoamRecord('fc-zzzzzzzz-999999'), null);
  });

  it('keeps finished records 30 days, 200 at most; active ones always', () => {
    const now = Date.now();
    const old = createFoamRecord(base());
    updateFoamRecord(old.id, { status: 'done', finished_at: new Date(now - 31 * 24 * 3600_000).toISOString() });
    assert.equal(readFoamRecord(old.id), null, 'older than 30 days');
    const running = createFoamRecord(base());
    updateFoamRecord(running.id, { status: 'running' });
    const ids = [];
    for (let i = 0; i < 205; i += 1) {
      const r = createFoamRecord(base());
      updateFoamRecord(r.id, { status: 'failed', finished_at: new Date(now - (300 - i) * 1000).toISOString() }, { write: 'none' });
      ids.push(r.id);
    }
    writeFoamStore();
    const finished = listFoamRecords({ status: ['done', 'failed', 'stopped', 'lost'] });
    assert.equal(finished.length, 200);
    assert.equal(readFoamRecord(ids[0]), null, 'the oldest finished went first');
    assert.ok(readFoamRecord(ids[204]));
    assert.ok(readFoamRecord(running.id), 'a running record stays');
  });

  it('events: the next seq per job; the last 400 events and 2000 points kept; one emitter', () => {
    const a = createFoamRecord(base());
    const b = createFoamRecord(base());
    const got = [];
    foamEventBus().on('event', (m) => got.push(m));
    assert.equal(emitFoamEvent(a.id, { event: 'start' }), 1);
    assert.equal(emitFoamEvent(a.id, { event: 'stage', stage: 'solve' }), 2);
    assert.equal(emitFoamEvent(b.id, { event: 'start' }), 1, 'per job');
    assert.equal(emitFoamEvent('fc-nonexist-000000', { event: 'start' }), 0);
    assert.deepEqual(got.map((m) => [m.job_id, m.seq, m.ev.event, m.plugin, m.study_id]), [
      [a.id, 1, 'start', 'foam-demo', 's1'],
      [a.id, 2, 'stage', 'foam-demo', 's1'],
      [b.id, 1, 'start', 'foam-demo', 's1'],
    ]);
    for (let i = 0; i < 450; i += 1) {
      emitFoamEvent(a.id, { event: 'progress', time: i, points: Array.from({ length: 5 }, (_, k) => ({ t: i * 5 + k })) });
    }
    assert.equal(recentFoamEvents(a.id).length, 400);
    assert.equal(recentFoamEvents(a.id).at(-1).seq, 452);
    const pts = recentFoamPoints(a.id, 400);
    assert.equal(pts.length, 400);
    assert.equal(pts.at(-1).t, 449 * 5 + 4, 'the last point kept');
    assert.equal(readFoamRecord(a.id).seq, 452);
  });

  it('thinPoints: evenly, at most max, the last always kept', () => {
    const list = Array.from({ length: 1000 }, (_, i) => i);
    const out = thinPoints(list, 400);
    assert.equal(out.length, 400);
    assert.equal(out[0], 0);
    assert.equal(out.at(-1), 999);
    assert.deepEqual(thinPoints([1, 2, 3], 400), [1, 2, 3]);
  });

  it('progress writes at most every 5 s', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const rec = createFoamRecord(base());
    const writes = [];
    resetFoamStoreForTests({
      filePath: FILE,
      renameSync: (from, to) => {
        writes.push(to);
        renameSync(from, to);
      },
    });
    readFoamRecord(rec.id);
    updateFoamRecord(rec.id, { time: 1 }, { write: 'soon' });
    updateFoamRecord(rec.id, { time: 2 }, { write: 'soon' });
    assert.equal(writes.length, 0);
    mock.timers.tick(4999);
    assert.equal(writes.length, 0, 'not before 5 s');
    mock.timers.tick(1);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).records[0].time, 2);
  });

  it('a write that keeps failing is skipped; memory stays the truth and the next write writes it whole', () => {
    const rec = createFoamRecord(base());
    let fail = true;
    let tries = 0;
    resetFoamStoreForTests({
      filePath: FILE,
      renameSync: (from, to) => {
        tries += 1;
        if (fail) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        renameSync(from, to);
      },
    });
    readFoamRecord(rec.id);
    assert.doesNotThrow(() => updateFoamRecord(rec.id, { status: 'running', stage: 'solve' }));
    assert.equal(tries, 6, 'the first try and 5 retries');
    assert.equal(readFoamRecord(rec.id).stage, 'solve');
    assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).records[0].status, 'queued', 'the file kept the last good write');
    fail = false;
    updateFoamRecord(rec.id, { n_steps: 3 });
    const onDisk = JSON.parse(readFileSync(FILE, 'utf8')).records[0];
    assert.equal(onDisk.stage, 'solve');
    assert.equal(onDisk.n_steps, 3);
  });
});
