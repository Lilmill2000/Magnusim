// Import SVG/DXF, the SVG reader (src/sketch/import/svg.ts): shapes, paths and transforms drawn
// exactly with y flipped, the units read from the root, and a hostile file read as data only:
// nothing in it runs, is fetched or reaches the page, and each such part is counted as skipped.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { curveSamples, deBoor, type DrawingCurve } from '../../../src/sketch/import/common';
import { planImport, readDrawing, summaryWords, tryReadDrawing } from '../../../src/sketch/import';
import type { Vec2 } from '../../../src/types/doc';
import { bytesOf, SVG_ARC, SVG_HOSTILE, SVG_MM, SVG_PX } from './fixtures';

const near = (a: Vec2, b: Vec2, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1]), `${a} vs ${b}`).toBeLessThan(tol);
const kinds = (cs: DrawingCurve[]) => cs.map((c) => c.kind);

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { __drawingRan?: unknown }).__drawingRan;
});

describe('the SVG reader', () => {
  it('mm over its viewBox: a rounded rectangle (4 lines, 4 arcs r 5), a circle, a cubic path in a transformed group, y up', () => {
    const d = readDrawing('plate.svg', bytesOf(SVG_MM));
    expect(d.format).toBe('svg');
    expect(d.mmPerUnit).toBeCloseTo(1, 12);
    expect(d.units).toBe('width 100mm over a viewBox 100 wide');
    expect(d.skipped).toEqual({});
    expect(kinds(d.curves)).toEqual(['line', 'arc', 'line', 'arc', 'line', 'arc', 'line', 'arc', 'circle', 'bspline', 'line', 'line', 'line']);
    const arcs = d.curves.filter((c): c is Extract<DrawingCurve, { kind: 'arc' }> => c.kind === 'arc');
    for (const a of arcs) expect(a.r).toBeCloseTo(5, 9);
    // The first corner (top right on paper): from (45, 10) to (50, 15) about (45, 15); flipped, clockwise.
    near(arcs[0].c, [45, -15]);
    near(arcs[0].a, [45, -10]);
    near(arcs[0].b, [50, -15]);
    expect(arcs[0].ccw).toBe(false);
    const circle = d.curves[8] as Extract<DrawingCurve, { kind: 'circle' }>;
    near(circle.c, [75, -25]);
    expect(circle.r).toBeCloseTo(10, 12);
    const cubic = d.curves[9] as Extract<DrawingCurve, { kind: 'bspline' }>;
    expect(cubic).toMatchObject({ degree: 3, knots: [0, 1], mults: [4, 4] });
    for (const [i, p] of ([[10, -40], [20, -30], [30, -50], [40, -40]] as Vec2[]).entries()) near(cubic.poles[i], p);
    near((d.curves[12] as Extract<DrawingCurve, { kind: 'line' }>).b, [10, -40]);
    const plan = planImport(d);
    expect(plan.summary.read).toEqual({ line: 7, arc: 4, circle: 1, spline: 1 });
    expect(plan.summary.openEnds).toBe(0);
    expect(plan.summary.size[0]).toBeCloseTo(75, 6);
    expect(plan.summary.size[1]).toBeCloseTo(36, 6);
    expect(summaryWords(plan.summary)).toMatchObject({ read: 'Read: 7 lines, 4 arcs, 1 circle, 1 spline', skipped: 'Skipped: nothing', size: 'Size: 75 × 36 mm', open: 'Open ends: 0', scale: 'Scale: 1 unit = 1 mm (width 100mm over a viewBox 100 wide)' });
  });

  it('px over its viewBox: 96 per inch; elliptical corners are ellipse arcs; a skewed circle is an ellipse', () => {
    const d = readDrawing('px.svg', bytesOf(SVG_PX));
    expect(d.mmPerUnit).toBeCloseTo(25.4 / 96, 12);
    expect(kinds(d.curves)).toEqual(['line', 'ellipse_arc', 'line', 'ellipse_arc', 'line', 'ellipse_arc', 'line', 'ellipse_arc', 'ellipse']);
    const corner = d.curves[1] as Extract<DrawingCurve, { kind: 'ellipse_arc' }>;
    expect(corner.A).toBeCloseTo(12, 9);
    expect(corner.B).toBeCloseTo(6, 9);
    // The skewed, turned circle: every point of it is the transform of the circle's.
    const e = d.curves[8] as Extract<DrawingCurve, { kind: 'ellipse' }>;
    const t = (Math.PI * 30) / 180;
    const k = Math.tan((Math.PI * 20) / 180);
    const map = (x: number, y: number): Vec2 => {
      const sx = x + k * y;
      return [Math.cos(t) * sx - Math.sin(t) * y, -(Math.sin(t) * sx + Math.cos(t) * y)];
    };
    near(e.c, map(40, 10), 1e-9);
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      const p = map(40 + 12 * Math.cos(a), 10 + 12 * Math.sin(a));
      // On the ellipse: its own equation in its frame.
      const q: Vec2 = [p[0] - e.c[0], p[1] - e.c[1]];
      const u = (q[0] * e.ux[0] + q[1] * e.ux[1]) / e.A;
      const v = (-q[0] * e.ux[1] + q[1] * e.ux[0]) / e.B;
      expect(u * u + v * v).toBeCloseTo(1, 9);
    }
    const plan = planImport(d);
    expect(plan.summary.size[0]).toBeCloseTo(25.4, 6);
    // No viewBox, no width: a user unit is a CSS px.
    const bare = readDrawing('bare.svg', bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="0" x2="96" y2="0"/></svg>'));
    expect(bare.mmPerUnit).toBeCloseTo(25.4 / 96, 12);
    expect(bare.units).toBe('CSS px, 96 per inch');
    expect(planImport(bare).summary.size[0]).toBeCloseTo(25.4, 9);
  });

  it("a path's arc keeps its sweep: over the top in the sketch, clockwise; relative commands, S and T reflections, a quadratic raised to a cubic", () => {
    const [arc] = readDrawing('arc.svg', bytesOf(SVG_ARC)).curves as Extract<DrawingCurve, { kind: 'arc' }>[];
    expect(arc.kind).toBe('arc');
    near(arc.c, [10, 0]);
    expect(arc.r).toBeCloseTo(10, 12);
    expect(arc.ccw).toBe(false);
    const mid = curveSamples(arc, 8)[Math.floor(curveSamples(arc, 8).length / 2)];
    expect(mid[1]).toBeGreaterThan(9.99);
    const d = readDrawing('cmds.svg', bytesOf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="m10 10 c0 10 10 10 10 0 s10-10 10 0 q5 5 10 0 t10 0"/></svg>'));
    expect(kinds(d.curves)).toEqual(['bspline', 'bspline', 'bspline', 'bspline']);
    const [c1, c2, q1, q2] = d.curves as Extract<DrawingCurve, { kind: 'bspline' }>[];
    near(c1.poles[0], [10, -10]);
    near(c1.poles[3], [20, -10]);
    // S reflects the last control point about the current point: (20, 20) about (20, 10) is (20, 0).
    near(c2.poles[1], [20, 0]);
    near(c2.poles[3], [30, -10]);
    // Q from (30, 10) through (35, 15) to (40, 10), raised: poles at 2/3 of the way to the control point.
    near(q1.poles[1], [30 + (2 / 3) * 5, -(10 + (2 / 3) * 5)]);
    expect(q1.degree).toBe(3);
    // T reflects (35, 15) about (40, 10): (45, 5); the curve's middle is exact.
    const U = [0, 0, 0, 0, 1, 1, 1, 1];
    near(deBoor(3, q2.poles, U, 0.5), [45, -(10 + 0.5 * (5 - 10))]);
  });

  it('a hostile SVG is read as data: nothing runs, is fetched or reaches the page; each part is counted as skipped', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const create = vi.spyOn(document, 'createElement');
    const createNs = vi.spyOn(document, 'createElementNS');
    const before = document.documentElement.outerHTML;
    const t0 = performance.now();
    const d = readDrawing('hostile.svg', bytesOf(SVG_HOSTILE));
    // The entity bomb is never expanded: read at once.
    expect(performance.now() - t0).toBeLessThan(500);
    expect((window as unknown as { __drawingRan?: unknown }).__drawingRan).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(createNs).not.toHaveBeenCalled();
    expect(document.documentElement.outerHTML).toBe(before);
    expect(d.skipped).toEqual({ entity: 9, event: 3, script: 2, external: 3, foreignObject: 1, image: 1, use: 1, style: 1, text: 1, entityRef: 1, unreadable: 1 });
    expect(kinds(d.curves)).toEqual(['line', 'line', 'line', 'line', 'line']);
    const w = summaryWords(planImport(d).summary);
    expect(w.skipped).toBe(
      'Skipped: 9 entity declarations (never expanded), 3 event attributes (on..., never run), 2 scripts (never run), 3 links to other files (never fetched), 1 embedded page (foreignObject, never shown), 1 image, 1 use reference, 1 style sheet, 1 text, 1 entity reference (never expanded), 1 shape with numbers that cannot be read',
    );
    expect(w.read).toBe('Read: 5 lines');
  });

  it('hidden elements, definitions and other vocabularies are left out; a file that is not an SVG is refused', () => {
    const d = readDrawing(
      'mixed.svg',
      bytesOf(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 10 10">
        <defs><circle id="c" r="3"/></defs>
        <clipPath id="k"><rect width="2" height="2"/></clipPath>
        <g style="fill:none;display:none"><line x1="0" y1="0" x2="1" y2="1"/></g>
        <inkscape:path d="M0 0 L5 5"/>
        <circle r="2" cx="5" cy="5"/>
        <blink/>
      </svg>`),
    );
    expect(kinds(d.curves)).toEqual(['circle']);
    expect(d.skipped).toEqual({ defs: 2, hidden: 1, other: 1 });
    expect(tryReadDrawing('page.svg', bytesOf('<html><body>no drawing</body></html>'))).toEqual({ refused: 'page.svg is not an SVG drawing (it has no <svg> element)' });
    expect(tryReadDrawing('notes.txt', bytesOf('just words'))).toEqual({ refused: 'notes.txt is not an SVG or a DXF drawing' });
  });

  it('a file past 20 MB is refused before it is read', () => {
    const big = new Uint8Array(20 * 1024 * 1024 + 1).fill(32);
    expect(tryReadDrawing('big.svg', big)).toEqual({ refused: 'big.svg is larger than 20 MB, the most a drawing can be' });
  });
});
