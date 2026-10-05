import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The BC routes take their types, seeds and field rules from the registry's
// BC families (bc_family), and keep every field a BC was saved with.
const root = mkdtempSync(join(tmpdir(), 'cfd-w19-registry-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;

const { createGeometryFolder, createStudyFolder, studyBcsDir, writeJsonAtomic } = await import('../project-layout.js');
const { getBcs, handleW19Api, W19_META } = await import('../w19-boundary-conditions.js');
const { bcRecordTypes, loadCommittedRegistry, resetRegistryCache, setLiveRegistry } = await import(
  '../registry-defaults.js'
);

const SIM = 'sim_1';

function seedProject(projectId, units) {
  const dir = join(root, projectId);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'project.json'), {
    id: projectId,
    units,
    active_geometry_id: 'geom-1',
    geometries: [{ id: 'geom-1', name: 'Box' }],
  });
  writeJsonAtomic(join(dir, 'simulations.json'), {
    active_id: SIM,
    simulations: [{ id: SIM, name: 'Study 1', geometry_id: 'geom-1' }],
  });
  createGeometryFolder(dir, { id: 'geom-1', name: 'Box', original_filename: 'box.step' });
  return createStudyFolder(dir, 'geom-1', { id: SIM, name: 'Study 1' });
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

/** The bc.json on disk of a BC, by id. */
function onDisk(study, id) {
  const dir = studyBcsDir(study.dir);
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('BC_')) continue;
    const rec = JSON.parse(readFileSync(join(dir, name, 'bc.json'), 'utf8'));
    if (rec.id === id) return rec;
  }
  return null;
}

const POROUS = {
  key: 'porous_jump',
  label: 'Porous jump',
  plugin: 'test_plugin',
  record_type: 'Porous jump',
  aliases: ['Porous baffle'],
  color: 'wall',
  hint: '',
  variants: ['porous_jump'],
  defaults: { metric: { resistance: 1000, mode: 'Darcy' }, imperial: { resistance: 1000, mode: 'Darcy' } },
  values: [],
  fields: {
    type: 'object',
    properties: {
      resistance: { type: 'number', default: 1 },
      mode: { type: 'string', default: 'Darcy', enum: ['Darcy', 'Forchheimer'] },
    },
  },
  ui: '',
};

after(() => {
  resetRegistryCache();
  rmSync(root, { recursive: true, force: true });
});

describe('BC types come from the registry', () => {
  const projectId = 'types';
  seedProject(projectId, 'Metric');

  afterEach(() => resetRegistryCache());

  it('a family the live registry adds is accepted under its record_type', async () => {
    const committed = loadCommittedRegistry();
    assert.ok(setLiveRegistry({ ...committed, bc_family: [...committed.bc_family, POROUS] }));
    assert.ok(W19_META.types.includes('Porous jump'));

    const r = await post({ project_id: projectId, simulation_id: SIM, bc_type: 'Porous baffle', faces: ['face 1@Body1'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.bc.bc_type, 'Porous jump');
    assert.equal(r.json.bc.name, 'Porous jump 1');
    assert.equal(r.json.bc.resistance, 1000);
    assert.equal(r.json.bc.mode, 'Darcy');

    const edited = await post({ project_id: projectId, simulation_id: SIM, id: r.json.bc.id, mode: 'forchheimer', resistance: '250' });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.bc.mode, 'Forchheimer');
    assert.equal(edited.json.bc.resistance, 250);
  });

  it('an unknown type is a 400 listing the registered types', async () => {
    const committed = loadCommittedRegistry();
    setLiveRegistry({ ...committed, bc_family: [...committed.bc_family, POROUS] });
    const r = await post({ project_id: projectId, simulation_id: SIM, bc_type: 'Banana', faces: [] });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Unsupported boundary condition type');
    assert.equal(r.json.got, 'Banana');
    assert.deepEqual(r.json.allowed, bcRecordTypes());
    assert.deepEqual(r.json.allowed, [...committed.bc_family.map((f) => f.record_type), 'Porous jump']);
  });

  it('without the live family its type is refused again', async () => {
    const r = await post({ project_id: projectId, simulation_id: SIM, bc_type: 'Porous jump', faces: [] });
    assert.equal(r.status, 400);
    const types = loadCommittedRegistry().bc_family.map((f) => f.record_type);
    assert.deepEqual(r.json.allowed, types);
    assert.deepEqual(W19_META.types, types);
    assert.deepEqual(types, [
      'Velocity inlet',
      'Velocity outlet',
      'Pressure',
      'Total pressure inlet',
      'Freestream',
      'Wall',
      'Symmetry',
    ]);
  });

  it("'Pressure outlet' is stored as 'Pressure'", async () => {
    const study = seedProject('aliases', 'Metric');
    const r = await post({ project_id: 'aliases', simulation_id: SIM, bc_type: 'Pressure outlet', faces: ['face 2@Body1'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.bc.bc_type, 'Pressure');
    assert.equal(r.json.bc.name, 'Pressure 1');
    assert.equal(onDisk(study, r.json.bc.id).bc_type, 'Pressure');
    assert.equal(getBcs('aliases', undefined, SIM).body.boundary_conditions[0].bc_type, 'Pressure');
  });
});

describe('a BC keeps every field it was saved with', () => {
  const projectId = 'fields';
  const study = seedProject(projectId, 'Metric');
  let id = '';

  it('create', async () => {
    const r = await post({
      project_id: projectId,
      simulation_id: SIM,
      bc_type: 'Wall',
      wall_type: 'No-slip',
      heat_flux_W_m2: 120.5,
      faces: ['face 3@Body1'],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    id = r.json.bc.id;
    assert.equal(r.json.bc.heat_flux_W_m2, 120.5);
    assert.equal(onDisk(study, id).heat_flux_W_m2, 120.5);
  });

  it('a single update that does not send it', async () => {
    const r = await post({ project_id: projectId, simulation_id: SIM, id, wall_type: 'slip' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.bc.wall_type, 'Slip');
    assert.equal(r.json.bc.heat_flux_W_m2, 120.5);
    assert.deepEqual(r.json.bc.faces, ['face 3@Body1']);
    assert.equal(onDisk(study, id).heat_flux_W_m2, 120.5);
  });

  it('the { bcs: [...] } batch (what a units switch posts)', async () => {
    const rec = getBcs(projectId, undefined, SIM).body.boundary_conditions.find((b) => b.id === id);
    const r = await post({
      project_id: projectId,
      simulation_id: SIM,
      bcs: [{ ...rec, heat_flux_W_m2: 99, thermal_mode: 'fixed_heat_flux' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const saved = onDisk(study, id);
    assert.equal(saved.heat_flux_W_m2, 99);
    assert.equal(saved.thermal_mode, 'fixed_heat_flux');
    assert.equal(saved.wall_type, 'Slip');
    const got = getBcs(projectId, undefined, SIM).body.boundary_conditions.find((b) => b.id === id);
    assert.equal(got.heat_flux_W_m2, 99);
  });

  it('a type change drops only the old family fields', async () => {
    const r = await post({
      project_id: projectId,
      simulation_id: SIM,
      bc_type: 'Velocity inlet',
      value: 3,
      temperature_K: 300,
      faces: ['face 4@Body1'],
    });
    const changed = await post({ project_id: projectId, simulation_id: SIM, id: r.json.bc.id, bc_type: 'Pressure' });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    const bc = changed.json.bc;
    assert.equal(bc.bc_type, 'Pressure');
    assert.equal(bc.temperature_K, 300);
    assert.equal(bc.value, 3);
    assert.equal(bc.pressure_type, 'Fixed value');
    for (const k of ['velocity_type', 'flow_rate_type', 'direction', 'vector', 'apply_per_face']) {
      assert.equal(Object.hasOwn(bc, k), false, k);
    }
  });

  it('request and folder keys are not stored as fields', async () => {
    const r = await post({
      project_id: projectId,
      simulation_id: SIM,
      bc_type: 'Wall',
      type: 'Wall',
      wall_type: 'Slip',
      defaults: { wall_type: 'Slip' },
      folder: 'BC_x',
      dir: '/tmp/x',
      faces: [],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const saved = onDisk(study, r.json.bc.id);
    for (const k of ['type', 'defaults', 'folder', 'dir']) assert.equal(Object.hasOwn(saved, k), false, k);
  });
});

describe('a new BC starts from its family seed', () => {
  it('Imperial projects get ft/s and psi', async () => {
    seedProject('imperial', 'Imperial');
    const v = await post({ project_id: 'imperial', simulation_id: SIM, bc_type: 'Velocity inlet', faces: [] });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(v.json.bc.unit, 'ft/s');
    assert.equal(v.json.bc.velocity_type, 'Fixed');
    assert.equal(v.json.bc.value, 5);
    assert.deepEqual(v.json.bc.vector, [0, 0, 1]);
    assert.equal(v.json.bc.apply_per_face, true);
    const p = await post({ project_id: 'imperial', simulation_id: SIM, bc_type: 'Pressure', faces: [] });
    assert.equal(p.json.bc.unit, 'psi');
    assert.equal(p.json.bc.value, 0);
    assert.equal(p.json.bc.pressure_type, 'Fixed value');
    const q = await post({ project_id: 'imperial', simulation_id: SIM, bc_type: 'Velocity inlet', velocity_type: 'Flow rate', faces: [] });
    assert.equal(q.json.bc.unit, 'ft³/min');
    const m = await post({
      project_id: 'imperial',
      simulation_id: SIM,
      bc_type: 'Velocity inlet',
      velocity_type: 'Flow rate',
      flow_rate_type: 'Mass flow',
      faces: [],
    });
    assert.equal(m.json.bc.unit, 'lb/s');
  });

  it('Metric projects get m/s, Pa and m³/s', async () => {
    seedProject('metric', 'Metric');
    const v = await post({ project_id: 'metric', simulation_id: SIM, bc_type: 'Velocity outlet', faces: [] });
    assert.equal(v.json.bc.unit, 'm/s');
    const p = await post({ project_id: 'metric', simulation_id: SIM, bc_type: 'Pressure', faces: [] });
    assert.equal(p.json.bc.unit, 'Pa');
    const q = await post({ project_id: 'metric', simulation_id: SIM, bc_type: 'Velocity inlet', velocity_type: 'Flow rate', faces: [] });
    assert.equal(q.json.bc.unit, 'm³/s');
  });

  it('fields are normalized from the family schema', async () => {
    seedProject('normalize', 'Metric');
    const v = await post({
      project_id: 'normalize',
      simulation_id: SIM,
      bc_type: 'Velocity inlet',
      velocity_type: 'Sideways',
      direction: 'Vector',
      vector: ['1', 'x', 2.5],
      value: '7.5',
      unit: ' ft/s ',
      faces: [],
    });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(v.json.bc.velocity_type, 'Fixed');
    assert.equal(v.json.bc.flow_rate_type, 'Volumetric flow');
    assert.equal(v.json.bc.direction, 'Vector');
    assert.deepEqual(v.json.bc.vector, [1, 0, 2.5]);
    assert.equal(v.json.bc.value, 7.5);
    assert.equal(v.json.bc.unit, 'ft/s');
    const w = await post({ project_id: 'normalize', simulation_id: SIM, bc_type: 'Wall', wall_type: 'no_slip', faces: [] });
    assert.equal(w.json.bc.wall_type, 'No-slip');
  });
});

describe("Incompressible Flow's newer BCs keep their fields", () => {
  const study = seedProject('newer', 'Imperial');
  const save = (body) => post({ project_id: 'newer', simulation_id: SIM, ...body });

  it('a freestream starts from its seed and keeps its speed, direction, pressure and turbulence', async () => {
    const r = await save({ bc_type: 'Far field', faces: ['face 1@Body1'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const bc = r.json.bc;
    assert.equal(bc.bc_type, 'Freestream');
    assert.equal(bc.name, 'Freestream 1');
    assert.deepEqual(
      [bc.velocity_input, bc.value, bc.unit, bc.vector, bc.freestream_pressure, bc.turbulence_spec],
      ['Speed and direction', 10, 'ft/s', [1, 0, 0], 0, 'Auto'],
    );
    const edited = await save({
      id: bc.id,
      velocity_input: 'velocity vector',
      vector: ['3', 0, -4],
      value: 5,
      freestream_pressure: '120',
      turbulence_spec: 'Intensity and viscosity ratio',
      turbulence_intensity: 1,
      turbulence_viscosity_ratio: 5,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    const disk = onDisk(study, bc.id);
    assert.deepEqual(
      [disk.velocity_input, disk.vector, disk.value, disk.freestream_pressure, disk.turbulence_spec, disk.turbulence_viscosity_ratio],
      ['Velocity vector', [3, 0, -4], 5, 120, 'Intensity and viscosity ratio', 5],
    );
    const listed = getBcs('newer', undefined, SIM).body.boundary_conditions.find((b) => b.id === bc.id);
    assert.equal(listed.turbulence_intensity, 1);
  });

  it('a total-pressure inlet, a symmetry plane and a moving or rotating wall keep theirs', async () => {
    const tp = await save({ bc_type: 'Total pressure', faces: ['face 2@Body1'], value: 2, turbulence_spec: 'Intensity and length scale', turbulence_length_scale: 0.02 });
    assert.equal(tp.status, 200, JSON.stringify(tp.json));
    assert.deepEqual([tp.json.bc.bc_type, tp.json.bc.value, tp.json.bc.unit], ['Total pressure inlet', 2, 'psi']);
    assert.equal(onDisk(study, tp.json.bc.id).turbulence_length_scale, 0.02);

    const sym = await save({ bc_type: 'Symmetry', faces: ['face 3@Body1'] });
    assert.equal(sym.status, 200, JSON.stringify(sym.json));
    assert.equal(onDisk(study, sym.json.bc.id).bc_type, 'Symmetry');

    const wall = await save({ bc_type: 'Wall', faces: ['face 4@Body1'], wall_type: 'moving', wall_velocity: [0, 2, 0] });
    assert.equal(wall.status, 200, JSON.stringify(wall.json));
    assert.deepEqual([wall.json.bc.wall_type, wall.json.bc.wall_velocity], ['Moving', [0, 2, 0]]);
    const turned = await save({ id: wall.json.bc.id, wall_type: 'Rotating', rotation_axis: [0, 0, 1], rotation_speed: 1500 });
    const disk = onDisk(study, turned.json.bc.id);
    assert.deepEqual(
      [disk.wall_type, disk.rotation_axis, disk.rotation_origin, disk.rotation_speed, disk.wall_velocity],
      ['Rotating', [0, 0, 1], [0, 0, 0], 1500, [0, 2, 0]],
    );
    // A type change drops the old family's fields: a symmetry plane has none of the wall's.
    const back = await save({ id: wall.json.bc.id, bc_type: 'Symmetry' });
    const after = onDisk(study, back.json.bc.id);
    assert.equal(after.bc_type, 'Symmetry');
    assert.equal(after.wall_type, undefined);
    assert.equal(after.rotation_speed, undefined);
  });
});
