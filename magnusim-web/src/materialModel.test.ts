import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import committed from '../scripts/generated/registry.json';
import {
  defaultPreset,
  materialRecord,
  modelFor,
  presetOf,
  properties,
  recordValues,
  type MaterialModelRow,
} from './materialModel';
import { useProjectStore } from './store/project';
import { FIXTURE_MODEL, FIXTURE_REGISTRY as REGISTRY } from './test/materialFixture';

beforeEach(() => {
  useProjectStore.setState({ registry: REGISTRY as never });
});

afterEach(() => {
  useProjectStore.setState({ registry: null });
});

describe('modelFor', () => {
  it("reads the analysis's material model, the default analysis's for a blank or unknown key", () => {
    expect(modelFor('incompressible_steady')?.key).toBe('newtonian_incompressible');
    expect(modelFor('')?.key).toBe('newtonian_incompressible');
    expect(modelFor('not_installed')?.key).toBe('newtonian_incompressible');
    expect(modelFor('no_fluid_steady')).toBeUndefined();
  });

  it('is undefined before the registry arrives', () => {
    useProjectStore.setState({ registry: null });
    expect(modelFor('incompressible_steady')).toBeUndefined();
  });
});

describe('presetOf: preset key, library code, name, blank name, else custom', () => {
  const m = FIXTURE_MODEL;
  it.each([
    [{ preset: 'water', library: 'AIR', name: 'Air' }, 'water'],
    [{ library: 'AIR' }, 'air'],
    [{ library: 'DEFAULT', name: 'Air' }, 'air'],
    [{ library: 'default' }, 'air'],
    [{ library: 'WATER', name: 'Air' }, 'water'],
    [{ library: 'CUSTOM', name: 'Air' }, 'custom'],
    [{ name: 'water' }, 'water'],
    [{ name: 'Air' }, 'air'],
    [{ name: ' AIR ' }, 'air'],
    [{ name: '' }, 'air'],
    [{}, 'air'],
    [null, 'air'],
    [{ name: 'Glycerol' }, 'custom'],
    [{ name: 'Glycerol', library: 'GLYCEROL' }, 'custom'],
    [{ preset: 'gone', name: 'Water' }, 'water'],
  ])('%j is %s', (record, key) => {
    expect(presetOf(m, record)?.key).toBe(key);
  });

  it('the default preset carries the DEFAULT code', () => {
    expect(defaultPreset(m)?.key).toBe('air');
  });
});

describe('recordValues', () => {
  const m = FIXTURE_MODEL;
  it('a saved record keeps its numbers, from any of its record keys', () => {
    expect(recordValues(m, { name: 'Air', kinematic_viscosity: 1.529e-5, density: 1.196 })).toEqual({ nu: 1.529e-5, rho: 1.196 });
    expect(recordValues(m, { name: 'Air', nu: 2e-5, rho: 1.1 })).toEqual({ nu: 2e-5, rho: 1.1 });
  });

  it("a record without numbers reads its preset's legacy values (older projects keep theirs)", () => {
    expect(recordValues(m, { name: 'Air' })).toEqual({ nu: 1.529e-5, rho: 1.196 });
    expect(recordValues(m, { name: 'Glycerol' })).toEqual({ nu: 1.529e-5, rho: 1.196 });
    expect(recordValues(m, { name: 'Water' })).toEqual({ nu: 1.004e-6, rho: 998.2 });
    expect(recordValues(m, { name: 'Air', density: 1.2 })).toEqual({ nu: 1.529e-5, rho: 1.2 });
  });

  it("no record yet is a new material: the preset's values", () => {
    expect(recordValues(m, null)).toEqual({ nu: 1.516e-5, rho: 1.204 });
  });
});

describe('materialRecord', () => {
  const m = FIXTURE_MODEL;
  it('writes every alias, the constants, library code, model and preset, and keeps the rest', () => {
    const rec = materialRecord(
      m,
      { id: 'm1', name: 'Air', library: 'DEFAULT', note: 'kept', created_at: 'then' },
      { preset: 'water', values: { nu: 1.004e-6, rho: 998.2 }, volumes: ['Body1'] },
      { simulation_id: 's1', project_id: 'p1' },
      'now',
    );
    expect(rec).toEqual({
      id: 'm1',
      name: 'Water',
      note: 'kept',
      type: 'Newtonian',
      viscosity_model: 'Newtonian',
      kinematic_viscosity_unit: 'm2/s',
      density_unit: 'kg/m3',
      kinematic_viscosity: 1.004e-6,
      nu: 1.004e-6,
      density: 998.2,
      rho: 998.2,
      library: 'WATER',
      material_model: 'newtonian_incompressible',
      preset: 'water',
      assigned_volumes: ['Body1'],
      assigned_volume: 'Body1',
      body_ids: ['Body1'],
      volume_ids: ['Body1'],
      simulation_id: 's1',
      project_id: 'p1',
      saved: true,
      created_at: 'then',
      updated_at: 'now',
    });
  });

  it('a custom fluid keeps the given name, else its own, else the preset name', () => {
    const v = { nu: 1e-5, rho: 900 };
    expect(materialRecord(m, null, { preset: 'custom', name: 'Glycol mix', values: v, volumes: [] }, {}, 'now')).toMatchObject({
      name: 'Glycol mix',
      library: 'CUSTOM',
      preset: 'custom',
      kinematic_viscosity: 1e-5,
      density: 900,
      assigned_volume: null,
    });
    expect(materialRecord(m, { name: 'Oil' }, { preset: 'custom', values: v, volumes: [] }, {}, 'now').name).toBe('Oil');
    expect(materialRecord(m, { name: 'Air' }, { preset: 'custom', values: v, volumes: [] }, {}, 'now').name).toBe('Custom fluid');
    expect(materialRecord(m, null, { preset: 'custom', name: 'X', values: v, volumes: [] }, {}, 'now').id).toMatch(/^mat-/);
  });
});

describe("the plugin's committed material model", () => {
  const model = (committed as unknown as { material: MaterialModelRow[] }).material.find(
    (r) => r.key === 'newtonian_incompressible',
  ) as MaterialModelRow;

  it('offers every fluid, then Custom, with its values at 20 C', () => {
    expect((model.library || []).map((p) => [p.name, p.values?.nu, p.values?.rho, p.library])).toEqual([
      ['Air', 1.516e-5, 1.204, 'AIR'],
      ['Argon', 1.34e-5, 1.661, 'ARGON'],
      ['Carbon dioxide', 8.03e-6, 1.842, 'CO2'],
      ['Hydrogen', 1.05e-4, 0.0838, 'HYDROGEN'],
      ['Nitrogen', 1.51e-5, 1.165, 'NITROGEN'],
      ['Water', 1.004e-6, 998.2, 'WATER'],
      ['Seawater (3.5% saline)', 1.05e-6, 1025, 'SEAWATER'],
      ['Custom fluid', 1.516e-5, 1.204, 'CUSTOM'],
    ]);
    expect(properties(model).map((p) => [p.key, p.quantity])).toEqual([
      ['nu', 'kinematic_viscosity'],
      ['rho', 'density'],
    ]);
  });

  it.each([
    ['argon', 'Argon', 1.34e-5, 1.661],
    ['co2', 'Carbon dioxide', 8.03e-6, 1.842],
    ['hydrogen', 'Hydrogen', 1.05e-4, 0.0838],
    ['nitrogen', 'Nitrogen', 1.51e-5, 1.165],
    ['seawater', 'Seawater (3.5% saline)', 1.05e-6, 1025],
  ])('%s saves its values and reads back as itself', (key, name, nu, rho) => {
    const rec = materialRecord(model, null, { preset: key, values: { nu, rho }, volumes: ['Body1'] }, {}, 'now');
    expect(rec).toMatchObject({ name, preset: key, kinematic_viscosity: nu, nu, density: rho, rho });
    expect(presetOf(model, rec)?.key).toBe(key);
    expect(presetOf(model, { name })?.key).toBe(key);
    expect(presetOf(model, { library: rec.library })?.key).toBe(key);
    expect(recordValues(model, rec)).toEqual({ nu, rho });
  });

  it('an old record (library DEFAULT, no numbers) reads as Air with the old numbers', () => {
    expect(presetOf(model, { name: 'Air', library: 'DEFAULT' })?.key).toBe('air');
    expect(recordValues(model, { name: 'Air', library: 'DEFAULT' })).toEqual({ nu: 1.529e-5, rho: 1.196 });
    expect(recordValues(model, null)).toEqual({ nu: 1.516e-5, rho: 1.204 });
  });
});
