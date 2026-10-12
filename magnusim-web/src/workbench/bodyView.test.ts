// Bodies hidden in the view: the store the setup tree reads, and a body row's menu items.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bodyHidden,
  bodyMenuItems,
  getBodyView,
  publishBodyView,
  requestBodyView,
  resetBodyViewForTests,
  setBodyViewHandler,
  subscribeBodyView,
  type BodyViewState,
} from './bodyView';

const view = (over: Partial<BodyViewState> = {}): BodyViewState => ({
  geometryId: 'g1',
  count: 3,
  hidden: [],
  selected: [],
  results: false,
  ...over,
});

afterEach(() => resetBodyViewForTests());

describe('bodyMenuItems', () => {
  it('a shown body hides, a hidden one shows', () => {
    expect(bodyMenuItems(view(), 'g1', 2)).toEqual([{ act: 'hide', label: 'Hide body', bodies: [2] }]);
    expect(bodyMenuItems(view({ hidden: [2] }), 'g1', 2)).toEqual([{ act: 'show', label: 'Show body', bodies: [2] }]);
  });

  it('a row among several picked rows acts on all of them', () => {
    expect(bodyMenuItems(view({ selected: [1, 3] }), 'g1', 3)).toEqual([{ act: 'hide', label: 'Hide 2 bodies', bodies: [1, 3] }]);
    expect(bodyMenuItems(view({ selected: [1, 3], hidden: [1, 3] }), 'g1', 1)).toEqual([{ act: 'show', label: 'Show 2 bodies', bodies: [1, 3] }]);
    // Some hidden, some shown: both.
    expect(bodyMenuItems(view({ selected: [1, 2], hidden: [1] }), 'g1', 2).map((i) => i.label)).toEqual(['Hide 2 bodies', 'Show 2 bodies']);
  });

  it('a row outside the picked rows acts on itself only', () => {
    expect(bodyMenuItems(view({ selected: [1, 3] }), 'g1', 2)).toEqual([{ act: 'hide', label: 'Hide body', bodies: [2] }]);
  });

  it('offers Show all bodies when another body is hidden', () => {
    expect(bodyMenuItems(view({ hidden: [3] }), 'g1', 1).map((i) => i.act)).toEqual(['hide', 'show-all']);
    expect(bodyMenuItems(view({ hidden: [1] }), 'g1', 1).map((i) => i.act)).toEqual(['show']);
  });

  it('nothing for a single body, another geometry, or the results view', () => {
    expect(bodyMenuItems(view({ count: 1 }), 'g1', 1)).toEqual([]);
    expect(bodyMenuItems(view(), 'g2', 1)).toEqual([]);
    expect(bodyMenuItems(view({ results: true }), 'g1', 1)).toEqual([]);
  });
});

describe('body view store', () => {
  it('repaints only on a change, and keeps ids sorted and unique', () => {
    const fn = vi.fn();
    subscribeBodyView(fn);
    publishBodyView({ geometryId: 'g1', count: 2, hidden: [2, 2, 0], selected: [] });
    expect(getBodyView().hidden).toEqual([2]);
    expect(fn).toHaveBeenCalledTimes(1);
    publishBodyView({ hidden: [2] });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bodyHidden(getBodyView(), 'g1', 2)).toBe(true);
    expect(bodyHidden(getBodyView(), 'g2', 2)).toBe(false);
  });

  it('passes the tree request to the workbench', () => {
    const got: unknown[] = [];
    setBodyViewHandler((req) => got.push(req));
    requestBodyView({ kind: 'hide', bodies: [1] });
    requestBodyView({ kind: 'show-all' });
    expect(got).toEqual([{ kind: 'hide', bodies: [1] }, { kind: 'show-all' }]);
  });
});
