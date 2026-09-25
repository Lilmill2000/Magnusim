import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'cfd-bcs-legacy-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;

const { createGeometryFolder, createStudyFolder, studyBcsDir, studyBcsPath, writeJsonAtomic } = await import(
  '../project-layout.js'
);
const { getBcs, handleW19Api } = await import('../w19-boundary-conditions.js');

/** e2e/fixtures/sample-project-steady-state/boundary_conditions.json: no ids, tagged sim_1. */
const LEGACY_BCS = {
  defaults: { wall_type: 'No-slip' },
  boundary_conditions: [
    {
      name: 'velocity_inlet_1',
      bc_type: 'Velocity Inlet',
      velocity_type: 'Fixed',
      value: 50.0,
      unit: 'm/s',
      faces: ['face 1@Body1'],
      simulation_id: 'sim_1',
    },
    { name: 'pressure_1', bc_type: 'Pressure Outlet', value: 0, unit: 'Pa', faces: ['face 2@Body1'], simulation_id: 'sim_1' },
  ],
};

function seed(projectId, { copyIntoStudy, extraSims = [], rootBcs = LEGACY_BCS }) {
  const dir = join(root, projectId);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'project.json'), {
    id: projectId,
    active_geometry_id: 'geom-e2e',
    geometries: [{ id: 'geom-e2e', name: 'Elbow' }],
  });
  const sims = [{ id: 'sim_1', name: 'Incompressible Steady-state', geometry_id: 'geom-e2e' }, ...extraSims];
  writeJsonAtomic(join(dir, 'simulations.json'), { active_id: 'sim_1', simulations: sims });
  writeJsonAtomic(join(dir, 'boundary_conditions.json'), rootBcs);
  createGeometryFolder(dir, { id: 'geom-e2e', name: 'elbow', original_filename: 'elbow.step' });
  const studies = sims.map((s) => createStudyFolder(dir, 'geom-e2e', s));
  // What e2e/prepare-projects.js and migrate_root_siblings do for a single-study project.
  if (copyIntoStudy) writeJsonAtomic(studyBcsPath(studies[0].dir), rootBcs);
  return { dir, study: studies[0] };
}

async function post(body) {
  const out = {};
  const res = { setHeader() {} };
  await handleW19Api({ method: 'POST' }, res, new URL('http://x/api/bcs'), ['api', 'bcs'], {
    readJsonBody: async () => body,
    sendJson: (_res, status, json) => Object.assign(out, { status, json }),
  });
  return out;
}

const names = (list) => (list || []).map((b) => b.name).sort();

after(() => rmSync(root, { recursive: true, force: true }));

for (const copyIntoStudy of [true, false]) {
  const layout = copyIntoStudy ? 'root file copied into the study' : 'root file only, never migrated';
  describe(`legacy root BCs survive the first study-level create (${layout})`, () => {
    const projectId = copyIntoStudy ? 'legacy-copied' : 'legacy-root-only';
    const { study } = seed(projectId, { copyIntoStudy });

    it('GET /api/bcs returns the legacy BCs the tree shows, with stable ids', () => {
      const r = getBcs(projectId, undefined, 'sim_1');
      assert.equal(r.status, 200);
      assert.deepEqual(names(r.body.boundary_conditions), ['pressure_1', 'velocity_inlet_1']);
      const byName = Object.fromEntries(r.body.boundary_conditions.map((b) => [b.name, b.id]));
      assert.equal(byName.velocity_inlet_1, 'bc-legacy-1');
      assert.equal(byName.pressure_1, 'bc-legacy-2');
    });

    it('creating one BC keeps both legacy BCs (response, GET and disk)', async () => {
      const created = await post({ project_id: projectId, simulation_id: 'sim_1', bc_type: 'Wall', faces: ['face 3@Body1'] });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const want = ['Wall 1', 'pressure_1', 'velocity_inlet_1'];
      assert.deepEqual(names(created.json.boundary_conditions), want);
      assert.deepEqual(names(getBcs(projectId, undefined, 'sim_1').body.boundary_conditions), want);

      const aggregate = JSON.parse(readFileSync(studyBcsPath(study.dir), 'utf8'));
      assert.deepEqual(names(aggregate.boundary_conditions), want);
      const folders = readdirSync(studyBcsDir(study.dir)).filter((n) => n.startsWith('BC_'));
      assert.equal(folders.length, 3, folders.join(', '));
      const adopted = JSON.parse(readFileSync(join(studyBcsDir(study.dir), 'BC_velocity_inlet_1', 'bc.json'), 'utf8'));
      assert.equal(adopted.id, 'bc-legacy-1');
      assert.equal(adopted.value, 50);
    });

    it('a second create still sees all of them', async () => {
      const created = await post({ project_id: projectId, simulation_id: 'sim_1', bc_type: 'Wall', faces: ['face 4@Body1'] });
      assert.deepEqual(names(created.json.boundary_conditions), ['Wall 1', 'Wall 2', 'pressure_1', 'velocity_inlet_1']);
    });

    it('deleting one adopted legacy BC removes only that one', async () => {
      const del = await post({ project_id: projectId, simulation_id: 'sim_1', delete: 'bc-legacy-2' });
      assert.equal(del.status, 200, JSON.stringify(del.json));
      const want = ['Wall 1', 'Wall 2', 'velocity_inlet_1'];
      assert.deepEqual(names(del.json.boundary_conditions), want);
      assert.deepEqual(names(getBcs(projectId, undefined, 'sim_1').body.boundary_conditions), want);
      assert.ok(existsSync(join(root, projectId, 'boundary_conditions.json')), 'root legacy file is left untouched');
    });
  });
}

describe('deleting a legacy BC before any create', () => {
  const projectId = 'legacy-delete-first';
  seed(projectId, { copyIntoStudy: true });

  it('removes that BC and keeps the other', async () => {
    const del = await post({ project_id: projectId, simulation_id: 'sim_1', delete: 'bc-legacy-1' });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.deepEqual(names(getBcs(projectId, undefined, 'sim_1').body.boundary_conditions), ['pressure_1']);
  });
});

describe('root BCs in a multi-study project follow matchesStudy', () => {
  const projectId = 'legacy-multi';
  seed(projectId, {
    copyIntoStudy: false,
    extraSims: [{ id: 'sim_2', name: 'Second', geometry_id: 'geom-e2e' }],
    rootBcs: {
      boundary_conditions: [
        { name: 'mine', bc_type: 'Wall', faces: ['face 1@Body1'], simulation_id: 'sim_1' },
        { name: 'theirs', bc_type: 'Wall', faces: ['face 2@Body1'], simulation_id: 'sim_2' },
        { name: 'untagged', bc_type: 'Wall', faces: ['face 3@Body1'] },
      ],
    },
  });

  it('each study sees only rows tagged for it; untagged rows stay unassigned', async () => {
    assert.deepEqual(names(getBcs(projectId, undefined, 'sim_1').body.boundary_conditions), ['mine']);
    assert.deepEqual(names(getBcs(projectId, undefined, 'sim_2').body.boundary_conditions), ['theirs']);
    const created = await post({ project_id: projectId, simulation_id: 'sim_1', bc_type: 'Wall', faces: ['face 4@Body1'] });
    assert.deepEqual(names(created.json.boundary_conditions), ['Wall 1', 'mine']);
    assert.deepEqual(names(getBcs(projectId, undefined, 'sim_2').body.boundary_conditions), ['theirs']);
  });
});
