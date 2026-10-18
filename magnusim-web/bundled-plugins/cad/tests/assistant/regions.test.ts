// A sketch's regions as the Assistant names them (src/assistant/sketch/regions.ts, CAD tools spec
// §6.6), on sketches the sketch tool draws on the REAL kernel: ids r1, r2, ... by area (largest
// first), then by their inside point; a region inside another's hole one deeper; "all" is the
// even-odd set (a plate with holes extrudes as the plate, a ring as a ring, two overlapping circles
// as all three pieces); at(u, v) is the smallest region holding the point. The sketch tool's answer,
// find and get_model list the same rows.
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
});
