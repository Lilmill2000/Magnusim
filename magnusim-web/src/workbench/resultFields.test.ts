import { describe, expect, it } from 'vitest';
import {
  defaultResultField,
  fieldInfoIn,
  normalizeFilterSet,
  resultRowsFor,
  rowShownName,
  toolOptions,
  velocityVectorName,
} from './resultFields';

// The Incompressible Flow analysis's rows as registry.describe publishes them (API 1.4).
const ifRow = {
  result_fields: [
    { key: 'U', label: 'Velocity', unit_quantity: 'velocity', kind: 'vector', unit: '', magnitude_label: '', shown: 'magU' },
    { key: 'p', label: 'Pressure', unit_quantity: 'pressure', kind: 'scalar', unit: '', magnitude_label: '', shown: 'p' },
    { key: 'k', label: 'Turbulent kinetic energy', unit_quantity: 'specific_energy', kind: 'scalar', unit: '', magnitude_label: '', shown: 'k' },
    { key: 'omega', label: 'Specific dissipation rate', unit_quantity: 'specific_dissipation_rate', kind: 'scalar', unit: '', magnitude_label: '', shown: 'omega' },
    { key: 'R', label: 'Reynolds stress', unit_quantity: 'specific_energy', kind: 'symm_tensor', unit: '', magnitude_label: '', shown: null },
  ],
};
const tRow = {
  result_fields: [{ key: 'T', label: 'Temperature', unit_quantity: 'temperature', kind: 'scalar', unit: 'K', magnitude_label: '', shown: 'T' }],
};

const labelled = (fields: ReturnType<typeof resultRowsFor>) => fields.map((f) => [f.name, f.label, f.unit]);

describe('result fields a results tool lists', () => {
  it('lists an Incompressible Flow run by what its frame wrote, with units', () => {
    const fields = resultRowsFor({ runRow: ifRow, defaultRow: ifRow, wrote: ['magU', 'p'] });
    expect(labelled(fields)).toEqual([
      ['magU', 'Velocity Magnitude', 'm/s'],
      ['p', 'Pressure', 'Pa'],
    ]);
  });

  it('hides what a laminar run did not write, and never a tensor or the face flux', () => {
    const fields = resultRowsFor({ runRow: ifRow, wrote: ['magU', 'p', 'phi'] });
    expect(fields.map((f) => f.name)).toEqual(['magU', 'p']);
    const turbulent = resultRowsFor({ runRow: ifRow, wrote: ['k', 'magU', 'omega', 'p', 'nuTilda'] });
    expect(labelled(turbulent)).toEqual([
      ['magU', 'Velocity Magnitude', 'm/s'],
      ['p', 'Pressure', 'Pa'],
      ['k', 'Turbulent kinetic energy', 'm²/s²'],
      ['omega', 'Specific dissipation rate', '1/s'],
    ]);
  });

  it('keeps every row while the frame is not known yet', () => {
    expect(resultRowsFor({ runRow: ifRow }).map((f) => f.name)).toEqual(['magU', 'p', 'k', 'omega']);
  });

  it('shows a T-only plugin case with no rows of its own by name', () => {
    const fields = resultRowsFor({ caseRows: null, runRow: null, defaultRow: ifRow, wrote: ['T'] });
    expect(labelled(fields)).toEqual([['T', 'T', '']]);
    expect(velocityVectorName(fields)).toBe('');
  });

  it('takes the case rows over the run row, and the run row over the default', () => {
    const caseRows = [{ key: 'T', kind: 'scalar', unit_quantity: 'temperature', label: 'Temperature', unit: 'K', magnitude_label: '' }];
    expect(labelled(resultRowsFor({ caseRows, runRow: ifRow, defaultRow: ifRow, wrote: ['T', 'magU', 'p'] }))).toEqual([
      ['T', 'Temperature', 'K'],
    ]);
    expect(labelled(resultRowsFor({ runRow: tRow, defaultRow: ifRow, wrote: ['T', 'magU'] }))).toEqual([['T', 'Temperature', 'K']]);
    // An empty case list is still the case's own: nothing else is listed.
    expect(resultRowsFor({ caseRows: [], runRow: ifRow, wrote: ['magU'] })).toEqual([]);
  });

  it('reads a sidecar vector row that does not say its kind from the frame', () => {
    const caseRows = [{ key: 'W', kind: '', unit_quantity: 'velocity', label: 'Wind', unit: '', magnitude_label: '' }];
    expect(rowShownName(caseRows[0], ['magW'])).toBe('magW');
    const fields = resultRowsFor({ caseRows, wrote: ['magW'] });
    expect(labelled(fields)).toEqual([['magW', 'Wind Magnitude', 'm/s']]);
    expect(velocityVectorName(fields)).toBe('W');
  });

  it('finds the velocity vector the frame wrote', () => {
    expect(velocityVectorName(resultRowsFor({ runRow: ifRow, wrote: ['magU', 'p'] }))).toBe('U');
    expect(velocityVectorName(resultRowsFor({ runRow: ifRow, wrote: ['p'] }))).toBe('');
    const other = { result_fields: [{ key: 'B', label: 'Field', unit_quantity: 'magnetic', kind: 'vector', unit: 'T', magnitude_label: '', shown: 'magB' }] };
    expect(velocityVectorName(resultRowsFor({ runRow: other, wrote: ['magB'] }))).toBe('');
  });

  it('picks the default field and builds picker options', () => {
    const fields = resultRowsFor({ runRow: ifRow, wrote: ['magU', 'p'] });
    expect(defaultResultField(fields, 'p')).toBe('p');
    expect(defaultResultField(fields, 'k')).toBe('magU');
    expect(defaultResultField(fields, '')).toBe('magU');
    expect(defaultResultField([], 'p')).toBe('');
    expect(toolOptions(fields)).toEqual([
      { value: 'magU', label: 'Velocity Magnitude' },
      { value: 'p', label: 'Pressure' },
    ]);
    expect(toolOptions(fields, { solid: 'Solid color' }).at(-1)).toEqual({ value: 'solid', label: 'Solid color' });
    expect(fieldInfoIn(fields, 'p')).toEqual({ name: 'p', label: 'Pressure', unit: 'Pa' });
    expect(fieldInfoIn(fields, 'T')).toEqual({ name: 'T', label: 'T', unit: '' });
  });
});

describe('a saved view on the fields a case shows', () => {
  const view = (field: string, coloring = 'magU') => ({
    v: 1,
    field,
    parts: { on: true, style: 'field', opacity: 1 },
    planes: [],
    pt: { open: false, coloring },
    scale: { magU: { bounds: { lo: 0, hi: 2 } }, p: null },
  });

  it('keeps magU, p and T views unchanged', () => {
    expect(normalizeFilterSet(view('magU'), ['magU', 'p'])).toEqual(view('magU'));
    expect(normalizeFilterSet(view('p', 'p'), ['magU', 'p', 'k'])).toEqual(view('p', 'p'));
    const t = { ...view('T', 'solid'), scale: { T: { lo: 290, hi: 310 } } };
    expect(normalizeFilterSet(t, ['T'])).toEqual(t);
  });

  it('maps a field the case does not show to its default', () => {
    const out = normalizeFilterSet(view('k', 'k'), ['magU', 'p']);
    expect([out.field, out.pt.coloring]).toEqual(['magU', 'magU']);
    expect(normalizeFilterSet(view('../x'), ['T']).field).toBe('T');
  });

  it('keeps only plain names in the colour scales, and nothing changes before the list is known', () => {
    const odd = { ...view('magU'), scale: { magU: { lo: 0, hi: 1 }, '../x': { lo: 0, hi: 1 } } };
    expect(Object.keys(normalizeFilterSet(odd, ['magU']).scale)).toEqual(['magU']);
    expect(normalizeFilterSet(view('k'), [])).toEqual(view('k'));
    expect(normalizeFilterSet({ ...view('cellVolume') }, ['magU']).field).toBe('cellVolume');
  });
});
