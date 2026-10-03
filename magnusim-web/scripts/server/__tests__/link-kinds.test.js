// Linked geometries (host API 1.5), L2 step 2: records whose kind belongs to another
// plugin (gate:l2-kinds). The host can tell which fields of a record hold faces only from
// its kind's schema; while the plugin that owns the kind is off or not installed, an
// update is refused (plugin_needed) with the records listed, and nothing is written. With
// the plugin on, its schema's face field is rewritten like any face list. The fixture
// plugin bc-demo owns the BC family "Demo porous" (its field `extra_faces`, widget faces),
// whose records are made as the BC panel makes them: POST /api/bcs with that bc_type.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { linkHarness } from './link-harness.js';

/** @type {any} */
let h;

before(async () => {
  h = await linkHarness({ name: 'link-kinds', plugins: ['bc-demo'], env: { MAGNUSIM_TEST_SLOT_HOLD: '1' } });
});
after(async () => {
  await h?.close();
});

function studyDirOf(p) {
  const sims = join(h.geomDir(p.pid, p.gid), 'simulations');
  for (const name of readdirSync(sims)) {
    const id = JSON.parse(readFileSync(join(sims, name, 'id.json'), 'utf8'));
    if (id.id === p.simId) return join(sims, name);
  }
  throw new Error('no study folder');
}

/** A BC of bc-demo's family, made through the BC route as the panel makes it; its folder record. */
async function porousRecord(p, rev) {
  const r = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, name: 'Porous', bc_type: 'Demo porous', faces: [], extra_faces: ['face 12@Body1'], geometry_rev: rev });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bc.registry_key, undefined, 'the panel saves no registry_key');
  assert.deepEqual([r.body.bc.bc_type, r.body.bc.extra_faces], ['Demo porous', ['face 12@Body1']]);
  p.porousId = r.body.bc.id;
  const dir = join(studyDirOf(p), 'boundary_conditions');
  const folder = readdirSync(dir).find((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f, 'bc.json'), 'utf8')).id === r.body.bc.id;
    } catch {
      return false;
    }
  });
  return join(dir, folder, 'bc.json');
}

async function setPlugin(key, on) {
  const r = await h.post(`/api/plugins/${key}/${on ? 'enable' : 'disable'}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await h.refreshRegistry();
}

async function ended(r) {
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return h.until(r.body.job_id);
}

describe("a record of another plugin's kind", () => {
  /** @type {any} */
  const p = {};

  it('is rewritten through its schema while its plugin is on', async () => {
    p.pid = h.project('p-kinds');
    p.sid = await h.study(p.pid);
    const first = await h.link(p.pid, p.sid, { version: 'v1', sourceVersion: 1 });
    const created = await ended(first);
    assert.equal(created.status, 'done', created.error);
    p.gid = first.body.geometry_id;
    const sim = await h.post('/api/simulation', { project_id: p.pid, geometry_id: p.gid, name: 'Study 1' });
    p.simId = sim.body.simulation ? sim.body.simulation.id : sim.body.id;
    p.simName = sim.body.simulation ? sim.body.simulation.name : sim.body.name;
    const file = await porousRecord(p, 1);
    const rec = await ended(await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 }));
    assert.equal(rec.status, 'done', rec.error);
    const bc = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(bc.extra_faces.slice().sort(), ['face 4@Body1', 'face 8@Body1'], "the family's face field follows the +y face");
    assert.equal(bc.geometry_rev, 2);
    const listed = (await h.get(`/api/bcs?project_id=${p.pid}&simulation_id=${p.simId}`)).body.boundary_conditions.find((b) => b.name === 'Porous');
    assert.deepEqual(listed.extra_faces.slice().sort(), ['face 4@Body1', 'face 8@Body1'], 'the BC list (what the panel reads) shows the new faces');
  });

  it('blocks an update while its plugin is off, and lists itself', async () => {
    await setPlugin('bc-demo', false);
    const before = h.state(p.pid, p.gid);
    const r = await h.link(p.pid, p.sid, { version: 'v3', sourceVersion: 3, basedOnRev: 2 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'plugin_needed');
    assert.equal(
      r.body.error,
      `Records of Demo porous come from a plugin that is off or not installed: ${p.simName} › Porous. Turn it on or install it, or delete those records, to update Demo 1.`,
    );
    assert.deepEqual(r.body.records, [{ kind: 'bc', key: 'Demo porous', study: p.simName, studyId: p.simId, name: 'Porous' }]);
    assert.deepEqual(h.state(p.pid, p.gid), before, 'nothing was written');
  });

  it('is refused the same way when its plugin is not installed, and an update commits once the record is deleted', async () => {
    await setPlugin('bc-demo', true);
    rmSync(join(h.plugins, 'bc-demo'), { recursive: true, force: true });
    const reload = await h.post('/api/worker', { method: 'registry.reload', params: {} });
    assert.equal(reload.status, 200, JSON.stringify(reload.body));
    await h.refreshRegistry();
    const r = await h.link(p.pid, p.sid, { version: 'v3', sourceVersion: 3, basedOnRev: 2 });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'plugin_needed');
    assert.ok(r.body.error.includes(`off or not installed: ${p.simName} › Porous`), r.body.error);
    const del = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, delete: p.porousId });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const rec = await ended(await h.link(p.pid, p.sid, { version: 'v3', sourceVersion: 4, basedOnRev: 2 }));
    assert.equal(rec.status, 'done', rec.error);
    assert.equal(h.state(p.pid, p.gid).rev, 3);
  });

  it('refuses in the plan when its plugin goes off between the call and the commit: nothing written', async () => {
    // bc-demo back, and a record of its kind again.
    const { cpSync } = await import('node:fs');
    const { WEB } = await import('./link-harness.js');
    cpSync(join(WEB, 'python', 'tests', 'fixtures', 'link-plugins', 'bc-demo'), join(h.plugins, 'bc-demo'), { recursive: true });
    await h.post('/api/worker', { method: 'registry.reload', params: {} });
    await setPlugin('bc-demo', true);
    const file = await porousRecord(p, 3);
    const hold = await h.post('/api/test/slot-hold', {});
    assert.equal(hold.status, 200);
    let r;
    try {
      r = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 5, basedOnRev: 3 });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.equal(r.body.queued, true);
      await setPlugin('bc-demo', false);
    } finally {
      await h.post('/api/test/slot-release', {});
    }
    h.queue.scheduleComputeQueueKick(0);
    const rec = await h.until(r.body.job_id);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.code, 'plugin_needed');
    assert.equal(h.state(p.pid, p.gid).rev, 3, 'the geometry keeps its last update');
    const bc = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(bc.extra_faces, ['face 12@Body1']);
  });
});

describe('a record of a family whose plugin is off, never read as a core wall', () => {
  it('a family record (bc_type Demo porous, no registry_key) with bc-demo off is its own unknown kind', async () => {
    const q = { pid: h.project('p-kinds-family') };
    q.sid = await h.study(q.pid);
    const first = await ended(await h.link(q.pid, q.sid, { version: 'v1', sourceVersion: 1 }));
    assert.equal(first.status, 'done', first.error);
    q.gid = first.geometry_id;
    const sim = await h.post('/api/simulation', { project_id: q.pid, geometry_id: q.gid, name: 'Study 1' });
    q.simId = sim.body.simulation ? sim.body.simulation.id : sim.body.id;
    q.simName = sim.body.simulation ? sim.body.simulation.name : sim.body.name;
    await setPlugin('bc-demo', true);
    await porousRecord(q, 1);
    await setPlugin('bc-demo', false);
    try {
      // The same shape with new names asks nothing: refused at the call.
      const r = await h.link(q.pid, q.sid, { version: 'v1', names: 'v1-renamed.face_names.json', sourceVersion: 2, basedOnRev: 1 });
      assert.deepEqual([r.status, r.body.code], [409, 'plugin_needed'], JSON.stringify(r.body));
      assert.deepEqual(r.body.records, [{ kind: 'bc', key: 'Demo porous', study: q.simName, studyId: q.simId, name: 'Porous' }]);
      const kinds = await h.real.call('geometry.check_kinds', { project_id: q.pid, geometry_id: q.gid });
      assert.deepEqual(kinds.unknown.map((u) => [u.key, u.owner, u.bundled_off]), [['Demo porous', null, false]]);
    } finally {
      await setPlugin('bc-demo', true);
    }
  });
});
