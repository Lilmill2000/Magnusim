// @vitest-environment node
// Kernel API 3 (docs/p2p3-plan.md §2.4-2.7): press_pull, split pieces' face counts,
// combine (join / cut / intersect, several targets and tools) and measure, against
// analytic values and the native references (fixtures/kernel/reference.json). Every
// result honours `valid` and runs on work copies.
// Owner: KERNEL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeAll, describe, expect, it } from 'vitest';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import { call, fingerprint, HAVE_VORTEX, importStep, importVortex, itVortex, loadKernel, REF, rel, tryCall, volume, type R } from './kernel-lib';

let k: Kernel;
let vortex: number;
let V0: number;
beforeAll(async () => {
  k = await loadKernel();
  if (HAVE_VORTEX) {
    vortex = importVortex(k).shapes[0].id;
    V0 = volume(k, vortex);
  }
});

const faceWhere = (id: number, test: (f: R) => boolean): number => {
  const f = call(k, 'topo', { id, edges: 'none', vertices: 'none' }).faces.find(test);
  if (!f) throw new Error('face not found');
  return f.i;
};
const centroid = (id: number, face: number): number[] => call(k, 'topo', { id, faces: [face], edges: 'none', vertices: 'none' }).faces[0].centroid;
const box20 = () => call(k, 'box', { dx: 20, dy: 20, dz: 20 }).id as number;
const topOf = (id: number) => faceWhere(id, (f) => f.type === 'plane' && f.normal[2] > 0.5);

describe('press_pull (API 3)', () => {
  it('box top face +5 -> 20 x 20 x 25, -5 -> 20 x 20 x 15; the moved face keeps its input in the history', () => {
    const box = box20();
    const top = topOf(box);
    const before = fingerprint(k, box);
    for (const [d, v] of [
      [5, 10000],
      [-5, 6000],
    ]) {
      const p = call(k, 'press_pull', { id: box, faces: [top], d });
      expect(p).toMatchObject({ valid: true, op: d > 0 ? 'fuse' : 'cut', empty: false, solids: 1, faces: 6, unified: true });
      expect(rel(volume(k, p.id), v)).toBeLessThan(1e-12);
      // The moved face is where the top face now lies, d further along +Z.
      expect(p.moved).toHaveLength(1);
      const c = centroid(p.id, p.moved[0]);
      expect(c[2]).toBeCloseTo(20 + d, 9);
      const entry = p.history.faces.find((f: R) => f.out === p.moved[0]);
      expect(entry.from).toContainEqual({ shape: box, face: top, how: 'modified' });
      expect(p.history.deleted.some((x: R) => x.face === top)).toBe(false);
      // Perpendicular neighbours just grow or shrink: no side face of its own.
      expect(p.sides).toEqual({});
    }
    expect(fingerprint(k, box)).toEqual(before);
  });

  it('flange top +10 doubles it (the prism keeps the holes); after deleting the holes it is 200,000', () => {
    const flange = importStep(k, 'flange.step').shapes[0].id;
    const top = topOf(flange);
    const p = call(k, 'press_pull', { id: flange, faces: [top], d: 10 });
    expect(p.valid).toBe(true);
    expect(rel(volume(k, p.id), 2 * REF.flange.import.volume)).toBeLessThan(1e-9);
    const holes = call(k, 'topo', { id: flange, edges: 'none', vertices: 'none' }).faces.filter((f: R) => f.type === 'cylinder').map((f: R) => f.i);
    const solid = call(k, 'defeature', { id: flange, faces: holes });
    const q = call(k, 'press_pull', { id: solid.id, faces: [topOf(solid.id)], d: 10 });
    expect(q).toMatchObject({ valid: true, faces: 6 });
    expect(rel(volume(k, q.id), 200000)).toBeLessThan(1e-12);
    const bb = call(k, 'props', { id: q.id, bbox: 'exact' }).bbox;
    expect(bb[5] - bb[2]).toBeCloseTo(20, 9);
  });

  it('a slanted neighbour is not extended: the side is a face of its own, generated from the edge', () => {
    // A wedge: its top face meets the slope at an angle, so the prism side stays a new face.
    const tan = Math.tan(Math.PI / 6);
    const prof = {
      plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] },
      loops: [[
        { id: 's1', kind: 'line', a: [0, 0], b: [20, 0] },
        { id: 's2', kind: 'line', a: [20, 0], b: [20, 10 + 20 * tan] },
        { id: 's3', kind: 'line', a: [20, 10 + 20 * tan], b: [0, 10] },
        { id: 's4', kind: 'line', a: [0, 10], b: [0, 0] },
      ]],
    };
    const w = call(k, 'extrude', { profile: prof, extent: { kind: 'blind', d: 10 } });
    const left = w.history.sides.s4; // the x = 0 face, normal -X
    const p = call(k, 'press_pull', { id: w.id, faces: [left], d: 5 });
    expect(p.valid).toBe(true);
    // + the 5 mm block in front of the 10 x 10 face.
    expect(rel(volume(k, p.id) - volume(k, w.id), 5 * 10 * 10)).toBeLessThan(1e-9);
    const keys = Object.keys(p.sides);
    expect(keys.length).toBe(1);
    const [faceKey, edgeKey] = keys[0].split(':').map(Number);
    expect(faceKey).toBe(left);
    const side = p.sides[keys[0]];
    expect(p.history.faces.find((f: R) => f.out === side).from).toEqual([{ shape: w.id, edge: edgeKey, how: 'generated' }]);
    const e = call(k, 'topo', { id: w.id, faces: 'none', edges: [edgeKey], vertices: 'none' }).edges[0];
    expect(e.faces).toContain(left);
    expect(e.faces).toContain(w.history.sides.s3);
  });

  itVortex('Vortex inlet cap +50.8 mm extends the inlet pipe: + pi 25.4^2 50.8, valid (native volume)', () => {
    const ref = REF.p2p3.press_pull_vortex.inlet_cap_plus_50_8;
    const cap = faceWhere(vortex, (f) => f.type === 'plane' && f.normal[0] > 0.9);
    expect(centroid(vortex, cap)[0]).toBeCloseTo(127, 9);
    const before = fingerprint(k, vortex);
    const p = call(k, 'press_pull', { id: vortex, faces: [cap], d: 50.8 });
    // Natively UnifySameDomain merges the pipe and the prism side into an invalid face;
    // the kernel keeps them apart instead (unified false), so the body is valid.
    expect(ref.unified.valid).toBe(false);
    expect(p).toMatchObject({ valid: true, unified: false, faces: ref.raw.faces, solids: 1 });
    const v = volume(k, p.id);
    expect(rel(v, ref.raw.volume)).toBeLessThan(1e-12);
    // Analytic within the volume integration's precision on this part (2e-8 of it).
    expect(Math.abs(v - V0 - ref.dv_analytic)).toBeLessThan(2e-8 * V0);
    const c = centroid(p.id, p.moved[0]);
    expect(c[0]).toBeCloseTo(127 + 50.8, 6);
    expect(fingerprint(k, vortex)).toEqual(before);
  });

  itVortex('Vortex bottom face pushed in 10 mm: - area x 10 (native volume), valid', () => {
    const ref = REF.p2p3.press_pull_vortex.bottom_minus_10;
    const bottom = faceWhere(vortex, (f) => f.type === 'plane' && f.normal[2] < -0.5);
    const p = call(k, 'press_pull', { id: vortex, faces: [bottom], d: -10 });
    expect(p).toMatchObject({ valid: true, op: 'cut', unified: true, faces: ref.unified.faces });
    const v = volume(k, p.id);
    expect(rel(v, ref.unified.volume)).toBeLessThan(1e-12);
    expect(Math.abs(v - V0 - ref.dv_expected)).toBeLessThan(2e-8 * V0);
    expect(centroid(p.id, p.moved[0])[2]).toBeCloseTo(-508 + 10, 9);
  });

  itVortex('the Vortex roof pushed down 10 mm fails in OCCT (natively too): the result says invalid, never valid', () => {
    const ref = REF.p2p3.press_pull_vortex.roof_minus_10;
    const roof = faceWhere(vortex, (f) => f.type === 'plane' && f.normal[2] > 0.5 && Math.abs(f.area - ref.area) < 1e-6);
    const p = call(k, 'press_pull', { id: vortex, faces: [roof], d: -10 });
    expect(ref.raw.valid).toBe(false);
    expect(p.valid).toBe(false);
    expect(p.reason).toMatch(/^invalid result \(BRepCheck\)/);
  });

  itVortex('refuses curved faces, a zero distance and a push that removes the whole body', () => {
    const cyl = faceWhere(vortex, (f) => f.type === 'cylinder');
    expect(tryCall(k, 'press_pull', { id: vortex, faces: [cyl], d: 1 })).toMatchObject({ ok: false, kind: 'input', error: `press_pull needs planar faces: face ${cyl} is a cylinder` });
    const box = box20();
    expect(tryCall(k, 'press_pull', { id: box, faces: [topOf(box)], d: 0 })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'press_pull', { id: box, faces: [], d: 1 })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'press_pull', { id: box, faces: [0, 0], d: 1 })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'press_pull', { id: box, faces: [topOf(box)], d: -25 })).toMatchObject({ ok: false, error: 'press-pull would remove the whole body' });
  });

  it('two faces at once', () => {
    const box = box20();
    const xp = faceWhere(box, (f) => f.type === 'plane' && f.normal[0] > 0.5);
    const p = call(k, 'press_pull', { id: box, faces: [topOf(box), xp], d: 5 });
    expect(p.valid).toBe(true);
    expect(p.moved).toHaveLength(2);
    expect(rel(volume(k, p.id), 8000 + 2 * 400 * 5)).toBeLessThan(1e-12);
  });
});

describe('split (API 3: faces per piece)', () => {
  itVortex('Vortex by the Top plane z = 0: 2 pieces whose volumes sum to the whole within 1e-9', () => {
    const s = call(k, 'split', { id: vortex, plane: { origin: [0, 0, 0], normal: [0, 0, 1] } });
    expect(s.valid).toBe(true);
    expect(s.lost_faces).toBe(0);
    expect(s.ids).toHaveLength(2);
    expect(s.faces).toEqual(s.ids.map((id: number) => call(k, 'props', { id, bbox: 'none' }).faces));
    // The default volume integration is off by ~1.5e-7 on this part's B-spline faces
    // (natively too: the default sum differs by 1.59e-8); integrated to 1e-9 the sum holds.
    const precise = (id: number) => call(k, 'props', { id, volume: true, volume_eps: 1e-9, bbox: 'none' });
    const whole = precise(vortex);
    expect(whole.volume_error).toBeGreaterThanOrEqual(0);
    const sum = s.ids.reduce((a: number, id: number) => a + precise(id).volume, 0);
    expect(rel(sum, whole.volume)).toBeLessThan(1e-9);
    const sumDefault = s.ids.reduce((a: number, id: number) => a + volume(k, id), 0);
    expect(rel(sumDefault, V0)).toBeLessThan(2e-8);
  });

  it('by a tool body: pieces largest first, each with its face count; the tool is unchanged', () => {
    const box = box20();
    const tool = call(k, 'cylinder', { origin: [10, 10, -5], r: 5, h: 30 }).id;
    const before = fingerprint(k, tool);
    const s = call(k, 'split', { id: box, tool });
    expect(s.valid).toBe(true);
    expect(s.lost_faces).toBe(0);
    expect(s.ids).toHaveLength(2);
    const vols = s.ids.map((id: number) => volume(k, id));
    expect(rel(vols[0], 8000 - Math.PI * 25 * 20)).toBeLessThan(1e-12);
    expect(rel(vols[1], Math.PI * 25 * 20)).toBeLessThan(1e-12);
    expect(s.faces).toEqual([7, 3]);
    expect(fingerprint(k, tool)).toEqual(before);
  });
});

describe('combine (API 3)', () => {
  const fb = REF.fluid_box;
  const fluidBox = () => call(k, 'box', { origin: fb.origin, dx: fb.dx, dy: fb.dy, dz: fb.dz }).id as number;

  itVortex('Vortex fluid domain: box with a 100 mm margin cut by Vortex = 213,286,252.06 mm³ (native), 22 faces', () => {
    const box = fluidBox();
    const before = fingerprint(k, vortex);
    const r = call(k, 'combine', { op: 'cut', targets: [box], tools: [vortex] });
    expect(r.results).toHaveLength(1);
    const c = r.results[0];
    expect(c).toMatchObject({ target: box, empty: false, solids: REF.cut_fluid.solids, faces: REF.cut_fluid.faces, valid: true, unified: true });
    expect(rel(volume(k, c.id), REF.cut_fluid.volume)).toBeLessThan(1e-6);
    // Keep tools: the tool is unchanged, so the document may keep it or not.
    expect(fingerprint(k, vortex)).toEqual(before);
    expect(c.history.faces.some((f: R) => f.from.some((s: R) => s.shape === vortex))).toBe(true);
    expect(c.history.faces.some((f: R) => f.from.some((s: R) => s.shape === box))).toBe(true);
  });

  itVortex('intersect = 44,798,524.14 mm³ and join with the side box = 49,269,787.87 mm³ (native)', () => {
    const com = call(k, 'combine', { op: 'intersect', targets: [fluidBox()], tools: [vortex] }).results[0];
    expect(com).toMatchObject({ valid: true, faces: REF.common_fluid.faces });
    expect(rel(volume(k, com.id), REF.common_fluid.volume)).toBeLessThan(1e-6);
    const b = REF.fuse_box_side.box;
    const side = call(k, 'box', { origin: b.origin, dx: b.dx, dy: b.dy, dz: b.dz }).id;
    const join = call(k, 'combine', { op: 'join', targets: [vortex], tools: [side] }).results[0];
    expect(join).toMatchObject({ target: vortex, valid: true, faces: REF.fuse_box_side.faces, solids: 1 });
    expect(rel(volume(k, join.id), REF.fuse_box_side.volume)).toBeLessThan(1e-6);
  });

  it('2 targets + 1 tool: one result per target (analytic); keep tools on and off', () => {
    const a = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id;
    const b = call(k, 'box', { origin: [20, 0, 0], dx: 10, dy: 10, dz: 10 }).id;
    const t = call(k, 'box', { origin: [5, 0, 5], dx: 20, dy: 10, dz: 10 }).id;
    const tool = fingerprint(k, t);
    const cut = call(k, 'combine', { op: 'cut', targets: [a, b], tools: [t] });
    expect(cut.results.map((x: R) => x.target)).toEqual([a, b]);
    for (const x of cut.results) {
      expect(x).toMatchObject({ valid: true, empty: false, solids: 1, faces: 8 });
      expect(rel(volume(k, x.id), 1000 - 5 * 10 * 5)).toBeLessThan(1e-12);
    }
    // Keep tools on: the tool body is untouched and still usable.
    expect(fingerprint(k, t)).toEqual(tool);
    const com = call(k, 'combine', { op: 'intersect', targets: [a, b], tools: [t] });
    for (const x of com.results) expect(rel(volume(k, x.id), 5 * 10 * 5)).toBeLessThan(1e-12);
    // Keep tools off: the document releases the tool; the results do not depend on it.
    call(k, 'release', { ids: [t] });
    for (const x of cut.results) expect(call(k, 'check', { id: x.id }).valid).toBe(true);
    expect(rel(volume(k, cut.results[0].id), 750)).toBeLessThan(1e-12);
  });

  it('join of 3 boxes is one solid; intersect with overlapping tools uses their union; a cut can leave nothing', () => {
    const a = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id;
    const b = call(k, 'box', { origin: [20, 0, 0], dx: 10, dy: 10, dz: 10 }).id;
    const t = call(k, 'box', { origin: [5, 0, 5], dx: 20, dy: 10, dz: 10 }).id;
    const join = call(k, 'combine', { op: 'join', targets: [a, b], tools: [t] });
    expect(join.results).toHaveLength(1);
    expect(join.results[0]).toMatchObject({ target: a, solids: 1, valid: true });
    expect(rel(volume(k, join.results[0].id), 1000 + 1000 + 2000 - 250 - 250)).toBeLessThan(1e-12);
    const onlyTargets = call(k, 'combine', { op: 'join', targets: [a, t] });
    expect(rel(volume(k, onlyTargets.results[0].id), 1000 + 2000 - 250)).toBeLessThan(1e-12);
    const c1 = call(k, 'box', { dx: 6, dy: 10, dz: 10 }).id;
    const c2 = call(k, 'box', { origin: [4, 0, 0], dx: 6, dy: 10, dz: 10 }).id;
    const mid = call(k, 'box', { origin: [2, 0, 0], dx: 6, dy: 10, dz: 10 }).id;
    const inter = call(k, 'combine', { op: 'intersect', targets: [mid], tools: [c1, c2] }).results[0];
    expect(rel(volume(k, inter.id), 600)).toBeLessThan(1e-12);
    const gone = call(k, 'combine', { op: 'cut', targets: [a], tools: [c1, c2] }).results[0];
    expect(gone).toMatchObject({ empty: true, solids: 0, faces: 0 });
  });

  itVortex('an invalid result is reported, never passed off (the P0 top-centre fuse)', () => {
    const tb = REF.fuse_box200_topcentre.box;
    const box = call(k, 'box', { origin: tb.origin, dx: tb.dx, dy: tb.dy, dz: tb.dz }).id;
    const r = call(k, 'combine', { op: 'join', targets: [vortex], tools: [box] }).results[0];
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/NotClosed|UnorientableShape/);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('validation is an input error', () => {
    const a = call(k, 'box', { dx: 1, dy: 1, dz: 1 }).id;
    const b = call(k, 'box', { dx: 2, dy: 2, dz: 2 }).id;
    expect(tryCall(k, 'combine', { op: 'cut', targets: [a], tools: [] })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'combine', { op: 'cut', targets: [], tools: [b] })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'combine', { op: 'cut', targets: [a], tools: [a] })).toMatchObject({ ok: false, kind: 'input', error: `a body cannot be a target and a tool (${a})` });
    expect(tryCall(k, 'combine', { op: 'join', targets: [a] })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'combine', { op: 'xor', targets: [a], tools: [b] })).toMatchObject({ ok: false, kind: 'input' });
  });
});

describe('measure (API 3): analytic answers', () => {
  const m = (a: R, b?: R) => call(k, 'measure', b ? { a, b } : { a });

  it('box: parallel faces 20, face to edge 20, opposite corners sqrt(3) 20', () => {
    const box = box20();
    const t = call(k, 'topo', { id: box });
    const bottom = t.faces.find((f: R) => f.normal[2] < -0.5).i;
    const top = t.faces.find((f: R) => f.normal[2] > 0.5).i;
    const left = t.faces.find((f: R) => f.normal[0] < -0.5).i;
    const far = t.edges.find((e: R) => Math.abs(e.mid[0] - 20) < 1e-9 && Math.abs(e.mid[2] - 20) < 1e-9).i;
    const v0 = t.vertices.find((v: R) => v.p.every((c: number) => Math.abs(c) < 1e-9)).i;
    const v1 = t.vertices.find((v: R) => v.p.every((c: number) => Math.abs(c - 20) < 1e-9)).i;
    const ff = m({ id: box, face: bottom }, { id: box, face: top });
    expect(ff.distance).toBeCloseTo(20, 12);
    expect(ff).toMatchObject({ angle_deg: 0, parallel: true });
    expect(ff.delta[2]).toBeCloseTo(20, 12);
    expect(ff.a).toMatchObject({ kind: 'face', type: 'plane', dir: [0, 0, -1] });
    expect(ff.a.area).toBeCloseTo(400, 9);
    expect(m({ id: box, face: left }, { id: box, edge: far }).distance).toBeCloseTo(20, 12);
    expect(m({ id: box, vertex: v0 }, { id: box, vertex: v1 }).distance).toBeCloseTo(Math.sqrt(3) * 20, 12);
    const body = m({ id: box });
    expect(body.a).toMatchObject({ kind: 'body', center: [10, 10, 10] });
    expect(body.a.volume).toBeCloseTo(8000, 9);
    const pb = m({ point: [30, 10, 10] }, { id: box });
    expect(pb.distance).toBeCloseTo(10, 12);
    // With a second target a body is only its geometry (no volume integration).
    expect(pb.b).toEqual({ kind: 'body' });
  });

  it('angle between a box face and a 30 degree wedge face is 30', () => {
    const tan = Math.tan(Math.PI / 6);
    const prof = { plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] }, loops: [[
      { id: 's1', kind: 'line', a: [0, 0], b: [20, 0] }, { id: 's2', kind: 'line', a: [20, 0], b: [20, 20 * tan] }, { id: 's3', kind: 'line', a: [20, 20 * tan], b: [0, 0] }]] };
    const w = call(k, 'extrude', { profile: prof, extent: { kind: 'blind', d: 10 } });
    const box = box20();
    const r = m({ id: box, face: topOf(box) }, { id: w.id, face: w.history.sides.s3 });
    expect(r.angle_deg).toBeCloseTo(30, 10);
    expect(r.parallel).toBe(false);
    // A line against a plane: the top edge of the box lies in the top plane (0).
    const edge = call(k, 'topo', { id: box, faces: 'none', vertices: 'none' }).edges.find((e: R) => e.type === 'line' && Math.abs(e.mid[2] - 20) < 1e-9).i;
    expect(m({ id: box, edge }, { plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }).angle_deg).toBeCloseTo(0, 10);
    expect(m({ id: box, edge }, { plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }).distance).toBeCloseTo(20, 9);
  });

  it('cylinder radius 10; two parallel cylinders 30 apart centre to centre', () => {
    const c1 = call(k, 'cylinder', { r: 10, h: 5 }).id;
    const c2 = call(k, 'cylinder', { origin: [30, 0, 0], r: 5, h: 5 }).id;
    const f1 = faceWhere(c1, (f) => f.type === 'cylinder');
    const f2 = faceWhere(c2, (f) => f.type === 'cylinder');
    const one = m({ id: c1, face: f1 });
    expect(one.a).toMatchObject({ kind: 'face', type: 'cylinder', radius: 10, dir: [0, 0, 1] });
    expect(one.distance).toBeUndefined();
    const two = m({ id: c1, face: f1 }, { id: c2, face: f2 });
    expect(two.distance).toBeCloseTo(15, 9);
    expect(two.center_distance).toBeCloseTo(30, 12);
    expect(two.parallel).toBe(true);
    const circle = call(k, 'topo', { id: c2, faces: 'none', vertices: 'none' }).edges.find((e: R) => e.type === 'circle').i;
    const ce = m({ id: c2, edge: circle });
    expect(ce.a).toMatchObject({ kind: 'edge', type: 'circle', radius: 5 });
    expect(ce.a.length).toBeCloseTo(10 * Math.PI, 9);
  });

  itVortex('Vortex outlet disk area pi 25.4^2', () => {
    const outlet = faceWhere(vortex, (f) => f.type === 'plane' && f.normal[2] > 0.5 && Math.abs(f.centroid[2] - 304.8) < 1e-6 && Math.abs(f.area - Math.PI * 25.4 ** 2) < 1);
    const r = m({ id: vortex, face: outlet });
    expect(rel(r.a.area, Math.PI * 25.4 ** 2)).toBeLessThan(1e-9);
  });

  itVortex('origin planes and axes', () => {
    const pp = m({ plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }, { plane: { origin: [0, 0, 5], normal: [0, 0, -1] } });
    expect(pp).toMatchObject({ distance: 5, angle_deg: 0, parallel: true });
    const crossing = m({ plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }, { plane: { origin: [0, 0, 0], normal: [1, 0, 0] } });
    expect(crossing.distance).toBeCloseTo(0, 12);
    expect(crossing.angle_deg).toBeCloseTo(90, 12);
    const skew = m({ axis: { origin: [0, 0, 0], dir: [1, 0, 0] } }, { axis: { origin: [0, 3, 4], dir: [0, 0, 1] } });
    expect(skew.distance).toBeCloseTo(3, 12);
    expect(skew.angle_deg).toBeCloseTo(90, 12);
    const axisPlane = m({ axis: { origin: [0, 0, 7], dir: [1, 0, 0] } }, { plane: { origin: [0, 0, 0], normal: [0, 0, 1] } });
    expect(axisPlane).toMatchObject({ distance: 7, angle_deg: 0, parallel: true });
    expect(tryCall(k, 'measure', { a: { id: vortex, face: 0, edge: 0 } })).toMatchObject({ ok: false, kind: 'input' });
    expect(tryCall(k, 'measure', { a: {} })).toMatchObject({ ok: false, kind: 'input' });
  });
});
