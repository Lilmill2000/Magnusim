// The Enclosure's geometry (src/features/enclosure/geometry.ts): each side's
// padding from Zero / Percent / Fixed or the user's own value, the box and the
// cylinder around a bounding box, the words when a side takes away the whole of
// the part, and where the drag arrows sit.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createUnitsService } from '../../../src/doc/units';
import { enclosureDef } from '../../../src/features/enclosure/def';
import { baseRadius, enclosureShape, paddingOf, resolveEnclosure, sideAnchors, sideCuts, sideLabel, sideMin, unionBox, type EnclosureValues } from '../../../src/features/enclosure/geometry';
import { draggedSide, dragMin } from '../../../src/features/enclosure/handles';
import { describeFace, placeWords } from '../../../src/naming';
import type { EnclosureOutput } from '../../../src/types/doc-service';
import { emptyDoc } from '../../../src/doc/schema';
import type { EnclosureFeature } from '../../../src/types/doc';
import type { BBox } from '../../../src/types/kernel-protocol';

const doc = emptyDoc('metric');
const units = createUnitsService(
  () => doc.units,
  () => [{ id: 'p_m', name: 'margin', expr: '25 mm', quantity: 'length' }],
);
const make = (patch: Partial<EnclosureFeature> = {}) => enclosureDef.create(doc, patch) as EnclosureFeature;
const values = (patch: Partial<EnclosureFeature> = {}): EnclosureValues => {
  const r = resolveEnclosure(make(patch), units);
  if (!r.ok) throw new Error(r.message);
  return r.values;
};
/** A 100 x 60 x 20 part from (-50, -30, 0). */
const PART: BBox = [-50, -30, 0, 50, 30, 20];

describe('Enclosure geometry', () => {
  it('a new Enclosure is a box, tight to the part (Zero padding), around every solid body, with the 10 % and 10 mm kept for later', () => {
    const f = make();
    expect(f).toMatchObject({ name: 'Enclosure 1', shape: 'box', axis: 'origin:z', bodies: [], padding: 'zero', percent: '10', distance: '10 mm', sides: {} });
    expect(f.creates).toMatch(/^b_/);
    const s = enclosureShape(values(), PART);
    expect(s).toEqual({ ok: true, shape: { kind: 'box', min: [-50, -30, 0], max: [50, 30, 20], pad: { '+x': 0, '-x': 0, '+y': 0, '-y': 0, '+z': 0, '-z': 0 } } });
  });

  it('Fixed moves every side out by the distance; Percent by that share of the part size in each direction', () => {
    const fixed = enclosureShape(values({ padding: 'fixed', distance: '100 mm' }), PART);
    expect(fixed.ok && fixed.shape.kind === 'box' && [fixed.shape.min, fixed.shape.max]).toEqual([
      [-150, -130, -100],
      [150, 130, 120],
    ]);
    const pct = enclosureShape(values({ padding: 'percent', percent: '50' }), PART);
    // 50 % of 100 (X), 60 (Y) and 20 (Z) on each side.
    expect(pct.ok && pct.shape.kind === 'box' && [pct.shape.min, pct.shape.max]).toEqual([
      [-100, -60, -10],
      [100, 60, 30],
    ]);
  });

  it('a side set on its own keeps its value; the others follow the padding (and a parameter)', () => {
    const v = values({ padding: 'fixed', distance: 'margin', sides: { '+x': '200 mm', '-z': '0 mm' } });
    expect(paddingOf('+x', v, PART)).toBe(200);
    expect(paddingOf('-x', v, PART)).toBe(25);
    expect(paddingOf('-z', v, PART)).toBe(0);
    const s = enclosureShape(v, PART);
    expect(s.ok && s.shape.kind === 'box' && [s.shape.min, s.shape.max]).toEqual([
      [-75, -55, 0],
      [250, 55, 45],
    ]);
    // Sides of the other shape are not read (a cylinder's Top while the shape is Box).
    expect(resolveEnclosure(make({ sides: { top: 'nonsense' } }), units).ok).toBe(true);
  });

  it('a cylinder about Z passes through the bounding box corners with no padding; Radius, Top and Bottom move out from there', () => {
    expect(baseRadius(PART, 'origin:z')).toBeCloseTo(Math.hypot(100, 60) / 2, 12);
    const s = enclosureShape(values({ shape: 'cylinder', padding: 'fixed', distance: '10 mm', sides: { top: '30 mm' } }), PART);
    if (!s.ok || s.shape.kind !== 'cylinder') throw new Error('no cylinder');
    expect(s.shape.base).toEqual([0, 0, -10]);
    expect(s.shape.axis).toEqual([0, 0, 1]);
    expect(s.shape.r).toBeCloseTo(Math.hypot(100, 60) / 2 + 10, 12);
    expect(s.shape.h).toBe(20 + 10 + 30);
    // About X: the axis through the middle of Y and Z; the radius from the Y-Z corners.
    const x = enclosureShape(values({ shape: 'cylinder', axis: 'origin:x' }), PART);
    if (!x.ok || x.shape.kind !== 'cylinder') throw new Error('no cylinder');
    expect(x.shape.base).toEqual([-50, 0, 10]);
    expect(x.shape.r).toBeCloseTo(Math.hypot(60, 20) / 2, 12);
    expect(x.shape.h).toBe(100);
    // Percent: of r0 for the radius, of the length for the ends.
    const p = enclosureShape(values({ shape: 'cylinder', padding: 'percent', percent: '10' }), PART);
    if (!p.ok || p.shape.kind !== 'cylinder') throw new Error('no cylinder');
    expect(p.shape.r).toBeCloseTo(1.1 * (Math.hypot(100, 60) / 2), 12);
    expect(p.shape.h).toBeCloseTo(20 * 1.2, 12);
  });

  it('says why when a side takes away more than the part, and refuses a negative padding', () => {
    expect(enclosureShape(values({ sides: { '+x': '-60 mm', '-x': '-50 mm' } }), PART)).toEqual({ ok: false, message: "The enclosure has no size along X: the −X and +X sides take away the part's whole X size", sides: ['-x', '+x'] });
    expect(enclosureShape(values({ shape: 'cylinder', sides: { radius: '-100 mm' } }), PART)).toEqual({ ok: false, message: "The enclosure has no radius: the Radius side takes away the part's whole radius", sides: ['radius'] });
    expect(resolveEnclosure(make({ padding: 'fixed', distance: '-1 mm' }), units)).toEqual({ ok: false, message: 'Distance must not be negative' });
    expect(resolveEnclosure(make({ padding: 'percent', percent: '-5' }), units)).toEqual({ ok: false, message: 'Percent must not be negative' });
    expect(resolveEnclosure(make({ sides: { '+y': 'w' } }), units)).toEqual({ ok: false, message: '+Y: Unknown parameter "w"' });
    // A side may go into the part (a symmetry plane), as long as some part is left.
    const half = enclosureShape(values({ sides: { '-y': '-30 mm' } }), PART);
    expect(half.ok && half.shape.kind === 'box' && half.shape.min[1]).toBe(0);
  });

  it('puts a drag arrow on each side, pointing out', () => {
    const s = enclosureShape(values({ padding: 'fixed', distance: '10 mm' }), PART);
    if (!s.ok) throw new Error(s.message);
    expect(sideAnchors(s.shape)).toEqual([
      { side: '+x', base: [60, 0, 10], dir: [1, 0, 0] },
      { side: '-x', base: [-60, 0, 10], dir: [-1, 0, 0] },
      { side: '+y', base: [0, 40, 10], dir: [0, 1, 0] },
      { side: '-y', base: [0, -40, 10], dir: [0, -1, 0] },
      { side: '+z', base: [0, 0, 30], dir: [0, 0, 1] },
      { side: '-z', base: [0, 0, -10], dir: [0, 0, -1] },
    ]);
    const c = enclosureShape(values({ shape: 'cylinder' }), PART);
    if (!c.ok || c.shape.kind !== 'cylinder') throw new Error('no cylinder');
    const r = c.shape.r;
    expect(sideAnchors(c.shape)).toEqual([
      { side: 'radius', base: [r, 0, 10], dir: [1, 0, 0] },
      { side: 'top', base: [0, 0, 20], dir: [0, 0, 1] },
      { side: 'bottom', base: [0, 0, 0], dir: [-0, -0, -1] },
    ]);
  });

  it("refuses a side moved past the part's far side (it would hold none of the part); a side into the part is allowed and flagged", () => {
    // SD review round 1: −X = −60 on a 40 mm block made a 5 mm slab beside it, and the row stayed ok.
    expect(enclosureShape(values({ sides: { '-x': '-100 mm' } }), PART)).toEqual({ ok: false, message: '−X would put the enclosure past the part (padding more than −100 mm)', sides: ['-x'] });
    expect(enclosureShape(values({ sides: { '-x': '-160 mm' } }), PART)).toEqual({ ok: false, message: '−X would put the enclosure past the part (padding more than −100 mm)', sides: ['-x'] });
    expect(enclosureShape(values({ sides: { '+y': '-60 mm' } }), PART)).toEqual({ ok: false, message: '+Y would put the enclosure past the part (padding more than −60 mm)', sides: ['+y'] });
    expect(enclosureShape(values({ shape: 'cylinder', sides: { top: '-20 mm' } }), PART)).toEqual({ ok: false, message: 'Top would put the enclosure past the part (padding more than −20 mm)', sides: ['top'] });
    expect(enclosureShape(values({ shape: 'cylinder', axis: 'origin:x', sides: { bottom: '-100 mm' } }), PART)).toEqual({ ok: false, message: '−X end would put the enclosure past the part (padding more than −100 mm)', sides: ['bottom'] });
    // The words follow the units the caller gives.
    expect(enclosureShape(values({ sides: { '-x': '-100 mm' } }), PART, (mm) => `${mm / 25.4} in`)).toEqual({ ok: false, message: '−X would put the enclosure past the part (padding more than −3.937007874015748 in)', sides: ['-x'] });
    // Just inside the far side: allowed, and it cuts into the part.
    const v = values({ sides: { '-x': '-99.9 mm' } });
    const s = enclosureShape(v, PART);
    expect(s.ok && s.shape.kind === 'box' && Number(s.shape.min[0].toFixed(6))).toBe(49.9);
    expect(sideCuts('-x', v, PART)).toBe(true);
    expect(sideCuts('+x', v, PART)).toBe(false);
    // The least each side can take: the part's size, less what the opposite side already took.
    expect(sideMin('-x', values(), PART)).toBeCloseTo(-100, 5);
    expect(sideMin('-x', values({ sides: { '+x': '-30 mm' } }), PART)).toBeCloseTo(-70, 5);
    expect(sideMin('radius', values({ shape: 'cylinder' }), PART)).toBeCloseTo(-baseRadius(PART, 'origin:z'), 5);
    // A cylinder's Radius never leaves the part (its axis runs through it): a small one is allowed, flagged.
    const thin = values({ shape: 'cylinder', sides: { radius: '-50 mm' } });
    expect(enclosureShape(thin, PART).ok).toBe(true);
    expect(sideCuts('radius', thin, PART)).toBe(true);
  });

  it("a dragged arrow stops at the part's far side", () => {
    const out: EnclosureOutput = { type: 'enclosure', bodies: ['b_1'], bbox: [0, 0, 0, 40, 30, 20], pad: { '+x': 12.7, '-x': 12.7, '+y': 12.7, '-y': 12.7, '+z': 12.7, '-z': 12.7 }, box: { min: [-12.7, -12.7, -12.7], max: [52.7, 42.7, 32.7] } };
    const units = { length: 'mm', angle: 'deg' } as const;
    expect(dragMin(out, '-x')).toBeCloseTo(-40, 5);
    // 20 mm in: allowed (into the part), not limited.
    expect(draggedSide(out, '-x', -32.7, 0.1, units)).toEqual({ expr: '-20 mm', mm: -20, limited: false });
    // 80 mm in: stops just inside the far side.
    const far = draggedSide(out, '-x', -80, 0.1, units)!;
    expect(far.limited).toBe(true);
    expect(far.mm).toBeGreaterThan(-40);
    expect(far.mm).toBeLessThan(-39.8);
    // With +X already 30 mm in, −X stops where the box would have no size.
    expect(dragMin({ ...out, pad: { ...out.pad, '+x': -30 } }, '-x')).toBeCloseTo(-10, 5);
  });

  it("names a cylinder's ends by its axis, and Measure and the pick lists say which side a face is", () => {
    expect(sideLabel('top')).toBe('Top');
    expect(sideLabel('bottom', 'origin:z')).toBe('Bottom');
    expect(sideLabel('top', 'origin:x')).toBe('+X end');
    expect(sideLabel('bottom', 'origin:y')).toBe('−Y end');
    expect(sideLabel('-x', 'origin:x')).toBe('−X');
    expect(placeWords('F:f_1:enclosure:+z')).toBe('+Z face');
    expect(placeWords('F:f_1:enclosure:-x')).toBe('−X face');
    expect(placeWords('F:f_1:enclosure:top')).toBe('Top face');
    expect(placeWords('F:f_1:enclosure:+x-end')).toBe('+X end');
    expect(placeWords('F:f_1:enclosure:side')).toBe('Side face');
    expect(placeWords('F:f_1:end')).toBeNull();
    expect(placeWords(null)).toBeNull();
    expect(describeFace('F:f_1:enclosure:-y-end', () => 'Enclosure 1')).toBe('−Y end of Enclosure 1');
    expect(describeFace('F:f_1:enclosure:+z', () => 'Enclosure 1')).toBe('+Z face of Enclosure 1');
  });

  it('unions bounding boxes', () => {
    expect(unionBox([])).toBeNull();
    expect(unionBox([PART, [40, 0, -5, 80, 10, 5]])).toEqual([-50, -30, -5, 80, 30, 20]);
  });

  it('lists its expressions and renames a parameter in them only', () => {
    const f = make({ padding: 'fixed', distance: 'margin', sides: { '+x': 'margin * 2' } });
    expect(enclosureDef.exprs!(f)).toEqual([
      { path: 'percent', expr: '10' },
      { path: 'distance', expr: 'margin' },
      { path: 'sides.+x', expr: 'margin * 2' },
    ]);
    const g = enclosureDef.mapExprs!(f, (e) => e.replace('margin', 'gap'));
    expect(g).toMatchObject({ distance: 'gap', sides: { '+x': 'gap * 2' }, shape: 'box', creates: f.creates });
  });
});
