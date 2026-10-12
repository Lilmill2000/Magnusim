// Linked geometries (host API 1.5), L2 step 4 "the question and Save as new" (proposal
// 5.0): when a plugin links a new shape and a simulation study on the geometry has saved
// setup, the host asks; the answer comes through POST /api/plugin-geometry/choose. "Save
// as new" adds a geometry beside the old one (no slot), copies the chosen studies' setup
// onto it through the link's own map, and leaves every file of the old geometry as it was
// but link/unlinked.json. Through the real routes and the real Python worker, with the
// fixture plugins link-demo and bc-demo (and link-demo copied as link-demo-2).
// gate:l2-choice, gate:l2-copy (node part).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { linkHarness } from './link-harness.js';

/** @type {any} */
let h;

before(async () => {
  h = await linkHarness({ name: 'link-choice', plugins: ['bc-demo', 'link-demo-2'], env: { MAGNUSIM_TEST_SLOT_HOLD: '1', MAGNUSIM_TEST_LINK_HOOKS: '1' } });
});
after(async () => {
  await h?.close();
});

const hooks = () => {
  const key = Symbol.for('magnusim.linkTestHooks');
  const g = /** @type {any} */ (globalThis);
  g[key] = g[key] || {};
  return g[key];
};

/** A project whose Demo study links v1, with one simulation study (its defaults) on it. */
async function linked(pid, opts = {}) {
  h.project(pid);
  const sid = await h.study(pid, opts);
  const r = await h.link(pid, sid, { version: 'v1', sourceVersion: 1, plugin: opts.plugin || 'link-demo' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.choosing, undefined, 'a first link never asks');
  const done = await h.until(r.body.job_id);
  assert.equal(done.status, 'done', done.error);
  const gid = r.body.geometry_id;
  const sim = await h.post('/api/simulation', { project_id: pid, geometry_id: gid, name: 'Study 1' });
  assert.ok(sim.status === 200 || sim.status === 201, JSON.stringify(sim.body));
  const simId = sim.body.simulation ? sim.body.simulation.id : sim.body.id;
  const simName = sim.body.simulation ? sim.body.simulation.name : sim.body.name;
  return { pid, sid, gid, simId, simName, plugin: opts.plugin || 'link-demo' };
}

async function addBc(p, name, faces, simId = p.simId) {
  const r = await h.post('/api/bcs', { project_id: p.pid, simulation_id: simId, name, bc_type: 'Wall', faces, geometry_rev: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.bc;
}

function studyDirOf(pid, gid, simId) {
  const sims = join(h.geomDir(pid, gid), 'simulations');
  for (const name of readdirSync(sims)) {
    const id = JSON.parse(readFileSync(join(sims, name, 'id.json'), 'utf8'));
    if (id.id === simId) return join(sims, name);
  }
  throw new Error(`no study folder ${simId}`);
}

function studiesOn(pid, gid) {
  const sims = join(h.geomDir(pid, gid), 'simulations');
  if (!existsSync(sims)) return [];
  return readdirSync(sims)
    .map((n) => {
      try {
        return { ...JSON.parse(readFileSync(join(sims, n, 'id.json'), 'utf8')), dir: join(sims, n) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function records(dir, sub, file) {
  const out = {};
  if (!existsSync(join(dir, sub))) return out;
  for (const name of readdirSync(join(dir, sub))) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, sub, name, file), 'utf8'));
      out[rec.name] = rec;
    } catch {
      /* not a record folder */
    }
  }
  return out;
}

/** Every file of a folder and its sha256 (relative paths), but the ones named. */
function hashTree(dir, skip = []) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = relative(dir, p).replace(/\\/g, '/');
        if (!skip.includes(rel)) out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

async function tree(pid) {
  const r = await h.get(`/api/project/tree?project_id=${pid}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

function writeMesh(dir, generated) {
  const m = join(dir, 'meshes', 'Mesh_1');
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, 'id.json'), JSON.stringify({ id: 'mesh-x1', name: 'Mesh 1', kind: 'mesh' }));
  writeFileSync(join(m, 'mesh.json'), JSON.stringify({ id: 'mesh-x1', name: 'Mesh 1', generated, settings: {} }));
}

function writeRun(dir, status) {
  const r = join(dir, 'simulation_runs', 'Run_1');
  mkdirSync(r, { recursive: true });
  writeFileSync(join(r, 'id.json'), JSON.stringify({ id: 'run-x1', name: 'Run 1', kind: 'run' }));
  writeFileSync(join(r, 'run.json'), JSON.stringify({ id: 'run-x1', name: 'Run 1', status, has_results: status === 'finished' }));
}

describe('the host asks only when it should', () => {
  it('never asks for a first link, equal bytes, names only, or a geometry whose studies have only their defaults', async () => {
    const p = await linked('p-noask');
    // Equal bytes: nothing changed.
    const same = await h.link(p.pid, p.sid, { version: 'v1', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.result.change, 'none');
    // A names-only change, on a geometry in use: no question.
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const names = await h.link(p.pid, p.sid, { version: 'v1', names: 'v1-renamed.face_names.json', sourceVersion: 3, basedOnRev: 1, choose: null });
    assert.equal(names.status, 202, JSON.stringify(names.body));
    assert.equal(names.body.choosing, undefined);
    assert.equal((await h.until(names.body.job_id)).status, 'done');
    // A shape change on a geometry whose only study has its defaults: no question, an overwrite.
    const q = await linked('p-defaults');
    const r = await h.link(q.pid, q.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.choosing, undefined, 'a study left with its defaults does not count');
    assert.equal(r.body.queued, true);
    const done = await h.until(r.body.job_id);
    assert.equal(done.status, 'done', done.error);
    assert.equal(h.state(q.pid, q.gid).rev, 2);
  });

  for (const [what, setUp] of [
    ['a boundary condition', async (p) => addBc(p, 'Wall 1', ['face 12@Body1'])],
    ['a generated mesh', async (p) => writeMesh(studyDirOf(p.pid, p.gid, p.simId), true)],
    ['a run with results', async (p) => writeRun(studyDirOf(p.pid, p.gid, p.simId), 'finished')],
  ]) {
    it(`asks for a shape change once a study has ${what}`, async () => {
      const p = await linked(`p-ask-${what.replace(/\W+/g, '-')}`);
      await setUp(p);
      const r = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const q = r.body.choosing;
      assert.ok(q, `asked: ${JSON.stringify(r.body)}`);
      assert.deepEqual(q.geometry, { id: p.gid, name: 'Demo 1' });
      assert.equal(q.new_name, 'Demo 1 v2');
      assert.deepEqual(q.studies, [{ id: p.simId, title: p.simName, copy: 'ok', checked: true }]);
      assert.equal(q.overwrite, 'ok');
      assert.equal(h.record(r.body.job_id).status, 'choosing');
      assert.equal(h.state(p.pid, p.gid).rev, 1, 'nothing changes while the question is open');
      const rows = h.queue.snapshotComputeQueue().items.filter((x) => x.job_id === r.body.job_id);
      assert.equal(rows.length, 0, 'a question takes no queue row');
    });
  }

  it('D36: with two studies in use only the one the geometry showed last starts checked', async () => {
    const p = await linked('p-d36');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    // A second study, made after the first: the project's active study now.
    const sim2 = await h.post('/api/simulation', { project_id: p.pid, geometry_id: p.gid, name: 'Study 2' });
    const sim2Id = sim2.body.simulation ? sim2.body.simulation.id : sim2.body.id;
    await addBc(p, 'Wall 2', ['face 1@Body1'], sim2Id);
    const r = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.deepEqual(
      r.body.choosing.studies.map((st) => [st.id, st.checked]),
      [
        [p.simId, false],
        [sim2Id, true],
      ],
    );
    await h.choose(p.pid, p.sid, r.body.job_id, 'cancel');
  });

  it('asks while the geometry is still updating (fenced), with every copy disabled and why', async () => {
    const p = await linked('p-fenced');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    // A journal no live job owns: the geometry is fenced until its recovery.
    writeFileSync(join(h.geomDir(p.pid, p.gid), 'link', 'commit.json'), JSON.stringify({ job: 'gl-gone00-000000', phase: 'swap', moves: [] }));
    const r = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.ok(r.body.choosing, JSON.stringify(r.body));
    assert.equal(r.body.choosing.fenced, true);
    assert.deepEqual(r.body.choosing.studies, [{ id: p.simId, title: p.simName, copy: 'Demo 1 is still updating', checked: false }]);
    const copyIt = await h.choose(p.pid, p.sid, r.body.job_id, 'new', [p.simId]);
    assert.equal(copyIt.status, 409, JSON.stringify(copyIt.body));
    await h.choose(p.pid, p.sid, r.body.job_id, 'cancel');
    rmSync(join(h.geomDir(p.pid, p.gid), 'link', 'commit.json'), { force: true });
  });

  it('ignores a draft mesh and a draft run', async () => {
    const p = await linked('p-drafts');
    writeMesh(studyDirOf(p.pid, p.gid, p.simId), false);
    writeRun(studyDirOf(p.pid, p.gid, p.simId), 'draft');
    const r = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.equal(r.body.choosing, undefined, JSON.stringify(r.body));
    assert.equal((await h.until(r.body.job_id)).status, 'done');
  });
});

describe('the answers', () => {
  it('"new" adds "Demo 1 v2" beside the old geometry, whose every file stays as it was but link/unlinked.json, even with the slot held', async () => {
    const p = await linked('p-new');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    writeMesh(studyDirOf(p.pid, p.gid, p.simId), true);
    const oldDir = h.geomDir(p.pid, p.gid);
    const before = hashTree(oldDir);
    const asked = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.ok(asked.body.choosing);
    const hold = await h.post('/api/test/slot-hold', {});
    assert.equal(hold.status, 200, JSON.stringify(hold.body));
    let rec;
    let chosen;
    try {
      chosen = await h.choose(p.pid, p.sid, asked.body.job_id, 'new', []);
      assert.equal(chosen.status, 202, JSON.stringify(chosen.body));
      assert.equal(chosen.body.created, true);
      assert.notEqual(chosen.body.geometry_id, p.gid);
      assert.equal(h.queue.snapshotComputeQueue().items.filter((x) => x.kind === 'geometry').length, 0, 'no queue row');
      rec = await h.until(asked.body.job_id);
    } finally {
      await h.post('/api/test/slot-release', {});
    }
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(rec.result.created, true);
    assert.equal(rec.result.geometryId, chosen.body.geometry_id);
    assert.equal(rec.result.name, 'Demo 1 v2');
    assert.equal(rec.result.rev, 1);
    assert.equal(rec.result.fromRev, null);
    const after = hashTree(oldDir, ['link/unlinked.json']);
    assert.deepEqual(after, before, 'the old geometry is untouched');
    const unlinked = JSON.parse(readFileSync(join(oldDir, 'link', 'unlinked.json'), 'utf8'));
    assert.equal(unlinked.moved_to, chosen.body.geometry_id);
    const st = h.state(p.pid, chosen.body.geometry_id);
    assert.deepEqual([st.rev, st.version, st.name], [1, 2, 'Demo 1 v2']);
    assert.ok(!existsSync(join(h.geomDir(p.pid, chosen.body.geometry_id), 'link', 'pending.json')));
    const linkedNow = await h.get(`/api/plugin-geometry/linked?project_id=${p.pid}&plugin=link-demo&study_id=${p.sid}`);
    assert.equal(linkedNow.body.linked.geometryId, chosen.body.geometry_id);
    const t = await tree(p.pid);
    const oldNode = t.geometries.find((g) => g.id === p.gid);
    const newNode = t.geometries.find((g) => g.id === chosen.body.geometry_id);
    assert.equal(oldNode.unlinked, true);
    assert.equal(oldNode.studies[0].meshes[0].out_of_date, false, "the old geometry's mesh is not out of date");
    assert.equal(newNode.unlinked, false);
    assert.equal(newNode.name, 'Demo 1 v2');
    const proj = JSON.parse(readFileSync(join(h.projects, p.pid, 'project.json'), 'utf8'));
    assert.ok(proj.geometries.some((g) => g.id === chosen.body.geometry_id), 'project.json lists the new geometry');
  });

  it('"overwrite" is the queued update; "cancel" ends cancelled with nothing written', async () => {
    const p = await linked('p-over');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const asked = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    const stage = join(h.projects, p.pid, '.magnusim-staging', `link-${asked.body.job_id}`);
    assert.ok(existsSync(join(stage, 'job.json')), 'the question keeps its staging');
    const before = hashTree(h.geomDir(p.pid, p.gid));
    const no = await h.choose(p.pid, p.sid, asked.body.job_id, 'cancel');
    assert.equal(no.status, 200, JSON.stringify(no.body));
    const ended = h.record(asked.body.job_id);
    assert.deepEqual([ended.status, ended.code], ['cancelled', 'cancelled']);
    assert.ok(!existsSync(stage), 'its staging goes');
    assert.deepEqual(hashTree(h.geomDir(p.pid, p.gid)), before, 'nothing written');
    // The next link asks again; Overwrite queues revision 6's update.
    const again = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 3, basedOnRev: 1, choose: null });
    assert.ok(again.body.choosing, 'asks again');
    const yes = await h.choose(p.pid, p.sid, again.body.job_id, 'overwrite');
    assert.equal(yes.status, 202, JSON.stringify(yes.body));
    assert.deepEqual([yes.body.queued, yes.body.created, yes.body.geometry_id], [true, false, p.gid]);
    const rec = await h.until(again.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    assert.deepEqual([rec.result.change, rec.result.rev, rec.result.geometryId], ['shape', 2, p.gid]);
  });
});

describe('versions and names', () => {
  it('a second Save as new is "Demo 1 v3", a name taken skips a version, the linked one follows a study rename, and a remove frees its version', async () => {
    const p = await linked('p-names');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const first = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: 'new' });
    const v2 = await h.until(first.body.job_id);
    assert.equal(v2.result.name, 'Demo 1 v2');
    // A study on the new one with setup, so the next shape change asks.
    const sim2 = await h.post('/api/simulation', { project_id: p.pid, geometry_id: v2.result.geometryId, name: 'Study 2' });
    const sim2Id = sim2.body.simulation ? sim2.body.simulation.id : sim2.body.id;
    await addBc(p, 'Wall 2', ['face 1@Body1'], sim2Id);
    const second = await h.link(p.pid, p.sid, { version: 'v3', sourceVersion: 3, basedOnRev: 1, choose: 'new' });
    const v3 = await h.until(second.body.job_id);
    assert.equal(v3.status, 'done', v3.error);
    assert.equal(v3.result.name, 'Demo 1 v3');
    assert.equal(h.state(p.pid, v3.result.geometryId).version, 3);
    // Another geometry named "Demo 1 v4" (an import): the next version skips that name.
    const plain = join(h.projects, p.pid, 'geometries', 'Geometry_Imported');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'id.json'), JSON.stringify({ id: 'geom-imported', name: 'Demo 1 v4', kind: 'geometry' }));
    const sim3 = await h.post('/api/simulation', { project_id: p.pid, geometry_id: v3.result.geometryId, name: 'Study 3' });
    const sim3Id = sim3.body.simulation ? sim3.body.simulation.id : sim3.body.id;
    await addBc(p, 'Wall 3', ['face 1@Body1'], sim3Id);
    const third = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 4, basedOnRev: 1, choose: 'new' });
    const v5 = await h.until(third.body.job_id);
    assert.equal(v5.status, 'done', v5.error);
    assert.equal(v5.result.name, 'Demo 1 v5');
    assert.equal(h.state(p.pid, v5.result.geometryId).version, 5);
    // A study rename: the linked one takes the new title at its next update; earlier ones keep theirs.
    const got = await h.get(`/api/plugin-studies/get?project_id=${p.pid}&plugin=link-demo&study_id=${p.sid}`);
    const ren = await h.post('/api/plugin-studies/rename', { project_id: p.pid, plugin: 'link-demo', study_id: p.sid, title: 'Wing', rev: got.body.study.rev });
    assert.equal(ren.status, 200, JSON.stringify(ren.body));
    // v3's shape on "Demo 1 v5", whose studies have no setup: no question, an overwrite.
    const named = await h.link(p.pid, p.sid, { version: 'v3', sourceVersion: 5, basedOnRev: 1, choose: null });
    assert.equal(named.body.choosing, undefined, JSON.stringify(named.body));
    const n = await h.until(named.body.job_id);
    assert.equal(n.status, 'done', n.error);
    const names = Object.fromEntries((await tree(p.pid)).geometries.map((g) => [g.id, g.name]));
    assert.equal(names[v5.result.geometryId], 'Wing v5');
    assert.equal(names[p.gid], 'Demo 1');
    assert.equal(names[v2.result.geometryId], 'Demo 1 v2');
    assert.equal(names[v3.result.geometryId], 'Demo 1 v3');
    // Remove the linked one: the next link asks first (API 1.7; refused target_removed without
    // ask_removed); "Add as new geometry" makes a new geometry with the next free version.
    const removed = await h.post('/api/geometry/remove', { project_id: p.pid, geometry_id: v5.result.geometryId });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const refused = await h.link(p.pid, p.sid, { version: 'v1', sourceVersion: 6, basedOnRev: null });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'target_removed');
    const next = await h.link(p.pid, p.sid, { version: 'v1', sourceVersion: 6, basedOnRev: null, extra: { ask_removed: true }, choose: 'new' });
    assert.equal(next.body.asked.kind, 'removed');
    assert.equal(next.body.asked.new_name, 'Wing v4');
    const created = await h.until(next.body.job_id);
    assert.equal(created.status, 'done', created.error);
    assert.equal(created.result.created, true);
    assert.equal(created.result.name, 'Wing v4');
    assert.ok(statSync(h.geomDir(p.pid, p.gid)).isDirectory(), 'earlier versions stay');
  });
});

describe('the choose route', () => {
  it('refuses another project or study, a study it did not offer, and a question already answered; no bridge call reaches it', async () => {
    const p = await linked('p-route');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const other = await linked('p-route-2');
    const asked = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    const id = asked.body.job_id;
    assert.equal((await h.choose(other.pid, p.sid, id, 'overwrite')).status, 404, 'another project');
    assert.equal((await h.choose(p.pid, other.sid, id, 'overwrite')).status, 404, 'another study');
    assert.equal((await h.choose(p.pid, p.sid, id, 'overwrite', [], 'link-demo-2')).status, 404, 'another plugin');
    const notOffered = await h.choose(p.pid, p.sid, id, 'new', ['sim-not-offered']);
    assert.equal(notOffered.status, 400, JSON.stringify(notOffered.body));
    assert.equal((await h.choose(p.pid, p.sid, id, 'maybe')).status, 400);
    assert.equal(h.record(id).status, 'choosing', 'a refused answer changes nothing');
    assert.equal((await h.choose(p.pid, p.sid, id, 'cancel')).status, 200);
    const twice = await h.choose(p.pid, p.sid, id, 'overwrite');
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'not_choosing');
  });
});

describe('a question waits', () => {
  it('a newer call supersedes it; a restart keeps it and its staging, and the events snapshot shows it', async () => {
    const p = await linked('p-wait');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const a = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    const joined = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.equal(joined.body.job_id, a.body.job_id, 'the same version and rev join the open question');
    assert.ok(joined.body.choosing);
    const older = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 1, basedOnRev: 1, choose: null });
    assert.equal(older.status, 409);
    assert.equal(older.body.code, 'stale');
    const b = await h.link(p.pid, p.sid, { version: 'v3', sourceVersion: 3, basedOnRev: 1, choose: null });
    assert.ok(b.body.choosing);
    assert.notEqual(b.body.job_id, a.body.job_id);
    assert.equal(h.record(a.body.job_id).status, 'superseded');
    assert.ok(!existsSync(join(h.projects, p.pid, '.magnusim-staging', `link-${a.body.job_id}`)));
    // A restart: the stored records are reconciled and the staging scanned again.
    h.job.reconcileLinkJobs();
    h.job.scanLinkJournals();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.record(b.body.job_id).status, 'choosing');
    assert.ok(existsSync(join(h.projects, p.pid, '.magnusim-staging', `link-${b.body.job_id}`, 'job.json')));
    // The workbench learns of it from the events snapshot.
    const ac = new AbortController();
    const res = await fetch(`${h.base}/api/plugin-geometry/events?project_id=${p.pid}&plugin=link-demo&study_id=${p.sid}`, { signal: ac.signal });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    const snap = JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5));
    const job = snap.jobs.find((j) => j.id === b.body.job_id);
    assert.equal(job.status, 'choosing');
    assert.equal(job.choosing.geometry.id, p.gid);
    // Deleting the plugin study ends it cancelled; its geometry stays.
    const del = await h.post('/api/plugin-studies/delete', { project_id: p.pid, plugin: 'link-demo', study_id: p.sid });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(h.record(b.body.job_id).status, 'cancelled');
    assert.ok(h.geomDir(p.pid, p.gid));
  });
});

describe('a question and the committed design', () => {
  it('a newer call with the committed bytes answers none and ends the open question superseded; removing the geometry ends one gone', async () => {
    const p = await linked('p-moot');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const a = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.ok(a.body.choosing);
    const back = await h.link(p.pid, p.sid, { version: 'v1', sourceVersion: 3, basedOnRev: 1, choose: null });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.result.change, 'none');
    assert.equal(h.record(a.body.job_id).status, 'superseded');
    const b = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 4, basedOnRev: 1, choose: null });
    assert.ok(b.body.choosing);
    const removed = await h.post('/api/geometry/remove', { project_id: p.pid, geometry_id: p.gid });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(h.record(b.body.job_id).status, 'gone');
    assert.ok(!existsSync(join(h.projects, p.pid, '.magnusim-staging', `link-${b.body.job_id}`)));
  });
});

describe('plugin_needed (D30)', () => {
  it('blocks Overwrite and the copy of that study, while Save as new still lands', async () => {
    const p = await linked('p-needed');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const dir = join(studyDirOf(p.pid, p.gid, p.simId), 'boundary_conditions', 'BC_Porous');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bc.json'),
      JSON.stringify({ id: 'bc-porous', name: 'Porous', registry_key: 'demo_porous', faces: [], settings: { extra_faces: ['face 12@Body1'] }, geometry_rev: 1, simulation_id: p.simId }),
    );
    const off = await h.post('/api/plugins/bc-demo/disable', {});
    assert.equal(off.status, 200, JSON.stringify(off.body));
    await h.refreshRegistry();
    try {
      const asked = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
      const q = asked.body.choosing;
      assert.ok(q, JSON.stringify(asked.body));
      const text = `Records of demo_porous come from a plugin that is off or not installed: ${p.simName} › Porous. Turn it on or install it, or delete those records, to update Demo 1.`;
      assert.equal(q.overwrite.code, 'plugin_needed');
      assert.equal(q.overwrite.message, text);
      assert.deepEqual(q.studies, [{ id: p.simId, title: p.simName, copy: text, checked: false }]);
      const over = await h.choose(p.pid, p.sid, asked.body.job_id, 'overwrite');
      assert.equal(over.status, 409);
      assert.equal(over.body.code, 'plugin_needed');
      const copyIt = await h.choose(p.pid, p.sid, asked.body.job_id, 'new', [p.simId]);
      assert.equal(copyIt.status, 409, 'a blocked copy is refused');
      const yes = await h.choose(p.pid, p.sid, asked.body.job_id, 'new', []);
      assert.equal(yes.status, 202, JSON.stringify(yes.body));
      const rec = await h.until(asked.body.job_id);
      assert.equal(rec.status, 'done', rec.error);
      assert.equal(rec.result.name, 'Demo 1 v2');
    } finally {
      await h.post('/api/plugins/bc-demo/enable', {});
      await h.refreshRegistry();
    }
  });
});

describe('a crash around the commit', () => {
  it('before the commit call: after a restart the hidden folder and its copied study are gone, and the old geometry is still linked', async () => {
    const p = await linked('p-crash-1');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const asked = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    hooks().beforeLinkCommit = () => {
      throw new Error('killed before the commit');
    };
    let newId;
    try {
      const yes = await h.choose(p.pid, p.sid, asked.body.job_id, 'new', [p.simId]);
      newId = yes.body.geometry_id;
      await h.until(asked.body.job_id);
    } finally {
      delete hooks().beforeLinkCommit;
    }
    const hidden = h.geomDir(p.pid, newId);
    assert.ok(hidden && existsSync(join(hidden, 'link', 'pending.json')), 'the hidden folder is left by the kill');
    assert.equal(studiesOn(p.pid, newId).length, 1, 'with its copied study');
    assert.ok(!(await tree(p.pid)).geometries.some((g) => g.id === newId), 'hidden from the tree');
    const listed = await h.get(`/api/simulation?project_id=${p.pid}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok((listed.body.simulations || []).every((x) => x.geometry_id !== newId), 'and from the study catalog');
    // The restart's scan.
    h.job.scanLinkJournals();
    await h.waitFor(() => !h.geomDir(p.pid, newId), 20_000, 'the pending folder to go');
    const cat = JSON.parse(readFileSync(join(h.projects, p.pid, 'simulations.json'), 'utf8'));
    assert.ok(cat.simulations.every((s) => s.geometry_id !== newId), 'no catalog row for the copy');
    const linkedNow = await h.get(`/api/plugin-geometry/linked?project_id=${p.pid}&plugin=link-demo&study_id=${p.sid}`);
    assert.equal(linkedNow.body.linked.geometryId, p.gid);
    assert.ok(!existsSync(join(h.geomDir(p.pid, p.gid), 'link', 'unlinked.json')));
  });

  it('after the commit point: the lookup gives the new one and the repair marks the old one unlinked', async () => {
    const p = await linked('p-crash-2');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const asked = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    hooks().afterLinkCommitPoint = true;
    let newId;
    try {
      const yes = await h.choose(p.pid, p.sid, asked.body.job_id, 'new', []);
      newId = yes.body.geometry_id;
      await h.until(asked.body.job_id);
    } finally {
      delete hooks().afterLinkCommitPoint;
    }
    const newDir = h.geomDir(p.pid, newId);
    assert.ok(!existsSync(join(newDir, 'link', 'pending.json')), 'the commit point passed');
    assert.ok(!existsSync(join(h.geomDir(p.pid, p.gid), 'link', 'unlinked.json')), 'unlinked.json not written yet');
    const linkedNow = await h.get(`/api/plugin-geometry/linked?project_id=${p.pid}&plugin=link-demo&study_id=${p.sid}`);
    assert.equal(linkedNow.body.linked.geometryId, newId, 'the newest linked_at wins');
    const t = await tree(p.pid);
    assert.equal(t.geometries.find((g) => g.id === p.gid).unlinked, true, 'the repair marked the old one');
    assert.ok(existsSync(join(h.geomDir(p.pid, p.gid), 'link', 'unlinked.json')));
  });
});

// ---- the copy (gate:l2-copy, node part) -------------------------------------------------

describe('"Copy the setup of <study> onto it"', () => {
  it('maps a two-solid part by name and body id, keeps lost faces, stamps rev 1, and leaves the source and the active study alone', async () => {
    const p = await linked('p-copy');
    const src = studyDirOf(p.pid, p.gid, p.simId);
    // v1: Body 2's +x side is face 17; in v2 it is face 12 (same name, another index).
    await addBc(p, 'Side', ['face 17@Body2']);
    await addBc(p, 'Top', ['face 15@Body1']); // the boss end, gone in v2
    const mat = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.simId, name: 'Air', assigned_volumes: ['Body2'], geometry_rev: 1 });
    assert.ok(mat.status === 200 || mat.status === 201, JSON.stringify(mat.body));
    const mesh = await h.post('/api/mesh', { project_id: p.pid, simulation_id: p.simId, name: 'Mesh 1' });
    const ref = await h.post('/api/mesh-refinements', { project_id: p.pid, simulation_id: p.simId, mesh_id: mesh.body.mesh.id, type: 'Surface custom sizing', faces: ['face 17@Body2'], geometry_rev: 1 });
    assert.equal(ref.status, 200, JSON.stringify(ref.body));
    const activeBefore = JSON.parse(readFileSync(join(h.projects, p.pid, 'simulations.json'), 'utf8')).active_id;
    const srcBefore = hashTree(src);
    const r = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: 'new', copy: [p.simId] });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    const newId = rec.result.geometryId;
    assert.equal(rec.copies.length, 1);
    assert.equal(rec.copies[0].ok, true, JSON.stringify(rec.copies));
    assert.ok(rec.copies[0].lost.some((l) => l.item === 'Top' && l.name === 'F:boss:end'), JSON.stringify(rec.copies[0].lost));
    assert.deepEqual(hashTree(src), srcBefore, 'the source study is only read');
    const copied = studiesOn(p.pid, newId);
    assert.equal(copied.length, 1);
    const bcs = records(copied[0].dir, 'boundary_conditions', 'bc.json');
    assert.deepEqual(bcs.Side.faces, ['face 12@Body2'], 'by name, in the paired body');
    assert.deepEqual(bcs.Top.faces, []);
    assert.equal(bcs.Top.lost_faces[0].name, 'F:boss:end');
    assert.equal(bcs.Top.lost_faces[0].reason, 'gone');
    for (const b of Object.values(bcs)) assert.equal(b.geometry_rev, 1, `${b.name} is stamped rev 1`);
    const mats = records(copied[0].dir, 'materials', 'material.json');
    assert.deepEqual(mats.Air.assigned_volumes, ['Body2']);
    assert.equal(mats.Air.geometry_rev, 1);
    const meshDir = join(copied[0].dir, 'meshes', readdirSync(join(copied[0].dir, 'meshes'))[0]);
    const meshDoc = JSON.parse(readFileSync(join(meshDir, 'mesh.json'), 'utf8'));
    assert.equal(meshDoc.generated, false, 'the copied mesh is not generated');
    const refs = records(meshDir, 'refinements', 'refinement.json');
    const refRec = Object.values(refs)[0];
    assert.deepEqual(refRec.faces, ['face 12@Body2']);
    assert.equal(refRec.geometry_rev, 1);
    const activeAfter = JSON.parse(readFileSync(join(h.projects, p.pid, 'simulations.json'), 'utf8')).active_id;
    assert.equal(activeAfter, activeBefore, 'activate:false keeps the active study');
    const cat = JSON.parse(readFileSync(join(h.projects, p.pid, 'simulations.json'), 'utf8'));
    assert.ok(cat.simulations.some((x) => x.id === copied[0].id && x.geometry_id === newId), 'the copy has its catalog row once its geometry is shown');
  });

  it('a finished run set up on an older rev: its copy keeps that stamp, so its seed faces are dropped as stale, never mapped through the wrong rev', async () => {
    const p = await linked('p-copy-old-run');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const made = await h.post('/api/run/create', { project_id: p.pid, simulation_id: p.simId, name: 'Run 1' });
    const runId = made.body.run.id;
    const views = [{ name: 'Seeds', pt: { faces: ['face 6@Body1'] } }];
    const set = await h.post('/api/run/update', { project_id: p.pid, simulation_id: p.simId, run_id: runId, views, geometry_rev: 1 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const runsDir = join(studyDirOf(p.pid, p.gid, p.simId), 'simulation_runs');
    const runFile = join(runsDir, readdirSync(runsDir).find((n) => existsSync(join(runsDir, n, 'run.json'))), 'run.json');
    const doc = JSON.parse(readFileSync(runFile, 'utf8'));
    writeFileSync(runFile, JSON.stringify({ ...doc, status: 'done', built_from: { geometry_rev: 1 } }));
    // Overwritten to rev 2: the finished run keeps its rev 1 labels (history).
    const over = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: 'overwrite' });
    assert.equal((await h.until(over.body.job_id)).status, 'done');
    assert.deepEqual(JSON.parse(readFileSync(runFile, 'utf8')).views[0].pt.faces, ['face 6@Body1']);
    const r = await h.link(p.pid, p.sid, { version: 'v3', sourceVersion: 3, basedOnRev: 2, choose: 'new', copy: [p.simId] });
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'done', rec.error);
    const copied = studiesOn(p.pid, rec.result.geometryId)[0];
    const cruns = join(copied.dir, 'simulation_runs');
    const copy = JSON.parse(readFileSync(join(cruns, readdirSync(cruns)[0], 'run.json'), 'utf8'));
    assert.deepEqual(copy.views[0].pt.faces, [], "rev 1's face 6 is not v2's face 6");
    assert.deepEqual([copy.geometry_rev, (copy.lost_faces || []).map((e) => e.reason)], [1, ['stale']]);
  });

  it('why the link map: the existing cross-geometry copy drops every face of a two-solid part', async () => {
    const { matchFaces, readPreviewFaces } = await import('../../geometry-face-match.js');
    const p = await linked('p-why');
    const r = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.equal((await h.until(r.body.job_id)).status, 'done');
    const v2 = readPreviewFaces(h.geomDir(p.pid, p.gid));
    const one = await linked('p-why-2');
    const v1 = readPreviewFaces(h.geomDir(one.pid, one.gid));
    assert.equal(matchFaces(v1, v2).size, 0, 'matchFaces refuses a geometry with two solids');
  });

  it('a copy whose plan fails is removed and reported; the new geometry still commits', async () => {
    const p = await linked('p-copy-fail');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    h.overrides.set('geometry.plan', (params, real, t) =>
      Array.isArray(params.studies) ? { ok: false, code: 'failed', error: 'injected plan error' } : real.call('geometry.plan', params, t),
    );
    let rec;
    try {
      const r = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: 'new', copy: [p.simId] });
      rec = await h.until(r.body.job_id);
    } finally {
      h.overrides.delete('geometry.plan');
    }
    assert.equal(rec.status, 'done', rec.error);
    assert.deepEqual(rec.copies.map((c) => [c.ok, c.error]), [[false, 'injected plan error']]);
    assert.deepEqual(studiesOn(p.pid, rec.result.geometryId), [], 'the failed copy is removed');
    const cat = JSON.parse(readFileSync(join(h.projects, p.pid, 'simulations.json'), 'utf8'));
    assert.ok(cat.simulations.every((s) => s.geometry_id !== rec.result.geometryId), 'with no catalog row');
    assert.ok(!existsSync(join(h.geomDir(p.pid, rec.result.geometryId), 'link', 'pending.json')), 'committed');
  });
});

/** The create's preview held until released (the job's own process otherwise). */
async function holdNextPreview() {
  const { PYTHON, PY_ROOT } = await import('../../python-env.js');
  const { spawn } = await import('node:child_process');
  let release;
  const held = new Promise((r) => (release = r));
  let first = true;
  h.job.setLinkJobDepsForTests({
    runPreview: async (args, opts) => {
      if (first) {
        first = false;
        await held;
      }
      return new Promise((done) => {
        const child = spawn(PYTHON, ['-m', 'cfddesk.cad.link_preview', ...args], { cwd: PY_ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        if (opts && opts.live) opts.live.children.add(child);
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('close', (code) => done({ code, stdout: '', stderr, timedOut: false }));
      });
    },
  });
  return release;
}

describe('while "Save as new" runs', () => {
  it('an answer about the geometry it leaves is refused until it ends, then that question ends stale; the old geometry keeps every file but link/unlinked.json', async () => {
    const p = await linked('sn-race');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const oldDir = h.geomDir(p.pid, p.gid);
    const before = hashTree(oldDir);
    const release = await holdNextPreview();
    let create;
    let q3;
    try {
      const q2 = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
      assert.ok(q2.body.choosing, JSON.stringify(q2.body));
      create = await h.choose(p.pid, p.sid, q2.body.job_id, 'new', []);
      assert.equal(create.status, 202, JSON.stringify(create.body));
      await h.waitFor(() => h.record(q2.body.job_id).status === 'running', 30_000, 'create running');
      // A newer design while the create runs: the host asks about Demo 1 again.
      q3 = await h.link(p.pid, p.sid, { version: 'v3', sourceVersion: 3, basedOnRev: 1, choose: null });
      assert.ok(q3.body.choosing, JSON.stringify(q3.body));
      const over = await h.choose(p.pid, p.sid, q3.body.job_id, 'overwrite');
      assert.deepEqual([over.status, over.body.code, over.body.error], [409, 'busy', 'Adding Demo 1 v2. Choose again when it is done.']);
      assert.equal(h.record(q3.body.job_id).status, 'choosing', 'the question stays open while the create runs');
      const asNew = await h.choose(p.pid, p.sid, q3.body.job_id, 'new', []);
      assert.deepEqual([asNew.status, asNew.body.code], [409, 'busy']);
    } finally {
      release();
      h.job.setLinkJobDepsForTests({ runPreview: null });
    }
    const made = await h.until(create.body.job_id);
    assert.equal(made.status, 'done', made.error);
    // The commit moved the link: the question about Demo 1 is moot.
    const moot = await h.until(q3.body.job_id);
    assert.deepEqual([moot.status, moot.code, moot.error], ['stale', 'stale', 'Demo 1 is no longer linked to Demo 1. Demo 1 is unchanged.']);
    const late = await h.choose(p.pid, p.sid, q3.body.job_id, 'overwrite');
    assert.deepEqual([late.status, late.body.code], [409, 'not_choosing']);
    assert.deepEqual(hashTree(oldDir, ['link/unlinked.json']), before, 'the old geometry is untouched');
  });

  it('a question about a geometry the repair marked unlinked (a crash after a commit point) ends stale when answered', async () => {
    const p = await linked('sn-repair');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const q = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
    assert.ok(q.body.choosing, JSON.stringify(q.body));
    const oldDir = h.geomDir(p.pid, p.gid);
    writeFileSync(join(oldDir, 'link', 'unlinked.json'), JSON.stringify({ moved_to: 'geom-elsewhere', job_id: 'gl-test00-000000', at: '2026-10-03T00:00:00Z' }));
    const before = hashTree(oldDir);
    const over = await h.choose(p.pid, p.sid, q.body.job_id, 'overwrite');
    assert.deepEqual([over.status, over.body.code, over.body.error], [409, 'stale', 'Demo 1 is no longer linked to Demo 1. Demo 1 is unchanged.']);
    assert.deepEqual([h.record(q.body.job_id).status, h.record(q.body.job_id).code], ['stale', 'stale']);
    assert.ok(!existsSync(join(h.projects, p.pid, '.magnusim-staging', `link-${q.body.job_id}`)), 'its staging goes');
    assert.deepEqual(hashTree(oldDir), before, 'nothing written');
  });

  it('a names-only update of the geometry it leaves waits in the queue without holding up another project, then ends stale', async () => {
    const p = await linked('sn-queue');
    await addBc(p, 'Wall 1', ['face 12@Body1']);
    const oldDir = h.geomDir(p.pid, p.gid);
    const before = hashTree(oldDir);
    const other = await linked('sn-queue-b');
    const release = await holdNextPreview();
    let create;
    let names;
    let otherUpdate;
    try {
      const q2 = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: null });
      create = await h.choose(p.pid, p.sid, q2.body.job_id, 'new', []);
      await h.waitFor(() => h.record(q2.body.job_id).status === 'running', 30_000, 'create running');
      // The same shape with new names asks nothing: an update of Demo 1 is queued.
      names = await h.link(p.pid, p.sid, { version: 'v1', names: 'v1-renamed.face_names.json', sourceVersion: 3, basedOnRev: 1, choose: null });
      assert.deepEqual([names.status, names.body.queued], [202, true], JSON.stringify(names.body));
      // Another project's update queued behind it starts on the free slot.
      otherUpdate = await h.link(other.pid, other.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1, choose: 'overwrite' });
      assert.equal(otherUpdate.status, 202, JSON.stringify(otherUpdate.body));
      const ran = await h.until(otherUpdate.body.job_id, undefined, 60_000);
      assert.equal(ran.status, 'done', `another project's update ran while the first row waited (${ran.error})`);
      assert.equal(h.record(names.body.job_id).status, 'queued', 'the update of the geometry the create leaves still waits');
    } finally {
      release();
      h.job.setLinkJobDepsForTests({ runPreview: null });
    }
    assert.equal((await h.until(create.body.job_id)).status, 'done');
    const ended = await h.until(names.body.job_id);
    assert.deepEqual([ended.status, ended.error], ['stale', 'Demo 1 is no longer linked to Demo 1. Demo 1 is unchanged.']);
    assert.deepEqual(hashTree(oldDir, ['link/unlinked.json']), before, 'the old geometry is untouched');
    assert.equal(h.queue.snapshotComputeQueue().items.filter((x) => x.kind === 'geometry').length, 0, 'its row left the queue');
  });
});
