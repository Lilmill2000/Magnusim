// Selectors on the REAL kernel (CAD tools spec §5.4, §12.1 selectors-resolve.test.ts), through the
// page's own resolution and the find tool as the bridge calls it, on a block with a hole, a fillet
// on a top edge, a slot cut across its top (which splits the top and the fillet) and a boss
// joined beside it (its top merges with the block's); two cubes made by one extrude of two
// profiles; a pipe swept along a line and an arc; a pattern's copy and a mirror's copy:
//   - roles: split faces (~k, with the split warning), merged faces (either part's label), sides by
//     their sketch entity, multi-profile caps end(2), sweep sides side(o@a2), copies and the mirror;
//     no face left lists the roles that are, with candidates; a word that is no role says so;
//   - queries: >Z >Z[2] >Z[3] (and [4] out of range), <Z +Z -Z |Z #Z %cylinder %torus hole boss
//     radius largest nearest, feature scopes, edges and vertices;
//   - points within and outside the tolerance, a face and an edge tie as ambiguous;
//   - edges of a face live, filtered fixed; A & B; faces that do not meet;
//   - a single-entity field names one, with at most 8 candidates;
//   - regions (even-odd all, r<N>, at(u, v), an open sketch), planes with offsets, axes;
//   - the person's selection, also on the bodies before a feature;
//   - edits resolve on the bodies before the feature; what a feature may keep (self, later);
//   - handles: by name, moved, stale, and per key;
//   - a kernel restart while a selector is read: read once more; twice: busy/changed.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { axisRefOf, edgeRefOf, faceRefOf, planeRefOf, regionRefOf, targetRefOf } from '../../src/assistant/selectors/refs';
import { applyFilters, echo, edgeLabel, selectAny, selectOne, selectSet, withScene, type AxisHit, type EdgeHit, type FaceHit, type PlaneHit, type RegionHit, type Scene } from '../../src/assistant/selectors/resolve';
import { topoCacheOf } from '../../src/assistant/selectors/topo-cache';
import { splitMerged } from '../../src/naming/names';
import type { FeatureId } from '../../src/types/doc';
import type { KernelAdapter } from '../../src/types/kernel';
import { realKernelAnywhere } from '../features/p2/kernel-anywhere';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { bodyNamed, extrude, faceNamed, filletEdge, regions, Shapes, sketchOn, sketchOnFace } from './parts';

type Row = Record<string, unknown>;

const call = (h: AssistantHarness, key = 'turn:t-test') => ({ services: h.services, key, signal: new AbortController().signal, progress: () => {} });
const scene = <T>(h: AssistantHarness, fn: (sc: Scene) => Promise<T>, opts: { before?: FeatureId | null; self?: FeatureId | null } = {}, key?: string) => withScene(call(h, key), opts, fn);
const names = (h: FaceHit[] | EdgeHit[]) => (h as FaceHit[]).map((x) => x.body.names?.faces[x.index] ?? null);
const reasonOf = async (p: Promise<unknown>): Promise<{ reason: string; message: string; detail: Row }> => {
  try {
    await p;
  } catch (e) {
    const t = e as { reason?: string; message: string; detail?: Row };
    if (!t.reason) throw e;
    return { reason: t.reason, message: t.message, detail: t.detail ?? {} };
  }
  throw new Error('it answered');
};
const has = (name: string | null, part: string) => !!name && splitMerged(name).some((p) => p === part || p.replace(/#\d+$/, '') === part);

interface Block {
  base: string;
  fillet: string;
  slot: string;
  boss: string;
  twin: string;
  pipe: string;
  sketch: string;
  path: string;
}

/** The test Part (see the file header). */
async function block(h: AssistantHarness): Promise<Block> {
  const sketch = await sketchOn(h, 'Base sketch', 'origin:top', new Shapes().rect('e', 0, 0, 40, 30).circle('h', [30, 15], 4));
  const base = await extrude(h, 'Base', regions(h, sketch, (_s, a) => a > 1000));
  let b = bodyNamed(h, 'Body 1');
  const fillet = await filletEdge(h, 'Fillet 1', b, faceNamed(b, `F:${base}:end`), b.names!.faces.findIndex((n) => n.startsWith(`F:${base}:side:e1[`)));
  b = bodyNamed(h, 'Body 1');
  const slotSketch = await sketchOnFace(h, 'Slot sketch', b, faceNamed(b, `F:${base}:end`), new Shapes().rect('s', 8, -1, 12, 31));
  const slot = await extrude(h, 'Slot', regions(h, slotSketch), { op: 'cut', flip: true, distance: '2 mm' });
  const bossSketch = await sketchOn(h, 'Boss sketch', 'origin:top', new Shapes().rect('k', 40, 0, 60, 30));
  const boss = await extrude(h, 'Boss', regions(h, bossSketch), { op: 'join' });
  const two = await sketchOn(h, 'Two sketch', 'origin:top', new Shapes().rect('a', 100, 0, 110, 10).rect('b', 120, 0, 130, 10));
  const twin = await extrude(h, 'Twin', regions(h, two));
  const path = await sketchOn(h, 'Path', 'origin:top', new Shapes().line('l1', [0, 100], [20, 100]).arc('a2', [20, 110], [20, 100], [30, 110]));
  const ring = await sketchOn(h, 'Ring', 'origin:right', new Shapes().circle('o', [100, 0], 2));
  const pipe = await h.add('sweep', { name: 'Pipe', profiles: regions(h, ring), path: { sketch: path, entities: ['l1', 'a2'] }, orientation: 'follow', op: 'new' });
  const twinBody = bodyNamed(h, 'Body 2');
  await h.add('pattern_linear', { name: 'Row', of: 'bodies', bodies: [twinBody.id], dir1: { axis: { kind: 'origin', axis: 'origin:y' }, flip: false, count: '2', mode: 'spacing', distance: '50 mm', symmetric: false }, dir2: null, op: 'new' });
  await h.add('mirror', { name: 'Flip', of: 'bodies', bodies: [twinBody.id], plane: { kind: 'origin', plane: 'origin:right' }, op: 'new' });
  const st = h.doc.state.get().rebuild;
  for (const [id, f] of Object.entries(st.features)) if (f.state !== 'ok') throw new Error(`${id} is ${f.state}: ${f.message}`);
  return { base, fillet, slot, boss, twin, pipe, sketch, path };
}

describe('selectors on a real block', () => {
  let h: AssistantHarness;
  let P: Block;
  beforeAll(async () => {
    h = await assistantHarness();
    P = await block(h);
  }, REAL_KERNEL_MS);
  afterAll(() => h?.dispose());

  it(
    'roles: split faces ~k with a warning, merged faces by either label, sides by entity, end(2), sweep sides, copies',
    async () => {
      await scene(h, async (sc) => {
        const ends = (await selectSet(sc, 'Base.end', 'face', 'targets')).hits as FaceHit[];
        expect(ends).toHaveLength(2);
        expect(names(ends).every((n) => has(n, `F:${P.base}:end`))).toBe(true);
        expect(ends[0].warnings.join(' ')).toMatch(/split face/);
        const one = (await selectOne(sc, 'Base.end~1', 'face', 'on')).hit as FaceHit;
        expect(one.body.names!.faces[one.index]).toBe(`F:${P.base}:end#0`);
        const two = (await selectOne(sc, 'Base.end~2', 'face', 'on')).hit as FaceHit;
        expect(has(two.body.names!.faces[two.index], `F:${P.boss}:end`)).toBe(true);
        // The merged top: the boss's end selects it too, and its label is one of the two.
        const bossEnd = (await selectOne(sc, 'Boss.end', 'face', 'on')).hit as FaceHit;
        expect(bossEnd.index).toBe(two.index);
        expect(['Boss.end', 'Base.end~2']).toContain(sc.labels.of(bossEnd.bi, bossEnd.index).label);
        // The front wall: the block's side e1 merged with the boss's k1.
        const front = (await selectOne(sc, 'Base.side(e1)', 'face', 'on')).hit as FaceHit;
        expect((await selectOne(sc, 'Boss.side(k1)', 'face', 'on')).hit).toMatchObject({ index: front.index });
        expect(front.topo.normal).toEqual([0, -1, 0]);
        expect(((await selectOne(sc, 'Base.side(e4)', 'face', 'on')).hit as FaceHit).topo.normal).toEqual([-1, 0, 0]);
        const hole = (await selectOne(sc, 'Base.side(h)', 'face', 'on')).hit as FaceHit;
        expect(hole.topo).toMatchObject({ type: 'cylinder', radius: 4 });
        // The fillet, split by the slot: two pieces of fillet(1).
        expect((await selectSet(sc, 'Fillet 1.fillet(1)', 'face', 'targets')).hits).toHaveLength(2);
        expect((await selectSet(sc, 'Fillet 1.fillet', 'face', 'targets')).hits).toHaveLength(2);
        // Two profiles of one extrude: their caps by profile number.
        const e2 = (await selectOne(sc, 'Twin.end(2)', 'face', 'on')).hit as FaceHit;
        expect(e2.body.names!.faces[e2.index]).toBe(`F:${P.twin}:end:1`);
        expect(e2.topo.centroid).toEqual([125, 5, 10]);
        expect(((await selectOne(sc, 'Twin.end(1)', 'face', 'on')).hit as FaceHit).topo.centroid).toEqual([105, 5, 10]);
        // A sweep's sides by the profile's entity and the path's.
        expect(((await selectOne(sc, 'Pipe.side(o@a2)', 'face', 'on')).hit as FaceHit).topo.type).toBe('torus');
        expect(((await selectOne(sc, 'Pipe.side(o@l1)', 'face', 'on')).hit as FaceHit).topo.type).toBe('cylinder');
        // A pattern's copy and the mirror's copy: their own bodies' faces.
        const copy = (await selectSet(sc, 'Row.copy(2)', 'face', 'targets')).hits as FaceHit[];
        expect(copy).toHaveLength(12);
        expect(new Set(copy.map((c) => c.body.name))).toEqual(new Set(['Body 2 (Instance 2)']));
        const mirror = (await selectSet(sc, 'Flip.mirror', 'face', 'targets')).hits as FaceHit[];
        expect(new Set(mirror.map((c) => c.body.name))).toEqual(new Set(['Body 2 (Mirror copy)']));
        // ~k past the faces of a label.
        const past = await reasonOf(selectOne(sc, 'Base.end~3', 'face', 'on'));
        expect(past).toMatchObject({ reason: 'selector_index', detail: { range: [1, 2] } });
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'every label written selects its own face, and every edge label its own edge',
    async () => {
      await scene(h, async (sc) => {
        let labelled = 0;
        for (let bi = 0; bi < sc.bodies.length; bi++) {
          for (let fi = 0; fi < (sc.bodies[bi].names?.faces.length ?? 0); fi++) {
            const label = sc.labels.of(bi, fi).label;
            if (!label) continue;
            labelled++;
            const hit = (await selectOne(sc, label, 'face', 'on')).hit as FaceHit;
            expect([hit.bi, hit.index], label).toEqual([bi, fi]);
          }
        }
        // Every face of these bodies has a label.
        expect(labelled).toBe(sc.bodies.reduce((n, b) => n + (b.names?.faces.length ?? 0), 0));
        let edges = 0;
        for (const e of ((await selectAny(sc, 'Body 2 edges')).hits as EdgeHit[]).concat((await selectAny(sc, 'Body 1 edges')).hits as EdgeHit[])) {
          const label = edgeLabel(sc, e, await sc.cache.topo(e.body.shape));
          if (!label) continue;
          edges++;
          const hit = (await selectOne(sc, label, 'edge', 'axis')).hit as EdgeHit;
          expect([hit.bi, hit.index], label).toEqual([e.bi, e.index]);
        }
        expect(edges).toBeGreaterThan(24);
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'no face left lists the roles that are, with candidates and their handles; a word that is no role, a sketch, say so',
    async () => {
      await scene(h, async (sc) => {
        const none = await reasonOf(selectSet(sc, 'Base.cut', 'face', 'targets'));
        expect(none.reason).toBe('nothing_selected');
        expect(none.message).toMatch(/^nothing_selected: Base has .* on the bodies; no cut is left/);
        expect(none.message).toMatch(/end x2/);
        expect(none.message).toMatch(/side x\d/);
        expect(none.detail.roles).toEqual(expect.arrayContaining(['end x2', 'start']));
        const cands = none.detail.candidates as Row[];
        expect(cands.length).toBeGreaterThan(0);
        expect(cands.length).toBeLessThanOrEqual(8);
        for (const c of cands) expect(c).toMatchObject({ handle: expect.stringMatching(/^#f\d+$/), words: expect.any(String), center_mm: expect.any(Array) });
        expect(await reasonOf(selectSet(sc, 'Base.side(zz)', 'face', 'targets'))).toMatchObject({ reason: 'nothing_selected' });
        const top = await reasonOf(selectSet(sc, 'Base.top', 'face', 'targets'));
        expect(top.reason).toBe('unknown_role');
        expect(top.message).toMatch(/Base has no role "top"/);
        const sk = await reasonOf(selectSet(sc, 'Base sketch.end', 'face', 'targets'));
        expect(sk).toMatchObject({ reason: 'unknown_role' });
        expect(sk.message).toMatch(/Base sketch is a sketch: it makes no faces/);
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'queries: levels along an axis, facing, parallel and perpendicular, types, holes, radii, largest, nearest, feature scope',
    async () => {
      await scene(h, async (sc) => {
        const faces = async (q: string) => (await selectAny(sc, q)).hits as FaceHit[];
        const z = (hs: FaceHit[]) => [...new Set(hs.map((x) => x.topo.centroid![2]))].sort((a, b) => a - b);
        // Two cubes: tops at z 10, sides at 5, bottoms at 0.
        expect((await faces('Body 2 faces >Z')).map((x) => x.topo.centroid![2])).toEqual([10, 10]);
        expect(await faces('Body 2 faces >Z[2]')).toHaveLength(8);
        expect(z(await faces('Body 2 faces >Z[3]'))).toEqual([0]);
        expect(await reasonOf(selectAny(sc, 'Body 2 faces >Z[4]'))).toMatchObject({ reason: 'selector_index', detail: { range: [1, 3] } });
        expect(z(await faces('Body 2 faces <Z'))).toEqual([0]);
        expect((await faces('Body 2 faces +Z')).map((x) => x.topo.normal)).toEqual([
          [0, 0, 1],
          [0, 0, 1],
        ]);
        expect(z(await faces('Body 2 faces -Z'))).toEqual([0]);
        expect(await faces('Body 2 faces |Z')).toHaveLength(4);
        expect(await faces('Body 2 faces #Z')).toHaveLength(8);
        expect((await faces('Body 2 faces >X')).map((x) => x.topo.centroid![0])).toEqual([130]);
        expect((await faces('Body 2 faces +X >X')).map((x) => x.topo.centroid![0])).toEqual([130]);
        // The block: the hole and the two pieces of the fillet are cylinders; only the hole is a hole.
        expect(await faces('Body 1 faces %cylinder')).toHaveLength(3);
        const hole = await faces('Body 1 faces hole');
        expect(hole).toHaveLength(1);
        expect(hole[0].topo.radius).toBe(4);
        expect(await faces('Body 1 faces %cylinder radius 2 mm')).toHaveLength(2);
        expect((await faces('Body 1 faces radius 4 mm')).map((x) => x.index)).toEqual([hole[0].index]);
        expect(await faces('Body 1 faces boss')).toHaveLength(0);
        // The pipe's straight part is round outward: a boss; its bend is a torus, neither.
        expect((await faces('Body 3 faces boss')).map((x) => x.topo.type)).toEqual(['cylinder']);
        expect(await faces('Body 3 faces hole')).toHaveLength(0);
        expect((await faces('Body 3 faces %torus')).map((x) => x.body.name)).toEqual(['Body 3']);
        // The largest face: the bottom, the block's and the boss's merged.
        const big = await faces('Body 1 faces largest');
        expect(big).toHaveLength(1);
        expect(has(big[0].name, `F:${P.base}:start`) && has(big[0].name, `F:${P.boss}:start`)).toBe(true);
        expect((await faces('Body 1 faces nearest (0, 15, 5)')).map((x) => x.topo.normal)).toEqual([[-1, 0, 0]]);
        expect((await faces('feature Slot faces')).map((x) => x.name!.split(':')[2]).sort()).toEqual(['end', 'side', 'side']);
        expect(await faces('Slot faces')).toHaveLength(3);
        // Edges and vertices.
        const vertical = (await selectAny(sc, 'Body 2 edges |Z')).hits as EdgeHit[];
        expect(vertical).toHaveLength(8);
        expect(vertical.every((e) => e.topo.type === 'line' && Math.abs(Math.abs(e.topo.dir![2]) - 1) < 1e-9)).toBe(true);
        const rims = (await selectAny(sc, 'Body 1 edges %circle radius 4 mm')).hits as EdgeHit[];
        expect(rims.map((e) => e.topo.center![2]).sort()).toEqual([0, 10]);
        expect(((await selectAny(sc, 'Body 1 edges %circle #Z radius 4 mm')).hits as EdgeHit[]).length).toBe(2);
        expect((await selectAny(sc, 'Body 2 vertices >X >Y >Z')).hits.map((v) => (v as { topo: { p: number[] } }).topo.p)).toEqual([[130, 10, 10]]);
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'a surface body warns that its normals may point either way',
    async () => {
      await scene(h, async (sc) => {
        const tops = (await selectAny(sc, 'Body 2 faces')).hits as FaceHit[];
        const surface = tops.map((t) => ({ ...t, body: { ...t.body, solids: 0 }, warnings: [] }));
        const kept = (await applyFilters(sc, surface, [{ f: '+', ax: { dir: [0, 0, 1], text: 'Z' }, col: 1, text: '+Z' }])) as FaceHit[];
        expect(kept).toHaveLength(2);
        expect(kept[0].warnings).toEqual(['normals may be unreliable on Body 2 (a surface body)']);
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'points: one face within the tolerance, the nearest named when none is, a face or an edge tie is ambiguous',
    async () => {
      await scene(h, async (sc) => {
        const at = async (q: string, want: 'face' | 'edge' | 'vertex' = 'face') => (await selectOne(sc, q, want, 'face')).hit as FaceHit;
        expect(sc.labels.of(...(((f) => [f.bi, f.index])(await at('Body 1 face at (4, 20, 10)')) as [number, number])).label).toBe('Base.end~1');
        // Within max(0.05 mm, 0.002 x the body's size) of it.
        expect((await at('Body 1 face at (4, 20, 10.1)')).body.names!.faces[(await at('Body 1 face at (4, 20, 10.1)')).index]).toBe(`F:${P.base}:end#0`);
        const off = await reasonOf(selectOne(sc, 'Body 1 face at (4, 20, 11)', 'face', 'face'));
        expect(off.reason).toBe('nothing_selected');
        expect(off.message).toBe('nothing_selected: No face of Body 1 at (4, 20, 11): nearest is Base.end~1, 1 mm away.');
        expect((off.detail.candidates as Row[])[0]).toMatchObject({ label: 'Base.end~1', handle: expect.stringMatching(/^#f/) });
        // On the edge between two faces: both are at 0 mm.
        const tie = await reasonOf(selectOne(sc, 'Body 2 face at (100, 5, 10)', 'face', 'face'));
        expect(tie.reason).toBe('selector_ambiguous');
        expect((tie.detail.candidates as Row[]).map((c) => c.label).sort()).toEqual(['Twin.end(1)', 'Twin.side(a4)']);
        // Close to one, not the other.
        expect((await at('Body 2 face at (101, 5, 10.05)')).topo.centroid).toEqual([105, 5, 10]);
        // A corner: three edges meet.
        const corner = await reasonOf(selectOne(sc, 'Body 2 edge at (100, 0, 0)', 'edge', 'axis'));
        expect(corner.reason).toBe('selector_ambiguous');
        expect(corner.detail.candidates as Row[]).toHaveLength(3);
        expect((await selectOne(sc, 'Body 2 edge at (105, 0, 0)', 'edge', 'axis')).hit).toMatchObject({ kind: 'edge', topo: { type: 'line', mid: [105, 0, 0] } });
        const corner3 = (await selectOne(sc, 'Body 2 vertex at (130, 10, 10)', 'vertex', 'to')).hit;
        expect(corner3).toMatchObject({ kind: 'vertex', topo: { p: [130, 10, 10] } });
        // What an extent "to" keeps: a vertex or a face, never an edge.
        expect(await targetRefOf(sc, corner3)).toMatchObject({ body: bodyNamed(h, 'Body 2').id, ref: { name: expect.stringMatching(/^V:/) } });
        expect(await targetRefOf(sc, (await selectOne(sc, 'Twin.end(2)', 'face', 'to')).hit)).toMatchObject({ ref: { name: `F:${P.twin}:end:1` } });
        expect(await reasonOf(targetRefOf(sc, (await selectOne(sc, 'Body 2 edge at (105, 0, 0)', 'edge', 'to')).hit))).toMatchObject({ reason: 'bad_selector' });
        expect(await reasonOf(selectOne(sc, 'Body 9 face at (0, 0, 0)', 'face', 'face'))).toMatchObject({ reason: 'bad_selector' });
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'edges of a face are live, with a filter a fixed set; A & B is the edge between them; faces that do not meet say so',
    async () => {
      await scene(h, async (sc) => {
        const live = await selectSet(sc, 'edges of Twin.end(1)', 'edge', 'targets');
        expect(live.hits).toHaveLength(4);
        expect(live.live?.map((f) => f.topo.centroid)).toEqual([[105, 5, 10]]);
        expect(echo(sc, live)).toBe('edges of Twin.end(1) -> 4 edges (lines), live set (every edge of the face as the part changes)');
        const fixed = await selectSet(sc, 'edges of Twin.end(1) |X', 'edge', 'targets');
        expect(fixed.live).toBeNull();
        expect((fixed.hits as EdgeHit[]).map((e) => e.topo.mid![1]).sort()).toEqual([0, 10]);
        expect(echo(sc, fixed)).toBe('edges of Twin.end(1) |X -> 2 edges (lines), fixed set');
        const pair = (await selectOne(sc, 'Twin.end(1) & Twin.side(a1)', 'edge', 'axis')).hit as EdgeHit;
        expect(pair.topo).toMatchObject({ type: 'line', mid: [105, 0, 10] });
        expect(await reasonOf(selectOne(sc, 'Twin.end(1) & Twin.start(1)', 'edge', 'axis'))).toMatchObject({ reason: 'nothing_selected' });
        expect(await reasonOf(selectOne(sc, 'Twin.end(1) & Pipe.start', 'edge', 'axis'))).toMatchObject({ reason: 'bad_selector' });
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'a single-entity field takes one: more is ambiguous with at most 8 candidates, each with a handle, label, words and centre',
    async () => {
      await scene(h, async (sc) => {
        const r = await reasonOf(selectOne(sc, 'Body 1 faces', 'face', 'on'));
        expect(r.reason).toBe('selector_ambiguous');
        expect(r.message).toMatch(/^selector_ambiguous: on: "Body 1 faces" names \d+ faces; this field takes one/);
        const cands = r.detail.candidates as Row[];
        expect(cands).toHaveLength(8);
        expect(Number(r.detail.count)).toBeGreaterThan(8);
        expect(new Set(cands.map((c) => c.handle)).size).toBe(8);
        for (const c of cands) expect(c).toMatchObject({ handle: expect.stringMatching(/^#f\d+$/), words: expect.any(String), center_mm: expect.any(Array) });
        expect(await reasonOf(selectOne(sc, 'Body 1 faces %sphere', 'face', 'on'))).toMatchObject({ reason: 'nothing_selected', detail: { field: 'on' } });
        expect(await reasonOf(selectOne(sc, 'Body 1 fcaes', 'face', 'on'))).toMatchObject({ reason: 'bad_selector', detail: { field: 'on', column: 8 } });
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    'regions: even-odd all, r<N>, at(u, v), every region in find, an open sketch; planes with offsets; axes',
    async () => {
      await scene(h, async (sc) => {
        const all = (await selectSet(sc, 'Base sketch all', 'region', 'regions')).hits as RegionHit[];
        expect(all.map((r) => [r.row.id, r.row.depth, r.row.holes])).toEqual([['r1', 0, 1]]);
        expect(((await selectSet(sc, 'Base sketch r2', 'region', 'regions')).hits as RegionHit[])[0].row).toMatchObject({ id: 'r2', depth: 1 });
        expect(((await selectSet(sc, 'Base sketch at(30, 15)', 'region', 'regions')).hits as RegionHit[])[0].row.id).toBe('r2');
        expect(((await selectSet(sc, 'Base sketch', 'region', 'profiles')).hits as RegionHit[]).map((r) => r.row.id)).toEqual(['r1']);
        expect(await reasonOf(selectSet(sc, 'Base sketch r9', 'region', 'regions'))).toMatchObject({ reason: 'region_not_found', detail: { regions: [{ id: 'r1' }, { id: 'r2' }] } });
        expect(await reasonOf(selectSet(sc, 'Base sketch at(200, 200)', 'region', 'regions'))).toMatchObject({ reason: 'region_not_found' });
        expect(await reasonOf(selectSet(sc, 'r1', 'region', 'regions'))).toMatchObject({ reason: 'bad_selector' });
        const open = await reasonOf(selectSet(sc, 'Path all', 'region', 'regions'));
        expect(open.reason).toBe('open_profile');
        expect(open.detail.open).toHaveLength(2);
        expect(regionRefOf(sc, all[0])).toMatchObject({ sketch: P.sketch, region: all[0].region.key });
        // Planes.
        const top = (await selectOne(sc, 'Top offset 12 mm', 'plane', 'on')).hit as PlaneHit;
        expect(top).toMatchObject({ frame: { origin: [0, 0, 12], normal: [0, 0, 1] }, offset: { expr: '12 mm', mm: 12 }, flip: false });
        expect(((await selectOne(sc, 'Top offset 12 mm flip', 'plane', 'on')).hit as PlaneHit).frame.origin).toEqual([0, 0, -12]);
        const onFace = (await selectOne(sc, 'Twin.end(1) offset 2 mm', 'plane', 'on')).hit as PlaneHit;
        expect(onFace.frame).toMatchObject({ origin: [0, 0, 12], normal: [0, 0, 1], xdir: [1, 0, 0] });
        expect(await planeRefOf(sc, onFace)).toMatchObject({ kind: 'face', body: onFace.source.s === 'face' ? onFace.source.face.body.id : '' });
        expect(await planeRefOf(sc, top)).toEqual({ kind: 'origin', plane: 'origin:top' });
        expect(await reasonOf(selectOne(sc, 'Base.side(h)', 'plane', 'on'))).toMatchObject({ reason: 'not_flat' });
        expect(await reasonOf(selectOne(sc, 'Top offset 1 zz', 'plane', 'on'))).toMatchObject({ reason: 'expr_error' });
        // Axes.
        const axis = async (q: string) => (await selectOne(sc, q, 'axis', 'axis')).hit as AxisHit;
        const holeAxis = await axis('axis of Base.side(h)');
        expect([holeAxis.origin[0], holeAxis.origin[1]]).toEqual([30, 15]);
        expect(Math.abs(holeAxis.dir[2])).toBe(1);
        expect(await axisRefOf(sc, holeAxis)).toMatchObject({ kind: 'face-axis' });
        expect(await axis('Z axis')).toMatchObject({ origin: [0, 0, 0], dir: [0, 0, 1] });
        expect(await axisRefOf(sc, await axis('Z axis'))).toEqual({ kind: 'origin', axis: 'origin:z' });
        const line = await axis('Path.l1');
        expect(line).toMatchObject({ origin: [0, 100, 0], dir: [1, 0, 0] });
        expect(await axisRefOf(sc, line)).toEqual({ kind: 'sketch-line', sketch: P.path, entity: 'l1' });
        expect(await reasonOf(selectOne(sc, 'Path.a2', 'axis', 'axis'))).toMatchObject({ reason: 'bad_selector' });
        const edge = await axis('Twin.end(1) & Twin.side(a1)');
        expect(Math.abs(edge.dir[0])).toBe(1);
        expect(await axisRefOf(sc, edge)).toMatchObject({ kind: 'edge', ref: { name: expect.stringMatching(/^E:/) } });
        expect(await axis('normal of Top')).toMatchObject({ dir: [0, 0, 1] });
        expect(await axisRefOf(sc, await axis('normal of Top'))).toEqual({ kind: 'normal', plane: { kind: 'origin', plane: 'origin:top' } });
      });
    },
    REAL_KERNEL_MS,
  );

  it(
    "find lists rows with handles, labels, words, sizes, a point on the face, hole or boss, the frame; handles follow kinds; the matches flash",
    async () => {
      const flashes: unknown[][] = [];
      h.services.viewport.set({ handle: { flash: (items: unknown[]) => flashes.push(items) } as never });
      try {
        const r = await h.ok('find', { query: 'Twin.end(1)', limit: 10 }, { turn: 'find-1' });
        expect(r.text).toBe('find "Twin.end(1)": 1 face (Twin.end(1))');
        expect(r.data).toMatchObject({ query: 'Twin.end(1)', kind: 'face', count: 1, more: 0 });
        const [row] = r.data.rows as Row[];
        expect(row).toEqual({
          handle: '#f1',
          kind: 'face',
          words: 'End face of Twin',
          label: 'Twin.end(1)',
          body: 'Body 2',
          feature: 'Twin',
          role: 'end',
          type: 'plane',
          area_mm2: 100,
          center_mm: [105, 5, 10],
          normal: [0, 0, 1],
          point_mm: expect.any(Array),
          frame: { origin_mm: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], words: 'u runs +X, v runs +Y, origin (0, 0, 10)' },
        });
        const p = row.point_mm as number[];
        expect(p[2]).toBe(10);
        expect(p[0]).toBeGreaterThan(100);
        expect(p[0]).toBeLessThan(110);
        // The matches flash in the person's view.
        expect(flashes.at(-1)).toEqual([{ kind: 'face', body: bodyNamed(h, 'Body 2').id, index: faceNamed(bodyNamed(h, 'Body 2'), `F:${P.twin}:end:0`) }]);
        // The same face again: the same handle; the handle itself finds it.
        expect(((await h.ok('find', { query: '#f1', limit: 10 }, { turn: 'find-1' })).data.rows as Row[])[0]).toMatchObject({ handle: '#f1', label: 'Twin.end(1)' });
        const hole = ((await h.ok('find', { query: 'Body 1 faces hole', limit: 10 }, { turn: 'find-1' })).data.rows as Row[])[0];
        expect(hole).toMatchObject({ handle: '#f2', label: 'Base.side(h)', type: 'cylinder', radius_mm: 4, hole: true, axis: { point_mm: expect.any(Array), dir: expect.any(Array) } });
        const pp = hole.point_mm as number[];
        expect(Math.hypot(pp[0] - 30, pp[1] - 15)).toBeCloseTo(4, 3);
        const fil = ((await h.ok('find', { query: 'Fillet 1.fillet', limit: 10 }, { turn: 'find-1' })).data.rows as Row[])[0];
        expect(fil).toMatchObject({ type: 'cylinder', radius_mm: 2, label: 'Fillet 1.fillet(1)~1', warning: expect.stringContaining('split face') });
        expect(fil).not.toHaveProperty('hole');
        const edges = await h.ok('find', { query: 'edges of Twin.end(1)', limit: 2 }, { turn: 'find-1' });
        expect(edges.data).toMatchObject({ kind: 'edge', count: 4, more: 2, live: expect.stringContaining('keeps every edge') });
        const [e1] = edges.data.rows as Row[];
        expect(e1).toMatchObject({ handle: '#e1', kind: 'edge', type: 'line', length_mm: 10, faces: expect.arrayContaining(['Twin.end(1)']), label: expect.stringMatching(/^(Twin\.end\(1\) & Twin\.side\(a\d\)|Twin\.side\(a\d\) & Twin\.end\(1\))$/) });
        const body = ((await h.ok('find', { query: 'bodies', limit: 10 }, { turn: 'find-1' })).data.rows as Row[]).map((x) => [x.handle, x.body]);
        expect(body.slice(0, 3)).toEqual([
          ['#b1', 'Body 1'],
          ['#b2', 'Body 2'],
          ['#b3', 'Body 3'],
        ]);
        const reg = (await h.ok('find', { query: 'Base sketch regions', limit: 10 }, { turn: 'find-1' })).data.rows as Row[];
        expect(reg.map((x) => [x.handle, x.depth, x.holes])).toEqual([
          ['Base sketch r1', 0, 1],
          ['Base sketch r2', 1, 0],
        ]);
        expect(reg[1]).toMatchObject({ kind: 'region', area_mm2: 50.2655, bounded_by: ['h'] });
        // A point inside it, in the sketch and in the model.
        const at = reg[1].at as number[];
        expect(Math.hypot(at[0] - 30, at[1] - 15)).toBeLessThan(4);
        expect(reg[1].at_mm).toEqual([at[0], at[1], 0]);
        const plane = ((await h.ok('find', { query: 'Front offset 5 mm', limit: 10 }, { turn: 'find-1' })).data.rows as Row[])[0];
        expect(plane).toMatchObject({ handle: 'Front offset 5 mm', kind: 'plane', frame: { origin_mm: [0, -5, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] } });
        expect(((await h.ok('find', { query: 'Path.l1', limit: 10 }, { turn: 'find-1' })).data.rows as Row[])[0]).toMatchObject({ kind: 'axis', axis: { point_mm: [0, 100, 0], dir: [1, 0, 0] } });
        // Nothing matched: what exists there.
        const none = await h.call('find', { query: 'Body 2 faces %cylinder', limit: 5 }, { turn: 'find-1' });
        expect(none).toMatchObject({ ok: false, error: { code: 'invalid_input', detail: { reason: 'nothing_selected', exists: { plane: 12 } } } });
        const bad = await h.call('find', { query: 'Body 2 faces >Q', limit: 5 }, { turn: 'find-1' });
        expect(bad).toMatchObject({ ok: false, error: { detail: { reason: 'bad_selector', column: 15 } } });
      } finally {
        h.services.viewport.set({ handle: null });
      }
    },
    REAL_KERNEL_MS,
  );

  it(
    "the person's selection, on the shown bodies and on the bodies before a feature; get_model names a selected face by its label",
    async () => {
      const b2 = bodyNamed(h, 'Body 2');
      const end1 = faceNamed(b2, `F:${P.twin}:end:0`);
      h.services.selection.set({ items: [{ kind: 'face', body: b2.id, index: end1 }], filter: [] });
      try {
        const r = await h.ok('find', { query: 'selection', limit: 5 }, { turn: 'sel-1' });
        expect((r.data.rows as Row[]).map((x) => x.label)).toEqual(['Twin.end(1)']);
        const model = await h.ok('get_model', { detail: 'brief', feature: '' }, { turn: 'sel-1' });
        expect(model.data.selection).toEqual(['face Twin.end(1) on Body 2']);
        // Before the pattern, the same face on Body 2 as it was then.
        const row = h.doc.state.get().doc.features.find((f) => f.name === 'Row')!;
        await scene(
          h,
          async (sc) => {
            const hit = (await selectOne(sc, 'selection', 'face', 'on')).hit as FaceHit;
            expect(hit.body.names!.faces[hit.index]).toBe(`F:${P.twin}:end:0`);
          },
          { before: row.id },
        );
        h.services.selection.set({ items: [], filter: [] });
        expect(await h.call('find', { query: 'selection', limit: 5 }, { turn: 'sel-1' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('the person has nothing selected') } });
      } finally {
        h.services.selection.set({ items: [], filter: [] });
      }
    },
    REAL_KERNEL_MS,
  );

  it(
    'an edit resolves on the bodies before its feature; a feature never keeps a face it made, nor one made after it',
    async () => {
      await scene(
        h,
        async (sc) => {
          expect(sc.bodies.map((b) => b.name)).toEqual(['Body 1']);
          // The edge the fillet rounds is there before it.
          const e = (await selectOne(sc, 'Base.end & Base.side(e1)', 'edge', 'targets')).hit as EdgeHit;
          expect(e.topo).toMatchObject({ type: 'line', mid: [20, 0, 10] });
          expect((await edgeRefOf(sc, e)).ref.name).toMatch(/^E:F:/);
          expect((await selectSet(sc, 'Base.end', 'face', 'targets')).hits).toHaveLength(1);
          expect(await reasonOf(selectSet(sc, 'Fillet 1.fillet', 'face', 'targets'))).toMatchObject({ reason: 'nothing_selected', message: expect.stringContaining('before Fillet 1') });
          expect(await reasonOf(selectSet(sc, 'Slot.end', 'face', 'targets'))).toMatchObject({ reason: 'nothing_selected' });
        },
        { before: P.fillet },
      );
      // At the end, that edge is the fillet's now.
      await scene(h, async (sc) => {
        expect(await reasonOf(selectOne(sc, 'Base.end~1 & Base.side(e1)', 'edge', 'targets'))).toMatchObject({ reason: 'nothing_selected' });
      });
      // Its own face, a later feature's face.
      await scene(
        h,
        async (sc) => {
          const own = (await selectOne(sc, 'Twin.end(1)', 'face', 'on')).hit as FaceHit;
          expect(await reasonOf(faceRefOf(sc, own))).toMatchObject({ reason: 'self_reference' });
        },
        { self: P.twin },
      );
      await scene(
        h,
        async (sc) => {
          const later = (await selectOne(sc, 'Slot.end', 'face', 'on')).hit as FaceHit;
          const r = await reasonOf(faceRefOf(sc, later));
          expect(r).toMatchObject({ reason: 'later_feature' });
          expect(r.message).toMatch(/Slot comes after Fillet 1 in the history/);
          expect((await faceRefOf(sc, (await selectOne(sc, 'Base.side(h)', 'face', 'on')).hit as FaceHit)).ref.name).toBe(`F:${P.base}:side:h[]`);
        },
        { self: P.fillet },
      );
    },
    REAL_KERNEL_MS,
  );
});

describe('handles across changes', () => {
  it(
    'a handle follows its face by name, says when it moved, answers selector_stale once it is gone, and belongs to its key',
    async () => {
      const h = await assistantHarness();
      try {
        const sk = await sketchOn(h, 'Base sketch', 'origin:top', new Shapes().rect('e', 0, 0, 40, 30));
        const base = await extrude(h, 'Base', regions(h, sk));
        const find = async (query: string, turn = 'h-1') => ((await h.ok('find', { query, limit: 5 }, { turn })).data.rows as Row[])[0];
        expect(await find('Base.end')).toMatchObject({ handle: '#f1' });
        expect(await find('Base.side(e1)')).toMatchObject({ handle: '#f2' });
        let b = bodyNamed(h, 'Body 1');
        const fillet = await filletEdge(h, 'Fillet 1', b, faceNamed(b, `F:${base}:end`), b.names!.faces.findIndex((n) => n.startsWith(`F:${base}:side:e1[`)));
        // A rebuild in between: found again by name, no warning.
        const again = await find('#f1');
        expect(again).toMatchObject({ handle: '#f1', label: 'Base.end' });
        expect(again).not.toHaveProperty('warning');
        expect(await find('Fillet 1.fillet(1)')).toMatchObject({ handle: '#f3' });
        // A slot splits the top and the fillet: the handles say they moved.
        b = bodyNamed(h, 'Body 1');
        const slotSketch = await sketchOnFace(h, 'Slot sketch', b, faceNamed(b, `F:${base}:end`), new Shapes().rect('s', 8, -1, 12, 31));
        await extrude(h, 'Slot', regions(h, slotSketch), { op: 'cut', flip: true, distance: '2 mm' });
        expect(await find('#f1')).toMatchObject({ handle: '#f1', warning: expect.stringContaining('#f1 moved: check') });
        // The fillet goes: its handle is stale.
        h.doc.remove(fillet);
        await h.settle();
        const stale = await h.call('find', { query: '#f3', limit: 5 }, { turn: 'h-1' });
        expect(stale).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'selector_stale: #f3 is gone after Slot; call find again.', detail: { reason: 'selector_stale', handle: '#f3' } } });
        // Another request: the handles of this one are not its.
        expect(await h.call('find', { query: '#f1', limit: 5 }, { turn: 'h-2' })).toMatchObject({ ok: false, error: { detail: { reason: 'selector_stale' }, message: expect.stringContaining('is not a handle of this request') } });
        // A handle never given.
        expect(await h.call('find', { query: '#e9', limit: 5 }, { turn: 'h-2' })).toMatchObject({ ok: false, error: { detail: { reason: 'selector_stale' } } });
        // A body the person undid: the handle says which body went.
        const lone = await sketchOn(h, 'Lone sketch', 'origin:top', new Shapes().rect('q', 100, 0, 110, 10));
        await extrude(h, 'Lone', regions(h, lone));
        expect(await find('Lone.end', 'h-3')).toMatchObject({ handle: '#f1', body: 'Body 2' });
        h.doc.undo();
        await h.settle();
        expect(await h.call('find', { query: '#f1', limit: 5 }, { turn: 'h-3' })).toMatchObject({ ok: false, error: { message: 'selector_stale: #f1 is gone: Body 2 is not there now; call find again.' } });
      } finally {
        h.dispose();
      }
    },
    REAL_KERNEL_MS,
  );
});

/** The real kernel, restarted (every shape id dies, the Part rebuilds) after `restarts` of its measure calls. */
function restartingKernel(): { kernel: KernelAdapter; restartAfterMeasure(n: number): void; restarts(): number } {
  const real = realKernelAnywhere();
  let pending = 0;
  let done = 0;
  const call: KernelAdapter['call'] = async (op, params, opts) => {
    const r = await real.call(op, params, opts);
    if (op === 'measure' && pending > 0) {
      pending--;
      done++;
      void real.restart('test restart');
    }
    return r;
  };
  const kernel = new Proxy(real, {
    get(t, prop) {
      if (prop === 'call') return call;
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { kernel, restartAfterMeasure: (n) => (pending = n), restarts: () => done };
}

describe('a kernel restart while a selector is read', () => {
  it(
    'reads it once more on the rebuilt Part; a second restart answers busy/changed; the topo cache starts again',
    async () => {
      const rk = restartingKernel();
      const h = await assistantHarness({ kernel: rk.kernel });
      try {
        const sk = await sketchOn(h, 'Base sketch', 'origin:top', new Shapes().rect('e', 0, 0, 40, 30));
        await extrude(h, 'Base', regions(h, sk));
        const cache = topoCacheOf(h.services);
        await h.ok('find', { query: 'Body 1 face at (4, 20, 10)', limit: 5 });
        const calls = cache.calls;
        // The same body again: no new topo call.
        await h.ok('find', { query: 'Body 1 faces >Z', limit: 5 });
        expect(cache.calls).toBe(calls);
        const respawns = h.services.kernel.status.get().respawns;
        rk.restartAfterMeasure(1);
        const r = await h.ok('find', { query: 'Body 1 face at (4, 20, 10)', limit: 5 });
        expect(rk.restarts()).toBe(1);
        expect((r.data.rows as Row[])[0]).toMatchObject({ label: 'Base.end' });
        expect(h.services.kernel.status.get().respawns).toBe(respawns + 1);
        // The cache was dropped with the old shapes, and read again.
        expect(cache.calls).toBeGreaterThan(calls);
        rk.restartAfterMeasure(2);
        const twice = await h.call('find', { query: 'Body 1 face at (4, 20, 10)', limit: 5 });
        expect(rk.restarts()).toBe(3);
        expect(twice).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'changed' } } });
        // Settled again, it reads.
        await h.settle();
        expect((await h.ok('find', { query: 'Base.end', limit: 5 })).data.count).toBe(1);
      } finally {
        h.dispose();
      }
    },
    REAL_KERNEL_MS * 2,
  );
});
