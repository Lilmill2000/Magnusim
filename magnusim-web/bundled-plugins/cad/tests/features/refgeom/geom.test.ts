// The analytic geometry of reference planes and axes (src/features/refgeom/geom.ts),
// the drawn squares and segments (scene.ts) and the picking tests (pick.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { axisThrough, midplane, offsetPlane, planeAtAngle, planeNormalTo, planesCross, planeThrough, rotate } from '../../../src/features/refgeom/geom';
import { hitConstruct } from '../../../src/features/refgeom/pick';
import { axisSegment, drawnConstructs, EMPTY_HALF, planeSquare } from '../../../src/features/refgeom/scene';
import type { PlaneFrame, Vec3 } from '../../../src/types/doc';

const TOP: PlaneFrame = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
const FRONT: PlaneFrame = { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] };
const RIGHT: PlaneFrame = { origin: [0, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] };
const near = (a: readonly number[], b: readonly number[], eps = 1e-12) => a.every((x, i) => Math.abs(x - b[i]) <= eps);

describe('reference plane geometry', () => {
  it('offset moves the plane along its normal and keeps its frame', () => {
    const p = offsetPlane(TOP, 20);
    expect(p).toEqual({ origin: [0, 0, 20], normal: [0, 0, 1], xdir: [1, 0, 0] });
    expect(offsetPlane(FRONT, 5).origin).toEqual([0, -5, 0]);
    expect(offsetPlane(TOP, -7.5).origin).toEqual([0, 0, -7.5]);
  });

  it('at an angle turns the plane about an axis in it (right hand), and refuses an axis across it', () => {
    const r = planeAtAngle(TOP, { origin: [0, 0, 0], dir: [1, 0, 0] }, 90);
    expect(r.ok).toBe(true);
    if (r.ok) expect(near(r.value.normal, [0, -1, 0])).toBe(true);
    const r30 = planeAtAngle(TOP, { origin: [0, 5, 0], dir: [1, 0, 0] }, 30);
    expect(r30.ok && near(r30.value.normal, [0, -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)])).toBe(true);
    // Through the axis: its origin is the axis point nearest the base origin.
    expect(r30.ok && near(r30.value.origin, [0, 5, 0])).toBe(true);
    // An axis parallel to the plane (above it) is fine; one through it is not.
    expect(planeAtAngle(TOP, { origin: [0, 0, 10], dir: [0, 1, 0] }, 45).ok).toBe(true);
    const bad = planeAtAngle(TOP, { origin: [0, 0, 0], dir: [0, 0, 1] }, 45);
    expect(bad).toEqual({ ok: false, message: 'the axis does not lie in the plane or run parallel to it' });
  });

  it('through three points: normal by the right-hand rule; refuses points on one line or doubled', () => {
    const r = planeThrough([0, 0, 0], [10, 0, 0], [0, 10, 5]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const n = [0, -50, 100].map((x) => x / Math.hypot(50, 100));
      expect(near(r.value.normal, n)).toBe(true);
      expect(r.value.xdir).toEqual([1, 0, 0]);
      expect(r.value.origin).toEqual([0, 0, 0]);
    }
    expect(planeThrough([0, 0, 0], [1, 1, 1], [2, 2, 2])).toEqual({ ok: false, message: 'the three points are on one line' });
    expect(planeThrough([0, 0, 0], [0, 0, 0], [2, 2, 2])).toEqual({ ok: false, message: 'two of the points are the same point' });
  });

  it('midplane: halfway between parallel planes (either facing), the equal-distance bisector of crossing ones', () => {
    const a = midplane(TOP, offsetPlane(TOP, 40));
    expect(a.ok && a.value.origin).toEqual([0, 0, 20]);
    // Opposite faces of a block (outward normals): the middle, facing as the first.
    const b = midplane({ origin: [0, 0, 30], normal: [0, 0, 1], xdir: [1, 0, 0] }, { origin: [0, 0, 10], normal: [0, 0, -1], xdir: [1, 0, 0] });
    expect(b.ok && b.value.origin).toEqual([0, 0, 20]);
    expect(b.ok && b.value.normal).toEqual([0, 0, 1]);
    // Top and Right cross on the Y axis: the bisector of equal signed distance is x = z.
    const c = midplane(TOP, RIGHT);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(near(c.value.normal, [-Math.SQRT1_2, 0, Math.SQRT1_2])).toBe(true);
      const d = (p: Vec3) => (p[0] - c.value.origin[0]) * c.value.normal[0] + (p[1] - c.value.origin[1]) * c.value.normal[1] + (p[2] - c.value.origin[2]) * c.value.normal[2];
      expect(Math.abs(d([5, 3, 5]))).toBeLessThan(1e-12);
    }
  });

  it('two planes cross on a line (the point nearest the given one); parallel ones do not', () => {
    const r = planesCross(FRONT, RIGHT, [3, 4, 7]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(near(r.value.dir, [0, 0, 1]) || near(r.value.dir, [0, 0, -1])).toBe(true);
      expect(near(r.value.origin, [0, 0, 7])).toBe(true);
    }
    expect(planesCross(TOP, offsetPlane(TOP, 3), [0, 0, 0])).toEqual({ ok: false, message: 'the planes are parallel, so they do not cross' });
  });

  it('normal to a curve, an axis through two points, Rodrigues rotation', () => {
    const p = planeNormalTo([1, 2, 3], [0, 0, 2]);
    expect(p.ok && p.value).toEqual({ origin: [1, 2, 3], normal: [0, 0, 1], xdir: [1, 0, 0] });
    expect(axisThrough([0, 0, 0], [0, 0, 5])).toEqual({ ok: true, value: { origin: [0, 0, 0], dir: [0, 0, 1] } });
    expect(axisThrough([1, 1, 1], [1, 1, 1]).ok).toBe(false);
    expect(near(rotate([1, 0, 0], [0, 0, 1], 90), [0, 1, 0])).toBe(true);
  });
});

describe('what the viewport draws', () => {
  it('a plane square over the bodies footprint on it (15 % wider); 50 mm with none', () => {
    const corners: Vec3[] = [];
    for (const x of [0, 40]) for (const y of [0, 30]) for (const z of [0, 20]) corners.push([x, y, z]);
    const sq = planeSquare({ origin: [0, 0, 25], normal: [0, 0, 1], xdir: [1, 0, 0] }, corners);
    expect(sq.center).toEqual([20, 15, 25]);
    expect(sq.half).toBeCloseTo(20 * 1.15, 12);
    expect(planeSquare(TOP, []).half).toBe(EMPTY_HALF);
  });

  it('an axis segment across the bodies, 10 % longer each way', () => {
    const seg = axisSegment([0, 0, 0], [0, 0, 2], [
      [0, 0, -5],
      [0, 0, 15],
    ]);
    expect(seg.a).toEqual([0, 0, -7]);
    expect(seg.b).toEqual([0, 0, 17]);
  });

  it('drawn: built CONSTRUCT features that are shown; planes left out in sketch mode', () => {
    const doc = { features: [{ id: 'f_p', type: 'ref_plane', name: 'Plane 1' }, { id: 'f_a', type: 'ref_axis', name: 'Axis 1' }, { id: 'f_q', type: 'ref_point', name: 'Point 1' }, { id: 'f_h', type: 'ref_point', name: 'Point 2' }] };
    const s = {
      doc,
      view: { sketches: { f_h: 'hidden' as const } },
      rebuild: { bodies: [], outputs: { f_p: { type: 'plane', frame: TOP }, f_a: { type: 'axis', origin: [0, 0, 0], dir: [0, 0, 1] }, f_q: { type: 'point', p: [1, 2, 3] }, f_h: { type: 'point', p: [0, 0, 0] } } },
    } as never;
    expect(drawnConstructs(s, 'model').map((d) => d.name)).toEqual(['Plane 1', 'Axis 1', 'Point 1']);
    expect(drawnConstructs(s, 'sketch').map((d) => d.name)).toEqual(['Axis 1', 'Point 1']);
  });
});

describe('picking', () => {
  // An orthographic-like projection: x, y on screen = model x, -y (px per mm 1), depth along -z.
  const project = (p: Vec3): [number, number] => [p[0], -p[1]];
  const ray = (x: number, y: number) => ({ origin: [x, -y, 100] as Vec3, dir: [0, 0, -1] as Vec3 });
  const plane = { feature: 'f_p', name: 'Plane 1', kind: 'plane' as const, plane: planeSquare({ origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] }, []) };
  const axis = { feature: 'f_a', name: 'Axis 1', kind: 'axis' as const, axis: { a: [-40, 0, 0] as Vec3, b: [40, 0, 0] as Vec3, dir: [1, 0, 0] as Vec3 } };
  const point = { feature: 'f_q', name: 'Point 1', kind: 'point' as const, point: [20, 0, 0] as Vec3 };

  it('a point beats an axis beats a plane; outside the square or 8 px is nothing', () => {
    const all = [plane, axis, point];
    expect(hitConstruct(all, { x: 21, y: 3, ray: ray(21, 3) }, project)?.feature).toBe('f_q');
    expect(hitConstruct(all, { x: -10, y: 5, ray: ray(-10, 5) }, project)?.feature).toBe('f_a');
    const p = hitConstruct(all, { x: -10, y: 30, ray: ray(-10, 30) }, project);
    expect(p?.feature).toBe('f_p');
    expect(p?.t).toBeCloseTo(90, 9);
    expect(hitConstruct(all, { x: 60, y: 60, ray: ray(60, 60) }, project)).toBeNull();
    // A field that takes planes only.
    expect(hitConstruct(all, { x: 21, y: 3, ray: ray(21, 3) }, project, ['plane'])?.feature).toBe('f_p');
  });
});
