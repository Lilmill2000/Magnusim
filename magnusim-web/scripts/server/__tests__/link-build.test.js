// Linked geometries (host API 1.5), L2 step 3 "build stamps and starts", through the real
// routes, the real Python worker and real link jobs (fixture plugin link-demo):
//   - gate:l2-build: the mesh input (Body1.stl) is the mesh's own geometry's; a names-only
//     update leaves it, a shape change moves it away and the next build makes it from the
//     new shape; the tree marks a mesh made before an update "out of date" and a run started
//     on it "older geometry"; a geometry no link made has neither;
//   - gate:l4-mesh-input (L4, LINK 5.9): the server never builds a linked geometry's input
//     (ensureBody1Stl answers `deferred` with link/state.json's shape hash, spawns nothing);
//     the mesh job's first stage builds it (generate_snappy.py prepare_input, run here with
//     --render-only, no WSL) at the --cad-quality triangle count, and Body1.json records
//     the shape hash, so a names-only update keeps it current;
//   - gate:l2-lost (refusals): after v2 merges the faces of two BCs, POST /api/mesh/generate
//     and POST /api/run/start are refused with "Face '…' was in … and …"; once a BC holds
//     the face again, Generate goes on to its next check.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkHarness } from './link-harness.js';
import { PYTHON, PY_ROOT, pyTool } from '../../python-env.js';

/** @type {any} */
let h;
/** @type {any} */
let w16;
/** @type {any} */
let io;

before(async () => {
  h = await linkHarness({ name: 'link-build' });
  w16 = await import('../../w16-project-geometry.js');
  io = await import('../../study-io.js');
});
after(async () => {
  await h?.close();
});

const V1 = { plusX1: 'face 6@Body1', plusX2: 'face 14@Body1' };

async function linkedProject(pid) {
  h.project(pid);
  const sid = await h.study(pid);
  const r = await h.link(pid, sid, { version: 'v1', sourceVersion: 1 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal((await h.until(r.body.job_id)).status, 'done');
  const gid = r.body.geometry_id;
  const sim = await h.post('/api/simulation', { project_id: pid, geometry_id: gid, name: 'Study 1' });
  const simId = sim.body.simulation ? sim.body.simulation.id : sim.body.id;
  assert.ok(simId, JSON.stringify(sim.body));
  return { pid, sid, gid, simId };
}

async function update(p, opts) {
  const r = await h.link(p.pid, p.sid, opts);
  assert.ok(r.status === 202 || r.status === 200, JSON.stringify(r.body));
  if (r.status === 200) return r.body.result;
  const rec = await h.until(r.body.job_id);
  assert.equal(rec.status, 'done', rec.error);
  return rec.result;
}

async function tree(pid) {
  const r = await h.get(`/api/project/tree?project_id=${pid}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

/**
 * The mesh job's host part for a Hex-dominant mesh of the study, with no WSL: what
 * startMeshGenerate runs, with --render-only. Returns the result and the stages.
 */
function renderSnappy(p, inputSha) {
  const caseDir = join(h.projects, p.pid, 'render-case');
  const r = spawnSync(
    PYTHON,
    [pyTool('generate_snappy.py'), '--project-dir', join(h.projects, p.pid), '--case-dir', caseDir, '--wsl-case', 'cfddesk-w25-l4node', '--generate-id', 'l4node', '--simulation-id', p.simId, '--mesh-id', 'm1', '--render-only', '--input-shape-sha256', inputSha],
    { cwd: PY_ROOT, encoding: 'utf8', env: { ...process.env, MAGNUSIM_WSL_CASE_ROOT: '/home/l4/cases' }, timeout: 300_000 },
  );
  const events = String(r.stdout || '').split(/\r?\n/).filter((l) => l.startsWith('MAGNUSIM_EVENT ')).map((l) => JSON.parse(l.slice('MAGNUSIM_EVENT '.length)));
  const result = events.filter((e) => e.event === 'result').pop();
  assert.ok(result, String(r.stderr).slice(-2000));
  return { result, stages: events.filter((e) => e.event === 'progress').map((e) => e.stage) };
}

/** What `convert_step_to_stl.py --step <geometry> --cad-quality` writes for the geometry's shape. */
function cliCadQuality(dir) {
  const out = join(dir, '..', `cli-${Date.now()}.stl`);
  const r = spawnSync(PYTHON, [pyTool('convert_step_to_stl.py'), '--step', join(dir, 'source.step'), '--out', out, '--cad-quality'], { cwd: PY_ROOT, encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, String(r.stderr).slice(-2000));
  return readFileSync(out);
}

const stateOf = (dir) => JSON.parse(readFileSync(join(dir, 'link', 'state.json'), 'utf8'));

describe('build stamps on a real linked geometry', () => {
  it('the mesh input is the geometry\'s own, built by the mesh job; a names update leaves it, a shape change moves it and the next build makes it from the new shape', async () => {
    const p = await linkedProject('lb-input');
    const dir = h.geomDir(p.pid, p.gid);
    io.persistOneMeshAt(join(h.projects, p.pid), p.simId, { id: 'm1', name: 'Mesh 1', simulation_id: p.simId });
    // The server builds nothing: deferred, with the shape's hash, and no file appears.
    const first = w16.ensureBody1Stl(p.pid, { geometryId: p.gid });
    assert.deepEqual([first.ok, first.deferred, first.path, first.shape_sha256], [true, true, join(dir, 'Body1.stl'), stateOf(dir).shape_sha256]);
    assert.equal(existsSync(join(dir, 'Body1.stl')), false);
    // The mesh job's first stage builds it, at the --cad-quality triangle count.
    const built = renderSnappy(p, first.shape_sha256);
    assert.equal(built.result.ok, true, JSON.stringify(built.result));
    assert.deepEqual(built.stages.slice(0, 2), ['prepare_input', 'load_geometry']);
    const v1Bytes = readFileSync(join(dir, 'Body1.stl'));
    assert.deepEqual(v1Bytes, cliCadQuality(dir));
    const meta = JSON.parse(readFileSync(join(dir, 'Body1.json'), 'utf8'));
    assert.deepEqual([meta.cad_quality, meta.shape_sha256], [true, first.shape_sha256]);
    assert.equal(built.result.body1_sha256, createHash('sha256').update(v1Bytes).digest('hex'));
    assert.deepEqual(w16.ensureBody1Stl(p.pid, { geometryId: p.gid }).cached, true);
    // Names only: same shape, the mesh input stays current, and is not built again.
    const names = await update(p, { version: 'v1', names: 'v1-renamed.face_names.json', sourceVersion: 2, basedOnRev: 1 });
    assert.equal(names.change, 'names');
    assert.deepEqual(readFileSync(join(dir, 'Body1.stl')), v1Bytes);
    assert.equal(w16.ensureBody1Stl(p.pid, { geometryId: p.gid }).cached, true);
    const again1 = renderSnappy(p, stateOf(dir).shape_sha256);
    assert.equal(again1.stages.includes('prepare_input'), false);
    // A shape change: moved away with the old shape, deferred again, then made from v2's shape.
    const shape = await update(p, { version: 'v2', sourceVersion: 3, basedOnRev: 1 });
    assert.equal(shape.change, 'shape');
    assert.equal(existsSync(join(dir, 'Body1.stl')), false);
    const again = w16.ensureBody1Stl(p.pid, { geometryId: p.gid });
    assert.deepEqual([again.ok, again.deferred, again.shape_sha256], [true, true, stateOf(dir).shape_sha256]);
    assert.notEqual(again.shape_sha256, first.shape_sha256);
    assert.equal(renderSnappy(p, again.shape_sha256).result.ok, true);
    assert.notDeepEqual(readFileSync(join(dir, 'Body1.stl')), v1Bytes);
    assert.deepEqual(readFileSync(join(dir, 'Body1.stl')), cliCadQuality(dir));
  });

  it('the tree: a mesh made before an update is out of date, a run started on it is on an older geometry', async () => {
    const p = await linkedProject('lb-tree');
    const meshDoc = io.persistOneMeshAt(join(h.projects, p.pid), p.simId, { id: 'm1', name: 'Mesh 1', simulation_id: p.simId });
    // As the generator leaves it at rev 1.
    io.persistOneMeshAt(
      join(h.projects, p.pid),
      p.simId,
      { id: 'm1', name: 'Mesh 1', simulation_id: p.simId, generated: true, live_mesh_result: { status: 'done', generate_id: 'g1', built_from_rev: 1, n_cells: 8 } },
      { generator: true },
    );
    io.persistRun(p.pid, p.simId, { id: 'r1', name: 'Run 1', simulation_id: p.simId, mesh_id: 'm1', status: 'done', has_results: true }, {
      builtFrom: { mesh_id: 'm1', generate_id: 'g1', geometry_rev: 1 },
    });
    assert.ok(meshDoc);
    const study = (t) => t.geometries.find((g) => g.id === p.gid).studies.find((s) => s.id === p.simId);
    let s = study(await tree(p.pid));
    assert.deepEqual([s.meshes[0].out_of_date, s.runs[0].older_geometry], [false, false]);
    await update(p, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
    s = study(await tree(p.pid));
    assert.deepEqual([s.meshes[0].out_of_date, s.meshes[0].built_from_rev, s.runs[0].older_geometry], [true, 1, true]);
  });

  it('a face two BCs claimed refuses Generate and Start through their routes until a BC holds it', async () => {
    const p = await linkedProject('lb-claimed');
    const add = async (name, bcType, faces) => {
      const r = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, name, bc_type: bcType, faces, geometry_rev: 1 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.bc;
    };
    const inlet = await add('Inlet', 'Velocity inlet', [V1.plusX1]);
    await add('Outlet', 'Pressure', [V1.plusX2]);
    io.persistOneMeshAt(join(h.projects, p.pid), p.simId, { id: 'm1', name: 'Mesh 1', simulation_id: p.simId });
    io.persistRun(p.pid, p.simId, { id: 'r1', name: 'Run 1', simulation_id: p.simId, mesh_id: 'm1', status: 'draft' });
    const result = await update(p, { version: 'v2', sourceVersion: 2, basedOnRev: 1 });
    assert.equal(result.claimedTwice.length, 1);
    const target = result.claimedTwice[0].target;
    const text = "Face 'Box +x' was in Inlet and Outlet after Demo 1 changed. Pick which one keeps it.";
    const gen = await h.post('/api/mesh/generate', { project_id: p.pid, simulation_id: p.simId, mesh_id: 'm1' });
    assert.deepEqual([gen.status, gen.body.code, gen.body.error], [409, 'face_claimed_twice', text]);
    const start = await h.post('/api/run/start', { project_id: p.pid, simulation_id: p.simId, run_id: 'r1' });
    assert.deepEqual([start.status, start.body.code, start.body.error], [409, 'face_claimed_twice', text]);
    // Inlet picks the face (a save at the current rev): Generate goes on to its next check.
    const save = await h.post('/api/bcs', { project_id: p.pid, simulation_id: p.simId, id: inlet.id, name: 'Inlet', bc_type: 'Velocity inlet', faces: [target], geometry_rev: 2 });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const next = await h.post('/api/mesh/generate', { project_id: p.pid, simulation_id: p.simId, mesh_id: 'm1', settings: { mesh_backend: 'no-such-mesher' } });
    assert.equal(next.status, 400, JSON.stringify(next.body));
    assert.match(String(next.body.error), /not installed or is turned off/);
  });

  it('a geometry no link made: no build fields in the tree', async () => {
    const pid = 'lb-plain';
    h.project(pid);
    const dir = join(h.projects, pid, 'geometries', 'Plate');
    mkdirSync(join(dir, 'simulations'), { recursive: true });
    writeFileSync(join(dir, 'id.json'), JSON.stringify({ id: 'g-plate', name: 'Plate', kind: 'geometry' }));
    const s = await h.post('/api/simulation', { project_id: pid, geometry_id: 'g-plate', name: 'Study 1' });
    const simId = s.body.simulation ? s.body.simulation.id : s.body.id;
    io.persistOneMeshAt(join(h.projects, pid), simId, { id: 'm1', name: 'Mesh 1', simulation_id: simId, live_mesh_result: { status: 'done' } }, { generator: true });
    const t = await tree(pid);
    const mesh = t.geometries[0].studies[0].meshes[0];
    assert.equal('out_of_date' in mesh, false);
    assert.equal(readdirSync(dir).includes('link'), false);
  });
});
