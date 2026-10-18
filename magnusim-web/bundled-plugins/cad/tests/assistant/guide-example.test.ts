// The guide's worked examples build on the REAL kernel (CAD tools spec §10.1, §12.1 guide-example),
// called as the guide writes them: every feature ok, every sketch fully defined (dof 0), the body's
// volume and box within 1e-6 (relative) of the formula. The holes of examples 1 and 3, and the
// flange's pattern, come with the hole tool; here the parts are built up to them:
//   1  the plate: parameters, a center_rect on Top anchored and dimensioned, extrude "Plate" blind t;
//   2  the L bracket: a closed polyline on Front with infer, extrude symmetric, the inner fillet;
//   3  the flange: a rect on Front dimensioned from the origin, revolve about the Z axis, full.
// The guide text is checked to hold each call as written here, so a change of either shows.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { GUIDE } from '../../src/assistant/guide';
import type { SketchFeature } from '../../src/types/doc';
import { EXTRUDE, ok, REVOLVE } from './extrude-tools';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { C, E, SK, type Row } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const P = (name: string, expr: string) => ({ name, kind: 'length', expr, comment: '', rename_to: '' });

/** Every feature ok, every sketch fully defined, one body: its volume and box against the formula. */
function check(x: AssistantHarness, v: number, box: number[]): void {
  const s = x.doc.state.get();
  for (const f of s.doc.features) {
    expect(s.rebuild.features[f.id]?.state, f.name).toBe('ok');
    if (f.type === 'sketch') expect((f as SketchFeature).solved, f.name).toMatchObject({ state: 'fully', dof: 0 });
  }
  expect(s.rebuild.bodies).toHaveLength(1);
  const b = s.rebuild.bodies[0];
  expect(Math.abs(b.volume! - v) / v, `volume ${b.volume} vs ${v}`).toBeLessThan(1e-6);
  b.bbox.forEach((c, i) => expect(Math.abs(c - box[i]), `bbox[${i}] ${c} vs ${box[i]}`).toBeLessThan(1e-6 * Math.max(1, Math.abs(box[i]))));
}

/** The guide's own line for example `n` (under its EXAMPLES heading). */
const line = (n: number) => GUIDE.slice(GUIDE.indexOf('\nEXAMPLES')).split('\n').find((l) => l.startsWith(`${n} `)) ?? '';

describe("the guide's examples", () => {
  it(
    '1: the plate (up to its holes)',
    async () => {
      const g = line(1);
      for (const part of ['set_params w 60 mm, d 40 mm, t 6 mm, hd 5 mm, e 8 mm', 'sketch on Top: center_rect r [0,0,60,40]; coincident [r.center, origin]; distance [r.bottom] "w", [r.left] "d"', 'extrude "Plate" ["all"] blind "t" new']) expect(g).toContain(part);
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'set_params', { set: [P('w', '60 mm'), P('d', '40 mm'), P('t', '6 mm'), P('hd', '5 mm'), P('e', '8 mm')], remove: [] });
      await ok(h, 'sketch', SK({ name: 'Plate sketch', on: 'Top', entities: [E('r', 'center_rect', [0, 0, 60, 40])], constraints: [C('c', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], 'w'), C('dd', 'distance', ['r.left'], 'd')] }));
      const r = await ok(h, 'extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', regions: ['all'], extent: 'blind', distance: 't', op: 'new' }));
      expect(r.data.created).toEqual(expect.arrayContaining(['Plate.end', 'Plate.start']));
      check(h, 60 * 40 * 6, [-30, -20, 0, 30, 20, 6]);
    },
    REAL_KERNEL_MS,
  );

  it(
    '2: the L bracket, with its inner fillet',
    async () => {
      const g = line(2);
      for (const part of ['sketch on Front: polyline p [0,0,50,0,50,5,5,5,5,40,0,40,0,0], infer; coincident [p.p0, origin]; distance [p.1] "a", [p.6] "b", [p.2] "t", [p.5] "t"', 'extrude "Bracket" symmetric "wid" new', 'modify fillet ["Bracket.side(p.3) & Bracket.side(p.4)"] "r"']) expect(g).toContain(part);
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'set_params', { set: [P('a', '50 mm'), P('b', '40 mm'), P('t', '5 mm'), P('wid', '30 mm'), P('r', '4 mm')], remove: [] });
      const L = [0, 0, 50, 0, 50, 5, 5, 5, 5, 40, 0, 40, 0, 0];
      await ok(h, 'sketch', SK({ name: 'L profile', on: 'Front', entities: [E('p', 'polyline', L)], constraints: [C('o', 'coincident', ['p.p0', 'origin']), C('da', 'distance', ['p.1'], 'a'), C('db', 'distance', ['p.6'], 'b'), C('t1', 'distance', ['p.2'], 't'), C('t2', 'distance', ['p.5'], 't')], infer: true }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Bracket', sketch: 'L profile', extent: 'symmetric', distance: 'wid', op: 'new' }));
      const fillet: Row = { edit: '', name: '', kind: 'fillet', targets: ['Bracket.side(p.3) & Bracket.side(p.4)'], size: 'r', size2: '', flip: false, inward: false };
      await ok(h, 'modify', fillet);
      // The L (50 x 5 and 5 x 35) times 30, and the inner round adds (1 - pi/4) r^2 along 30 mm.
      check(h, (50 * 5 + 5 * 35) * 30 + (1 - Math.PI / 4) * 16 * 30, [0, -15, 0, 50, 15, 40]);
    },
    REAL_KERNEL_MS,
  );

  it(
    '3: the flange (up to its holes)',
    async () => {
      const g = line(3);
      for (const part of ['sketch on Front: rect r [10,0,40,8]; horizontal [r.bl, origin]; distance_x [origin, r.bl] "bore/2", [origin, r.br] "od/2"; distance [r.left] "t"', 'revolve "Flange" axis "Z axis" full new']) expect(g).toContain(part);
      h = await assistantHarness({ sketchMode: true });
      await ok(h, 'set_params', { set: [P('od', '80 mm'), P('bore', '20 mm'), P('t', '8 mm')], remove: [] });
      await ok(h, 'sketch', SK({ name: 'Flange sketch', on: 'Front', entities: [E('r', 'rect', [10, 0, 40, 8])], constraints: [C('hz', 'horizontal', ['r.bl', 'origin']), C('ib', 'distance_x', ['origin', 'r.bl'], 'bore/2'), C('io', 'distance_x', ['origin', 'r.br'], 'od/2'), C('th', 'distance', ['r.left'], 't')] }));
      await ok(h, 'revolve', REVOLVE({ name: 'Flange', sketch: 'Flange sketch', axis: 'Z axis', extent: 'full', op: 'new' }));
      check(h, Math.PI * (40 * 40 - 10 * 10) * 8, [-40, -40, 0, 40, 40, 8]);
    },
    REAL_KERNEL_MS,
  );
});
