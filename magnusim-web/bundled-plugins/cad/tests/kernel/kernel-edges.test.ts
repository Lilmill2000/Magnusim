// @vitest-environment node
// tessellate's edge_flags: one byte per edge index, so the viewport can skip lines
// that are not model edges (seams, poles, internal edges, same-domain splits) and
// tell tangent (smooth) edges apart.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { EDGE_FLAG, EDGE_HIDDEN } from '../../src/types/kernel-protocol';
import { call, FIXTURES, importStep, loadKernel, type R } from './kernel-lib';

let k: Kernel;
beforeAll(async () => {
  k = await loadKernel();
});

function flags(id: number, extra: R = {}): { flags: number[]; hidden: number; count: Record<number, number> } {
  const t = call(k, 'tessellate', { id, ...extra });
  const b = k.takeBuffers(t as never);
  const f = [...(b.edge_flags as Uint8Array)];
  expect(f.length).toBe(b.edge_ranges.length / 2);
  const count: Record<number, number> = {};
  for (const x of f) count[x] = (count[x] ?? 0) + 1;
  return { flags: f, hidden: t.hidden_edges, count };
}

describe('edge flags', () => {
  it('a box has 12 plain edges', () => {
    const r = flags(call(k, 'box', { dx: 1, dy: 2, dz: 3 }).id);
    expect(r.count).toEqual({ 0: 12 });
    expect(r.hidden).toBe(0);
  });

  it('a cylinder has 2 circles and 1 seam; a sphere 1 seam and 2 poles', () => {
    expect(flags(call(k, 'cylinder', { r: 2, h: 5 }).id).count).toEqual({ 0: 2, [EDGE_FLAG.seam]: 1 });
    const s = flags(call(k, 'sphere', { r: 2 }).id);
    expect(s.count).toEqual({ [EDGE_FLAG.seam]: 1, [EDGE_FLAG.degenerated]: 2 });
    expect(s.hidden).toBe(3);
  });

  it('a fillet boundary is smooth (tangent), the other edges stay plain', () => {
    const box = call(k, 'box', { dx: 20, dy: 20, dz: 20 }).id;
    const f = call(k, 'fillet', { id: box, edges: [0], r: 3 });
    const r = flags(f.id);
    expect(r.count[EDGE_FLAG.smooth]).toBe(2);
    expect(r.hidden).toBe(0);
    // smooth:false skips the tangency test.
    expect(flags(f.id, { smooth: false }).count[EDGE_FLAG.smooth]).toBeUndefined();
  });

  it('a join left un-unified has same-domain edges; unified it has none', () => {
    const a = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id;
    const b = call(k, 'box', { origin: [10, 0, 0], dx: 10, dy: 10, dz: 10 }).id;
    const raw = call(k, 'boolean', { op: 'fuse', targets: [a], tools: [b], unify: false });
    const r = flags(raw.id);
    expect(r.count[EDGE_FLAG.same_domain]).toBe(4); // the seam between the two boxes on 4 sides
    expect(r.hidden).toBe(4);
    const unified = call(k, 'boolean', { op: 'fuse', targets: [a], tools: [b] });
    expect(flags(unified.id).count).toEqual({ 0: 12 });
  });

  it('the Vortex recipe: the tangent inlet leaves an 85.5 mm internal edge in the roof (P0)', () => {
    const calls: R[] = JSON.parse(readFileSync(join(FIXTURES, 'vortex-recipe.calls.json'), 'utf8')).calls;
    const bin = call(k, 'extrude', calls[0].params).id;
    const cone = call(k, 'revolve', calls[1].params).id;
    const j1 = call(k, 'boolean', { op: 'fuse', targets: [bin], tools: [cone] }).id;
    const inlet = call(k, 'extrude', calls[4].params).id;
    const j2 = call(k, 'boolean', { op: 'fuse', targets: [j1], tools: [inlet] }).id;
    const r = flags(j2);
    const t = call(k, 'topo', { id: j2, faces: 'none', vertices: 'none' });
    const internal = r.flags.map((f, i) => [f, i]).filter(([f]) => f & EDGE_FLAG.internal).map(([, i]) => t.edges[i].length);
    expect(internal).toHaveLength(1);
    expect(internal[0]).toBeCloseTo(85.5111, 3);
  });

  it('the imported Vortex: seams, poles and the split cone are hidden, blends are smooth', () => {
    const id = importStep(k, 'vortex-cfd-test.step').shapes[0].id;
    const r = flags(id);
    expect(r.flags).toHaveLength(34);
    expect(r.hidden).toBe(r.flags.filter((f) => f & EDGE_HIDDEN).length);
    expect(r.count[EDGE_FLAG.seam]).toBeGreaterThan(0);
    expect(r.count[EDGE_FLAG.same_domain]).toBe(1); // the exporter split the cone in two
    expect(r.count[EDGE_FLAG.smooth]).toBeGreaterThan(0);
  });

  it('edge_flags:false leaves the buffer out', () => {
    const t = call(k, 'tessellate', { id: call(k, 'box', { dx: 1, dy: 1, dz: 1 }).id, edge_flags: false });
    expect(Object.keys(k.takeBuffers(t as never))).not.toContain('edge_flags');
  });
});
