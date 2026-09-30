import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Tree reads the test answers by hand, oldest first.
const pending: Array<{ resolve: (doc: unknown) => void; reject: (err: unknown) => void }> = [];
vi.mock('../api/client', () => ({
  apiGet: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))),
}));

import { apiGet } from '../api/client';
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

const reads = () => vi.mocked(apiGet).mock.calls.length;
const answer = (doc: unknown) =>
  act(async () => {
    pending.shift()?.resolve(doc);
  });
const fail = () =>
  act(async () => {
    pending.shift()?.reject(new Error('worker busy'));
  });
// What refreshSetupTree does, several times in one tick (a geometry or study switch).
const syncs = (n: number) =>
  act(() => {
    for (let i = 0; i < n; i++) window.dispatchEvent(new Event('cfd:tree-sync'));
  });
const treeText = () => document.getElementById('left-tree')?.textContent || '';

function mountTree(generation = 1) {
  const host = document.createElement('aside');
  host.id = 'left-tree';
  const ul = document.createElement('ul');
  ul.id = 'simulations-tree';
  host.appendChild(ul);
  document.body.appendChild(host);
  useProjectStore.setState({ projectId: 'p1', generation });
  render(<LeftTree />);
}

describe('LeftTree refresh', () => {
  afterEach(async () => {
    cleanup();
    // Answer what is still out, so the next test starts with no read in flight.
    for (let i = 0; i < 10 && pending.length; i++) await answer(tree([]));
    vi.mocked(apiGet).mockClear();
    document.body.innerHTML = '';
  });

  it('several syncs in one tick: one tree read at once, then exactly one follow-up', async () => {
    mountTree();
    expect(reads()).toBe(1);
    await answer(tree([]));
    // A switch syncs six times at once: the first sends, the rest wait for its answer.
    await syncs(6);
    expect(reads()).toBe(2);
    // Run 1 is made while that read is out, so its answer does not have it.
    await answer(tree([]));
    expect(reads()).toBe(3);
    expect(treeText()).not.toContain('Run 1');
    await answer(tree([{ id: 'r1', name: 'Run 1' }]));
    expect(reads()).toBe(3);
    expect(treeText()).toContain('Run 1');
  });

  it('syncs while a read is out send nothing until it lands, then one follow-up for all of them', async () => {
    mountTree();
    expect(reads()).toBe(1);
    await syncs(3);
    await syncs(2);
    expect(reads()).toBe(1);
    await answer(tree([]));
    expect(reads()).toBe(2);
    await answer(tree([{ id: 'r1', name: 'Run 1' }]));
    expect(reads()).toBe(2);
    expect(treeText()).toContain('Run 1');
  });

  it('an answer to a read sent before the project reloaded is not painted (the new run stays)', async () => {
    mountTree(1);
    expect(reads()).toBe(1);
    // The project reloads while that read is out: its answer may predate the reload.
    act(() => {
      useProjectStore.setState({ generation: 2 });
    });
    expect(reads()).toBe(1);
    await answer(tree([{ id: 'r0', name: 'Old run' }]));
    expect(treeText()).not.toContain('Old run');
    expect(reads()).toBe(2);
    await answer(tree([{ id: 'r1', name: 'Run 1' }]));
    expect(treeText()).toContain('Run 1');
    expect(treeText()).not.toContain('Old run');
  });

  it('a failed read does not stop the next one', async () => {
    mountTree();
    await answer(tree([{ id: 'r1', name: 'Run 1' }]));
    await syncs(1);
    expect(reads()).toBe(2);
    await fail();
    // The tree keeps what it had.
    expect(treeText()).toContain('Run 1');
    await syncs(1);
    expect(reads()).toBe(3);
    await answer(tree([{ id: 'r1', name: 'Run 1' }, { id: 'r2', name: 'Run 2' }]));
    expect(treeText()).toContain('Run 2');
  });
});
