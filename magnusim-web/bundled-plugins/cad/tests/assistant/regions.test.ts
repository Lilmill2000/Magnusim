// A sketch's regions as the Assistant names them (src/assistant/sketch/regions.ts, CAD tools spec
// §6.6), on sketches the sketch tool draws on the REAL kernel: ids r1, r2, ... by area (largest
// first), then equal ones by where they sit (u, then v: a row of equal holes left to right, a column
// bottom to top, though the kernel's areas differ in their last bits); a region in another's hole
// one deeper, also each piece of a hole that crossing curves split (overlapping holes, a line across
// a hole, a keyhole), and an island in such a hole one deeper again; "all" is every region at even
// depth (a plate with holes extrudes as the plate, its split holes open too, a ring as a ring, two
// overlapping circles as all three pieces); at(u, v) is the smallest region holding the point. The
// sketch tool's answer, find and get_model list the same rows.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { regionRows } from '../../src/assistant/sketch/regions';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { C, E, outputOf, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const find = async (x: AssistantHarness, query: string) => {
  const r = await x.ok('find', { query, limit: 50 });
  return r.data.rows as Row[];
};
const sketch = async (x: AssistantHarness, input: Row) => {
  const r = await x.call('sketch', input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.result as { text: string; data: { regions: Row[] } };
};

describe('regions', () => {
  it(
    'numbers a plate with two holes by area; all is the plate alone; at(u, v) the smallest that holds it',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const r = await sketch(h, SK({ name: 'Holes sk', entities: [E('r', 'rect', [-30, -20, 30, 20]), E('a', 'circle', [-15, 0, 3]), E('b', 'circle', [15, 0, 5])] }));
      expect(r.data.regions.map((x) => [x.id, x.area_mm2, x.holes, x.depth])).toEqual([
        ['r1', expect.any(Number), 2, 0],
        ['r2', Number((Math.PI * 25).toPrecision(6)), 0, 1],
        ['r3', Number((Math.PI * 9).toPrecision(6)), 0, 1],
      ]);
      expect(r.data.regions[0].area_mm2).toBeCloseTo(2400 - Math.PI * 34, 2);
      expect(r.data.regions[1].bounded_by).toEqual(['b']);
      expect(r.data.regions[0].bounded_by).toEqual(['a', 'b', 'r.bottom', 'r.left', 'r.right', 'r.top']);
      // All (the sketch's name alone): even depth only, the plate with its holes open.
      expect((await find(h, 'Holes sk')).map((x) => x.handle)).toEqual(['Holes sk r1']);
      expect((await find(h, 'Holes sk regions')).map((x) => x.handle)).toEqual(['Holes sk r1', 'Holes sk r2', 'Holes sk r3']);
      expect((await find(h, 'Holes sk at(-15, 0)')).map((x) => x.handle)).toEqual(['Holes sk r3']);
      expect((await find(h, 'Holes sk at(0, 10)')).map((x) => x.handle)).toEqual(['Holes sk r1']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a ring: all is the ring; two overlapping circles: all three pieces, equal ones by their inside point',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // Drawn at one centre, the circles share it (a join): concentric by that.
      const ring = await sketch(h, SK({ name: 'Ring sk', entities: [E('o', 'circle', [0, 0, 10]), E('i', 'circle', [0, 0, 5])], constraints: [C('k', 'coincident', ['o.center', 'origin'])] }));
      expect(ring.data.regions.map((x) => [x.id, x.depth, x.holes])).toEqual([
        ['r1', 0, 1],
        ['r2', 1, 0],
      ]);
      expect(ring.data.regions[0].area_mm2).toBeCloseTo(Math.PI * 75, 2);
      expect((await find(h, 'Ring sk')).map((x) => x.handle)).toEqual(['Ring sk r1']);
      const two = await sketch(h, SK({ name: 'Two sk', on: 'Front', entities: [E('a', 'circle', [0, 0, 5]), E('b', 'circle', [6, 0, 5])] }));
      const rows = two.data.regions;
      expect(rows.map((x) => [x.id, x.depth])).toEqual([
        ['r1', 0],
        ['r2', 0],
        ['r3', 0],
      ]);
      // The two crescents are the same size: the one further left (smaller u) comes first.
      expect(rows[0].area_mm2).toBeCloseTo(rows[1].area_mm2 as number, 3);
      expect((rows[0].at as number[])[0]).toBeLessThan((rows[1].at as number[])[0]);
      expect((await find(h, 'Two sk')).map((x) => x.handle)).toEqual(['Two sk r1', 'Two sk r2', 'Two sk r3']);
      // regionRows is the one rule: the same order from the built output.
      expect(regionRows(outputOf(h, 'Two sk')).map((x) => x.id)).toEqual(['r1', 'r2', 'r3']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'keeps holes open that crossing curves split: two overlapping holes, a line across a hole, a keyhole; an island in one is material',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      const plate = E('r', 'rect', [-30, -20, 30, 20]);
      const allArea = async (name: string) => {
        const handles = (await find(h!, name)).map((x) => x.handle as string);
        const rows = regionRows(outputOf(h!, name));
        return { handles, area: rows.filter((r) => handles.includes(`${name} ${r.id}`)).reduce((s, r) => s + r.area_mm2, 0), rows };
      };
      // Two overlapping holes: two crescents and the lens between them, each in the plate's hole.
      await sketch(h, SK({ name: 'Overlap sk', entities: [plate, E('a', 'circle', [-3, 0, 5]), E('b', 'circle', [3, 0, 5])] }));
      const lens = 2 * 25 * Math.acos(3 / 5) - 3 * Math.sqrt(25 - 9) * 2;
      const overlap = await allArea('Overlap sk');
      expect(overlap.rows.map((x) => [x.id, x.holes, x.depth])).toEqual([
        ['r1', 1, 0],
        ['r2', 0, 1],
        ['r3', 0, 1],
        ['r4', 0, 1],
      ]);
      expect(overlap.handles).toEqual(['Overlap sk r1']);
      expect(overlap.area).toBeCloseTo(2400 - (50 * Math.PI - lens), 1);
      // A line across a hole: both halves are in it.
      await sketch(h, SK({ name: 'Crossed sk', on: 'Front', entities: [plate, E('c', 'circle', [0, 0, 5]), E('l', 'line', [-8, 0, 8, 0])] }));
      const crossed = await allArea('Crossed sk');
      expect(crossed.rows.map((x) => x.depth)).toEqual([0, 1, 1]);
      expect(crossed.handles).toEqual(['Crossed sk r1']);
      expect(crossed.area).toBeCloseTo(2400 - 25 * Math.PI, 1);
      // A keyhole: a circle and a slot that overlaps it; all three pieces are the hole.
      await sketch(h, SK({ name: 'Key sk', on: 'Right', entities: [plate, E('c', 'circle', [0, 0, 5]), E('s', 'rect', [-2, -12, 2, 0])] }));
      const inside = 2 * (Math.sqrt(21) + 12.5 * Math.asin(0.4));
      const key = await allArea('Key sk');
      expect(key.rows.map((x) => x.depth)).toEqual([0, 1, 1, 1]);
      expect(key.handles).toEqual(['Key sk r1']);
      expect(key.area).toBeCloseTo(2400 - (25 * Math.PI + 48 - inside), 1);
      // An island in the left crescent: one hole deeper again, so material.
      await sketch(h, SK({ name: 'Island sk', on: 'Top', entities: [plate, E('a', 'circle', [-3, 0, 5]), E('b', 'circle', [3, 0, 5]), E('i', 'circle', [-6, 0, 1])] }));
      const island = await allArea('Island sk');
      const disc = island.rows.find((x) => Math.abs(x.area_mm2 - Math.PI) < 1e-3)!;
      expect(disc.depth).toBe(2);
      expect(island.rows.filter((x) => x.depth === 1)).toHaveLength(3);
      expect(island.handles).toEqual(['Island sk r1', `Island sk ${disc.id}`]);
      expect(island.area).toBeCloseTo(2400 - (50 * Math.PI - lens) + Math.PI, 1);
    },
    REAL_KERNEL_MS,
  );

  it(
    'numbers equal holes by where they sit: a row left to right, a column bottom to top',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // Seven equal holes in a row: the kernel's areas differ in their last bits, by place.
      const us = [-40, -25, -10, 5, 20, 35, 50];
      const row = await sketch(h, SK({ name: 'Row sk', on: 'Front', entities: [E('r', 'rect', [-60, -20, 60, 20]), ...us.map((u, i) => E(`c${i}`, 'circle', [u, 0, 2.5]))] }));
      const raw = outputOf(h, 'Row sk').regions.filter((x) => x.area < 100).map((x) => x.area);
      expect(new Set(raw).size).toBeGreaterThan(1);
      const holes = row.data.regions.slice(1);
      expect(holes.map((x) => x.bounded_by)).toEqual(us.map((_, i) => [`c${i}`]));
      expect(regionRows(outputOf(h, 'Row sk')).slice(1).map((x) => x.entities)).toEqual(us.map((_, i) => [`c${i}`]));
      // A column of them, written top first.
      const vs = [15, 5, -5, -15];
      const col = await sketch(h, SK({ name: 'Column sk', on: 'Right', entities: [E('r', 'rect', [-10, -20, 10, 20]), ...vs.map((v, i) => E(`k${i}`, 'circle', [0, v, 2.5]))] }));
      expect(col.data.regions.slice(1).map((x) => x.bounded_by)).toEqual([['k3'], ['k2'], ['k1'], ['k0']]);
    },
    REAL_KERNEL_MS,
  );
});
