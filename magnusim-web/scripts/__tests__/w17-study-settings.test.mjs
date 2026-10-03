import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

// A new study is seeded with whatever settings its analysis publishes (study_defaults,
// settings_schema defaults included). The core stores them as given and names none:
// no turbulence model, turbulence key or flow group of its own.
const root = mkdtempSync(join(tmpdir(), 'cfd-w17-settings-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;

const { createGeometryFolder, writeJsonAtomic } = await import('../project-layout.js');
const { buildSimulation, handleW17Api } = await import('../w17-simulation.js');
const { loadCommittedRegistry, resetRegistryCache, setLiveRegistry } = await import('../registry-defaults.js');

after(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => resetRegistryCache());

/** A one-analysis plugin row ("Scalar diffusion", steady only) with these study defaults. */
function scalarRow(studyDefaults) {
  return {
    key: 'scalar_steady',
    label: 'Scalar diffusion',
    plugin: 'scalar',
    time_dependency: 'steady',
    category: 'HEAT',
    algorithm_label: 'SIMPLE',
    family: { key: 'scalar', label: 'Scalar', study_name: 'Scalar' },
    study_defaults: {
      analysis_type: 'scalar_steady',
      analysis: 'Scalar',
      analysis_title: 'Scalar diffusion',
      category: 'HEAT',
      time_dependency: 'Steady-state',
      algorithm: 'SIMPLE',
      ...studyDefaults,
    },
  };
}

function installAnalysis(row) {
  const committed = loadCommittedRegistry();
  assert.ok(setLiveRegistry({ ...committed, analysis: [...committed.analysis, row] }));
}

function seedProject(projectId) {
  const dir = join(root, projectId);
  mkdirSync(dir, { recursive: true });
  const proj = {
    id: projectId,
    active_geometry_id: 'geom-1',
    geometries: [{ id: 'geom-1', name: 'Box' }],
  };
  writeJsonAtomic(join(dir, 'project.json'), proj);
  createGeometryFolder(dir, { id: 'geom-1', name: 'Box', original_filename: 'box.step' });
  return { dir, proj };
}

async function create(body) {
  const out = {};
  const res = { setHeader() {} };
  await handleW17Api({ method: 'POST' }, res, new URL('http://x/api/simulation'), ['api', 'simulation'], {
    readJsonBody: async () => body,
    // What the client receives (JSON on the wire).
    sendJson: (_res, status, json) => Object.assign(out, { status, json: JSON.parse(JSON.stringify(json)) }),
  });
  return out;
}

const NAMED = ['turbulence_model', 'turbulence_model_key', 'flow_group'];

describe('a new study stores its analysis settings generically', () => {
  it('carries a setting the core does not know, and no turbulence keys', async () => {
    installAnalysis(scalarRow({ diffusivity: 0.1 }));
    const { dir, proj } = seedProject('p-scalar');
    const built = buildSimulation({ analysis_type: 'scalar_steady' }, proj);
    assert.equal(built.ok, true);
    assert.equal(built.sim.diffusivity, 0.1);
    assert.equal(built.sim.defaults.diffusivity, 0.1);
    for (const key of NAMED) {
      assert.equal(key in built.sim, false, key + ' on the study');
      assert.equal(key in built.sim.defaults, false, key + ' in its defaults');
    }

    const out = await create({ project_id: 'p-scalar', analysis_type: 'scalar_steady' });
    assert.equal(out.status, 201, JSON.stringify(out.json));
    const sim = out.json.simulation;
    assert.equal(sim.diffusivity, 0.1);
    assert.equal(sim.analysis_type, 'scalar_steady');
    for (const key of NAMED) assert.equal(key in sim, false, key + ' on the saved study');
    assert.deepEqual(out.json.defaults, { time_dependency: 'Steady-state', algorithm: 'SIMPLE' });

    // The saved row keeps the setting; project.json's study reference names no turbulence.
    const index = JSON.parse(readFileSync(join(dir, 'simulations.json'), 'utf8'));
    const row = index.simulations.find((s) => s.id === sim.id);
    assert.equal(row.diffusivity, 0.1);
    for (const key of NAMED) assert.equal(key in row, false, key + ' in simulations.json');
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    assert.equal(project.simulation.id, sim.id);
    assert.equal('turbulence_model' in project.simulation, false);
  });

  it('carries a turbulence model on the study and its defaults when the analysis seeds one', async () => {
    installAnalysis(scalarRow({ turbulence_model: 'kOmegaSST' }));
    const { proj } = seedProject('p-turb');
    const built = buildSimulation({ analysis_type: 'scalar_steady' }, proj);
    assert.equal(built.sim.turbulence_model, 'kOmegaSST');
    assert.equal(built.sim.defaults.turbulence_model, 'kOmegaSST');
    assert.equal('turbulence_model_key' in built.sim, false);
    assert.equal('flow_group' in built.sim, false);

    const out = await create({ project_id: 'p-turb', analysis_type: 'scalar_steady' });
    assert.equal(out.status, 201, JSON.stringify(out.json));
    assert.equal(out.json.simulation.turbulence_model, 'kOmegaSST');
    assert.equal(out.json.simulation.defaults.turbulence_model, 'kOmegaSST');
  });

  it('the identity comes from the request and the analysis, not from a seeded value of the same name', () => {
    installAnalysis(scalarRow({ diffusivity: 0.2 }));
    const { proj } = seedProject('p-identity');
    const built = buildSimulation({ analysis_type: 'scalar_steady', id: 'sim-x' }, proj);
    assert.equal(built.sim.id, 'sim-x');
    assert.equal(built.sim.project_id, 'p-identity');
    assert.equal(built.sim.geometry_id, 'geom-1');
    assert.equal(built.sim.time_dependency, 'Steady-state');
    assert.equal(built.sim.algorithm, 'SIMPLE');
    assert.equal(built.sim.category, 'HEAT');
  });
});
