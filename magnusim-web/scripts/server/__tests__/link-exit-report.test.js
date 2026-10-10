// Exit-sync fixes (the CAD session's review of the exits, 2026-10-04), the server's side,
// through the real routes and the real Python worker (fixture plugin link-demo):
//   - the update report names only faces a record refers to: the job keeps `setup` (faces
//     records hold that moved far, split or merged, each with its record) beside the
//     plugin's LinkResult, whose `match` counts stay statistics of the whole part; the end
//     event and the status route carry it;
//   - "Queued" only for a job that waits: the route's `waiting` and each `queued` event's;
//   - the stage `finishing` says what it still waits for (the centre of mass, the thumbnail,
//     the project file), with a fraction, as each follow-up ends.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHarness, sleep } from './link-harness.js';

/** @type {any} */
let h;

before(async () => {
  h = await linkHarness({ name: 'link-exit-report' });
});
after(async () => {
  await h?.close();
});

/** A simulation study on the geometry with one BC on `faces` at `rev` (as the BC panel saves it). */
function bcOn(dir, gid, name, faces, rev) {
  const s = join(dir, 'simulations', 'Study_1');
  mkdirSync(join(s, 'boundary_conditions', `BC_${name}`), { recursive: true });
  writeFileSync(join(s, 'id.json'), JSON.stringify({ id: 'sim-1', name: 'Study 1', geometry_id: gid, kind: 'simulation' }));
  writeFileSync(
    join(s, 'boundary_conditions', `BC_${name}`, 'bc.json'),
    JSON.stringify({ id: `bc-${name.toLowerCase()}`, name, bc_type: 'Wall', faces, face: faces[0], geometry_rev: rev, simulation_id: 'sim-1' }),
  );
}

const endOf = (id) => (h.store.recentLinkEvents(id).find((e) => e.ev.event === 'end') || {}).ev;

describe('the update report names only faces a record refers to', () => {
  it('six faces moved far, none held: an empty setup (job, end event, status); a held one is named with its record', async () => {
    const pid = h.project('p-setup');
    const sid = await h.study(pid);
    const first = await h.link(pid, sid, { sourceVersion: 1 });
    assert.equal((await h.until(first.body.job_id)).status, 'done');
    const gid = first.body.geometry_id;
    const dir = h.geomDir(pid, gid);
    // v1 to v4: the boss and Body 2's top stand 10 mm higher; Body 2's bottom (face 20) does not move.
    bcOn(dir, gid, 'Floor', ['face 20@Body2'], 1);
    const r = await h.link(pid, sid, { version: 'v4', sourceVersion: 2, basedOnRev: 1 });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await h.queue.kickComputeQueue();
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    // The plugin's LinkResult keeps the part's statistics...
    assert.equal(rec.result.match.movedFar, 6);
    // ...but nothing of it touches a record: nothing to report.
    const none = { movedFar: [], split: [], merged: [], stale: [], inside: [] };
    assert.deepEqual(rec.setup, none);
    assert.deepEqual(endOf(r.body.job_id).setup, none);
    const st = await h.get(`/api/plugin-geometry/status?project_id=${pid}&plugin=link-demo&study_id=${sid}&job_id=${r.body.job_id}`);
    assert.deepEqual(st.body.job.setup, none);
    assert.equal('setup' in rec.result, false, 'not part of LinkResult (the plugin API)');
    // A BC on the boss end (face 15 at rev 2), then back to v1: the boss moves 10 mm down.
    bcOn(dir, gid, 'Top', ['face 15@Body1'], 2);
    const r2 = await h.link(pid, sid, { version: 'v1', sourceVersion: 3, basedOnRev: 2 });
    await h.queue.kickComputeQueue();
    const rec2 = await h.until(r2.body.job_id);
    assert.equal(rec2.status, 'done', rec2.error);
    assert.deepEqual(rec2.setup.movedFar, [
      { studyId: 'sim-1', studyTitle: 'Study 1', kind: 'bc', item: 'Top', field: 'faces', old: 'face 15@Body1', name: 'F:boss:end', label: 'Boss end' },
    ]);
    assert.deepEqual([rec2.setup.split, rec2.setup.merged, rec2.setup.stale], [[], [], []]);
    assert.deepEqual(endOf(r2.body.job_id).setup, rec2.setup);
  });
});

describe('"Queued" only for a job that waits', () => {
  it('a free slot: the route and the queued event say waiting:false; a held slot: waiting:true', async () => {
    const pid = h.project('p-wait');
    const sid = await h.study(pid);
    const first = await h.link(pid, sid, { sourceVersion: 1 });
    await h.until(first.body.job_id);
    const r = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
    assert.deepEqual([r.status, r.body.queued, r.body.waiting], [202, true, false]);
    const q = h.store.recentLinkEvents(r.body.job_id).find((e) => e.ev.event === 'queued');
    assert.equal(q.ev.waiting, false);
    await h.queue.kickComputeQueue();
    assert.equal((await h.until(r.body.job_id)).status, 'done');
    await h.waitFor(() => !h.slot.computeSlotHolder(), 30_000, 'the slot freed');
    const held = h.slot.claimComputeSlot('mesh', { project_id: pid, mesh_id: 'm1', name: 'Mesh 1' });
    let r2;
    try {
      r2 = await h.link(pid, sid, { version: 'v3', sourceVersion: 3, basedOnRev: 2 });
      assert.deepEqual([r2.body.queued, r2.body.waiting], [true, true]);
      assert.equal(h.store.recentLinkEvents(r2.body.job_id).find((e) => e.ev.event === 'queued').ev.waiting, true);
      await sleep(300);
    } finally {
      h.slot.releaseComputeSlot(held.token);
    }
    await h.queue.kickComputeQueue();
    assert.equal((await h.until(r2.body.job_id)).status, 'done');
  });
});

describe('Finishing says what it still waits for', () => {
  it('an update: the centre of mass, the thumbnail and the project file, then each one done, with its fraction', async () => {
    const pid = h.project('p-finish');
    const sid = await h.study(pid);
    const first = await h.link(pid, sid, { sourceVersion: 1 });
    await h.until(first.body.job_id);
    const r = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
    await h.queue.kickComputeQueue();
    assert.equal((await h.until(r.body.job_id)).status, 'done');
    const fin = h.store
      .recentLinkEvents(r.body.job_id)
      .map((e) => e.ev)
      .filter((e) => e.event === 'stage' && e.stage === 'finishing');
    assert.deepEqual(fin[0], { event: 'stage', stage: 'finishing', fraction: null });
    assert.deepEqual([fin[1].label, fin[1].fraction], ['Finishing: the centre of mass, the thumbnail and the project file', 0]);
    assert.deepEqual(
      fin.slice(2).map((e) => [/\((\d) of 3 done\)$/.exec(e.label)?.[1], e.fraction]),
      [
        ['1', 1 / 3],
        ['2', 2 / 3],
      ],
    );
    // A first link has no project file to write: two follow-ups.
    const pid2 = h.project('p-finish-create');
    const sid2 = await h.study(pid2);
    const c = await h.link(pid2, sid2, { sourceVersion: 1 });
    await h.until(c.body.job_id);
    const fin2 = h.store
      .recentLinkEvents(c.body.job_id)
      .map((e) => e.ev)
      .filter((e) => e.event === 'stage' && e.stage === 'finishing' && e.label);
    assert.equal(fin2[0].label, 'Finishing: the centre of mass and the thumbnail');
    assert.match(fin2[1].label, /^Finishing: the (centre of mass|thumbnail) \(1 of 2 done\)$/);
  });
});
