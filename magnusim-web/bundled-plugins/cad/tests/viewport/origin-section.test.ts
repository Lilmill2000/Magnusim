// Origin planes (auto: drawn on an empty part and while selected or hovered;
// sized to the bodies; picks only what is drawn) and the section plane (which
// side is kept, flip, the coordinate the chrome shows).
// SPDX-License-Identifier: GPL-3.0-or-later
import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { EMPTY_PLANE_HALF, OriginPlanes } from '../../src/viewport/origin';
import { offsetRange, originFrame, sectionPlane } from '../../src/viewport/section';
import { sectionAxis } from '../../src/viewport/ViewportChrome';

describe('OriginPlanes', () => {
  it('draws all planes, or only the selected / hovered ones, and picks only what is drawn', () => {
    const host = document.createElement('div');
    const o = new OriginPlanes(host);
    expect(host.querySelectorAll('.cad-vp-label')).toHaveLength(3);
    expect(o.picks().map((p) => p.ref)).toEqual(['origin:top', 'origin:front', 'origin:right']);
    expect(o.setShown(false)).toBe(true);
    expect(o.picks()).toEqual([]);
    o.setState({ 'origin:front': 'pick', 'origin:right': 'hover' });
    o.setShown(false);
    expect(o.picks().map((p) => p.ref)).toEqual(['origin:front', 'origin:right']);
    expect(host.querySelector('[data-plane-label="origin:front"]')!.getAttribute('data-state')).toBe('pick');
    o.setState({});
    o.setShown(false);
    expect(o.picks()).toEqual([]);
    o.setShown(true);
    expect(o.picks()).toHaveLength(3);
    o.dispose();
    expect(host.querySelector('.cad-vp-labels')).toBeNull();
  });

  it('sizes each plane to the footprint of the bodies on it and the origin, 15 % wider (review round 2)', () => {
    const o = new OriginPlanes(document.createElement('div'));
    expect(o.halfSize).toBe(EMPTY_PLANE_HALF);
    expect(o.box().min.toArray()).toEqual([-EMPTY_PLANE_HALF, -EMPTY_PLANE_HALF, -EMPTY_PLANE_HALF]);
    o.fitTo(new Box3(new Vector3(0, 0, 0), new Vector3(10, 20, 300)));
    o.setShown(true);
    const [top, front, right] = o.picks();
    // Top (XY): 10 x 20 from the origin -> a 23 mm square centred at (5, 10).
    expect(top.ref).toBe('origin:top');
    expect(top.half).toBeCloseTo(11.5, 9);
    expect(top.origin.toArray()).toEqual([5, 10, 0]);
    // Front (XZ) and Right (YZ): 300 tall.
    expect(front.half).toBeCloseTo(172.5, 9);
    expect(front.origin.x).toBeCloseTo(5, 9);
    expect(front.origin.z).toBeCloseTo(150, 9);
    expect(right.half).toBeCloseTo(172.5, 9);
    expect(o.halfSize).toBeCloseTo(172.5, 9);
    // A part away from the origin: the square still takes the origin in.
    o.fitTo(new Box3(new Vector3(100, 100, 0), new Vector3(120, 120, 20)));
    const t2 = o.picks()[0];
    expect(t2.half).toBeCloseTo(69, 9);
    expect(t2.origin.toArray()).toEqual([60, 60, 0]);
    // No body shown any more (rolled to the start, suppressed): they keep that size,
    // so they do not fill a view fitted to the part (review round 2).
    o.fitTo(null);
    expect(o.picks()[0].half).toBeCloseTo(69, 9);
    // A part that never showed a body gets the default size around the origin.
    const fresh = new OriginPlanes(document.createElement('div'));
    fresh.fitTo(null);
    expect(fresh.halfSize).toBe(EMPTY_PLANE_HALF);
  });
});

describe('section plane', () => {
  it('keeps the side behind the plane (away from its normal), Flip keeps the other', () => {
    // Front plane: normal -Y. Offset -10 along it is y = 10; kept: y >= 10.
    const p = sectionPlane({ frame: originFrame('origin:front'), offset: -10, flip: false });
    expect(p.distanceToPoint(new Vector3(0, 15, 0))).toBeGreaterThan(0);
    expect(p.distanceToPoint(new Vector3(0, 5, 0))).toBeLessThan(0);
    expect(p.distanceToPoint(new Vector3(3, 10, 7))).toBeCloseTo(0, 12);
    const f = sectionPlane({ frame: originFrame('origin:front'), offset: -10, flip: true });
    expect(f.distanceToPoint(new Vector3(0, 5, 0))).toBeGreaterThan(0);
    expect(f.distanceToPoint(new Vector3(0, 15, 0))).toBeLessThan(0);
    // Top plane: normal +Z, offset 4 is z = 4; kept: z <= 4.
    const t = sectionPlane({ frame: originFrame('origin:top'), offset: 4, flip: false });
    expect(t.distanceToPoint(new Vector3(0, 0, 1))).toBeGreaterThan(0);
    expect(t.distanceToPoint(new Vector3(0, 0, 9))).toBeLessThan(0);
  });

  it('cuts any plane at its own origin plus the offset along its own normal (a construction plane at an angle)', () => {
    // A plane through (0, 0, 10) tilted 45 degrees about Y: normal (s, 0, s).
    const s = Math.SQRT1_2;
    const frame = { origin: [0, 0, 10] as [number, number, number], normal: [s, 0, s] as [number, number, number] };
    const at0 = sectionPlane({ frame, offset: 0, flip: false });
    expect(at0.distanceToPoint(new Vector3(0, 0, 10))).toBeCloseTo(0, 12);
    // Unflipped: the side against the normal stays (the origin, below the plane), the other goes.
    expect(at0.distanceToPoint(new Vector3(0, 0, 0))).toBeGreaterThan(0);
    expect(at0.distanceToPoint(new Vector3(10, 0, 10))).toBeLessThan(0);
    // Offset 2 along the normal: through (0, 0, 10) + 2 n; Flip keeps the other side.
    const moved = sectionPlane({ frame, offset: 2, flip: true });
    expect(moved.distanceToPoint(new Vector3(2 * s, 0, 10 + 2 * s))).toBeCloseTo(0, 12);
    expect(moved.distanceToPoint(new Vector3(10, 0, 10))).toBeGreaterThan(0);
    // A normal that is not of unit length cuts the same.
    expect(sectionPlane({ frame: { origin: frame.origin, normal: [3, 0, 3] }, offset: 2, flip: true }).distanceToPoint(new Vector3(10, 0, 10))).toBeCloseTo(moved.distanceToPoint(new Vector3(10, 0, 10)), 12);
  });

  it("gives the offsets a box spans along a plane's normal (the range and its middle)", () => {
    // Front (normal -Y): a box from y = 0 to 20 spans offsets -20 to 0.
    expect(offsetRange(originFrame('origin:front'), [[0, 0, 0, 10, 20, 30]])).toEqual([-20, 0]);
    // A tilted plane through (0, 0, 10): the cube [0, 10]^3 spans (0 - 10) s to (10 + 10 - 10) s.
    const s = Math.SQRT1_2;
    const r = offsetRange({ origin: [0, 0, 10], normal: [s, 0, s] }, [[0, 0, 0, 10, 10, 10]])!;
    expect(r[0]).toBeCloseTo(-10 * s, 12);
    expect(r[1]).toBeCloseTo(10 * s, 12);
    expect(offsetRange(originFrame('origin:top'), [])).toBeNull();
  });

  it('shows the cut as the coordinate it fixes', () => {
    expect(sectionAxis('origin:front')).toEqual({ label: 'Y', sign: -1 });
    expect(sectionAxis('origin:top')).toEqual({ label: 'Z', sign: 1 });
    expect(sectionAxis('origin:right')).toEqual({ label: 'X', sign: 1 });
    // Any other plane: its offset along its own normal.
    expect(sectionAxis({ kind: 'origin', plane: 'origin:front' })).toEqual({ label: 'Y', sign: -1 });
    expect(sectionAxis({ kind: 'feature', feature: 'f_1' })).toEqual({ label: 'Offset', sign: 1 });
  });
});
