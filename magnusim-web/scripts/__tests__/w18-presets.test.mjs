/**
 * POST /api/materials seeds a new material from the analysis's material model
 * presets (the committed registry here); a saved record keeps its numbers, and
 * an older one without numbers reads what older versions filled in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'w18-presets-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;
const { airFromProject, buildAirMaterial, defaultFluidName, materialHeaderName, studyFluid, W18_META } = await import(
  '../w18-materials.js'
);
const { materialPreset, materialPresetOf, materialModel } = await import('../registry-defaults.js');

test.after(() => rmSync(root, { recursive: true, force: true }));

const BODY = { assigned_volumes: ['Body1'] };

function built(body, existing = null) {
  const out = buildAirMaterial(body, existing);
  assert.equal(out.ok, true, JSON.stringify(out.body));
  return out.material;
}

test('POST name=Water seeds water, every record key included', () => {
  const m = built({ ...BODY, name: 'Water' });
  assert.equal(m.name, 'Water');
  assert.equal(m.density, 998.2);
  assert.equal(m.rho, 998.2);
  assert.equal(m.kinematic_viscosity, 1.004e-6);
  assert.equal(m.nu, 1.004e-6);
  assert.equal(m.library, 'WATER');
  assert.equal(m.preset, 'water');
  assert.equal(m.material_model, 'newtonian_incompressible');
  assert.equal(m.viscosity_model, 'Newtonian');
  assert.equal(m.kinematic_viscosity_unit, 'm2/s');
  assert.equal(m.density_unit, 'kg/m3');
});

test('a new Air (named or not) seeds air at 20 C', () => {
  for (const body of [BODY, { ...BODY, name: 'Air' }, { ...BODY, material: 'air' }]) {
    const m = built(body);
    assert.equal(m.name, 'Air');
    assert.equal(m.density, 1.204);
    assert.equal(m.kinematic_viscosity, 1.516e-5);
    assert.equal(m.library, 'AIR');
    assert.equal(m.preset, 'air');
  }
  assert.equal(W18_META.air.key, 'air');
});

for (const [name, key, nu, rho, code] of [
  ['Argon', 'argon', 1.34e-5, 1.661, 'ARGON'],
  ['Carbon dioxide', 'co2', 8.03e-6, 1.842, 'CO2'],
  ['Hydrogen', 'hydrogen', 1.05e-4, 0.0838, 'HYDROGEN'],
  ['Nitrogen', 'nitrogen', 1.51e-5, 1.165, 'NITROGEN'],
  ['Seawater (3.5% saline)', 'seawater', 1.05e-6, 1025, 'SEAWATER'],
]) {
  test(`POST name=${name} seeds its preset`, () => {
    const m = built({ ...BODY, name });
    assert.deepEqual([m.name, m.preset, m.kinematic_viscosity, m.density, m.library], [name, key, nu, rho, code]);
  });
}

test('another name is a custom fluid with its own name and numbers', () => {
  const m = built({ ...BODY, name: 'Glycol mix', kinematic_viscosity: 1e-5, density: 1070 });
  assert.deepEqual([m.name, m.preset, m.library, m.kinematic_viscosity, m.density], ['Glycol mix', 'custom', 'CUSTOM', 1e-5, 1070]);
});

test('a saved record keeps its numbers', () => {
  const saved = { id: 'm1', name: 'Air', library: 'DEFAULT', kinematic_viscosity: 1.529e-5, density: 1.196, assigned_volumes: ['Body1'] };
  const m = built({ assigned_volumes: ['Body1', 'Body2'] }, saved);
  assert.deepEqual([m.id, m.name, m.kinematic_viscosity, m.density], ['m1', 'Air', 1.529e-5, 1.196]);
  assert.deepEqual(m.assigned_volumes, ['Body1', 'Body2']);
});

test('an older record without numbers reads what older versions filled in', () => {
  const old = { id: 'm1', name: 'Air', library: 'DEFAULT', assigned_volumes: ['Body1'] };
  const m = built({}, old);
  assert.deepEqual([m.name, m.kinematic_viscosity, m.nu, m.density, m.rho], ['Air', 1.529e-5, 1.529e-5, 1.196, 1.196]);
  // Water's numbers did not change.
  const w = built({}, { id: 'm2', name: 'Water', assigned_volumes: ['Body1'] });
  assert.deepEqual([w.kinematic_viscosity, w.density], [1.004e-6, 998.2]);
});

test('naming another preset on a saved record loads that preset', () => {
  const saved = { id: 'm1', name: 'Air', kinematic_viscosity: 1.529e-5, density: 1.196, assigned_volumes: ['Body1'] };
  const m = built({ name: 'Argon' }, saved);
  assert.deepEqual([m.id, m.name, m.kinematic_viscosity, m.density], ['m1', 'Argon', 1.34e-5, 1.661]);
});

test('legacy airFromProject (an old project without numbers) still gives 1.196 and library DEFAULT', () => {
  const id = 'old-project';
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(
    join(root, id, 'project.json'),
    JSON.stringify({ id, materials: { air: { id: 'mat-old', assigned_volumes: ['Body1'] } } }),
  );
  const doc = airFromProject(id);
  assert.equal(doc.air.id, 'mat-old');
  assert.equal(doc.air.name, 'Air');
  assert.equal(doc.air.density, 1.196);
  assert.equal(doc.air.kinematic_viscosity, 1.529e-5);
  assert.equal(doc.air.library, 'DEFAULT');
});

test("the presets' read rule", () => {
  assert.equal(materialModel('')?.key, 'newtonian_incompressible');
  assert.equal(materialPreset('', '')?.key, 'air');
  assert.equal(materialPreset('', 'DEFAULT')?.key, 'air');
  assert.equal(materialPreset('', 'water')?.key, 'water');
  assert.equal(materialPreset('', 'Glycerol')?.key, 'custom');
  assert.equal(materialPresetOf('', { name: 'Air', library: 'CUSTOM' })?.key, 'custom');
  assert.equal(materialPresetOf('', { preset: 'water', library: 'AIR' })?.key, 'water');
  assert.equal(materialPresetOf('', { name: '' })?.key, 'air');
  assert.equal(materialPreset('not_registered', 'Air'), null);
});

test("the study's fluid: assigned first, else the model's default fluid (an older study's Air), else the first", () => {
  assert.equal(defaultFluidName(), 'Air');
  assert.equal(defaultFluidName('newtonian_incompressible'), 'Air');
  const water = { name: 'Water' };
  const air = { name: 'Air' };
  const assigned = { name: 'Nitrogen', assigned_volumes: ['Body1'] };
  assert.equal(studyFluid([water, air, assigned]), assigned);
  assert.equal(studyFluid([water, air]), air);
  assert.equal(studyFluid([water]), water);
  assert.equal(studyFluid([]), null);
});

test('X-CFD-Material-Name is the saved material name (Air stays Air)', () => {
  assert.equal(materialHeaderName(built(BODY)), 'Air');
  assert.equal(materialHeaderName(built({ ...BODY, name: 'Water' })), 'Water');
  assert.equal(materialHeaderName({ name: 'Seawater (3.5% saline)' }), 'Seawater (3.5% saline)');
  assert.equal(materialHeaderName({ name: 'Wasser ä' }), encodeURIComponent('Wasser ä'));
  assert.equal(materialHeaderName({}), 'Air');
});
