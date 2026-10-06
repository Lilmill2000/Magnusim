// The sketch feature's pure parts: entity geometry and the kernel's curves,
// driving values and driven measures, lineage, the face frame, region
// unpacking and point-in-region tests.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createUnitsService } from '../../../src/doc/units';
import type { CadDoc, SketchFeature } from '../../../src/types/doc';
import { curvesOf, dimensionCount, dimensionLabel, drivenMeasures, drivingValues, entityGeometry, hasProfileCurves, lineageRoot, measureDimension, sameValues } from '../../../src/features/sketch/geometry';
import { faceFrame, rayPlane, toModel, toSketch } from '../../../src/features/sketch/plane';
import { regionAt, regionContains, unpackRegions } from '../../../src/features/sketch/regions';

const sketch = (patch: Partial<SketchFeature> = {}): SketchFeature => ({
  id: 'f_s',
  type: 'sketch',
  name: 'Sketch 1',
  support: { kind: 'plane', plane: 'origin:top' },
  plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
  points: {},
  entities: [],
  constraints: [],
  solved: { values: {}, dof: 0, state: 'fully' },
  ...patch,
});

/** A 40 x 20 rectangle from the origin, a circle, a construction diagonal, an arc and a point. */
const rect = sketch({
  points: { pt_b: [40, 0], pt_c: [40, 20], pt_d: [0, 20], pt_o: [20, 10], pt_a0: [60, 0], pt_a1: [50, 10], pt_ac: [50, 0], pt_x: [5, 5] },
  entities: [
    { id: 'e_1', kind: 'line', p: ['origin', 'pt_b'] },
    { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
    { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
    { id: 'e_4', kind: 'line', p: ['pt_d', 'origin'] },
    { id: 'e_5', kind: 'line', p: ['origin', 'pt_c'], construction: true },
    { id: 'e_6', kind: 'line', p: ['pt_b', 'pt_d'], centerline: true },
    { id: 'e_7', kind: 'circle', c: 'pt_o', r: 5 },
    { id: 'e_8', kind: 'arc', c: 'pt_ac', a: 'pt_a0', b: 'pt_a1' },
    { id: 'e_9', kind: 'point', p: 'pt_x' },
  ],
  constraints: [
    { id: 'c_h', kind: 'horizontal', refs: ['e_1'] },
    { id: 'c_w', kind: 'distance', refs: ['e_1'], expr: 'w', driving: true },
    { id: 'c_r', kind: 'radius', refs: ['e_7'], expr: '5 mm', driving: true },
    { id: 'c_diag', kind: 'distance', refs: ['origin', 'pt_c'], expr: '44.72 mm', driving: false },
  ],
});

describe('sketch geometry', () => {
  it('resolves every entity against the points (the origin implicit at 0,0), arcs with their angles', () => {
    const g = entityGeometry(rect, rect.points, { e_7: 5 });
    expect(g.find((x) => x.id === 'e_1')).toMatchObject({ kind: 'line', a: [0, 0], b: [40, 0], pa: 'origin', pb: 'pt_b', construction: false });
    expect(g.find((x) => x.id === 'e_5')).toMatchObject({ construction: true });
    expect(g.find((x) => x.id === 'e_6')).toMatchObject({ construction: true });
    const arc = g.find((x) => x.id === 'e_8');
    expect(arc).toMatchObject({ kind: 'arc', c: [50, 0], r: 10, a0: 0, a1: 90, ccw: true, pa: 'pt_a0', pb: 'pt_a1', pc: 'pt_ac' });
  });

  it('gives the kernel only profile curves (no construction, no centerline), with their point ids, and the points', () => {
    const curves = curvesOf(entityGeometry(rect, rect.points, {}));
    expect(curves.map((c) => `${c.kind}:${c.id}`)).toEqual(['line:e_1', 'line:e_2', 'line:e_3', 'line:e_4', 'circle:e_7', 'arc:e_8', 'point:e_9']);
    expect(curves[4]).toEqual({ id: 'e_7', kind: 'circle', c: [20, 10], r: 5, pc: 'pt_o' });
    expect(curves[6]).toEqual({ id: 'e_9', kind: 'point', p: [5, 5], pid: 'pt_x' });
    expect(hasProfileCurves(curves)).toBe(true);
    expect(hasProfileCurves([{ id: 'e_9', kind: 'point', p: [0, 0] }])).toBe(false);
  });

  it('uses a solved radius over the stored one', () => {
    const g = entityGeometry(rect, rect.points, { e_7: 7.5 });
    expect(g.find((x) => x.id === 'e_7')).toMatchObject({ r: 7.5 });
  });

  it('says which entity uses a point that is not there', () => {
    const broken = sketch({ points: {}, entities: [{ id: 'e_3', kind: 'line', p: ['pt_a', 'pt_b'] }] });
    expect(() => entityGeometry(broken, broken.points, {})).toThrow('line e_3 uses a point that is not in the sketch');
  });
});

describe('dimensions', () => {
  const doc = { units: { length: 'mm' as const, angle: 'deg' as const }, params: [{ id: 'p_w', name: 'w', expr: '40 mm', quantity: 'length' as const }] } as Pick<CadDoc, 'units' | 'params'>;
  const units = createUnitsService(
    () => doc.units,
    () => doc.params,
  );

  it('evaluates the driving dimensions (parameters included) and names them as sketch mode does in messages', () => {
    expect(drivingValues(rect, units)).toEqual({ ok: true, values: { c_w: 40, c_r: 5 } });
    // INTEGRATE: the words of sketch mode's conflict list, not d1, d2 ... (which no panel shows).
    expect(dimensionLabel(rect, 'c_r')).toBe('Radius 5 mm');
    expect(dimensionLabel(rect, 'c_diag')).toBe('Distance 44.72 mm');
    expect(dimensionLabel(rect, 'c_w')).toBe('Distance w');
    expect(dimensionLabel(rect, 'c_h')).toBe('Horizontal');
    // With the units service, a bare number says its unit (follow-up: units next to every dimension value).
    const bareDoc = sketch({ constraints: [{ id: 'c_1', kind: 'diameter', refs: ['e_1'], expr: '125', driving: true }] });
    expect(dimensionLabel(bareDoc, 'c_1', units)).toBe('Diameter 125 mm');
    expect(dimensionLabel(rect, 'c_w', units)).toBe('Distance w');
    expect(dimensionCount(rect)).toBe(3);
    const bad = sketch({ constraints: [{ id: 'c_1', kind: 'distance', refs: ['e_1'], expr: 'nope * 2', driving: true }] });
    const r = drivingValues(bad, units);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/^Distance nope \* 2: /);
    const zero = sketch({ constraints: [{ id: 'c_1', kind: 'radius', refs: ['e_7'], expr: '0 mm', driving: true }] });
    expect(drivingValues(zero, units)).toEqual({ ok: false, message: 'Radius 0 mm: a radius must be more than 0' });
  });

  it('compares with the solved values at 1e-9 relative', () => {
    expect(sameValues({ a: 40 }, { a: 40 + 1e-9 })).toBe(true);
    expect(sameValues({ a: 40 }, { a: 40.001 })).toBe(false);
    expect(sameValues({ a: 40 }, {})).toBe(false);
    expect(sameValues({}, { a: 1 })).toBe(true);
  });

  it('measures driven dimensions on the geometry with the solver semantics', () => {
    const g = entityGeometry(rect, rect.points, { e_7: 5 });
    const m = (kind: 'distance' | 'distance_x' | 'distance_y' | 'radius' | 'diameter' | 'angle', refs: string[]) => measureDimension({ kind, refs }, g, rect.points);
    expect(m('distance', ['origin', 'pt_c'])).toBeCloseTo(Math.hypot(40, 20), 12);
    expect(m('distance', ['e_2'])).toBeCloseTo(20, 12);
    expect(m('distance', ['pt_o', 'e_1'])).toBeCloseTo(10, 12);
    expect(m('distance', ['e_1', 'e_3'])).toBeCloseTo(20, 12);
    expect(m('distance', ['pt_x', 'e_7'])).toBeCloseTo(Math.hypot(15, 5) - 5, 12);
    expect(m('distance', ['e_7', 'e_8'])).toBeCloseTo(Math.hypot(30, 10) - 15, 12);
    expect(m('distance', ['e_7', 'e_1'])).toBeCloseTo(5, 12);
    expect(m('distance_x', ['pt_c', 'origin'])).toBe(-40);
    expect(m('distance_y', ['pt_c'])).toBe(20);
    expect(m('distance_x', ['e_3'])).toBe(-40);
    expect(m('radius', ['e_8'])).toBeCloseTo(10, 12);
    expect(m('diameter', ['e_7'])).toBe(10);
    expect(m('angle', ['e_2'])).toBeCloseTo(90, 12);
    expect(m('angle', ['e_1', 'e_3'])).toBeCloseTo(180, 12);
    expect(m('radius', ['e_1'])).toBeNull();
    expect(drivenMeasures(rect, g, rect.points)).toEqual({ c_diag: Math.hypot(40, 20) });
  });

  it('finds the root of an entity lineage, by parent or by spelling', () => {
    const parents = new Map<string, string | null>([
      ['e_1.b', 'e_1'],
      ['e_1.c', 'e_1.b'],
    ]);
    expect(lineageRoot('e_1.c', parents)).toBe('e_1');
    expect(lineageRoot('e_9.b', new Map())).toBe('e_9');
    expect(lineageRoot('e_2', parents)).toBe('e_2');
  });
});

describe('planes', () => {
  it('frames a face: the origin projected, the outward normal, X projected (Y when X is the normal)', () => {
    const top = faceFrame([0, 0, 1], [20, 20, 20]);
    expect(top).toEqual({ origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] });
    const side = faceFrame([1, 0, 0], [40, 3, 4]);
    expect(side).toEqual({ origin: [40, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] });
    const back = faceFrame([0, 1, 0], [1, 30, 2]);
    expect(back.origin).toEqual([0, 30, 0]);
    expect(back.xdir).toEqual([1, 0, 0]);
  });

  it('maps sketch points to the model and back, and meets rays', () => {
    const front = { origin: [0, 0, 0] as [number, number, number], normal: [0, -1, 0] as [number, number, number], xdir: [1, 0, 0] as [number, number, number] };
    expect(toModel(front, [3, 4])).toEqual([3, 0, 4]);
    expect(toSketch(front, [3, 9, 4])).toEqual([3, 4]);
    const hit = rayPlane(front, { origin: [3, -100, 4], dir: [0, 1, 0] });
    expect(hit).toMatchObject({ t: 100, uv: [3, 4] });
    expect(rayPlane(front, { origin: [3, -100, 4], dir: [1, 0, 0] })).toBeNull();
    expect(rayPlane(front, { origin: [3, -100, 4], dir: [0, -1, 0] })).toBeNull();
  });
});

describe('regions', () => {
  const regions = unpackRegions(
    [
      { key: 'A', loops: [['+e_1[]']], entities: ['e_1'], area: 100, sample: [5, 5], bbox: [0, 0, 10, 10] },
      { key: 'B', loops: [['+e_2[]']], entities: ['e_2'], area: 50, sample: [15, 2.5], bbox: [10, 0, 20, 5] },
    ],
    {
      tri_uv: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10, 20, 0, 20, 5, 10, 5]).buffer,
      tri_idx: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 6]).buffer,
      tri_ranges: new Uint32Array([0, 6, 6, 6]).buffer,
    },
  );

  it('unpacks each region with the shared u/v and its own triangles', () => {
    expect(regions.map((r) => [r.key, [...r.tri.idx]])).toEqual([
      ['A', [0, 1, 2, 0, 2, 3]],
      ['B', [1, 4, 5, 1, 5, 6]],
    ]);
    expect(regions[0].tri.uv).toBe(regions[1].tri.uv);
  });

  it('finds the region under a point (the smaller one on a shared edge), and none outside', () => {
    expect(regionContains(regions[0], [5, 5])).toBe(true);
    expect(regionContains(regions[0], [15, 2])).toBe(false);
    expect(regionAt(regions, [15, 2])?.key).toBe('B');
    expect(regionAt(regions, [10, 2])?.key).toBe('B');
    expect(regionAt(regions, [30, 30])).toBeNull();
  });

  it('keeps a region the kernel sent without triangles (a profile that cannot be shaded)', () => {
    const r = unpackRegions([{ key: 'A', loops: [], entities: [], area: 1, sample: [0, 0], bbox: [0, 0, 1, 1] }], {});
    expect(r[0].tri.idx.length).toBe(0);
    expect(regionContains(r[0], [0.5, 0.5])).toBe(false);
  });
});
