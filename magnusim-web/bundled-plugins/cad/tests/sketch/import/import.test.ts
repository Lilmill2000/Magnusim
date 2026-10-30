// Import SVG/DXF, the import itself (src/sketch/import/common.ts planImport, importIntoDraft):
// ends within the tolerance share one sketch point (a closed outline has no open end), ends
// farther apart stay open and are counted, duplicates and pieces too small to draw are left out
// and counted, the scale and the place (origin or centre), the cap on what it weighs for the sketch
// solver, and the sketch entities made (no relation added; a curve whose ends meet keeps two points).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { entityPoints } from '../../../src/sketch/model';
import { IMPORT_MAX_LOAD, importIntoDraft, planImport, readDrawing, summaryWords } from '../../../src/sketch/import';
import type { SketchEntity } from '../../../src/types/doc';
import { bytesOf, DXF_PART, dxf, manyLinesDxf, squareDxf, SVG_MM } from './fixtures';

const EMPTY = { points: {}, entities: [], constraints: [] };

describe('joining and the import', () => {
  it('a square of four lines whose ends miss by 1e-7 mm: four shared points, no open end, no relation added', () => {
    const plan = planImport(readDrawing('sq.dxf', bytesOf(squareDxf(1e-7))));
    expect(plan.summary).toMatchObject({ openEnds: 0, joins: 4, total: 4, tolerance: 1e-4 });
    const { outcome, added } = importIntoDraft(EMPTY, plan);
    expect(outcome.ok).toBe(true);
    const draft = (outcome as Extract<typeof outcome, { ok: true }>).draft;
    expect(Object.keys(draft.points)).toHaveLength(4);
    expect(draft.constraints).toEqual([]);
    expect(added).toEqual(draft.entities.map((e) => e.id));
    // Each corner is the end of two lines.
    const uses = new Map<string, number>();
    for (const e of draft.entities) for (const p of entityPoints(e)) uses.set(p, (uses.get(p) ?? 0) + 1);
    expect([...uses.values()]).toEqual([2, 2, 2, 2]);
  });

  it('ends 0.01 mm apart stay apart: their open ends are counted, in words', () => {
    const plan = planImport(readDrawing('gap.dxf', bytesOf(squareDxf(0.01))));
    expect(plan.summary).toMatchObject({ openEnds: 6, joins: 1 });
    expect(summaryWords(plan.summary).open).toBe('Open ends: 6 (where a curve ends and nothing else does)');
  });

  it('duplicates (a line again, the other way round) and pieces too small to draw are left out and counted', () => {
    const line = (a: number[], b: number[]) => [0, 'LINE', 8, '0', 10, a[0], 20, a[1], 11, b[0], 21, b[1]];
    const d = readDrawing('dup.dxf', bytesOf(dxf([0, 'SECTION', 2, 'ENTITIES', ...line([0, 0], [5, 0]), ...line([5, 0], [0, 0]), ...line([9, 9], [9, 9.00001]), 0, 'ENDSEC', 0, 'EOF'])));
    const plan = planImport(d);
    expect(plan.summary).toMatchObject({ total: 1, duplicates: 1, tooSmall: 1 });
    expect(summaryWords(plan.summary).skipped).toBe('Skipped: 1 duplicate (a curve on top of another), 1 too small to draw');
  });

  it('the scale and the place: the size follows the scale; centred, the box is about the origin', () => {
    const d = readDrawing('plate.svg', bytesOf(SVG_MM));
    const twice = planImport(d, { scale: 2 });
    expect(twice.summary.size[0]).toBeCloseTo(150, 6);
    expect(twice.summary.scale).toBe(2);
    expect(twice.summary.defaultScale).toBe(1);
    const c = planImport(d, { place: 'centre' }).summary.box!;
    expect(c.min[0] + c.max[0]).toBeCloseTo(0, 9);
    expect(c.min[1] + c.max[1]).toBeCloseTo(0, 9);
    expect(() => planImport(d, { scale: 0 })).toThrow('The scale must be a number above 0, not 0');
  });

  it('a curve whose two ends meet keeps two points there; an arc whose ends meet is its circle', () => {
    const d = readDrawing('loop.svg', bytesOf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0 C10 10 20 -10 0 0"/><path d="M50 0 A 5 5 0 1 1 50 0.00000001"/></svg>'));
    const plan = planImport(d);
    expect(plan.summary.read).toEqual({ spline: 1, circle: 1 });
    const { outcome } = importIntoDraft(EMPTY, plan);
    const s = (outcome as Extract<typeof outcome, { ok: true }>).draft.entities.find((e): e is Extract<SketchEntity, { kind: 'spline' }> => e.kind === 'spline')!;
    expect(s.pts[0]).not.toBe(s.pts[3]);
    expect(s).toMatchObject({ form: 'control', degree: 3, knots: [0, 1], mults: [4, 4] });
  });

  it('the sketch entities a DXF part makes: kinds, an ellipse by its centre, major and minor ends, a control spline with its knots', () => {
    const plan = planImport(readDrawing('part.dxf', bytesOf(DXF_PART)));
    const { outcome } = importIntoDraft(EMPTY, plan);
    const draft = (outcome as Extract<typeof outcome, { ok: true }>).draft;
    const kinds: Record<string, number> = {};
    for (const e of draft.entities) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    expect(kinds).toEqual({ line: 8, arc: 3, circle: 1, spline: 1, ellipse: 1 });
    const el = draft.entities.find((e): e is Extract<SketchEntity, { kind: 'ellipse' }> => e.kind === 'ellipse')!;
    const at = (id: string) => draft.points[id].map((x) => Math.round(x * 1e6) / 1e6);
    expect([at(el.c), at(el.major), at(el.minor)]).toEqual([[16 * 25.4, 25.4], [18 * 25.4, 25.4], [16 * 25.4, 2 * 25.4]]);
  });

  it(`a drawing that weighs more than ${IMPORT_MAX_LOAD.toLocaleString('en-US')} for the sketch solver is refused with its weight and why; one at the cap goes in`, () => {
    // 5,001 separate lines: 10,002 points.
    const over = planImport(readDrawing('many.dxf', bytesOf(manyLinesDxf(5_001))));
    expect(over.summary.refused).toBe('many.dxf is too large for one sketch: its 10,002 points weigh 10,002 for the sketch solver (each point 1), at most 10,000');
    expect(importIntoDraft(EMPTY, over).outcome).toEqual({ ok: false, reason: over.summary.refused });
    const at = planImport(readDrawing('many.dxf', bytesOf(manyLinesDxf(5_000))));
    expect(at.summary).toMatchObject({ refused: null, load: 10_000 });
  });
});
