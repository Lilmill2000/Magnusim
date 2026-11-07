// SPDX-License-Identifier: GPL-3.0-or-later
// No run starts on a mesh whose last Generate failed (Daniel's D1, 2026-11-07: "you never solve on
// a broken mesh"). Every mesher copies its polyMesh back whatever its result, so the files alone
// passed Start's gate (validateSolveReady): a run queued behind a Hex-dominant mesh that then failed
// checkMesh solved on it, and so did a Start sent straight to the route. Now Start refuses with the
// mesh's own reason, and a queued run leaves the queue at once with it (the notice and the Run
// panel's reason). The mesh generated again without the failure: Start goes on.
// Fails on the code before: validateSolveReady said ok, and the queued Start went on.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-solve-failed-mesh-'));
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.MAGNUSIM_PROJECTS_ROOT = PROJECTS;
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_WSL_CASE_ROOT = '/home/tester/cases';
process.env.MAGNUSIM_QUEUE_QUIET = '1';
// The stand-in interpreter: node, which runs fake-python.mjs before the tool script.
process.env.MAGNUSIM_PYTHON = process.execPath;
process.env.NODE_OPTIONS = `--import=${pathToFileURL(join(HERE, 'fixtures', 'fake-python.mjs')).href}`;

const w21 = await import('../w21-mesh-generate.js');
const w27 = await import('../w27-solve.js');
const slot = await import('../compute-slot.js');
const queue = await import('../server/compute-queue.ts');
const layout = await import('../project-layout.js');
const io = await import('../study-io.js');
const { attachWorkerBridge } = await import('../py-json.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The worker's answers Start needs before it writes the case (the analysis says ready).
attachWorkerBridge(async (method, params) => {
  if (method === 'analysis.validate_ready') return { ready: true, issues: [] };
  if (method === 'analysis.run_normalize') return { settings: { end_time: 10, write_interval: 5, ...(params && params.settings) } };
  // The run's plan: the stand-in refuses, so a Start that got past the gates says so.
  if (method === 'analysis.plan_run') return { ok: false, error: 'fake prepare_run' };
  return { ok: true };
});

after(() => {
  delete process.env.FAKE_PY_FAIL;
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file */
  }
});

beforeEach(() => {
  slot.resetComputeSlotForTests();
  queue.resetComputeQueueForTests({ filePath: join(ROOT, 'queue.json'), items: [], deps: {}, holdRetryMs: 1 });
  delete process.env.FAKE_PY_FAIL;
});

// The Hex-dominant generator's own words for the 55 D pipe (python/tests/fixtures/mesh-facts/checkmesh/hexdominant-pipe-55d.log).
const REASON =
  'checkMesh failed 5 checks: 8 cells with a high aspect ratio, 8 cells with a negative volume, 84 faces over 90° non-orthogonal, 644 wrongly oriented faces, 164 highly skewed faces.';
const REFUSED = `Mesh 1's last Generate failed: ${REASON} Generate it again before using it on a run.`;

let serial = 0;

/** A project with one geometry, a study on it with Mesh 1 and a draft Run 1 on that mesh. */
function project() {
  serial += 1;
  const pid = `fm${serial}`;
  const dir = join(PROJECTS, pid);
  mkdirSync(dir, { recursive: true });
  const geo = layout.createGeometryFolder(dir, { id: `pipe${serial}`, name: 'Pipe' });
  writeFileSync(join(geo.dir, 'source.bbrep'), Buffer.alloc(256, 7));
  writeFileSync(join(geo.dir, 'cad_faces.vtp'), Buffer.alloc(400, 1));
  const part = { id: geo.id, name: geo.name, step_path: join(geo.dir, 'source.step') };
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: pid, title: pid, geometries: [part], active_geometry_id: geo.id, geometry: { ...part } }));
  const sid = `s-${serial}`;
  layout.createStudyFolder(dir, geo.id, { id: sid, name: 'Study 1' });
  writeFileSync(join(dir, 'simulations.json'), JSON.stringify({ active_id: sid, simulations: [{ id: sid, name: 'Study 1', geometry_id: geo.id }] }));
  const mid = `m-${serial}`;
  io.persistOneMeshAt(dir, sid, { id: mid, name: 'Mesh 1', simulation_id: sid, settings: { advanced: { mesh_engine: 'standard' } } });
  const rid = `r-${serial}`;
  io.persistRun(pid, sid, { id: rid, run_id: rid, name: 'Run 1', simulation_id: sid, mesh_id: mid, status: 'draft' });
  return { pid, dir, sid, mid, rid };
}

function meshRec(p) {
  const folder = io.meshFolderOf(p.pid, p.mid, p.sid);
  return JSON.parse(readFileSync(join(folder.dir, 'mesh.json'), 'utf8'));
}

const runRec = (p) => JSON.parse(readFileSync(join(io.runFolderOf(p.pid, p.rid, p.sid).dir, 'run.json'), 'utf8'));

async function generate(p, fail) {
  if (fail) process.env.FAKE_PY_FAIL = fail;
  else delete process.env.FAKE_PY_FAIL;
  const out = w21.startMeshGenerate({ settings: null, projectId: p.pid, meshId: p.mid, onUpdate: () => {} });
  assert.equal(out.ok, true, JSON.stringify(out.bodyExtra));
  const end = Date.now() + 30_000;
  for (;;) {
    const live = meshRec(p).live_mesh_result || {};
    if (['done', 'failed', 'stopped'].includes(live.status) && !w21.isLiveMeshJobHeld() && !slot.computeSlotHolder()) return live;
    if (Date.now() > end) throw new Error(`mesh still ${live.status}`);
    await sleep(40);
  }
}

const start = (p) => w27.startSolve({ projectId: p.pid, runId: p.rid, simulationId: p.sid });

/** Queue Run 1's Start and kick once: whether it left, the notice, and the rows left. */
async function viaQueue(p) {
  queue.resetComputeQueueForTests({
    filePath: join(ROOT, 'queue.json'),
    items: [],
    // A refusal that is not final is held and tried again: these tests see that as a row still queued.
    holdRetryMs: 60_000,
    deps: {
      isBusy: () => slot.computeSlotHolder() !== null,
      startSolve: async (item) => queue.startResultFromEngine(await w27.startSolve({ projectId: item.project_id, runId: item.run_id, simulationId: item.simulation_id })),
    },
  });
  assert.equal(queue.enqueueComputeJob({ kind: 'solve', project_id: p.pid, simulation_id: p.sid, run_id: p.rid, mesh_id: p.mid, name: 'Run 1' }).ok, true);
  await queue.kickComputeQueue(p.pid);
  const snap = queue.snapshotComputeQueue(p.pid);
  return { left: snap.items.length === 0, failed: snap.failed.map((f) => [f.name, f.error, f.reason || 'failed']) };
}

describe('a run on a mesh whose last Generate failed', () => {
  it("is refused by Start's gate with the mesh's reason, its polyMesh complete or not", async () => {
    const p = project();
    const live = await generate(p, REASON);
    assert.deepEqual([live.status, live.error], ['failed', REASON]);
    const ready = w27.validateSolveReady(p.pid, { meshId: p.mid, simulationId: p.sid });
    assert.deepEqual(
      [ready.ok, ready.code, ready.error, ready.fix, ready.final],
      [false, 'mesh_failed', REFUSED, { go: 'mesh', id: p.mid, name: 'Mesh 1' }, true],
    );
    // Start sent straight to the route: refused, the run left as it was.
    const out = await start(p);
    assert.deepEqual([out.ok, out.status, out.bodyExtra.code, out.bodyExtra.error], [false, 400, 'mesh_failed', REFUSED]);
    assert.equal(runRec(p).status, 'draft');
    assert.equal(slot.computeSlotHolder(), null);
  });

  it('leaves the queue at once with the reason, never started', async () => {
    const p = project();
    await generate(p, REASON);
    // The notice's words (the toast and the Run panel's reason), no retry held.
    assert.deepEqual(await viaQueue(p), { left: true, failed: [['Run 1', REFUSED.replace(/\.$/, ''), 'failed']] });
    assert.equal(runRec(p).status, 'draft');
    assert.equal(slot.computeSlotHolder(), null);
  });

  it('a failure without words still names the mesh', async () => {
    const p = project();
    await generate(p, ' ');
    const ready = w27.validateSolveReady(p.pid, { meshId: p.mid, simulationId: p.sid });
    assert.equal(ready.ok, false);
    assert.match(ready.error, /^Mesh 1's last Generate failed(: .+)?\. Generate it again before using it on a run\.$/);
  });

  it('starts once the mesh is generated again without the failure', async () => {
    const p = project();
    await generate(p, REASON);
    assert.equal(w27.validateSolveReady(p.pid, { meshId: p.mid, simulationId: p.sid }).ok, false);
    const live = await generate(p, '');
    assert.equal(live.status, 'done');
    assert.equal(w27.validateSolveReady(p.pid, { meshId: p.mid, simulationId: p.sid }).ok, true);
    // Past every gate, to the stand-in's plan.
    const out = await start(p);
    assert.match(String(out.bodyExtra && out.bodyExtra.error), /fake prepare_run/);
  });
});
