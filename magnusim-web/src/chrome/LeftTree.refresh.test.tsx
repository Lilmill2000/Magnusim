import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Two tree reads in flight: the older (sent before Run 1 existed) answers last.
const pending: Array<(doc: unknown) => void> = [];
vi.mock('../api/client', () => ({
  apiGet: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
}));

import { LeftTree } from './LeftTree';
import { useProjectStore } from '../store/project';

const tree = (runs: Array<{ id: string; name: string }>) => ({
  project_id: 'p1',
  geometries: [
    {
      id: 'g1',
      name: 'cube',
      bodies: ['Body1'],
      studies: [{ id: 's1', name: 'Study', geometry_id: 'g1', active: true, meshes: [], runs }],
    },
  ],
});

describe('LeftTree refresh', () => {
  afterEach(() => {
    pending.length = 0;
    document.body.innerHTML = '';
  });

  it('a slow older tree read does not replace a newer one (the new run stays)', async () => {
    const host = document.createElement('aside');
    host.id = 'left-tree';
    const ul = document.createElement('ul');
    ul.id = 'simulations-tree';
    host.appendChild(ul);
    document.body.appendChild(host);
    useProjectStore.setState({ projectId: 'p1', generation: 1 });
    render(<LeftTree />);
    // First read goes out on mount; a second after the run is created.
    act(() => {
      window.dispatchEvent(new Event('cfd:tree-sync'));
    });
    expect(pending.length).toBe(2);
    await act(async () => {
      pending[1](tree([{ id: 'r1', name: 'Run 1' }]));
    });
    expect(document.getElementById('left-tree')?.textContent).toContain('Run 1');
    await act(async () => {
      pending[0](tree([]));
    });
    expect(document.getElementById('left-tree')?.textContent).toContain('Run 1');
  });
});
