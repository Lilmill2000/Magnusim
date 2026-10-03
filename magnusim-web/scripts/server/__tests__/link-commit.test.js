// Linked geometries (host API 1.5), L2 step 1: an update's commit and what it does when
// things go wrong. The swap in one synchronous step that undoes itself (a held file:
// waiting, then the commit; held too long: busy, the geometry whole), a failed undo (the
// geometry fenced until the job undoes it), the apply timeout (the gate stays closed
// until the barrier answers), an apply that never lands (fenced; the recovery, first in
// line on the slot, finishes it), a swap a kill cut short (the recovery undoes it by what
// exists), removal at every stage, follow-ups that never make a folder, and the overlay
// that adds back a record project.json lost. gate:l2-commit, gate:l2-recovery,
// gate:l2-slot (step 1's parts).
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkHarness, sha256, sleep } from './link-harness.js';

const PAUSE = join(tmpdir(), `magnusim-link-apply-pause-${process.pid}`);
const HOOKS = Symbol.for('magnusim.linkTestHooks');

/** @type {any} */
let h;
before(async () => {
  h = await linkHarness({
    name: 'link-commit',
    env: { MAGNUSIM_TEST_LINK_HOOKS: '1', MAGNUSIM_TEST_LINK_APPLY_TIMEOUT_MS: '1500', MAGNUSIM_TEST_APPLY_PAUSE: PAUSE },
  });
});
after(async () => {
  restoreRename();
  try {
    fs.rmSync(PAUSE, { force: true });
  } catch {
    /* gone */
  }
  await h?.close();
});
beforeEach(() => {
  restoreRename();
  delete globalThis[HOOKS];
  h.overrides.clear();
  h.job.setLinkJobDepsForTests({
    now: null,
    runPreview: null,
    runCom: null,
    timing: { waitSteps: [50, 50, 50, 50], waitEvery: 100, waitLoopMs: 600_000, applyRetries: [20, 20] },
  });
});

const realRename = fs.renameSync;
/** Make renameSync fail with EBUSY when fn(from, to) says so (every module's import of it). */
function patchRename(fn) {
  fs.renameSync = (from, to) => {
    if (fn(String(from), String(to))) {
      const e = new Error(`EBUSY: resource busy or locked, rename '${from}'`);
      e.code = 'EBUSY';
      throw e;
    }
    return realRename(from, to);
  };
  syncBuiltinESMExports();
}
function restoreRename() {
  fs.renameSync = realRename;
  syncBuiltinESMExports();
}

async function linkedV1(pid) {
  h.project(pid);
  const sid = await h.study(pid);
  const r = await h.link(pid, sid, { sourceVersion: 1 });
  const rec = await h.until(r.body.job_id);
  assert.equal(rec.status, 'done', rec.error);
  return { sid, gid: r.body.geometry_id, dir: h.geomDir(pid, r.body.geometry_id) };
}

/** Link v2 (an update) and start it on the free slot. */
async function updateV2(pid, sid) {
  const r = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await h.queue.kickComputeQueue();
  return r.body.job_id;
}

function stages(id) {
  return h.store.recentLinkEvents(id).map((e) => e.ev);
}

describe('the swap step', () => {
  it('a file another program holds: the job waits with the folder whole, then commits', async () => {
    const pid = 'c-held';
    const { sid, gid, dir } = await linkedV1(pid);
    const v1bytes = readFileSync(join(dir, 'source.bbrep'));
    let fails = 4;
    let wholeWhileWaiting;
    patchRename((from) => {
      if (!from.endsWith(join(dir, 'cad_edges.vtp')) || fails <= 0) return false;
      fails -= 1;
      return true;
    });
    h.job.setLinkJobDepsForTests({ timing: { waitSteps: [300, 300, 300, 300] } });
    const id = await updateV2(pid, sid);
    await h.waitFor(() => stages(id).some((e) => e.event === 'stage' && e.stage === 'waiting'), 60_000, 'waiting');
    wholeWhileWaiting = {
      rev: h.state(pid, gid).rev,
      shape: sha256(readFileSync(join(dir, 'source.bbrep'))) === sha256(v1bytes),
      journal: existsSync(join(dir, 'link', 'commit.json')),
    };
    const rec = await h.until(id);
    assert.equal(rec.status, 'done', rec.error);
    assert.deepEqual(wholeWhileWaiting, { rev: 1, shape: true, journal: false });
    const waiting = stages(id).find((e) => e.stage === 'waiting');
    assert.equal(waiting.label, "Waiting for another program to release Demo 1's files");
    assert.equal(h.state(pid, gid).rev, 2);
  });

  it('held for the whole wait: busy, the geometry unchanged and the slot free', async () => {
    const pid = 'c-busy';
    const { sid, gid, dir } = await linkedV1(pid);
    const before = sha256(readFileSync(join(dir, 'cad_preview.json')));
    patchRename((from) => from.endsWith(join(dir, 'cad_edges.vtp')));
    h.job.setLinkJobDepsForTests({ timing: { waitLoopMs: 400 } });
    const id = await updateV2(pid, sid);
    const rec = await h.until(id);
    restoreRename();
    assert.equal(rec.status, 'busy');
    assert.match(rec.error, /Another program held Demo 1's files for 10 minutes/);
    assert.equal(h.state(pid, gid).rev, 1);
    assert.equal(sha256(readFileSync(join(dir, 'cad_preview.json'))), before);
    assert.equal(existsSync(join(dir, 'link', 'commit.json')), false);
    await h.waitFor(() => !h.slot.computeSlotHolder(), 10_000, 'slot released');
  });

  it('the undo fails: the journal stays at swap and the geometry is fenced until the job undoes it, then it commits', async () => {
    const pid = 'c-undo';
    const { sid, gid, dir } = await linkedV1(pid);
    let forward = 1;
    let undo = 3;
    patchRename((from, to) => {
      if (from.endsWith(join(dir, 'cad_faces.vtp')) && forward > 0) {
        forward -= 1;
        return true;
      }
      // The undo of the first move (staging/old/source.bbrep back into the folder).
      if (to.endsWith(join(dir, 'source.bbrep')) && from.includes(`${join('old', 'source.bbrep')}`) && undo > 0) {
        undo -= 1;
        return true;
      }
      return false;
    });
    h.job.setLinkJobDepsForTests({ timing: { waitSteps: [400, 400, 400, 400] } });
    const id = await updateV2(pid, sid);
    await h.waitFor(() => existsSync(join(dir, 'link', 'commit.json')) && h.job.geometryFenced(dir), 30_000, 'fenced');
    const journal = JSON.parse(readFileSync(join(dir, 'link', 'commit.json'), 'utf8'));
    assert.equal(journal.phase, 'swap');
    const cad = await h.get(`/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=meta`);
    assert.deepEqual([cad.status, cad.body.code], [503, 'geometry_updating']);
    assert.equal(cad.body.error, 'Updating Demo 1. Try again in a moment.');
    const rec = await h.until(id);
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(h.state(pid, gid).rev, 2);
    assert.equal(existsSync(join(dir, 'link', 'commit.json')), false);
  });

  it('afterMove (MAGNUSIM_TEST_LINK_HOOKS) runs inside the swap; a throw there undoes the step', async () => {
    const pid = 'c-hook';
    const { sid, gid } = await linkedV1(pid);
    const seen = [];
    let thrown = false;
    globalThis[HOOKS] = {
      afterMove(i) {
        seen.push(i);
        if (i === 2 && !thrown) {
          thrown = true;
          throw Object.assign(new Error('test kill'), { code: 'EBUSY' });
        }
      },
    };
    const id = await updateV2(pid, sid);
    const rec = await h.until(id);
    assert.equal(rec.status, 'done', rec.error);
    assert.ok(seen.filter((i) => i === 0).length >= 2, 'the step ran again after its undo');
    assert.equal(h.state(pid, gid).rev, 2);
  });
});

describe('the apply', () => {
  it('times out: the gate stays closed until the barrier answers; landed late, the job finishes', async () => {
    const pid = 'c-timeout';
    const { sid, gid, dir } = await linkedV1(pid);
    h.project('c-other');
    writeFileSync(PAUSE, 'hold');
    let id;
    try {
      id = await updateV2(pid, sid);
      await h.waitFor(() => {
        try {
          return JSON.parse(readFileSync(join(dir, 'link', 'commit.json'), 'utf8')).phase === 'apply';
        } catch {
          return false;
        }
      }, 60_000, 'apply phase');
      // GET /api/project is answered in Node (no worker call): only the gate can hold it.
      let answered = null;
      const read = h.get(`/api/project?project_id=${pid}`).then((r) => (answered = r));
      // Past the 1.5 s apply timeout: still closed (the barrier waits behind the held apply).
      await sleep(3000);
      assert.equal(answered, null, 'a gated request of the project waits');
      assert.equal(h.gate.gateIsClosed(pid), true);
      const other = await h.get(`/api/project?project_id=c-other`);
      assert.equal(other.status, 200, 'another project is not held');
      assert.ok(h.calls.some(([m]) => m === 'geometry.barrier'), 'the barrier was sent');
      fs.rmSync(PAUSE, { force: true });
      const rec = await h.until(id);
      assert.equal(rec.status, 'done', rec.error);
      const r = await read;
      assert.equal(r.status, 200);
      assert.equal(r.body.project.geometries.find((g) => g.id === gid).link.rev, 2, 'the waiting read sees the new rev');
    } finally {
      fs.rmSync(PAUSE, { force: true });
    }
    assert.equal(h.state(pid, gid).rev, 2);
    assert.equal(existsSync(join(dir, 'link', 'commit.json')), false);
  });

  it('never lands: the geometry is fenced and its reads answer 503; the recovery finishes it first in line', async () => {
    const pid = 'c-fence';
    const { sid, gid, dir } = await linkedV1(pid);
    const made = await h.post('/api/simulation', { project_id: pid, geometry_id: gid, name: 'Study 1' });
    assert.equal(made.status, 201, JSON.stringify(made.body).slice(0, 300));
    const studyId = made.body.simulation.id;
    h.overrides.set('geometry.apply', () => ({ ok: false, code: 'failed', error: 'held by a test' }));
    const id = await updateV2(pid, sid);
    const rec = await h.until(id);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.error, "Couldn't finish updating Demo 1. The app will finish it.");
    const journal = JSON.parse(readFileSync(join(dir, 'link', 'commit.json'), 'utf8'));
    assert.equal(journal.phase, 'apply');
    assert.equal(h.state(pid, gid).rev, 1, 'the state is the old rev until the apply lands');
    assert.ok(existsSync(join(h.projects, pid, journal.staging, 'plan.json')), 'its staging is kept for the recovery');
    // The recovery ran on the freed slot and failed too: tried again later, from one timer.
    await h.waitFor(() => (h.job.pendingRecoveries()[0] || {}).tries === 1, 30_000, 'first recovery try');
    const pend = h.job.pendingRecoveries();
    assert.equal(pend.length, 1);
    assert.ok(pend[0].nextAt - Date.now() > 50_000, 'backoff of a minute');
    for (const part of ['meta', 'faces']) {
      const r = await h.get(`/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=${part}`);
      assert.deepEqual([r.status, r.body.code], [503, 'geometry_updating'], part);
    }
    const thumb = await h.get(`/api/geometry/thumb?project_id=${pid}`);
    assert.equal(thumb.status, 503);
    // No study of it is made or copied while fenced: the copy would map faces wrongly.
    const create = await h.post('/api/simulation', { project_id: pid, geometry_id: gid, name: 'Study 2' });
    assert.deepEqual([create.status, create.body.code], [503, 'geometry_updating']);
    const copy = await h.post('/api/simulation', { project_id: pid, geometry_id: gid, name: 'Study 3', copy_from: studyId, copy_mode: 'settings' });
    assert.deepEqual([copy.status, copy.body.code], [503, 'geometry_updating']);
    // A link of the same study meanwhile gets no `none` (a journal is left) and refuses
    // to record its version.
    const rs = await h.real.call('geometry.record_source', { project_id: pid, geometry_id: gid, source_version: 9 });
    assert.equal(rs.code, 'geometry_updating');
    // Due again: the recovery claims the slot as "Finish updating Demo 1" before the queued row.
    h.overrides.clear();
    let holderName = null;
    const watch = setInterval(() => {
      const hd = h.slot.computeSlotHolder();
      if (hd && hd.kind === 'geometry' && !holderName) holderName = hd.name;
    }, 2);
    h.job.setLinkJobDepsForTests({ now: () => Date.now() + 120_000 });
    await h.queue.kickComputeQueue();
    await h.waitFor(() => !existsSync(join(dir, 'link', 'commit.json')), 60_000, 'recovered');
    clearInterval(watch);
    assert.equal(holderName, 'Finish updating Demo 1');
    assert.equal(h.state(pid, gid).rev, 2);
    assert.equal(h.state(pid, gid).job_id, id);
    assert.deepEqual(h.job.pendingRecoveries(), []);
    // The study's link stream hears that the fence ended: an open page reads the tree again.
    assert.deepEqual(stages(id).at(-1), { event: 'recovered', geometry_id: gid });
    const cad = await h.get(`/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=meta`);
    assert.equal(cad.status, 200);
    assert.equal(Math.round(cad.body.bounds.zmax), 30); // v2 (v1 has a boss up to z = 35)
  });
});

describe('the apply, when it does not land', () => {
  it('times out, then the held apply fails: the job ends failed, the journal stays at apply and the geometry is fenced for the recovery', async () => {
    const pid = 'c-timeout-fail';
    const { sid, gid, dir } = await linkedV1(pid);
    let release;
    const held = new Promise((r) => (release = r));
    let answered;
    const applyAnswered = new Promise((r) => (answered = r));
    // The worker's one lane: the barrier is answered only after the held apply.
    h.overrides.set('geometry.apply', async () => {
      await held;
      answered();
      return { ok: false, code: 'failed', error: 'the held apply failed' };
    });
    h.overrides.set('geometry.barrier', async (params, real, t) => {
      await applyAnswered;
      return real.call('geometry.barrier', params, t);
    });
    const barriers = h.calls.filter(([m]) => m === 'geometry.barrier').length;
    const id = await updateV2(pid, sid);
    try {
      await h.waitFor(() => h.calls.filter(([m]) => m === 'geometry.barrier').length > barriers, 60_000, 'the barrier after the 1.5 s timeout');
      assert.equal(h.gate.gateIsClosed(pid), true, 'the gate stays closed until the barrier answers');
    } finally {
      release();
    }
    const rec = await h.until(id);
    assert.deepEqual([rec.status, rec.error], ['failed', "Couldn't finish updating Demo 1. The app will finish it."]);
    const journal = JSON.parse(readFileSync(join(dir, 'link', 'commit.json'), 'utf8'));
    assert.equal(journal.phase, 'apply');
    assert.equal(h.job.geometryFenced(dir), true);
    assert.deepEqual(h.job.pendingRecoveries().map((x) => x.geometryId), [gid]);
    const cad = await h.get(`/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=meta`);
    assert.deepEqual([cad.status, cad.body.code], [503, 'geometry_updating']);
    // The recovery finishes it (first in line on the free slot).
    h.overrides.clear();
    h.job.setLinkJobDepsForTests({ now: () => Date.now() + 120_000 });
    await h.queue.kickComputeQueue();
    await h.waitFor(() => !existsSync(join(dir, 'link', 'commit.json')), 60_000, 'recovered');
    assert.equal(h.state(pid, gid).rev, 2);
  });

  it('fails: a read that waited at the closed gate gets 503 when the gate opens, not the half-updated geometry', async () => {
    const pid = 'c-fail-waiters';
    const { sid, gid, dir } = await linkedV1(pid);
    h.overrides.set('geometry.apply', () => ({ ok: false, code: 'failed', error: 'held by a test' }));
    h.job.setLinkJobDepsForTests({ timing: { applyRetries: [400, 400] } });
    const id = await updateV2(pid, sid);
    await h.waitFor(() => {
      try {
        return h.gate.gateIsClosed(pid) && JSON.parse(readFileSync(join(dir, 'link', 'commit.json'), 'utf8')).phase === 'apply';
      } catch {
        return false;
      }
    }, 60_000, 'the journal at apply, the gate closed');
    const waited = await Promise.all(['meta', 'faces'].map((part) => h.get(`/api/geometry/cad?project_id=${pid}&geometry_id=${gid}&part=${part}`)));
    const rec = await h.until(id);
    assert.equal(rec.status, 'failed');
    for (const r of waited) assert.deepEqual([r.status, r.body && r.body.code], [503, 'geometry_updating']);
    // Recover, so the next test starts clean.
    h.overrides.clear();
    h.job.setLinkJobDepsForTests({ now: () => Date.now() + 120_000 });
    await h.queue.kickComputeQueue();
    await h.waitFor(() => !existsSync(join(dir, 'link', 'commit.json')), 60_000, 'recovered');
  });
});

describe('the accept rule again under the slot', () => {
  it('a job queued behind another of its study may be stale when it starts', async () => {
    const pid = 'c-behind';
    const { sid, gid } = await linkedV1(pid);
    const { PYTHON, PY_ROOT } = await import('../../python-env.js');
    const { spawn } = await import('node:child_process');
    let release;
    const held = new Promise((r) => (release = r));
    let calls = 0;
    // The first job's preview waits for the test, then runs as usual.
    h.job.setLinkJobDepsForTests({
      runPreview: async (args) => {
        calls += 1;
        if (calls === 1) await held;
        return new Promise((done) => {
          const c = spawn(PYTHON, ['-m', 'cfddesk.cad.link_preview', ...args], { cwd: PY_ROOT, windowsHide: true });
          let stderr = '';
          c.stderr.on('data', (d) => (stderr += d));
          c.on('close', (code) => done({ code, stdout: '', stderr, timedOut: false }));
        });
      },
    });
    let first;
    let second;
    try {
      // v2 as version 2 runs (held in its preview); meanwhile another tab sends version 2
      // of the same design with other bytes, from the rev it read (1): accepted at the
      // call (the state is still version 1), queued behind the running job.
      first = await updateV2(pid, sid);
      await h.waitFor(() => calls === 1, 60_000, 'first preview');
      const r = await h.link(pid, sid, { version: 'v1', names: 'v1-renamed.face_names.json', sourceVersion: 2, basedOnRev: 1 });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      second = r.body.job_id;
      assert.equal(h.record(second).status, 'queued');
    } finally {
      release();
    }
    assert.equal((await h.until(first)).status, 'done');
    await h.queue.kickComputeQueue();
    const rec = await h.until(second);
    // The state is now version 2 at rev 2: the same version from rev 1 with other bytes is stale.
    assert.equal(rec.status, 'stale');
    assert.match(rec.error, /Demo 1 changed in another tab/);
    assert.equal(calls, 1, 'decided before its preview: only the first job ran one');
    assert.equal(h.state(pid, gid).rev, 2);
  });
});

describe('the recovery', () => {
  it('a swap a kill cut short: undone by what exists; the folder is the old rev again', async () => {
    const pid = 'c-kill';
    const { gid, dir } = await linkedV1(pid);
    const pdir = join(h.projects, pid);
    const before = Object.fromEntries(['source.bbrep', 'cad_faces.vtp', 'cad_preview.json'].map((f) => [f, sha256(readFileSync(join(dir, f)))]));
    // What swapOnce had done when the process died: two of four moves.
    const stage = join(pdir, '.magnusim-staging', 'link-gl-killed-abcdef');
    mkdirSync(join(stage, 'old'), { recursive: true });
    mkdirSync(join(stage, 'new'), { recursive: true });
    writeFileSync(join(stage, 'new', 'source.bbrep'), 'new shape');
    const rel = (p) => p.slice(pdir.length + 1).replace(/\\/g, '/');
    const moves = [
      { from: join(dir, 'source.bbrep'), to: join(stage, 'old', 'source.bbrep') },
      { from: join(dir, 'cad_faces.vtp'), to: join(stage, 'old', 'cad_faces.vtp') },
      { from: join(stage, 'new', 'source.bbrep'), to: join(dir, 'source.bbrep') },
      { from: join(stage, 'new', 'cad_faces.vtp'), to: join(dir, 'cad_faces.vtp') },
    ];
    writeFileSync(
      join(dir, 'link', 'commit.json'),
      JSON.stringify({ job: 'gl-killed-abcdef', from_rev: 1, rev: 2, staging: rel(stage), moves: moves.map((m) => ({ from: rel(m.from), to: rel(m.to) })), phase: 'swap' }),
    );
    renameSync(moves[0].from, moves[0].to);
    renameSync(moves[1].from, moves[1].to);
    renameSync(moves[2].from, moves[2].to);
    h.job.scanLinkJournals();
    assert.equal(h.job.pendingRecoveries().length, 1);
    assert.ok(h.job.geometryFenced(dir));
    await h.queue.kickComputeQueue();
    await h.waitFor(() => !existsSync(join(dir, 'link', 'commit.json')), 30_000, 'undone');
    for (const [f, hash] of Object.entries(before)) assert.equal(sha256(readFileSync(join(dir, f))), hash, f);
    assert.equal(h.state(pid, gid).rev, 1);
    await h.waitFor(() => !existsSync(stage), 10_000, 'staging removed');
  });

  it('an apply that landed is only cleaned up; a second module instance shares the list and scans nothing', async () => {
    const pid = 'c-landed';
    const { gid, dir } = await linkedV1(pid);
    const state = h.state(pid, gid);
    writeFileSync(join(dir, 'link', 'commit.json'), JSON.stringify({ job: state.job_id, phase: 'apply', moves: [], staging: '.magnusim-staging/link-gone' }));
    const v2 = await import(`../link-job.js?v=2`);
    h.job.scanLinkJournals();
    assert.deepEqual(v2.pendingRecoveries(), h.job.pendingRecoveries());
    assert.equal(v2.linkBootOnce(), false, 'once per process: a re-import does not scan again');
    const store2 = await import(`../../link-store.js?v=2`);
    assert.equal(store2.readLinkRecord(state.job_id).status, 'done');
    await h.queue.kickComputeQueue();
    await h.waitFor(() => !existsSync(join(dir, 'link', 'commit.json')), 30_000, 'cleaned');
    assert.equal(h.state(pid, gid).rev, 1);
  });
});

describe('removing the geometry', () => {
  it('a queued update ends gone and leaves the queue with no notice', async () => {
    const pid = 'c-rm-queued';
    const { sid, gid, dir } = await linkedV1(pid);
    const held = h.slot.claimComputeSlot('mesh', { project_id: 'elsewhere', mesh_id: 'm1' });
    try {
      const r = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
      const removed = await h.post('/api/geometry/remove', { project_id: pid, geometry_id: gid });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      const rec = h.record(r.body.job_id);
      assert.equal(rec.status, 'gone');
      const snap = h.queue.snapshotComputeQueue(pid);
      assert.equal(snap.items.length, 0);
      assert.equal((snap.failed || []).length, 0);
      assert.equal(existsSync(dir), false);
    } finally {
      h.slot.releaseComputeSlot(held.token);
    }
  });

  it('a running update before its commit ends gone within a second', async () => {
    const pid = 'c-rm-running';
    const { sid, gid } = await linkedV1(pid);
    let started = false;
    h.job.setLinkJobDepsForTests({
      runPreview: (_args, opts) =>
        new Promise((done) => {
          started = true;
          const t = setInterval(() => {
            if (opts.live && opts.live.aborted) {
              clearInterval(t);
              done({ code: null, stdout: '', stderr: '', timedOut: false });
            }
          }, 10);
        }),
    });
    try {
      const id = await updateV2(pid, sid);
      await h.waitFor(() => started, 30_000, 'preview started');
      const t0 = Date.now();
      const removed = await h.post('/api/geometry/remove', { project_id: pid, geometry_id: gid });
      assert.equal(removed.status, 200);
      const rec = await h.until(id, undefined, 5_000);
      assert.equal(rec.status, 'gone');
      assert.ok(Date.now() - t0 < 1500);
      await h.waitFor(() => !h.slot.computeSlotHolder(), 5_000, 'slot released');
    } finally {
      h.job.setLinkJobDepsForTests({ runPreview: null });
    }
  });

  it('a follow-up already under way never makes the removed folder again', async () => {
    const pid = 'c-rm-follow';
    h.project(pid);
    const sid = await h.study(pid);
    let release;
    const held = new Promise((r) => (release = r));
    let inCom = false;
    h.job.setLinkJobDepsForTests({
      runCom: async () => {
        inCom = true;
        await held;
        return { code: 0, stdout: 'LINK_COM {"center_of_mass":[1,2,3],"center_of_mass_kind":"volume"}\n', stderr: '', timedOut: false };
      },
    });
    const r = await h.link(pid, sid, { sourceVersion: 1 });
    await h.waitFor(() => inCom, 60_000, 'centre of mass started');
    const dir = h.geomDir(pid, r.body.geometry_id);
    const removed = await h.post('/api/geometry/remove', { project_id: pid, geometry_id: r.body.geometry_id });
    assert.equal(removed.status, 200);
    assert.equal(existsSync(dir), false);
    release();
    await h.until(r.body.job_id);
    await sleep(300);
    assert.equal(existsSync(dir), false, 'the follow-up made no folder');
  });
});

describe('follow-ups after a create', () => {
  it('an update committed meanwhile wins: the held centre of mass drops its file', async () => {
    const pid = 'c-follow-rev';
    h.project(pid);
    const sid = await h.study(pid);
    let release;
    const held = new Promise((r) => (release = r));
    let calls = 0;
    h.job.setLinkJobDepsForTests({
      runCom: async (bbrep, opts) => {
        calls += 1;
        if (calls === 1) {
          await held;
          return { code: 0, stdout: 'LINK_COM {"center_of_mass":[111,111,111],"center_of_mass_kind":"volume"}\n', stderr: '', timedOut: false };
        }
        return { code: 0, stdout: 'LINK_COM {"center_of_mass":[5,10,20],"center_of_mass_kind":"volume"}\n', stderr: '', timedOut: false, opts, bbrep };
      },
    });
    const first = await h.link(pid, sid, { sourceVersion: 1 });
    await h.waitFor(() => calls === 1, 60_000, 'create follow-up held');
    const gid = first.body.geometry_id;
    const id = await updateV2(pid, sid);
    const rec = await h.until(id);
    assert.equal(rec.status, 'done', rec.error);
    release();
    await h.until(first.body.job_id);
    const meta = JSON.parse(readFileSync(join(h.geomDir(pid, gid), 'cad_preview.json'), 'utf8'));
    assert.deepEqual(meta.center_of_mass, [5, 10, 20], "the update's own follow-up, not the create's");
    assert.equal(Math.round(meta.bounds.zmax), 30); // v2 (v1 has a boss up to z = 35)
  });
});

describe('project.json is a cache', () => {
  it('a linked geometry the record lost is shown and added back', async () => {
    const pid = 'c-repair';
    const { gid } = await linkedV1(pid);
    const path = join(h.projects, pid, 'project.json');
    const proj = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...proj, geometries: [] }, null, 2));
    const r = await h.get(`/api/project?project_id=${pid}`);
    assert.equal(r.status, 200);
    const geo = r.body.project.geometries.find((g) => g.id === gid);
    assert.ok(geo, 'the overlay shows it');
    assert.equal(geo.link.rev, 1);
    assert.equal(geo.source.plugin, 'link-demo');
    await h.waitFor(() => JSON.parse(readFileSync(path, 'utf8')).geometries.some((g) => g.id === gid), 30_000, 'repaired');
    // The active record is drawn from the linked geometry's own files.
    assert.equal(r.body.project.geometry.id, gid);
    assert.match(r.body.project.geometry.faces_url, new RegExp(`geometry_id=${gid}`));
  });
});
