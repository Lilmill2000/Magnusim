// P4b SELECT: linked sketch geometry, the pure part (src/sketch/project/curves.ts): curves to
// fixed entities (a key keeps its entity, so constraints survive a re-projection), what a
// rebuild moves, lost and changed keys, Break link, pruning, the plane maths, and the solver's
// view (every linked point fixed with an internal id that never reaches a conflict list).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { PlaneFrame, SketchLink } from '../../src/types/doc';
import { applyLinkCurves, breakLinks, linkOfEntity, linkedRefusal, pierceSegment, projectSegment, prunedLinks, toPlaneUv, type LinkDraft } from '../../src/sketch/project/curves';
import { storedIdOf, toSolverSketch } from '../../src/sketch/model';
import { fromKernel } from '../../src/sketch/project/source';
import { linkLook } from '../../src/sketch/project/style';

const TOP: PlaneFrame = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };
const empty = (): LinkDraft => ({ points: {}, entities: [], constraints: [] });
const link = (id = 'l_1'): SketchLink => ({ id, type: 'projected', source: { kind: 'face', body: 'b_1', ref: { name: 'F:x:1', signature: { kind: 'plane', at: [0, 0, 0] } as never } }, entities: [] });

describe('plane maths', () => {
  it('a model point in the plane u/v (orthogonal along the normal)', () => {
    expect(toPlaneUv(TOP, [3, 4, 99])).toEqual([3, 4]);
    const front: PlaneFrame = { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] };
    // Front: v = normal x xdir = (0,-1,0) x (1,0,0) = (0,0,1).
    expect(toPlaneUv(front, [2, 7, 5])).toEqual([2, 5]);
  });
  it('a straight edge: a line, or a point seen end-on; where it pierces the plane', () => {
    expect(projectSegment(TOP, [0, 0, 5], [10, 0, 5])).toEqual({ kind: 'line', a: [0, 0], b: [10, 0] });
    expect(projectSegment(TOP, [3, 4, 0], [3, 4, 20])).toEqual({ kind: 'point', p: [3, 4] });
    expect(pierceSegment(TOP, [3, 4, -10], [3, 4, 10])).toEqual([3, 4]);
    expect(pierceSegment(TOP, [3, 4, 1], [3, 4, 10])).toBeNull();
    expect(pierceSegment(TOP, [0, 0, 5], [10, 0, 5])).toBeNull();
  });
  it("the kernel's arc (a0, a1 degrees, run direction) and B-spline (ends at its poles)", () => {
    const a = fromKernel({ kind: 'arc', c: [0, 0], r: 10, a0: 0, a1: 90, ccw: true });
    expect(a.kind).toBe('arc');
    if (a.kind === 'arc') {
      expect(a.a[0]).toBeCloseTo(10);
      expect(a.b[1]).toBeCloseTo(10);
      expect(a.ccw).toBe(true);
    }
    const b = fromKernel({ kind: 'bspline', degree: 3, poles: [[0, 0], [1, 1], [2, 1], [3, 0]], knots: [0, 1], mults: [4, 4] });
    expect(b).toMatchObject({ kind: 'bspline', a: [0, 0], b: [3, 0], closed: false });
  });
});

describe('curves to linked entities', () => {
  it("a face's loop: lines sharing their corner points, all tagged, the link row keyed", () => {
    const sq = [
      { key: 'E:a&b', curve: { kind: 'line' as const, a: [0, 0] as [number, number], b: [40, 0] as [number, number] } },
      { key: 'E:b&c', curve: { kind: 'line' as const, a: [40, 0] as [number, number], b: [40, 20] as [number, number] } },
      { key: 'E:c&d', curve: { kind: 'line' as const, a: [40, 20] as [number, number], b: [0, 20] as [number, number] } },
      { key: 'E:d&a', curve: { kind: 'line' as const, a: [0, 20] as [number, number], b: [0, 0] as [number, number] } },
    ];
    const r = applyLinkCurves(empty(), link(), sq);
    expect(r.added).toHaveLength(4);
    expect(Object.keys(r.draft.points)).toHaveLength(4);
    expect(r.draft.entities.every((e) => e.link === 'l_1')).toBe(true);
    expect(r.link.entities.map((x) => x.key)).toEqual(['E:a&b', 'E:b&c', 'E:c&d', 'E:d&a']);
    expect(r.draft.links).toHaveLength(1);

    // Re-projected 10 mm wider: the same entities move (ids kept); nothing added, nothing lost.
    const wider = sq.map((c) => ({ key: c.key, curve: { ...c.curve, a: [c.curve.a[0] === 40 ? 50 : c.curve.a[0], c.curve.a[1]] as [number, number], b: [c.curve.b[0] === 40 ? 50 : c.curve.b[0], c.curve.b[1]] as [number, number] } }));
    const again = applyLinkCurves(r.draft, r.link, wider);
    expect(again.lostKeys).toEqual([]);
    expect(again.changed).toBe(true);
    expect(Object.values(again.draft.points).filter((p) => p[0] === 50)).toHaveLength(2);
    expect(again.added).toEqual([]);
    expect(again.draft.entities.map((e) => e.id)).toEqual(r.draft.entities.map((e) => e.id));

    // One edge gone (a face lost its notch): its key is lost, the entity stays.
    const three = wider.slice(0, 3);
    const kept = applyLinkCurves(r.draft, r.link, three);
    expect(kept.lostKeys).toEqual(['E:d&a']);
    expect(kept.draft.entities).toHaveLength(4);

    // A new edge: added (with the same deterministic id every time: the rebuild and the opened sketch agree).
    const five = [...wider, { key: 'E:x&y', curve: { kind: 'line' as const, a: [0, 0] as [number, number], b: [5, 5] as [number, number] } }];
    const f1 = applyLinkCurves(r.draft, r.link, five);
    expect(f1.added).toHaveLength(1);
    expect(applyLinkCurves(r.draft, r.link, five).added).toEqual(f1.added);
  });

  it('a curve that changes kind gets a new entity; the old one stays, lost', () => {
    const r = applyLinkCurves(empty(), link(), [{ key: 'e', curve: { kind: 'line', a: [0, 0], b: [10, 0] } }]);
    const r2 = applyLinkCurves(r.draft, r.link, [{ key: 'e', curve: { kind: 'arc', c: [5, 0], r: 5, a: [10, 0], b: [0, 0], ccw: true } }]);
    expect(r2.added).toHaveLength(1);
    expect(r2.draft.entities.map((e) => e.kind)).toEqual(['line', 'arc']);
    expect(r2.lostKeys).toHaveLength(1);
  });

  it("a circle's radius moves with it; a B-spline keeps its knots", () => {
    const r = applyLinkCurves(empty(), link(), [{ key: 'e', curve: { kind: 'circle', c: [0, 0], r: 5 } }]);
    const m = applyLinkCurves(r.draft, r.link, [{ key: 'e', curve: { kind: 'circle', c: [1, 1], r: 7 } }]);
    expect(m.draft.entities.map((e) => (e.kind === 'circle' ? e.r : null))).toEqual([7]);
    const s = applyLinkCurves(empty(), link('l_2'), [{ key: 'c0', curve: { kind: 'bspline', degree: 3, poles: [[0, 0], [1, 1], [2, 1], [3, 0]], knots: [0, 1], mults: [4, 4], a: [0, 0], b: [3, 0], closed: false } }]);
    expect(s.draft.entities[0]).toMatchObject({ kind: 'spline', form: 'control', degree: 3, knots: [0, 1], mults: [4, 4] });
  });
});

describe('upkeep and the solver', () => {
  const base = () => applyLinkCurves(empty(), link(), [{ key: 'e', curve: { kind: 'line', a: [0, 0], b: [10, 0] } }]).draft;
  it('Break link: the entity becomes ordinary geometry; the link row goes with its last entity', () => {
    const d = base();
    const id = d.entities[0].id;
    expect(linkOfEntity(d, id)?.id).toBe('l_1');
    expect(linkedRefusal(d, id, 'Line 1')).toBe('Line 1 follows the model: Break link first (right-click it)');
    const b = breakLinks(d, [id])!;
    expect(b.entities[0].link).toBeUndefined();
    expect(b.links).toBeUndefined();
    expect(breakLinks(b, [id])).toBeNull();
  });
  it('a deleted entity leaves its link row (pruned)', () => {
    const d = base();
    expect(prunedLinks({ ...d, entities: [] })).toBeUndefined();
  });
  it('every linked point fixed for the solver, with internal ids no conflict list shows', () => {
    const d = applyLinkCurves(base(), link('l_2'), [{ key: 'e', curve: { kind: 'circle', c: [5, 5], r: 3 } }]).draft;
    const s = toSolverSketch(d);
    const fixes = s.constraints.filter((c) => c.id.startsWith('#ln:'));
    expect(fixes).toHaveLength(3);
    expect(s.constraints.filter((c) => c.id.startsWith('#lr:'))).toEqual([expect.objectContaining({ kind: 'radius', value: 3 })]);
    expect(storedIdOf('#ln:pt_x')).toBeNull();
    expect(storedIdOf('#lr:e_x')).toBeNull();
    expect(storedIdOf('c_1#a')).toBe('c_1');
  });
  it('the look: purple, amber when the last build lost it, light when auto-made', () => {
    const d = base();
    const id = d.entities[0].id;
    expect(linkLook(d, undefined).entities.get(id)).toEqual({ lost: false, light: false });
    const out = { type: 'sketch', links: { l_1: { state: 'lost', lost: [id] } } } as never;
    expect(linkLook(d, out).entities.get(id)).toEqual({ lost: true, light: false });
    const auto = { ...d, links: d.links!.map((l) => ({ ...l, auto: true })) };
    expect(linkLook(auto, undefined).entities.get(id)?.light).toBe(true);
  });
});

// ---- P4b fix round 1 (B-1, B-2): the source gains or loses curves; the user deletes or breaks one.
type P2 = [number, number];
const line = (key: string, a: P2, b: P2) => ({ key, curve: { kind: 'line' as const, a, b } });
const arc = (key: string, c: P2, r: number, a: P2, b: P2) => ({ key, curve: { kind: 'arc' as const, c, r, a, b, ccw: true } });
const rect = () => [line('E:f', [0, 0], [40, 0]), line('E:r', [40, 0], [40, 20]), line('E:b', [40, 20], [0, 20]), line('E:l', [0, 20], [0, 0])];
/** Each linked entity's end positions now. */
function ends(d: LinkDraft, id: string): P2[] {
  const e = d.entities.find((x) => x.id === id)!;
  const ids = e.kind === 'line' ? e.p : e.kind === 'arc' ? [e.a, e.b] : [];
  return ids.map((p) => d.points[p] as P2);
}
const entOf = (d: LinkDraft, l: SketchLink, key: string) => l.entities.find((r) => r.key === key)!.entity;

describe('B-1: a projected outline that gains and loses curves upstream', () => {
  it('a rounded corner: the kept lines are shortened, not skewed, and every end meets exactly one other', () => {
    const r = applyLinkCurves(empty(), link(), rect());
    // Fillet r 4 at (40, 0): the front and right lines end 4 mm short, an arc joins them.
    const rounded = [line('E:f', [0, 0], [36, 0]), arc('E:fil', [36, 4], 4, [36, 0], [40, 4]), line('E:r', [40, 4], [40, 20]), line('E:b', [40, 20], [0, 20]), line('E:l', [0, 20], [0, 0])];
    const a = applyLinkCurves(r.draft, r.link, rounded);
    expect(a.lostKeys).toEqual([]);
    expect(a.added).toHaveLength(1);
    expect(ends(a.draft, entOf(a.draft, a.link, 'E:f'))).toEqual([[0, 0], [36, 0]]);
    expect(ends(a.draft, entOf(a.draft, a.link, 'E:r'))).toEqual([[40, 4], [40, 20]]);
    expect(ends(a.draft, entOf(a.draft, a.link, 'E:b'))).toEqual([[40, 20], [0, 20]]);
    // Joined: 5 places, each the end of two curves (a closed loop).
    const count = new Map<string, number>();
    for (const e of a.draft.entities) for (const p of e.kind === 'line' ? e.p : e.kind === 'arc' ? [e.a, e.b] : []) count.set(p, (count.get(p) ?? 0) + 1);
    expect([...count.values()]).toEqual([2, 2, 2, 2, 2]);
    // The rebuild (in memory) and the opened sketch (stored) give the same entities and points.
    const b = applyLinkCurves(r.draft, r.link, rounded);
    expect(b.draft.entities).toEqual(a.draft.entities);
    expect(b.draft.points).toEqual(a.draft.points);
    // Applied again: nothing changes.
    expect(applyLinkCurves(a.draft, a.link, rounded).changed).toBe(false);
  });

  it('a curve whose key goes (Delete faces of a fillet) stays where it was, lost; the new one is beside it, not on it', () => {
    // The front edge was the fillet's (y = 4); after Delete faces it is the front face's (y = 0), a new key.
    const before = [line('E:fil', [0, 4], [40, 4]), line('E:r', [40, 4], [40, 20]), line('E:b', [40, 20], [0, 20]), line('E:l', [0, 20], [0, 4])];
    const r = applyLinkCurves(empty(), link(), before);
    const after = [line('E:front', [0, 0], [40, 0]), line('E:r', [40, 0], [40, 20]), line('E:b', [40, 20], [0, 20]), line('E:l', [0, 20], [0, 0])];
    const a = applyLinkCurves(r.draft, r.link, after);
    expect(a.lostKeys).toEqual(['E:fil']);
    expect(ends(a.draft, entOf(a.draft, a.link, 'E:fil'))).toEqual([[0, 4], [40, 4]]);
    expect(ends(a.draft, entOf(a.draft, a.link, 'E:front'))).toEqual([[0, 0], [40, 0]]);
    expect(ends(a.draft, entOf(a.draft, a.link, 'E:r'))).toEqual([[40, 0], [40, 20]]);
  });
});

describe('B-2: Delete and Break link of one projected curve are kept', () => {
  it('a deleted curve is dropped from its link and never re-added', () => {
    const r = applyLinkCurves(empty(), link(), rect());
    const front = entOf(r.draft, r.link, 'E:f');
    const without: LinkDraft = { ...r.draft, entities: r.draft.entities.filter((e) => e.id !== front) };
    const links = prunedLinks(without)!;
    expect(links[0].dropped).toEqual(['E:f']);
    expect(links[0].entities).toHaveLength(3);
    const a = applyLinkCurves({ ...without, links }, links[0], rect());
    expect(a.added).toEqual([]);
    expect(a.lostKeys).toEqual([]);
    expect(a.changed).toBe(false);
  });

  it('a broken curve gets its own ends (free to drag), is dropped, and a wider face does not move it', () => {
    const r = applyLinkCurves(empty(), link(), rect());
    const front = entOf(r.draft, r.link, 'E:f');
    const b = breakLinks(r.draft, [front])!;
    const e = b.entities.find((x) => x.id === front)!;
    expect(e.link).toBeUndefined();
    const others = new Set(b.entities.filter((x) => x.link).flatMap((x) => (x.kind === 'line' ? x.p : [])));
    expect(e.kind === 'line' && e.p.some((p) => others.has(p))).toBe(false);
    expect(b.links![0].dropped).toEqual(['E:f']);
    // Width 40 -> 60 upstream: the broken line stays, nothing is added on top of it.
    const wider = [line('E:f', [0, 0], [60, 0]), line('E:r', [60, 0], [60, 20]), line('E:b', [60, 20], [0, 20]), line('E:l', [0, 20], [0, 0])];
    const a = applyLinkCurves(b, b.links![0], wider);
    expect(a.added).toEqual([]);
    expect(ends(a.draft, front)).toEqual([[0, 0], [40, 0]]);
    expect(a.draft.entities.filter((x) => x.kind === 'line')).toHaveLength(4);
  });
});
