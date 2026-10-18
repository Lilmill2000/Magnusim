// measure on the REAL kernel (CAD tools spec §3.2.3, §9.3, §12.1 measure.test.ts), through the
// page's tool handler as the bridge calls it:
//   - one body: volume, area, centre of mass, bounding box, solids, shells, voids, faces, edges,
//     valid; a sealed pocket is voids 1 (get_model says it too); two separate cubes in one body are
//     shells 2, voids 0;
//   - two bodies: the overlap of two cubes is 1000 mm³ (joined, one solid); separate cubes overlap
//     0, do not touch, join into 2 solids; cubes that share a face touch, overlap 0, join into 1;
//     a box with an open pocket and its lid join with one void; the kernel's shapes made for it
//     are released;
//   - a section: a ring cut at mid-height is π(R² - r²) to 1e-6 (the reply to 6 figures), with its
//     loops, holes and piece; a cut along its axis is two pieces; a construction plane and a flat
//     face (with an offset) cut the same; a plane that misses says so;
//   - a face, an edge, a vertex (through the person's selection), a point, a plane and an axis;
//   - refusals: a section with two targets, of a face, through a body or an axis; a name that is no
//     body (with the bodies); nothing or two things selected; the same body twice; a bad offset; a
//     curved face as the section plane;
//   - a change of the Part while it measures (forced in the kernel's queue) measures again once;
//     a second change answers busy/changed; a kernel restart mid-measure measures again, and the
//     ids of shapes the dead worker made are never released in the next one; a change while the
//     call is held at after-settled is measured;
//   - the rollback bar above the end: the bodies there, said so;
//   - by selector (find's selectors): a role label, a query, a handle find gave (the same point on
//     the face as find's), a face's plane with an offset as the section; several things are
//     selector_ambiguous with handles; a split face's warning; a text that is no body and no
//     selector names its column; a region, a handle never given.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELP } from '../../src/assistant/help';
import { sectionFacts } from '../../src/assistant/measure';
import { parsePoint, splitOffset } from '../../src/assistant/measure-targets';
import { sig6 } from '../../src/assistant/numbers';
import { runtimeOf } from '../../src/assistant/runtime';
import { selectItem } from '../../src/lib/selection';
import type { BodyId, Feature, RegionRef, SketchFeature } from '../../src/types/doc';
import type { KernelAdapter } from '../../src/types/kernel';
import type { SketchOutput } from '../../src/types/sketch';
import { block } from '../doc/blocks';
import { realKernelAnywhere } from '../features/p2/kernel-anywhere';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { bodyNamed, extrude, faceNamed, plate, regions, Shapes, sketchOnFace } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

type Row = Record<string, unknown>;
const M = (targets: string[], section = '') => ({ targets, section });

/** Shapes the kernel holds now. */
async function shapes(x: AssistantHarness): Promise<number> {
  return (await x.services.kernel.call('mem', {})).result.shapes;
}

/** A sketch of concentric circles R and r about the origin on Top, its ring extruded `t` (a new body). */
async function ring(x: AssistantHarness, R: number, r: number, t: number): Promise<{ extrude: string; body: BodyId }> {
  const sketch = await x.add('sketch', {
    points: { pt_c: [0, 0] },
    entities: [
      { id: 'e_1', kind: 'circle', c: 'pt_c', r: R },
      { id: 'e_2', kind: 'circle', c: 'pt_c', r },
    ],
  } as Partial<SketchFeature> as Record<string, unknown>);
  const out = x.doc.state.get().rebuild.outputs[sketch] as SketchOutput;
  const annulus = out.regions.find((g) => g.loops.length === 2)!;
  const profile: RegionRef = { sketch, region: annulus.key, entities: [...annulus.entities].sort(), sample: annulus.sample };
  const extrude = await x.add('extrude', { profiles: [profile], extent: { kind: 'blind', distance: `${t} mm` }, op: 'new' });
  const f = x.doc.state.get().doc.features.find((g) => g.id === extrude) as Feature & { creates: BodyId };
  return { extrude, body: f.creates };
}

/**
 * A kernel whose calls a test can step in before (to change the Part in the middle of a measure).
 * `stale` lists every id a release sent to a worker that did not make it ("<respawns>:<id>"): a
 * worker numbers its shapes from the start, so such an id may be another body's.
 */
function hookedKernel(): { kernel: KernelAdapter; before: Map<string, () => void>; real: KernelAdapter; stale: string[] } {
  const real = realKernelAnywhere();
  const before = new Map<string, () => void>();
  const made = new Set<string>();
  const stale: string[] = [];
  const kernel: KernelAdapter = {
    get status() {
      return real.status;
    },
    start: () => real.start(),
    call: (op, params, opts) => {
      before.get(op)?.();
      const epoch = real.status.get().respawns;
      if (op === 'release') for (const id of (params as { ids?: number[] }).ids ?? []) if (!made.has(`${epoch}:${id}`)) stale.push(`${epoch}:${id}`);
      return real.call(op, params, opts).then((r) => {
        const out = r.result as { id?: unknown; ids?: unknown };
        for (const id of [out.id, ...(Array.isArray(out.ids) ? out.ids : [])]) if (typeof id === 'number') made.add(`${epoch}:${id}`);
        return r;
      });
    },
    onRespawn: (fn) => real.onRespawn(fn),
    restart: (why) => real.restart(why),
    recycleIfLarge: () => real.recycleIfLarge(),
    dispose: () => real.dispose(),
  };
  return { kernel, before, real, stale };
}

describe('measure: one body', () => {
  it(
    'gives volume, area, centre of mass, bounding box, solids, shells, voids, faces, edges and valid; a sealed pocket is voids 1',
    async () => {
      h = await assistantHarness();
      block(h.doc);
      await h.settle();
      const r = await h.ok('measure', M(['Body 1']));
      expect(r.data).toMatchObject({
        target: 'Body 1',
        kind: 'body',
        body: 'Body 1',
        volume_mm3: 8000,
        area_mm2: 2400,
        centroid_mm: [10, 10, 10],
        bbox_mm: [
          [0, 0, 0],
          [20, 20, 20],
        ],
        solids: 1,
        shells: 1,
        voids: 0,
        faces: 6,
        edges: 12,
        valid: true,
      });
      expect(typeof r.data.rev).toBe('number');
      expect(r.text).toBe('Body 1: volume 8000 mm3, 1 solid, 0 voids');
      expect(r.summary).toBe('Measured Body 1: volume 8000 mm3, 1 solid, 0 voids');
      // Any case, quotes allowed.
      expect((await h.ok('measure', M(['"body 1"']))).data.volume_mm3).toBe(8000);

      // A 10 mm cube cut from the middle: closed inside, a second shell of the one solid.
      block(h.doc, { op: 'cut', at: [5, 5, 5], size: [10, 10, 10] });
      await h.settle();
      const p = await h.ok('measure', M(['Body 1']));
      expect(p.data).toMatchObject({ volume_mm3: 7000, area_mm2: 3000, solids: 1, shells: 2, voids: 1, faces: 12, valid: true });
      expect(p.text).toBe('Body 1: volume 7000 mm3, 1 solid, 1 void');
      // get_model reads the same.
      const model = await h.ok('get_model', { detail: 'brief', feature: '' });
      expect((model.data.bodies as Row[])[0]).toMatchObject({ solids: 1, shells: 2, voids: 1, volume_mm3: 7000 });
    },
    REAL_KERNEL_MS,
  );

  it(
    'two separate cubes in one body are 2 solids, 2 shells and no void',
    async () => {
      h = await assistantHarness();
      const sketch = await h.add('sketch', {
        points: { a1: [0, 0], a2: [10, 0], a3: [10, 10], a4: [0, 10], b1: [30, 0], b2: [40, 0], b3: [40, 10], b4: [30, 10] },
        entities: [
          { id: 'e_1', kind: 'line', p: ['a1', 'a2'] },
          { id: 'e_2', kind: 'line', p: ['a2', 'a3'] },
          { id: 'e_3', kind: 'line', p: ['a3', 'a4'] },
          { id: 'e_4', kind: 'line', p: ['a4', 'a1'] },
          { id: 'e_5', kind: 'line', p: ['b1', 'b2'] },
          { id: 'e_6', kind: 'line', p: ['b2', 'b3'] },
          { id: 'e_7', kind: 'line', p: ['b3', 'b4'] },
          { id: 'e_8', kind: 'line', p: ['b4', 'b1'] },
        ],
      });
      const out = h.doc.state.get().rebuild.outputs[sketch] as SketchOutput;
      expect(out.regions).toHaveLength(2);
      const profiles: RegionRef[] = out.regions.map((g) => ({ sketch, region: g.key, entities: [...g.entities].sort(), sample: g.sample }));
      await h.add('extrude', { profiles, extent: { kind: 'blind', distance: '10 mm' }, op: 'new' });
      const r = await h.ok('measure', M(['Body 1']));
      expect(r.data).toMatchObject({ volume_mm3: 2000, solids: 2, shells: 2, voids: 0 });
      expect(r.text).toBe('Body 1: volume 2000 mm3, 2 solids, 0 voids');
    },
    REAL_KERNEL_MS,
  );
});

describe('measure: two bodies', () => {
  it(
    'two cubes overlapping by a 10 mm cube share 1000 mm3; separate ones share nothing and join into 2 solids; a shared face touches; nothing is left in the kernel',
    async () => {
      h = await assistantHarness();
      block(h.doc); // Body 1: 0..20
      block(h.doc, { at: [10, 10, 10] }); // Body 2: 10..30, a 10 mm cube in common
      block(h.doc, { at: [50, 0, 0] }); // Body 3: 30 mm from Body 1 along X
      block(h.doc, { at: [0, 0, 20] }); // Body 4: on top of Body 1, sharing its face z = 20
      await h.settle();
      expect(h.doc.state.get().rebuild.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2', 'Body 3', 'Body 4']);
      const held = await shapes(h);

      const over = await h.ok('measure', M(['Body 1', 'Body 2']));
      expect(over.data).toMatchObject({
        targets: [
          { target: 'Body 1', kind: 'body', words: 'Body 1' },
          { target: 'Body 2', kind: 'body', words: 'Body 2' },
        ],
        distance_mm: 0,
        overlap_mm3: 1000,
        touching: true,
        union_solids: 1,
        union_voids: 0,
      });
      expect(over.text).toBe('Body 1 to Body 2: distance 0 mm, overlap 1000 mm3, joined 1 solid and 0 voids');

      const apart = await h.ok('measure', M(['Body 1', 'Body 3']));
      expect(apart.data).toMatchObject({ distance_mm: 30, delta_mm: [30, 0, 0], overlap_mm3: 0, touching: false, union_solids: 2, union_voids: 0 });
      expect((apart.data.p1_mm as number[])[0]).toBe(20);
      expect((apart.data.p2_mm as number[])[0]).toBe(50);

      const flush = await h.ok('measure', M(['Body 1', 'Body 4']));
      expect(flush.data).toMatchObject({ distance_mm: 0, overlap_mm3: 0, touching: true, union_solids: 1, union_voids: 0 });

      // The common and union shapes were released.
      expect(await shapes(h)).toBe(held);
    },
    REAL_KERNEL_MS,
  );

  it(
    'two pieces that enclose a void together: the union has it',
    async () => {
      h = await assistantHarness();
      // A box with a pocket open at its top, and a lid on it: apart, no void; joined, one.
      block(h.doc, { size: [20, 20, 10] }); // Body 1
      block(h.doc, { op: 'cut', at: [5, 5, 5], size: [10, 10, 5] }); // a pocket open at z = 10
      block(h.doc, { at: [0, 0, 10], size: [20, 20, 2] }); // Body 2: the lid
      await h.settle();
      const box = await h.ok('measure', M(['Body 1']));
      expect(box.data).toMatchObject({ solids: 1, shells: 1, voids: 0, volume_mm3: 3500 });
      const both = await h.ok('measure', M(['Body 1', 'Body 2']));
      expect(both.data).toMatchObject({ overlap_mm3: 0, touching: true, union_solids: 1, union_voids: 1 });
    },
    REAL_KERNEL_MS,
  );
});

describe('measure: a section', () => {
  it(
    'a ring cut at mid-height is pi (R^2 - r^2) to 1e-6, with its loops, holes and one piece; along its axis two pieces; a construction plane and a flat face cut the same; a miss says so',
    async () => {
      h = await assistantHarness();
      const { body } = await ring(h, 10, 4, 10);
      const exact = Math.PI * (10 * 10 - 4 * 4);
      const b = h.doc.state.get().rebuild.bodies.find((x) => x.id === body)!;
      // The raw number, then the reply's (6 figures).
      const raw = await sectionFacts(h.services, b, { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] });
      expect(Math.abs(raw.area - exact) / exact).toBeLessThan(1e-6);
      expect(raw).toMatchObject({ loops: 2, holes: 1, open: 0 });
      const held = await shapes(h);
      const r = await h.ok('measure', M(['Body 1'], 'Top offset 5 mm'));
      expect(r.data).toMatchObject({
        target: 'Body 1',
        kind: 'body',
        body: 'Body 1',
        section: { plane: 'Top offset 5 mm', origin_mm: [0, 0, 5], normal: [0, 0, 1], area_mm2: sig6(exact), loops: 2, holes: 1, regions: [{ area_mm2: sig6(exact), holes: 1 }] },
      });
      expect(r.text).toBe(`Body 1 cut at Top offset 5 mm: area ${sig6(exact)} mm2 in 1 piece, 1 hole`);
      expect(await shapes(h)).toBe(held);

      // Along the axis (the Front plane, y = 0): two 6 x 10 rectangles.
      const front = await h.ok('measure', M(['Body 1'], 'Front'));
      expect(front.data.section).toMatchObject({ plane: 'Front plane', area_mm2: 120, loops: 2, holes: 0, regions: [{ area_mm2: 60, holes: 0 }, { area_mm2: 60, holes: 0 }] });

      // A construction plane 5 mm above Top, by its name.
      await h.add('ref_plane', { plane: { kind: 'origin', plane: 'origin:top' }, distance: '5 mm', name: 'Mid' });
      expect((await h.ok('measure', M(['Body 1'], 'Mid'))).data.section).toMatchObject({ plane: 'plane Mid', area_mm2: sig6(exact) });
      // The top face, selected, 5 mm into the ring (its normal points out of it, up).
      const top = b.names!.faces.findIndex((n) => n.endsWith(':end'));
      expect(top).toBeGreaterThanOrEqual(0);
      selectItem(h.services.selection, { kind: 'face', body, index: top }, false);
      const face = await h.ok('measure', M(['Body 1'], 'selection offset -5 mm'));
      expect(face.data.section).toMatchObject({ origin_mm: [0, 0, 5], normal: [0, 0, 1], area_mm2: sig6(exact), loops: 2, holes: 1 });
      expect(String((face.data.section as Row).plane)).toMatch(/^face .* on Body 1 offset -5 mm$/);

      // A plane past the ring.
      const miss = await h.ok('measure', M(['Body 1'], 'Top offset 20 mm'));
      expect(miss.data.section).toMatchObject({ area_mm2: 0, loops: 0, holes: 0, regions: [], note: 'The plane misses Body 1.' });
      expect(miss.text).toBe('Body 1 cut at Top offset 20 mm: the plane misses it');
    },
    REAL_KERNEL_MS,
  );
});

describe('measure: faces, edges, points', () => {
  it(
    "a selected face, edge and vertex; a point, a plane and an axis; two of them give their distance and angle",
    async () => {
      h = await assistantHarness();
      const { body } = await ring(h, 10, 4, 10);
      const b = h.doc.state.get().rebuild.bodies.find((x) => x.id === body)!;
      const topo = (await h.services.kernel.call('topo', { id: b.shape, face_bbox: 'none' })).result;
      const outer = topo.faces.find((f) => f.type === 'cylinder' && Math.abs((f.radius ?? 0) - 10) < 1e-6)!;
      selectItem(h.services.selection, { kind: 'face', body, index: outer.i }, false);
      const face = await h.ok('measure', M(['selection']));
      expect(face.data).toMatchObject({ target: 'selection', kind: 'face', body: 'Body 1', type: 'cylinder', area_mm2: sig6(2 * Math.PI * 10 * 10), radius_mm: 10 });
      expect(String(face.data.words)).toMatch(/^face .* on Body 1$/);
      const axis = face.data.axis as { point_mm: number[]; dir: number[] };
      expect(Math.abs(axis.dir[2])).toBe(1);
      expect(axis.point_mm.slice(0, 2)).toEqual([0, 0]);
      // A point on the face: 10 mm from the axis (a chord of the tessellation is a little inside).
      const p = face.data.point_mm as number[];
      expect(Math.abs(Math.hypot(p[0], p[1]) - 10)).toBeLessThan(0.5);
      expect(face.text).toMatch(/: cylinder, area 628\.319 mm2, radius 10 mm$/);

      const circle = topo.edges.find((e) => e.type === 'circle' && Math.abs((e.radius ?? 0) - 10) < 1e-6)!;
      selectItem(h.services.selection, { kind: 'edge', body, index: circle.i }, false);
      const edge = await h.ok('measure', M(['selection']));
      expect(edge.data).toMatchObject({ kind: 'edge', type: 'circle', length_mm: 62.8319, radius_mm: 10, circumference_mm: 62.8319 });
      expect((edge.data.center_mm as number[]).slice(0, 2)).toEqual([0, 0]);

      const vtx = topo.vertices[0];
      selectItem(h.services.selection, { kind: 'vertex', body, index: vtx.i }, false);
      const vertex = await h.ok('measure', M(['selection']));
      expect(vertex.data).toMatchObject({ kind: 'vertex', point_mm: vtx.p.map((v) => Math.round(v * 1e4) / 1e4) });

      expect((await h.ok('measure', M(['(1, 2, 3)']))).data).toMatchObject({ kind: 'point', point_mm: [1, 2, 3], words: 'the point (1, 2, 3)' });
      expect((await h.ok('measure', M(['Top offset 4 mm']))).data).toMatchObject({ kind: 'plane', point_mm: [0, 0, 4], normal: [0, 0, 1] });
      expect((await h.ok('measure', M(['z axis']))).data).toMatchObject({ kind: 'axis', words: 'Z axis', axis: { point_mm: [0, 0, 0], dir: [0, 0, 1] } });

      // A point 3 mm above the ring's top face (z = 10).
      const up = await h.ok('measure', M(['(7, 0, 13)', 'Body 1']));
      expect(up.data).toMatchObject({ distance_mm: 3, p1_mm: [7, 0, 13], p2_mm: [7, 0, 10], delta_mm: [0, 0, -3] });
      expect(up.data.overlap_mm3).toBeUndefined();
      // The outer face against the Z axis: parallel.
      selectItem(h.services.selection, { kind: 'face', body, index: outer.i }, false);
      const par = await h.ok('measure', M(['selection', 'Z axis']));
      expect(par.data).toMatchObject({ angle_deg: 0, parallel: true });
    },
    REAL_KERNEL_MS,
  );
});

describe('measure: refusals', () => {
  it(
    'a section with two targets, of a face, through a body, an axis or a curved face; an unknown name; nothing or two things selected; one body twice; a bad offset',
    async () => {
      h = await assistantHarness();
      const { body } = await ring(h, 10, 4, 10);
      block(h.doc, { at: [30, 0, 0] });
      await h.settle();
      const reason = async (input: Row) => {
        const r = await h!.call('measure', input);
        if (r.ok) throw new Error(`measure answered ${JSON.stringify(r.result)}`);
        return r.error as { code: string; message: string; hint?: string; detail: Row };
      };
      expect(await reason(M(['Body 1', 'Body 2'], 'Top'))).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_section', field: 'section' } });
      expect(await reason(M(['Body 1'], 'Body 2'))).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('Body 2 is a body'), detail: { reason: 'bad_section' } });
      expect(await reason(M(['Body 1'], 'Z axis'))).toMatchObject({ detail: { reason: 'bad_section' }, message: 'bad_section: section: Z axis is not a plane.' });
      expect(await reason(M(['Body 1'], 'Top offset 5 qq'))).toMatchObject({ detail: { reason: 'expr_error', field: 'section' } });

      const unknown = await reason(M(['Bdy 1']));
      expect(unknown).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_selector', field: 'targets[0]', bodies: ['Body 1', 'Body 2'] } });
      expect(unknown.message).toContain('Bodies: Body 1, Body 2.');
      expect(await reason(M(['Body 1', 'Bdy 2']))).toMatchObject({ detail: { reason: 'bad_selector', field: 'targets[1]' } });

      expect(await reason(M(['selection']))).toMatchObject({ message: 'nothing_selected: targets[0]: the person has nothing selected.', detail: { reason: 'nothing_selected' } });
      const b = h.doc.state.get().rebuild.bodies.find((x) => x.id === body)!;
      selectItem(h.services.selection, { kind: 'face', body, index: 0 }, false);
      selectItem(h.services.selection, { kind: 'face', body, index: 1 }, true);
      const two = await reason(M(['selection']));
      expect(two).toMatchObject({ detail: { reason: 'selector_ambiguous', count: 2 } });
      expect((two.detail.candidates as Row[]).map((c) => typeof c.words)).toEqual(['string', 'string']);

      // A selected face is no body to cut; a curved face is no plane.
      const curved = (await h.services.kernel.call('topo', { id: b.shape, face_bbox: 'none' })).result.faces.find((f) => f.type === 'cylinder')!;
      selectItem(h.services.selection, { kind: 'face', body, index: curved.i }, false);
      expect(await reason(M(['selection'], 'Top'))).toMatchObject({ detail: { reason: 'bad_section' }, message: expect.stringContaining('A section cuts a body') });
      expect(await reason(M(['Body 1'], 'selection'))).toMatchObject({ detail: { reason: 'bad_section' }, message: expect.stringContaining('is not flat (cylinder)') });

      expect(await reason(M(['Body 1', 'body 1']))).toMatchObject({ detail: { reason: 'bad_input', field: 'targets' } });
      expect(await reason({ targets: [], section: '' })).toMatchObject({ detail: { reason: 'bad_input' } });
    },
    REAL_KERNEL_MS,
  );
});

describe('measure while the Part changes', () => {
  it(
    'a change in the middle measures again once; a second change answers busy/changed; a kernel restart in the middle measures again',
    async () => {
      const k = hookedKernel();
      h = await assistantHarness({ kernel: k.kernel });
      block(h.doc);
      block(h.doc, { at: [10, 10, 10] });
      await h.settle();
      let n = 0;
      const change = () => {
        n++;
        h!.doc.addParam({ name: `p${n}`, expr: `${n} mm`, quantity: 'length' });
      };
      // Once: the first boolean (the overlap) sees the Part change under it.
      let once = true;
      k.before.set('boolean', () => {
        if (!once) return;
        once = false;
        change();
      });
      const r = await h.ok('measure', M(['Body 1', 'Body 2']));
      expect(r.data).toMatchObject({ overlap_mm3: 1000, union_solids: 1 });
      expect(n).toBe(1);

      // Every time (twice per try: the overlap and the union): the second try changes too.
      k.before.set('boolean', change);
      const busy = await h.call('measure', M(['Body 1', 'Body 2']));
      expect(busy).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'changed' } } });
      expect(n).toBe(5);

      // The kernel restarts as the overlap is asked for: every shape died; measured again after the rebuild.
      let restart = true;
      k.before.set('boolean', () => {
        if (!restart) return;
        restart = false;
        void k.real.restart('test');
      });
      const again = await h.ok('measure', M(['Body 1', 'Body 2']));
      expect(again.data).toMatchObject({ overlap_mm3: 1000, union_solids: 1, union_voids: 0 });
      expect(k.real.status.get().respawns).toBe(1);

      // The kernel restarts once the overlap's shape is made (as its volume is asked for): that shape
      // died with its worker, and its id is never sent to the next one, which may give it to a body.
      restart = true;
      k.before.set('boolean', () => {});
      k.before.set('props', () => {
        if (!restart) return;
        restart = false;
        void k.real.restart('test');
      });
      const after = await h.ok('measure', M(['Body 1', 'Body 2']));
      expect(after.data).toMatchObject({ overlap_mm3: 1000, union_solids: 1, union_voids: 0 });
      expect(k.real.status.get().respawns).toBe(2);
      expect(k.stale).toEqual([]);
      // The bodies the rebuild made in the new worker are whole.
      expect((await h.ok('measure', M(['Body 1']))).data).toMatchObject({ volume_mm3: 8000, valid: true });
    },
    REAL_KERNEL_MS,
  );

  it(
    'a change while the call is held after the Part settled is measured',
    async () => {
      h = await assistantHarness();
      block(h.doc);
      await h.settle();
      const holds = runtimeOf(h.services)!.holds;
      holds.hold('after-settled');
      const call = h.call('measure', M(['Body 1']));
      await vi.waitFor(() => expect(holds.waiting()).toContain('after-settled'), { timeout: 10_000, interval: 5 });
      block(h.doc, { op: 'cut', at: [5, 5, 5], size: [10, 10, 10] });
      holds.release('after-settled');
      const r = await call;
      expect(r).toMatchObject({ ok: true, result: { data: { volume_mm3: 7000, shells: 2, voids: 1 } } });
    },
    REAL_KERNEL_MS,
  );

  it(
    'with the rollback bar above the end it measures the bodies there and says so',
    async () => {
      h = await assistantHarness();
      block(h.doc);
      block(h.doc, { op: 'cut', at: [5, 5, 5], size: [10, 10, 10] });
      await h.settle();
      h.doc.setRollback(2);
      await h.settle();
      const r = await h.ok('measure', M(['Body 1']));
      expect(r.data).toMatchObject({
        volume_mm3: 8000,
        voids: 0,
        rolled_back: { after: 'Extrude 1', count: 2 },
        note: 'The rollback bar is after Extrude 1: these are the bodies there, not at the end of the history.',
      });
      // Back at the end: the pocket again, and no note.
      h.doc.setRollback(null);
      await h.settle();
      const end = await h.ok('measure', M(['Body 1']));
      expect(end.data).toMatchObject({ volume_mm3: 7000, voids: 1 });
      expect(end.data.rolled_back).toBeUndefined();
      expect(end.data.note).toBeUndefined();
    },
    REAL_KERNEL_MS,
  );
});

describe('measure: by selector', () => {
  it(
    "a role label, a query and a handle find gave; a face's plane as the section; several things are ambiguous with handles; a bad selector, a region and an unknown handle say why",
    async () => {
      h = await assistantHarness();
      await ring(h, 10, 4, 10);
      const reason = async (input: Row) => {
        const r = await h!.call('measure', input);
        if (r.ok) throw new Error(`measure answered ${JSON.stringify(r.result)}`);
        return r.error as { code: string; message: string; detail: Row };
      };

      // A role label: the ring's top face.
      const top = await h.ok('measure', M(['Extrude 1.end']));
      expect(top.data).toMatchObject({ target: 'Extrude 1.end', kind: 'face', body: 'Body 1', words: 'face Extrude 1.end on Body 1', type: 'plane', area_mm2: sig6(Math.PI * (100 - 16)), normal: [0, 0, 1] });
      expect(top.text).toBe('face Extrude 1.end on Body 1: plane, area 263.894 mm2');
      // Its plane 5 mm down cuts the whole ring.
      const cut = await h.ok('measure', M(['Body 1'], 'Extrude 1.end offset -5 mm'));
      expect(cut.data.section).toMatchObject({ plane: 'face Extrude 1.end on Body 1 offset -5 mm', area_mm2: sig6(Math.PI * (100 - 16)), loops: 2, holes: 1 });
      // Two faces: 10 mm apart, parallel.
      expect((await h.ok('measure', M(['Extrude 1.end', 'Extrude 1.start']))).data).toMatchObject({ distance_mm: 10, parallel: true });

      // A handle find gave: the hole, at the same point on it as find says, on the cylinder.
      const [hole] = (await h.ok('find', { query: 'Body 1 faces hole', limit: 10 })).data.rows as Row[];
      expect(hole).toMatchObject({ handle: expect.stringMatching(/^#f\d+$/), type: 'cylinder', radius_mm: 4, hole: true });
      const byHandle = await h.ok('measure', M([hole.handle as string]));
      expect(byHandle.data).toMatchObject({ kind: 'face', type: 'cylinder', radius_mm: 4, point_mm: hole.point_mm });
      const p = byHandle.data.point_mm as number[];
      expect(Math.abs(Math.hypot(p[0], p[1]) - 4)).toBeLessThan(1e-3);

      // A query naming two things: ambiguous, each candidate with a handle; a filter narrows it to one.
      const two = await reason(M(['Body 1 edges %circle radius 10 mm']));
      expect(two).toMatchObject({ code: 'invalid_input', detail: { reason: 'selector_ambiguous', field: 'targets[0]', count: 2 } });
      expect((two.detail.candidates as Row[]).map((c) => String(c.handle))).toEqual([expect.stringMatching(/^#e\d+$/), expect.stringMatching(/^#e\d+$/)]);
      const rim = await h.ok('measure', M(['Body 1 edges %circle radius 10 mm >Z']));
      expect(rim.data).toMatchObject({ kind: 'edge', type: 'circle', radius_mm: 10, circumference_mm: 62.8319 });
      expect((rim.data.center_mm as number[])[2]).toBe(10);

      // Neither a body nor a selector: the selector's column, and the bodies.
      const bad = await reason(M(['Body 1 faces >Q']));
      expect(bad).toMatchObject({ code: 'invalid_input', detail: { reason: 'bad_selector', field: 'targets[0]', selector: 'Body 1 faces >Q', column: expect.any(Number), bodies: ['Body 1'] } });
      expect(bad.message).toMatch(/^bad_selector: targets\[0\]: "Body 1 faces >Q" is not a body here, nor a selector \(.*column \d+.*\)\. Use a body name, a face, edge or vertex selector/);
      expect(bad.message).toContain('Bodies: Body 1.');
      const badCut = await reason(M(['Body 1'], 'Extrude 1.end offsett 5 mm'));
      expect(badCut).toMatchObject({ detail: { reason: 'bad_section', field: 'section', column: expect.any(Number) } });
      // A sketch region is no measure target; a handle this request never gave is stale.
      expect(await reason(M(['Sketch 1 r1']))).toMatchObject({ detail: { reason: 'bad_selector', field: 'targets[0]' }, message: expect.stringContaining('is a sketch region') });
      expect(await reason(M(['#f99']))).toMatchObject({ detail: { reason: 'selector_stale', handle: '#f99' } });
    },
    REAL_KERNEL_MS,
  );

  it(
    "a split face measured by its label carries the selector's warning",
    async () => {
      h = await assistantHarness();
      // The plate's top face cut in two by a groove across it.
      const p = await plate(h);
      const b = bodyNamed(h, 'Body 1');
      const groove = await sketchOnFace(h, 'Groove sketch', b, faceNamed(b, `F:${p.extrude}:end`), new Shapes().rect('g', -2, -25, 2, 25));
      await extrude(h, 'Groove', regions(h, groove), { op: 'cut', flip: true, distance: '2 mm' });
      const rows = (await h.ok('find', { query: 'Extrude 1.end', limit: 10 })).data.rows as Row[];
      expect(rows.map((r) => r.label)).toEqual(['Extrude 1.end~1', 'Extrude 1.end~2']);
      expect(String(rows[0].warning)).toContain('split face');
      const m = await h.ok('measure', M(['Extrude 1.end~1']));
      expect(m.data).toMatchObject({ kind: 'face', type: 'plane', words: 'face Extrude 1.end~1 on Body 1', warning: rows[0].warning });
      expect(m.data.area_mm2).toBe(sig6(28 * 40));
    },
    REAL_KERNEL_MS,
  );
});

describe('measure: forms and help', () => {
  it('reads points and plane offsets', () => {
    expect(parsePoint('(1, -2.5, 3e1)')).toEqual([1, -2.5, 30]);
    expect(parsePoint('( 0,0 ,0 )')).toEqual([0, 0, 0]);
    expect(parsePoint('(1, 2)')).toBeNull();
    expect(parsePoint('(a, 2, 3)')).toBeNull();
    expect(splitOffset('Top offset 4 mm')).toEqual({ base: 'Top', offset: '4 mm', flip: false });
    expect(splitOffset('Base.end offset t/2 flip')).toEqual({ base: 'Base.end', offset: 't/2', flip: true });
    expect(splitOffset('Top')).toEqual({ base: 'Top', offset: null, flip: false });
  });

  it('help checks says how to read volumes, voids, overlaps, unions and sections', () => {
    const about = HELP.checks.map((r) => r.about);
    expect(about.slice(0, 4)).toEqual(['volumes and areas', 'voids', 'overlap and union', 'sections']);
    const text = HELP.checks.map((r) => r.text).join(' ');
    expect(text).toContain('1.5e-7');
    expect(text).toContain('two separate solids also give shells 2');
    expect(text).toContain('overlap_mm3');
    expect(text).toContain('union_solids');
  });
});
