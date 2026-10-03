// Rename validation: feature and body names, parameter names.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkItemName, checkParamName } from '../../src/ui/tree/names';

const features = [
  { id: 'f1', name: 'Extrude 1' },
  { id: 'f2', name: 'Sketch 1' },
];

describe('feature and body names', () => {
  it('accepts a new name, trimmed', () => {
    expect(checkItemName('  Base plate  ', features, 'f1', 'feature')).toEqual({ ok: true, name: 'Base plate' });
    expect(checkItemName('extrude 1 (copy)', features, 'f2', 'feature')).toEqual({ ok: true, name: 'extrude 1 (copy)' });
  });

  it('reports an unchanged name as the same', () => {
    expect(checkItemName('Extrude 1', features, 'f1', 'feature')).toEqual({ ok: 'same' });
    expect(checkItemName(' Extrude 1 ', features, 'f1', 'feature')).toEqual({ ok: 'same' });
  });

  it('refuses empty, too long, control characters and duplicates (ignoring case)', () => {
    expect(checkItemName('   ', features, 'f1', 'feature')).toEqual({ ok: false, reason: 'Enter a name' });
    expect(checkItemName('x'.repeat(65), features, 'f1', 'feature')).toEqual({ ok: false, reason: 'Use 64 characters or fewer' });
    expect(checkItemName('x'.repeat(64), features, 'f1', 'feature').ok).toBe(true);
    expect(checkItemName('a\tb', features, 'f1', 'feature')).toEqual({ ok: false, reason: 'Names cannot contain tabs or line breaks' });
    expect(checkItemName('SKETCH 1', features, 'f1', 'feature')).toEqual({ ok: false, reason: 'A feature named "Sketch 1" already exists' });
    expect(checkItemName('body 2', [{ id: 'b1', name: 'Body 1' }, { id: 'b2', name: 'Body 2' }], 'b1', 'body')).toEqual({
      ok: false,
      reason: 'A body named "Body 2" already exists',
    });
  });

  it('lets a name change only its case', () => {
    expect(checkItemName('BOX 1', features, 'f1', 'feature')).toEqual({ ok: true, name: 'BOX 1' });
  });
});

describe('parameter names', () => {
  const params = [
    { id: 'p1', name: 'width' },
    { id: 'p2', name: 'Depth_2' },
  ];

  it('accepts identifiers', () => {
    expect(checkParamName('height', params, null)).toEqual({ ok: true, name: 'height' });
    expect(checkParamName('_h2', params, null)).toEqual({ ok: true, name: '_h2' });
    expect(checkParamName(' wall_t ', params, null)).toEqual({ ok: true, name: 'wall_t' });
  });

  it('refuses what an expression could not use as a name (the document\'s own rule)', () => {
    expect(checkParamName('', params, null)).toEqual({ ok: false, reason: 'Enter a name' });
    expect(checkParamName('   ', params, null)).toEqual({ ok: false, reason: 'Enter a name' });
    for (const bad of ['2x', 'wall t', 'a-b', 'é', 'w.1']) {
      expect(checkParamName(bad, params, null)).toEqual({ ok: false, reason: 'A name starts with a letter or _ and has only letters, digits and _' });
    }
    for (const reserved of ['mm', 'IN', 'deg', 'rad', 'sqrt', 'Sin', 'max', 'pi', 'PI']) {
      expect(checkParamName(reserved, params, null)).toEqual({ ok: false, reason: `"${reserved}" is a unit or function name` });
    }
    expect(checkParamName('x'.repeat(65), params, null)).toEqual({ ok: false, reason: 'A name can have at most 64 characters' });
  });

  it('refuses duplicates ignoring case, but not the parameter itself', () => {
    expect(checkParamName('WIDTH', params, null)).toEqual({ ok: false, reason: 'A parameter named "width" already exists' });
    expect(checkParamName('depth_2', params, 'p1')).toEqual({ ok: false, reason: 'A parameter named "Depth_2" already exists' });
    expect(checkParamName('width', params, 'p1')).toEqual({ ok: 'same' });
    expect(checkParamName('Width', params, 'p1')).toEqual({ ok: true, name: 'Width' });
  });
});
