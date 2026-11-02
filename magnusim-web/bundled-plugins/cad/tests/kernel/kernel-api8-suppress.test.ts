// @vitest-environment node
// Kernel API 8, suppress_blends (Analysis Situs asiAlgo_SuppressBlendsInc): fillets taken off
// as fillets, where OCCT's defeature fills the gap (the Step 0 family: T-block, I-beam, plus,
// comb, Z-block on every edge R1 / R2, and the L-block control). Gate G2 of the integration
// plan: the exact sharp part (valid, volume, faces), the history every naming step needs
// (exactly the picked faces deleted, every kept face one image on its own plane, no result face
// without a source), the proof's case G (take off a chain, re-round the restored edges), and the
// refusals that keep a wrong body from ever looking right: a pick that is not every fillet up to
// R, faces that are not fillets, two solids, and nothing (or not everything) taken off. The input
// never changes, and running out of memory is an error, not a result.
// Until the shipped kernel is API 8 this runs on a dev kernel (CAD_KERNEL_DIR; tests/kernel/asi-lib.ts).
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { call, importStep, KERNEL_DIR, loadKernel, rel, tryCall, type R } from './kernel-lib';
import { api8Gate, FAMILY, familyPart, partKit, PROOF_A_SHARP, proofA, ringBoss, type Face } from './asi-lib';

const k = await loadKernel();
const { describe8 } = api8Gate(k);
const kit = partKit(k);

const recognize = (id: number, extra: R = {}): R => call(k, 'recognize', { id, ...extra });
const suppress = (id: number, faces: number[], extra: R = {}): R => call(k, 'suppress_blends', { id, faces, ...extra });
const refusal = (id: number, faces: number[]) => tryCall(k, 'suppress_blends', { id, faces });
const allBlends = (id: number): number[] => recognize(id).blends.map((b: R) => b.face);
const brepBytes = (id: number): string => Buffer.from(k.takeBuffers(k.call('brep_write', { ids: [id] })).brep as Uint8Array).toString('base64');

/**
 * The history a naming step reads, checked against the geometry: exactly the picked faces of
 * `input` deleted, every result face from exactly one kept input face (modified or same), every
 * kept face landing once, on its own plane.
 */
function checkHistory(input: number, picks: number[], s: R) {
  const inFaces = kit.faces(input);
  const outFaces = kit.faces(s.id);
  const deleted = (s.history.deleted as R[]).filter((d) => d.face !== undefined).map((d) => d.face).sort((a: number, b: number) => a - b);
  expect(deleted).toEqual([...picks].sort((a, b) => a - b));
  expect((s.history.deleted as R[]).every((d) => d.shape === input)).toBe(true);
  const landed = new Map<number, number>();
  expect(s.history.faces).toHaveLength(s.faces);
  for (const e of s.history.faces as R[]) {
    expect(e.from, `result face ${e.out}`).toHaveLength(1);
    const src = e.from[0];
    expect(src.shape).toBe(input);
    expect(['modified', 'same']).toContain(src.how);
    expect(picks).not.toContain(src.face);
    landed.set(src.face, (landed.get(src.face) ?? 0) + 1);
    const a = inFaces[src.face] as Face;
    const b = outFaces[e.out] as Face;
    expect(b.type).toBe(a.type);
    if (a.type === 'plane') {
      // The image is on its source's plane: same normal, and its centroid on that plane.
      for (let i = 0; i < 3; i++) expect(b.normal![i]).toBeCloseTo(a.normal![i], 9);
      const d = a.normal!.reduce((acc, n, i) => acc + n * (b.centroid![i] - a.centroid![i]), 0);
      expect(Math.abs(d)).toBeLessThan(1e-7);
    }
  }
  for (let i = 0; i < inFaces.length; i++) if (!picks.includes(i)) expect(landed.get(i), `kept face ${i}`).toBe(1);
}

describe8('suppress_blends (API 8)', () => {
  it("the Step 0 family, every fillet up to R: exactly the sharp part, where OCCT's defeature fills the gap", () => {
    for (const name of Object.keys(FAMILY)) {
      for (const r of name === 'L' ? [2] : [1, 2]) {
        const what = `${name} R${r}`;
        const p = familyPart(kit, name, r);
        const s = suppress(p.id, p.truth);
        expect(s, what).toMatchObject({ valid: true, faces: p.sharpFaces, chains: 1, asked: p.truth.length, removed: p.truth.length, left: 0 });
        expect(s.r, what).toBeCloseTo(r, 9);
        expect(s.max_r, what).toBeCloseTo(r * 1.001, 9);
        expect(rel(kit.vol(s.id), p.sharpVolume), what).toBeLessThan(1e-12);
        expect(kit.faces(s.id).every((f) => f.type === 'plane'), what).toBe(true);
        expect(recognize(s.id).blends, what).toEqual([]);
        expect(s.self_check, what).toEqual({ split: 0, stale_leaves: 0, dropped: 0 });
        expect(s.convert_to_occ, what).toEqual({ disagree: 0, fewer_images: 0, no_source: 0 });
        expect(s.timings.suppress_ms, what).toBeGreaterThan(0);
        checkHistory(p.id, p.truth, s);
        // OCCT on the same faces: valid but wrong (it fills the steps), except on the L-block
        // whose two-go heal Delete faces already gets right.
        const d = call(k, 'defeature', { id: p.id, faces: p.truth });
        const occt = kit.vol(d.id);
        if (name === 'L') expect(occt, what).toBeCloseTo(48000, 6);
        else expect(Math.abs(occt - p.sharpVolume), what).toBeGreaterThan(1000);
        kit.release(p.id, p.sharp, s.id, d.id);
      }
    }
  });

  it('what the T-block R2 result adds and takes against the rounded body (for the taken rule): 460.2413 mm³ at the convex rounds, 64.8145 mm³ at the concave', () => {
    const p = familyPart(kit, 'T', 2);
    const s = suppress(p.id, p.truth);
    const added = kit.vol(kit.cut(s.id, p.id));
    const taken = kit.vol(kit.cut(p.id, s.id));
    expect(added).toBeCloseTo(460.2413, 3);
    expect(taken).toBeCloseTo(64.8145, 3);
    expect(added - taken).toBeCloseTo(kit.vol(s.id) - kit.vol(p.id), 6);
  });

  it('several chains: lateral rounds only (one chain each), the T with two radii (all at once, then only the R1 rounds)', () => {
    for (const [name, r, n] of [
      ['T', 2, 8],
      ['comb', 1, 20],
      ['I', 2, 12],
      ['Z', 2, 8],
    ] as [string, number, number][]) {
      const p = familyPart(kit, name, r, 'lat');
      const s = suppress(p.id, p.truth);
      expect(s, name).toMatchObject({ valid: true, faces: p.sharpFaces, chains: n, removed: n, left: 0 });
      expect(rel(kit.vol(s.id), p.sharpVolume), name).toBeLessThan(1e-12);
      checkHistory(p.id, p.truth, s);
    }
    // The T rounded R2 along the extrusion, then every edge of its two end faces R1.
    const lat = familyPart(kit, 'T', 2, 'lat');
    const caps = kit.edges(lat.id).filter((e) => [e.first, e.last].every((q) => Math.abs(q[1]) < 1e-9) || [e.first, e.last].every((q) => Math.abs(Math.abs(q[1]) - 40) < 1e-9)).map((e) => e.i);
    expect(caps).toHaveLength(32);
    const two = kit.fillet(lat.id, caps, 1);
    const rec = recognize(two.id);
    expect(rec.blends).toHaveLength(40);
    const all = suppress(two.id, rec.blends.map((b: R) => b.face));
    expect(all).toMatchObject({ valid: true, faces: 10 });
    expect(rel(kit.vol(all.id), lat.sharpVolume)).toBeLessThan(1e-12);
    const small = rec.blends.filter((b: R) => b.r_max < 1.5).map((b: R) => b.face);
    expect(small).toEqual(two.made);
    const s = suppress(two.id, small);
    expect(s).toMatchObject({ valid: true, faces: 18, chains: 2 });
    expect(rel(kit.vol(s.id), kit.vol(lat.id))).toBeLessThan(1e-12);
    checkHistory(two.id, small, s);
  });

  it("the proof's part A: every fillet (R5 and R3) gives the box with its holes; the R3 chain alone keeps the R5 rounds, and re-rounding the restored top edges R1.5 builds the same part as a fresh R1.5 build (case G)", () => {
    const a = proofA(kit);
    const every = [...a.r5, ...a.rTop].sort((x, y) => x - y);
    const s = suppress(a.id, every);
    expect(s).toMatchObject({ valid: true, faces: 9, removed: 12 });
    expect(rel(kit.vol(s.id), PROOF_A_SHARP)).toBeLessThan(1e-12);
    checkHistory(a.id, every, s);

    const top = suppress(a.id, a.rTop);
    expect(top).toMatchObject({ valid: true, faces: 13, removed: 8 });
    expect(top.r).toBeCloseTo(3, 9);
    const noTop = proofA(kit, 0);
    expect(rel(kit.vol(top.id), kit.vol(noTop.id))).toBeLessThan(1e-12);
    checkHistory(a.id, a.rTop, top);
    // The restored top face's edges (lines and the R5 arcs; not the hole's full circle).
    const edges = kit.edges(top.id).filter((e) => [e.first, e.last].every((q) => Math.abs(q[2] - 20) < 1e-9) && !(e.type === 'circle' && e.first.every((v, i) => Math.abs(v - e.last[i]) < 1e-9)));
    expect(edges).toHaveLength(8);
    const again = kit.fillet(top.id, edges.map((e) => e.i), 1.5);
    const fresh = proofA(kit, 1.5);
    expect(again.res).toMatchObject({ valid: true, faces: call(k, 'props', { id: fresh.id, bbox: 'none' }).faces });
    expect(rel(kit.vol(again.id), kit.vol(fresh.id))).toBeLessThan(1e-9);
  });

  it('a box with every edge R4 (vertex blends): the box; a variable fillet 2 -> 6 (STEP fixture): the box', () => {
    const f = kit.filletAll(kit.box(60, 40, 20), 4);
    const s = suppress(f.id, f.made);
    expect(s).toMatchObject({ valid: true, faces: 6, removed: 20 });
    expect(rel(kit.vol(s.id), 48000)).toBeLessThan(1e-12);
    checkHistory(f.id, f.made, s);
    const v = importStep(k, 'variable-fillet.step').shapes[0].id;
    const sv = suppress(v, [2]);
    expect(sv).toMatchObject({ valid: true, faces: 6, removed: 1 });
    expect(sv.r).toBeCloseTo(6, 2);
    expect(rel(kit.vol(sv.id), 48000)).toBeLessThan(1e-9);
  });

  it('rings are refused, never passed through: the boss of case F, a rounded hole rim, and a ring among fillets that do come off', () => {
    const boss = ringBoss(kit);
    const ringWords = '(a ring round a boss or a hole cannot be taken off as a fillet)';
    expect(refusal(boss.id, [...boss.foot, ...boss.rim])).toMatchObject({ ok: false, kind: 'input', error: `no fillet could be taken off ${ringWords}` });
    expect(refusal(boss.id, boss.rim)).toMatchObject({ ok: false, error: `no fillet could be taken off ${ringWords}` });
    const h = kit.cut(kit.box(40, 40, 10), kit.cyl(3, 12, [20, 20, -1]));
    const rim = kit.fillet(h, kit.edges(h).filter((e) => e.type === 'circle' && Math.abs(e.first[2] - 10) < 1e-9).map((e) => e.i), 1);
    expect(refusal(rim.id, rim.made)).toMatchObject({ ok: false, error: `no fillet could be taken off ${ringWords}` });
    // A plate rounded R2 on every edge with an R2 ring at a boss's foot: SuppressBlendsInc takes
    // the plate's 20 fillet faces off and skips the ring; the kernel refuses the partial result.
    const plate = kit.filletAll(kit.box(60, 40, 10), 2).id;
    const withBoss = kit.fuse(plate, kit.cyl(8, 10, [30, 20, 9]));
    const foot = kit.edges(withBoss).filter((e) => e.type === 'circle' && Math.abs(e.first[2] - 10) < 1e-9).map((e) => e.i);
    const ringed = kit.fillet(withBoss, foot, 2);
    const picks = allBlends(ringed.id);
    expect(picks).toHaveLength(21);
    expect(refusal(ringed.id, picks)).toMatchObject({ ok: false, kind: 'input', error: `1 of the 21 fillet faces could not be taken off ${ringWords}` });
  });

  it('a pick that is not every fillet up to R is refused, naming both counts', () => {
    const p = familyPart(kit, 'T', 2);
    expect(refusal(p.id, p.truth.slice(0, 36))).toMatchObject({ ok: false, kind: 'input', error: 'the fillets up to R2 are 40 faces; 36 are picked' });
    expect(refusal(p.id, p.truth.slice(0, 1))).toMatchObject({ ok: false, error: 'the fillets up to R2 are 40 faces; 1 are picked' });
    // The T with two radii: the R2 rounds alone leave the R1 rounds, which are under R2 too.
    const lat = familyPart(kit, 'T', 2, 'lat');
    const caps = kit.edges(lat.id).filter((e) => [e.first, e.last].every((q) => Math.abs(q[1]) < 1e-9) || [e.first, e.last].every((q) => Math.abs(Math.abs(q[1]) - 40) < 1e-9)).map((e) => e.i);
    const two = kit.fillet(lat.id, caps, 1);
    const big = recognize(two.id).blends.filter((b: R) => b.r_max > 1.5).map((b: R) => b.face);
    expect(big).toHaveLength(8);
    expect(refusal(two.id, big)).toMatchObject({ ok: false, error: 'the fillets up to R2 are 40 faces; 8 are picked' });
  });

  it('faces that are not fillets, two solids, a surface body and bad indices are refused in words', () => {
    const p = familyPart(kit, 'T', 2);
    const planes = kit.faces(p.id).filter((f) => f.type === 'plane').map((f) => f.i);
    expect(refusal(p.id, [planes[0]])).toMatchObject({ ok: false, kind: 'input', error: 'the face is not a fillet' });
    expect(refusal(p.id, planes.slice(0, 3))).toMatchObject({ ok: false, error: 'none of the 3 faces are fillets' });
    expect(refusal(p.id, [...p.truth, planes[0]])).toMatchObject({ ok: false, error: '1 of the 41 faces are not fillets' });
    expect(refusal(p.id, [])).toMatchObject({ ok: false, error: 'no faces given' });
    expect(refusal(p.id, [999])).toMatchObject({ ok: false, error: 'face index 999 out of range' });
    const one = (x: number) => kit.filletAll(kit.box(20, 20, 20, [x, 0, 0]), 2).id;
    const both = kit.fuse(one(0), one(50));
    expect(refusal(both, allBlends(both))).toMatchObject({ ok: false, kind: 'input', error: 'this body has 2 solids: fillets are taken off one solid at a time' });
    const shell = importStep(k, 'box20-faces.step', { heal: false }).shapes[0].id;
    expect(refusal(shell, [0])).toMatchObject({ ok: false, kind: 'input', error: 'no solid in this body (fillets are taken off solids only)' });
    expect(tryCall(k, 'suppress_blends', { id: p.id, faces: p.truth, debug_history: 'first' })).toMatchObject({ ok: false, error: 'debug_history must be leaves or convert_to_occ' });
  });

  it('the input is never changed, by a result or by a refusal', () => {
    for (const [id, picks] of [
      [familyPart(kit, 'T', 2).id, null],
      [proofA(kit).id, null],
      [ringBoss(kit).id, null],
    ] as [number, number[] | null][]) {
      const before = brepBytes(id);
      const all = picks ?? allBlends(id);
      tryCall(k, 'suppress_blends', { id, faces: all });
      tryCall(k, 'suppress_blends', { id, faces: all.slice(0, 1) });
      expect(brepBytes(id)).toBe(before);
    }
  });

  it("Analysis Situs' ConvertToOcc agrees with the all-leaves history on every part here (no face is split); swapped in, the same history", () => {
    for (const [p, picks] of [
      [familyPart(kit, 'comb', 1), null],
      [familyPart(kit, 'comb', 1, 'lat'), null],
      [familyPart(kit, 'I', 2), null],
    ] as [{ id: number; truth: number[] }, null][]) {
      const faces = picks ?? p.truth;
      const ours = suppress(p.id, faces);
      const occ = suppress(p.id, faces, { debug_history: 'convert_to_occ' });
      expect(ours.convert_to_occ).toEqual({ disagree: 0, fewer_images: 0, no_source: 0 });
      expect(ours.self_check.split).toBe(0);
      expect(occ.history).toEqual(ours.history);
    }
  });

  it('the same result from a fresh kernel and from one that has run 200 ops (gate G5)', async () => {
    const used = await loadKernel();
    const ukit = partKit(used);
    for (let i = 0; i < 50; i++) {
      const b = ukit.box(10 + i, 20, 30);
      const f = ukit.filletAll(b, 1 + (i % 3));
      ukit.release(b, f.id);
    }
    for (const name of ['T', 'comb', 'Z']) {
      const a = familyPart(kit, name, 2);
      const b = familyPart(ukit, name, 2);
      const sa = suppress(a.id, a.truth);
      const sb = call(used, 'suppress_blends', { id: b.id, faces: b.truth });
      expect(sb.faces, name).toBe(sa.faces);
      // The same history, but for the input's id.
      expect(JSON.stringify(sb.history).replaceAll(`"shape":${b.id}`, '"shape":0'), name).toBe(JSON.stringify(sa.history).replaceAll(`"shape":${a.id}`, '"shape":0'));
      expect(ukit.vol(sb.id), name).toBe(kit.vol(sa.id));
      expect(JSON.stringify(ukit.faces(sb.id)), name).toBe(JSON.stringify(kit.faces(sa.id)));
    }
  });
});

describe8('suppress_blends out of memory (API 8)', () => {
  let w: Worker;
  const send = (op: string, params: R = {}, timeoutMs = 120_000): Promise<R> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`watchdog: ${op} did not answer in ${timeoutMs / 1000} s`)), timeoutMs);
      w.once('message', (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      w.postMessage({ op, params });
    });

  it('on a full heap: ok:false with oom, never a partial body; after freeing it works again', async () => {
    w = new Worker(new URL('./kernel-oom-worker.mjs', import.meta.url), { workerData: { dir: KERNEL_DIR } });
    try {
      await new Promise((resolve, reject) => {
        w.once('message', resolve);
        w.once('error', reject);
      });
      const T = FAMILY.T;
      const ex = await send('extrude', { profile: { plane: { origin: [0, 0, 0], normal: [0, -1, 0], xdir: [1, 0, 0] }, loops: [T.xz.map((a, i) => ({ id: `s${i}`, kind: 'line', a, b: T.xz[(i + 1) % T.xz.length] }))] }, extent: { kind: 'blind', d: T.depth } });
      const topo = await send('topo', { id: ex.id, faces: 'none', vertices: 'none' });
      const f = await send('fillet', { id: ex.id, edges: topo.edges.map((e: R) => e.i), r: 2 });
      const rec = await send('recognize', { id: f.id });
      const picks = rec.blends.map((b: R) => b.face);
      expect(picks).toHaveLength(40);
      const hold = await send('debug_hold', { leave_mb: 4 });
      expect(hold.held_mb).toBeGreaterThan(3500);
      let made = 0;
      let failed: R | null = null;
      for (; made < 2000; made++) {
        const s = await send('suppress_blends', { id: f.id, faces: picks, check: false });
        if (!s.ok) {
          failed = s;
          break;
        }
      }
      expect(made).toBeGreaterThan(0);
      expect(failed).toMatchObject({ ok: false, oom: true });
      expect(String(failed!.error)).toMatch(/^out of memory during suppress_blends/);
      // No partial body was kept: the store holds the two inputs (extrude, fillet) and the results returned.
      const mem = await send('mem');
      expect(mem.shapes).toBe(2 + made);
      await send('debug_hold', { free: true });
      const again = await send('suppress_blends', { id: f.id, faces: picks });
      expect(again).toMatchObject({ ok: true, valid: true, faces: 10 });
    } finally {
      await w.terminate();
    }
  }, 300_000);
});
