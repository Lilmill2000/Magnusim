// P4b SELECT: the box selection's maths (src/viewport/boxselect.ts) and the sketch box's
// hits (src/sketch/select-tool.ts sketchBoxHits): which way a box was dragged, enclose and
// touch on points, polylines and triangles, the filter's kinds and words, Shift / Ctrl.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { allInRect, boxCaption, boxCombine, boxFrom, boxKinds, boxStarts, combineSelection, pointInTriangle, polylineMeetsRect, rectInRect, rectsMeet, segmentMeetsRect, triangleMeetsRect } from '../../src/viewport/boxselect';
import { hitOptions, selectTakesPress, sketchBoxCaption, sketchBoxHits } from '../../src/sketch/select-tool';
import type { SketchFeature, Vec2 } from '../../src/types/doc';

const R = { x0: 10, y0: 10, x1: 50, y1: 30 };

describe('box direction', () => {
  it('left to right encloses, right to left touches, corners sorted', () => {
    expect(boxFrom(10, 30, 50, 10)).toEqual({ rect: R, mode: 'enclose' });
    expect(boxFrom(50, 10, 10, 30)).toEqual({ rect: R, mode: 'touch' });
    // Straight up or down (no sideways move) counts as left to right.
    expect(boxFrom(20, 40, 20, 5).mode).toBe('enclose');
  });
});

describe('enclose', () => {
  it('every point inside, edges included; an empty list is not inside', () => {
    expect(allInRect(R, [10, 10, 50, 30, 30, 20])).toBe(true);
    expect(allInRect(R, [10, 10, 50.01, 30])).toBe(false);
    expect(allInRect(R, [])).toBe(false);
  });
  it('a box inside a box', () => {
    expect(rectInRect(R, { x0: 12, y0: 12, x1: 40, y1: 28 })).toBe(true);
    expect(rectInRect(R, { x0: 5, y0: 12, x1: 40, y1: 28 })).toBe(false);
  });
});

describe('touch', () => {
  it('a segment that crosses the box with both ends outside', () => {
    expect(segmentMeetsRect(R, 0, 20, 100, 20)).toBe(true);
    expect(segmentMeetsRect(R, 30, 0, 30, 100)).toBe(true);
    // Diagonal past a corner, missing it.
    expect(segmentMeetsRect(R, 0, 40, 9, 31)).toBe(false);
    expect(segmentMeetsRect(R, 0, 0, 100, 0)).toBe(false);
    // Touching an edge counts.
    expect(segmentMeetsRect(R, 0, 10, 100, 10)).toBe(true);
  });
  it('a polyline: any point inside or any segment across; a single point', () => {
    expect(polylineMeetsRect(R, [0, 0, 5, 5, 60, 25])).toBe(true);
    expect(polylineMeetsRect(R, [0, 0, 5, 5])).toBe(false);
    expect(polylineMeetsRect(R, [20, 20])).toBe(true);
  });
  it('a triangle that holds the whole box touches it', () => {
    expect(triangleMeetsRect(R, -100, -100, 200, -100, 0, 200)).toBe(true);
    expect(triangleMeetsRect(R, 60, 0, 80, 0, 70, 5)).toBe(false);
    expect(pointInTriangle(1, 1, 0, 0, 4, 0, 0, 4)).toBe(true);
    expect(pointInTriangle(3, 3, 0, 0, 4, 0, 0, 4)).toBe(false);
  });
  it('two boxes overlapping or apart', () => {
    expect(rectsMeet(R, { x0: 45, y0: 25, x1: 60, y1: 40 })).toBe(true);
    expect(rectsMeet(R, { x0: 51, y0: 25, x1: 60, y1: 40 })).toBe(false);
  });
});

describe('filter, words, modifiers', () => {
  it('no filter boxes edges (SolidWorks); a filter its kinds; planes never', () => {
    expect(boxKinds([])).toEqual(['edge']);
    expect(boxKinds(['face', 'vertex'])).toEqual(['face', 'vertex']);
    expect(boxKinds(['origin'])).toEqual([]);
    expect(boxCaption('enclose', ['edge'])).toBe('Enclose · edges');
    expect(boxCaption('touch', ['body', 'face'])).toBe('Touch · bodies, faces');
    expect(boxCaption('touch', [])).toBe('Nothing to box: planes are picked by clicking');
  });
  it('mouse binding (2026-10-06): only Ctrl + left drag boxes; plain left orbits, Alt always moves the camera', () => {
    expect(boxStarts({ button: 0, ctrl: true, alt: false })).toBe(true);
    expect(boxStarts({ button: 0, ctrl: false, alt: false })).toBe(false);
    expect(boxStarts({ button: 0, ctrl: true, alt: true })).toBe(false);
    expect(boxStarts({ button: 1, ctrl: true, alt: false })).toBe(false);
    expect(boxStarts({ button: 2, ctrl: true, alt: false })).toBe(false);
    // Sketch mode's Select tool: Ctrl anywhere, or a press on geometry (to drag it); else the viewport's.
    expect(selectTakesPress({ ctrl: true }, null)).toBe(true);
    expect(selectTakesPress({ ctrl: false }, null)).toBe(false);
    expect(selectTakesPress({ ctrl: false }, { what: 'entity', id: 'e_1' })).toBe(true);
    expect(selectTakesPress({ ctrl: false }, { what: 'point', id: 'p_1' })).toBe(true);
    expect(selectTakesPress({ ctrl: false }, { what: 'constraint', id: 'c_1' })).toBe(false);
  });
  it('a box replaces (an empty one clears), Ctrl+Shift adds; toggle stays for Ctrl+click', () => {
    expect(boxCombine({ shift: false })).toBe('replace');
    expect(boxCombine({ shift: true })).toBe('add');
    const k = (s: string) => s;
    expect(combineSelection(['a', 'b'], ['b', 'c'], 'replace', k)).toEqual(['b', 'c']);
    expect(combineSelection(['a', 'b'], ['b', 'c'], 'add', k)).toEqual(['a', 'b', 'c']);
    expect(combineSelection(['a', 'b'], ['b', 'c'], 'toggle', k)).toEqual(['a', 'c']);
  });
  it('sketch filter: words and click kinds', () => {
    expect(sketchBoxCaption('enclose', [])).toBe('Enclose · curves, points, dimensions');
    expect(sketchBoxCaption('touch', ['dimension', 'point'])).toBe('Touch · points, dimensions');
    expect(hitOptions([])).toEqual({ points: true, entities: true });
    expect(hitOptions(['point'])).toEqual({ points: true, entities: false });
  });
});

describe('sketch box hits', () => {
  // Line 1 (0,0)-(30,0), Line 2 (0,20)-(60,20), Circle 1 at (80,10) r 5, Point 1 at (10,10); screen = u, -v (+ 100).
  const f: Pick<SketchFeature, 'points' | 'entities'> = {
    points: { a: [0, 0], b: [30, 0], c: [0, 20], d: [60, 20], o: [80, 10], p: [10, 10] },
    entities: [
      { id: 'l1', kind: 'line', p: ['a', 'b'] },
      { id: 'l2', kind: 'line', p: ['c', 'd'] },
      { id: 'c1', kind: 'circle', c: 'o', r: 5 },
      { id: 'pe', kind: 'point', p: 'p' },
    ],
  };
  const screen = (uv: Vec2): [number, number] => [uv[0], 100 - uv[1]];
  const box = { x0: -5, y0: 75, x1: 35, y1: 105 };
  it('enclose takes what lies wholly inside; touch what it meets', () => {
    expect(sketchBoxHits(f, box, 'enclose', screen)).toEqual([
      { what: 'entity', id: 'l1' },
      { what: 'entity', id: 'pe' },
    ]);
    expect(sketchBoxHits(f, box, 'touch', screen).map((h) => h.id)).toEqual(['l1', 'l2', 'pe']);
  });
  it('a circle crossed by a box (no sample inside) is touched, not enclosed', () => {
    const across = { x0: 70, y0: 89, x1: 90, y1: 91 };
    expect(sketchBoxHits(f, across, 'touch', screen).map((h) => h.id)).toEqual(['c1']);
    expect(sketchBoxHits(f, across, 'enclose', screen)).toEqual([]);
  });
  it('the Points filter takes the ends of curves and point entities; Curves only curves', () => {
    expect(sketchBoxHits(f, box, 'enclose', screen, ['point']).map((h) => `${h.what}:${h.id}`)).toEqual(['entity:pe', 'point:a', 'point:b', 'point:c']);
    expect(sketchBoxHits(f, box, 'enclose', screen, ['curve']).map((h) => h.id)).toEqual(['l1']);
  });
  it('dimension labels by their screen box', () => {
    const dims = [{ id: 'd1', rect: { x0: 10, y0: 105, x1: 20, y1: 112 } }];
    expect(sketchBoxHits(f, { x0: 0, y0: 100, x1: 30, y1: 120 }, 'enclose', screen, ['dimension'], dims)).toEqual([{ what: 'constraint', id: 'd1' }]);
    expect(sketchBoxHits(f, { x0: 0, y0: 100, x1: 15, y1: 120 }, 'enclose', screen, ['dimension'], dims)).toEqual([]);
    expect(sketchBoxHits(f, { x0: 0, y0: 100, x1: 15, y1: 120 }, 'touch', screen, ['dimension'], dims)).toEqual([{ what: 'constraint', id: 'd1' }]);
  });
  it('a point behind the camera (no screen place) is never inside', () => {
    expect(sketchBoxHits(f, box, 'enclose', () => null)).toEqual([]);
  });
});

describe('P4b fix round 1, polish 3: a drifting Ctrl+click stays a click', () => {
  it('a Ctrl press boxes only past twice the click distance', async () => {
    const { BOX_START_PX } = await import('../../src/viewport/boxselect');
    const { CLICK_PX } = await import('../../src/viewport/colors');
    expect(BOX_START_PX).toBeGreaterThanOrEqual(2 * CLICK_PX);
    // The review's 6 x 2 px drift is under it.
    expect(Math.hypot(6, 2)).toBeLessThan(BOX_START_PX);
  });
});
