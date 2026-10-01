// @vitest-environment node
// Mutating ops run on deep copies (decision 3): a failed op never changes a body
// the rebuild cache still holds. The P0 finding replayed: the Vortex recipe up to
// the inlet join, the R0.125 in inlet blend (which OCCT 7.9.3 cannot build), then
// the vortex-finder cut. With the fillet run in place, the cut removed 0.10 mm3
// (natively; 0.015 mm3 in this kernel built with MK_TEST_NO_WORK_COPY) instead
// of 42,353 mm3. The recipe's calls are fixtures/kernel/vortex-recipe.calls.json;
// fillet edges are found by name (the faces they lie between), not by index.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, fingerprint, FIXTURES, loadKernel, rect, rel, tryCall, volume, type R } from './kernel-lib';

const CALLS: R[] = JSON.parse(readFileSync(join(FIXTURES, 'vortex-recipe.calls.json'), 'utf8')).calls;
// Analytic volume of the vortex-finder ring (outer r 1.188 in, inner r 1 in, 2 in deep).
const RING = Math.PI * (30.1752 ** 2 - 25.4 ** 2) * 50.8;

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

/** The exact recipe up to the inlet join, naming faces from the kernel's history. */
function buildToInlet() {
  const names = new Map<number, Map<number, Set<string>>>();
  const nameSet = (id: number, fi: number) => {
    if (!names.has(id)) names.set(id, new Map());
    const m = names.get(id)!;
    if (!m.has(fi)) m.set(fi, new Set());
    return m.get(fi)!;
  };
  const sweep = (r: R, feat: string) => {
    for (const [seg, fi] of Object.entries(r.history.sides as Record<string, number>)) nameSet(r.id, fi).add(`F:${feat}:side:${seg}`);
    if (r.history.start != null) nameSet(r.id, r.history.start).add(`F:${feat}:start`);
    if (r.history.end != null) nameSet(r.id, r.history.end).add(`F:${feat}:end`);
  };
  const inherit = (r: R) => {
    for (const f of r.history.faces as R[])
      for (const s of f.from as R[]) {
        const from = s.face != null ? names.get(s.shape)?.get(s.face) : undefined;
        if (from) for (const n of from) nameSet(r.id, f.out).add(n);
      }
  };
  const between = (id: number, a: string, b: string): number[] => {
    const nm = names.get(id) ?? new Map<number, Set<string>>();
    const has = (fi: number, n: string) => !!nm.get(fi)?.has(n);
    const t = call(k, 'topo', { id, faces: 'none', vertices: 'none' });
    return t.edges
      .filter((e: R) => e.faces.length === 2 && ((has(e.faces[0], a) && has(e.faces[1], b)) || (has(e.faces[0], b) && has(e.faces[1], a))))
      .map((e: R) => e.i);
  };
  const bin = call(k, 'extrude', CALLS[0].params);
  sweep(bin, 'f_bin');
  const cone = call(k, 'revolve', CALLS[1].params);
  sweep(cone, 'f_cone');
  const j1 = call(k, 'boolean', { ...CALLS[2].params, targets: [bin.id], tools: [cone.id] });
  inherit(j1);
  const neck = between(j1.id, 'F:f_cone:side:e_slant', 'F:f_bin:start');
  expect(neck).toHaveLength(1);
  const f1 = call(k, 'fillet', { id: j1.id, edges: neck, r: CALLS[3].params.r });
  expect(f1.valid).toBe(true);
  inherit(f1);
  const inlet = call(k, 'extrude', CALLS[4].params);
  sweep(inlet, 'f_in');
  const j2 = call(k, 'boolean', { ...CALLS[5].params, targets: [f1.id], tools: [inlet.id] });
  expect(j2.valid).toBe(true);
  inherit(j2);
  return { body: j2.id as number, blendEdges: between(j2.id, 'F:f_in:side:e_in', 'F:f_cone:side:e_slant') };
}

function cutRing(body: number) {
  const ring = call(k, 'extrude', CALLS[7].params);
  const cut = call(k, 'boolean', { op: 'cut', targets: [body], tools: [ring.id] });
  return { removed: volume(k, body) - volume(k, cut.id), valid: cut.valid };
}

describe('P0 finding: a failed fillet must not poison its input', () => {
  it('the vortex-finder cut removes the ring whether or not the inlet blend was tried first', () => {
    // Control: no blend attempt.
    const control = buildToInlet();
    const c = cutRing(control.body);
    expect(c.valid).toBe(true);
    expect(rel(c.removed, RING)).toBeLessThan(1e-4); // the ring meets the cone roof, so not exactly analytic

    const { body, blendEdges } = buildToInlet();
    expect(blendEdges).toHaveLength(3); // the inlet/cone intersection, split in 3
    const before = fingerprint(k, body);
    const blend = tryCall(k, 'fillet', { id: body, edges: blendEdges, r: 3.175 });
    // OCCT 7.9.3 "builds" it as a 7-face, 220,515 mm3 solid: reported, not passed off.
    expect(blend.ok).toBe(true);
    expect(blend.valid).toBe(false);
    expect(blend.reason).toMatch(/UnorientableShape/);
    expect(rel(volume(k, blend.id), 220515.44)).toBeLessThan(1e-6);
    // The body the blend ran on is exactly as it was...
    expect(fingerprint(k, body)).toEqual(before);
    // ...and a later cut on it removes the ring, as in the control (not 0.1 mm3).
    const after = cutRing(body);
    expect(after.valid).toBe(true);
    expect(rel(after.removed, c.removed)).toBeLessThan(1e-12);
  }, 120_000);

  it('a blend OCCT refuses outright (1 faulty vertex) is ok:false and leaves the body as it was', () => {
    const { body, blendEdges } = buildToInlet();
    const before = fingerprint(k, body);
    const t = call(k, 'topo', { id: body, faces: 'none', vertices: 'none', edges: blendEdges });
    const longest = t.edges.reduce((a: R, b: R) => (b.length > a.length ? b : a)).i; // 170.8 mm: "1 faulty vertex" natively
    const r = tryCall(k, 'fillet', { id: body, edges: [longest], r: 3.175 });
    expect(r).toMatchObject({ ok: false, kind: 'occt' });
    expect(r.error).toMatch(/fillet failed .*the body is unchanged/);
    expect(fingerprint(k, body)).toEqual(before);
  }, 120_000);
});

describe('every mutating op leaves its inputs unchanged', () => {
  it('boolean, split, fillet, chamfer, shell, defeature and repair (and tessellate, export)', () => {
    const box = call(k, 'box', { dx: 20, dy: 20, dz: 20 }).id;
    const cyl = call(k, 'cylinder', { r: 4, h: 30, origin: [10, 10, -5] }).id;
    const cut = call(k, 'boolean', { op: 'cut', targets: [box], tools: [cyl] }).id;
    const watched = [box, cyl, cut];
    const before = watched.map((id) => fingerprint(k, id));
    const hole = call(k, 'topo', { id: cut, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.type === 'cylinder').i;
    const top = call(k, 'topo', { id: box, edges: 'none', vertices: 'none' }).faces.find((f: R) => f.normal && f.normal[2] > 0.5).i;
    const ops: [string, R][] = [
      ['boolean', { op: 'fuse', targets: [box], tools: [cyl] }],
      ['boolean', { op: 'common', targets: [cut], tools: [box] }],
      ['split', { id: cut, plane: { origin: [0, 0, 10], normal: [0, 0, 1] } }],
      ['split', { id: box, tool: cyl }],
      ['fillet', { id: cut, edges: [0, 1, 2], r: 1 }],
      ['fillet', { id: box, edges: [0], r: 25 }], // too big: fails
      ['chamfer', { id: box, edges: [0, 3], d: 2 }],
      ['shell', { id: box, faces: [top], t: 2 }],
      ['defeature', { id: cut, faces: [hole] }],
      ['repair', { id: cut }],
      // Not modelling ops, but they read the stored shapes too.
      ['tessellate', { id: cut, lin_defl: 0.05 }],
      ['export_step', { shapes: [{ id: cut, name: 'Cut' }], schema: 'AP242' }],
      ['topo', { id: box }],
    ];
    for (const [op, p] of ops) {
      const r = tryCall(k, op, p);
      if (r.ok) k.takeBuffers(r as never); // frees any result buffers
    }
    expect(watched.map((id) => fingerprint(k, id))).toEqual(before);
  });

  it('a shape used twice in one boolean is copied consistently', () => {
    const a = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id;
    const r = call(k, 'boolean', { op: 'common', targets: [a], tools: [a] });
    expect(r.valid).toBe(true);
    expect(rel(volume(k, r.id), 1000)).toBeLessThan(1e-12);
  });

  it('reports the copy cost (timings.copy_ms)', () => {
    const r = call(k, 'fillet', { id: call(k, 'extrude', { profile: rect(0, 0, 30, 10), extent: { kind: 'blind', d: 5 } }).id, edges: [0], r: 1 });
    expect(typeof r.timings.copy_ms).toBe('number');
    expect(typeof r.timings.op_ms).toBe('number');
  });
});
