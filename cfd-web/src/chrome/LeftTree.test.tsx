import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeftTree, SetupTreeView } from './LeftTree';
import type { SetupTreeModel } from './treeModel';

const fixture: SetupTreeModel = {
  selectedKey: null,
  geoms: [
    {
      id: 'g1',
      name: 'Elbow',
      bodies: ['Body1'],
      studies: [
        {
          id: 's1',
          name: 'Elbow',
          geometryId: 'g1',
          active: true,
          meshes: [{ id: 'mesh_1', name: 'Mesh 1', ready: false }],
          materialsAssigned: false,
          materialVolumes: [],
          bcs: [],
          wallDefault: 'No-slip',
          runs: [],
        },
      ],
    },
  ],
};

describe('LeftTree', () => {
  it('marks the setup tree host', () => {
    const host = document.createElement('aside');
    host.id = 'left-tree';
    const tree = document.createElement('ul');
    tree.id = 'simulations-tree';
    host.appendChild(tree);
    document.body.appendChild(host);
    render(<LeftTree />);
    expect(document.getElementById('left-tree')?.getAttribute('data-react-tree')).toBe('1');
  });

  it('opens the mesh form via [data-w20-mesh-item]', () => {
    render(
      <ul>
        <SetupTreeView model={fixture} />
      </ul>,
    );
    const item = document.querySelector('[data-w20-mesh-item="mesh_1"]');
    expect(item).toBeTruthy();
    expect(screen.getByText('Mesh 1')).toBeInTheDocument();
    expect(item?.getAttribute('data-label')).toBe('mesh:mesh_1');
    const refs = document.querySelector('[data-w26-refs="1"][data-w26-refs-mesh="mesh_1"]');
    expect(refs).toBeTruthy();
    expect(refs?.querySelector('[data-refs-plus="mesh_1"]')).toBeTruthy();
  });

  it('renders the full tree for an inactive study', () => {
    const two: SetupTreeModel = {
      selectedKey: null,
      geoms: [
        {
          id: 'g1',
          name: 'Part',
          bodies: ['Body1'],
          studies: [
            {
              id: 's1',
              name: 'Incompressible Steady-state 1',
              geometryId: 'g1',
              active: false,
              meshes: [{ id: 'mesh_a', name: 'Mesh 1', ready: true }],
              materialsAssigned: true,
              materialVolumes: ['Body1'],
              bcs: [{ id: 'bc1', name: 'Pressure 1', faces: ['face 10@Body1'] }],
              wallDefault: 'Slip',
              runs: [{ id: 'run1', name: 'Run 1', meshId: 'mesh_a', meshName: 'Mesh 1', ready: true }],
            },
            {
              id: 's2',
              name: 'Incompressible Steady-state 2',
              geometryId: 'g1',
              active: true,
              meshes: [{ id: 'mesh_b', name: 'Mesh 1', ready: false }],
              materialsAssigned: true,
              materialVolumes: ['Body1'],
              bcs: [{ id: 'bc2', name: 'Pressure 2', faces: [] }],
              wallDefault: 'Slip',
              runs: [],
            },
          ],
        },
      ],
    };
    render(
      <ul>
        <SetupTreeView model={two} />
      </ul>,
    );
    expect(document.querySelector('[data-w17-sim-id="s1"] [data-w20-mesh-item="mesh_a"]')).toBeTruthy();
    expect(document.querySelector('[data-w17-sim-id="s1"] [data-w19-bc="bc1"]')).toBeTruthy();
    expect(document.querySelector('[data-w17-sim-id="s1"] [data-w27-run="run1"]')).toBeTruthy();
    expect(document.querySelector('[data-w17-sim-id="s1"] [data-w27-run-results="run1"]')).toBeTruthy();
    expect(document.querySelector('[data-w28-key="media:run:run1:screenshot"]')).toBeTruthy();
    expect(document.querySelector('[data-w28-key="media:run:run1:graphs"]')).toBeTruthy();
    expect(document.querySelector('[data-w28-key="media:mesh:mesh_a:recording"]')).toBeTruthy();
    expect(document.querySelector('[data-w17-sim-id="s2"] [data-w19-bc="bc2"]')).toBeTruthy();
    expect(document.querySelector('[data-w17-sim-id="s1"] [data-w20-mesh="1"]')?.getAttribute('data-label')).toBe(
      'Mesh:s1',
    );
    expect(document.querySelector('[data-w17-sim-id="s2"] [data-w20-mesh="1"]')?.getAttribute('data-label')).toBe(
      'Mesh:s2',
    );
    expect(document.querySelector('[data-w17-sim-id="s1"] [data-w26-refs="1"]')).toBeTruthy();
    expect(document.querySelector('[data-w17-sim-id="s1"] [data-refs-plus="mesh_a"]')).toBeTruthy();
    expect(document.querySelector('[data-w17-sim-id="s1"] .bc-plus')).toBeTruthy();
    expect(document.querySelector('[data-w17-sim-id="s2"] .bc-plus')).toBeTruthy();
    expect(document.getElementById('btn-bcs-plus')?.closest('[data-w17-sim-id]')?.getAttribute('data-w17-sim-id')).toBe(
      's2',
    );
  });

  it('renders refinement children and the hub click hook', () => {
    const withRefs: SetupTreeModel = {
      ...fixture,
      selectedKey: 'refs:mesh_1',
      geoms: [
        {
          ...fixture.geoms[0],
          studies: [
            {
              ...fixture.geoms[0].studies[0],
              meshes: [
                {
                  id: 'mesh_1',
                  name: 'Mesh 1',
                  ready: false,
                  refinements: [{ id: 'ref_1', name: 'Surface custom sizing 1', faces: ['face 1@Body1'] }],
                },
              ],
            },
          ],
        },
      ],
    };
    render(
      <ul>
        <SetupTreeView model={withRefs} />
      </ul>,
    );
    expect(document.querySelector('[data-w26-refs="1"][data-w26-refs-mesh="mesh_1"]')).toBeTruthy();
    expect(document.querySelector('[data-w26-ref="ref_1"]')).toBeTruthy();
    expect(document.querySelector('[data-w26-face="face 1@Body1"][data-w26-parent="ref_1"]')).toBeTruthy();
  });

  it('shows a spinner on a generating mesh and a queue number on a waiting run', () => {
    const live: SetupTreeModel = {
      ...fixture,
      geoms: [
        {
          ...fixture.geoms[0],
          studies: [
            {
              ...fixture.geoms[0].studies[0],
              meshes: [
                { id: 'mesh_1', name: 'Mesh 1', ready: true },
                { id: 'mesh_2', name: 'Mesh 2', ready: false, busy: true },
              ],
              runs: [{ id: 'run1', name: 'Run 1', meshId: 'mesh_1', meshName: 'Mesh 1', ready: false, queuePos: 1 }],
            },
          ],
        },
      ],
    };
    render(
      <ul>
        <SetupTreeView model={live} />
      </ul>,
    );
    const mesh2 = document.querySelector('[data-w20-mesh-item="mesh_2"]');
    const run1 = document.querySelector('[data-w27-run="run1"]');
    expect(mesh2?.querySelector(':scope > .tree-row .tree-spin')).toBeTruthy();
    expect(mesh2?.querySelector(':scope > .tree-row .tree-check')).toBeFalsy();
    expect(run1?.querySelector(':scope > .tree-row .tree-queue')?.textContent).toBe('1');
    expect(document.querySelector('[data-w20-mesh-item="mesh_1"] > .tree-row .tree-check')).toBeTruthy();
  });

  it('shows Results on a running run that already has frames', () => {
    const live: SetupTreeModel = {
      ...fixture,
      geoms: [
        {
          ...fixture.geoms[0],
          studies: [
            {
              ...fixture.geoms[0].studies[0],
              runs: [
                {
                  id: 'run1',
                  name: 'Run 1',
                  meshId: 'mesh_1',
                  meshName: 'Mesh 1',
                  ready: false,
                  hasResults: true,
                  busy: true,
                },
              ],
            },
          ],
        },
      ],
    };
    render(
      <ul>
        <SetupTreeView model={live} />
      </ul>,
    );
    expect(document.querySelector('[data-w27-run-results="run1"]')).toBeTruthy();
    expect(document.querySelector('[data-w27-run="run1"] > .tree-row .tree-check')).toBeFalsy();
    expect(document.querySelector('[data-w27-run="run1"] > .tree-row .tree-spin')).toBeTruthy();
  });
});
