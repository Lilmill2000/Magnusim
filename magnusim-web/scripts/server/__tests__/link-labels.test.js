// Linked geometries (host API 1.5), L2 step 2 "labels": an update rewrites the face- and
// body-carrying records of the geometry's studies once, at its commit (the re-match by
// name then by shape, lost faces and their return, claimed twice), and saves drawn on an
// older rev are refused, through the real routes and the real Python worker
// (fixture plugin link-demo; its exports v1, v2 and v3, tools/gen_link_demo_fixtures.py).
// gate:l2-rewrite (through the job), gate:l2-lost, gate:l2-stale, gate:l2-routes.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHarness } from './link-harness.js';

/** @type {any} */
let h;

before(async () => {
  h = await linkHarness({ name: 'link-labels', env: { MAGNUSIM_TEST_LINK_HOOKS: '1' } });
});
after(async () => {
  await h?.close();
});

// v1's faces (tools/gen_link_demo_fixtures.py): the two halves of Body 1's +x side are
// faces 6 and 14 (both named F:box:+x), its +y side is face 12, the boss's end is 15.
const V1 = { plusX1: 'face 6@Body1', plusX2: 'face 14@Body1', plusY: 'face 12@Body1', end: 'face 15@Body1', minusX: 'face 1@Body1' };
// v2: +x is one face (10), +y two (4 and 8), no boss; v3 brings the boss end back (face 3).
const V2 = { plusX: 'face 10@Body1', plusY: ['face 4@Body1', 'face 8@Body1'], minusX: 'face 1@Body1' };

/** A project with a geometry linked from v1 and one simulation study on it. */
async function linkedProject(pid) {
  h.project(pid);
  const sid = await h.study(pid);
  const r = await h.link(pid, sid, { version: 'v1', sourceVersion: 1 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const done = await h.until(r.body.job_id);
  assert.equal(done.status, 'done', done.error);
  const gid = r.body.geometry_id;
  const sim = await h.post('/api/simulation', { project_id: pid, geometry_id: gid, name: 'Study 1' });
  assert.ok(sim.status === 200 || sim.status === 201, JSON.stringify(sim.body));
  const simId = sim.body.simulation ? sim.body.simulation.id : sim.body.id;
  assert.ok(simId, JSON.stringify(sim.body));
  return { pid, sid, gid, simId };
}

async function addBc(p, name, bcType, faces, rev) {
  const r = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, name, bc_type: bcType, faces, geometry_rev: rev });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.bc;
}

function studyDir(p) {
  const g = h.geomDir(p.pid, p.gid);
  const sims = join(g, 'simulations');
  for (const name of readdirSync(sims)) {
    const id = JSON.parse(readFileSync(join(sims, name, 'id.json'), 'utf8'));
    if (id.id === p.simId) return join(sims, name);
  }
  throw new Error('no study folder');
}

function bcRecords(p) {
  const dir = join(studyDir(p), 'boundary_conditions');
  const out = {};
  for (const name of readdirSync(dir)) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, name, 'bc.json'), 'utf8'));
      out[rec.name] = rec;
    } catch {
      /* not a record folder */
    }
  }
  return out;
}

async function update(p, version, sourceVersion, basedOnRev) {
  const r = await h.link(p.pid, p.sid, { version, sourceVersion, basedOnRev });
  assert.ok(r.status === 202 || r.status === 200, JSON.stringify(r.body));
  if (r.status === 200) return r.body.result;
  const rec = await h.until(r.body.job_id);
  assert.equal(rec.status, 'done', rec.error);
  return rec.result;
}

describe('an update rewrites the records of its studies', () => {
  it('keeps BC faces by name, splits and merges them, and keeps lost faces until they come back', async () => {
    const p = await linkedProject('p-rewrite');
    await addBc(p, 'Inlet', 'Velocity inlet', [V1.plusX1], 1);
    await addBc(p, 'Outlet', 'Pressure', [V1.plusX2], 1);
    await addBc(p, 'Top', 'Wall', [V1.end], 1);
    await addBc(p, 'Side', 'Wall', [V1.plusY, V1.minusX], 1);
    const before = bcRecords(p);
    assert.equal(before.Inlet.geometry_rev, 1, 'the server stamps the checked rev');

    const r2 = await update(p, 'v2', 2, 1);
    assert.equal(r2.change, 'shape');
    assert.equal(r2.rev, 2);
    const v2 = bcRecords(p);
    // Merged: the two +x halves held by two BCs are one face now; neither keeps it.
    assert.deepEqual(v2.Inlet.faces, []);
    assert.deepEqual(v2.Outlet.faces, []);
    assert.equal(v2.Inlet.lost_faces[0].reason, 'claimed_twice');
    assert.deepEqual(v2.Inlet.lost_faces[0].targets, [V2.plusX]);
    assert.deepEqual(r2.claimedTwice.map((c) => [c.target, c.items]), [[V2.plusX, ['Inlet', 'Outlet']]]);
    // Split: one face named F:box:+y is two faces now; the BC keeps both. -x keeps its face.
    assert.deepEqual(v2.Side.faces.slice().sort(), [...V2.plusY, V2.minusX].sort());
    // Lost: the boss's end face is gone; the BC lists it with its name and label.
    assert.deepEqual(v2.Top.faces, []);
    assert.equal(v2.Top.lost_faces.length, 1);
    assert.equal(v2.Top.lost_faces[0].reason, 'gone');
    assert.equal(v2.Top.lost_faces[0].name, 'F:boss:end');
    assert.equal(v2.Top.lost_faces[0].label, 'Boss end');
    assert.equal(v2.Top.lost_faces[0].old, V1.end);
    for (const rec of Object.values(v2)) assert.equal(rec.geometry_rev, 2, `${rec.name} is stamped with the new rev`);
    assert.ok(r2.lost.some((l) => l.item === 'Top' && l.label === 'Boss end' && l.kind === 'bc'), JSON.stringify(r2.lost));
    assert.equal(r2.stillLost, 3);

    const r3 = await update(p, 'v3', 3, 2);
    assert.equal(r3.change, 'shape');
    const v3 = bcRecords(p);
    assert.equal(v3.Top.faces.length, 1, 'the end face came back');
    assert.deepEqual(v3.Top.lost_faces, []);
    assert.ok(r3.returned.some((l) => l.item === 'Top' && l.name === 'F:boss:end'), JSON.stringify(r3.returned));
    const meta = JSON.parse(readFileSync(join(h.geomDir(p.pid, p.gid), 'cad_preview.json'), 'utf8'));
    const back = meta.faces.find((f) => `face ${f.id}@Body${f.body}` === v3.Top.faces[0]);
    assert.equal(back.name, 'F:boss:end');
  });
});

// ---- saves drawn on an older rev (gate:l2-stale) --------------------------------------------

function onDisk(dir, sub, name) {
  for (const f of readdirSync(join(dir, sub))) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, sub, f, `${name}.json`), 'utf8'));
      if (rec) return rec;
    } catch {
      /* not this one */
    }
  }
  return null;
}

function firstBcFile(sdir) {
  const dir = join(sdir, 'boundary_conditions');
  return join(dir, readdirSync(dir).find((f) => f.startsWith('BC_')), 'bc.json');
}

function runDirOf(sdir) {
  const dir = join(sdir, 'simulation_runs');
  return join(dir, readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory()).name);
}

/** A study at rev 2 with a BC, a material, a mesh with a refinement and a draft run, all made at rev 1. */
async function staleSetup(pid) {
  const p = await linkedProject(pid);
  const bc = await addBc(p, 'Inlet', 'Velocity inlet', [V1.plusY], 1);
  const mat = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.simId, name: 'Air', assigned_volumes: ['Body1'], geometry_rev: 1 });
  assert.ok(mat.status === 200 || mat.status === 201, JSON.stringify(mat.body));
  const mesh = await h.post('/api/mesh', { project_id: p.pid, simulation_id: p.simId, name: 'Mesh 1' });
  assert.ok(mesh.status === 200 || mesh.status === 201, JSON.stringify(mesh.body));
  const meshId = mesh.body.mesh.id;
  const ref = await h.post('/api/mesh-refinements', {
    project_id: p.pid,
    simulation_id: p.simId,
    mesh_id: meshId,
    type: 'Surface custom sizing',
    faces: [V1.plusY],
    geometry_rev: 1,
  });
  assert.equal(ref.status, 200, JSON.stringify(ref.body));
  const run = await h.post('/api/run/create', { project_id: p.pid, simulation_id: p.simId, name: 'Run 1' });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const runId = run.body.run.id;
  const r2 = await update(p, 'v2', 2, 1);
  assert.equal(r2.rev, 2);
  return { ...p, bcId: bc.id, matId: mat.body.material.id, meshId, refId: ref.body.refinement.id, runId };
}

describe("a save drawn at an older rev is refused, and the stamp on disk is the server's", () => {
  /** @type {any} */
  let p;
  before(async () => {
    p = await staleSetup('p-stale');
  });

  it('answers 409 geometry_changed on every face-record route and writes nothing', async () => {
    const sdir = studyDir(p);
    const before = readFileSync(firstBcFile(sdir), 'utf8');
    const whole = Object.values(bcRecords(p)).map((b) => ({ ...b, geometry_rev: 1 }));
    const unstamped = whole.map((b) => {
      const out = { ...b };
      delete out.geometry_rev;
      return out;
    });
    const tries = [
      ['bcs.set, stamped at the old rev', '/api/worker', { method: 'bcs.set', params: { project_id: p.pid, sim_id: p.simId, body: { boundary_conditions: whole, simulation_id: p.simId } } }],
      ['bcs.set, with no stamp', '/api/worker', { method: 'bcs.set', params: { project_id: p.pid, sim_id: p.simId, body: { boundary_conditions: unstamped, simulation_id: p.simId } } }],
      ['POST /api/bcs', '/api/bcs', { project_id: p.pid, simulation_id: p.simId, id: p.bcId, name: 'Inlet', bc_type: 'Velocity inlet', faces: [V2.minusX], geometry_rev: 1 }],
      // No stamp at all (neither the call nor the record): refused too, by the records' check.
      ['POST /api/bcs, with no stamp', '/api/bcs', { project_id: p.pid, simulation_id: p.simId, id: p.bcId, name: 'Inlet', bc_type: 'Velocity inlet', faces: [V2.minusX] }],
      [
        'POST /api/mesh-refinements, with no stamp',
        '/api/mesh-refinements',
        { project_id: p.pid, simulation_id: p.simId, mesh_id: p.meshId, id: p.refId, type: 'Surface custom sizing', faces: [V2.minusX] },
      ],
      ['POST /api/materials', '/api/materials', { project_id: p.pid, simulation_id: p.simId, id: p.matId, name: 'Water', assigned_volumes: ['Body1'], geometry_rev: 1 }],
      ['materials.set', '/api/worker', { method: 'materials.set', params: { project_id: p.pid, sim_id: p.simId, body: { materials: [{ id: p.matId, name: 'Air', geometry_rev: 1 }], only_id: p.matId } } }],
      [
        'POST /api/mesh-refinements',
        '/api/mesh-refinements',
        { project_id: p.pid, simulation_id: p.simId, mesh_id: p.meshId, id: p.refId, type: 'Surface custom sizing', faces: [V2.minusX], geometry_rev: 1 },
      ],
      ['a draft run', '/api/run/update', { project_id: p.pid, simulation_id: p.simId, run_id: p.runId, views: [{ name: 'Seeds', pt: { faces: [V2.minusX] } }], geometry_rev: 1 }],
    ];
    for (const [what, url, body] of tries) {
      const r = await h.post(url, body);
      assert.equal(r.status, 409, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'geometry_changed', what);
      assert.equal(r.body.error, 'Demo 1 was updated. This change was not saved.', what);
    }
    assert.equal(readFileSync(firstBcFile(sdir), 'utf8'), before, 'nothing was written');
  });

  it('saves at the current rev and stamps the rev it checked, whatever the record says', async () => {
    const sdir = studyDir(p);
    const ok = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, id: p.bcId, name: 'Inlet', bc_type: 'Velocity inlet', faces: [V2.minusX], geometry_rev: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(bcRecords(p).Inlet.geometry_rev, 2);
    // A record that says another rev inside a checked call is stamped with the checked one.
    const odd = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, bcs: [{ id: p.bcId, name: 'Inlet', bc_type: 'Velocity inlet', faces: [V2.minusX], geometry_rev: 7 }], geometry_rev: 2 });
    assert.equal(odd.status, 200, JSON.stringify(odd.body));
    assert.equal(bcRecords(p).Inlet.geometry_rev, 2);
    // The client's whole-list save, each record with its own stamp.
    const list = Object.values(bcRecords(p));
    const w = await h.post('/api/worker', { method: 'bcs.set', params: { project_id: p.pid, sim_id: p.simId, body: { boundary_conditions: list, simulation_id: p.simId } } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    // Library Apply of Water onto the study's material: an update through POST /api/materials.
    const lib = await h.post('/api/materials', {
      project_id: p.pid,
      simulation_id: p.simId,
      id: p.matId,
      name: 'Water',
      kinematic_viscosity: 1.004e-6,
      density: 998.2,
      assigned_volumes: ['Body1'],
      geometry_rev: 2,
    });
    assert.ok(lib.status === 200 || lib.status === 201, JSON.stringify(lib.body));
    const mat = onDisk(sdir, 'materials', 'material');
    assert.equal(mat.name, 'Water');
    assert.equal(mat.geometry_rev, 2);
    const ref = await h.post('/api/mesh-refinements', {
      project_id: p.pid,
      simulation_id: p.simId,
      mesh_id: p.meshId,
      id: p.refId,
      type: 'Surface custom sizing',
      faces: [V2.minusX],
      geometry_rev: 2,
    });
    assert.equal(ref.status, 200, JSON.stringify(ref.body));
    const run = await h.post('/api/run/update', { project_id: p.pid, simulation_id: p.simId, run_id: p.runId, views: [{ name: 'Seeds', pt: { faces: [V2.minusX] } }], geometry_rev: 2 });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(JSON.parse(readFileSync(join(runDirOf(sdir), 'run.json'), 'utf8')).geometry_rev, 2);
  });

  it('never checks a run that started (its views auto-save), nor a study on a geometry no link made', async () => {
    const runDir = runDirOf(studyDir(p));
    const doc = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ ...doc, status: 'done' }));
    const r = await h.post('/api/run/update', { project_id: p.pid, simulation_id: p.simId, run_id: p.runId, current_view: { pt: { faces: [] } }, geometry_rev: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { checkRecordSave } = await import('../../link-stamp.js');
    assert.deepEqual(checkRecordSave(join(h.projects, p.pid), 'no-such-study', [{}], undefined), { ok: true, rev: null });
  });
});

describe('while the geometry is fenced (its update did not finish)', () => {
  it('refuses face-record saves, Forget and a refinement copy with 503; deletes and renames go on', async () => {
    const p = await staleSetup('p-fenced');
    const gdir = h.geomDir(p.pid, p.gid);
    const mesh2 = await h.post('/api/mesh', { project_id: p.pid, simulation_id: p.simId, name: 'Mesh 2' });
    assert.ok(mesh2.status === 200 || mesh2.status === 201, JSON.stringify(mesh2.body));
    writeFileSync(join(gdir, 'link', 'commit.json'), JSON.stringify({ job: 'gl-gone00-aaaaaa', phase: 'apply', moves: [] }));
    try {
      const save = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, id: p.bcId, name: 'Inlet', bc_type: 'Velocity inlet', faces: [V2.minusX], geometry_rev: 2 });
      assert.equal(save.status, 503, JSON.stringify(save.body));
      assert.equal(save.body.code, 'geometry_updating');
      assert.equal(save.body.error, 'Updating Demo 1. Try again in a moment.');
      assert.equal(save.headers.get('retry-after'), '2');
      const rpc = await h.post('/api/worker', { method: 'bcs.set', params: { project_id: p.pid, sim_id: p.simId, body: { boundary_conditions: Object.values(bcRecords(p)), simulation_id: p.simId } } });
      assert.equal(rpc.status, 503, JSON.stringify(rpc.body));
      const forget = await h.post('/api/geometry/lost-faces/forget', { project_id: p.pid, geometry_id: p.gid, geometry_rev: 2 });
      assert.equal(forget.status, 503, JSON.stringify(forget.body));
      const copy = await h.post('/api/mesh-refinements', { project_id: p.pid, simulation_id: p.simId, mesh_id: mesh2.body.mesh.id, copy_from_mesh: p.meshId });
      assert.equal(copy.status, 503, JSON.stringify(copy.body));
      // Deletes and renames are never refused for it.
      const del = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, delete: p.bcId });
      assert.equal(del.status, 200, JSON.stringify(del.body));
      const ren = await h.post('/api/simulation/update', { project_id: p.pid, id: p.simId, simulation_id: p.simId, name: 'Renamed' });
      assert.equal(ren.status, 200, JSON.stringify(ren.body));
      const mdel = await h.post('/api/mesh', { project_id: p.pid, simulation_id: p.simId, mesh_id: mesh2.body.mesh.id, delete_record: true });
      assert.equal(mdel.status, 200, JSON.stringify(mdel.body));
    } finally {
      unlinkSync(join(gdir, 'link', 'commit.json'));
    }
  });
});

describe('runs that can still start (gate:l2-rewrite, gate:l2-stale)', () => {
  /** A run's folder by its id. */
  function runFolder(sdir, runId) {
    const dir = join(sdir, 'simulation_runs');
    for (const name of readdirSync(dir)) {
      try {
        if (JSON.parse(readFileSync(join(dir, name, 'id.json'), 'utf8')).id === runId) return join(dir, name);
      } catch {
        /* not a run folder */
      }
    }
    throw new Error(`no run folder ${runId}`);
  }
  /** A run with an area average on the given faces, then left with this status on disk. */
  async function runWith(p, name, faces, status) {
    const made = await h.post('/api/run/create', { project_id: p.pid, simulation_id: p.simId, name });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = made.body.run.id;
    const rc = { id: `rc-${id}`, name: 'Area average 1', kind: 'Area average', faces };
    const set = await h.post('/api/run/update', { project_id: p.pid, simulation_id: p.simId, run_id: id, result_controls: [rc], geometry_rev: 1 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const file = join(runFolder(studyDir(p), id), 'run.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...doc, status, built_from: { geometry_rev: 1 } }));
    return { id, file };
  }

  it('a stopped run follows the update and needs the current rev to save; a finished run is history, and its copy drops faces of an older shape', async () => {
    const p = await linkedProject('p-runs-start');
    const stopped = await runWith(p, 'Run 1', [V1.plusX1], 'stopped');
    const done = await runWith(p, 'Run 2', [V1.plusX1], 'done');
    await update(p, 'v2', 2, 1);
    const s = JSON.parse(readFileSync(stopped.file, 'utf8'));
    assert.deepEqual([s.result_controls[0].faces, s.geometry_rev, s.status], [[V2.plusX], 2, 'stopped'], 'its monitor follows +x to the next Start');
    const d = JSON.parse(readFileSync(done.file, 'utf8'));
    assert.deepEqual(d.result_controls[0].faces, [V1.plusX1], 'a finished run keeps its labels');
    // A tab that still shows rev 1 cannot write rev 1 labels into it.
    const old = await h.post('/api/run/update', { project_id: p.pid, simulation_id: p.simId, run_id: stopped.id, result_controls: [{ ...s.result_controls[0], faces: [V1.plusX1] }], geometry_rev: 1 });
    assert.deepEqual([old.status, old.body.code, old.body.error], [409, 'geometry_changed', 'Demo 1 was updated. This change was not saved.']);
    const now = await h.post('/api/run/update', { project_id: p.pid, simulation_id: p.simId, run_id: stopped.id, result_controls: s.result_controls, geometry_rev: 2 });
    assert.equal(now.status, 200, JSON.stringify(now.body));
    // A copy of the study on the same geometry: each run becomes a draft; the finished
    // run's faces (rev 1) mean other faces now, so its copy has none.
    const copy = await h.post('/api/simulation', { project_id: p.pid, geometry_id: p.gid, name: 'Study copy', copy_from: p.simId, copy_mode: 'settings' });
    assert.ok(copy.status === 200 || copy.status === 201, JSON.stringify(copy.body));
    const copyId = copy.body.simulation ? copy.body.simulation.id : copy.body.id;
    const cdir = studyDir({ ...p, simId: copyId });
    const runs = {};
    for (const name of readdirSync(join(cdir, 'simulation_runs'))) {
      try {
        const doc = JSON.parse(readFileSync(join(cdir, 'simulation_runs', name, 'run.json'), 'utf8'));
        // Its result controls are folder records of the run (rematerializeRunResultControls).
        const rcDir = join(cdir, 'simulation_runs', name, 'result_controls');
        doc.rcs = readdirSync(rcDir).map((f) => JSON.parse(readFileSync(join(rcDir, f, 'result_control.json'), 'utf8')));
        runs[doc.name] = doc;
      } catch {
        /* not a run */
      }
    }
    assert.deepEqual([runs['Run 1'].status, runs['Run 1'].rcs.map((r) => r.faces), runs['Run 1'].geometry_rev], ['draft', [[V2.plusX]], 2]);
    assert.deepEqual([runs['Run 2'].status, runs['Run 2'].rcs.map((r) => [r.faces, r.geometry_rev]), runs['Run 2'].geometry_rev], ['draft', [[[], 2]], 2]);
  });
});

describe('copies into or out of a fenced geometry (gate:l2-stale)', () => {
  it('a study copy and a refinement copy between it and another geometry answer 503 both ways; once it is whole they go through', async () => {
    const a = await linkedProject('p-fence-copy');
    const meshA = await h.post('/api/mesh', { project_id: a.pid, simulation_id: a.simId, name: 'Mesh 1' });
    assert.ok(meshA.status === 200 || meshA.status === 201, JSON.stringify(meshA.body));
    const refA = await h.post('/api/mesh-refinements', { project_id: a.pid, simulation_id: a.simId, mesh_id: meshA.body.mesh.id, type: 'Surface custom sizing', faces: [V1.plusY], geometry_rev: 1 });
    assert.equal(refA.status, 200, JSON.stringify(refA.body));
    // A second geometry in the same project (Demo 2's), with a study and a mesh of its own.
    const sid2 = await h.study(a.pid, { title: 'Demo 2' });
    const l2 = await h.link(a.pid, sid2, { version: 'v1', sourceVersion: 1 });
    assert.equal((await h.until(l2.body.job_id)).status, 'done');
    const gid2 = l2.body.geometry_id;
    const simB = await h.post('/api/simulation', { project_id: a.pid, geometry_id: gid2, name: 'Study B' });
    const simBId = simB.body.simulation ? simB.body.simulation.id : simB.body.id;
    const meshB = await h.post('/api/mesh', { project_id: a.pid, simulation_id: simBId, name: 'Mesh B' });
    assert.ok(meshB.status === 200 || meshB.status === 201, JSON.stringify(meshB.body));
    const gdir = h.geomDir(a.pid, a.gid);
    writeFileSync(join(gdir, 'link', 'commit.json'), JSON.stringify({ job: 'gl-gone00-aaaaaa', phase: 'apply', moves: [] }));
    const updating = (r, what) => assert.deepEqual([r.status, r.body && r.body.code, r.body && r.body.error], [503, 'geometry_updating', 'Updating Demo 1. Try again in a moment.'], what);
    const tries = {
      newStudyOutOf: () => h.post('/api/simulation', { project_id: a.pid, geometry_id: gid2, name: 'Copy out', copy_from: a.simId, copy_mode: 'settings' }),
      copyOutOf: () => h.post('/api/simulation/copy', { project_id: a.pid, from: a.simId, to: simBId, copy_mode: 'settings' }),
      copyInto: () => h.post('/api/simulation/copy', { project_id: a.pid, from: simBId, to: a.simId, copy_mode: 'settings' }),
      refinementsOutOf: () => h.post('/api/mesh-refinements', { project_id: a.pid, simulation_id: simBId, mesh_id: meshB.body.mesh.id, copy_from_mesh: meshA.body.mesh.id }),
      refinementsInto: () => h.post('/api/mesh-refinements', { project_id: a.pid, simulation_id: a.simId, mesh_id: meshA.body.mesh.id, copy_from_mesh: meshB.body.mesh.id }),
    };
    try {
      for (const [what, send] of Object.entries(tries)) updating(await send(), what);
    } finally {
      unlinkSync(join(gdir, 'link', 'commit.json'));
    }
    // Whole again: each goes through.
    for (const [what, send] of Object.entries(tries)) {
      const r = await send();
      assert.ok(r.status === 200 || r.status === 201, `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  });
});

describe('Forget, and what the study sees of its lost faces (gate:l2-lost, gate:l2-routes)', () => {
  it('needs the shown rev, removes the entry from every copy, and linkedGeometry counts what is left', async () => {
    const p = await linkedProject('p-forget');
    await addBc(p, 'Top', 'Wall', [V1.end], 1);
    await addBc(p, 'Side', 'Wall', [V1.plusY], 1);
    await update(p, 'v2', 2, 1);
    const linked = await h.get(`/api/plugin-geometry/linked?project_id=${p.pid}&plugin=link-demo&study_id=${p.sid}`);
    assert.equal(linked.body.linked.lostFaces, 1);
    const panel = await h.get(`/api/geometry/lost-faces?project_id=${p.pid}&geometry_id=${p.gid}`);
    assert.equal(panel.status, 200);
    assert.equal(panel.body.entries[0].label, 'Boss end');
    assert.equal(panel.body.last_update.rev, 2);
    const top = bcRecords(p).Top;
    const stale = await h.post('/api/geometry/lost-faces/forget', { project_id: p.pid, geometry_id: p.gid, study_id: p.simId, kind: 'bc', id: top.id, geometry_rev: 1 });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(bcRecords(p).Top.lost_faces.length, 1, 'a stale tab removes nothing');
    const entry = { field: top.lost_faces[0].field, old: top.lost_faces[0].old };
    const ok = await h.post('/api/geometry/lost-faces/forget', { project_id: p.pid, geometry_id: p.gid, study_id: p.simId, kind: 'bc', id: top.id, entry, geometry_rev: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.removed, 1);
    assert.deepEqual(bcRecords(p).Top.lost_faces, []);
    const agg = JSON.parse(readFileSync(join(studyDir(p), 'boundary_conditions.json'), 'utf8'));
    assert.deepEqual(agg.boundary_conditions.find((b) => b.id === top.id).lost_faces, []);
    const again = await h.get(`/api/plugin-geometry/linked?project_id=${p.pid}&plugin=link-demo&study_id=${p.sid}`);
    assert.equal(again.body.linked.lostFaces, 0);
    // The tree: the counts, the plugin's state and the study's title for the row.
    const tree = await h.get(`/api/project/tree?project_id=${p.pid}`);
    const node = tree.body.geometries.find((g) => g.id === p.gid);
    assert.equal(node.lost_faces, 0);
    assert.equal(node.source_state, 'ok');
    assert.equal(node.source.study_title, 'Demo 1');
    assert.equal(node.behind, false);
  });
});

describe('a two-step material save that straddles the commit (beforeCommitRpc)', () => {
  it('the commit backs off while it is open, then plans it at the new rev', async () => {
    const p = await linkedProject('p-straddle');
    const mat = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.simId, name: 'Air', assigned_volumes: ['Body2'], geometry_rev: 1 });
    assert.ok(mat.status === 200 || mat.status === 201, JSON.stringify(mat.body));
    let release = () => undefined;
    const held = new Promise((r) => (release = r));
    let entered = false;
    globalThis[Symbol.for('magnusim.linkTestHooks')] = {
      beforeCommitRpc: async () => {
        entered = true;
        await held;
      },
    };
    try {
      const save = h.post('/api/materials', { project_id: p.pid, simulation_id: p.simId, id: mat.body.material.id, name: 'Air', assigned_volumes: ['Body2'], geometry_rev: 1 });
      await h.waitFor(() => entered, 20_000, 'the save is between its two steps');
      const link = await h.link(p.pid, p.sid, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
      assert.equal(link.status, 202, JSON.stringify(link.body));
      // The drain waits up to 3 s for the open save, then the job waits and tries again.
      await h.waitFor(() => (h.record(link.body.job_id) || {}).stage === 'waiting', 30_000, 'the commit backs off');
      release();
      const saved = await save;
      assert.ok(saved.status === 200 || saved.status === 201, JSON.stringify(saved.body));
      const rec = await h.until(link.body.job_id);
      assert.equal(rec.status, 'done', rec.error);
      const onDiskMat = onDisk(studyDir(p), 'materials', 'material');
      assert.equal(onDiskMat.geometry_rev, 2, 'the save landed first, then the plan stamped it');
      assert.deepEqual(onDiskMat.assigned_volumes, ['Body2']);
    } finally {
      delete globalThis[Symbol.for('magnusim.linkTestHooks')];
      release();
    }
  });
});

describe('copies and adoptions keep the link\'s keys right (gate:l2-lost, gate:l2-stale)', () => {
  it('a study copied on its geometry keeps stamps and lost faces; onto another geometry it takes that rev and drops them', async () => {
    const p = await linkedProject('p-copy');
    await addBc(p, 'Top', 'Wall', [V1.end], 1);
    await update(p, 'v2', 2, 1);
    assert.equal(bcRecords(p).Top.lost_faces.length, 1);
    // The same geometry: the copy's records are current, as they are.
    const same = await h.post('/api/simulation', { project_id: p.pid, geometry_id: p.gid, copy_from: p.simId, copy_mode: 'settings', name: 'Same' });
    assert.ok(same.status === 200 || same.status === 201, JSON.stringify(same.body));
    const sameId = same.body.simulation ? same.body.simulation.id : same.body.id;
    const sameTop = Object.values(bcRecords({ ...p, simId: sameId })).find((b) => b.name === 'Top');
    assert.equal(sameTop.geometry_rev, 2);
    assert.equal(sameTop.lost_faces.length, 1);
    // Another linked geometry (a second Demo study, at rev 1): its rev, and no lost faces.
    const sid2 = await h.study(p.pid, { title: 'Demo 2' });
    const other = await h.link(p.pid, sid2, { version: 'v1', sourceVersion: 1 });
    assert.equal((await h.until(other.body.job_id)).status, 'done');
    const copy = await h.post('/api/simulation', { project_id: p.pid, geometry_id: other.body.geometry_id, copy_from: p.simId, copy_mode: 'settings', name: 'Other' });
    assert.ok(copy.status === 200 || copy.status === 201, JSON.stringify(copy.body));
    const otherId = copy.body.simulation ? copy.body.simulation.id : copy.body.id;
    const otherTop = Object.values(bcRecords({ ...p, gid: other.body.geometry_id, simId: otherId })).find((b) => b.name === 'Top');
    assert.equal(otherTop.geometry_rev, 1);
    assert.equal(otherTop.lost_faces, undefined);
  });

  it('a legacy row given its own folder by a save keeps its lost faces and its stamp', async () => {
    const p = await linkedProject('p-legacy');
    await addBc(p, 'Inlet', 'Velocity inlet', [V1.plusY], 1);
    const sdir = studyDir(p);
    const agg = JSON.parse(readFileSync(join(sdir, 'boundary_conditions.json'), 'utf8'));
    const lost = [{ field: 'faces', old: V1.end, name: 'F:boss:end', label: 'Boss end', lost_at_rev: 1, reason: 'gone' }];
    agg.boundary_conditions.push({ id: 'bc-old', name: 'Old', bc_type: 'Wall', faces: [], lost_faces: lost, geometry_rev: 1, simulation_id: p.simId });
    writeFileSync(join(sdir, 'boundary_conditions.json'), JSON.stringify(agg));
    await addBc(p, 'Second', 'Wall', [V1.minusX], 1);
    const old = bcRecords(p).Old;
    assert.ok(old, 'the save gave the legacy row its folder');
    assert.deepEqual(old.lost_faces, lost);
    assert.equal(old.geometry_rev, 1);
  });

  it("a materials.set refusal from the worker reaches the client as its 503, never swallowed", async () => {
    const p = await linkedProject('p-w18');
    const mat = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.simId, name: 'Air', assigned_volumes: ['Body1'], geometry_rev: 1 });
    assert.ok(mat.status === 200 || mat.status === 201, JSON.stringify(mat.body));
    const journal = join(h.geomDir(p.pid, p.gid), 'link', 'commit.json');
    globalThis[Symbol.for('magnusim.linkTestHooks')] = {
      // Between its Node write and its main-lane call, the geometry becomes fenced.
      beforeCommitRpc: async () => writeFileSync(journal, JSON.stringify({ job: 'gl-gone00-bbbbbb', phase: 'apply', moves: [] })),
    };
    try {
      const r = await h.post('/api/materials', { project_id: p.pid, simulation_id: p.simId, id: mat.body.material.id, name: 'Air', assigned_volumes: ['Body2'], geometry_rev: 1 });
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.code, 'geometry_updating');
      assert.equal(r.headers.get('retry-after'), '2');
    } finally {
      delete globalThis[Symbol.for('magnusim.linkTestHooks')];
      unlinkSync(journal);
    }
  });
});
