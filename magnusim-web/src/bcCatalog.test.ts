import { beforeEach, describe, expect, it } from 'vitest';
import committed from '../scripts/generated/registry.json';
import type { BcFamilyRow, RegistryDescribe } from './api/registry.gen';
import {
  canonicalBcType,
  colorOf,
  completeBcRecord,
  defaultsChoiceText,
  familiesFor,
  familyOf,
  newBcRecord,
  typeChangeFields,
  valueQuantity,
} from './bcCatalog';
import { useProjectStore } from './store/project';

// The BC catalogue is read from the registry rows the plugins publish; these
// tests use the committed registry (Incompressible Flow's families) plus a
// fixture family from another plugin.
const IF_FAMILIES = (committed as unknown as RegistryDescribe).bc_family as BcFamilyRow[];
const IF_BCS = IF_FAMILIES.flatMap((f) => f.variants);

const mirror: BcFamilyRow = {
  key: 'mirror_plane',
  label: 'Mirror plane',
  plugin: 'example-extra-bc',
  record_type: 'Mirror plane',
  aliases: ['Mirror'],
  color: 'other',
  hint: 'Mirror plane: no flow through it',
  variants: ['symmetry_plane'],
  defaults: { metric: { mirror: 'Plane' }, imperial: { mirror: 'Plane' } },
  values: [],
  fields: {
    type: 'object',
    properties: { mirror: { type: 'string', title: 'Mirror', enum: ['Plane', 'Wedge'], default: 'Plane' } },
  },
  ui: '',
};

function family(key: string): BcFamilyRow {
  const row = [...IF_FAMILIES, mirror].find((f) => f.key === key);
  if (!row) throw new Error(key);
  return row;
}

beforeEach(() => {
  useProjectStore.setState({
    registry: {
      analysis: [
        { key: 'incompressible_steady', label: 'Incompressible', bc_types: IF_BCS },
        { key: 'extra_bc_steady', label: 'Extra BC', bc_types: [...IF_BCS, 'symmetry_plane'] },
        { key: 'stub_steady', label: 'Stub', bc_types: [] },
      ],
      bc_family: [...IF_FAMILIES, mirror],
      default_analysis: { steady: 'incompressible_steady', aliases: ['Incompressible'] },
    } as RegistryDescribe,
  });
});

describe('families', () => {
  it("offers the families of the study's analysis, in registry order", () => {
    const labels = familiesFor('incompressible_steady').map((f) => f.label);
    expect(labels).toEqual(IF_FAMILIES.map((f) => f.label));
    expect(labels.slice(0, 3)).toEqual(['Velocity inlet', 'Velocity outlet', 'Pressure']);
    expect(labels).toEqual(expect.arrayContaining(['Wall', 'Symmetry', 'Freestream']));
    expect(familiesFor('extra_bc_steady').map((f) => f.key)).toEqual([...IF_FAMILIES.map((f) => f.key), 'mirror_plane']);
    expect(familiesFor('stub_steady')).toEqual([]);
    // No analysis named: the default analysis. One not installed: every family.
    expect(familiesFor('').map((f) => f.key)).toHaveLength(IF_FAMILIES.length);
    expect(familiesFor('Incompressible').map((f) => f.key)).toHaveLength(IF_FAMILIES.length);
    expect(familiesFor('gone_steady').map((f) => f.key)).toHaveLength(IF_FAMILIES.length + 1);
  });

  it('reads older type names through the aliases, ignoring case, spaces, _ and -', () => {
    expect(canonicalBcType('Pressure outlet')).toBe('Pressure');
    expect(canonicalBcType('pressure_inlet')).toBe('Pressure');
    expect(canonicalBcType('Pressure Outlet')).toBe('Pressure');
    expect(canonicalBcType('velocity_inlet')).toBe('Velocity inlet');
    expect(canonicalBcType('No-slip wall')).toBe('Wall');
    expect(canonicalBcType('symmetry plane')).toBe('Symmetry');
    expect(canonicalBcType('mirror')).toBe('Mirror plane');
    expect(canonicalBcType('  Mystery ')).toBe('Mystery');
    expect(familyOf({ type: 'velocity outlet' })?.key).toBe('velocity_outlet');
    expect(familyOf({ bc_type: 'Mystery' })).toBeUndefined();
  });

  it('colours a record by its family; other for one no plugin knows', () => {
    expect(colorOf({ bc_type: 'Velocity inlet' })).toBe('inlet');
    expect(colorOf({ bc_type: 'Velocity outlet' })).toBe('outlet');
    expect(colorOf({ bc_type: 'Pressure outlet' })).toBe('pressure');
    expect(colorOf({ bc_type: 'Wall' })).toBe('wall');
    expect(colorOf({ bc_type: 'Symmetry' })).toBe('symmetry');
    expect(colorOf({ bc_type: 'Mirror plane' })).toBe('other');
    expect(colorOf({ bc_type: 'Mystery' })).toBe('other');
    expect(colorOf(null)).toBe('other');
  });

  it('knows nothing before the registry arrives', () => {
    useProjectStore.setState({ registry: null });
    expect(familiesFor('incompressible_steady')).toEqual([]);
    expect(canonicalBcType('Pressure outlet')).toBe('Pressure outlet');
    expect(colorOf({ bc_type: 'Wall' })).toBe('other');
  });
});

describe('new records', () => {
  it('seeds each family for the unit system', () => {
    expect(newBcRecord(family('velocity_inlet'), false)).toMatchObject({
      bc_type: 'Velocity inlet',
      velocity_type: 'Fixed',
      value: 5,
      unit: 'm/s',
      direction: 'Normal to face',
      vector: [0, 0, 1],
    });
    expect(newBcRecord(family('velocity_inlet'), true).unit).toBe('ft/s');
    expect(newBcRecord(family('pressure_outlet'), false)).toEqual({
      bc_type: 'Pressure',
      pressure_type: 'Fixed value',
      value: 0,
      unit: 'Pa',
    });
    expect(newBcRecord(family('pressure_outlet'), true).unit).toBe('psi');
    expect(newBcRecord(family('mirror_plane'), false)).toEqual({ bc_type: 'Mirror plane', mirror: 'Plane' });
    expect(newBcRecord(family('symmetry'), true)).toEqual({ bc_type: 'Symmetry' });
  });

  it('starts a BC of the family the study defaults use on the choice that differs from the default', () => {
    expect(newBcRecord(family('wall'), false, { wall_type: 'No-slip' }).wall_type).toBe('Slip');
    expect(newBcRecord(family('wall'), false, { wall_type: 'Slip' }).wall_type).toBe('No-slip');
    expect(newBcRecord(family('wall'), true, { wall_type: 'slip' }).wall_type).toBe('No-slip');
    // Families the defaults do not name keep their seed.
    expect(newBcRecord(family('pressure_outlet'), false, { wall_type: 'Slip' })).not.toHaveProperty('wall_type');
  });

  it('a seed is a copy, never the registry row itself', () => {
    const rec = newBcRecord(family('velocity_inlet'), false);
    (rec.vector as number[])[0] = 9;
    expect(newBcRecord(family('velocity_inlet'), false).vector).toEqual([0, 0, 1]);
  });
});

describe('value quantity', () => {
  it("is the family's first values row the record matches", () => {
    expect(valueQuantity({ bc_type: 'Velocity inlet' })).toEqual({ field: 'value', unit_field: 'unit', quantity: 'velocity' });
    expect(valueQuantity({ bc_type: 'Velocity inlet', velocity_type: 'Fixed' })?.quantity).toBe('velocity');
    expect(valueQuantity({ bc_type: 'Velocity inlet', velocity_type: 'Flow rate' })?.quantity).toBe('volumetric_flow');
    expect(
      valueQuantity({ bc_type: 'Velocity outlet', velocity_type: 'Flow rate', flow_rate_type: 'Volumetric flow' })?.quantity,
    ).toBe('volumetric_flow');
    expect(valueQuantity({ bc_type: 'Velocity inlet', velocity_type: 'Flow rate', flow_rate_type: 'Mass flow' })?.quantity).toBe(
      'mass_flow',
    );
    expect(valueQuantity({ bc_type: 'Pressure outlet' })?.quantity).toBe('pressure');
    expect(valueQuantity({ bc_type: 'Wall' })).toBeNull();
    expect(valueQuantity({ bc_type: 'Mirror plane' })).toBeNull();
    expect(valueQuantity({ bc_type: 'Symmetry' })).toBeNull();
    expect(valueQuantity({ bc_type: 'Mystery' })).toBeNull();
  });
});

describe('saved records', () => {
  it('fills blank fields from the schema and normalizes choices, as the BC routes store them', () => {
    expect(completeBcRecord({ bc_type: 'Wall', wall_type: 'slip' }, false).wall_type).toBe('Slip');
    expect(completeBcRecord({ bc_type: 'Wall' }, false).wall_type).toBe('No-slip');
    expect(completeBcRecord({ bc_type: 'Pressure', value: 'x' }, true)).toMatchObject({
      pressure_type: 'Fixed value',
      value: 0,
      unit: 'psi',
    });
    const v = completeBcRecord({ bc_type: 'Velocity inlet', velocity_type: 'Flow rate', value: 0.2, vector: ['1', 2] }, false);
    expect(v).toMatchObject({
      flow_rate_type: 'Volumetric flow',
      value: 0.2,
      unit: 'm³/s',
      direction: 'Normal to face',
      apply_per_face: true,
      vector: [1, 2, 0],
    });
  });

  it('keeps every field, and a record no plugin knows as it is', () => {
    expect(completeBcRecord({ bc_type: 'Wall', wall_type: 'No-slip', heat_flux_W_m2: 120.5 }, false).heat_flux_W_m2).toBe(120.5);
    const odd = { bc_type: 'Mystery', strength: 3 };
    expect(completeBcRecord(odd, false)).toBe(odd);
  });

  it("seeds a type change with the new family's fields", () => {
    // Pressure -> velocity: a Pa value is no velocity, so it starts on the seed.
    expect(typeChangeFields({ bc_type: 'Pressure', value: 250, unit: 'Pa' }, family('velocity_inlet'), false)).toMatchObject({
      velocity_type: 'Fixed',
      value: 5,
      unit: 'm/s',
      direction: 'Normal to face',
    });
    // Velocity -> pressure on an Imperial project.
    expect(typeChangeFields({ bc_type: 'Velocity inlet', value: 5, unit: 'ft/s' }, family('pressure_outlet'), true)).toMatchObject({
      pressure_type: 'Fixed value',
      value: 0,
      unit: 'psi',
    });
    // A value already in the right quantity is kept.
    const kept = typeChangeFields({ bc_type: 'Velocity inlet', value: 7, unit: 'm/s', velocity_type: 'Fixed' }, family('velocity_outlet'), false);
    expect(kept).not.toHaveProperty('value');
    // Wall: the default-family rule.
    expect(typeChangeFields({ bc_type: 'Pressure' }, family('wall'), false, { wall_type: 'No-slip' }).wall_type).toBe('Slip');
    expect(typeChangeFields({ bc_type: 'Pressure', wall_type: 'No-slip' }, family('wall'), false, { wall_type: 'No-slip' })).not.toHaveProperty(
      'wall_type',
    );
  });

  it('names the choice of the field the study defaults use', () => {
    expect(defaultsChoiceText({ bc_type: 'Wall', wall_type: 'slip' }, { wall_type: 'No-slip' })).toBe('Slip');
    expect(defaultsChoiceText({ bc_type: 'Wall' }, { wall_type: 'No-slip' })).toBe('No-slip');
    expect(defaultsChoiceText({ bc_type: 'Pressure' }, { wall_type: 'No-slip' })).toBe('');
    expect(defaultsChoiceText({ bc_type: 'Wall', wall_type: 'Slip' }, null)).toBe('');
  });
});
