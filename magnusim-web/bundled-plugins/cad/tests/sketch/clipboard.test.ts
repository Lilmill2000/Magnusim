// @vitest-environment node
// Sketch copy and paste (src/sketch/tools/clip.ts, src/sketch/tools/paste.ts):
//   - what Copy holds: the picked entities and their points (construction and centerline kept),
//     the relations and dimensions whose every reference is copied (a dimension with its value),
//     and how many tie the copied geometry to anything else (left out);
//   - paste: new geometry moved so the middle of the copy lands where it is placed, the relations
//     and dimensions made again on the copies (expressions kept, labels and a Fix moved with it; an
//     expression the target cannot read takes the value it had);
//   - in sketch mode with the real solver: Copy and Paste are commands; the copy follows the
//     pointer; a click places it as one undo step (Ctrl+Z takes it out), selects what it made, and
//     the DOF grows by the original's; what was left out is said; Escape adds nothing; another
//     sketch (another plane) takes the same 2D shape;
//   - the copy kept in the plugin's prefs for another Part (a small one), read back when the page
//     has none.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUnitsService } from '../../src/doc/units';
import { isDimension } from '../../src/sketch/model';
import { clipOf, clipWords, leftOutWords, pasteClip, readClip, valuedWords, type SketchClip } from '../../src/sketch/tools/clip';
import { evaluatedIn } from '../../src/sketch/tools/paste';
import type { DocUnits } from '../../src/types/units';
import { CLIP_PREF, CLIP_PREF_MAX, forgetClip, heldClip, holdClip, peekClip } from '../../src/sketch/tools/paste';
import type { SketchDimension, SketchEntity, Vec2 } from '../../src/types/doc';
import { sketchHarness, type Harness } from './harness';
import { circle, merge, rectangle, sketchOf } from './fixtures';

let h: Harness | null = null;
let h2: Harness | null = null;
beforeEach(() => forgetClip());
afterEach(() => {
  h?.dispose();
  h2?.dispose();
  h = null;
  h2 = null;
  forgetClip();
});

const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;

/** A 30 x 20 rectangle at (10, 10) with its bottom dimensioned, a construction centerline, and a circle tied to the rectangle's side by tangency. */
function drawing() {
  const g = merge(rectangle(10, 10, 30, 20), circle('c1', [60, 20], 5));
  g.entities.push({ id: 'cl', kind: 'line', p: ['p1', 'p3'], construction: true, centerline: true } as SketchEntity);
  g.constraints.push({ id: 'd1', kind: 'distance', refs: ['e1'], expr: '30 mm', driving: true, at: [25, 4] } as SketchDimension);
  g.constraints.push({ id: 't1', kind: 'tangent', refs: ['e2', 'c1'] });
  g.constraints.push({ id: 'dx', kind: 'distance_x', refs: ['origin', 'p1'], expr: '10 mm', driving: true } as SketchDimension);
  return sketchOf(g, { name: 'Plate', solved: { values: { d1: 30, dx: 10 }, dof: 0, state: 'under' } });
}

describe('what Copy holds', () => {
  it('the entities, their points, construction and centerline; the relations and dimensions inside; the ones to other geometry counted', () => {
    const d = drawing();
    const clip = clipOf(d, ['e1', 'e2', 'e3', 'e4', 'cl']) as SketchClip;
    expect(typeof clip).toBe('object');
    expect(clip.from).toBe('Plate');
    expect(clip.entities.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'cl']);
    expect(clip.entities[4]).toMatchObject({ construction: true, centerline: true });
    expect(Object.keys(clip.points).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    // H, V on the four sides and the 30 mm dimension are inside; the tangent to the circle and the
    // horizontal dimension from the origin also tie what is not copied.
    expect(clip.constraints.map((c) => c.id)).toEqual(['h1', 'v2', 'h3', 'v4', 'd1']);
    expect(clip.values).toEqual({ d1: 30 });
    expect(clip.outside).toEqual({ relations: 1, dimensions: 1 });
    expect(leftOutWords(clip.outside)).toBe('1 relation and 1 dimension to other geometry were left out');
    expect(leftOutWords({ relations: 2, dimensions: 0 })).toBe('2 relations to other geometry were left out');
    expect(leftOutWords({ relations: 0, dimensions: 0 })).toBeNull();
    expect(clipWords(clip)).toBe('5 lines, 4 relations and 1 dimension');
    // The middle of the box.
    expect(near(clip.anchor, [25, 20])).toBe(true);
    // A copy is data: it never shares the sketch's objects.
    expect(clip.entities[0]).not.toBe(d.entities[0]);
    // Nothing of the geometry picked: why.
    expect(clipOf(d, ['h1'])).toBe('select sketch geometry first: lines, arcs, circles, splines or points');
    // A point picked under a point entity is that point entity.
    const pe = sketchOf({ points: { q: [1, 2] }, entities: [{ id: 'pt', kind: 'point', p: 'q' }], constraints: [] });
    expect((clipOf(pe, ['q']) as SketchClip).entities.map((e) => e.id)).toEqual(['pt']);
  });
});

describe('paste', () => {
  it('new geometry with the middle on the place; relations and dimensions made again on the copies; labels and a Fix move with it', () => {
    const d = drawing();
    d.constraints.push({ id: 'fx', kind: 'fix', refs: ['p2'], value: [40, 10] });
    const clip = clipOf(d, ['e1', 'e2', 'e3', 'e4']) as SketchClip;
    const r = pasteClip(d, clip, [125, 20]);
    expect(r.outcome.ok).toBe(true);
    const out = (r.outcome as unknown as { draft: typeof d }).draft;
    expect(r.added).toHaveLength(4);
    expect(new Set([...r.added, ...d.entities.map((e) => e.id)]).size).toBe(d.entities.length + 4);
    // Moved by (100, 0): the first copy runs (110, 10) -> (140, 10).
    const line = out.entities.find((e) => e.id === r.added[0]) as Extract<SketchEntity, { kind: 'line' }>;
    expect(near(out.points[line.p[0]], [110, 10])).toBe(true);
    expect(near(out.points[line.p[1]], [140, 10])).toBe(true);
    // Corners stay shared: four new points.
    expect(Object.keys(out.points).length).toBe(Object.keys(d.points).length + 4);
    const made = out.constraints.slice(d.constraints.length);
    expect(made.map((c) => c.kind)).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical', 'distance', 'fix']);
    expect(made[0].refs).toEqual([r.added[0]]);
    const dim = made[4] as SketchDimension;
    expect(dim).toMatchObject({ expr: '30 mm', driving: true, refs: [r.added[0]] });
    expect(dim.at).toEqual([125, 4]);
    expect((made[5] as { value: Vec2 }).value).toEqual([140, 10]);
    expect(r.kept).toEqual({ relations: 5, dimensions: 1 });
    // The source is as it was.
    expect(out.entities.slice(0, d.entities.length)).toEqual(d.entities);
  });

  it("an expression the target cannot read (another Part's parameter) takes the value the dimension had; a driven one stays driven", () => {
    const d = sketchOf(rectangle(0, 0, 40, 20, { hv: false }), { name: 'A', solved: { values: { w: 40 }, dof: 0, state: 'under' } });
    d.constraints.push({ id: 'w', kind: 'distance', refs: ['e1'], expr: 'width', driving: true } as SketchDimension);
    d.constraints.push({ id: 'h', kind: 'distance', refs: ['e2'], expr: '20 mm', driving: false } as SketchDimension);
    const clip = clipOf(d, ['e1', 'e2', 'e3', 'e4']) as SketchClip;
    expect(clip.values).toEqual({ w: 40, h: 20 });
    const empty = sketchOf({}, { name: 'B' });
    const r = pasteClip(empty, clip, [0, 0], { evaluate: (expr) => (expr === 'width' ? null : 20) });
    const out = (r.outcome as unknown as { draft: typeof d }).draft;
    expect(out.constraints.filter(isDimension).map((c) => [c.expr, c.driving])).toEqual([
      ['40 mm', true],
      ['20 mm', false],
    ]);
    expect(r.valued).toEqual(['width']);
    // Read by the target as the value it had: kept as it is.
    const same = pasteClip(empty, clip, [0, 0], { evaluate: (expr) => (expr === 'width' ? 40 : 20) });
    expect((same.outcome as unknown as { draft: typeof d }).draft.constraints.filter(isDimension).map((c) => c.expr)).toEqual(['width', '20 mm']);
    expect(same.valued).toEqual([]);
    // Read, but as another value (the target's own "width" is 55), with no units to go by: the value it had.
    const other = pasteClip(empty, clip, [0, 0], { evaluate: (expr) => (expr === 'width' ? 55 : 20) });
    expect((other.outcome as unknown as { draft: typeof d }).draft.constraints.filter(isDimension).map((c) => c.expr)).toEqual(['40 mm', '20 mm']);
    // The copy says its Part's units and the target's are the same: the parameter keeps its link.
    const mm = { length: 'mm', angle: 'deg' } as DocUnits;
    const linked = pasteClip(empty, clipOf(d, ['e1', 'e2', 'e3', 'e4'], mm) as SketchClip, [0, 0], { evaluate: (expr) => (expr === 'width' ? 55 : 20), units: mm });
    expect((linked.outcome as unknown as { draft: typeof d }).draft.constraints.filter(isDimension).map((c) => c.expr)).toEqual(['width', '20 mm']);
  });

  it('a unitless expression ("2*15") copied in a mm Part and pasted into an inch Part takes the value it had (30 mm), not 762 mm; the words say so; a mm one ("30 mm") keeps its text', () => {
    const mm = createUnitsService(() => ({ length: 'mm', angle: 'deg' }) as DocUnits);
    const inch = createUnitsService(() => ({ length: 'in', angle: 'deg' }) as DocUnits);
    const d = sketchOf(rectangle(0, 0, 30, 20, { hv: false }), { name: 'A' });
    d.constraints.push({ id: 'w', kind: 'distance', refs: ['e1'], expr: '2*15', driving: true } as SketchDimension);
    d.constraints.push({ id: 'h', kind: 'distance', refs: ['e2'], expr: '20 mm', driving: true } as SketchDimension);
    d.solved = { values: { w: evaluatedIn(mm, '2*15', 'length')!, h: 20 }, dof: 0, state: 'under' } as typeof d.solved;
    const clip = clipOf(d, ['e1', 'e2', 'e3', 'e4'], mm.units()) as SketchClip;
    expect(clip).toMatchObject({ values: { w: 30, h: 20 }, units: { length: 'mm', angle: 'deg' } });
    expect(readClip(JSON.parse(JSON.stringify(clip)))).toEqual(clip);
    expect(evaluatedIn(inch, '2*15', 'length')).toBeCloseTo(762, 9);
    const r = pasteClip(sketchOf({}, { name: 'B' }), clip, [0, 0], { evaluate: (expr, q) => evaluatedIn(inch, expr, q), units: inch.units() });
    expect((r.outcome as unknown as { draft: typeof d }).draft.constraints.filter(isDimension).map((c) => c.expr)).toEqual(['30 mm', '20 mm']);
    expect(valuedWords(r.valued)).toBe('1 dimension took the value it had (its expression "2*15" reads otherwise here)');
    // In a mm Part both read as they did: both kept.
    const same = pasteClip(sketchOf({}, { name: 'C' }), clip, [0, 0], { evaluate: (expr, q) => evaluatedIn(mm, expr, q), units: mm.units() });
    expect((same.outcome as unknown as { draft: typeof d }).draft.constraints.filter(isDimension).map((c) => c.expr)).toEqual(['2*15', '20 mm']);
    expect(valuedWords(same.valued)).toBeNull();
  });

  it('a clip read back from the prefs is checked: anything that is not a whole copy is none', () => {
    const clip = clipOf(drawing(), ['e1', 'e2']) as SketchClip;
    expect(readClip(JSON.parse(JSON.stringify(clip)))).toEqual(clip);
    expect(readClip(null)).toBeNull();
    expect(readClip({ ...clip, v: 2 })).toBeNull();
    expect(readClip({ ...clip, entities: [] })).toBeNull();
    // A point an entity uses is missing; a relation names something not copied.
    expect(readClip({ ...clip, points: { p1: [0, 0] } })).toBeNull();
    expect(readClip({ ...clip, constraints: [{ id: 'x', kind: 'tangent', refs: ['e1', 'c9'] }] })).toBeNull();
  });
});

describe("the page's clipboard and the prefs (another Part)", () => {
  const fakePrefs = () => {
    const store = new Map<string, unknown>();
    const calls: string[] = [];
    return {
      store,
      calls,
      prefs: {
        get: async (k: string) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
        set: async (k: string, v: unknown) => {
          calls.push(`set ${k}`);
          store.set(k, v);
        },
        remove: async (k: string) => {
          calls.push(`remove ${k}`);
          store.delete(k);
        },
        onChange: () => () => {},
      },
    };
  };

  it('a small copy goes to the prefs too, and a page with none (another Part) pastes it; a big one stays in its page and takes the old one out of the prefs', async () => {
    const p = fakePrefs();
    const services = { bridge: { prefs: p.prefs } } as never;
    const clip = clipOf(drawing(), ['e1', 'e2', 'e3', 'e4']) as SketchClip;
    expect(holdClip(services, clip)).toBe('prefs');
    await Promise.resolve();
    expect(p.calls).toEqual([`set ${CLIP_PREF}`]);
    expect(peekClip()).toBe(clip);
    // Another Part: a new page, nothing held; the prefs give it.
    forgetClip();
    expect(peekClip()).toBeNull();
    expect(await heldClip(services)).toEqual(clip);
    // Too big for the prefs: this page only, and the older copy leaves the prefs.
    const big = { ...clip, from: 'x'.repeat(CLIP_PREF_MAX) };
    expect(holdClip(services, big)).toBe('page');
    await Promise.resolve();
    expect(p.calls).toEqual([`set ${CLIP_PREF}`, `remove ${CLIP_PREF}`]);
    expect(await heldClip(services)).toBe(big);
    forgetClip();
    expect(await heldClip(services)).toBeNull();
    // No prefs (an older host): the page only.
    expect(holdClip({ bridge: {} } as never, clip)).toBe('page');
  });
});

describe('copy and paste in sketch mode (real solver)', () => {
  /** A 30 x 20 rectangle drawn away from the origin, its bottom dimensioned: 3 DOF. */
  async function rectangleWithDimension(hh: Harness) {
    hh.tool('rectangle-corner');
    hh.click([10, 10]);
    hh.click([40, 30]);
    await hh.idle();
    hh.tool('dimension');
    hh.click([25, 10]);
    hh.click([25, 4]);
    await hh.idle();
    const dim = hh.sketch().constraints.find(isDimension)!;
    expect((await hh.mode.setDimension(dim.id, '30')).ok).toBe(true);
    await hh.idle();
    hh.tool('select');
    expect(hh.mode.state.get().status).toMatchObject({ state: 'under', dof: 3 });
    return hh.sketch().entities.filter((e) => e.kind === 'line').map((e) => e.id);
  }
  const lines = (hh: Harness) => hh.sketch().entities.filter((e) => e.kind === 'line');
  const run = async (hh: Harness, id: string) => {
    const r = await hh.services.commands.run(id);
    await hh.idle();
    return r;
  };

  it('Copy, Paste: the copy follows the pointer; a click places it with its dimension; the DOF grows by the original\'s; it is selected; one undo step', async () => {
    h = await sketchHarness();
    const ids = await rectangleWithDimension(h);
    h.mode.select(ids.map((id) => ({ what: 'entity', id })), false);
    expect(await run(h, 'sketch.copy')).toBe(true);
    expect(h.mode.view.get().note).toBe('Copied 4 lines, 4 relations and 1 dimension.');
    const clip = peekClip()!;
    expect(near(clip.anchor, [25, 20])).toBe(true);
    expect(await run(h, 'sketch.paste')).toBe(true);
    expect(h.mode.state.get().tool).toBe('paste');
    expect(h.mode.view.get().hint).toBe('Paste 4 lines, 4 relations and 1 dimension: click where the middle of the copy goes (Enter or a click places it, one undo step; Esc cancels)');
    // The preview follows the pointer: its middle under it.
    h.move([100, 50]);
    const box = (pv: Vec2[][]) => {
      const xs = pv.flat().map((q) => q[0]);
      const ys = pv.flat().map((q) => q[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] as Vec2;
    };
    expect(near(box(h.mode.view.get().preview!.lines), [100, 50])).toBe(true);
    h.move([120, 60]);
    expect(near(box(h.mode.view.get().preview!.lines), [120, 60])).toBe(true);
    // Nothing added until the click.
    expect(lines(h)).toHaveLength(4);
    const depth = h.mode.undoDepth;
    h.click([120, 60]);
    await h.idle();
    // One sketch undo step.
    expect(h.mode.undoDepth).toBe(depth + 1);
    expect(lines(h)).toHaveLength(8);
    const dims = h.sketch().constraints.filter(isDimension) as SketchDimension[];
    expect(dims.map((c) => c.expr)).toEqual(['30 mm', '30 mm']);
    expect(h.mode.state.get().status).toMatchObject({ state: 'under', dof: 6 });
    expect(h.mode.state.get().tool).toBe('select');
    expect(h.mode.view.get().preview).toBeNull();
    // The copy is selected, and lies where it was placed: (105, 50) to (135, 70).
    const sel = h.mode.selected().map((x) => x.id);
    expect(sel).toHaveLength(4);
    expect(sel.every((id) => !ids.includes(id))).toBe(true);
    const pts = h.sketch().points;
    const at = sel.flatMap((id) => (h!.sketch().entities.find((e) => e.id === id) as Extract<SketchEntity, { kind: 'line' }>).p.map((p) => pts[p]));
    expect([Math.min(...at.map((q) => q[0])), Math.min(...at.map((q) => q[1])), Math.max(...at.map((q) => q[0])), Math.max(...at.map((q) => q[1]))].map((x) => +x.toFixed(9))).toEqual([105, 50, 135, 70]);
    expect(h.mode.view.get().note).toBeNull();
    // One undo step.
    h.mode.undo();
    await h.idle();
    expect(lines(h)).toHaveLength(4);
    expect(h.mode.state.get().status).toMatchObject({ dof: 3 });
  });

  it('a relation to geometry not copied is left out and said; Escape while pasting adds nothing', async () => {
    h = await sketchHarness();
    // From the origin: its corner coincident with the origin (2 DOF), not copied.
    h.tool('rectangle-corner');
    h.click([0.2, 0.1]);
    h.click([40.3, 20.2]);
    await h.idle();
    h.tool('select');
    const ids = lines(h).map((e) => e.id);
    h.mode.select(ids.map((id) => ({ what: 'entity', id })), false);
    await run(h, 'sketch.copy');
    expect(h.mode.view.get().note).toBe('Copied 4 lines and 4 relations; 1 relation to other geometry will be left out.');
    await run(h, 'sketch.paste');
    expect(h.mode.tool?.options?.().map((o) => ('text' in o ? o.text : o.id))).toEqual(['From Sketch 1: 4 lines and 4 relations', '1 relation to other geometry will be left out', 'cancel']);
    // Escape: the paste goes, nothing added.
    h.move([80, 0]);
    h.mode.escape();
    await h.idle();
    expect(h.mode.state.get().tool).toBe('select');
    expect(h.mode.view.get().preview).toBeNull();
    expect(lines(h)).toHaveLength(4);
    expect(h.mode.undoDepth).toBe(1);
    // Placed: said what was left out; the copy has the original's 2 DOF and the 2 the origin held.
    await run(h, 'sketch.paste');
    h.click([80, 0]);
    await h.idle();
    expect(lines(h)).toHaveLength(8);
    expect(h.mode.view.get().note).toBe('Pasted 4 lines and 4 relations: 1 relation to other geometry was left out.');
    expect(h.mode.state.get().status).toMatchObject({ dof: 6 });
  });

  it('Enter places the copy where the pointer is; Paste with nothing copied says so; another sketch (on Front) takes the same 2D shape', async () => {
    h = await sketchHarness();
    await run(h, 'sketch.paste');
    expect(h.mode.view.get().note).toBe('Nothing to paste: select sketch geometry and Copy it first');
    expect(h.mode.state.get().tool).toBe('select');
    // Copy needs geometry selected: the key is the browser's then.
    expect(h.services.commands.get('sketch.copy')!.passKey!()).toBe(true);
    const ids = await rectangleWithDimension(h);
    h.mode.select([...ids.map((id) => ({ what: 'entity' as const, id }))], false);
    expect(h.services.commands.get('sketch.copy')!.passKey!()).toBe(false);
    await run(h, 'sketch.copy');
    h.dispose();
    h = null;
    // Another sketch, on the Front plane: its own u, v.
    h2 = await sketchHarness({ name: 'Sketch 2', plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] }, support: { kind: 'plane', plane: 'origin:front' } });
    await run(h2, 'sketch.paste');
    expect(h2.mode.state.get().tool).toBe('paste');
    h2.move([0, 0]);
    expect(h2.mode.tool!.commit!()).toBe(true);
    await h2.idle();
    const d = h2.sketch();
    expect(d.entities.filter((e) => e.kind === 'line')).toHaveLength(4);
    const xs = Object.values(d.points).map((q) => q[0]);
    const ys = Object.values(d.points).map((q) => q[1]);
    expect(Math.min(...xs)).toBeCloseTo(-15, 9);
    expect(Math.max(...xs)).toBeCloseTo(15, 9);
    expect(Math.min(...ys)).toBeCloseTo(-10, 9);
    expect(Math.max(...ys)).toBeCloseTo(10, 9);
    expect(d.constraints.filter(isDimension).map((c) => c.expr)).toEqual(['30 mm']);
    expect(h2.mode.state.get().status).toMatchObject({ dof: 3 });
  });
});
