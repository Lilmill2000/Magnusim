// The toy kernel of tests/doc/fake-kernel.ts plus the API 3 ops the sketch and
// extrude features call, scripted per test:
//   sketch_regions   regionsFor(curves) gives the regions (key, entities, area,
//                    sample, triangles in u/v); open ends and dangling too
//   extrude_regions  a toy prism: the selected regions' u/v box on the Top
//                    plane (or the plane's own frame) swept over the extent,
//                    volume = area x length; history with a cap per region and
//                    a side per sub-segment token of the region keys
//   topo             faces of a toy box in OCCT's box order (x-, x+, y-, y+,
//                    z-, z+) with centroids and outward normals
//   repair           the same toy shape, valid
// Records every call (ops()).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelReply } from '../../../src/types/kernel';
import type { BBox, KernelOp, KernelRegion, OpHistory, SketchCurve } from '../../../src/types/kernel-protocol';
import type { PlaneFrame, Vec2, Vec3 } from '../../../src/types/doc';
import { FakeKernel } from '../../doc/fake-kernel';

export interface FakeRegion extends KernelRegion {
  /** Triangles in u/v (each three points). */
  tris: [Vec2, Vec2, Vec2][];
}

export interface FakeRegionsAnswer {
  regions: FakeRegion[];
  open?: { at: Vec2; entity: string; point: string | null }[];
  dangling?: string[];
}

/** A rectangular region [u0,v0]-[u1,v1] with a key and entities (two triangles). */
export function rectRegion(key: string, entities: string[], u0: number, v0: number, u1: number, v1: number): FakeRegion {
  return {
    key,
    loops: [key.split(' ')],
    entities: [...entities].sort(),
    area: (u1 - u0) * (v1 - v0),
    sample: [(u0 + u1) / 2, (v0 + v1) / 2],
    bbox: [u0, v0, u1, v1],
    tris: [
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
      ],
      [
        [u0, v0],
        [u1, v1],
        [u0, v1],
      ],
    ],
  };
}

/** Sub-segment tokens of a key ("+e_1[p:a>p:b] -e_2[...]" -> ["e_1[p:a>p:b]", "e_2[...]"]). */
export function tokensOf(key: string): string[] {
  return key
    .split(' / ')
    .flatMap((loop) => loop.split(' '))
    .map((t) => t.replace(/^[+-]/, ''))
    .filter(Boolean);
}

export class ProfilesFakeKernel extends FakeKernel {
  regionsFor: (curves: SketchCurve[], plane: PlaneFrame) => FakeRegionsAnswer = () => ({ regions: [] });
  /** Whether extrude_regions answers valid (default true). */
  extrudeValid = true;
  /** Without these ops (an API 2 kernel). */
  noApi3 = false;
  /** Shapes made by extrude_regions: their toy box and the params. */
  extrudes: { id: number; params: Record<string, unknown> }[] = [];
  private next = 10_000;

  private store(bbox: BBox, volume: number): number {
    const id = this.next++;
    this.shapes.set(id, { bbox, volume });
    return id;
  }

  override async call<Op extends KernelOp>(op: Op, params: Record<string, unknown> & object, opts: { timeoutMs?: number } = {}): Promise<KernelReply<Op>> {
    const p = params as Record<string, unknown>;
    const reply = (result: Record<string, unknown>, buffers: Record<string, ArrayBuffer> = {}) => ({ result: result as never, buffers, ms: 0, wall_ms: 0, heap_bytes: 0 }) as KernelReply<Op>;
    const unknownOp = () => Object.assign(new Error(`unknown op "${op}"`), { kind: 'input', op });
    if (op === 'sketch_regions' || op === 'extrude_regions' || op === 'topo') {
      this.calls.push({ op, params: p, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
      await Promise.resolve();
      const f = this.script.fail?.(op, p);
      if (f) throw Object.assign(new Error(f.message), { kind: f.kind, op });
    }
    if (op === 'sketch_regions') {
      if (this.noApi3) throw unknownOp();
      const ans = this.regionsFor(p.curves as SketchCurve[], p.plane as PlaneFrame);
      const uv: number[] = [];
      const idx: number[] = [];
      const ranges: number[] = [];
      for (const r of ans.regions) {
        const start = idx.length;
        for (const t of r.tris) for (const q of t) {
          idx.push(uv.length / 2);
          uv.push(q[0], q[1]);
        }
        ranges.push(start, idx.length - start);
      }
      const regions: KernelRegion[] = ans.regions.map(({ tris: _t, ...r }) => r);
      return reply(
        { regions, open: ans.open ?? [], dangling: ans.dangling ?? [], timings: {} },
        { tri_uv: new Float32Array(uv).buffer, tri_idx: new Uint32Array(idx).buffer, tri_ranges: new Uint32Array(ranges).buffer },
      );
    }
    if (op === 'extrude_regions') {
      if (this.noApi3) throw unknownOp();
      const plane = p.plane as PlaneFrame;
      const keys = p.regions as string[];
      const ans = this.regionsFor(p.curves as SketchCurve[], plane);
      const chosen = keys.map((k) => {
        const r = ans.regions.find((x) => x.key === k);
        if (!r) throw Object.assign(new Error(`region not found: ${k}`), { kind: 'input', op });
        return r;
      });
      const ext = p.extent as { kind: string; d?: number; d1?: number; d2?: number };
      let s0 = 0;
      let L = 0;
      if (ext.kind === 'blind') L = ext.d!;
      else if (ext.kind === 'symmetric') {
        L = Math.abs(ext.d!);
        s0 = -L / 2;
      } else if (ext.kind === 'two') {
        L = ext.d1! + ext.d2!;
        s0 = -ext.d2!;
      }
      const sign = p.flip ? -1 : 1;
      const n = plane.normal;
      const area = chosen.reduce((a, r) => a + r.area, 0);
      const [u0, v0, u1, v1] = chosen.reduce<[number, number, number, number]>((b, r) => [Math.min(b[0], r.bbox[0]), Math.min(b[1], r.bbox[1]), Math.max(b[2], r.bbox[2]), Math.max(b[3], r.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
      // The toy box: the u/v box on the plane (Top-like frames), swept along the normal.
      const a = sign * s0;
      const b = sign * (s0 + L);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const o = plane.origin;
      const box: BBox = [o[0] + u0 + n[0] * lo, o[1] + v0 + n[1] * lo, o[2] + n[2] * lo, o[0] + u1 + n[0] * hi, o[1] + v1 + n[1] * hi, o[2] + n[2] * hi];
      if (n[2] !== 0) {
        box[2] = o[2] + lo * n[2];
        box[5] = o[2] + hi * n[2];
        if (box[2] > box[5]) [box[2], box[5]] = [box[5], box[2]];
      }
      const id = this.store(box as BBox, area * Math.abs(L));
      this.extrudes.push({ id, params: p });
      // History: one cap pair per region (merged regions would share theirs), one side per token.
      const faces: OpHistory['faces'] = [];
      const caps: NonNullable<OpHistory['caps']> = {};
      const sides: Record<string, number> = {};
      for (const k of keys) {
        const s = faces.length;
        faces.push({ out: s, from: [{ cap: 'start', how: 'generated' }] }, { out: s + 1, from: [{ cap: 'end', how: 'generated' }] });
        caps[k] = { start: s, end: s + 1 };
      }
      for (const k of keys)
        for (const t of tokensOf(k)) {
          if (t in sides) continue;
          sides[t] = faces.length;
          faces.push({ out: faces.length, from: [{ seg: t, how: 'generated' }] });
        }
      const first = caps[keys[0]];
      const history: OpHistory = { faces, edges: [], deleted: [], sides, caps, start: first.start, end: first.end };
      return reply({ id, valid: this.extrudeValid, ...(this.extrudeValid ? {} : { reason: 'invalid result (BRepCheck): BadOrientationOfSubshape x1' }), faces: faces.length, history, from: s0, to: s0 + L, direction: sign > 0 ? n : n.map((x) => -x), solids: 1 });
    }
    if (op === 'topo') {
      const t = this.shapes.get(Number(p.id));
      if (!t) throw Object.assign(new Error(`unknown shape id ${p.id}`), { kind: 'input', op });
      const [x0, y0, z0, x1, y1, z1] = t.bbox;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const cz = (z0 + z1) / 2;
      const all: { c: Vec3; n: Vec3; area: number }[] = [
        { c: [x0, cy, cz], n: [-1, 0, 0], area: (y1 - y0) * (z1 - z0) },
        { c: [x1, cy, cz], n: [1, 0, 0], area: (y1 - y0) * (z1 - z0) },
        { c: [cx, y0, cz], n: [0, -1, 0], area: (x1 - x0) * (z1 - z0) },
        { c: [cx, y1, cz], n: [0, 1, 0], area: (x1 - x0) * (z1 - z0) },
        { c: [cx, cy, z0], n: [0, 0, -1], area: (x1 - x0) * (y1 - y0) },
        { c: [cx, cy, z1], n: [0, 0, 1], area: (x1 - x0) * (y1 - y0) },
      ];
      const sel = p.faces;
      const pick = sel === 'none' ? [] : Array.isArray(sel) ? (sel as number[]) : all.map((_, i) => i);
      const faces = pick.map((i) => ({ i, type: 'plane' as const, area: all[i].area, centroid: all[i].c, normal: all[i].n, bbox: null }));
      return reply({ faces, edges: [], vertices: [], counts: { faces: 6, edges: 12, vertices: 8 }, timings: {} });
    }
    if (op === 'repair' && !this.script.repair) {
      this.calls.push({ op, params: p });
      const t = this.shapes.get(Number(p.id));
      if (!t) throw Object.assign(new Error(`unknown shape id ${p.id}`), { kind: 'input', op });
      const id = this.store(t.bbox, t.volume);
      return reply({ id, valid: true, fixed: true, faces: 6, history: { faces: Array.from({ length: 6 }, (_, i) => ({ out: i, from: [{ shape: Number(p.id), face: i, how: 'modified' }] })), edges: [], deleted: [] }, before: { faces: 6, edges: 12, vertices: 8 }, after: { faces: 6, edges: 12, vertices: 8 } });
    }
    return super.call(op, params, opts);
  }
}
