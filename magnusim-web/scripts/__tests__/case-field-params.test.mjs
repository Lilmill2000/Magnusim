import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  caseResultFieldRows,
  caseShownFields,
  cutParamsFromUrl,
  fieldListParam,
  inspectParamsFromUrl,
  isoParamsFromUrl,
  isoVolParamsFromUrl,
  legacyFieldName,
  popParamsFromUrl,
  ptParamsFromUrl,
} from '../vite-plugin-case-fields.js';

// Results tools take field names (a scalar by its name, a vector X as magX).
// The page still sends labels for the iso and plot pickers; those map to names
// in one place, and '' stays '' so the tool shows the case's default field.
const url = (query) => new URL(`http://127.0.0.1/api/x?${new URLSearchParams(query)}`);

describe('case field request parameters', () => {
  it('passes field names through', () => {
    const iso = isoParamsFromUrl(url({ iso_field: 'T', color_field: 'magW', vector: 'W', iso_value: '300' }));
    assert.deepEqual([iso.iso_field, iso.color_field, iso.vector, iso.iso_value], ['T', 'magW', 'W', 300]);
    const iv = isoVolParamsFromUrl(url({ iso_field: 'k', color_field: 'T' }));
    assert.deepEqual([iv.iso_field, iv.color_field, iv.vector], ['k', 'T', '']);
    assert.equal(popParamsFromUrl(url({ field: 'T', points: '0,0,0;1,0,0' })).field, 'T');
    const cut = cutParamsFromUrl(url({ field: 'T', vector: 'W', extra: 'k,../x,magW,k' }));
    assert.deepEqual([cut.field, cut.vector, cut.extra], ['T', 'W', ['k', 'magW']]);
    assert.deepEqual(inspectParamsFromUrl(url({ x: '1', y: '2', z: '3', fields: 'T;magW' })).fields, ['T', 'magW']);
    const pt = ptParamsFromUrl(url({ vector: 'W', coloring: 'T' }));
    assert.deepEqual([pt.vector, pt.coloring], ['W', 'T']);
  });

  it('maps the legacy labels the page sends', () => {
    const iso = isoParamsFromUrl(url({ iso_scalar: 'Velocity Magnitude', coloring: 'Pressure' }));
    assert.deepEqual([iso.iso_field, iso.color_field], ['magU', 'p']);
    const iv = isoVolParamsFromUrl(url({ isoScalar: 'Pressure', coloring: 'Velocity Magnitude' }));
    assert.deepEqual([iv.iso_field, iv.color_field], ['p', 'magU']);
    assert.equal(popParamsFromUrl(url({ field_variable: 'Pressure' })).field, 'p');
    assert.equal(popParamsFromUrl(url({ fieldVariable: 'Velocity Magnitude' })).field, 'magU');
    // A name in the new parameter wins over a label in the old one.
    assert.equal(isoParamsFromUrl(url({ iso_field: 'T', iso_scalar: 'Pressure' })).iso_field, 'T');
    assert.equal(legacyFieldName('pressure'), 'p');
    assert.equal(legacyFieldName('T'), 'T');
  });

  it("keeps '' as '' and drops what is not a name", () => {
    const iso = isoParamsFromUrl(url({}));
    assert.deepEqual([iso.iso_field, iso.color_field, iso.vector], ['', '', '']);
    assert.equal(popParamsFromUrl(url({ field: '' })).field, '');
    // No extra parameter is null (the slice keeps every scalar); an empty one is [].
    const cut = cutParamsFromUrl(url({ field: '' }));
    assert.deepEqual([cut.field, cut.vector, cut.extra], ['', '', null]);
    assert.deepEqual(cutParamsFromUrl(url({ field: 'magU', extra: '' })).extra, []);
    assert.equal(isoParamsFromUrl(url({ coloring: 'Solid color' })).color_field, '');
    assert.equal(cutParamsFromUrl(url({ field: '../p' })).field, '');
    assert.deepEqual(inspectParamsFromUrl(url({ x: '0', y: '0', z: '0' })).fields, []);
    const pt = ptParamsFromUrl(url({ seeds_h: '4' }));
    assert.deepEqual([pt.vector, pt.coloring, pt.seeds_h], ['', '', 4]);
    assert.deepEqual(fieldListParam(''), []);
  });
});

describe('case shown fields', () => {
  const foam = (dir, name, cls) =>
    writeFileSync(join(dir, name), ['FoamFile', '{', `    class       ${cls};`, `    object      ${name};`, '}', 'internalField uniform 0;', ''].join('\n'));

  it('lists scalars by name and vectors as magX, never tensors, face fields or old times', () => {
    const root = mkdtempSync(join(tmpdir(), 'case-fields-'));
    try {
      const t = join(root, '100');
      mkdirSync(join(t, 'uniform'), { recursive: true });
      foam(t, 'U', 'volVectorField');
      foam(t, 'p', 'volScalarField');
      foam(t, 'k', 'volScalarField');
      foam(t, 'phi', 'surfaceScalarField');
      foam(t, 'R', 'volSymmTensorField');
      foam(t, 'U_0', 'volVectorField');
      assert.deepEqual(caseShownFields(root, '100'), ['magU', 'k', 'p']);
      assert.deepEqual(caseShownFields(root, '7'), []);
      // No sidecar, or one without result_fields: null.
      assert.equal(caseResultFieldRows(root), null);
      writeFileSync(join(root, 'w27-case.json'), JSON.stringify({ kinematic_fields: [] }));
      assert.equal(caseResultFieldRows(root), null);
      writeFileSync(
        join(root, 'w27-case.json'),
        JSON.stringify({
          result_fields: [
            { key: 'T', kind: 'Scalar', unit_quantity: 'Temperature', label: 'Temperature', unit: 'K' },
            '../x',
            'W',
            { key: 'q', unit: ['a', 'b'].join(String.fromCharCode(10)) },
          ],
        }),
      );
      assert.deepEqual(caseResultFieldRows(root), [
        { key: 'T', kind: 'scalar', unit_quantity: 'temperature', label: 'Temperature', unit: 'K', magnitude_label: '' },
        { key: 'W', kind: '', unit_quantity: '', label: '', unit: '', magnitude_label: '' },
        { key: 'q', kind: '', unit_quantity: '', label: '', unit: '', magnitude_label: '' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
