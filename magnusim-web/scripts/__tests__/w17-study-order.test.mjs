import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assignStudyNames,
  mergeStudyOrder,
  persistStudyNames,
  sortStudies,
  stampStudyOrder,
} from '../w17-sim-catalog.js';

describe('study catalog order', () => {
  it('keeps catalog order after folders would sort alphabetically', () => {
    const walked = [
      { id: 'b', name: 'Inverse', folder: 'Inverse', dir: '/Inverse' },
      { id: 'a', name: 'Main', folder: 'Main', dir: '/Main' },
    ];
    const catalog = [
      { id: 'a', name: 'Main', sort_index: 0 },
      { id: 'b', name: 'Inverse', sort_index: 1 },
    ];
    assert.deepEqual(
      mergeStudyOrder(walked, catalog).map((s) => s.id),
      ['a', 'b']
    );
    assert.deepEqual(
      mergeStudyOrder(walked, catalog).map((s) => s.sort_index),
      [0, 1]
    );
  });

  it('appends studies that exist only on disk', () => {
    const walked = [
      { id: 'a', name: 'Main', folder: 'Main', dir: '/Main' },
      { id: 'c', name: 'New', folder: 'New', dir: '/New' },
    ];
    const catalog = [{ id: 'a', name: 'Main' }];
    assert.deepEqual(
      mergeStudyOrder(walked, catalog).map((s) => s.id),
      ['a', 'c']
    );
  });

  it('sorts by sort_index even when names are alphabetical the other way', () => {
    const rows = [
      { id: 'b', name: 'Inverse', sort_index: 1 },
      { id: 'a', name: 'Main', sort_index: 0 },
    ];
    assert.deepEqual(sortStudies(rows).map((s) => s.id), ['a', 'b']);
    assert.deepEqual(stampStudyOrder(rows).map((s) => s.id), ['a', 'b']);
  });

  it('keeps a typed default-style name when only one study remains', () => {
    const rows = [
      {
        id: 'sim-2',
        name: 'Incompressible Steady-state 1',
        geometry_id: 'g1',
        time_dependency: 'Steady-state',
      },
    ];
    assert.deepEqual(
      persistStudyNames(rows).map((s) => s.name),
      ['Incompressible Steady-state 1']
    );
    assert.deepEqual(
      assignStudyNames(rows).map((s) => s.name),
      ['Incompressible Steady-state']
    );
  });

  it('numbers new default studies only at create time', () => {
    const rows = [
      { id: 'a', name: 'Incompressible Steady-state', geometry_id: 'g1', time_dependency: 'Steady-state' },
      { id: 'b', name: 'Incompressible Steady-state', geometry_id: 'g1', time_dependency: 'Steady-state' },
    ];
    assert.deepEqual(assignStudyNames(rows).map((s) => s.name), [
      'Incompressible Steady-state 1',
      'Incompressible Steady-state 2',
    ]);
  });

  it('reindex writes a new explicit order', () => {
    const rows = [
      { id: 'b', name: 'Inverse', sort_index: 0 },
      { id: 'a', name: 'Main', sort_index: 1 },
    ];
    assert.deepEqual(
      stampStudyOrder(rows, true).map((s) => [s.id, s.sort_index]),
      [
        ['b', 0],
        ['a', 1],
      ]
    );
  });
});
