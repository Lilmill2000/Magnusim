// @vitest-environment node
// ux010 (DRAW), below the UI:
//  - construction drawing: Construction (X) with nothing selected turns it on and off; while on,
//    lines, rectangles, circles and arcs are made construction (a line begun before counts too),
//    points stay points; with curves selected it converts them, as before; never greyed;
//  - the snaps on the model's kernel reads: one at a time, the newest next, stale ones dropped;
//  - a new fillet's radius arrow: its drag solves live, the release is one undo step that changes
//    the radius dimension (nothing added), a radius too big stops at the largest one and says why.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { latestQueue } from '../../src/sketch/latest-queue';
import { isClickDrag } from '../../src/sketch/overlay';
import { asConstruction, drawsConstruction } from '../../src/sketch/edit';
import { arcGeom, isDimension } from '../../src/sketch/model';
import type { SketchPointer } from '../../src/sketch/mode';
import { filletCornerOf, filletLimit, filletMidAt, filletRadiusAt, radiusHandleOf } from '../../src/sketch/tools/radius-handle';
import { filletCorner } from '../../src/sketch/tools/fillet';
import type { SketchDimension, SketchEntity, Vec2 } from '../../src/types/doc';
import { rectangle, type Geo } from './fixtures';

/** A 40 x 20 rectangle from the origin, fully defined (its two sides dimensioned). */
function plate(): Geo {
  const g = rectangle(0, 0, 40, 20);
  return {
    ...g,
    constraints: [
      ...g.constraints,
      { id: 'o', kind: 'coincident', refs: ['p1', 'origin'] },
      { id: 'd1', kind: 'distance', refs: ['e1'], expr: '40 mm', driving: true },
      { id: 'd2', kind: 'distance', refs: ['e2'], expr: '20 mm', driving: true },
    ] as Geo['constraints'],
  };
}
import { sketchHarness, type Harness } from './harness';

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const curves = (hh: Harness) => hh.sketch().entities.filter((e) => e.kind !== 'point');

describe('construction drawing (Construction / X with nothing selected)', () => {
  it('toggles; what the drawing tools make while on is construction; points stay points; off again draws normal geometry', async () => {
    h = await sketchHarness();
    const cmd = h.services.commands.get('sketch.construction')!;
    expect(h.services.commands.canRun('sketch.construction')).toBe(true);
    expect(cmd.hint).toMatch(/^Construction drawing is off: X turns it on/);
    expect(cmd.pressed!()).toBe(false);
    await h.services.commands.run('sketch.construction');
    expect(h.mode.drawConstruction).toBe(true);
    expect(cmd.pressed!()).toBe(true);
    expect(cmd.hint).toBe('Construction drawing is on: X turns it off');
    h.tool('line');
    h.click([0, 0]);
    h.click([30, 0]);
    h.mode.escape();
    h.tool('rectangle-corner');
    h.click([0, 10]);
    h.click([20, 30]);
    h.tool('circle');
    h.click([50, 50]);
    h.click([55, 50]);
    h.tool('arc-3pt');
    h.click([60, 0]);
    h.click([80, 0]);
    h.click([70, 6]);
    h.tool('point');
    h.click([90, 90]);
    await h.idle();
    const made = curves(h);
    expect(made.map((e) => e.kind).sort()).toEqual(['arc', 'circle', 'line', 'line', 'line', 'line', 'line']);
    expect(made.every((e) => e.construction)).toBe(true);
    const pt = h.sketch().entities.find((e) => e.kind === 'point');
    expect(pt?.construction).toBeFalsy();
    // Off: a normal line again.
    await h.services.commands.run('sketch.construction');
    expect(h.mode.drawConstruction).toBe(false);
    h.tool('line');
    h.click([0, -20]);
    h.click([30, -20]);
    await h.idle();
    const last = curves(h).find((e) => !made.some((m) => m.id === e.id));
    expect(last?.kind).toBe('line');
    expect(last?.construction).toBeFalsy();
  });

  it('a line whose first click came before X is made construction; Undo removes it as usual', async () => {
    h = await sketchHarness();
    h.tool('line');
    h.click([0, 0]);
    await h.services.commands.run('sketch.construction');
    h.click([25, 5]);
    await h.idle();
    expect(curves(h)).toHaveLength(1);
    expect(curves(h)[0].construction).toBe(true);
    h.mode.undo();
    await h.idle();
    expect(curves(h)).toHaveLength(0);
  });

  it('with curves selected it converts them (and back), and leaves construction drawing alone; it resets when the sketch closes', async () => {
    h = await sketchHarness({ points: { a: [0, 0], b: [20, 0] }, entities: [{ id: 'l', kind: 'line', p: ['a', 'b'] }] });
    h.mode.select([{ what: 'entity', id: 'l' }], false);
    const cmd = h.services.commands.get('sketch.construction')!;
    expect(cmd.hint).toBe('Make the selection construction');
    await h.services.commands.run('sketch.construction');
    await h.idle();
    expect(h.sketch().entities.find((e) => e.id === 'l')?.construction).toBe(true);
    expect(h.mode.drawConstruction).toBe(false);
    expect(cmd.hint).toBe('Make the selection normal geometry (not construction)');
    h.mode.select([], false);
    await h.services.commands.run('sketch.construction');
    expect(h.mode.drawConstruction).toBe(true);
    h.session.commit();
    expect(h.mode.drawConstruction).toBe(false);
  });

  it('review S1: with a drawing tool in hand X toggles construction drawing, never converting a selection left from before; with Select it converts', async () => {
    h = await sketchHarness({ points: { a: [0, 0], b: [20, 0] }, entities: [{ id: 'l', kind: 'line', p: ['a', 'b'] }] });
    h.mode.select([{ what: 'entity', id: 'l' }], false);
    h.tool('line');
    const cmd = h.services.commands.get('sketch.construction')!;
    expect(cmd.hint).toMatch(/^Construction drawing is off: X turns it on/);
    await h.services.commands.run('sketch.construction');
    await h.idle();
    expect(h.mode.drawConstruction).toBe(true);
    expect(h.sketch().entities.find((e) => e.id === 'l')?.construction).toBeFalsy();
    h.tool('select');
    h.mode.select([{ what: 'entity', id: 'l' }], false);
    expect(cmd.hint).toBe('Make the selection construction');
    await h.services.commands.run('sketch.construction');
    await h.idle();
    expect(h.sketch().entities.find((e) => e.id === 'l')?.construction).toBe(true);
    expect(h.mode.drawConstruction).toBe(true);
  });

  it('asConstruction marks only the curves an edit added; the tools it applies to', () => {
    const before = { points: {}, entities: [{ id: 'old', kind: 'line', p: ['a', 'b'] } as SketchEntity], constraints: [] };
    const after = {
      ...before,
      entities: [
        ...before.entities,
        { id: 'n', kind: 'line', p: ['b', 'c'] } as SketchEntity,
        { id: 'pt', kind: 'point', p: 'c' } as SketchEntity,
        { id: 'ln', kind: 'line', p: ['c', 'd'], link: 'k1' } as unknown as SketchEntity,
      ],
    };
    const out = asConstruction(before, after);
    expect(out.entities.map((e) => !!e.construction)).toEqual([false, true, false, false]);
    expect(['line', 'rectangle-corner', 'circle', 'arc-3pt', 'arc-tangent', 'spline-fit'].every(drawsConstruction)).toBe(true);
    expect(['point', 'centerline', 'mirror', 'fillet', 'trim', 'select', null].some((t) => drawsConstruction(t))).toBe(false);
  });
});

describe('the Select tool cursor follows the analysis (CI run 37: a hover before it kept the hand)', () => {
  const px = 0.1;
  const ev = (at: Vec2): SketchPointer => ({ type: 'move', uv: at, px, ctrl: false, shift: false, pressed: false, clientX: at[0] / px, clientY: -at[1] / px });
  it('the origin is never draggable; before the analysis nothing shows the hand; when it lands a free point under a still pointer gets the hand, a fully defined one keeps the arrow', async () => {
    h = await sketchHarness({ points: { a: [10, 0], b: [30, 0] }, entities: [{ id: 'l', kind: 'line', p: ['a', 'b'] }] });
    const analysis = h.mode.view.get().analysis;
    expect(analysis).not.toBeNull();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    // The analysis not in yet (a slow machine): the origin, then a free end: the arrow.
    h.mode.view.set({ analysis: null });
    h.mode.tool!.pointer(ev([0, 0]));
    expect(h.mode.view.get().hover).toMatchObject({ id: 'origin' });
    expect(h.mode.view.get().cursor).toBe('');
    h.mode.tool!.pointer(ev([30, 0]));
    expect(h.mode.view.get().hover).toMatchObject({ what: 'point', id: 'b' });
    expect(h.mode.view.get().cursor).toBe('');
    // It lands with the pointer still: the free end gets the hand.
    h.mode.view.set({ analysis });
    await tick();
    expect(h.mode.view.get().cursor).toBe('move');
    // Back on the origin with the analysis in: the arrow; an analysis that says the end is fully defined: the arrow.
    h.mode.tool!.pointer(ev([0, 0]));
    expect(h.mode.view.get().cursor).toBe('');
    h.mode.tool!.pointer(ev([30, 0]));
    expect(h.mode.view.get().cursor).toBe('move');
    h.mode.view.set({ analysis: { ...analysis!, perPoint: { ...analysis!.perPoint, b: 'fully' } } });
    await tick();
    expect(h.mode.view.get().cursor).toBe('');
  });
});

describe('review S2: a sloppy click stays a click', () => {
  it('click-drag only when held >= 150 ms and moved > 12 px, or moved > 30 px', () => {
    expect(isClickDrag(60, 20)).toBe(false);
    expect(isClickDrag(400, 10)).toBe(false);
    expect(isClickDrag(200, 13)).toBe(true);
    expect(isClickDrag(40, 31)).toBe(true);
    expect(isClickDrag(149, 29)).toBe(false);
  });
});

describe('snaps on the model: one kernel read at a time, the newest next', () => {
  it('a read asked while one runs replaces the one waiting; the replaced one is dropped and told', async () => {
    const q = latestQueue();
    const ran: string[] = [];
    const dropped: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = (id: string, wait?: Promise<void>) => async () => {
      ran.push(id);
      if (wait) await wait;
    };
    q.ask(job('a', gate));
    q.ask(job('b'), { dropped: () => dropped.push('b') });
    q.ask(job('c'), { dropped: () => dropped.push('c') });
    q.ask(job('d'), { dropped: () => dropped.push('d') });
    // A low-priority read never replaces one waiting.
    q.ask(job('low'), { low: true, dropped: () => dropped.push('low') });
    expect(ran).toEqual(['a']);
    expect(dropped).toEqual(['b', 'c', 'low']);
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual(['a', 'd']);
    expect(q.busy).toBe(false);
    // A failing read does not stop the queue.
    q.ask(async () => {
      throw new Error('kernel');
    });
    q.ask(job('e'));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual(['a', 'd', 'e']);
  });
});

describe("a new sketch fillet's radius arrow", () => {
  /** A 90 degree corner: the arc's midpoint is r (1/sin 45 - 1) from the corner. */
  const K = Math.SQRT2 - 1;
  const px = 0.1;
  const ev = (type: SketchPointer['type'], at: Vec2, pressed = false): SketchPointer => ({ type, uv: at, px, ctrl: false, shift: false, pressed, clientX: at[0] / px, clientY: -at[1] / px });

  it('the largest fillet of a 40 x 20 corner is 20 (the short side), of a 60 degree corner min(side) x tan(30)', () => {
    const g = rectangle(0, 0, 40, 20);
    const f = filletCorner(g, 'p3', 5, '5 mm');
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    const arc = f.draft.entities.find((e) => e.kind === 'arc')!;
    const lim = filletLimit(f.draft, arc.id)!;
    expect(lim.max).toBeCloseTo(20, 5);
    expect(lim.why).toBe('the lines are too short');
    const tri = { points: { o: [0, 0] as Vec2, a: [30, 0] as Vec2, b: [10 * Math.cos(Math.PI / 3), 10 * Math.sin(Math.PI / 3)] as Vec2 }, entities: [{ id: 'l1', kind: 'line', p: ['o', 'a'] }, { id: 'l2', kind: 'line', p: ['o', 'b'] }] as SketchEntity[], constraints: [] };
    const f2 = filletCorner(tri, 'o', 1, '1 mm');
    if (!f2.ok) throw new Error(f2.reason);
    const arc2 = f2.draft.entities.find((e) => e.kind === 'arc')!;
    expect(filletLimit(f2.draft, arc2.id)!.max).toBeCloseTo(10 * Math.tan(Math.PI / 6), 5);
    // The arrow sits on the arc's middle and points away from its centre.
    const hg = radiusHandleOf(f.draft, arc.id)!;
    const ag = arcGeom(f.draft, arc as Extract<SketchEntity, { kind: 'arc' }>)!;
    expect(Math.hypot(hg.at[0] - ag.c[0], hg.at[1] - ag.c[1])).toBeCloseTo(5, 6);
    expect(hg.dir[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(hg.dir[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('direct manipulation: the radius whose fillet midpoint is at a point, two lines (closed form) and a line with an arc (searched)', () => {
    const g = rectangle(0, 0, 40, 20);
    const f = filletCorner(g, 'p3', 5, '5 mm');
    if (!f.ok) throw new Error(f.reason);
    const arc = f.draft.entities.find((e) => e.kind === 'arc')!;
    const fc = filletCornerOf(f.draft, arc.id)!;
    // Between two lines at 90 degrees: the midpoint is r (sqrt 2 - 1) from the corner (40, 20), along the bisector.
    const m7 = filletMidAt(fc, 7)!;
    expect(Math.hypot(m7[0] - 40, m7[1] - 20)).toBeCloseTo(7 * (Math.SQRT2 - 1), 6);
    expect(filletRadiusAt(fc, m7, 0.01, 19.99)).toBeCloseTo(7, 4);
    // A point off the bisector: its projection on it.
    expect(filletRadiusAt(fc, [m7[0] + 0.8, m7[1] - 0.8], 0.01, 19.99)).toBeCloseTo(7, 4);
    // A line and an arc (no closed form): the search finds the radius whose midpoint is there.
    const la = { points: { a: [0, 0] as Vec2, p: [20, 0] as Vec2, o: [25, 10] as Vec2, q: [35, 10] as Vec2 }, entities: [{ id: 'l', kind: 'line', p: ['a', 'p'] }, { id: 'k', kind: 'arc', c: 'o', a: 'p', b: 'q' }] as SketchEntity[], constraints: [] };
    const f2 = filletCorner(la, 'p', 2, '2 mm');
    if (!f2.ok) throw new Error(f2.reason);
    const had = new Set(la.entities.map((e) => e.id));
    const arc2 = f2.draft.entities.find((e) => e.kind === 'arc' && !had.has(e.id))!;
    const fc2 = filletCornerOf(f2.draft, arc2.id)!;
    expect(fc2.why).toBe('the line and the arc are too short');
    const m3 = filletMidAt(fc2, 3)!;
    expect(filletRadiusAt(fc2, m3, 0.01, filletLimit(f2.draft, arc2.id)!.max * 0.999)).toBeCloseTo(3, 3);
  });

  it('drag inward (away from the corner): bigger radius live and stored in one undo step (the dimension changes, nothing added); too far stops at 20 and says why; Undo gives 5 back', async () => {
    h = await sketchHarness(plate());
    h.tool('fillet');
    h.click([40, 20]);
    await h.idle();
    const dims = () => h!.sketch().constraints.filter((c): c is SketchDimension => isDimension(c) && c.kind === 'radius');
    expect(dims()).toHaveLength(1);
    const dimId = dims()[0].id;
    expect(dims()[0].expr).toBe('5 mm');
    const pv = h.mode.view.get().preview;
    expect(pv?.handles).toHaveLength(1);
    const { at, dir } = pv!.handles![0];
    expect(h.mode.view.get().hint).toMatch(/^Drag the arrow to size this fillet/);
    const t = h.mode.tool!;
    // Direct manipulation (Daniel, efd5d15): the arrow points inward (towards the arc's centre, away
    // from the corner) and the arc's midpoint follows the pointer: a radius d mm bigger moves it
    // d (1/sin 45 - 1) = d (sqrt 2 - 1) mm further along the bisector.
    const ag0 = arcGeom(h.sketch(), h.sketch().entities.find((e) => e.kind === 'arc') as Extract<SketchEntity, { kind: 'arc' }>)!;
    expect((ag0.c[0] - at[0]) * dir[0] + (ag0.c[1] - at[1]) * dir[1]).toBeCloseTo(5, 6);
    const along = (d: number): Vec2 => [at[0] + dir[0] * d * K, at[1] + dir[1] * d * K];
    t.pointer(ev('move', at));
    t.pointer(ev('down', at, true));
    for (let i = 1; i <= 6; i++) {
      t.pointer(ev('move', along(i * 0.5), true));
      await h.idle();
    }
    // 3 mm bigger: radius 8, drawn live before the release, its midpoint under the pointer.
    const live = h.mode.view.get().draft!;
    const liveArc = live.entities.find((e) => e.kind === 'arc') as Extract<SketchEntity, { kind: 'arc' }>;
    expect(arcGeom(live, liveArc)!.r).toBeCloseTo(8, 4);
    const liveMid = radiusHandleOf(live, liveArc.id)!.at;
    expect(Math.hypot(liveMid[0] - along(3)[0], liveMid[1] - along(3)[1])).toBeLessThan(0.05);
    expect(h.mode.view.get().hint).toBe('Radius 8 mm: release to keep it.');
    const opts = h.mode.tool!.options!();
    expect(opts[0]).toMatchObject({ id: 'radius', expr: '8 mm' });
    expect(h.sketch().constraints.find((c) => c.id === dimId)).toMatchObject({ expr: '5 mm' });
    t.pointer(ev('up', along(3)));
    t.pointer(ev('click', along(3)));
    await h.idle();
    await h.idle();
    expect(dims()).toHaveLength(1);
    expect(dims()[0]).toMatchObject({ id: dimId, expr: '8 mm' });
    const arc = h.sketch().entities.find((e) => e.kind === 'arc') as Extract<SketchEntity, { kind: 'arc' }>;
    expect(arcGeom(h.sketch(), arc)!.r).toBeCloseTo(8, 6);
    expect(h.mode.undoDepth).toBe(2);
    // Too far: it stops at 20 (the short side) and says why.
    const g2 = h.mode.view.get().preview!.handles![0];
    t.pointer(ev('down', g2.at, true));
    t.pointer(ev('move', [g2.at[0] + g2.dir[0] * 40 * K, g2.at[1] + g2.dir[1] * 40 * K], true));
    await h.idle();
    expect(h.mode.view.get().hint).toBe("The radius can't be bigger than 20 mm here: the lines are too short");
    t.pointer(ev('up', g2.at));
    await h.idle();
    await h.idle();
    expect(dims()[0].expr).toBe('19.99 mm');
    // Undo twice: 8 then 5 (each drag one step).
    h.mode.undo();
    await h.idle();
    expect(dims()[0].expr).toBe('8 mm');
    h.mode.undo();
    await h.idle();
    expect(dims()[0].expr).toBe('5 mm');
    const a5 = h.sketch().entities.find((e) => e.kind === 'arc') as Extract<SketchEntity, { kind: 'arc' }>;
    expect(arcGeom(h.sketch(), a5)!.r).toBeCloseTo(5, 6);
  });

  it('review S3/S4/N1: Escape during the drag puts the radius and the box back and stores nothing (Fillet and Select); the arrow is back right after Undo', async () => {
    h = await sketchHarness(plate());
    h.tool('fillet');
    h.click([40, 20]);
    await h.idle();
    const box = () => (h!.mode.tool!.options!()[0] as { expr: string }).expr;
    const rad = () => h!.sketch().constraints.filter((c): c is SketchDimension => isDimension(c) && c.kind === 'radius')[0].expr;
    let g = h.mode.view.get().preview!.handles![0];
    let t = h.mode.tool!;
    // A radius k mm bigger (k < 0: smaller, towards the corner).
    const out = (k: number): Vec2 => [g.at[0] + g.dir[0] * k * K, g.at[1] + g.dir[1] * k * K];
    t.pointer(ev('down', g.at, true));
    t.pointer(ev('move', out(-4), true));
    await h.idle();
    expect(box()).toBe('1 mm');
    h.mode.escape();
    await h.idle();
    expect(box()).toBe('5 mm');
    t.pointer(ev('up', out(-4)));
    await h.idle();
    expect(rad()).toBe('5 mm');
    expect(h.mode.undoDepth).toBe(1);
    expect(h.mode.view.get().preview?.handles ?? []).toHaveLength(1);
    expect(h.mode.tool?.id).toBe('fillet');
    // A drag kept, then Undo: the arrow is drawn again without a pointer move.
    t.pointer(ev('down', g.at, true));
    t.pointer(ev('move', out(2), true));
    await h.idle();
    t.pointer(ev('up', out(2)));
    await h.idle();
    await h.idle();
    expect(rad()).toBe('7 mm');
    h.mode.undo();
    await h.idle();
    expect(rad()).toBe('5 mm');
    expect(h.mode.view.get().preview?.handles ?? []).toHaveLength(1);
    // Select tool: Escape cancels too.
    h.mode.escape();
    h.mode.escape();
    const arc = h.sketch().entities.find((e) => e.kind === 'arc')!;
    h.mode.select([{ what: 'entity', id: arc.id }], false);
    g = h.mode.view.get().preview!.handles![0];
    t = h.mode.tool!;
    t.pointer(ev('down', g.at, true));
    t.pointer(ev('move', out(3), true));
    await h.idle();
    h.mode.escape();
    t.pointer(ev('up', out(3)));
    await h.idle();
    await h.idle();
    expect(rad()).toBe('5 mm');
    expect(h.mode.view.get().preview?.handles ?? []).toHaveLength(1);
  });

  it('a fillet arc selected later (Select tool) shows the arrow too; its drag is one undo step; deselected, the arrow goes', async () => {
    h = await sketchHarness(plate());
    h.tool('fillet');
    h.click([40, 20]);
    await h.idle();
    h.mode.escape();
    h.mode.escape();
    expect(h.mode.tool?.id).toBe('select');
    expect(h.mode.view.get().preview?.handles ?? []).toHaveLength(0);
    const arc = h.sketch().entities.find((e) => e.kind === 'arc')!;
    h.mode.select([{ what: 'entity', id: arc.id }], false);
    const hs = h.mode.view.get().preview?.handles ?? [];
    expect(hs).toHaveLength(1);
    const t = h.mode.tool!;
    expect(t.takesPress!(ev('down', hs[0].at, true))).toBe(true);
    t.pointer(ev('down', hs[0].at, true));
    t.pointer(ev('move', [hs[0].at[0] + hs[0].dir[0] * 2 * K, hs[0].at[1] + hs[0].dir[1] * 2 * K], true));
    await h.idle();
    t.pointer(ev('up', [hs[0].at[0] + hs[0].dir[0] * 2 * K, hs[0].at[1] + hs[0].dir[1] * 2 * K]));
    await h.idle();
    await h.idle();
    const dim = h.sketch().constraints.find((c): c is SketchDimension => isDimension(c) && c.kind === 'radius')!;
    expect(dim.expr).toBe('7 mm');
    expect(h.mode.undoDepth).toBe(2);
    h.mode.select([], false);
    expect(h.mode.view.get().preview?.handles ?? []).toHaveLength(0);
  });

  it('typed in the Radius box while the arrow shows: that fillet takes it; too big is refused with the reason; Escape drops the arrow, then the tool', async () => {
    h = await sketchHarness(plate());
    h.tool('fillet');
    h.click([40, 20]);
    await h.idle();
    const opt = h.mode.tool!.options!()[0] as { set(e: string, v: number): string | null | void };
    expect(opt.set('25 mm', 25)).toBe("The radius can't be bigger than 20 mm here: the lines are too short");
    expect(opt.set('7 mm', 7)).toBeNull();
    await h.idle();
    expect(h.sketch().constraints.filter((c) => isDimension(c) && c.kind === 'radius')[0]).toMatchObject({ expr: '7 mm' });
    h.mode.escape();
    expect(h.mode.view.get().preview?.handles ?? []).toHaveLength(0);
    expect(h.mode.tool?.id).toBe('fillet');
    h.mode.escape();
    expect(h.mode.tool?.id).toBe('select');
  });
});
