// @vitest-environment node
// P0 gates 2, 3, 4, 5 and 7 on the shipped kernel, against the native reference
// (fixtures/kernel/reference.json: OCCT 7.9.3 run natively). Gate 9 (out of
// memory) is kernel-oom.test.ts; the 113 MB STEP is kernel-bigstep.test.ts (opt-in).
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, importStep, loadKernel, rect, REF, rel, tryCall, volume, type R } from './kernel-lib';

let k: Kernel;
let vortex: number;
beforeAll(async () => {
  k = await loadKernel();
  vortex = importStep(k, 'vortex-cfd-test.step').shapes[0].id;
});

describe('gate 2: Vortex import', () => {
  it('gives 1 solid and 17 faces with the native volume, area and exact bbox (1e-6)', () => {
    const imp = importStep(k, 'vortex-cfd-test.step');
    const ref = REF.vortex.import;
    expect(imp.shapes).toHaveLength(1);
    expect(imp.shapes[0].name).toBe(ref.name);
    expect(imp.faces).toBe(ref.faces);
    expect(imp.edges).toBe(ref.edges);
    const p = call(k, 'props', { id: imp.shapes[0].id, volume: true, area: true, bbox: 'exact' });
    expect(p).toMatchObject({ faces: 17, edges: 34, vertices: 18, solids: 1 });
    expect(rel(p.volume, ref.volume)).toBeLessThan(1e-6);
    expect(rel(p.area, ref.area)).toBeLessThan(1e-6);
    const size = Math.max(...[0, 1, 2].map((i) => ref.bbox_exact[i + 3] - ref.bbox_exact[i]));
    for (let i = 0; i < 6; i++) expect(Math.abs(p.bbox[i] - ref.bbox_exact[i]) / size).toBeLessThan(1e-6);
    expect(call(k, 'check', { id: imp.shapes[0].id }).valid).toBe(true);
    const t = call(k, 'tessellate', { id: imp.shapes[0].id });
    const b = k.takeBuffers(t as never);
    expect(t.faces_without_triangles).toBe(0);
    expect(b.face_ranges.length).toBe(2 * 17);
    expect(b.edge_ranges.length).toBe(2 * 34);
    call(k, 'release', { ids: imp.shapes.map((s: R) => s.id) });
  });
});

describe('gate 3: booleans on the import', () => {
  it('box minus Vortex = the external fluid volume (native and V_box - V_vortex, 1e-6), valid', () => {
    const fb = REF.fluid_box;
    const box = call(k, 'box', { origin: fb.origin, dx: fb.dx, dy: fb.dy, dz: fb.dz });
    const cut = call(k, 'boolean', { op: 'cut', targets: [box.id], tools: [vortex] });
    expect(cut.valid).toBe(true);
    expect(cut.solids).toBe(1);
    const p = call(k, 'props', { id: cut.id, volume: true });
    expect(p.faces).toBe(REF.cut_fluid.faces);
    expect(rel(p.volume, REF.cut_fluid.volume)).toBeLessThan(1e-6);
    expect(rel(p.volume, fb.V_box_native - REF.vortex.import.volume)).toBeLessThan(1e-6);
  });

  it('box common Vortex = V_vortex (1e-6), valid, 16 faces after unify', () => {
    const fb = REF.fluid_box;
    const box = call(k, 'box', { origin: fb.origin, dx: fb.dx, dy: fb.dy, dz: fb.dz });
    const com = call(k, 'boolean', { op: 'common', targets: [box.id], tools: [vortex] });
    expect(com.valid).toBe(true);
    const p = call(k, 'props', { id: com.id, volume: true });
    expect(p.faces).toBe(REF.common_fluid.faces);
    expect(rel(p.volume, REF.vortex.import.volume)).toBeLessThan(1e-6);
  });

  it('Vortex fuse the side box = native (1e-6), valid', () => {
    const b = REF.fuse_box_side.box;
    const box = call(k, 'box', { origin: b.origin, dx: b.dx, dy: b.dy, dz: b.dz });
    const fuse = call(k, 'boolean', { op: 'fuse', targets: [vortex], tools: [box.id] });
    expect(fuse.valid).toBe(true);
    const p = call(k, 'props', { id: fuse.id, volume: true });
    expect(p.faces).toBe(REF.fuse_box_side.faces);
    expect(rel(p.volume, REF.fuse_box_side.volume)).toBeLessThan(1e-6);
  });

  it('the fluid body survives a STEP round trip (AP214 out, re-import in the kernel)', () => {
    const fb = REF.fluid_box;
    const box = call(k, 'box', { origin: fb.origin, dx: fb.dx, dy: fb.dy, dz: fb.dz });
    const cut = call(k, 'boolean', { op: 'cut', targets: [box.id], tools: [vortex] });
    const out = call(k, 'export_step', { shapes: [{ id: cut.id, name: 'Fluid' }], schema: 'AP214' });
    const step = k.takeBuffers(out as never).step as Uint8Array;
    expect(new TextDecoder().decode(step.subarray(0, 13))).toBe('ISO-10303-21;');
    const again = call(k, 'import_step', { ...k.putBytes(step), name: 'fluid.step' });
    expect(again.shapes).toHaveLength(1);
    expect(again.faces).toBe(REF.step_roundtrip_cut.reimport_faces);
    const v = volume(k, again.shapes[0].id);
    expect(rel(v, volume(k, cut.id))).toBeLessThan(1e-9);
    // Native OCCT re-imported its own export of the same body at this volume.
    expect(rel(v, REF.step_roundtrip_cut.reimport_volume_xcaf_healed)).toBeLessThan(1e-6);
  });
});

describe('gate 4: fillet all 12 edges of a 20 mm box (r = 2)', () => {
  it('is valid and matches the analytic volume', () => {
    const imp = importStep(k, 'box20.step');
    const id = imp.shapes[0].id;
    const f = call(k, 'fillet', { id, edges: [...Array(12).keys()], r: 2 });
    expect(f.valid).toBe(true);
    const p = call(k, 'props', { id: f.id, volume: true });
    expect(p.faces).toBe(REF.box20.fillet_all_edges.faces);
    expect(rel(p.volume, REF.box20.fillet_all_edges.volume_analytic)).toBeLessThan(1e-9);
  });
});

describe('gate 5: defeature the flange holes', () => {
  it('removes the 4 hole faces and grows the volume by 4 pi r^2 t', () => {
    const imp = importStep(k, 'flange.step');
    const id = imp.shapes[0].id;
    const t = call(k, 'topo', { id, face_bbox: 'none' });
    const holes = t.faces.filter((f: R) => f.type === 'cylinder' && Math.abs(f.radius - REF.flange.r_hole) < 1e-9).map((f: R) => f.i);
    expect(holes).toHaveLength(4);
    const v0 = volume(k, id);
    const d = call(k, 'defeature', { id, faces: holes });
    expect(d.valid).toBe(true);
    const p = call(k, 'props', { id: d.id, volume: true });
    expect(p.faces).toBe(REF.flange.defeature.faces);
    const growth = p.volume - v0;
    expect(rel(growth, 4 * Math.PI * REF.flange.r_hole ** 2 * REF.flange.t)).toBeLessThan(1e-9);
  });
});

describe('gate 7: naming mini-gate', () => {
  // The resolver the naming layer will use: an edge is named by the two faces it
  // lies between, and faces are named by the extrude history (side:<seg>, start, end).
  const facesOf = (ext: R) => {
    const m = new Map<string, number>();
    for (const [seg, fi] of Object.entries(ext.history.sides as Record<string, number>)) m.set(`side:${seg}`, fi);
    m.set('start', ext.history.start);
    m.set('end', ext.history.end);
    return m;
  };
  const resolve = (ext: R, a: string, b: string) => {
    const m = facesOf(ext);
    const fa = m.get(a);
    const fb = m.get(b);
    if (fa == null || fb == null) throw new Error(`Edge not found after rebuild: F:ext:${a} & F:ext:${b}`);
    const t = call(k, 'topo', { id: ext.id, faces: 'none', vertices: 'none' });
    const hits = t.edges.filter((e: R) => e.faces.length === 2 && e.faces.includes(fa) && e.faces.includes(fb));
    if (hits.length !== 1) throw new Error(`Edge not found after rebuild: F:ext:${a} & F:ext:${b}`);
    return hits[0];
  };

  it('fillets the same logical edge after the width changes, and a trim fails loudly', () => {
    for (const w of ['width_40', 'width_50'] as const) {
      const ref = REF.naming[w];
      const ext = call(k, 'extrude', { profile: ref.profile, extent: ref.extent });
      expect(ext.valid).toBe(true);
      expect(ext.history).toMatchObject(ref.history);
      const e = resolve(ext, 'side:s1', 'start');
      expect(e.length).toBeCloseTo(ref.target_edge.length, 9);
      for (let i = 0; i < 3; i++) expect(e.mid[i]).toBeCloseTo(ref.target_edge.mid[i], 9);
      const f = call(k, 'fillet', { id: ext.id, edges: [e.i], r: ref.fillet.r });
      expect(f.valid).toBe(true);
      expect(rel(volume(k, f.id), ref.fillet.volume)).toBeLessThan(1e-9);
    }
    // A trim that removes s1: the name cannot resolve, and says so.
    const trimmed = {
      plane: REF.naming.width_40.profile.plane,
      loops: [
        [
          { id: 's2', kind: 'line', a: [40, 0], b: [40, 20] },
          { id: 's3', kind: 'line', a: [40, 20], b: [0, 20] },
          { id: 's5', kind: 'line', a: [0, 20], b: [40, 0] },
        ],
      ],
    };
    const ext = call(k, 'extrude', { profile: trimmed, extent: { kind: 'blind', d: 10 } });
    expect(() => resolve(ext, 'side:s1', 'start')).toThrow(/Edge not found/);
  });

  it('reports bad inputs as input errors, never a trap', () => {
    expect(tryCall(k, 'extrude', { profile: rect(0, 0, 0, 10), extent: { kind: 'blind', d: 1 } })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'fillet', { id: vortex, edges: [999], r: 1 })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'boolean', { op: 'xor', targets: [vortex], tools: [vortex] })).toMatchObject({ ok: false, kind: 'input' });
    expect(k.dead).toBeNull();
  });
});
