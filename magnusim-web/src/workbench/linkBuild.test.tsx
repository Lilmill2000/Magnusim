// Build stamps on a linked geometry as the user sees them (host API 1.5, LINK proposal
// 5.15, D26; L2 step 3): "Out of date" on a mesh made from an older version of its
// geometry and the mesh panel's line; "Older geometry" on a run started on one, and the
// line its run panel and particle trace show.
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupTreeView } from '../chrome/LeftTree';
import { readSetupTree, type ProjectTreeDoc } from '../chrome/treeModel';
import { meshOutOfDateOf, outOfDateLine } from '../panels/mesh/MeshPanel';
import { OLDER_RUN_TEXT, noteTreeGeometries, resetGeometryRevForTests, runOlderGeometry } from './geometryRev';

beforeEach(() => resetGeometryRevForTests());
afterEach(() => vi.unstubAllGlobals());

const DOC: ProjectTreeDoc = {
  project_id: 'p1',
  geometries: [
    {
      id: 'g1',
      name: 'Demo 1',
      key: 'p:p1/g:g1',
      bodies: ['Body1'],
      rev: 3,
      studies: [
        {
          id: 's1',
          name: 'Study 1',
          geometry_id: 'g1',
          key: 'p:p1/g:g1/s:s1',
          meshes: [
            { id: 'm-old', name: 'Mesh 1', key: 'p:p1/g:g1/s:s1/m:m-old', generated: true, live_status: 'done', n_cells: 8, case_dir: 'c', out_of_date: true },
            { id: 'm-new', name: 'Mesh 2', key: 'p:p1/g:g1/s:s1/m:m-new', generated: true, live_status: 'done', n_cells: 8, case_dir: 'c', out_of_date: false },
          ],
          runs: [
            { id: 'r-old', name: 'Run 1', key: 'p:p1/g:g1/s:s1/r:r-old', status: 'done', older_geometry: true },
            { id: 'r-new', name: 'Run 2', key: 'p:p1/g:g1/s:s1/r:r-new', status: 'done', older_geometry: false },
          ],
        },
      ],
    },
  ],
} as unknown as ProjectTreeDoc;

describe('the tree', () => {
  it('shows "Out of date" on a mesh made from an older version and "Older geometry" on a run started on one, on no other', () => {
    const model = readSetupTree(DOC);
    const study = model.geoms[0].studies[0];
    expect(study.meshes.map((m) => [m.id, !!m.outOfDate])).toEqual([
      ['m-old', true],
      ['m-new', false],
    ]);
    expect(study.runs.map((r) => [r.id, !!r.olderGeometry])).toEqual([
      ['r-old', true],
      ['r-new', false],
    ]);
    const { container } = render(
      <ul>
        <SetupTreeView model={model} />
      </ul>,
    );
    const outOfDate = container.querySelectorAll('[data-mesh-out-of-date]');
    expect([...outOfDate].map((el) => el.closest('[data-w20-mesh-item]')?.getAttribute('data-w20-mesh-item'))).toEqual(['m-old']);
    expect(outOfDate[0].textContent).toBe('Out of date');
    const older = container.querySelectorAll('[data-run-older-geometry]');
    expect([...older].map((el) => el.closest('[data-w27-run]')?.getAttribute('data-w27-run'))).toEqual(['r-old']);
    expect(older[0].textContent).toBe('Older geometry');
  });
});

describe('the mesh panel', () => {
  it('says "Out of date: made from an older version of <Geometry>. Generate it again." for that mesh only', () => {
    const geoms = DOC.geometries as unknown as Parameters<typeof meshOutOfDateOf>[0];
    expect(meshOutOfDateOf(geoms, 'm-old')).toBe('Demo 1');
    expect(meshOutOfDateOf(geoms, 'm-new')).toBeNull();
    expect(meshOutOfDateOf(geoms, 'nope')).toBeNull();
    expect(outOfDateLine('Demo 1')).toBe('Out of date: made from an older version of Demo 1. Generate it again.');
  });
});

describe('runs on an older geometry (D26)', () => {
  it("each tree read says which runs were started on an older version, with the geometry's name for their line", () => {
    noteTreeGeometries('p1', DOC.geometries as unknown as Parameters<typeof noteTreeGeometries>[1]);
    expect(runOlderGeometry('r-old')).toBe('Demo 1');
    expect(runOlderGeometry('r-new')).toBeNull();
    expect(OLDER_RUN_TEXT('Demo 1')).toBe('This run was made on an older version of Demo 1. Face seeds and highlights are off for it.');
    // The next read is the truth: a run regenerated or deleted is no longer listed.
    noteTreeGeometries('p1', [{ id: 'g1', name: 'Demo 1', rev: 3, studies: [{ runs: [{ id: 'r-old', older_geometry: false }] }] }]);
    expect(runOlderGeometry('r-old')).toBeNull();
  });
});
