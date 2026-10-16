// The mesher of a new mesh, a copy and Restore defaults (host API 1.8 default_mesher),
// through the real /api/mesh handler (scripts/w20-mesh.js) and read back as the app reads
// a mesh (the hydrate migrate of migrateMeshEngineEntry runs on every read):
// - a new mesh whose study's mesher is cfMesh is saved as cfMesh (not the old bug stamp);
// - a copy of a cfMesh mesh is cfMesh, as a new mesh and into an existing one;
// - Restore defaults gives the study's mesher (Hex-dominant for a Heat Transfer-like
//   study), not Standard;
// - a save that makes the study's first mesh starts it on the study's mesher.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'cfd-w20-engine-'));
const projects = join(root, 'projects');
mkdirSync(projects);
process.env.MAGNUSIM_PROJECTS_ROOT = projects;

const { attachWorkerBridge } = await import('../py-json.js');
const { createProjectFromSample } = await import('../w16-project-geometry.js');
const { getMesh, handleW20Api, W20_DEFAULTS } = await import('../w20-mesh.js');
const { loadCommittedRegistry, resetRegistryCache, setLiveRegistry } = await import('../registry-defaults.js');

const json = (value) => JSON.stringify(value, null, 2);

/** The live registry with incompressible_steady naming `engine` as its new meshes' mesher. */
function studyMesher(engine) {
  const reg = loadCommittedRegistry();
  setLiveRegistry({
    ...reg,
    analysis: reg.analysis.map((r) => (r.key === 'incompressible_steady' ? { ...r, default_mesher: engine } : r)),
  });
}

/** A project with one study (incompressible_steady), made the way Home opens a sample. */
async function project() {
  const dir = join(root, 'sample');
  const study = join(dir, 'geometries', 'G', 'simulations', 'S');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(study, { recursive: true });
  writeFileSync(join(dir, 'project.json'), json({ id: '{{project_id}}', title: 'Engines' }));
  writeFileSync(join(dir, 'geometries', 'G', 'id.json'), json({ id: 'G' }));
  writeFileSync(join(study, 'id.json'), json({ id: 'sim-1', name: 'S', analysis_type: 'incompressible_steady' }));
  attachWorkerBridge((method) =>
    method === 'plugins.sample' ? Promise.resolve({ ok: true, plugin: 'demo', sample: 's', title: 'Engines', dir }) : null,
  );
  const made = await createProjectFromSample({ plugin: 'demo', sample: 's' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.id;
}

async function post(body) {
  let sent = null;
  await handleW20Api({ method: 'POST' }, { setHeader() {} }, new URL('http://x/api/mesh'), ['api', 'mesh'], {
    readJsonBody: async () => body,
    sendJson: (_res, status, b) => (sent = { status, body: b }),
  });
  assert.ok(sent && sent.status < 300, JSON.stringify(sent));
  return sent.body;
}

/** A mesh as the app reads it back: its saved engine after the hydrate migrate. */
function engineNow(pid, meshId) {
  const got = getMesh(pid, undefined, 'sim-1', { meshId });
  const mesh = got.body.mesh;
  assert.equal(String(mesh.id), String(meshId));
  return mesh.settings.advanced.mesh_engine;
}

let pid = '';
before(async () => {
  pid = await project();
});
after(() => {
  attachWorkerBridge(null);
  resetRegistryCache();
  rmSync(root, { recursive: true, force: true });
});

describe("a new mesh, a copy and Restore defaults use the study's mesher", () => {
  it('a new mesh whose study starts on cfMesh is cfMesh, and so are its copies', async () => {
    studyMesher('cfmesh');
    const made = await post({ project_id: pid, simulation_id: 'sim-1', create: true, name: 'CF' });
    const cf = made.mesh.id;
    assert.equal(made.mesh.settings.advanced.mesh_engine, 'cfmesh');
    assert.equal(engineNow(pid, cf), 'cfmesh');
    // A copy as a new mesh keeps its source's mesher.
    studyMesher('');
    const copy = await post({ project_id: pid, simulation_id: 'sim-1', create: true, name: 'CF copy', copy_from: cf });
    assert.equal(engineNow(pid, copy.mesh.id), 'cfmesh');
    // Copied into an existing Standard mesh: cfMesh too.
    const std = await post({ project_id: pid, simulation_id: 'sim-1', create: true, name: 'Std' });
    assert.equal(engineNow(pid, std.mesh.id), 'standard');
    await post({ project_id: pid, simulation_id: 'sim-1', mesh_id: std.mesh.id, copy_from: cf });
    assert.equal(engineNow(pid, std.mesh.id), 'cfmesh');
  });

  it("Restore defaults gives the study's mesher (Hex-dominant), not Standard", async () => {
    studyMesher('snappy_hexdominant');
    const made = await post({ project_id: pid, simulation_id: 'sim-1', create: true, name: 'Hex' });
    const id = made.mesh.id;
    assert.equal(engineNow(pid, id), 'snappy_hexdominant');
    await post({ project_id: pid, simulation_id: 'sim-1', mesh_id: id, fineness: 6, advanced: { mesh_engine: 'standard' } });
    assert.equal(engineNow(pid, id), 'standard');
    // As the Mesh panel's Restore defaults sends it (setupPersist.saveMeshSettings).
    const restored = await post({
      project_id: pid,
      simulation_id: 'sim-1',
      mesh_id: id,
      reset_defaults: true,
      use_bank_defaults: true,
      force_bank: true,
      name: 'Hex',
    });
    assert.equal(restored.mesh.settings.advanced.mesh_engine, 'snappy_hexdominant');
    assert.equal(restored.mesh.settings.fineness, W20_DEFAULTS.fineness);
    assert.equal(engineNow(pid, id), 'snappy_hexdominant');
  });
});

describe("a save with no mesh yet makes the study's first mesh on the study's mesher", () => {
  it('the engine the form sent (its Standard default) is not taken as a pick', async () => {
    const other = await project();
    studyMesher('snappy_hexdominant');
    const saved = await post({ project_id: other, simulation_id: 'sim-1', fineness: 3, advanced: { mesh_engine: 'standard' } });
    assert.equal(saved.mesh.settings.fineness, 3);
    assert.equal(saved.mesh.settings.advanced.mesh_engine, 'snappy_hexdominant');
    assert.equal(engineNow(other, saved.mesh.id), 'snappy_hexdominant');
    // On that mesh, a pick is a pick.
    await post({ project_id: other, simulation_id: 'sim-1', mesh_id: saved.mesh.id, advanced: { mesh_engine: 'cfmesh' } });
    assert.equal(engineNow(other, saved.mesh.id), 'cfmesh');
  });
});
