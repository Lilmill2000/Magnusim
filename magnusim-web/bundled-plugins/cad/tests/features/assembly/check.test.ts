// The assembly checks (src/features/assembly/check.ts) on the REAL kernel, on fixtures built in code
// (tests/features/assembly/fixtures.ts; never a person's Parts):
//   - stack: two wheels on one headed shaft with a gap and nothing above: the lower one slides 4 mm
//     toward +Z before it meets the upper one, the upper one slides 4 mm toward -Z and comes off the
//     shaft toward +Z (each finding names the wheel and the side); a spacer between them and a
//     collar pressed on above: nothing is loose, and the parts list says what holds each side;
//   - stack: a wheel whose bore is 1.5 mm wider than its shaft is held radially by nothing (named,
//     with the numbers); a wheel alone has an empty bore;
//   - stack: two frame plates holding two arbors: an arbor with a wheel between the plates turns
//     held both ways, a plain one slides out of the frame either way;
//   - interference: two boxes that share 125 mm3, two pairs 0.2 mm apart listed only with a
//     clearance above it, a pair that touches counted as touching;
//   - sweep: a hand turned about its arbor meets a key at the angle the geometry gives (7.39 deg, and
//     332.87 deg the other way), and the kernel's turned copy 1 degree past it overlaps the key; the
//     same hand above the key meets nothing;
//   - sweep: when OCCT answers the turned copy's common as if apart (kernel API 10; GitHub issue 15)
//     the hit stays, with no word on what they share (never 0);
//   - 48 small bodies (a grid of rings on pins, every second one overlapping its neighbours) are
//     checked for interference and stack within CHECK_48_MS, every pair near enough measured;
//   - a check reports progress, stops with the signal, and past its time limit says how far it got;
//     the shapes it made are released; an axis the limit cut short is left out (no half-read finding);
//   - a D shaft in a D bore with 0.2 mm all round rides on it with that play (no press fit);
//   - a frame plate does not bring every body into each axis; bodies narrow the axes cut; a collar
//     keeps its levels among a comb's 900; a rod lying across a hand's path is met;
//   - interference: a collar drawn under its shaft is a press fit, apart from collisions; one body
//     against the rest; the stack: a frame's clearance hole is no finding, a lone hand's empty bore is.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { axisLine, checkInterference, checkStack, checkSweep, type StackPart } from '../../../src/features/assembly/check';
import type { KernelAdapter } from '../../../src/types/kernel';
import { commonsAsIfApart } from '../../fakes/as-if-apart';
import { realKernelAnywhere } from '../p2/kernel-anywhere';
import { Fixture } from './fixtures';

/** Real-kernel tests: each one's ceiling (Linux CI runs on 2 slow cores). */
const MS = 120_000;
/** 48 small bodies: interference and stack together within this (ms). */
export const CHECK_48_MS = 30_000;

let kernel: KernelAdapter | null = null;
afterEach(() => {
  kernel?.dispose();
  kernel = null;
});

async function fixture(): Promise<Fixture> {
  kernel = realKernelAnywhere();
  await kernel.start();
  return new Fixture(kernel);
}

const env = () => ({ kernel: kernel! });
const shapes = async () => (await kernel!.call('mem', {})).result.shapes;
const part = (parts: StackPart[], name: string) => parts.find((p) => p.body === name)!;

describe('stack', () => {
  it(
    'two wheels on one shaft with no spacer can slide (each named with its side); a spacer and a collar hold them',
    async () => {
      const f = await fixture();
      await f.shaft('Shaft', 2, 0, 30, { head: [6, 2] });
      await f.ring('Wheel 1', 2.2, 15, 2, 4);
      await f.ring('Wheel 2', 2.2, 12, 10, 4);
      const before = await shapes();
      const r = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(await shapes()).toBe(before);
      expect(r.complete).toBe(true);
      expect(r.axes).toHaveLength(1);
      expect(r.axes[0]).toMatchObject({ words: 'along Z through (0, 0, 0)', negWords: '-Z', posWords: '+Z' });
      expect(r.findings.map((x) => x.words)).toEqual([
        'Wheel 1 can slide 4 mm along Shaft toward +Z before it meets Wheel 2',
        'Wheel 2 can slide 4 mm along Shaft toward -Z before it meets Wheel 1',
        'Wheel 2 can slide along Shaft toward +Z: nothing stops it before it comes off Shaft',
      ]);
      expect(r.findings.map((x) => [x.body, x.kind, x.side])).toEqual([
        ['Wheel 1', 'slides', 'pos'],
        ['Wheel 2', 'slides', 'neg'],
        ['Wheel 2', 'free', 'pos'],
      ]);
      const parts = r.axes[0].parts;
      expect(parts.map((p) => p.body)).toEqual(['Shaft', 'Wheel 1', 'Wheel 2']);
      expect(part(parts, 'Wheel 1')).toMatchObject({ from: 2, to: 6, on: 'Shaft', inBore: false, neg: { by: 'Shaft', gap: 0 }, pos: { by: 'Wheel 2', gap: 4 } });
      expect(part(parts, 'Wheel 1').bore).toBeCloseTo(2.2, 9);
      expect(part(parts, 'Wheel 1').play).toBeCloseTo(0.2, 9);
      // The shaft carries them: it is not checked itself.
      expect(part(parts, 'Shaft')).toMatchObject({ on: null, neg: null, pos: null, bore: null });

      // A spacer between them and a collar pressed on above (its bore the shaft's size).
      await f.ring('Spacer', 2.2, 4, 6, 4);
      await f.ring('Collar', 2, 5, 14, 3);
      const held = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(held.findings).toEqual([]);
      const p2 = held.axes[0].parts;
      expect(part(p2, 'Wheel 1')).toMatchObject({ neg: { by: 'Shaft', gap: 0 }, pos: { by: 'Spacer', gap: 0 } });
      expect(part(p2, 'Spacer')).toMatchObject({ on: 'Shaft', neg: { by: 'Wheel 1', gap: 0 }, pos: { by: 'Wheel 2', gap: 0 } });
      expect(part(p2, 'Wheel 2')).toMatchObject({ neg: { by: 'Spacer', gap: 0 }, pos: { by: 'Collar', gap: 0 } });
      // The collar is fixed to the shaft by its press fit: neither is checked against the other.
      expect(part(p2, 'Collar')).toMatchObject({ fixed: ['Shaft'], on: null, neg: null });
      expect(part(p2, 'Shaft').fixed).toEqual(['Collar']);
      // Only some bodies: the findings and the sides of those only.
      const only = await checkStack(env(), f.bodies.slice(0, 3), { play: 0.5, only: [1] });
      expect(only.findings.map((x) => x.body)).toEqual(['Wheel 1']);
    },
    MS,
  );

  it(
    'a bore much wider than its shaft holds nothing radially, and a wheel alone has an empty bore',
    async () => {
      const f = await fixture();
      await f.shaft('Shaft', 2, 0, 30, { head: [6, 2] });
      await f.ring('Loose wheel', 3.5, 15, 2, 4);
      await f.ring('Lonely wheel', 3, 10, 0, 4, [60, 0]);
      const r = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(r.findings.map((x) => [x.body, x.kind])).toEqual([
        ['Loose wheel', 'bore'],
        ['Lonely wheel', 'bore'],
      ]);
      expect(r.findings[0].words).toBe('Nothing holds Loose wheel radially: its bore along Z through (0, 0, 0) (radius 3.5 mm) is 1.5 mm wider than Shaft (radius 2 mm) inside it');
      expect(r.findings[1].words).toBe('Nothing holds Lonely wheel radially: its bore along Z through (60, 0, 0) (radius 3 mm) is empty');
      // A wider play counts the loose one as held (on its shaft, now free above).
      const wide = await checkStack(env(), f.bodies, { play: 2 });
      expect(wide.findings.map((x) => [x.body, x.kind, x.side])).toEqual([
        ['Loose wheel', 'free', 'pos'],
        ['Lonely wheel', 'bore', null],
      ]);
    },
    MS,
  );

  it(
    'in a frame (plates holding two arbors) an arbor with a wheel between the plates is held; a plain one slides out either way',
    async () => {
      const f = await fixture();
      for (const [name, z] of [['Front plate', 0], ['Back plate', 20]] as const) await f.box(name, [-10, -10, z], [50, 20, 3]);
      // Bores in both plates at x 0 and x 30 (the plates are cut by two cylinders each).
      const k = kernel!;
      for (const b of f.bodies) {
        let id = b.shape;
        for (const x of [0, 30]) {
          const hole = (await k.call('cylinder', { r: 2.2, h: 3, origin: [x, 0, b.bbox[2]], axis: [0, 0, 1] })).result.id;
          id = (await k.call('boolean', { op: 'cut', targets: [id], tools: [hole] })).result.id;
        }
        b.shape = id;
        b.faces = (await k.call('props', { id })).result.faces;
      }
      // Arbor 1: a rod with a wheel joined on it, between the plates (touching both). Arbor 2: a plain rod.
      const rod = (await k.call('cylinder', { r: 2, h: 29, origin: [0, 0, -3], axis: [0, 0, 1] })).result.id;
      const wheel = (await k.call('cylinder', { r: 8, h: 17, origin: [0, 0, 3], axis: [0, 0, 1] })).result.id;
      const arbor = (await k.call('boolean', { op: 'fuse', targets: [rod], tools: [wheel] })).result.id;
      const p = (await k.call('props', { id: arbor, bbox: 'exact' })).result;
      f.bodies.push({ id: 'a1', name: 'Arbor 1', shape: arbor, bbox: p.bbox as never, faces: p.faces, solids: p.solids });
      await f.shaft('Arbor 2', 2, -3, 29, { at: [30, 0] });
      const r = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(r.axes.map((a) => a.words)).toEqual(['along Z through (0, 0, 0)', 'along Z through (30, 0, 0)']);
      expect(part(r.axes[0].parts, 'Arbor 1')).toMatchObject({ on: expect.stringMatching(/plate$/), inBore: true, neg: { by: 'Front plate', gap: 0 }, pos: { by: 'Back plate', gap: 0 } });
      expect(r.findings.map((x) => x.words)).toEqual(['Arbor 2 can slide in Front plate toward -Z: nothing stops it', 'Arbor 2 can slide in Front plate toward +Z: nothing stops it']);
    },
    MS,
  );
});

describe('interference', () => {
  it(
    'lists pairs that overlap with where, pairs closer than a clearance, and counts the pairs that touch',
    async () => {
      const f = await fixture();
      await f.box('A', [0, 0, 0], [10, 10, 10]);
      await f.box('B', [5, 5, 5], [10, 10, 10]);
      await f.box('C', [30, 0, 0], [10, 10, 10]);
      await f.box('D', [40.2, 0, 0], [10, 10, 10]);
      await f.box('E', [30, 0, 10], [10, 10, 10]);
      const before = await shapes();
      const r = await checkInterference(env(), f.bodies, { clearance: 0 });
      expect(await shapes()).toBe(before);
      expect(r).toMatchObject({ bodies: 5, pairs: 10, complete: true, touching: 1, surfaces: [] });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ a: 'A', b: 'B', gap: null });
      expect(r.rows[0].overlap).toBeCloseTo(125, 6);
      expect(r.rows[0].at.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([7.5, 7.5, 7.5]);
      // Boxes far apart are never measured.
      expect(r.boxPairs).toBeLessThan(r.pairs);
      const close = await checkInterference(env(), f.bodies, { clearance: 0.5 });
      expect(close.rows.map((x) => [x.a, x.b, x.overlap === null ? 'gap' : 'overlap'])).toEqual([
        ['A', 'B', 'overlap'],
        ['C', 'E', 'gap'],
        ['C', 'D', 'gap'],
        ['D', 'E', 'gap'],
      ]);
      expect(close.rows[1].gap).toBe(0);
      expect(close.rows[2].gap).toBeCloseTo(0.2, 9);
      expect(close.rows[3].gap).toBeCloseTo(0.2, 9);
    },
    MS,
  );
});

describe('sweep', () => {
  it(
    'a hand turned about its arbor meets a key at the first angle each way, confirmed by the kernel; above the key it meets nothing',
    async () => {
      const f = await fixture();
      await f.shaft('Arbor', 2, 0, 30);
      await f.hand('Hand', 2.1, 4, 10, 1, 40, 4);
      await f.box('Key', [20, 5, 8], [3, 3, 6]);
      await f.hand('High hand', 2.1, 4, 20, 1, 40, 4);
      const before = await shapes();
      const r = await checkSweep(env(), f.bodies, [1], axisLine([0, 0, 0], [0, 0, 1]));
      expect(await shapes()).toBe(before);
      expect(r).toMatchObject({ words: 'along Z through (0, 0, 0)', turning: ['Hand'], already: [], complete: true });
      expect(r.hits).toHaveLength(1);
      const hit = r.hits[0];
      expect(hit).toMatchObject({ turning: 'Hand', hits: 'Key' });
      // The key's far corner (23, 5) meets the arm's edge y = 2: atan(5/23) - asin(2/|(23, 5)|).
      const r23 = Math.hypot(23, 5);
      expect(hit.pos!).toBeCloseTo(((Math.atan2(5, 23) - Math.asin(2 / r23)) * 180) / Math.PI, 1);
      // The other way the arm's edge y = -2 meets the corner (20, 8).
      expect(hit.neg!).toBeCloseTo(360 - ((Math.atan2(8, 20) + Math.asin(2 / Math.hypot(20, 8))) * 180) / Math.PI, 1);
      expect(hit.at[2]).toBeCloseTo(10.5, 6);
      expect(hit.overlap!).toBeGreaterThan(0.1);
      // The high hand turns clear of everything (the arbor in its bore is no hit).
      const high = await checkSweep(env(), f.bodies, [3], axisLine([0, 0, 0], [0, 0, 1]));
      expect(high.hits).toEqual([]);
      expect(high.near).toBeGreaterThan(0);
    },
    MS,
  );

  it(
    "when OCCT answers the turned copy's common as if apart (kernel API 10, as_if_apart wrong; GitHub issue 15): the hit stays, with no word on what they share (never 0 shared)",
    async () => {
      const f = await fixture();
      await f.shaft('Arbor', 2, 0, 30);
      await f.hand('Hand', 2.1, 4, 10, 1, 40, 4);
      await f.box('Key', [20, 5, 8], [3, 3, 6]);
      const k = commonsAsIfApart(kernel!);
      k.set(true);
      const r = await checkSweep({ kernel: k.kernel }, f.bodies, [1], axisLine([0, 0, 0], [0, 0, 1]));
      expect(r.hits).toHaveLength(1);
      expect(r.hits[0]).toMatchObject({ turning: 'Hand', hits: 'Key', overlap: null });
    },
    MS,
  );
});

describe('48 small bodies', () => {
  it(
    `are checked for interference and stack within ${CHECK_48_MS / 1000} s, every pair near enough measured`,
    async () => {
      const f = await fixture();
      // 24 pins in a 6 x 4 grid, each with a ring on it; every second ring is wide enough to overlap its neighbour.
      for (let i = 0; i < 24; i++) {
        const at: [number, number] = [(i % 6) * 12, Math.floor(i / 6) * 12];
        await f.shaft(`Pin ${i + 1}`, 2, 0, 10, { at, head: [4, 1] });
        await f.ring(`Ring ${i + 1}`, 2.2, i % 2 ? 7.5 : 5, 1, 3, at);
      }
      expect(f.bodies).toHaveLength(48);
      const t0 = performance.now();
      const fractions: number[] = [];
      const i = await checkInterference({ kernel: kernel!, progress: (x) => x !== null && fractions.push(x) }, f.bodies, { clearance: 0 });
      const s = await checkStack(env(), f.bodies, { play: 0.5 });
      const ms = performance.now() - t0;
      console.log(`[assembly] 48 bodies: interference ${i.boxPairs} of ${i.pairs} pairs measured, stack ${s.axes.length} axes, ${Math.round(ms)} ms`);
      expect(ms).toBeLessThan(CHECK_48_MS);
      expect(i).toMatchObject({ bodies: 48, pairs: 1128, complete: true });
      expect(i.checked).toBe(i.boxPairs);
      expect(i.boxPairs).toBeLessThan(200);
      // Each wide ring (radius 7.5, 12 mm from its neighbours) overlaps the rings beside it: 5 pairs in
      // each of the 4 rows, and the wide ones above each other in 3 columns, 3 pairs each.
      expect(i.rows.length).toBe(29);
      expect(i.rows.every((x) => x.a.startsWith('Ring') && x.b.startsWith('Ring') && (x.overlap ?? 0) > 0)).toBe(true);
      expect(fractions.length).toBeGreaterThan(10);
      expect(s.complete).toBe(true);
      expect(s.axes).toHaveLength(24);
      // Every ring rests on its pin's head with nothing above: free toward +Z.
      expect(s.findings).toHaveLength(24);
      expect(s.findings.every((x) => x.kind === 'free' && x.side === 'pos')).toBe(true);
    },
    MS,
  );
});

describe('progress, the stop and the time limit', () => {
  it(
    'stops with the signal, and past the time limit says how far it got',
    async () => {
      const f = await fixture();
      for (let i = 0; i < 4; i++) await f.box(`Box ${i + 1}`, [i * 9, 0, 0], [10, 10, 10]);
      const stop = new AbortController();
      stop.abort(new Error('stopped by the test'));
      await expect(checkInterference({ kernel: kernel!, signal: stop.signal }, f.bodies, { clearance: 0 })).rejects.toThrow('stopped by the test');
      await expect(checkStack({ kernel: kernel!, signal: stop.signal }, f.bodies, { play: 0.5 })).rejects.toThrow('stopped by the test');
      const late = await checkInterference({ kernel: kernel!, timeLimitMs: 0 }, f.bodies, { clearance: 0 });
      expect(late).toMatchObject({ complete: false, checked: 0, boxPairs: 3 });
      const full = await checkInterference(env(), f.bodies, { clearance: 0 });
      expect(full).toMatchObject({ complete: true, checked: 3 });
      expect(full.rows.map((x) => [x.a, x.b])).toEqual([
        ['Box 1', 'Box 2'],
        ['Box 2', 'Box 3'],
        ['Box 3', 'Box 4'],
      ]);
    },
    MS,
  );
});

describe('fits that are not round, the time limit, which bodies an axis cuts, and its levels', () => {
  it(
    'a D shaft in a D bore 0.2 mm larger all round rides on it with that play (not a press fit): the wheel slides down to the head and off the top',
    async () => {
      const f = await fixture();
      await f.dShaft('Shaft', 2, 1.5, 0, 30, { head: [6, 2] });
      await f.dRing('Wheel', 2.2, 1.7, 12, 10, 4);
      const r = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(r.complete).toBe(true);
      const wheel = part(r.axes[0].parts, 'Wheel');
      expect(wheel).toMatchObject({ on: 'Shaft', inBore: false, fixed: [] });
      expect(wheel.play!).toBeCloseTo(0.2, 6);
      expect(r.findings.map((x) => x.words)).toEqual(['Wheel can slide 8 mm along Shaft toward -Z before it meets Shaft', 'Wheel can slide along Shaft toward +Z: nothing stops it before it comes off Shaft']);
    },
    MS,
  );

  it(
    'an axis the time limit cut short is left out, never read half way: no finding from its first slabs, and the result says how many axes it checked',
    async () => {
      const f = await fixture();
      await f.shaft('Shaft', 2, 0, 30, { head: [6, 2] });
      await f.ring('Wheel 1', 2.2, 15, 2, 4);
      await f.ring('Spacer', 2.2, 4, 6, 4);
      await f.ring('Wheel 2', 2.2, 12, 10, 4);
      await f.ring('Collar', 2, 5, 14, 3);
      expect((await checkStack(env(), f.bodies, { play: 0.5 })).findings).toEqual([]);
      // A clock that passes the limit after two slabs (one tick per look at it).
      let tick = 0;
      const r = await checkStack({ kernel: kernel!, now: () => tick++, timeLimitMs: 3 }, f.bodies, { play: 0.5 });
      expect(r).toMatchObject({ complete: false, axes: [], axesTotal: 1, findings: [] });
    },
    MS,
  );

  it(
    "a frame plate's far corner does not bring every body into each axis; with some bodies only, the axes near them (and one more to know the plates are a frame)",
    async () => {
      const f = await fixture();
      const k = kernel!;
      for (const [name, z] of [['Front plate', 0], ['Back plate', 20]] as const) await f.box(name, [-10, -10, z], [100, 20, 3]);
      for (const b of f.bodies) {
        let id = b.shape;
        for (const x of [0, 30, 60]) {
          const hole = (await k.call('cylinder', { r: 2.2, h: 3, origin: [x, 0, b.bbox[2]], axis: [0, 0, 1] })).result.id;
          id = (await k.call('boolean', { op: 'cut', targets: [id], tools: [hole] })).result.id;
        }
        b.shape = id;
        b.faces = (await k.call('props', { id })).result.faces;
      }
      for (const x of [0, 30, 60]) {
        await f.shaft(`Arbor ${x}`, 2, -3, 29, { at: [x, 0] });
        await f.ring(`Wheel ${x}`, 2, 12, 8, 4, [x, 0]);
      }
      const sections: { x: number; ids: number }[] = [];
      const spy = new Proxy(k, {
        get(target, key, receiver) {
          if (key !== 'call') return Reflect.get(target, key, receiver);
          return (op: string, params: { plane?: { origin: number[] }; ids?: unknown[] }, o?: unknown) => {
            if (op === 'section') sections.push({ x: Math.round(params.plane!.origin[0]), ids: params.ids!.length });
            return (target.call as (...a: unknown[]) => unknown)(op, params, o);
          };
        },
      }) as KernelAdapter;
      const all = await checkStack({ kernel: spy }, f.bodies, { play: 0.5 });
      expect(all.axes.map((a) => a.words)).toEqual(['along Z through (0, 0, 0)', 'along Z through (30, 0, 0)', 'along Z through (60, 0, 0)']);
      // Each axis cuts its own arbor and wheel and the two plates, not the others' (8 bodies).
      expect(Math.max(...sections.map((s) => s.ids))).toBe(4);
      sections.length = 0;
      const wheel0 = f.bodies.findIndex((b) => b.name === 'Wheel 0');
      const only = await checkStack({ kernel: spy }, f.bodies, { play: 0.5, only: [wheel0] });
      expect(only).toMatchObject({ complete: true, axesTotal: 1 });
      expect(only.axes.map((a) => a.words)).toEqual(['along Z through (0, 0, 0)']);
      expect([...new Set(sections.map((s) => s.x))].sort((a, b) => a - b)).toEqual([0, 30]);
      // The wheel is pressed on its arbor, which turns in the plates: its findings are the full run's.
      const mine = new Set(['Wheel 0', 'Arbor 0']);
      expect(only.findings.map((x) => x.words)).toEqual(all.findings.filter((x) => mine.has(x.body)).map((x) => x.words));
      expect(only.findings.length).toBeGreaterThan(0);
    },
    MS,
  );

  it(
    "a collar one slab thick keeps its levels among a comb's 900 (the axis's own parts first): the wheel is held both ways",
    async () => {
      const f = await fixture();
      await f.shaft('Shaft', 2, 0, 40, { head: [6, 2] });
      await f.ring('Wheel', 2.2, 12, 2, 4);
      await f.ring('Collar', 2, 5, 6, 1);
      const alone = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(alone.findings).toEqual([]);
      const comb = await f.comb('Comb', 7, 9, 9, 39, 450, -1, 2);
      expect([comb.bbox[2], comb.bbox[5]].map((z) => Math.round(z))).toEqual([9, 39]);
      const r = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(r).toMatchObject({ complete: true, thinned: true });
      expect(r.axes[0].parts.map((p) => p.body)).toEqual(['Shaft', 'Wheel', 'Collar']);
      expect(part(r.axes[0].parts, 'Wheel')).toMatchObject({ from: 2, to: 6, neg: { by: 'Shaft', gap: 0 }, pos: { by: 'Collar', gap: 0 } });
      expect(r.findings).toEqual([]);
    },
    MS * 2,
  );

  it(
    "a rod lying across the hand's path, dipping 0.4 mm into it, is met (its lowest line is a face's end, not a vertex)",
    async () => {
      const f = await fixture();
      await f.shaft('Arbor', 2, 0, 30);
      await f.hand('Hand', 2.1, 4, 10, 1, 40, 4);
      await f.rodX('Rod', 2, -50, 100, 30, 12.6);
      const r = await checkSweep(env(), f.bodies, [1], axisLine([0, 0, 0], [0, 0, 1]));
      expect(r).toMatchObject({ complete: true, already: [] });
      expect(r.hits.map((h) => h.hits)).toEqual(['Rod']);
      // The kernel's turned copy 1 degree past the contact shares material with the rod.
      expect(r.hits[0].overlap!).toBeGreaterThan(0);
    },
    MS,
  );
});

describe('press fits in interference, frame holes and lone hands in the stack', () => {
  it(
    'a collar drawn 0.05 mm under its shaft is a press fit, apart from a real collision; two coaxial wheels overlapping 0.2 mm along the axis are a collision; one body against the rest',
    async () => {
      const f = await fixture();
      await f.shaft('Shaft', 2, 0, 20);
      await f.ring('Collar', 1.95, 5, 5, 4);
      await f.box('Block', [4, -1, 5], [3, 2, 2]);
      await f.ring('Wheel A', 2.2, 10, 10, 4);
      await f.ring('Wheel B', 2.2, 10, 13.8, 4);
      const r = await checkInterference(env(), f.bodies, { clearance: 0 });
      expect(r.rows.map((x) => [x.a, x.b, x.press])).toEqual([
        ['Wheel A', 'Wheel B', false],
        ['Collar', 'Block', false],
        ['Shaft', 'Collar', true],
      ]);
      expect(r.rows[2].overlap!).toBeCloseTo(Math.PI * (4 - 1.95 ** 2) * 4, 3);
      expect(r.one).toBeNull();
      // The block against every other body: only its pairs.
      const one = await checkInterference(env(), f.bodies, { clearance: 0, one: 2 });
      expect(one).toMatchObject({ one: 'Block', pairs: 4, complete: true });
      expect(one.rows.map((x) => [x.a, x.b])).toEqual([['Collar', 'Block']]);
    },
    MS,
  );

  it(
    "a frame plate's clearance hole round a pipe that bears in the other plate is no finding",
    async () => {
      const f = await fixture();
      const k = kernel!;
      for (const [name, z] of [['Front plate', 0], ['Back plate', 20]] as const) await f.box(name, [-10, -10, z], [80, 20, 3]);
      for (const b of f.bodies) {
        let id = b.shape;
        for (const [x, r] of [[0, 2.2], [30, 2.2], [60, b.name === 'Front plate' ? 5 : 4.2]]) {
          const hole = (await k.call('cylinder', { r, h: 3, origin: [x, 0, b.bbox[2]], axis: [0, 0, 1] })).result.id;
          id = (await k.call('boolean', { op: 'cut', targets: [id], tools: [hole] })).result.id;
        }
        b.shape = id;
        b.faces = (await k.call('props', { id })).result.faces;
      }
      await f.shaft('Arbor 1', 2, -3, 29);
      await f.shaft('Arbor 2', 2, -3, 29, { at: [30, 0] });
      await f.shaft('Pipe', 4, -3, 29, { at: [60, 0] });
      const r = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(r.complete).toBe(true);
      expect(r.findings.filter((x) => x.kind === 'bore')).toEqual([]);
      expect(r.findings.some((x) => x.body === 'Front plate' || x.body === 'Back plate')).toBe(false);
    },
    MS,
  );

  it(
    'a hand alone (its centroid out on its arm) with nothing in its bore is a finding',
    async () => {
      const f = await fixture();
      await f.hand('Lonely hand', 2.1, 4, 0, 1, 30, 4);
      const r = await checkStack(env(), f.bodies, { play: 0.5 });
      expect(r.findings.map((x) => x.words)).toEqual(['Nothing holds Lonely hand radially: its bore along Z through (0, 0, 0) (radius 2.1 mm) is empty']);
    },
    MS,
  );
});
