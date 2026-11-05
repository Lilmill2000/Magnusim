// Refine out to on Surface custom sizing (the validation set's gap G4): POST /api/mesh/refinements
// keeps `reach` with its unit (`reach_unit`, the size's when none is sent), reads them back, keeps
// them on a save that does not send them, clears them with null, "" or 0 (the default band), and
// refuses a negative or non-numeric distance with words (nothing saved). An Inflate boundary layer
// has none. The panel and the Assistant: e2e/mesh-refine-reach.spec.js; the mesher:
// python/tests/unit/test_refine_reach.py.
// Real routes and router, the real worker, a projects root of its own (link-harness.js).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHarness } from './link-harness.js';

/** @type {any} */
let h;
/** @type {any} */
let layout;

before(async () => {
  h = await linkHarness({ name: 'refine-reach' });
  layout = await import('../../project-layout.js');
});

after(async () => {
  await h?.close();
});

/** A project with one geometry folder (no CAD read), a study and a mesh, through the routes. */
async function seeded(pid) {
  const dir = join(h.projects, pid);
  mkdirSync(dir, { recursive: true });
  const g = layout.createGeometryFolder(dir, { id: 'g1', name: 'Part', original_filename: 'Part.step' });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: pid, title: pid, geometries: [{ id: g.id, name: 'Part' }], active_geometry_id: g.id }));
  const made = await h.post('/api/simulation', { project_id: pid, geometry_id: g.id });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sid = made.body.simulation.id;
  const mesh = await h.post('/api/mesh', { project_id: pid, simulation_id: sid, name: 'Mesh 1' });
  assert.ok(mesh.status === 200 || mesh.status === 201, JSON.stringify(mesh.body));
  return { pid, sid, mid: mesh.body.mesh.id };
}

describe('Refine out to on Surface custom sizing', () => {
  it('is saved with its unit, read back, kept, cleared, and a bad one refused', async () => {
    const p = await seeded('p-reach');
    const post = (body) => h.post('/api/mesh/refinements', { project_id: p.pid, simulation_id: p.sid, mesh_id: p.mid, ...body });
    const stored = async (id) => (await h.get(`/api/mesh/refinements?project_id=${p.pid}&simulation_id=${p.sid}`)).body.refinements.find((r) => r.id === id);

    // A new one has none: the default band.
    const made = await post({ type: 'Surface custom sizing', faces: ['face 1@Body1'], default_size: 0.5, default_size_unit: 'mm' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = made.body.refinement.id;
    assert.deepEqual([made.body.refinement.reach, made.body.refinement.reach_unit], [null, 'mm']);

    // Saved with its unit, and read back.
    let r = await post({ id, reach: 30, reach_unit: 'mm' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.refinement.reach, r.body.refinement.reach_unit], [30, 'mm']);
    let rec = await stored(id);
    assert.deepEqual([rec.reach, rec.reach_unit, rec.default_size], [30, 'mm', 0.5]);

    // A save that does not send it (the size changed) keeps it.
    r = await post({ id, default_size: 0.4 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    rec = await stored(id);
    assert.deepEqual([rec.reach, rec.reach_unit, rec.default_size], [30, 'mm', 0.4]);

    // Another unit; a number in text is a number.
    r = await post({ id, reach: '0.05', reach_unit: 'm' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    rec = await stored(id);
    assert.deepEqual([rec.reach, rec.reach_unit], [0.05, 'm']);

    // Refused with words, nothing saved: a negative distance, and text that is not a number.
    for (const bad of [-5, 'far', true]) {
      r = await post({ id, reach: bad, default_size: 9 });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /^Refine out to must be a distance above 0, or empty for about three cells of the size/);
      assert.equal(r.body.field, 'reach');
      rec = await stored(id);
      assert.deepEqual([rec.reach, rec.reach_unit, rec.default_size], [0.05, 'm', 0.4]);
    }

    // Cleared: null, "" and 0 each mean the default band again.
    for (const clear of [null, '', 0]) {
      r = await post({ id, reach: 12 });
      assert.equal((await stored(id)).reach, 12);
      r = await post({ id, reach: clear });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await stored(id)).reach, null, `cleared by ${JSON.stringify(clear)}`);
    }

    // No unit sent: the size's.
    const inch = await post({ type: 'Surface custom sizing', faces: ['face 2@Body1'], default_size: 0.02, default_size_unit: 'in', reach: 1 });
    assert.equal(inch.status, 200, JSON.stringify(inch.body));
    assert.deepEqual([inch.body.refinement.reach, inch.body.refinement.reach_unit], [1, 'in']);
  });

  it('an Inflate boundary layer has none', async () => {
    const p = await seeded('p-reach-inflate');
    const r = await h.post('/api/mesh/refinements', {
      project_id: p.pid,
      simulation_id: p.sid,
      mesh_id: p.mid,
      type: 'Inflate boundary layer',
      faces: ['face 1@Body1'],
      reach: 30,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal('reach' in r.body.refinement, false);
    assert.equal('reach_unit' in r.body.refinement, false);
  });
});
