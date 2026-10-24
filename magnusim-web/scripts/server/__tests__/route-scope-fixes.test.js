// Route bugs found by the core host tools review (each once answered as if it worked):
//  - {delete: true, id} to /api/bcs and /api/mesh/refinements deleted every record of the study
//  - POST /api/materials with an id the study does not have updated its first material
//  - queue removal and reorder reached other projects' rows
//  - /api/times, /api/plot-over-path and the field routes read any `case` folder with no project_id
//  - POST /api/simulation/activate answered 200 to an unknown study
//  - POST /api/simulation ignored `name`
//  - an empty POST /api/mesh restored the mesh's defaults
//  - POST /api/mesh/delete skipped the hook POST /api/mesh {delete_generated} runs
//  - the raw geometry import had no size cap, and step_path copied in any file
// Real routes and router, the real worker, a projects root of its own (link-harness.js).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHarness } from './link-harness.js';

/** @type {any} */
let h;
/** @type {any} */
let layout;
/** @type {any} */
let io;

before(async () => {
  h = await linkHarness({ name: 'route-fixes', env: { MAGNUSIM_IMPORT_MAX_MB: '1' } });
  layout = await import('../../project-layout.js');
  io = await import('../../study-io.js');
});

after(async () => {
  await h?.close();
});

/** A project with one geometry folder (no CAD read) and one study made through the route. */
async function seeded(pid, studyName) {
  const dir = join(h.projects, pid);
  mkdirSync(dir, { recursive: true });
  const g = layout.createGeometryFolder(dir, { id: 'g1', name: 'Part', original_filename: 'Part.step' });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({ id: pid, title: pid, geometries: [{ id: g.id, name: 'Part' }], active_geometry_id: g.id }),
  );
  const made = await h.post('/api/simulation', { project_id: pid, geometry_id: g.id, ...(studyName ? { name: studyName } : {}) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { pid, dir, sid: made.body.simulation.id, sim: made.body.simulation };
}

describe('record deletes name one record', () => {
  it('{delete: true, id} deletes only that BC; a bare delete:true is refused; delete:"all" deletes all', async () => {
    const p = await seeded('p-bcs');
    const ids = [];
    for (const face of ['face 1@Body1', 'face 2@Body1']) {
      const r = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.sid, bc_type: 'Wall', faces: [face] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      ids.push(r.body.boundary_condition ? r.body.boundary_condition.id : r.body.boundary_conditions.slice(-1)[0].id);
    }
    const list = async () => (await h.get(`/api/bcs?project_id=${p.pid}&simulation_id=${p.sid}`)).body.boundary_conditions.map((b) => b.id);
    assert.deepEqual((await list()).sort(), ids.slice().sort());

    const one = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.sid, delete: true, id: ids[0] });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(await list(), [ids[1]]);

    const bare = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.sid, delete: true });
    assert.equal(bare.status, 400, JSON.stringify(bare.body));
    assert.deepEqual(await list(), [ids[1]]);

    const all = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.sid, delete: 'all' });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(await list(), []);
  });

  it('{delete: true, id} deletes only that refinement; a bare delete:true is refused', async () => {
    const p = await seeded('p-refs');
    const mesh = await h.post('/api/mesh', { project_id: p.pid, simulation_id: p.sid, name: 'Mesh 1' });
    assert.ok(mesh.status === 200 || mesh.status === 201, JSON.stringify(mesh.body));
    const meshId = mesh.body.mesh.id;
    const ids = [];
    for (const face of ['face 1@Body1', 'face 2@Body1']) {
      const r = await h.post('/api/mesh/refinements', { project_id: p.pid, simulation_id: p.sid, mesh_id: meshId, type: 'Surface custom sizing', faces: [face] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      ids.push(r.body.refinement.id);
    }
    const list = async () => (await h.get(`/api/mesh/refinements?project_id=${p.pid}&simulation_id=${p.sid}`)).body.refinements.map((r) => r.id);
    assert.deepEqual((await list()).sort(), ids.slice().sort());

    const one = await h.post('/api/mesh/refinements', { project_id: p.pid, simulation_id: p.sid, delete: true, id: ids[1] });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(await list(), [ids[0]]);

    const bare = await h.post('/api/mesh/refinements', { project_id: p.pid, simulation_id: p.sid, action: 'delete' });
    assert.equal(bare.status, 400, JSON.stringify(bare.body));
    assert.deepEqual(await list(), [ids[0]]);
  });
});

describe('POST /api/materials', () => {
  it('an id the study does not have adds a second material; the first keeps its own', async () => {
    const p = await seeded('p-mats');
    const first = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.sid, name: 'Air', assigned_volumes: ['Body1'] });
    assert.ok(first.status === 200 || first.status === 201, JSON.stringify(first.body));
    const firstId = first.body.material.id;

    const second = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.sid, id: 'mat-second', name: 'Water', assigned_volumes: ['Body2'] });
    assert.ok(second.status === 200 || second.status === 201, JSON.stringify(second.body));
    assert.equal(second.body.material.id, 'mat-second');

    const mats = (await h.get(`/api/materials?project_id=${p.pid}&simulation_id=${p.sid}`)).body.materials;
    const byId = Object.fromEntries(mats.map((m) => [m.id, m]));
    assert.deepEqual(Object.keys(byId).sort(), [firstId, 'mat-second'].sort());
    assert.deepEqual(byId[firstId].assigned_volumes, ['Body1']);
    assert.equal(byId[firstId].name, 'Air');
    assert.deepEqual(byId['mat-second'].assigned_volumes, ['Body2']);
    // The study's fluid (what a one-material study shows) is still the first material.
    const fluid = async () => {
      const got = (await h.get(`/api/materials?project_id=${p.pid}&simulation_id=${p.sid}`)).body;
      const proj = (await h.get(`/api/project?project_id=${p.pid}`)).body.project;
      return [got.air && got.air.id, proj.materials && proj.materials.air && proj.materials.air.id];
    };
    assert.deepEqual(await fluid(), [firstId, firstId]);

    // Its own id still updates that material, and only it.
    const upd = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.sid, id: firstId, name: 'Air', assigned_volumes: ['Body3'] });
    assert.ok(upd.status === 200 || upd.status === 201, JSON.stringify(upd.body));
    const again = (await h.get(`/api/materials?project_id=${p.pid}&simulation_id=${p.sid}`)).body.materials;
    assert.equal(again.length, 2);
    assert.deepEqual(again.find((m) => m.id === firstId).assigned_volumes, ['Body3']);
    assert.deepEqual(again.find((m) => m.id === 'mat-second').assigned_volumes, ['Body2']);
    assert.deepEqual(again.map((m) => m.id), [firstId, 'mat-second']);
    assert.deepEqual(await fluid(), [firstId, firstId]);

    const bad = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.sid, id: '../x', name: 'Oil', assigned_volumes: ['Body1'] });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
  });
});

describe('the compute queue keeps to the request project', () => {
  it("a removal or reorder from project A never touches project B's rows", async () => {
    h.project('q-a');
    h.project('q-b');
    const add = (pid, mesh) => {
      const r = h.queue.enqueueComputeJob({ kind: 'mesh', project_id: pid, mesh_id: mesh, simulation_id: 's1' });
      assert.ok(r.ok, JSON.stringify(r));
      return r.item;
    };
    const a1 = add('q-a', 'mesh_1');
    const b1 = add('q-b', 'mesh_1');
    const b2 = add('q-b', 'mesh_2');
    const rows = (pid) => h.queue.snapshotComputeQueue(pid).items.map((r) => r.id);
    try {
      // B's row id, sent by A: stays.
      const byRow = await h.post('/api/compute-queue', { action: 'remove', id: b1.id, project_id: 'q-a' });
      assert.equal(byRow.status, 200);
      assert.deepEqual(rows('q-b'), [b1.id, b2.id]);
      const del = await fetch(`${h.base}/api/compute-queue/${b1.id}?project_id=q-a`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.deepEqual(rows('q-b'), [b1.id, b2.id]);
      const bareDel = await fetch(`${h.base}/api/compute-queue/${b1.id}`, { method: 'DELETE' });
      assert.equal(bareDel.status, 400);
      // No project: refused.
      const bare = await h.post('/api/compute-queue', { action: 'remove', id: b1.id });
      assert.equal(bare.status, 400);
      const bareDrop = await h.post('/api/compute-queue', { action: 'drop-mesh', mesh_id: 'mesh_1' });
      assert.equal(bareDrop.status, 400);
      assert.deepEqual(rows('q-b'), [b1.id, b2.id]);
      assert.deepEqual(rows('q-a'), [a1.id]);
      // A reorder from A naming B's rows moves nothing.
      const patch = await fetch(h.base + '/api/compute-queue', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [b2.id, b1.id], project_id: 'q-a' }),
      });
      assert.equal(patch.status, 200);
      assert.deepEqual(rows('q-b'), [b1.id, b2.id]);
      const barePatch = await fetch(h.base + '/api/compute-queue', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [b2.id, b1.id] }),
      });
      assert.equal(barePatch.status, 400);
      // B's own requests still work.
      const own = await fetch(h.base + '/api/compute-queue', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [b2.id, b1.id], project_id: 'q-b' }),
      });
      assert.equal(own.status, 200);
      assert.deepEqual(rows('q-b'), [b2.id, b1.id]);
      const ownDel = await h.post('/api/compute-queue', { action: 'remove', id: b1.id, project_id: 'q-b' });
      assert.equal(ownDel.status, 200);
      assert.deepEqual(rows('q-b'), [b2.id]);
      assert.deepEqual(rows('q-a'), [a1.id]);
    } finally {
      for (const [pid, id] of [['q-a', a1.id], ['q-b', b1.id], ['q-b', b2.id]]) h.queue.removeComputeJob(null, id, pid);
    }
  });
});

describe('case routes read only cases inside a project', () => {
  it('a case folder outside the projects root is not found, with or without project_id', async () => {
    const p = await seeded('p-case');
    const inside = join(p.dir, 'geometries', 'case-in');
    const outside = join(h.root, 'outside-case');
    // Outside, but with a "projects" folder in its path (the loose name match).
    const lookalike = join(h.root, 'elsewhere', 'projects', 'p-case', 'case');
    for (const c of [inside, outside, lookalike]) {
      for (const t of ['0', '5']) mkdirSync(join(c, t), { recursive: true });
    }
    const times = (c, extra = '') => h.get(`/api/times?case=${encodeURIComponent(c)}${extra}`);
    const ok = await times(inside);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.case_dir, inside);
    assert.equal((await times(inside, `&project_id=${p.pid}`)).status, 200);
    for (const c of [outside, lookalike]) {
      const r = await times(c);
      assert.equal(r.status, 404, `${c}: ${JSON.stringify(r.body)}`);
      assert.equal((await times(c, `&project_id=${p.pid}`)).status, 404);
      const range = await h.get(`/api/fields/U/series-range?case=${encodeURIComponent(c)}`);
      assert.equal(range.status, 404, JSON.stringify(range.body));
      // The harness stands in for the filter routes; ask the real handler (/api/plot-over-path).
      const url = new URL(`http://x/api/plot-over-path/meta?case=${encodeURIComponent(c)}&field=U&time=5`);
      const sent = [];
      await h.live.serveLegacyFilter(
        { url, pathname: url.pathname, method: 'GET', res: { setHeader() {} }, sendJson: (s, b) => sent.push([s, b]) },
        'plot-over-path',
      );
      assert.equal(sent.length && sent[0][0], 404, JSON.stringify(sent));
    }
  });
});

describe('studies', () => {
  it('activate answers 404 to a study the project does not have, and keeps the active one', async () => {
    const p = await seeded('p-act');
    const missing = await h.post('/api/simulation/activate', { project_id: p.pid, simulation_id: 'sim-nope' });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.active_id, p.sid);
    const known = await h.post('/api/simulation/activate', { project_id: p.pid, simulation_id: p.sid });
    assert.equal(known.status, 200, JSON.stringify(known.body));
  });

  it('create takes the name it is sent', async () => {
    const p = await seeded('p-name', '  Wing at 4 degrees  ');
    assert.equal(p.sim.name, 'Wing at 4 degrees');
    const read = await h.get(`/api/simulation?project_id=${p.pid}&simulation_id=${p.sid}`);
    assert.equal(read.body.simulation.name, 'Wing at 4 degrees');
    // No name: the analysis's own name, as before.
    const other = await h.post('/api/simulation', { project_id: p.pid, geometry_id: 'g1' });
    assert.equal(other.status, 201);
    assert.notEqual(other.body.simulation.name, 'Wing at 4 degrees');
    assert.match(other.body.simulation.name, /Steady-state|Transient/);
  });
});

describe('meshes', () => {
  it('an empty POST /api/mesh is refused and changes no mesh (it once saved the defaults)', async () => {
    const p = await seeded('p-mesh-empty');
    const saved = await h.post('/api/mesh', { project_id: p.pid, simulation_id: p.sid, fineness: 9, sizing: 'Manual' });
    assert.ok(saved.status === 200 || saved.status === 201, JSON.stringify(saved.body));
    assert.equal(saved.body.settings.fineness, 9);
    // With no project in the body, only the last-opened project can be meant (non-strict).
    writeFileSync(join(h.projects, 'active.json'), JSON.stringify({ project_id: p.pid }));
    const prev = process.env.MAGNUSIM_STRICT_SCOPE;
    process.env.MAGNUSIM_STRICT_SCOPE = '0';
    let empty;
    try {
      empty = await h.post('/api/mesh', {});
    } finally {
      if (prev === undefined) delete process.env.MAGNUSIM_STRICT_SCOPE;
      else process.env.MAGNUSIM_STRICT_SCOPE = prev;
    }
    assert.equal(empty.status, 400, JSON.stringify(empty.body && empty.body.settings));
    const read = await h.get(`/api/mesh?project_id=${p.pid}&simulation_id=${p.sid}`);
    assert.deepEqual(read.body.meshes.map((m) => m.id), [saved.body.mesh.id]);
    assert.equal(read.body.settings.fineness, 9, JSON.stringify(read.body.settings));
    assert.equal(read.body.settings.sizing, 'Manual');
  });

  it('POST /api/mesh/delete runs the deleted-mesh hook: the attached case goes idle', async () => {
    const p = await seeded('p-mesh-del');
    const mid = 'mesh-del-1';
    io.persistOneMeshAt(p.dir, p.sid, { id: mid, name: 'Mesh 1', simulation_id: p.sid });
    const caseDir = join(io.meshFolderOf(p.pid, mid, p.sid).dir, 'case');
    const poly = join(caseDir, 'constant', 'polyMesh');
    mkdirSync(poly, { recursive: true });
    for (const name of ['points', 'faces', 'owner', 'neighbour', 'boundary']) writeFileSync(join(poly, name), `${name}\n`);
    io.persistOneMeshAt(p.dir, p.sid, {
      id: mid,
      name: 'Mesh 1',
      simulation_id: p.sid,
      case_dir: caseDir,
      live_mesh_result: { status: 'done', case_dir: caseDir, n_cells: 8, n_points: 27 },
    });
    const attached = await h.post('/api/case/attach', { case_dir: caseDir, project_id: p.pid, simulation_id: p.sid });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    assert.equal(h.live.caseSnapshot().case_dir, caseDir);

    const r = await h.post('/api/mesh/delete', { project_id: p.pid, simulation_id: p.sid, mesh_id: mid });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(existsSync(caseDir), false);
    assert.equal(h.live.caseSnapshot().case_dir, null);
  });
});

describe('geometry import', () => {
  it('a raw upload over the cap is refused with 413 and adds no geometry', async () => {
    h.project('p-big');
    const big = Buffer.alloc(1024 * 1024 + 4096, 0x20);
    const r = await fetch(`${h.base}/api/geometry/import?project_id=p-big&filename=big.stl&length_unit=MM`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: big,
    });
    const body = await r.json();
    assert.equal(r.status, 413, JSON.stringify(body));
    assert.match(body.error, /1 MB/);
    const proj = (await h.get('/api/project?project_id=p-big')).body.project;
    assert.equal((proj.geometries || []).length, 0);
  });

  it('step_path is read only as a geometry file, whatever filename is sent', async () => {
    h.project('p-path');
    const secret = join(h.root, 'secret.txt');
    writeFileSync(secret, 'not a geometry '.repeat(10));
    const r = await h.post('/api/geometry/import', { project_id: 'p-path', step_path: secret, filename: 'part.step' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    const folder = join(h.root, 'folder.step');
    mkdirSync(folder, { recursive: true });
    const d = await h.post('/api/geometry/import', { project_id: 'p-path', step_path: folder, filename: 'part.step' });
    assert.equal(d.status, 400, JSON.stringify(d.body));
    const proj = (await h.get('/api/project?project_id=p-path')).body.project;
    assert.equal((proj.geometries || []).length, 0);
  });
});
