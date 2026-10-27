// @vitest-environment node
// The shape tools (v0.5.0, Daniel's parity rule both ways): each one, clicked in a real sketch
// session with the real solver, stores exactly what the Assistant's macro stores for the same
// numbers (points, entities, own relations and their ids), reads back as that macro, keeps the
// macro's DOF, takes typed values as driving dimensions, and its closed shapes are one region on
// the real kernel (a slot extrudes).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { describeSketch } from '../../src/assistant/sketch/describe';
import { expandEntity, KIND_DOF, type EntityKind } from '../../src/assistant/sketch/macros';
import { curvesOf, entityGeometry, storedRadii, withOrigin } from '../../src/features/sketch/geometry';
import { isDimension } from '../../src/sketch/model';
import { SHAPES, shapeId } from '../../src/sketch/tools/shapes';
import type { DocState } from '../../src/types/doc-service';
import type { SketchDimension, SketchFeature, Vec2 } from '../../src/types/doc';
import type { SketchToolId } from '../../src/types/sketch';
import { call, loadKernel } from '../kernel/kernel-lib';
import { sketchHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const r2 = Math.SQRT1_2 * 20;
const n = (() => {
  // The left normal of (10, 10) -> (30, 20), 8 mm long.
  const d = [20, 10];
  const l = Math.hypot(d[0], d[1]);
  return [(-d[1] / l) * 8, (d[0] / l) * 8];
})();

interface Case {
  tool: SketchToolId;
  clicks: Vec2[];
  kind: EntityKind;
  id: string;
  at: number[];
  dof: number;
  /** Area of its one region (mm2), when it is a closed shape. */
  area?: number;
  setup?(hh: Harness): void;
}

const CASES: Case[] = [
  { tool: 'line-midpoint', clicks: [[10, 10], [20, 15]], kind: 'midpoint_line', id: 'midline1', at: [10, 10, 20, 15], dof: 4 },
  { tool: 'rectangle-3pt', clicks: [[10, 10], [30, 20], [30 + n[0], 20 + n[1]]], kind: 'rect_3pt', id: 'rect1', at: [10, 10, 30, 20, 8], dof: 5, area: Math.hypot(20, 10) * 8 },
  { tool: 'rectangle-center-3pt', clicks: [[10, 10], [20, 10], [15, 16]], kind: 'center_rect_3pt', id: 'crect1', at: [10, 10, 20, 12, 0], dof: 5, area: 240 },
  { tool: 'parallelogram', clicks: [[10, 10], [30, 10], [35, 20]], kind: 'parallelogram', id: 'pgram1', at: [10, 10, 30, 10, 35, 20], dof: 6, area: 200 },
  { tool: 'circle-3pt', clicks: [[10, 0], [0, 10], [-10, 0]], kind: 'circle_3pt', id: 'circle1', at: [10, 0, 0, 10, -10, 0], dof: 3, area: Math.PI * 100 },
  { tool: 'arc-center', clicks: [[10, 10], [20, 10], [10, 25]], kind: 'arc', id: 'arc1', at: [10, 10, 10, 0, 90], dof: 5 },
  { tool: 'slot-center', clicks: [[10, 10], [30, 10], [20, 14]], kind: 'slot', id: 'slot1', at: [10, 10, 30, 10, 4], dof: 5, area: 20 * 8 + Math.PI * 16 },
  { tool: 'slot-overall', clicks: [[10, 30], [40, 30], [25, 33]], kind: 'slot', id: 'slot1', at: [13, 30, 37, 30, 3], dof: 5, area: 24 * 6 + Math.PI * 9 },
  { tool: 'slot-center-point', clicks: [[20, 50], [30, 50], [25, 52.5]], kind: 'slot', id: 'slot1', at: [10, 50, 30, 50, 2.5], dof: 5, area: 20 * 5 + Math.PI * 6.25 },
  { tool: 'slot-arc-3pt', clicks: [[20, 0], [0, 20], [r2, r2], [23, 0]], kind: 'arc_slot', id: 'arcslot1', at: [0, 0, 20, 3, 0, 90], dof: 6, area: (Math.PI / 2) * 20 * 6 + Math.PI * 9 },
  { tool: 'slot-arc-center', clicks: [[50, 50], [70, 50], [50, 75], [73, 50]], kind: 'arc_slot', id: 'arcslot1', at: [50, 50, 20, 3, 0, 90], dof: 6, area: (Math.PI / 2) * 20 * 6 + Math.PI * 9 },
  { tool: 'polygon', clicks: [[10, 10], [20, 10]], kind: 'polygon', id: 'polygon1', at: [10, 10, 10, 6, 0], dof: 4, area: ((3 * Math.sqrt(3)) / 2) * 100 },
  {
    tool: 'polygon',
    clicks: [[10, 10], [20, 10]],
    kind: 'polygon',
    id: 'polygon1',
    at: [10, 10, 10 / Math.cos(Math.PI / 6), 6, -30],
    dof: 4,
    area: 6 * 10 * 10 * Math.tan(Math.PI / 6),
    setup: (hh) => {
      const o = hh.mode.tool!.options!().find((x) => x.id === 'polygon-kind');
      if (o?.kind === 'choice') o.set('circumscribed');
    },
  },
  { tool: 'sector', clicks: [[10, 10], [30, 10], [10, 30]], kind: 'sector', id: 'sector1', at: [10, 10, 0, 20, 0, 90], dof: 5, area: Math.PI * 100 },
  {
    tool: 'sector',
    clicks: [[10, 10], [30, 10], [10, 30]],
    kind: 'sector',
    id: 'sector1',
    at: [10, 10, 5, 20, 0, 90],
    dof: 6,
    area: (Math.PI / 4) * (400 - 25),
    setup: (hh) => {
      const o = hh.mode.tool!.options!().find((x) => x.id === 'inner');
      if (o?.kind === 'number') o.set('5 mm', 5);
    },
  },
];

/** The shape's own record in a sketch: its points, entities and relations (ids "<id>" or "<id>__..."). */
function recordOf(f: SketchFeature, id: string) {
  const own = (x: string) => x === id || x.startsWith(`${id}__`);
  return {
    points: Object.fromEntries(Object.entries(f.points).filter(([k]) => own(k))),
    entities: f.entities.filter((e) => own(e.id)),
    relations: f.constraints.filter((c) => own(c.id) && !isDimension(c) && !('inferred' in c && c.inferred)),
  };
}

async function draw(c: Case): Promise<Harness> {
  const hh = await sketchHarness();
  hh.tool(c.tool);
  c.setup?.(hh);
  for (const p of c.clicks) {
    hh.move([p[0] + 0.3, p[1] + 0.2]);
    hh.click(p);
  }
  await hh.idle();
  return hh;
}

const STATE = (f: SketchFeature) =>
  ({ doc: { features: [f], params: [], units: { length: 'mm', angle: 'deg' } }, rebuild: { bodies: [], features: {}, outputs: {} } }) as unknown as DocState;

describe('the shape tools store what the Assistant stores', () => {
  for (const c of CASES) {
    it(`${c.tool}${c.setup ? ' (option)' : ''}: the ${c.kind} macro's record, ${c.dof} DOF, read back as ${c.kind}`, async () => {
      h = await draw(c);
      const f = h.sketch();
      const m = expandEntity(c.id, c.kind, c.at, false);
      if (!m.ok) throw new Error(m.problem);
      const rec = recordOf(f, c.id);
      // The same entities (kinds, ids, points, flags), relations (ids, kinds, refs) and points (to 1e-6 mm).
      expect(rec.entities.map((e) => ({ ...e, ...(e.kind === 'circle' ? { r: Math.round(e.r * 1e6) / 1e6 } : {}) }))).toEqual(
        m.macro.entities.map((e) => ({ ...e, ...(e.kind === 'circle' ? { r: Math.round(e.r * 1e6) / 1e6 } : {}) })),
      );
      expect(rec.relations).toEqual(m.macro.relations);
      expect(Object.keys(rec.points).sort()).toEqual(m.macro.points.map((p) => p.id).sort());
      for (const p of m.macro.points) {
        expect(rec.points[p.id][0], p.id).toBeCloseTo(p.at[0], 6);
        expect(rec.points[p.id][1], p.id).toBeCloseTo(p.at[1], 6);
      }
      // Nothing else (no snap: the clicks are on nothing).
      expect(f.entities.length).toBe(rec.entities.length);
      expect(h.mode.state.get().status).toMatchObject({ dof: c.dof });
      if (KIND_DOF[c.kind] !== null && c.kind !== 'sector') expect(c.dof).toBe(KIND_DOF[c.kind]);
      // The Assistant reads it back as its own macro, with the same numbers.
      const form = describeSketch(f, STATE(f));
      const ent = (form.inputs?.entities as { id: string; kind: string; at: number[] }[]).find((e) => e.id === (c.kind === 'circle_3pt' ? c.id : c.id));
      expect(ent?.kind).toBe(c.kind === 'circle_3pt' ? 'circle' : c.kind);
      if (c.kind !== 'circle_3pt') {
        const back = expandEntity(c.id, c.kind, ent!.at, false);
        expect(back.ok && back.macro.points.map((p) => p.at.map((x) => +x.toFixed(4)))).toEqual(m.macro.points.map((p) => p.at.map((x) => +x.toFixed(4))));
      }
    });
  }

  it('the closed shapes are one region each on the real kernel, of the right area (a slot, an arc slot, a polygon, a sector extrude)', async () => {
    const k = await loadKernel();
    for (const c of CASES.filter((x) => x.area !== undefined)) {
      const hh = await draw(c);
      const f = hh.sketch();
      const curves = curvesOf(entityGeometry(f, withOrigin(f.points), storedRadii(f)));
      const r = call(k, 'sketch_regions', { plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] }, curves }) as { regions: { area: number }[] };
      expect(r.regions.length, c.tool).toBe(1);
      expect(r.regions[0].area / c.area!, c.tool).toBeCloseTo(1, 4);
      hh.dispose();
    }
  });

  it('typed values: a slot of length 20 and width 8 stores both as driving dimensions (3 DOF left)', async () => {
    h = await sketchHarness();
    h.tool('slot-center');
    h.move([10, 10]);
    h.click([10, 10]);
    h.move([25, 12]);
    h.mode.tool!.box!('length', 'input', '20');
    expect(h.mode.tool!.box!('length', 'enter', '20')).toBe(false);
    h.move([18, 14]);
    expect(h.mode.tool!.box!('width', 'enter', '8')).toBe(true);
    await h.idle();
    const f = h.sketch();
    const dims = f.constraints.filter(isDimension) as SketchDimension[];
    expect(dims.map((d) => [d.kind, d.refs, d.expr])).toEqual([
      ['distance', ['slot1__axis'], '20 mm'],
      ['diameter', ['slot1__arc_a'], '8 mm'],
    ]);
    expect(h.mode.state.get().status).toMatchObject({ dof: 3 });
    const pts = f.points;
    expect(Math.hypot(pts.slot1__b[0] - pts.slot1__a[0], pts.slot1__b[1] - pts.slot1__a[1])).toBeCloseTo(20, 6);
  });

  it('a click on a sketch point joins it, a click on the origin ties to it; Escape steps back; construction drawing', async () => {
    h = await sketchHarness();
    h.tool('slot-center');
    h.click([0.05, 0.05]); // the origin
    h.click([20, 0]);
    h.click([10, 3]);
    await h.idle();
    let f = h.sketch();
    expect(f.constraints.find((c) => c.kind === 'coincident')).toMatchObject({ refs: ['slot1__a', 'origin'], inferred: true });
    // A second slot from the first's arc centre: that point, joined (as the Assistant joins it).
    h.click([20.02, 0]);
    expect(h.mode.tool!.cancel()).toBe(true); // Escape: the click goes
    h.click([20.02, 0]);
    h.click([20, 20]);
    h.mode.setDrawConstruction(true);
    h.click([22, 10]);
    await h.idle();
    f = h.sketch();
    const s2 = f.entities.find((e) => e.id === 'slot2__axis');
    expect(s2?.kind === 'line' && s2.p[0]).toBe('slot1__b');
    expect(f.points.slot2__a).toBeUndefined();
    expect(f.entities.filter((e) => e.id.startsWith('slot2__')).every((e) => e.construction)).toBe(true);
  });

  it('every shape tool has a spec, a unique tool id, and ids that never clash', () => {
    expect(new Set(SHAPES.map((s) => s.tool)).size).toBe(SHAPES.length);
    const d = { points: { slot1__a: [0, 0] as Vec2 }, entities: [], constraints: [] };
    expect(shapeId(d, 'slot')).toBe('slot2');
    expect(shapeId({ points: {}, entities: [], constraints: [] }, 'slot')).toBe('slot1');
  });
});
