// The sketch writer's watch path (CAD tools spec §6.5, §8.2, §12.1 sketch-write.test.ts), on the
// REAL kernel and solver through the real sketch mode, at the watch pace with its delays scaled
// to 0 (every apply still happens, nothing waits):
//   - moves that are small: each entity is drawn where the model put it (its rubber band first,
//     then added and selected), then each relation, then each dimension; every apply is solved by
//     sketch mode, so the DOF counts down and the dimensions pull the sketch into shape; what is
//     stored at the end is the headless solution;
//   - moves that are large: the entities are drawn where the solution has them (nothing jumps);
//   - a partial solve that took another path (forced: the headless solve on the other branch of
//     a two-branch sketch): one final apply writes the headless solution exactly;
//   - an intermediate apply sketch mode refuses (forced) ends the drawing early: the final apply
//     writes the solution, the call is kept, never reverted;
//   - a replace draws its difference: what goes in one apply, a new entity one by one;
//   - the hold point sketch-step:<n> follows the n-th apply; the fast pace is one apply.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeOf } from '../../src/assistant/runtime';
import * as solveModule from '../../src/assistant/sketch/solve';
import { drawAt, drawSteps, groupOf, isExactly } from '../../src/assistant/sketch/write';
import type { SketchMode } from '../../src/sketch/mode';
import type { SketchFeature, Vec2 } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { C, E, featureNamed, partNow, SK } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  h?.dispose();
  h = null;
});

interface Applied {
  label: string;
  /** What the apply asked for (points), before sketch mode solved it. */
  asked: Record<string, Vec2>;
  ok: boolean;
  /** What sketch mode stored after it, and its DOF then. */
  stored: Record<string, Vec2>;
  dof: number | null;
  entities: string[];
  constraints: string[];
  /** The rubber band shown just before it (lines and arcs). */
  preview: number;
  selected: string[];
}

/** Every apply of sketch mode from now on; `refuse(n)`: the n-th (1-based) is refused as a collapse. */
function recordApplies(x: AssistantHarness, o: { refuse?: number } = {}): Applied[] {
  const mode = x.mode as SketchMode;
  const log: Applied[] = [];
  const apply = mode.apply.bind(mode);
  let lastPreview = 0;
  const setPreview = mode.setPreview.bind(mode);
  vi.spyOn(mode, 'apply').mockImplementation(async (label, make, opts) => {
    const n = log.length + 1;
    let asked: Record<string, Vec2> = {};
    const preview = lastPreview;
    lastPreview = 0;
    const r =
      o.refuse === n
        ? { ok: false as const, reason: 'would shrink line r.top to nothing' }
        : await apply(
            label,
            (d) => {
              const out = make(d);
              if (out && 'points' in out) asked = { ...(out as { points: Record<string, Vec2> }).points };
              return out;
            },
            opts,
          );
    const st = mode.stored();
    log.push({
      label,
      asked,
      ok: r.ok,
      stored: { ...(st?.points ?? {}) },
      dof: mode.state.get().status?.dof ?? null,
      entities: st?.entities.map((e) => e.id) ?? [],
      constraints: st?.constraints.map((c) => c.id) ?? [],
      preview,
      selected: x.services.selection.get().items.flatMap((it) => (it.kind === 'sketch' ? [`${it.what}:${it.id}`] : [])),
    });
    return r;
  });
  vi.spyOn(mode, 'setPreview').mockImplementation((p) => {
    if (p) lastPreview = p.lines.length + p.arcs.length + p.points.length;
    setPreview(p);
  });
  return log;
}

const near = (a: Vec2 | undefined, b: Vec2, tol = 1e-6) => !!a && Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

/** A 60 x 40 rectangle centred on the origin, drawn where `at` says ([cu, cv, w, h]). */
const plate = (at: number[]) =>
  SK({
    name: 'Plate sketch',
    entities: [E('r', 'center_rect', at)],
    constraints: [C('c0', 'coincident', ['r.center', 'origin']), C('dw', 'distance', ['r.bottom'], '60 mm'), C('dh', 'distance', ['r.left'], '40 mm')],
  });

describe('the watch path', () => {
  it(
    "draws where the model put it when the solution moves little, then the relations and dimensions pull it; the DOF counts down to 0",
    async () => {
      h = await assistantHarness({ sketchMode: true, pace: 'watch' });
      const log = recordApplies(h);
      const r = await h.call('sketch', plate([0.5, 0.4, 59, 39]));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      // The last dimension's solve is the headless solution already: no final apply.
      expect(log.map((a) => a.label)).toEqual(['Draw center_rect r', 'Relation c0', 'Dimension dw', 'Dimension dh']);
      // The rect went in where the model drew it (its corner at (0.5 - 29.5, 0.4 - 19.5)), after its rubber band, and was selected.
      expect(near(log[0].asked.r__bl, [-29, -19.1])).toBe(true);
      // Its rubber band: 4 sides and its centre point.
      expect(log[0].preview).toBe(5);
      // Selected once in (still selected when the next apply ran), then the relation.
      expect(log[1].selected).toEqual(['entity:r__bottom']);
      expect(log[2].selected).toEqual(['constraint:c0']);
      // Each apply solved: the DOF goes down as the relation and the dimensions go in.
      expect(log.slice(0, 4).map((a) => a.dof)).toEqual([4, 2, 1, 0]);
      expect(log[3].stored.r__bl[0]).toBeCloseTo(-30, 6);
      expect(log[3].stored.r__bl[1]).toBeCloseTo(-20, 6);
      // Stored: the headless solution (the final apply writes it exactly), fully defined, one undo entry.
      const f = featureNamed(h, 'Plate sketch');
      expect(near(f.points.r__bl, [-30, -20])).toBe(true);
      expect(near(f.points.r__tr, [30, 20])).toBe(true);
      expect(f.solved).toMatchObject({ dof: 0, state: 'fully' });
      expect(partNow(h)).toMatchObject({ features: ['Plate sketch'], session: false, panel: false, mode: 'model' });
      expect(h.doc.state.get().history.undoLabel).toMatch(/^Assistant: /);
      // Nothing of the drawing stays selected.
      expect(h.services.selection.get().items).toEqual([]);
    },
    REAL_KERNEL_MS,
  );

  it(
    'draws where the solution has them when the solution moves a point far (nothing jumps)',
    async () => {
      h = await assistantHarness({ sketchMode: true, pace: 'watch' });
      const log = recordApplies(h);
      // Drawn 10 x 10 at (8, 5): the solution moves the corners by more than 10% of its diagonal.
      const r = await h.call('sketch', plate([8, 5, 10, 10]));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(log[0].label).toBe('Draw center_rect r');
      expect(near(log[0].asked.r__bl, [-30, -20])).toBe(true);
      expect(near(log[0].asked.r__tr, [30, 20])).toBe(true);
      // Every apply keeps the corners where they are: they already sit at the solution.
      for (const a of log) expect(near(a.stored.r__bl, [-30, -20], 1e-6)).toBe(true);
      expect(featureNamed(h, 'Plate sketch').solved).toMatchObject({ dof: 0, state: 'fully' });
    },
    REAL_KERNEL_MS,
  );

  it(
    "writes the headless solution exactly when the partial solves took another path (the other branch of a two-branch sketch)",
    async () => {
      h = await assistantHarness({ sketchMode: true, pace: 'watch' });
      // A flat triangle: a 10 mm base on the u axis from the origin, two 5.02 mm sides; its apex has two places, (5, 0.4477) and (5, -0.4477).
      const tri = SK({
        name: 'Tri',
        entities: [E('a', 'line', [0, 0, 10, 0]), E('b', 'line', [10, 0, 5, 0.45]), E('c', 'line', [5, 0.45, 0, 0])],
        constraints: [C('o', 'coincident', ['a.start', 'origin']), C('ha', 'horizontal', ['a']), C('la', 'distance', ['a'], '10 mm'), C('lb', 'distance', ['b'], '5.02 mm'), C('lc', 'distance', ['c'], '5.02 mm')],
      });
      // The headless solve is made to land on the lower branch; the drawing starts on the upper one (0.9 mm away: the guesses are used).
      const real = solveModule.solveSketch;
      vi.spyOn(solveModule, 'solveSketch').mockImplementation(async (...args) => {
        const s = await real(...args);
        const points = Object.fromEntries(Object.entries(s.geometry.points).map(([id, p]) => [id, [p[0], -p[1]] as Vec2]));
        return { ...s, geometry: { ...s.geometry, points } };
      });
      const log = recordApplies(h);
      const r = await h.call('sketch', tri);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const labels = log.map((a) => a.label);
      expect(labels.slice(0, 3)).toEqual(['Draw line a', 'Draw line b', 'Draw line c']);
      expect(labels[labels.length - 1]).toBe('Solve');
      // The drawing ended on the upper branch; the final apply stored the lower one.
      expect(log[log.length - 2].stored.b__end[1]).toBeGreaterThan(0.4);
      const f = featureNamed(h, 'Tri');
      expect(f.points.b__end[1]).toBeCloseTo(-Math.sqrt(5.02 ** 2 - 25), 4);
      expect(f.solved).toMatchObject({ dof: 0, state: 'fully' });
    },
    REAL_KERNEL_MS,
  );

  it(
    'a refused intermediate apply ends the drawing early: the final apply writes the solution, and the call is kept',
    async () => {
      h = await assistantHarness({ sketchMode: true, pace: 'watch' });
      const log = recordApplies(h, { refuse: 2 });
      const r = await h.call('sketch', plate([0.5, 0.4, 59, 39]));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(log.map((a) => [a.label, a.ok])).toEqual([
        ['Draw center_rect r', true],
        ['Relation c0', false],
        ['Solve', true],
      ]);
      const f = featureNamed(h, 'Plate sketch');
      expect(near(f.points.r__bl, [-30, -20])).toBe(true);
      expect(f.solved).toMatchObject({ dof: 0, state: 'fully' });
      expect(runtimeOf(h.services)!.ledger.entries('turn:t-test').map((e) => e.part)).toEqual(['Sketch Plate sketch']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a replace draws its difference: a new circle one by one, then what goes in one apply',
    async () => {
      h = await assistantHarness({ sketchMode: true, pace: 'watch' });
      expect((await h.call('sketch', plate([0, 0, 60, 40]))).ok).toBe(true);
      const log = recordApplies(h);
      const withHole = { ...plate([0, 0, 60, 40]), edit: 'Plate sketch', on: '', entities: [E('r', 'center_rect', [0, 0, 60, 40]), E('h', 'circle', [10, 0, 3])] };
      expect((await h.call('sketch', withHole)).ok).toBe(true);
      expect(log.map((a) => a.label)[0]).toBe('Draw circle h');
      expect(log[0].entities).toContain('h');
      log.length = 0;
      expect((await h.call('sketch', { ...plate([0, 0, 60, 40]), edit: 'Plate sketch', on: '' })).ok).toBe(true);
      expect(log[0].label).toBe('Remove');
      expect(log[0].entities).not.toContain('h');
      expect(featureNamed(h, 'Plate sketch').entities.map((e) => e.id)).toEqual(['r__bottom', 'r__right', 'r__top', 'r__left', 'r__center']);
    },
    REAL_KERNEL_MS,
  );

  it(
    'holds at sketch-step:<n> after the n-th apply; the fast pace is one apply, then sketch-step:1',
    async () => {
      h = await assistantHarness({ sketchMode: true, pace: 'watch' });
      const rt = runtimeOf(h.services)!;
      rt.holds.hold('sketch-step:2');
      const r = h.call('sketch', plate([0, 0, 60, 40]));
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['sketch-step:2']), { timeout: 60_000 });
      // The rect and the coincident are in; the dimensions not yet.
      const d = (h.mode as SketchMode).stored() as SketchFeature;
      expect(d.constraints.map((c) => c.id)).toContain('c0');
      expect(d.constraints.map((c) => c.id)).not.toContain('dw');
      rt.holds.release('sketch-step:2');
      expect((await r).ok).toBe(true);
      // Fast: one apply.
      rt.pace.force('fast');
      const log = recordApplies(h);
      rt.holds.hold('sketch-step:1');
      const r2 = h.call('sketch', { ...plate([0, 0, 60, 40]), name: 'Second' });
      await vi.waitFor(() => expect(rt.holds.waiting()).toEqual(['sketch-step:1']), { timeout: 60_000 });
      expect(log.map((a) => a.label)).toEqual(['Sketch']);
      rt.holds.release('sketch-step:1');
      expect((await r2).ok).toBe(true);
    },
    REAL_KERNEL_MS,
  );
});

describe('the pure pieces', () => {
  it('groups a macro with its own and inferred relations; the model draws where it put things unless the solution moves far', () => {
    expect(['r__bottom', 'r__h_top', 'p__1__h', 'l1', 'e_3'].map(groupOf)).toEqual(['r', 'r', 'p', 'l1', 'e_3']);
    const target = { points: { a: [0, 0] as Vec2, b: [10, 0] as Vec2 }, entities: [{ id: 'l', kind: 'line' as const, p: ['a', 'b'] as [string, string] }], constraints: [] };
    const near1 = { ...target, points: { a: [0, 0.5] as Vec2, b: [10, 1] as Vec2 } };
    expect(drawAt(target, near1)).toMatchObject({ guesses: true, moved: 1, geometry: { points: { b: [10, 1] } } });
    const far = { ...target, points: { a: [0, 0] as Vec2, b: [10, 3] as Vec2 } };
    expect(drawAt(target, far)).toMatchObject({ guesses: false, moved: 3, geometry: { points: { b: [10, 0] } } });
    expect(drawAt(target, undefined).guesses).toBe(false);
    // The steps from nothing: the line, then nothing else; already there: none.
    expect(drawSteps({ points: {}, entities: [], constraints: [] }, target).map((s) => s.label)).toEqual(['Draw line l']);
    expect(drawSteps(target, target)).toEqual([]);
    expect(isExactly(target, target, 1e-9)).toBe(true);
    expect(isExactly(near1, target, 1e-9)).toBe(false);
  });
});
