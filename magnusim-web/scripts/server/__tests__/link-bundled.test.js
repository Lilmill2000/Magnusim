// Linked geometries (host API 1.5), gate:l2-kinds: a BC kind of a bundled plugin that is
// off. Only the generated registry of the bundled plugins maps a kind to its plugin while
// that plugin is off; so for a bundled owner the refusal says how to fix it: "Turn <Plugin>
// on, then update <Geometry> from <Study> again." A fixture bundled folder
// (MAGNUSIM_BUNDLED_DIR) ships bc-demo as a bundled plugin, beside a copy of
// incompressible_flow, with the generated registry that goes with it.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linkHarness } from './link-harness.js';

/** @type {any} */
let h;

before(async () => {
  h = await linkHarness({ name: 'link-bundled', bundled: ['bc-demo'] });
});
after(async () => {
  await h?.close();
});

async function setPlugin(key, on) {
  const r = await h.post(`/api/plugins/${key}/${on ? 'enable' : 'disable'}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await h.refreshRegistry();
}

describe('a bundled plugin that is off owns a record of the geometry', () => {
  it('the link and the question name it: "Turn BC demo on, then update Demo 1 from Demo 1 again."', async () => {
    const pid = h.project('p-bundled');
    const sid = await h.study(pid);
    const first = await h.link(pid, sid, { version: 'v1', sourceVersion: 1 });
    assert.equal((await h.until(first.body.job_id)).status, 'done');
    const gid = first.body.geometry_id;
    const sim = await h.post('/api/simulation', { project_id: pid, geometry_id: gid, name: 'Study 1' });
    const simId = sim.body.simulation ? sim.body.simulation.id : sim.body.id;
    const bc = await h.post('/api/bcs', { project_id: pid, simulation_id: simId, name: 'Porous', bc_type: 'Demo porous', faces: [], extra_faces: ['face 12@Body1'], geometry_rev: 1 });
    assert.equal(bc.status, 200, JSON.stringify(bc.body));
    await setPlugin('bc-demo', false);
    const text = 'Turn BC demo on, then update Demo 1 from Demo 1 again. Demo 1 keeps its last update.';
    try {
      // With no question (the same shape, new names): refused at the call.
      const names = await h.link(pid, sid, { version: 'v1', names: 'v1-renamed.face_names.json', sourceVersion: 2, basedOnRev: 1 });
      assert.deepEqual([names.status, names.body.code, names.body.error], [409, 'plugin_needed', text]);
      // A new shape asks: Overwrite is disabled with the same words.
      const asked = await h.link(pid, sid, { version: 'v2', sourceVersion: 3, basedOnRev: 1, choose: null });
      assert.ok(asked.body.choosing, JSON.stringify(asked.body));
      assert.deepEqual([asked.body.choosing.overwrite.code, asked.body.choosing.overwrite.message], ['plugin_needed', text]);
      await h.choose(pid, sid, asked.body.job_id, 'cancel');
    } finally {
      await setPlugin('bc-demo', true);
    }
    assert.equal(h.state(pid, gid).rev, 1, 'nothing was written');
  });
});
