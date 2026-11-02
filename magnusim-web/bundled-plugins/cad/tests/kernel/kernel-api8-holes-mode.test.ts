// @vitest-environment node
// Kernel API 8, recognize's drill-hole mode (decisions D6 and D9 of the Analysis Situs plan): the
// app finds holes in hard mode (src/kernel/recognition.ts HOLES_MODE), because hard finds most
// holes whose mouth straddles a fillet and the face next to it, which soft mode misses. These are
// the documented rows, as they are, on a 60 x 40 x 20 block (one top edge rounded R6, or every edge
// R3) drilled 4 mm (one 1 mm) where the verifier drilled them, plus cross-drilled holes, which hard
// mode joins into one hole. Measured 2026-11-02 (scratch D6 probe): hard lost no hole soft finds on
// the gate's 216 code-built rows and the 11 NIST parts, and differs only where holes cross (NIST
// FTC-10: 26 soft holes, 16 hard), at the same cost.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { HOLES_MODE } from '../../src/kernel/recognition';
import { call, loadKernel, type R } from './kernel-lib';
import { api8Gate, partKit } from './asi-lib';

const k = await loadKernel();
const { describe8 } = api8Gate(k);
const kit = partKit(k);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Each hole as [d_min, d_max, through] in a mode. */
const holes = (id: number, mode: 'soft' | 'hard') => (call(k, 'recognize', { id, blends: false, holes_mode: mode }).holes as R[]).map((h) => [h.d_min, h.d_max, h.through]);

/** The block with its top front edge (y 0, z 20) rounded R6. */
const oneR6 = () => {
  const b = kit.box(60, 40, 20);
  const e = kit.edges(b).filter((x) => [x.first, x.last].every((p) => near(p[2], 20) && near(p[1], 0))).map((x) => x.i);
  return kit.fillet(b, e, 6).id;
};
/** The block with every edge rounded R3. */
const allR3 = () => kit.filletAll(kit.box(60, 40, 20), 3).id;

describe8("recognize's hole modes: holes into fillets and crossing holes, the documented rows", () => {
  it('the app finds holes in hard mode', () => {
    expect(HOLES_MODE).toBe('hard');
  });

  it("a 4 mm hole whose mouth straddles a fillet and the top: soft misses it, hard finds it (the app's mode)", () => {
    const blind: R[] = [[4, 4, false]];
    const rows: [string, number, R[], R[]][] = [
      // [what, body, soft, hard]
      ['R6, blind at y 3 (the mouth inside the fillet)', kit.cut(oneR6(), kit.cyl(2, 11, [30, 3, 10])), blind, blind],
      ['R6, blind at y 5.5 (the mouth on the fillet and the top)', kit.cut(oneR6(), kit.cyl(2, 11, [30, 5.5, 10])), [], blind],
      ['R6, blind at y 8 (the mouth on the top only)', kit.cut(oneR6(), kit.cyl(2, 11, [30, 8, 10])), blind, blind],
      ['R3 all, blind at y 2.5 (fillet and top)', kit.cut(allR3(), kit.cyl(2, 11, [30, 2.5, 10])), [], blind],
      ['R3 all, through at y 2.5 (fillet and top, fillet and bottom)', kit.cut(allR3(), kit.cyl(2, 22, [30, 2.5, -1])), [], [[4, 4, true]]],
      ['R3 all, along the fillet normal at 45 degrees, out through the bottom', kit.cut(allR3(), kit.cyl(2, 36, [30, 3 - 10 * Math.SQRT1_2, 17 + 10 * Math.SQRT1_2], [0, 1, -1])), [], [[4, 4, true]]],
      ['R3 all, blind at y 8 (top only)', kit.cut(allR3(), kit.cyl(2, 11, [30, 8, 10])), blind, blind],
      ['R3 all, 1 mm blind at y 1.5 (the mouth inside the fillet)', kit.cut(allR3(), kit.cyl(0.5, 11, [30, 1.5, 10])), [[1, 1, false]], [[1, 1, false]]],
    ];
    for (const [what, id, soft, hard] of rows) {
      expect(holes(id, 'soft'), `${what}: soft`).toEqual(soft);
      expect(holes(id, 'hard'), `${what}: hard`).toEqual(hard);
    }
  });

  it('documented misses in both modes: a 4 mm hole mostly in an R3 fillet, and one along y through the R3 fillets at z 18.5', () => {
    for (const [what, id] of [
      ['R3 all, blind at y 1.5', kit.cut(allR3(), kit.cyl(2, 11, [30, 1.5, 10]))],
      ['R3 all, along y through at z 18.5', kit.cut(allR3(), kit.cyl(2, 42, [30, -1, 18.5], [0, 1, 0]))],
    ] as [string, number][]) {
      // The drill really took material away.
      expect(kit.nFaces(id), what).toBeGreaterThan(26);
      expect(holes(id, 'soft'), what).toEqual([]);
      expect(holes(id, 'hard'), what).toEqual([]);
    }
  });

  it('crossing holes: hard mode joins them into one hole (bores 4 to 6, or 6 and 6), soft finds the 4 mm only or nothing', () => {
    const cross = (r2: number) => kit.cut(kit.box(40, 40, 40), kit.cyl(3, 42, [20, 20, -1]), kit.cyl(r2, 42, [-1, 20, 20], [1, 0, 0]));
    expect(holes(cross(2), 'soft')).toEqual([[4, 4, true]]);
    expect(holes(cross(2), 'hard')).toEqual([[4, 6, true]]);
    expect(holes(cross(3), 'soft')).toEqual([]);
    expect(holes(cross(3), 'hard')).toEqual([[6, 6, true]]);
  });
});
