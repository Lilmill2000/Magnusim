// Import SVG/DXF against files built to make the reading slow, large or wrong (each one a few
// bytes to a few MB, made here): every one is read or refused within a time budget, and what the
// panel and the Assistant are told is true.
//   - SVG: 200,000 nested groups, stray close tags, 100,000-character lengths and transforms (no
//     pattern backtracks over them), one path of 2,000,000 segments (stopped at the reading's cap),
//     a root whose width or height is 0 or whose viewBox is far too small (a scale all the same),
//     numbers that are not finite (1e999, scale(1e200) twice: that shape alone is unreadable);
//   - DXF: an ARC or ELLIPSE with an angle of 1e300, an array of 100,000 x 100,000 empty blocks, a
//     block that inserts itself four times, a chain of blocks past 16 levels, a SPLINE through
//     20,000 fit points, one on 100,000 control points, one of degree 5,000, a block scaled 1e200
//     inside one scaled 1e200;
//   - the import: a closed outline of one curve has no open end; a stray curve far off does not
//     widen the join tolerance; the summary says the tolerance; a drawing heavier than the sketch
//     solver carries is refused with its weight (1,000 arcs), one at the cap goes in.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { IMPORT_MAX_LOAD, importIntoDraft, planImport, readDrawing, summaryWords, tryReadDrawing } from '../../../src/sketch/import';
import { bytesOf, dxf } from './fixtures';

// Wall-time bounds get three times the room on a shared CI runner (GitHub sets CI): one took
// 3.08 s against 3 s there on 2026-11-15. Locally they hold as written.
const ROOM = process.env.CI ? 3 : 1;

const EMPTY = { points: {}, entities: [], constraints: [] };

/** f's result and how long it took (ms). */
function timed<T>(f: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = f();
  return { value, ms: performance.now() - t0 };
}

const svg = (body: string, root = 'viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`;
const SQUARE = '<rect x="0" y="0" width="10" height="10"/>';
const entities = (...recs: (string | number)[][]) => dxf([0, 'SECTION', 2, 'ENTITIES', ...recs.flat(), 0, 'ENDSEC', 0, 'EOF']);
const LINE = (a: [number, number], b: [number, number], layer = '0') => [0, 'LINE', 8, layer, 10, a[0], 20, a[1], 30, 0, 11, b[0], 21, b[1], 31, 0];
const SQUARE_DXF = [LINE([0, 0], [10, 0]), LINE([10, 0], [10, 10]), LINE([10, 10], [0, 10]), LINE([0, 10], [0, 0])];

describe('SVG files built to be slow or wrong', () => {
  it('200,000 nested groups (and their closes) read within a second or two; 20,000 with 20,000 stray close tags too', () => {
    const deep = svg(`${'<g>'.repeat(200_000)}${SQUARE}${'</g>'.repeat(200_000)}${SQUARE.replace('x="0"', 'x="20"')}`);
    const r = timed(() => readDrawing('deep.svg', bytesOf(deep)));
    expect(r.ms).toBeLessThan(3000 * ROOM);
    // Past 256 levels the rest is passed over (counted once); the square after the groups is drawn.
    expect(r.value.skipped).toEqual({ deep: 1 });
    expect(r.value.curves).toHaveLength(4);
    const stray = svg(`${'<g>'.repeat(20_000)}${'</x>'.repeat(20_000)}${'</g>'.repeat(20_000)}${SQUARE}`);
    const s = timed(() => readDrawing('stray.svg', bytesOf(stray)));
    expect(s.ms).toBeLessThan(3000 * ROOM);
    expect(s.value.curves).toHaveLength(4);
  });

  it('a 100,000-character length, root width or transform is unreadable at once (no pattern backtracks over it)', () => {
    const digits = '1'.repeat(100_000);
    const r = timed(() => readDrawing('long.svg', bytesOf(svg(`<line x1="${digits}!" y1="0" x2="5" y2="5"/><g transform="scale(1)${' '.repeat(100_000)}!">${SQUARE}</g>${SQUARE}`, `width="${'m'.repeat(100_000)}!" viewBox="0 0 100 100"`))));
    expect(r.ms).toBeLessThan(1000 * ROOM);
    expect(r.value.skipped).toEqual({ unreadable: 2 });
    expect(r.value.curves).toHaveLength(4);
    expect(r.value.units).toBe('CSS px, 96 per inch');
  });

  it('one path of 2,000,000 segments stops at the reading cap: no slower than one of 200,000 (it never builds the rest, that would fill the memory)', () => {
    const file = (n: number) => bytesOf(svg(`<path d="M0 0${'h.1'.repeat(n)}"/>`));
    const small = file(200_000);
    const big = file(2_000_000);
    tryReadDrawing('warm.svg', small);
    const a = timed(() => tryReadDrawing('long-path.svg', small));
    const b = timed(() => tryReadDrawing('long-path.svg', big));
    for (const r of [a, b]) expect(r.value).toEqual({ refused: 'long-path.svg has more than 100,000 curves: too many to import' });
    expect(b.ms).toBeLessThan(3 * a.ms + 150);
    const poly = timed(() => tryReadDrawing('poly.svg', bytesOf(svg(`<polyline points="${Array.from({ length: 400_000 }, (_, i) => `${i} ${i % 2}`).join(' ')}"/>`))));
    expect(poly.value).toEqual({ refused: 'poly.svg has more than 100,000 curves: too many to import' });
  });

  it('a root width or height of 0, or a viewBox far too small, still gives a scale (CSS px) and says so; the panel has numbers to show', () => {
    const zero = readDrawing('sprites.svg', bytesOf(svg(SQUARE, 'width="0" height="0" viewBox="0 0 100 100"')));
    expect(zero.mmPerUnit).toBeCloseTo(25.4 / 96, 12);
    expect(zero.units).toBe('CSS px, 96 per inch');
    expect(zero.notes).toEqual(['Its width or height is 0, so it gives no size: read as CSS px (set the scale)']);
    // Width 0 and no height: read, not "Cannot read properties of undefined".
    expect(tryReadDrawing('w0.svg', bytesOf(svg(SQUARE, 'width="0" viewBox="0 0 100 100"')))).toMatchObject({ drawing: { mmPerUnit: 25.4 / 96 } });
    // One size 0, the other good: the good one's.
    expect(readDrawing('h.svg', bytesOf(svg(SQUARE, 'width="0" height="50mm" viewBox="0 0 100 100"')))).toMatchObject({ mmPerUnit: 0.5, units: 'height 50mm over a viewBox 100 high' });
    const tiny = readDrawing('tiny.svg', bytesOf(svg(SQUARE, 'width="10mm" viewBox="0 0 1e-320 100"')));
    expect(Number.isFinite(tiny.mmPerUnit) && tiny.mmPerUnit > 0).toBe(true);
    expect(tiny.notes).toEqual(['Its size over its viewBox gives no scale (a viewBox far too small): read as CSS px (set the scale)']);
    // The Assistant's row (no scale given) and the panel both plan it.
    for (const d of [zero, tiny]) expect(summaryWords(planImport(d).summary).scale).toBe('Scale: 1 unit = 0.264583 mm (CSS px, 96 per inch)');
  });

  it('a number that is not finite (1e999), or a transform that overflows, leaves that shape out as unreadable; the rest goes in', () => {
    const d = readDrawing('inf.svg', bytesOf(svg(`${SQUARE}<path d="M0 0 L1e999 5"/><g transform="scale(1e200) scale(1e200)"><line x1="0" y1="0" x2="1" y2="1"/></g><line x1="0" y1="0" x2="1e300" y2="0" transform="scale(1e10)"/>`)));
    expect(d.skipped).toEqual({ unreadable: 3 });
    const plan = planImport(d);
    expect(plan.summary).toMatchObject({ refused: null, total: 4, tooSmall: 0, openEnds: 0 });
    expect(Number.isFinite(plan.summary.tolerance)).toBe(true);
  });

  it('a closed outline of one cubic has no open end', () => {
    const plan = planImport(readDrawing('loop.svg', bytesOf(svg('<path d="M0 0 C5 5 10 -5 0 0 Z"/>'))));
    expect(plan.summary).toMatchObject({ total: 1, openEnds: 0 });
    expect(summaryWords(plan.summary).open).toBe('Open ends: 0');
    // The sketch still gives it two points there (a curve never ends on itself).
    const { outcome } = importIntoDraft(EMPTY, plan);
    expect(Object.keys((outcome as Extract<typeof outcome, { ok: true }>).draft.points)).toHaveLength(4);
  });
});

describe('DXF files built to be slow or wrong', () => {
  it('an ARC or an ELLIPSE with an angle of 1e300 (or 1e15) is unreadable at once; an ordinary arc past 360 deg still reads', () => {
    const r = timed(() =>
      readDrawing(
        'angles.dxf',
        bytesOf(
          entities(
            [0, 'ARC', 8, '0', 10, 0, 20, 0, 30, 0, 40, 5, 50, 1e300, 51, 90],
            [0, 'ARC', 8, '0', 10, 0, 20, 0, 30, 0, 40, 5, 50, 0, 51, 1e15],
            [0, 'ELLIPSE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 5, 21, 0, 31, 0, 40, 0.5, 41, 0, 42, 1e300],
            [0, 'ARC', 8, '0', 10, 20, 20, 0, 30, 0, 40, 5, 50, -30, 51, 400],
          ),
        ),
      ),
    );
    expect(r.ms).toBeLessThan(500 * ROOM);
    expect(r.value.skipped).toEqual({ unreadable: 3 });
    // -30 to 400 deg: 70 deg counter-clockwise from -30.
    const arc = r.value.curves[0] as Extract<(typeof r.value.curves)[number], { kind: 'arc' }>;
    expect(arc.kind).toBe('arc');
    expect(Math.atan2(arc.b[1], arc.b[0] - 20) * (180 / Math.PI)).toBeCloseTo(40, 9);
  });

  it('an array of 100,000 x 100,000 empty blocks is refused at once: its blocks expand too far', () => {
    const text = dxf([
      0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'E', 10, 0, 20, 0, 30, 0, 0, 'ENDBLK', 0, 'ENDSEC',
      0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 8, '0', 2, 'E', 10, 0, 20, 0, 30, 0, 70, 100_000, 71, 100_000, 44, 1, 45, 1, 0, 'ENDSEC', 0, 'EOF',
    ]);
    const r = timed(() => tryReadDrawing('array.dxf', bytesOf(text)));
    expect(r.ms).toBeLessThan(5000 * ROOM);
    expect(r.value).toEqual({ refused: "array.dxf's blocks expand too far: its INSERTs place more than 1,000,000 entities (blocks in blocks, or arrays of many rows and columns)" });
  });

  it('a block that inserts itself four times is left out once per INSERT (not 4^16 times); a chain of 18 blocks stops at 16 levels', () => {
    const self = dxf([
      0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'S', 10, 0, 20, 0, 30, 0,
      ...[0, 1, 2, 3].flatMap((i) => [0, 'INSERT', 8, '0', 2, 'S', 10, i, 20, 0, 30, 0]),
      ...LINE([0, 0], [1, 0]),
      0, 'ENDBLK', 0, 'ENDSEC',
      0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 8, '0', 2, 'S', 10, 0, 20, 0, 30, 0, 0, 'ENDSEC', 0, 'EOF',
    ]);
    const r = timed(() => readDrawing('self.dxf', bytesOf(self)));
    expect(r.ms).toBeLessThan(500 * ROOM);
    expect(r.value.skipped).toEqual({ selfInsert: 4 });
    expect(r.value.curves).toHaveLength(1);
    expect(summaryWords(planImport(r.value).summary).skipped).toBe('Skipped: 4 INSERTs of a block inside itself');
    const chain = dxf([
      0, 'SECTION', 2, 'BLOCKS',
      ...Array.from({ length: 18 }, (_, i) => [0, 'BLOCK', 2, `B${i}`, 10, 0, 20, 0, 30, 0, ...(i < 17 ? [0, 'INSERT', 8, '0', 2, `B${i + 1}`, 10, 0, 20, 0, 30, 0] : LINE([0, 0], [1, 0])), 0, 'ENDBLK']).flat(),
      0, 'ENDSEC',
      0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 8, '0', 2, 'B0', 10, 0, 20, 0, 30, 0, 0, 'ENDSEC', 0, 'EOF',
    ]);
    expect(readDrawing('chain.dxf', bytesOf(chain)).skipped).toEqual({ nested: 1 });
  });

  it('a SPLINE through 20,000 fit points plans within a second or two and is refused by its weight; one through 2,000 goes in', () => {
    const fit = (n: number) => entities([0, 'SPLINE', 8, '0', 70, 8, 71, 3, 74, n, ...Array.from({ length: n }, (_, i) => [11, i, 21, Math.sin(i / 10) * 5, 31, 0]).flat()]);
    const big = timed(() => planImport(readDrawing('fit.dxf', bytesOf(fit(20_000)))));
    expect(big.ms).toBeLessThan(3000 * ROOM);
    expect(big.value.summary.refused).toBe('fit.dxf is too large for one sketch: its 20,000 points weigh 20,000 for the sketch solver (each point 1), at most 10,000');
    const ok = timed(() => {
      const plan = planImport(readDrawing('fit.dxf', bytesOf(fit(2_000))));
      return { plan, draft: importIntoDraft(EMPTY, plan) };
    });
    expect(ok.ms).toBeLessThan(2000 * ROOM);
    expect(ok.value.plan.summary).toMatchObject({ refused: null, read: { spline: 1 }, load: 2_000 });
  });

  it('a SPLINE on 100,000 control points plans within a few seconds (refused by its weight); one of degree 5,000 is left out at once', () => {
    const n = 100_000;
    const knots = [0, 0, 0, ...Array.from({ length: n - 2 }, (_, i) => i), n - 3, n - 3, n - 3];
    const long = entities([0, 'SPLINE', 8, '0', 70, 8, 71, 3, 72, knots.length, 73, n, ...knots.flatMap((k) => [40, k]), ...Array.from({ length: n }, (_, i) => [10, i, 20, i % 2, 30, 0]).flat()]);
    const r = timed(() => planImport(readDrawing('long.dxf', bytesOf(long))));
    expect(r.ms).toBeLessThan(5000 * ROOM);
    expect(r.value.summary.refused).toContain('long.dxf is too large for one sketch: its 100,000 points weigh 100,000');
    const p = 5000;
    const high = entities([0, 'SPLINE', 8, '0', 70, 8, 71, p, ...Array.from({ length: 2 * p + 2 }, (_, i) => [40, i <= p ? 0 : 1]).flat(), ...Array.from({ length: p + 1 }, (_, i) => [10, i, 20, 0, 30, 0]).flat()]);
    const h = timed(() => readDrawing('high.dxf', bytesOf(high)));
    expect(h.ms).toBeLessThan(500 * ROOM);
    expect(h.value.skipped).toEqual({ highDegree: 1 });
    expect(summaryWords(planImport(readDrawing('x.dxf', bytesOf(entities(...SQUARE_DXF, [0, 'SPLINE', 8, '0', 71, 30, 40, 0])))).summary).skipped).toBe('Skipped: 1 SPLINE of degree past 25');
  });

  it('a block scaled 1e200 inside one scaled 1e200 is unreadable; the square beside it goes in with a finite tolerance', () => {
    const text = dxf([
      0, 'SECTION', 2, 'BLOCKS',
      0, 'BLOCK', 2, 'IN', 10, 0, 20, 0, 30, 0, ...LINE([0, 0], [1, 1]), 0, 'ENDBLK',
      0, 'BLOCK', 2, 'OUT', 10, 0, 20, 0, 30, 0, 0, 'INSERT', 8, '0', 2, 'IN', 10, 0, 20, 0, 30, 0, 41, 1e200, 42, 1e200, 43, 1, 0, 'ENDBLK',
      0, 'ENDSEC',
      0, 'SECTION', 2, 'ENTITIES', ...SQUARE_DXF.flat(), 0, 'INSERT', 8, '0', 2, 'OUT', 10, 0, 20, 0, 30, 0, 41, 1e200, 42, 1e200, 43, 1, 0, 'ENDSEC', 0, 'EOF',
    ]);
    const d = readDrawing('huge.dxf', bytesOf(text));
    expect(d.skipped).toEqual({ unreadable: 1 });
    const plan = planImport(d);
    expect(plan.summary).toMatchObject({ refused: null, total: 4, tooSmall: 0, openEnds: 0, tolerance: 1e-4 });
  });

  it('a closed SPLINE given by control points (periodic, wrapped poles; or clamped, first pole = last) has no open end', () => {
    const periodic = entities([
      0, 'SPLINE', 8, '0', 70, 11, 71, 3,
      ...Array.from({ length: 11 }, (_, i) => [40, i]).flat(),
      ...[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0], [10, 0], [10, 10]].flatMap(([x, y]) => [10, x, 20, y, 30, 0]),
    ]);
    const clamped = entities([
      0, 'SPLINE', 8, '0', 70, 8, 71, 3,
      ...[0, 0, 0, 0, 1, 2, 2, 2, 2].flatMap((k) => [40, k]),
      ...[[0, 0], [10, -5], [15, 10], [-5, 10], [0, 0]].flatMap(([x, y]) => [10, x, 20, y, 30, 0]),
    ]);
    for (const [name, text] of [['periodic.dxf', periodic], ['clamped.dxf', clamped]] as const) {
      const plan = planImport(readDrawing(name, bytesOf(text)));
      expect(plan.summary, name).toMatchObject({ total: 1, openEnds: 0 });
    }
  });
});

describe('the import', () => {
  it('a stray entity far off does not widen the join tolerance: lines 0.02 mm apart stay apart; the summary says the tolerance and why', () => {
    const d = readDrawing('stray.dxf', bytesOf(dxf([0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...LINE([0, 0], [10, 0]), ...LINE([10.02, 0], [20, 0]), 0, 'POINT', 8, '0', 10, 100_000, 20, 100_000, 30, 0, 0, 'ENDSEC', 0, 'EOF'])));
    const plan = planImport(d);
    expect(plan.summary.openEnds).toBe(4);
    expect(plan.summary.tolerance).toBeCloseTo(0.01, 9);
    const w = summaryWords(plan.summary);
    expect(w.join).toBe('Ends joined within 0.01 mm');
    expect(w.notes).toContain('A few curves lie far from the rest (it spans 100000 × 100000 mm): ends are joined within 0.01 mm, by the size of its curves');
    // Without the stray point: the drawing's own tolerance (2e-5 of 20 mm is under the floor).
    expect(summaryWords(planImport(readDrawing('two.dxf', bytesOf(entities(LINE([0, 0], [10, 0]), LINE([10.02, 0], [20, 0]))))).summary).join).toBe('Ends joined within 0.0001 mm');
  });

  it(`1,000 arcs are too heavy for the sketch solver: refused with their weight and why; 300 go in`, () => {
    const arcs = (n: number) => entities(...Array.from({ length: n }, (_, i) => [0, 'ARC', 8, '0', 10, (i % 100) * 20, 20, Math.floor(i / 100) * 20, 30, 0, 40, 5, 50, 0, 51, 90]));
    const over = planImport(readDrawing('arcs.dxf', bytesOf(arcs(1000))));
    expect(over.summary.refused).toBe('arcs.dxf is too large for one sketch: its 3,000 points and 1,000 arcs weigh 23,000 for the sketch solver (each point 1, each arc 20 more), at most 10,000');
    expect(over.summary.load).toBeGreaterThan(IMPORT_MAX_LOAD);
    const fine = planImport(readDrawing('arcs.dxf', bytesOf(arcs(300))));
    expect(fine.summary).toMatchObject({ refused: null, load: 300 * 3 + 300 * 20 });
  });
});
