// @vitest-environment node
// Kernel API 10 (2026-11-06, GitHub issue 15): boolean and combine say when OCCT answered as if the
// inputs were apart. The report: a 60 x 40 x 20 block with a 5.1054 mm hole (a 1/4-20 tap drill) at
// (15, 0), and a helical groove in the hole's wall (a loft through a 1/4-20 thread's basic profile,
// 60 degree flanks and a P/8 flat, in planes turned round the hole's axis, 16 a turn, 1.27 mm a
// turn, its inner edge 0.0254 mm inside the wall). Ending inside the block (15.3 turns) it cuts
// 86.19 mm3; running out through the bottom face (16.75 turns) OCCT 7.9.3 cut nothing, valid and
// without a warning, with fuzzy 1e-4 and 1e-3 too, and its common was empty and its fuse kept two
// solids. Such a result now answers as_if_apart 'wrong' with words; inputs really apart (or only
// touching) answer 'right'; any other result (an ordinary cut, a fuse of a tool inside its target)
// has no as_if_apart and is the API 9 kernel's answer, byte for byte. Every shape is built here.
// Review round 1: a counterbore flush with the block's top fused onto the groove still answers wrong
// (the piece of its cap in the top is no face of its own; a box flush on the top answers right);
// the groove as one solid of several (beside a box that cuts, as two tools or a two-solid tool;
// a fuse that kept the block as it came) answers wrong naming that solid; ordinary booleans with
// several tools never answer wrong; under glue no right is given; the check keeps to its second
// (apart_late, its time reported).
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { call, loadKernel, type R } from './kernel-lib';
import { poly } from './asi-lib';

const k = await loadKernel();
const api = Number(call(k, 'version').api);
const XY = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };

const vol = (id: number) => call(k, 'props', { id, volume: true, bbox: 'none' }).volume as number;
const release = (...ids: number[]) => void call(k, 'release', { ids });
const box = (dx: number, dy: number, dz: number, origin: number[]) => call(k, 'box', { dx, dy, dz, origin }).id as number;
const cyl = (r: number, h: number, origin: number[]) => call(k, 'cylinder', { r, h, origin, axis: [0, 0, 1] }).id as number;
const boolean = (op: string, target: number, tool: number, extra: R = {}): R => call(k, 'boolean', { op, targets: [target], tools: [tool], ...extra });
/** A result's shape and history (input ids as their role: target, tool), as digests (what "the same answer" compares). */
const digest = (r: R, roles: Record<number, string>): string => {
  const brep = Buffer.from(k.takeBuffers(k.call('brep_write', { ids: [r.id] })).brep as Uint8Array);
  const history = JSON.stringify(r.history, (key, v) => (key === 'shape' && typeof v === 'number' ? (roles[v] ?? v) : v));
  return `${createHash('sha256').update(brep).digest('hex').slice(0, 16)} ${createHash('sha256').update(history).digest('hex').slice(0, 16)}`;
};
/** The answer's fields but timings (and check_ms), for comparing answers. */
const fields = (r: R): R => {
  const { timings: _t, check_ms: _c, history: _h, id: _i, ...rest } = r;
  return rest;
};

// The 1/4-20 thread's basic profile in a 5.1054 mm hole at (15, 0): pitch 1.27, major radius 3.175.
const PITCH = 1.27;
const HOLE_R = 5.1054 / 2;
const R_IN = HOLE_R - 0.0254;
const R_OUT = 6.35 / 2;
const HALF_OUT = PITCH / 16;
const HALF_IN = HALF_OUT + (R_OUT - R_IN) * Math.tan(Math.PI / 6);
const AXIS = [15, 0];

/** The block with its hole (7 faces, 48,000 - pi 2.5527^2 20 mm3). */
function block(): number {
  const b = box(60, 40, 20, [-15, -20, 0]);
  const h = cyl(HOLE_R, 20, [AXIS[0], AXIS[1], 0]);
  const r = boolean('cut', b, h);
  release(b, h);
  return r.id;
}

/** The groove: `turns` turns down from z = 20, a trapezoid every 1/16 turn, lofted (not ruled). */
function groove(turns: number): number {
  const n = Math.round(turns * 16);
  const sections: R[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (turns * i) / n;
    const a = 2 * Math.PI * t;
    const plane = { origin: [AXIS[0], AXIS[1], 20 - PITCH * t], normal: [-Math.sin(a), Math.cos(a), 0], xdir: [Math.cos(a), Math.sin(a), 0] };
    const curves = [
      { id: 'l1', kind: 'line', a: [R_IN, -HALF_IN], b: [R_OUT, -HALF_OUT] },
      { id: 'l2', kind: 'line', a: [R_OUT, -HALF_OUT], b: [R_OUT, HALF_OUT] },
      { id: 'l3', kind: 'line', a: [R_OUT, HALF_OUT], b: [R_IN, HALF_IN] },
      { id: 'l4', kind: 'line', a: [R_IN, HALF_IN], b: [R_IN, -HALF_IN] },
    ];
    sections.push({ plane, curves, regions: [call(k, 'sketch_regions', { plane, curves, tess: false }).regions[0].key] });
  }
  const r = call(k, 'loft_regions', { ruled: false, sections });
  expect(r.valid).toBe(true);
  return r.id;
}

/** The point the words name, and whether it lies where the groove and the block meet. */
function witness(text: string): number[] {
  const m = /at \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\) mm lies inside/.exec(text);
  expect(m, text).not.toBeNull();
  const p = m!.slice(1).map(Number);
  const r = Math.hypot(p[0] - AXIS[0], p[1] - AXIS[1]);
  expect(r).toBeGreaterThan(HOLE_R - 1e-3);
  expect(r).toBeLessThan(R_OUT + 1e-3);
  expect(p[2]).toBeGreaterThan(-1e-3);
  expect(p[2]).toBeLessThan(20 + 1e-3);
  return p;
}

describe('as_if_apart (API 10)', () => {
  it('version answers api 10', () => {
    expect(call(k, 'version')).toMatchObject({ occt: '7.9.3', build: 'wasm32', api: 10 });
  });

  it('issue 15: the groove that runs out through the bottom face. OCCT cuts nothing, its common is empty and its fuse keeps two solids, each valid: each answers as_if_apart wrong, in words that name a point where they overlap', () => {
    expect(api, 'as_if_apart is API 10').toBeGreaterThanOrEqual(10);
    const b = block();
    const g = groove(16.75);
    expect(vol(g)).toBeCloseTo(100.78, 1);
    const before = vol(b);
    for (const extra of [{}, { fuzzy: 1e-4 }, { fuzzy: 1e-3 }]) {
      const cut = boolean('cut', b, g, extra);
      // What OCCT 7.9.3 answers: the block back, valid, nothing removed.
      expect(cut).toMatchObject({ valid: true, empty: false, solids: 1, faces: 7, as_if_apart: 'wrong', warnings: true });
      expect(Math.abs(vol(cut.id) - before)).toBeLessThan(1e-6);
      expect(cut.warning_text).toMatch(/^the cut removed nothing although the tool overlaps the target \(a point of the (tool|target) at \(.+\) mm lies inside the (target|tool)\): OCCT took them for apart and gave the target back unchanged$/);
      witness(cut.warning_text);
      expect(cut.timings.apart_ms).toBeGreaterThanOrEqual(0);
      release(cut.id);
    }
    const common = boolean('common', b, g);
    expect(common).toMatchObject({ empty: true, as_if_apart: 'wrong', warnings: true });
    expect(common.warning_text).toMatch(/^the common is empty although the tool overlaps the target \(.+\): OCCT took them for apart$/);
    witness(common.warning_text);
    const fuse = boolean('fuse', b, g);
    expect(fuse).toMatchObject({ valid: true, solids: 2, as_if_apart: 'wrong', warnings: true });
    expect(fuse.warning_text).toMatch(/^the fuse merged nothing although the tool overlaps the target \(.+\): OCCT took them for apart and kept them as separate solids$/);
    // Combine (the Combine feature's op) runs the same check on each result.
    const comb = call(k, 'combine', { op: 'cut', targets: [b], tools: [g] }).results[0];
    expect(comb).toMatchObject({ target: b, empty: false, as_if_apart: 'wrong' });
    expect(comb.warning_text).toMatch(/^the cut removed nothing although the tool overlaps the target/);
    release(common.id, fuse.id, comb.id, b, g);
  }, 120_000);

  it('the groove that ends inside the block (15.3 turns) cuts 86.19 mm3 as before: no as_if_apart, no warning, no check run', () => {
    const b = block();
    const g = groove(15.3);
    const cut = boolean('cut', b, g);
    expect(cut).toMatchObject({ valid: true, empty: false, solids: 1, faces: 27, warnings: false });
    expect(cut.as_if_apart).toBeUndefined();
    expect(cut.warning_text).toBeUndefined();
    expect(cut.timings.apart_ms).toBeUndefined();
    expect(vol(b) - vol(cut.id)).toBeCloseTo(86.195, 2);
    const comb = call(k, 'combine', { op: 'cut', targets: [b], tools: [g] }).results[0];
    expect(comb.as_if_apart).toBeUndefined();
    release(cut.id, comb.id, b, g);
  }, 120_000);

  it('inputs apart or only touching answer right with no warning: a box away from the block, one on its edge, a pin in its hole (cut, common and fuse)', () => {
    expect(api).toBeGreaterThanOrEqual(10);
    const b = block();
    const tools = { apart: box(5, 5, 5, [100, 0, 0]), edge: box(10, 10, 10, [45, 20, 0]), pin: cyl(2, 30, [AXIS[0], AXIS[1], -5]) };
    for (const [name, t] of Object.entries(tools)) {
      const cut = boolean('cut', b, t);
      expect(cut, name).toMatchObject({ valid: true, empty: false, solids: 1, faces: 7, as_if_apart: 'right', warnings: false });
      expect(cut.warning_text, name).toBeUndefined();
      expect(Math.abs(vol(cut.id) - vol(b)), name).toBeLessThan(1e-6);
      expect(boolean('common', b, t), name).toMatchObject({ empty: true, as_if_apart: 'right', warnings: false });
      expect(boolean('fuse', b, t), name).toMatchObject({ valid: true, solids: 2, as_if_apart: 'right', warnings: false });
    }
  });

  it('a fuse of a tool inside the target, a common of a target inside the tool, a tool enclosing the target and ordinary booleans have no as_if_apart: the same answers as the API 9 kernel, shapes and history byte for byte', () => {
    const b = block();
    const inner = box(4, 4, 4, [0, 0, 5]);
    const big = box(100, 100, 100, [-40, -50, -40]);
    const through = cyl(3, 30, [0, 0, -5]);
    // Digests of brep_write and of the history on the API 9 kernel (51a140f0, mk32.wasm c59b3a0f).
    const want: Record<string, string> = {
      'cut inner': '9f6cf50b955a8c8b e961036215755f3b',
      'common inner': '1f6c6028779288d4 f7241bcd59b43637',
      'fuse inner': '5efc37e99f21f176 12a571c9e7ed9409',
      'cut big': 'e22afeeb8344991e d70e5a250e306b24',
      'common big': '5efc37e99f21f176 12a571c9e7ed9409',
      'fuse big': '8a443a6030460332 6c5edf0d94621b37',
      'cut through': '8945f943f1ca2227 5d96d7b55cf51601',
      'common through': '9dbcfe09930fcfd5 3738c13d9479cc9e',
      'fuse through': 'bd96e7242d2ce4a3 dbe80882d035f77f',
    };
    for (const [name, t] of Object.entries({ inner, big, through }))
      for (const op of ['cut', 'common', 'fuse']) {
        const r = boolean(op, b, t);
        const key = `${op} ${name}`;
        expect(r.as_if_apart, key).toBeUndefined();
        expect(r.warnings, key).toBe(false);
        expect(r.timings.apart_ms, key).toBeUndefined();
        expect(digest(r, { [b]: 'target', [t]: 'tool' }), key).toBe(want[key]);
        expect(Object.keys(fields(r)).sort(), key).toEqual(['empty', 'faces', 'fuzzy', 'glue', 'ok', 'solids', 'valid', 'warnings']);
        release(r.id);
      }
    // A fuse of a tool inside its target changes nothing, and is not flagged.
    const f = boolean('fuse', b, inner);
    expect(f).toMatchObject({ solids: 1, faces: 7 });
    expect(Math.abs(vol(f.id) - vol(b))).toBeLessThan(1e-6);
  });

  it("cost on a 5,000-face prism: an ordinary cut runs no check; a tool apart inside the prism's box, one flush on its top and one touching a vertex answer right, the check a fraction of the boolean", () => {
    expect(api).toBeGreaterThanOrEqual(10);
    const n = 4998;
    const pts = Array.from({ length: n }, (_, i) => [100 * Math.cos((2 * Math.PI * i) / n), 100 * Math.sin((2 * Math.PI * i) / n)]);
    const prism = call(k, 'extrude', { profile: poly(pts, XY), extent: { kind: 'blind', d: 10 }, check: false }).id;
    const through = boolean('cut', prism, cyl(5, 30, [0, 0, -5]), { check: false });
    expect(through.faces).toBe(5001);
    expect(through.as_if_apart).toBeUndefined();
    expect(through.timings.apart_ms).toBeUndefined();
    const rows: string[] = [];
    for (const [name, t, ops] of [
      ['apart in its box', box(5, 5, 5, [90, 90, 2]), ['cut', 'common', 'fuse']],
      ['flush on its top', box(10, 10, 5, [0, 0, 10]), ['common']],
      ['touching a vertex', box(5, 5, 10, [100, -2.5, 0]), ['cut', 'common', 'fuse']],
    ] as const)
      for (const op of ops) {
        const r = boolean(op, prism, t, { check: false });
        expect(r.as_if_apart, `${name} ${op}`).toBe('right');
        rows.push(`${name} ${op}: check ${r.timings.apart_ms.toFixed(0)} ms, boolean ${r.timings.boolean_ms.toFixed(0)} ms`);
        // Generous (the machine may be busy): measured 2026-11-06, 43-230 ms against 730-2,400 ms.
        expect(r.timings.apart_ms, rows.at(-1)).toBeLessThan(r.timings.boolean_ms + r.timings.copy_ms + 500);
        release(r.id);
      }
    console.log(`[as_if_apart cost, 5,000-face prism] ${rows.join('; ')}`);
  }, 120_000);
});

/** Booleans with several targets or tools at once. */
const several = (op: string, targets: number[], tools: number[], extra: R = {}): R => call(k, 'boolean', { op, targets, tools, ...extra });
/** The point the words name lies in the ring round the hole (from its wall to rOut), within the block's height. */
function inRing(text: string, rOut: number): void {
  const m = /at \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\) mm lies inside/.exec(text);
  expect(m, text).not.toBeNull();
  const [x, y, z] = m!.slice(1).map(Number);
  expect(Math.hypot(x - AXIS[0], y - AXIS[1])).toBeGreaterThan(HOLE_R - 1e-3);
  expect(Math.hypot(x - AXIS[0], y - AXIS[1])).toBeLessThan(rOut + 1e-3);
  expect(z).toBeGreaterThan(-1e-3);
  expect(z).toBeLessThan(20 + 1e-3);
}

describe('as_if_apart, review round 1', () => {
  it("a counterbore flush with the block's top fused onto the groove (one tool): its cut and common answer wrong (the piece of the tool's cap in the block's top is no face the tool made); a box flush on the top answers right; the counterbore alone still cuts", () => {
    expect(api).toBeGreaterThanOrEqual(10);
    const b = block();
    const before = vol(b);
    const tool = boolean('fuse', groove(16.75), cyl(3.5, 2, [AXIS[0], AXIS[1], 18]));
    expect(tool).toMatchObject({ valid: true, solids: 1 });
    const cut = boolean('cut', b, tool.id);
    expect(cut).toMatchObject({ valid: true, empty: false, solids: 1, faces: 7, as_if_apart: 'wrong', warnings: true });
    expect(Math.abs(vol(cut.id) - before)).toBeLessThan(1e-6);
    expect(cut.warning_text).toMatch(/^the cut removed nothing although the tool overlaps the target \(.+\): OCCT took them for apart and gave the target back unchanged$/);
    inRing(cut.warning_text, 3.5);
    expect(boolean('common', b, tool.id)).toMatchObject({ empty: true, as_if_apart: 'wrong', warnings: true });
    // A box on the top (only touching): the piece it shares with the top is no face of its own either.
    const flush = box(10, 10, 5, [-10, -10, 20]);
    for (const op of ['cut', 'common']) expect(boolean(op, b, flush), op).toMatchObject({ as_if_apart: 'right', warnings: false });
    const alone = boolean('cut', b, cyl(3.5, 2, [AXIS[0], AXIS[1], 18]));
    expect(alone.as_if_apart).toBeUndefined();
    expect(before - vol(alone.id)).toBeCloseTo(Math.PI * (3.5 ** 2 - HOLE_R ** 2) * 2, 4);
  }, 120_000);

  it('one solid of several: the groove beside a box that cuts the top (two tools, or a two-solid tool) or beside an inner box answers wrong for cut, common and fuse, naming that solid; the box is cut as it was; Combine says the same', () => {
    expect(api).toBeGreaterThanOrEqual(10);
    const b = block();
    const g = groove(16.75);
    const before = vol(b);
    const top = box(4, 4, 4, [-10, -2, 18]);
    const inner = box(4, 4, 4, [-10, -2, 8]);
    const two = boolean('fuse', g, top);
    expect(two.solids).toBe(2);
    for (const [name, tools, removed, who] of [
      ['two tools', [g, top], 32, 'tool 1'],
      ['a two-solid tool', [two.id], 32, 'solid \\d of the tool'],
      ['beside an inner box', [g, inner], 64, 'tool 1'],
    ] as const) {
      const cut = several('cut', [b], [...tools]);
      expect(cut, name).toMatchObject({ valid: true, empty: false, solids: 1, as_if_apart: 'wrong', warnings: true });
      expect(before - vol(cut.id), name).toBeCloseTo(removed, 6);
      expect(cut.warning_text).toMatch(new RegExp(`^the cut removed nothing where ${who} overlaps the target \\(a point of (${who}|the target) at \\(.+\\) mm lies inside (the target|${who})\\): OCCT took them for apart and left that part uncut$`));
      witness(cut.warning_text);
      const common = several('common', [b], [...tools]);
      expect(common, name).toMatchObject({ empty: false, as_if_apart: 'wrong', warnings: true });
      expect(common.warning_text).toMatch(new RegExp(`^the common left out where ${who} overlaps the target \\(.+\\): OCCT took them for apart$`));
      witness(common.warning_text);
      const fuse = several('fuse', [b], [...tools]);
      expect(fuse, name).toMatchObject({ solids: 2, as_if_apart: 'wrong', warnings: true });
      expect(fuse.warning_text).toMatch(/^the fuse kept (the target|tool 1|solid \d of the tool) as a separate solid although it overlaps another input \(.+\): OCCT took them for apart$/);
      witness(fuse.warning_text);
      release(cut.id, common.id, fuse.id);
    }
    for (const op of ['cut', 'intersect', 'join']) expect(call(k, 'combine', { op, targets: [b], tools: [g, top] }).results[0].as_if_apart, op).toBe('wrong');
  }, 120_000);

  it('a fuse that kept the block as it came beside a block under it that the groove runs into (a Join over the two): wrong, naming the target', () => {
    expect(api).toBeGreaterThanOrEqual(10);
    const fuse = several('fuse', [block()], [groove(16.75), box(6, 6, 2.7, [12, -3, -3])]);
    expect(fuse).toMatchObject({ valid: true, solids: 2, as_if_apart: 'wrong', warnings: true });
    expect(fuse.warning_text).toMatch(/^the fuse kept the target as a separate solid although it overlaps another input \(a point of (the target|another input) at \(.+\) mm lies inside (another input|the target)\): OCCT took them for apart$/);
    witness(fuse.warning_text);
  }, 120_000);

  it('booleans with several tools or solids that OCCT gets right never answer wrong: overlapping pins, a pin in a bigger pin, a box in a pocket, the same pin twice, tools flush with each other, a pocket from the top, a box flush on top, a two-solid tool with a solid apart, twelve overlapping pins, three tools of which one is apart, a box inside and one apart', () => {
    const plate = () => box(40, 40, 10, [0, 0, 0]);
    const cases: [string, () => number[]][] = [
      ['two overlapping pins', () => [cyl(3, 20, [10, 10, -5]), cyl(3, 20, [14, 10, -5])]],
      ['a pin inside a bigger pin', () => [cyl(5, 20, [10, 10, -5]), cyl(1, 8, [10, 10, 1])]],
      ['a box inside a pocket in the material', () => [box(10, 10, 4, [5, 5, 3]), box(2, 2, 2, [8, 8, 4])]],
      ['the same pin twice', () => [cyl(3, 20, [10, 10, -5]), cyl(3, 20, [10, 10, -5])]],
      ['two tools flush with each other', () => [box(5, 10, 20, [5, 5, -5]), box(5, 10, 20, [10, 5, -5])]],
      ['a pocket from the top face and a pin', () => [box(10, 10, 5, [5, 5, 5]), cyl(2, 20, [30, 30, -5])]],
      ['a box flush on top and a pin', () => [box(10, 10, 5, [5, 5, 10]), cyl(2, 20, [30, 30, -5])]],
      ['a two-solid tool: a pin and a sphere apart', () => [boolean('fuse', cyl(2, 20, [30, 30, -5]), call(k, 'sphere', { r: 2, center: [20, 20, 30] }).id).id]],
      ['twelve overlapping pins', () => Array.from({ length: 12 }, (_, i) => cyl(2, 20, [5 + 2.5 * i, 20, -5]))],
      ['three tools: one overlapping, one apart, one flush on top', () => [box(10, 10, 10, [35, 35, 5]), box(5, 5, 5, [100, 0, 0]), box(10, 10, 10, [0, 0, 10])]],
      ['a box inside and one apart', () => [box(4, 4, 4, [5, 5, 3]), box(5, 5, 5, [100, 0, 0])]],
    ];
    for (const [name, tools] of cases)
      for (const op of ['cut', 'common', 'fuse']) {
        const r = several(op, [plate()], tools());
        expect(r.as_if_apart, `${name} ${op}: ${r.warning_text}`).not.toBe('wrong');
        expect(r.warnings, `${name} ${op}`).toBe(false);
        release(r.id);
      }
  }, 120_000);

  it("under glue (shift, full) OCCT does not split every crossing, so no 'right' is given: boxes that overlap or are apart, glued full, have no verdict; an overlap glue shift misses is still wrong", () => {
    expect(api).toBeGreaterThanOrEqual(10);
    const a = box(10, 10, 10, [0, 0, 0]);
    const over = box(10, 10, 10, [5, 5, 5]);
    const apart = box(10, 10, 10, [20, 0, 0]);
    for (const op of ['cut', 'common', 'fuse']) {
      expect(boolean(op, a, over, { glue: 'full' }).as_if_apart, `full overlap ${op}`).toBeUndefined();
      expect(boolean(op, a, apart, { glue: 'full' }).as_if_apart, `full apart ${op}`).toBeUndefined();
      expect(boolean(op, a, over, { glue: 'shift' }), `shift overlap ${op}`).toMatchObject({ as_if_apart: 'wrong', warnings: true });
      expect(boolean(op, a, apart).as_if_apart, `off apart ${op}`).toBe('right');
    }
  });

  it("the check keeps to its second where 300 tools lie apart in a 5,000-face ring's opening: it stops with no verdict, says apart_late and reports its time", () => {
    expect(api).toBeGreaterThanOrEqual(10);
    const n = 4998;
    const pts = Array.from({ length: n }, (_, i) => [100 * Math.cos((2 * Math.PI * i) / n), 100 * Math.sin((2 * Math.PI * i) / n)]);
    const prism = call(k, 'extrude', { profile: poly(pts, XY), extent: { kind: 'blind', d: 10 }, check: false }).id;
    const ring = boolean('cut', prism, cyl(50, 30, [0, 0, -5]), { check: false }).id;
    const tools = Array.from({ length: 300 }, (_, i) => box(2, 2, 2, [30 * Math.cos((2 * Math.PI * i) / 300) - 1, 30 * Math.sin((2 * Math.PI * i) / 300) - 1, 4]));
    const r = several('cut', [ring], tools, { check: false });
    expect(r.as_if_apart).toBeUndefined();
    expect(r.apart_late).toBe(true);
    expect(r.timings.apart_ms).toBeGreaterThanOrEqual(1000);
    // Generous (the machine may be busy): it stops at the first point classified after 1 s.
    expect(r.timings.apart_ms).toBeLessThan(2500);
    console.log(`[as_if_apart budget, 300 tools in a 5,000-face ring] check ${r.timings.apart_ms.toFixed(0)} ms, boolean ${r.timings.boolean_ms.toFixed(0)} ms`);
  }, 180_000);
});
