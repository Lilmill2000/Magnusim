// Review P1 (press-pull fix round 1): the ci2 gap rule for angle labels. A line's angle
// label used to sit on the bisector at 0.4 of the line's length, so a 10° label's pill lay
// on the line it measures (0 px) and a click meant for the line picked the label. Now its
// near side is LABEL_GAP_PX from both arms, however wide its words are.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { angleLabelAt, defaultLabelAt, LABEL_GAP_PX, type LabelReach } from '../../src/sketch/dimensions';
import type { SketchFeature, Vec2 } from '../../src/types/doc';

const PX = 0.2; // mm per px
/** A pill of w x h px, upright on a screen that shows the sketch square-on. */
const pill =
  (w: number, h: number): LabelReach =>
  (_at, dir) =>
    ((Math.abs(dir[0]) * w) / 2 + (Math.abs(dir[1]) * h) / 2) * PX;
/** The gap (px) between a w x h pill centred at p and the line through o at angle a. */
function gapPx(p: Vec2, o: Vec2, a: number, w: number, h: number): number {
  const n: Vec2 = [-Math.sin(a), Math.cos(a)];
  const d = Math.abs((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1]);
  return d / PX - (Math.abs(n[0]) * w) / 2 - (Math.abs(n[1]) * h) / 2;
}

describe('angle labels keep a gap from both arms', () => {
  for (const deg of [10, 30, 75, 120, -20, 170])
    for (const [w, h] of [
      [36, 18],
      [56, 22],
    ])
      it(`${deg}°, a ${w} x ${h} px pill: at least LABEL_GAP_PX from the line and from the horizontal`, () => {
        const th = (deg * Math.PI) / 180;
        const p = angleLabelAt([0, 0], 0, th, 28 * PX, PX, pill(w, h));
        expect(gapPx(p, [0, 0], 0, w, h)).toBeGreaterThanOrEqual(LABEL_GAP_PX - 1e-6);
        expect(gapPx(p, [0, 0], th, w, h)).toBeGreaterThanOrEqual(LABEL_GAP_PX - 1e-6);
        // On the bisector, inside the angle.
        const a = Math.atan2(p[1], p[0]);
        expect(a).toBeCloseTo(th / 2, 9);
      });

  it("a line's own angle: the reviewer's 10° line 40 long (the pill was on it), through defaultLabelAt", () => {
    const th = (10 * Math.PI) / 180;
    const f = {
      points: { a: [0, -30], b: [40 * Math.cos(th), -30 + 40 * Math.sin(th)] },
      entities: [{ id: 'l', kind: 'line', p: ['a', 'b'] }],
      constraints: [],
    } as unknown as SketchFeature;
    const p = defaultLabelAt(f, { kind: 'angle', refs: ['l'] }, PX, pill(36, 18))!;
    expect(gapPx(p, [0, -30], th, 36, 18)).toBeGreaterThanOrEqual(LABEL_GAP_PX - 1e-6);
    expect(gapPx(p, [0, -30], 0, 36, 18)).toBeGreaterThanOrEqual(LABEL_GAP_PX - 1e-6);
  });

  it('with no reach (a label not measured yet) the label stays where it was: 0.4 of the line or 28 px out', () => {
    const p = angleLabelAt([0, 0], 0, Math.PI / 2, 8, PX);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(8, 9);
  });

  it('two lines at 30°: the label clears both', () => {
    const th = (30 * Math.PI) / 180;
    const p = angleLabelAt([5, 5], Math.PI / 4, th, 28 * PX, PX, pill(40, 20));
    expect(gapPx(p, [5, 5], Math.PI / 4, 40, 20)).toBeGreaterThanOrEqual(LABEL_GAP_PX - 1e-6);
    expect(gapPx(p, [5, 5], Math.PI / 4 + th, 40, 20)).toBeGreaterThanOrEqual(LABEL_GAP_PX - 1e-6);
  });
});
