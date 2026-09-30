import { afterEach, describe, expect, it, vi } from 'vitest';

const pending: Array<(doc: unknown) => void> = [];
vi.mock('../api/client', () => ({
  apiGet: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
}));

import { apiGet } from '../api/client';
import { followProjectTree, onProjectTree, readProjectTree, type TreeAnswer } from './treeFeed';

const reads = () => vi.mocked(apiGet).mock.calls;
const answer = async (doc: unknown) => {
  pending.shift()?.(doc);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
const sync = () => window.dispatchEvent(new Event('cfd:tree-sync'));

describe('treeFeed', () => {
  afterEach(async () => {
    for (let i = 0; i < 10 && pending.length; i++) await answer({});
    vi.mocked(apiGet).mockClear();
  });

  it('a sync reads each watched project once, however many readers it has', async () => {
    const heardA: TreeAnswer[] = [];
    const heardB: TreeAnswer[] = [];
    const stopA = onProjectTree('p1', (a) => heardA.push(a));
    const stopB = onProjectTree('p1', (a) => heardB.push(a));
    const stopC = onProjectTree('p2', () => undefined);
    sync();
    expect(reads().map((c) => c[1])).toEqual([{ project_id: 'p1' }, { project_id: 'p2' }]);
    await answer({ project_id: 'p1' });
    expect(heardA.map((a) => a.doc)).toEqual([{ project_id: 'p1' }]);
    expect(heardB.map((a) => a.doc)).toEqual([{ project_id: 'p1' }]);
    stopA();
    stopB();
    stopC();
    // Nobody reads p1 now: a sync sends nothing for it.
    await answer({ project_id: 'p2' });
    sync();
    expect(reads()).toHaveLength(2);
  });

  it('a reader that starts while a request is out hears the follow-up, not that answer', async () => {
    const early: TreeAnswer[] = [];
    const late: TreeAnswer[] = [];
    const stopEarly = onProjectTree('p1', (a) => early.push(a));
    readProjectTree('p1');
    const stopLate = onProjectTree('p1', (a) => late.push(a));
    readProjectTree('p1');
    expect(reads()).toHaveLength(1);
    await answer({ n: 1 });
    expect(reads()).toHaveLength(2);
    await answer({ n: 2 });
    expect(early.map((a) => a.doc)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(late.map((a) => a.doc)).toEqual([{ n: 2 }]);
    expect(early[1].seq).toBeGreaterThan(early[0].seq);
    stopEarly();
    stopLate();
  });

  it('a follower joins the request that is out, or sends one: never a follow-up read of its own', async () => {
    const tree: TreeAnswer[] = [];
    const menu: TreeAnswer[] = [];
    const stopTree = onProjectTree('p1', (a) => tree.push(a));
    readProjectTree('p1');
    const stopMenu = followProjectTree('p1', (a) => menu.push(a));
    expect(reads()).toHaveLength(1);
    await answer({ n: 1 });
    expect(reads()).toHaveLength(1);
    expect(tree.map((a) => a.doc)).toEqual([{ n: 1 }]);
    expect(menu.map((a) => a.doc)).toEqual([{ n: 1 }]);
    // Later syncs reach both from one request.
    sync();
    await answer({ n: 2 });
    expect(reads()).toHaveLength(2);
    expect(menu.map((a) => a.doc)).toEqual([{ n: 1 }, { n: 2 }]);
    stopTree();
    stopMenu();
    // With nothing out, following reads at once.
    const heard: TreeAnswer[] = [];
    const stop = followProjectTree('p2', (a) => heard.push(a));
    expect(reads()).toHaveLength(3);
    await answer({ n: 3 });
    expect(heard.map((a) => a.doc)).toEqual([{ n: 3 }]);
    stop();
  });

  it('a reader that stopped hears nothing more', async () => {
    const heard: TreeAnswer[] = [];
    const stop = onProjectTree('p1', (a) => heard.push(a));
    readProjectTree('p1');
    stop();
    await answer({ n: 1 });
    expect(heard).toEqual([]);
  });
});
