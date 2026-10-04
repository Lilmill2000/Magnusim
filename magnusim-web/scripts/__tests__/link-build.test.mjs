// gate:l2-build (host API 1.5, LINK proposal 5.15): build stamps and starts on a linked
// geometry, with the real generate and Start code and a stand-in interpreter
// (fixtures/fake-python.mjs) in place of the mesher and prepare_run:
//   - a mesh is stamped with the rev its generate started from, also when the rev moves
//     while it runs; settings saves keep the stamp; a recovered case carries the stamp its
//     generate wrote; an interrupted generate that kept the old mesh keeps its stamp;
//   - Generate and Start refuse while the geometry has a commit journal, and while a face
//     is claimed twice, by the route's call and by the queue's kick (the row leaves with
//     its reason in the notice);
//   - Start refuses on an out-of-date mesh, a stopped run too; a run's built_from is set at
//     Start only;
//   - a Hex-dominant generate builds the mesh input of the mesh's own geometry: from L4
//     (gate:l4-mesh-input, LINK 5.9) the server builds none for a linked or display-budgeted
//     geometry and never reads its Body1.stl; it passes the shape's hash to the generator
//     (prepare_input). A plain import without the budget keeps today's synchronous build.
//     A Standard or cfMesh generate on such a geometry never reads its Body1.stl either.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-link-build-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';
// The stand-in interpreter: node, which runs fake-python.mjs before the tool script.
process.env.MAGNUSIM_PYTHON = process.execPath;
process.env.NODE_OPTIONS = `--import=${pathToFileURL(join(HERE, 'fixtures', 'fake-python.mjs')).href}`;
const HOLD = join(ROOT, 'hold');
process.env.FAKE_PY_HOLD = HOLD;

const w21 = await import('../w21-mesh-generate.js');
const w27 = await import('../w27-solve.js');
const w16 = await import('../w16-project-geometry.js');
const slot = await import('../compute-slot.js');
const queue = await import('../server/compute-queue.ts');
const layout = await import('../project-layout.js');
const io = await import('../study-io.js');
const build = await import('../link-build.js');
const { attachWorkerBridge } = await import('../py-json.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The worker's answers Start needs before it writes the case (the analysis says ready).
attachWorkerBridge(async (method, params) => {
  if (method === 'analysis.validate_ready') return { ready: true, issues: [] };
  if (method === 'analysis.run_normalize') return { settings: { end_time: 10, write_interval: 5, ...(params && params.settings) } };
  // The run's plan (core solves on the runner): the stand-in refuses, as fake prepare_run did.
  if (method === 'analysis.plan_run') return { ok: false, error: 'fake prepare_run' };
  return { ok: true };
});

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

beforeEach(() => {
  slot.resetComputeSlotForTests();
  queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {}, holdRetryMs: 1 });
  rmSync(HOLD, { force: true });
});

let serial = 0;

/**
 * A project with two geometries: "Plate" (plain, shown) and "Demo 1" (made by a link, at
 * `rev`), a study on Demo 1 with a mesh, and the face table of Demo 1.
 */
function linkedProject({ rev = 2, engine = 'standard', meshOnPlate = false } = {}) {
  serial += 1;
  const pid = `lb${serial}`;
  const dir = join(PROJECTS, pid);
  mkdirSync(dir, { recursive: true });
  const plate = layout.createGeometryFolder(dir, { id: `plate${serial}`, name: 'Plate' });
  const demo = layout.createGeometryFolder(dir, { id: `demo${serial}`, name: 'Demo 1' });
  for (const g of [plate, demo]) writeFileSync(join(g.dir, 'source.bbrep'), Buffer.alloc(256, 7));
  writeFileSync(join(plate.dir, 'cad_faces.vtp'), Buffer.alloc(400, 1));
  writeFileSync(join(demo.dir, 'cad_faces.vtp'), Buffer.alloc(400, 2));
  mkdirSync(join(demo.dir, 'link'), { recursive: true });
  writeFileSync(join(demo.dir, 'link', 'state.json'), JSON.stringify({ rev, name: 'Demo 1', shape_sha256: 'a'.repeat(64) }));
  writeFileSync(
    join(demo.dir, 'cad_preview.json'),
    JSON.stringify({ faces: [{ id: 7, label: 'Box +x', name: 'F:box:+x' }, { id: 8, label: 'Box -x' }], bodies: ['Body1'] }),
  );
  const part = (g) => ({ id: g.id, name: g.name, step_path: join(g.dir, 'source.step') });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({ id: pid, title: pid, geometries: [part(plate), part(demo)], active_geometry_id: plate.id, geometry: { ...part(plate) } }),
  );
  const sid = `s-${serial}`;
  const home = meshOnPlate ? plate : demo;
  layout.createStudyFolder(dir, home.id, { id: sid, name: 'Study 1' });
  writeFileSync(join(dir, 'simulations.json'), JSON.stringify({ active_id: sid, simulations: [{ id: sid, name: 'Study 1', geometry_id: home.id }] }));
  const mid = `m-${serial}`;
  const settings = engine === 'hex' ? { algorithm: 'Hex-dominant' } : { advanced: { mesh_engine: 'standard' } };
  io.persistOneMeshAt(dir, sid, { id: mid, name: 'Mesh 1', simulation_id: sid, settings });
  return { pid, dir, sid, mid, demo, plate };
}

function meshRec(p) {
  const folder = io.meshFolderOf(p.pid, p.mid, p.sid);
  return JSON.parse(readFileSync(join(folder.dir, 'mesh.json'), 'utf8'));
}

async function meshEnds(p, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const live = meshRec(p).live_mesh_result || {};
    if (['done', 'failed', 'stopped'].includes(live.status) && !w21.isLiveMeshJobHeld() && !slot.computeSlotHolder()) return live;
    if (Date.now() > end) throw new Error(`mesh still ${live.status}`);
    await sleep(40);
  }
}

function generate(p, settings) {
  return w21.startMeshGenerate({ settings: settings || null, projectId: p.pid, meshId: p.mid, onUpdate: () => {} });
}

function setRev(p, rev) {
  writeFileSync(join(p.demo.dir, 'link', 'state.json'), JSON.stringify({ rev, name: 'Demo 1', shape_sha256: 'b'.repeat(64) }));
}

/** Two BCs whose faces an update merged into face 7 (each holds a claimed_twice entry). */
function claimTwice(p) {
  const entry = (old) => ({ field: 'faces', old, name: 'F:box:+x', label: 'Box +x', reason: 'claimed_twice', lost_at_rev: 2, targets: ['face 7@Body1'] });
  io.persistOneBcAt(p.dir, p.sid, { id: 'bc-in', name: 'Inlet', kind: 'velocity_inlet', faces: [], simulation_id: p.sid });
  io.persistOneBcAt(p.dir, p.sid, { id: 'bc-out', name: 'Outlet', kind: 'pressure_outlet', faces: [], simulation_id: p.sid });
  // Only the link writes lost_faces: put them into the files as the apply does.
  for (const [id, old] of [['bc-in', 'face 3@Body1'], ['bc-out', 'face 4@Body1']]) {
    const s = layout.findStudy(p.dir, p.sid);
    const folder = layout.findChildItem(layout.studyBcsDir(s.dir), 'bc.json', id);
    const file = join(folder.dir, 'bc.json');
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...rec, lost_faces: [entry(old)], geometry_rev: 2 }));
  }
}

const CLAIMED = "Face 'Box +x' was in Inlet and Outlet after Demo 1 changed. Pick which one keeps it.";

describe('the mesh build stamp', () => {
  it('is the rev the generate started from, also when the rev moves while it runs; a later generate takes the new rev', async () => {
    const p = linkedProject({ rev: 2 });
    writeFileSync(HOLD, '1');
    const out = generate(p);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    // Running: stamped at once, and the file beside the case names this generate.
    assert.equal(meshRec(p).live_mesh_result.status, 'running');
    assert.equal(meshRec(p).live_mesh_result.built_from_rev, 2);
    const file = JSON.parse(readFileSync(join(io.meshFolderOf(p.pid, p.mid).dir, build.BUILD_FILE), 'utf8'));
    assert.deepEqual(file, { generate_id: out.bodyExtra.generate_id, built_from_rev: 2 });
    setRev(p, 3);
    rmSync(HOLD, { force: true });
    const live = await meshEnds(p);
    assert.equal(live.status, 'done');
    assert.equal(live.built_from_rev, 2);
    assert.deepEqual(build.meshOutOfDate(p.pid, p.mid), { outOfDate: true, rev: 3, builtFromRev: 2, meshName: 'Mesh 1', geometryName: 'Demo 1' });
    // Generate again: the new rev.
    assert.equal(generate(p).ok, true);
    const again = await meshEnds(p);
    assert.equal(again.built_from_rev, 3);
    assert.equal(build.meshOutOfDate(p.pid, p.mid).outOfDate, false);
  });

  it('a mesh of a geometry no link made has no stamp and is never out of date', async () => {
    const p = linkedProject({ meshOnPlate: true });
    assert.equal(generate(p).ok, true);
    const live = await meshEnds(p);
    assert.equal(live.status, 'done');
    assert.equal('built_from_rev' in live, false);
    assert.equal(existsSync(join(io.meshFolderOf(p.pid, p.mid).dir, build.BUILD_FILE)), false);
    assert.equal(build.meshOutOfDate(p.pid, p.mid).outOfDate, false);
  });

  it('settings saves and renames keep the stamp on disk; a write with no result makes the mesh not generated', async () => {
    const p = linkedProject({ rev: 2 });
    assert.equal(generate(p).ok, true);
    await meshEnds(p);
    const rec = meshRec(p);
    // A settings save (as w20's upsertMesh) sending a stamp of its own, or none.
    io.persistOneMesh(p.pid, p.sid, { ...rec, name: 'Renamed', live_mesh_result: { ...rec.live_mesh_result, built_from_rev: 9 } });
    assert.equal(meshRec(p).live_mesh_result.built_from_rev, 2);
    assert.equal(meshRec(p).name, 'Renamed');
    const noStamp = { ...rec.live_mesh_result };
    delete noStamp.built_from_rev;
    io.persistMeshDoc(p.pid, p.sid, { meshes: [{ ...rec, live_mesh_result: noStamp }] });
    assert.equal(meshRec(p).live_mesh_result.built_from_rev, 2);
    setRev(p, 3);
    assert.equal(build.meshOutOfDate(p.pid, p.mid).outOfDate, true);
    io.persistOneMesh(p.pid, p.sid, { ...rec, generated: false, live_mesh_result: null });
    assert.deepEqual(
      [meshRec(p).live_mesh_result, build.meshOutOfDate(p.pid, p.mid).outOfDate],
      [null, false],
    );
  });

  it('a case found on disk carries the stamp its own generate wrote, else none (out of date)', () => {
    const p = linkedProject({ rev: 2 });
    const folder = io.meshFolderOf(p.pid, p.mid);
    const caseDir = join(folder.dir, 'case');
    const poly = join(caseDir, 'constant', 'polyMesh');
    mkdirSync(poly, { recursive: true });
    for (const n of ['points', 'faces', 'owner', 'neighbour', 'boundary']) writeFileSync(join(poly, n), n);
    writeFileSync(join(caseDir, 'w21-counts.json'), JSON.stringify({ n_cells: 8, generate_id: 'gX' }));
    writeFileSync(join(folder.dir, build.BUILD_FILE), JSON.stringify({ generate_id: 'gX', built_from_rev: 2 }));
    io.persistOneMesh(p.pid, p.sid, { ...meshRec(p), live_mesh_result: { status: 'failed', generate_id: 'gX' } });
    assert.equal(w21.recoverStudyMeshesFromDisk(p.pid, p.sid), 1);
    assert.deepEqual([meshRec(p).live_mesh_result.status, meshRec(p).live_mesh_result.built_from_rev], ['done', 2]);
    assert.equal(build.meshOutOfDate(p.pid, p.mid).outOfDate, false);
    // A file naming another generate: unknown.
    writeFileSync(join(folder.dir, build.BUILD_FILE), JSON.stringify({ generate_id: 'gOther', built_from_rev: 2 }));
    io.persistOneMesh(p.pid, p.sid, { ...meshRec(p), generated: false, live_mesh_result: { status: 'failed', generate_id: 'gX' } }, { generator: true });
    assert.equal(w21.recoverStudyMeshesFromDisk(p.pid, p.sid), 1);
    assert.equal('built_from_rev' in meshRec(p).live_mesh_result, false);
    assert.equal(build.meshOutOfDate(p.pid, p.mid).outOfDate, true);
  });

  it('an interrupted generate that kept the previous mesh keeps that mesh\'s stamp, not its own', () => {
    const p = linkedProject({ rev: 3 });
    const folder = io.meshFolderOf(p.pid, p.mid);
    const poly = join(folder.dir, 'case', 'constant', 'polyMesh');
    mkdirSync(poly, { recursive: true });
    for (const n of ['points', 'faces', 'owner', 'neighbour', 'boundary']) writeFileSync(join(poly, n), n);
    const live = { status: 'running', mesh_id: p.mid, generate_id: 'g2', built_from_rev: 3, prev_built_from_rev: 2, fingerprint_before: { n_cells: 8, n_points: 27 }, mesh_path: poly };
    w21.markMeshGenerateInterrupted(p.pid, live);
    assert.deepEqual([meshRec(p).live_mesh_result.status, meshRec(p).live_mesh_result.built_from_rev], ['done', 2]);
    assert.equal(build.meshOutOfDate(p.pid, p.mid).outOfDate, true);
  });
});

describe('Generate refusals (the route and the queue kick both meet them)', () => {
  it('while the geometry has a commit journal: "<Geometry> is still updating", nothing starts', async () => {
    const p = linkedProject({ rev: 2 });
    writeFileSync(join(p.demo.dir, 'link', 'commit.json'), JSON.stringify({ job: 'gl-x', phase: 'apply' }));
    const out = generate(p);
    assert.deepEqual([out.ok, out.status, out.bodyExtra.code, out.bodyExtra.error, out.bodyExtra.final], [
      false,
      409,
      'geometry_updating',
      'Demo 1 is still updating. Try again in a moment.',
      true,
    ]);
    assert.equal(meshRec(p).live_mesh_result, undefined);
    assert.equal(slot.computeSlotHolder(), null);
    // Queued, then started by the kick: the row leaves at once with its reason.
    const kicked = await viaQueue(p);
    assert.deepEqual(kicked, { left: true, error: 'Demo 1 is still updating. Try again in a moment', name: 'Mesh 1' });
  });

  it('while a face is claimed twice and no BC holds it; picking it on one BC lets it start', async () => {
    const p = linkedProject({ rev: 2 });
    claimTwice(p);
    const out = generate(p);
    assert.deepEqual([out.status, out.bodyExtra.code, out.bodyExtra.error], [409, 'face_claimed_twice', CLAIMED]);
    assert.deepEqual(out.bodyExtra.claimed_twice, [{ target: 'face 7@Body1', label: 'Box +x', items: ['Inlet', 'Outlet'] }]);
    assert.deepEqual(await viaQueue(p), { left: true, error: CLAIMED.replace(/\.$/, ''), name: 'Mesh 1' });
    // Inlet picks the face: allowed.
    const s = layout.findStudy(p.dir, p.sid);
    const folder = layout.findChildItem(layout.studyBcsDir(s.dir), 'bc.json', 'bc-in');
    const rec = JSON.parse(readFileSync(join(folder.dir, 'bc.json'), 'utf8'));
    writeFileSync(join(folder.dir, 'bc.json'), JSON.stringify({ ...rec, faces: ['face 7@Body1'] }));
    assert.equal(generate(p).ok, true);
    assert.equal((await meshEnds(p)).status, 'done');
  });
});

/** Queue a mesh row and kick: whether it left, the notice's error and name. */
async function viaQueue(p) {
  queue.resetComputeQueueForTests({
    filePath: join(ROOT, 'queue.json'),
    items: [],
    holdRetryMs: 1,
    deps: {
      isBusy: () => slot.computeSlotHolder() !== null,
      startMesh: (item) => queue.startResultFromEngine(w21.startMeshGenerate({ settings: null, projectId: item.project_id, meshId: item.mesh_id, onUpdate: () => {} })),
      startSolve: async (item) => queue.startResultFromEngine(await w27.startSolve({ projectId: item.project_id, runId: item.run_id, simulationId: item.simulation_id })),
    },
  });
  const row = p.rid
    ? { kind: 'solve', project_id: p.pid, simulation_id: p.sid, run_id: p.rid, name: 'Run 1' }
    : { kind: 'mesh', project_id: p.pid, simulation_id: p.sid, mesh_id: p.mid, name: 'Mesh 1' };
  assert.equal(queue.enqueueComputeJob(row).ok, true);
  await queue.kickComputeQueue(p.pid);
  const snap = queue.snapshotComputeQueue(p.pid);
  const f = snap.failed[0] || {};
  return { left: snap.items.length === 0, error: f.error, name: f.name };
}

describe('Start', () => {
  /** A linked project with a mesh generated at rev 2 and a draft run on it. */
  async function readyProject() {
    const p = linkedProject({ rev: 2 });
    assert.equal(generate(p).ok, true);
    await meshEnds(p);
    p.rid = `r-${serial}`;
    io.persistRun(p.pid, p.sid, { id: p.rid, run_id: p.rid, name: 'Run 1', simulation_id: p.sid, mesh_id: p.mid, status: 'draft' });
    return p;
  }
  const run = (p) => JSON.parse(readFileSync(join(io.runFolderOf(p.pid, p.rid, p.sid).dir, 'run.json'), 'utf8'));
  const start = (p) => w27.startSolve({ projectId: p.pid, runId: p.rid, simulationId: p.sid });

  it('sets built_from from its mesh, and only Start does', async () => {
    const p = await readyProject();
    const out = await start(p);
    // prepare_run is the stand-in's refusal: the run was marked running first, with its stamp.
    assert.match(String(out.bodyExtra && out.bodyExtra.error), /fake prepare_run/);
    const gen = meshRec(p).live_mesh_result.generate_id;
    assert.deepEqual(run(p).built_from, { mesh_id: p.mid, generate_id: gen, geometry_rev: 2 });
    // Every other write keeps it.
    io.persistRun(p.pid, p.sid, { id: p.rid, status: 'stopped', built_from: { mesh_id: 'x', generate_id: 'y', geometry_rev: 9 } });
    assert.deepEqual(run(p).built_from, { mesh_id: p.mid, generate_id: gen, geometry_rev: 2 });
    io.persistRun(p.pid, p.sid, { id: p.rid, name: 'Run 1b' });
    assert.equal(run(p).built_from.geometry_rev, 2);
  });

  it('refuses on an out-of-date mesh, a stopped run too: "Generate Mesh 1 again first"', async () => {
    const p = await readyProject();
    setRev(p, 3);
    const text = 'Generate Mesh 1 again first. It was made from an older version of Demo 1.';
    let out = await start(p);
    assert.deepEqual([out.status, out.bodyExtra.code, out.bodyExtra.error, out.bodyExtra.fix], [400, 'mesh_out_of_date', text, { go: 'mesh', id: p.mid, name: 'Mesh 1' }]);
    assert.equal(run(p).status, 'draft');
    assert.equal('built_from' in run(p), false);
    io.persistRun(p.pid, p.sid, { id: p.rid, status: 'stopped' });
    out = await start(p);
    assert.equal(out.bodyExtra.error, text);
    assert.equal(slot.computeSlotHolder(), null);
    // Generate again: Start goes on (to the stand-in prepare_run).
    assert.equal(generate(p).ok, true);
    await meshEnds(p);
    out = await start(p);
    assert.match(String(out.bodyExtra.error), /fake prepare_run/);
    assert.equal(run(p).built_from.geometry_rev, 3);
  });

  it('refuses while the geometry has a journal and while a face is claimed twice, by the route and by the queue kick', async () => {
    const p = await readyProject();
    writeFileSync(join(p.demo.dir, 'link', 'commit.json'), JSON.stringify({ job: 'gl-x', phase: 'apply' }));
    let out = await start(p);
    assert.deepEqual([out.status, out.bodyExtra.code, out.bodyExtra.error], [409, 'geometry_updating', 'Demo 1 is still updating. Try again in a moment.']);
    assert.deepEqual(await viaQueue(p), { left: true, error: 'Demo 1 is still updating. Try again in a moment', name: 'Run 1' });
    rmSync(join(p.demo.dir, 'link', 'commit.json'));
    claimTwice(p);
    out = await start(p);
    assert.deepEqual([out.status, out.bodyExtra.code, out.bodyExtra.error], [409, 'face_claimed_twice', CLAIMED]);
    assert.deepEqual(await viaQueue(p), { left: true, error: CLAIMED.replace(/\.$/, ''), name: 'Run 1' });
    assert.equal(run(p).status, 'draft');
  });
});

const flagOf = (argv) => {
  const i = argv.indexOf('--input-shape-sha256');
  return i >= 0 ? argv[i + 1] : null;
};

describe('the mesh input', () => {
  it("a Hex-dominant generate defers the mesh input of the mesh's own linked geometry to the mesh job", async () => {
    const p = linkedProject({ rev: 2, engine: 'hex' });
    const out = generate(p);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    // The server converted nothing: the stand-in convert would have written Body1.stl.
    assert.equal(existsSync(join(p.demo.dir, 'Body1.stl')), false);
    // The generator builds it, from Demo 1's shape (link/state.json's hash).
    assert.equal(flagOf(out.bodyExtra.argv), 'a'.repeat(64));
    const g = out.bodyExtra.geometry;
    assert.deepEqual([g.input_shape_sha256, g.input_deferred, g.body1_sha256], ['a'.repeat(64), true, null]);
    // The finished record takes the input's hash from the generator's result.
    const ended = await meshEnds(p);
    assert.deepEqual([ended.geometry.body1_sha256, ended.geometry.mesh_input_built], ['f'.repeat(64), true]);
    assert.equal(existsSync(join(p.plate.dir, 'Body1.stl')), false);
    // The shown geometry's record does not name another geometry's file.
    const proj = JSON.parse(readFileSync(join(p.dir, 'project.json'), 'utf8'));
    assert.equal(proj.geometry.stl_path, undefined);
    // A current input (Body1.json names this shape): not read; the record takes the shape hash.
    writeFileSync(join(p.demo.dir, 'Body1.stl'), Buffer.alloc(4096, 9));
    writeFileSync(join(p.demo.dir, 'Body1.json'), JSON.stringify({ cad_quality: true, shape_sha256: 'a'.repeat(64) }));
    const cur = generate(p);
    assert.equal(cur.ok, true, JSON.stringify(cur.bodyExtra));
    assert.deepEqual([cur.bodyExtra.geometry.body1_sha256, cur.bodyExtra.geometry.input_deferred, flagOf(cur.bodyExtra.argv)], ['a'.repeat(64), false, 'a'.repeat(64)]);
    await meshEnds(p);
    assert.deepEqual(w16.ensureBody1Stl(p.pid, { geometryId: p.demo.id }), {
      ok: true,
      path: join(p.demo.dir, 'Body1.stl'),
      cached: true,
      cad_quality: true,
      shape_sha256: 'a'.repeat(64),
      linked: true,
      project_id: p.pid,
    });
    // Another shape (an update): stale, deferred again; the file is not touched.
    setRev(p, 3);
    const stale = w16.ensureBody1Stl(p.pid, { geometryId: p.demo.id });
    assert.deepEqual([stale.deferred, stale.shape_sha256], [true, 'b'.repeat(64)]);
    assert.deepEqual(readFileSync(join(p.demo.dir, 'Body1.stl')), Buffer.alloc(4096, 9));
    // And by itself: a named geometry with no shape of its own never takes the shown one's.
    rmSync(join(p.demo.dir, 'source.bbrep'));
    rmSync(join(p.demo.dir, 'Body1.stl'));
    assert.equal(w16.ensureBody1Stl(p.pid, { geometryId: p.demo.id }).ok, false);
    assert.equal(existsSync(join(p.demo.dir, 'Body1.stl')), false);
  });

  it('a plain import with the display budget defers too; one without keeps the synchronous build from its faces', async () => {
    const p = linkedProject({ rev: 2, engine: 'hex', meshOnPlate: true });
    // Demo 1 shown, so the plate's record in project.json is not touched (no worker here).
    const proj = JSON.parse(readFileSync(join(p.dir, 'project.json'), 'utf8'));
    writeFileSync(join(p.dir, 'project.json'), JSON.stringify({ ...proj, active_geometry_id: p.demo.id, geometry: proj.geometries[1] }));
    writeFileSync(join(p.plate.dir, 'cad_preview.json'), JSON.stringify({ display_budget: true, shape_sha256: 'c'.repeat(64), bounds: {} }));
    const out = generate(p);
    assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
    assert.equal(existsSync(join(p.plate.dir, 'Body1.stl')), false);
    assert.equal(flagOf(out.bodyExtra.argv), 'c'.repeat(64));
    assert.equal(out.bodyExtra.geometry.input_deferred, true);
    await meshEnds(p);
    // No budget: today's path, the stand-in convert from the faces VTP, no flag.
    writeFileSync(join(p.plate.dir, 'cad_preview.json'), JSON.stringify({ bounds: {} }));
    const plain = generate(p);
    assert.equal(plain.ok, true, JSON.stringify(plain.bodyExtra));
    assert.equal(JSON.parse(readFileSync(join(p.plate.dir, 'Body1.json'), 'utf8')).from, join(p.plate.dir, 'cad_faces.vtp'));
    assert.equal(flagOf(plain.bodyExtra.argv), null);
    assert.equal('input_shape_sha256' in plain.bodyExtra.geometry, false);
    await meshEnds(p);
  });

  it('a Standard or cfMesh generate never reads the Body1.stl of a linked or budgeted geometry; a plain import is hashed as before', async () => {
    /** Body1.stl reads (fs.readFileSync, the one w21 hashes the file with) while `fn` runs. */
    const readsOf = (fn) => {
      const reads = [];
      const orig = fs.readFileSync;
      fs.readFileSync = function (f, ...rest) {
        if (/Body1\.stl$/i.test(String(f))) reads.push(String(f));
        return orig.call(this, f, ...rest);
      };
      syncBuiltinESMExports();
      try {
        return { out: fn(), reads };
      } finally {
        fs.readFileSync = orig;
        syncBuiltinESMExports();
      }
    };
    const recordHash = (p) => meshRec(p).live_mesh_result.geometry.body1_sha256;
    const body = Buffer.alloc(1 << 20, 5);
    for (const engine of ['standard', 'cfmesh']) {
      const settings = { advanced: { mesh_engine: engine } };
      // Linked: a current CAD-quality input (prepare_input left it; 325 MB on the 113 MB part).
      const p = linkedProject({ rev: 2 });
      writeFileSync(join(p.demo.dir, 'Body1.stl'), body);
      writeFileSync(join(p.demo.dir, 'Body1.json'), JSON.stringify({ cad_quality: true, shape_sha256: 'a'.repeat(64) }));
      let r = readsOf(() => generate(p, settings));
      assert.equal(r.out.ok, true, JSON.stringify(r.out.bodyExtra));
      assert.deepEqual(r.reads, [], `${engine}: read ${r.reads}`);
      assert.equal(recordHash(p), 'a'.repeat(64));
      await meshEnds(p);
      // Another shape: still not read; the record names no input.
      setRev(p, 3);
      r = readsOf(() => generate(p, settings));
      assert.equal(r.out.ok, true, JSON.stringify(r.out.bodyExtra));
      assert.deepEqual(r.reads, [], `${engine}: read ${r.reads}`);
      assert.equal(recordHash(p), null);
      await meshEnds(p);
      // A plain import with the display budget: not read either.
      const q = linkedProject({ rev: 2, meshOnPlate: true });
      writeFileSync(join(q.plate.dir, 'cad_preview.json'), JSON.stringify({ display_budget: true, shape_sha256: 'c'.repeat(64), bounds: {} }));
      writeFileSync(join(q.plate.dir, 'Body1.stl'), body);
      writeFileSync(join(q.plate.dir, 'Body1.json'), JSON.stringify({ cad_quality: true, shape_sha256: 'c'.repeat(64) }));
      r = readsOf(() => generate(q, settings));
      assert.equal(r.out.ok, true, JSON.stringify(r.out.bodyExtra));
      assert.deepEqual(r.reads, [], `${engine}: read ${r.reads}`);
      assert.equal(recordHash(q), 'c'.repeat(64));
      await meshEnds(q);
      // Without the budget: today's path, the file's own hash.
      writeFileSync(join(q.plate.dir, 'cad_preview.json'), JSON.stringify({ bounds: {} }));
      r = readsOf(() => generate(q, settings));
      assert.equal(r.out.ok, true, JSON.stringify(r.out.bodyExtra));
      assert.equal(r.reads.length, 1);
      assert.equal(recordHash(q), createHash('sha256').update(body).digest('hex'));
      await meshEnds(q);
    }
  });
});
