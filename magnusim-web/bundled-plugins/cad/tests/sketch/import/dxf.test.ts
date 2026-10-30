// Import SVG/DXF, the DXF reader (src/sketch/import/dxf.ts): LWPOLYLINE bulges, ARC, CIRCLE,
// SPLINE, ELLIPSE, an INSERT of a block with its transform, $INSUNITS, TEXT skipped and counted,
// layers listed (one the file has off left out), the mirrored object coordinate system, Z
// projected with a note, splines of other degrees made exact, rational ones approximated (said),
// and binary DXF refused.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { curveSamples, deBoor, type DrawingCurve } from '../../../src/sketch/import/common';
import { planImport, readDrawing, summaryWords, tryReadDrawing } from '../../../src/sketch/import';
import type { Vec2 } from '../../../src/types/doc';
import { bytesOf, DXF_BINARY, DXF_OCS, DXF_PART, dxf } from './fixtures';

const near = (a: Vec2, b: Vec2, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1]), `${a} vs ${b}`).toBeLessThan(tol);
type Of<K extends DrawingCurve['kind']> = Extract<DrawingCurve, { kind: K }>;

describe('the DXF reader', () => {
  it('a part in inches: bulges as arcs, ARC, CIRCLE, SPLINE, ELLIPSE, a block inserted turned and scaled; TEXT skipped; layers', () => {
    const d = readDrawing('part.dxf', bytesOf(DXF_PART));
    expect(d.format).toBe('dxf');
    expect(d.mmPerUnit).toBe(25.4);
    expect(d.units).toBe('$INSUNITS 1: inches');
    expect(d.skipped).toEqual({ TEXT: 1 });
    expect(d.layers).toEqual([
      { name: '0', count: 10, off: false },
      { name: 'Parts', count: 4, off: false },
      { name: 'Hidden', count: 1, off: true },
    ]);
    expect(d.notes).toEqual(['Layers the file has off or frozen are left out: Hidden']);
    // The slot: line, a bulge-1 semicircle about (4, 1) counter-clockwise, line, a semicircle about (0, 1).
    const [l1, a1, l2, a2] = d.curves as [Of<'line'>, Of<'arc'>, Of<'line'>, Of<'arc'>];
    expect([l1.kind, a1.kind, l2.kind, a2.kind]).toEqual(['line', 'arc', 'line', 'arc']);
    near(a1.c, [4, 1]);
    expect(a1.r).toBeCloseTo(1, 12);
    near(a1.a, [4, 0]);
    near(a1.b, [4, 2]);
    expect(a1.ccw).toBe(true);
    near(a2.c, [0, 1]);
    near(a2.a, [0, 2]);
    near(a2.b, [0, 0]);
    // The half disc's arc, the spline as it is (clamped cubic), the ellipse.
    const arc = d.curves.find((c): c is Of<'arc'> => c.kind === 'arc' && Math.abs(c.c[0] - 8) < 1e-9)!;
    near(arc.a, [9, 1]);
    near(arc.b, [7, 1]);
    const sp = d.curves.find((c): c is Of<'bspline'> => c.kind === 'bspline')!;
    expect(sp).toMatchObject({ degree: 3, knots: [0, 1], mults: [4, 4], poles: [[10, 0], [11, 2], [12, -2], [13, 0]], layer: '0' });
    const el = d.curves.find((c): c is Of<'ellipse'> => c.kind === 'ellipse')!;
    near(el.c, [16, 1]);
    near(el.ux, [1, 0]);
    expect(el.A).toBeCloseTo(2, 12);
    expect(el.B).toBeCloseTo(1, 12);
    // The block: a unit square scaled 2 and turned 90 deg at (20, 0), on the INSERT's layer.
    const sq = d.curves.filter((c): c is Of<'line'> => c.kind === 'line' && c.layer === 'Parts');
    expect(sq.map((c) => [c.a, c.b].map((p) => p.map((x) => Math.round(x * 1e9) / 1e9 + 0)))).toEqual([
      [[20, 0], [20, 2]],
      [[20, 2], [18, 2]],
      [[18, 2], [18, 0]],
      [[18, 0], [20, 0]],
    ]);
    // Imported: inches to mm; the Hidden layer left out; every outline closed.
    const plan = planImport(d);
    expect(plan.summary.read).toEqual({ line: 8, arc: 3, circle: 1, ellipse: 1, spline: 1 });
    expect(plan.summary.openEnds).toBe(0);
    expect(plan.summary.size[0]).toBeCloseTo(21 * 25.4, 6);
    const w = summaryWords(plan.summary);
    expect(w).toMatchObject({ read: 'Read: 8 lines, 3 arcs, 1 circle, 1 ellipse, 1 spline', skipped: 'Skipped: 1 TEXT', open: 'Open ends: 0', scale: 'Scale: 1 unit = 25.4 mm ($INSUNITS 1: inches)', layers: 'Layers: 0 (10), Parts (4), Hidden (1); left out: Hidden' });
    near((plan.curves[1] as Of<'arc'>).c, [4 * 25.4, 25.4], 1e-9);
    // The person ticks Hidden: its line comes too; only Parts: the square alone.
    expect(planImport(d, { layers: ['0', 'Parts', 'Hidden'] }).summary.read.line).toBe(9);
    expect(planImport(d, { layers: ['Parts'] }).summary.read).toEqual({ line: 4 });
    expect(() => planImport(d, { layers: ['Walls'] })).toThrow('part.dxf has no layer "Walls" (its layers: 0, Parts, Hidden)');
  });

  it('a mirrored object coordinate system (extrusion -Z) mirrors X: the arc runs clockwise; Z off the plane is projected and said; no units read as mm', () => {
    const d = readDrawing('ocs.dxf', bytesOf(DXF_OCS));
    const [arc, line, pt] = d.curves as [Of<'arc'>, Of<'line'>, Of<'point'>];
    near(arc.c, [-5, 0]);
    near(arc.a, [-6, 0]);
    near(arc.b, [-5, 1]);
    expect(arc.ccw).toBe(false);
    // The arc's middle: the OCS 45 deg point, mirrored.
    const s = curveSamples(arc, 8);
    near(s[Math.floor(s.length / 2)], [-5 - Math.SQRT1_2, Math.SQRT1_2], 1e-9);
    near(line.a, [0, 0]);
    near(line.b, [-1, 0]);
    near(pt.p, [3, 4]);
    expect(d.mmPerUnit).toBe(1);
    expect(d.units).toBe('unitless: read as mm');
    expect(d.notes).toEqual(['1 curve lies off the drawing plane (Z not 0, or a tilted plane): projected onto it', 'It says no units ($INSUNITS): read as mm (set the scale if it is not)']);
  });

  it('splines of degree 2 and 4 are raised exactly (Bezier pieces); unclamped knots are clamped exactly; a rational one is approximated and said; fit points alone make a fit spline', () => {
    const poles: Vec2[] = [[0, 0], [1, 2], [3, 3], [5, 1], [6, -1], [8, 0]];
    const spline = (p: number, U: number[], extra: (string | number)[] = []) =>
      dxf([0, 'SECTION', 2, 'ENTITIES', 0, 'SPLINE', 8, '0', 70, 8, 71, p, 72, U.length, 73, poles.length, ...U.flatMap((u) => [40, u]), ...extra, ...poles.flatMap((q) => [10, q[0], 20, q[1], 30, 0]), 0, 'ENDSEC', 0, 'EOF']);
    // Degree 2, clamped with interior knots: as cubic Bezier pieces, the same curve.
    const U2 = [0, 0, 0, 1, 2, 3, 4, 4, 4];
    const [c2] = readDrawing('q.dxf', bytesOf(spline(2, U2))).curves as Of<'bspline'>[];
    expect(c2.degree).toBe(3);
    expect(c2.mults).toEqual([4, 3, 3, 3, 4]);
    const flat = (c: Of<'bspline'>) => c.knots.flatMap((k, i) => new Array(c.mults[i]).fill(k) as number[]);
    for (let i = 0; i <= 40; i++) near(deBoor(3, c2.poles, flat(c2), (i / 40) * 4), deBoor(2, poles, U2, (i / 40) * 4), 1e-9);
    // Degree 4, uniform (unclamped) knots: degree 5 pieces over the domain [U4, U6].
    const U4 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const [c4] = readDrawing('u.dxf', bytesOf(spline(4, U4))).curves as Of<'bspline'>[];
    expect(c4.degree).toBe(5);
    for (let i = 0; i <= 20; i++) near(deBoor(5, c4.poles, flat(c4), c4.knots[0] + ((c4.knots[c4.knots.length - 1] - c4.knots[0]) * i) / 20), deBoor(4, poles, U4, 4 + (2 * i) / 20), 1e-8);
    // Rational (weights not all equal): a fit curve through points of it, said in the notes.
    const W = [1, 2, 1, 1, 3, 1];
    const r = readDrawing('w.dxf', bytesOf(spline(3, [0, 0, 0, 0, 1, 2, 3, 3, 3, 3], W.flatMap((w) => [41, w]))));
    expect(r.curves.map((c) => c.kind)).toEqual(['fit']);
    expect(r.notes[0]).toBe('1 spline is rational or past degree 5: each made as a fit spline through points of it (close, not exact)');
    // Equal weights: not rational, exact.
    expect(readDrawing('e.dxf', bytesOf(spline(3, [0, 0, 0, 0, 1, 2, 3, 3, 3, 3], [41, 2, 41, 2, 41, 2, 41, 2, 41, 2, 41, 2]))).curves[0].kind).toBe('bspline');
    // Fit points only.
    const fit = readDrawing('f.dxf', bytesOf(dxf([0, 'SECTION', 2, 'ENTITIES', 0, 'SPLINE', 8, '0', 70, 8, 71, 3, 72, 0, 73, 0, 74, 3, 11, 0, 21, 0, 31, 0, 11, 5, 21, 3, 31, 0, 11, 10, 21, 0, 31, 0, 0, 'ENDSEC', 0, 'EOF'])));
    expect(fit.curves).toEqual([{ kind: 'fit', pts: [[0, 0], [5, 3], [10, 0]], closed: false, layer: '0' }]);
    expect(fit.notes[0]).toContain('fit points only');
  });

  it('a POLYLINE with VERTEXes and a bulge; a block that inserts itself is left out and counted once; an INSERT of no block is counted', () => {
    const d = readDrawing(
      'p.dxf',
      bytesOf(
        dxf([
          0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'LOOP', 10, 0, 20, 0, 30, 0, 0, 'INSERT', 8, '0', 2, 'LOOP', 10, 1, 20, 0, 30, 0, 0, 'ENDBLK', 0, 'ENDSEC',
          0, 'SECTION', 2, 'ENTITIES',
          0, 'POLYLINE', 8, '0', 66, 1, 70, 0, 10, 0, 20, 0, 30, 0,
          0, 'VERTEX', 8, '0', 10, 0, 20, 0, 30, 0, 42, -1,
          0, 'VERTEX', 8, '0', 10, 2, 20, 0, 30, 0,
          0, 'VERTEX', 8, '0', 10, 2, 20, 2, 30, 0,
          0, 'SEQEND', 8, '0',
          0, 'INSERT', 8, '0', 2, 'LOOP', 10, 0, 20, 0, 30, 0,
          0, 'INSERT', 8, '0', 2, 'NONE', 10, 0, 20, 0, 30, 0,
          0, 'ENDSEC', 0, 'EOF',
        ]),
      ),
    );
    const [a, l] = d.curves as [Of<'arc'>, Of<'line'>];
    expect(a.kind).toBe('arc');
    near(a.c, [1, 0]);
    expect(a.ccw).toBe(false);
    expect(l).toMatchObject({ kind: 'line', a: [2, 0], b: [2, 2] });
    expect(d.skipped).toEqual({ selfInsert: 1, missingBlock: 1 });
  });

  it('a binary DXF is refused with what to do; text that is not a DXF is refused', () => {
    expect(tryReadDrawing('b.dxf', DXF_BINARY)).toEqual({ refused: 'b.dxf is a binary DXF: save it as an ASCII DXF (R12 or later) and import that' });
    expect(tryReadDrawing('x.dxf', bytesOf('hello\nworld\n'))).toEqual({ refused: 'x.dxf is not an ASCII DXF drawing (line 1 is "hello", not a group code)' });
  });
});
