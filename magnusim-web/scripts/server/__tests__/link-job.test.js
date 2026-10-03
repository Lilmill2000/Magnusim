// Linked geometries (host API 1.5), L2 step 1 "the job and the files": the link call, the
// create, the queued update, its commit (plan, swap, apply) and its follow-ups, through
// the real routes and the real Python worker (fixture plugin link-demo).
// gate:l2-commit, gate:l2-slot, gate:l2-routes (step 1's part).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHarness, sleep } from './link-harness.js';

/** @type {any} */
let h;

before(async () => {
  h = await linkHarness({ name: 'link-job', plugins: ['link-demo-2'] });
});
after(async () => {
  await h?.close();
});

const NAME = 'Geometry_Demo_1';

describe('the first link: a create, outside the compute slot', () => {
  it('makes the geometry folder, its link state and its project record, with no queue row and no slot', async () => {
    const pid = h.project('p-create');
    const sid = await h.study(pid);
    let claimedDuring = false;
    const watch = setInterval(() => {
      if (h.slot.computeSlotHolder()) claimedDuring = true;
    }, 5);
    const r = await h.link(pid, sid, { version: 'v1', sourceVersion: 1 });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.created, true);
    assert.equal(r.body.queued, false);
    assert.match(r.body.job_id, h.store.LINK_JOB_RE);
    assert.equal(h.queue.snapshotComputeQueue().items.length, 0, 'a create takes no queue row');
    const rec = await h.until(r.body.job_id);
    clearInterval(watch);
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(claimedDuring, false, 'a create never claims the compute slot');
    assert.equal(rec.result.created, true);
    assert.equal(rec.result.rev, 1);
    assert.equal(rec.result.geometryId, r.body.geometry_id);
    const dir = h.geomDir(pid, r.body.geometry_id);
    assert.ok(dir && dir.endsWith(NAME), dir);
    const id = JSON.parse(readFileSync(join(dir, 'id.json'), 'utf8'));
    assert.deepEqual(
      { type: id.source.type, plugin: id.source.plugin, study_id: id.source.study_id, workspace: id.source.workspace },
      { type: 'plugin_study', plugin: 'link-demo', study_id: sid, workspace: 'demo' },
    );
    assert.ok(id.source.linked_at);
    for (const f of ['source.bbrep', 'cad_faces.vtp', 'cad_edges.vtp', 'cad_preview.json', 'face_names.json', 'thumb.png']) {
      assert.ok(existsSync(join(dir, f)), f);
    }
    assert.equal(existsSync(join(dir, 'source.step')), false, 'no STEP copy');
    const state = h.state(pid, r.body.geometry_id);
    assert.equal(state.rev, 1);
    assert.equal(state.version, 1);
    assert.equal(state.source_version, 1);
    assert.equal(state.name, 'Demo 1');
    assert.equal(state.n_solids, 2);
    assert.equal(state.n_faces, 21);
    assert.deepEqual(state.bodies, [
      { index: 1, ref: 'Body1', id: 'b1', name: 'Body 1' },
      { index: 2, ref: 'Body2', id: 'b2', name: 'Body 2' },
    ]);
    const meta = JSON.parse(readFileSync(join(dir, 'cad_preview.json'), 'utf8'));
    assert.ok(Array.isArray(meta.center_of_mass), 'the centre of mass follow-up ran');
    const proj = JSON.parse(readFileSync(join(h.projects, pid, 'project.json'), 'utf8'));
    const geo = proj.geometries.find((g) => g.id === r.body.geometry_id);
    assert.ok(geo, 'project.upsert_geometry added the record');
    assert.equal(geo.source_kind, 'plugin');
    // A project that showed no geometry shows its first linked one, as after a first import.
    assert.equal(proj.active_geometry_id, r.body.geometry_id);
    assert.equal(proj.geometry.faces_url, `/api/geometry/cad?project_id=${pid}&geometry_id=${r.body.geometry_id}&part=faces`);
    // Nothing of the job is left in staging.
    await h.waitFor(() => !existsSync(join(h.projects, pid, '.magnusim-staging', `link-${r.body.job_id}`)), 10_000, 'staging removed');
    // The tree shows it with its link fields; GET linked answers it.
    const tree = await h.get(`/api/project/tree?project_id=${pid}`);
    const node = tree.body.geometries.find((g) => g.id === r.body.geometry_id);
    assert.equal(node.name, 'Demo 1');
    assert.equal(node.rev, 1);
    assert.deepEqual(node.source, { plugin: 'link-demo', study_id: sid, workspace: 'demo', study_title: 'Demo 1' });
    const linked = await h.get(`/api/plugin-geometry/linked?project_id=${pid}&plugin=link-demo&study_id=${sid}`);
    assert.equal(linked.body.linked.geometryId, r.body.geometry_id);
    assert.equal(linked.body.linked.state, 'ok');
    assert.equal(linked.body.linked.sourceVersion, 1);
  });

  it('a failed first link leaves no folder in geometries/', async () => {
    const pid = h.project('p-create-bad');
    const sid = await h.study(pid);
    const r = await h.link(pid, sid, { shapeFile: Buffer.from('not a brep at all'), names: null, sourceVersion: 1 });
    assert.equal(r.status, 202);
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.code, 'bad_brep');
    assert.equal(h.geomDir(pid, r.body.geometry_id), null);
  });

  it('a create whose folder name a plain import took gets a unique folder', async () => {
    const pid = h.project('p-create-name');
    const sid = await h.study(pid);
    const taken = join(h.projects, pid, 'geometries', NAME);
    await import('node:fs').then((fs) => fs.mkdirSync(taken, { recursive: true }));
    writeFileSync(join(taken, 'id.json'), JSON.stringify({ id: 'geom-plain', name: 'Demo 1', kind: 'geometry' }));
    const r = await h.link(pid, sid, { sourceVersion: 1 });
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.ok(h.geomDir(pid, r.body.geometry_id).endsWith(`${NAME}_2`));
    assert.equal(JSON.parse(readFileSync(join(taken, 'id.json'), 'utf8')).id, 'geom-plain');
  });
});

describe('`none` at the call', () => {
  it('records the newer version through the main lane, takes no slot and leaves no staging', async () => {
    const pid = h.project('p-none');
    const sid = await h.study(pid);
    const first = await h.link(pid, sid, { sourceVersion: 5 });
    await h.until(first.body.job_id);
    const gid = first.body.geometry_id;
    // The same bytes, a newer version, with the slot held by another job: answered at once.
    const held = h.slot.claimComputeSlot('solve', { project_id: 'elsewhere', run_id: 'r1' });
    try {
      const again = await h.link(pid, sid, { sourceVersion: 7, basedOnRev: 1 });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.result.change, 'none');
      assert.equal(again.body.result.rev, 1);
      assert.equal(h.state(pid, gid).source_version, 7);
      // An older version is stale now.
      const old = await h.link(pid, sid, { sourceVersion: 6, basedOnRev: 1 });
      assert.equal(old.status, 409);
      assert.equal(old.body.code, 'stale');
      // The bytes of the committed design are never stale for their basedOnRev.
      const honest = await h.link(pid, sid, { sourceVersion: 7, basedOnRev: 0 });
      assert.equal(honest.status, 200);
      assert.equal(honest.body.result.change, 'none');
    } finally {
      h.slot.releaseComputeSlot(held.token);
    }
    const staging = join(h.projects, pid, '.magnusim-staging');
    const left = existsSync(staging) ? (await import('node:fs')).readdirSync(staging) : [];
    assert.deepEqual(left, []);
  });
});

describe('an update: a queued compute job', () => {
  it('queues, starts on the free slot, commits rev 2 and moves the old shape files aside', async () => {
    const pid = h.project('p-update');
    const sid = await h.study(pid);
    const first = await h.link(pid, sid, { sourceVersion: 1 });
    await h.until(first.body.job_id);
    const gid = first.body.geometry_id;
    const dir = h.geomDir(pid, gid);
    // A mesh input and a STEP copy of v1: stale after a shape change.
    writeFileSync(join(dir, 'Body1.stl'), 'solid v1');
    writeFileSync(join(dir, 'Body1.json'), '{}');
    writeFileSync(join(dir, 'source.step'), 'ISO-10303-21;');
    const held = h.slot.claimComputeSlot('mesh', { project_id: pid, mesh_id: 'm1', name: 'Mesh 1' });
    let r;
    try {
      r = await h.link(pid, sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.deepEqual([r.body.created, r.body.queued, r.body.geometry_id], [false, true, gid]);
      const snap = h.queue.snapshotComputeQueue(pid);
      assert.equal(snap.items.length, 1);
      assert.equal(snap.items[0].kind, 'geometry');
      assert.equal(snap.items[0].name, 'Update Demo 1 from Demo 1');
      assert.deepEqual(snap.items[0].geometry, { plugin: 'link-demo', study_id: sid, geometry_id: gid });
      await sleep(300);
      assert.equal(h.record(r.body.job_id).status, 'queued');
    } finally {
      h.slot.releaseComputeSlot(held.token);
    }
    await h.queue.kickComputeQueue();
    const holder = h.slot.computeSlotHolder();
    assert.equal(holder && holder.kind, 'geometry');
    assert.equal(holder.geometry_id, gid);
    assert.equal(holder.name, 'Update Demo 1 from Demo 1');
    // The Queue chip's busy job carries the geometry.
    const live = (await h.get(`/api/compute-queue?project_id=${pid}`)).body.busy;
    assert.equal(live.kind, 'geometry');
    assert.equal(live.geometry_id, gid);
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.deepEqual([rec.result.change, rec.result.rev, rec.result.fromRev, rec.result.created], ['shape', 2, 1, false]);
    await h.waitFor(() => !h.slot.computeSlotHolder(), 30_000, 'the slot freed after the follow-ups');
    const state = h.state(pid, gid);
    assert.equal(state.rev, 2);
    assert.equal(state.job_id, r.body.job_id);
    for (const f of ['Body1.stl', 'Body1.json', 'source.step']) assert.equal(existsSync(join(dir, f)), false, `${f} moved aside`);
    assert.equal(existsSync(join(dir, 'link', 'commit.json')), false, 'no journal left');
    const last = JSON.parse(readFileSync(join(dir, 'link', 'last-update.json'), 'utf8'));
    assert.deepEqual([last.rev, last.from_rev], [2, 1]);
    const meta = JSON.parse(readFileSync(join(dir, 'cad_preview.json'), 'utf8'));
    // v1 has a boss up to z = 35; v2 has none (tools/gen_link_demo_fixtures.py).
    assert.equal(Math.round(meta.bounds.zmax), 30, 'the new shape is live');
    assert.ok(Array.isArray(meta.center_of_mass));
    assert.equal(h.queue.snapshotComputeQueue(pid).items.length, 0);
  });

  it('a names-only change keeps the rev and the mesh input', async () => {
    const pid = h.project('p-names');
    const sid = await h.study(pid);
    const first = await h.link(pid, sid, { sourceVersion: 1 });
    await h.until(first.body.job_id);
    const gid = first.body.geometry_id;
    const dir = h.geomDir(pid, gid);
    writeFileSync(join(dir, 'Body1.stl'), 'solid v1');
    const before = h.state(pid, gid);
    const r = await h.link(pid, sid, { version: 'v1', names: 'v1-renamed.face_names.json', sourceVersion: 2, basedOnRev: 1 });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await h.queue.kickComputeQueue();
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(rec.result.change, 'names');
    const after = h.state(pid, gid);
    assert.equal(after.rev, 1);
    assert.notEqual(after.names_sha256, before.names_sha256);
    assert.equal(after.source_version, 2);
    assert.equal(readFileSync(join(dir, 'Body1.stl'), 'utf8'), 'solid v1');
    assert.equal(existsSync(join(dir, 'link', 'last-update.json')), false, 'a names change keeps the last rev change');
    assert.ok(readFileSync(join(dir, 'face_names.json'), 'utf8').includes('Renamed Box'));
  });
});
