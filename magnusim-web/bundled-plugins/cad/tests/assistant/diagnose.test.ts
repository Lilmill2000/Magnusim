// Why a join, cut or intersect met nothing (CAD tools spec §7.4, §12.1 diagnose), on the REAL
// kernel through the extrude and revolve tools. Every miss changes nothing (no feature, no panel,
// no undo entry) and says which way it missed:
//   - a blind cut pointing away from a plate it does not reach either way at its distance:
//     wrong_side with how far the body starts (gap_mm), and the hint's cut works;
//   - a blind cut pointing away from the plate: wrong_side, with the body the other way and the
//     flip hint ("set flip false" when flip is already true); a through cut the wrong way too;
//   - the L bracket walk: a hole sketched on its -X face at v = +22.5 and cut through misses below
//     the bracket: off_body, the face's frame in words (u runs +Y, v runs -Z), the profile's box
//     beside the body's; at v = -22.5 it cuts;
//   - a cut from above that stops short: too_short, the body it is in line with;
//   - drafted cuts (Extrude's draft angle): until the walls meet pointing away is wrong_side with
//     the flip hint, as the panel says; one whose flipped walls meet short of the plate gets no flip
//     hint and too_short that says the draft narrows it off first (with flip in its hint); a smaller
//     draft that reaches gets the hint; drafted misses get hints with no extent through, and a drafted
//     check the kernel refuses leaves the sub-reason out;
//   - a cut on given bodies that cuts nothing away: cut_removed_nothing with the sub-reason; one
//     that cuts one of two bodies is kept, warning of the other; an intersect on a body it misses
//     fails (it would leave nothing of it);
//   - a join beside the plate: feature_failed no_overlap with CAD's words;
//   - a blind cut pointing away from the plate whose common the other way OCCT answers as if apart
//     (kernel API 10, as_if_apart wrong; GitHub issue 15): still wrong_side, the body and the flip hint;
//   - a revolve cut turning away: wrong_side with the revolve's hint;
//   - forced races: the person's Escape while the miss is checked answers taken_over; a kernel
//     restart while it is checked leaves the sub-reason out (no guess); a restart while a scoped
//     cut's volumes are read answers busy changed. Nothing is kept in each case.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { HINTS } from '../../src/assistant/errors';
import { runtimeOf } from '../../src/assistant/runtime';
import type { KernelAdapter } from '../../src/types/kernel';
import { uiFor } from '../../src/ui/controller';
import { commonsAsIfApart } from '../fakes/as-if-apart';
import { realKernelAnywhere } from '../features/p2/kernel-anywhere';
import { EXTRUDE, fail, names, ok, REVOLVE, volume, type ToolErr as Err } from './extrude-tools';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { undoLabel } from './parts';
import { C, E, rectInput, SK } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const PI = Math.PI;

/** What a refused call must leave: the same model, the same Undo, no panel or session. */
function unchanged(x: AssistantHarness) {
  const doc = x.doc.state.get().doc;
  const label = undoLabel(x);
  return () => {
    expect(x.doc.state.get().doc).toBe(doc);
    expect(undoLabel(x)).toBe(label);
    expect(x.doc.session()).toBeNull();
    expect(uiFor(x.services).state.get().panel).toBeNull();
  };
}

/** The tool's 60 x 40 x 6 plate on Top (Body 1, faces Plate.start/end/side(r.*)). */
async function plate(x: AssistantHarness): Promise<void> {
  await ok(x, 'sketch', rectInput('Plate sketch', 60, 40));
  await ok(x, 'extrude', EXTRUDE({ name: 'Plate', sketch: 'Plate sketch', distance: '6 mm' }));
}

/** A circle of radius `r` at (u, v) sketched on `on`. */
const disc = (name: string, on: string, u: number, v: number, r = 5) => SK({ name, on, entities: [E('c', 'circle', [u, v, r])] });

/** The guide's L bracket: an L on Front (50 x 40, 5 thick), 30 wide symmetric (Body 1: x 0..50, y -15..15, z 0..40). */
async function bracket(x: AssistantHarness): Promise<void> {
  const L = [0, 0, 50, 0, 50, 5, 5, 5, 5, 40, 0, 40, 0, 0];
  await ok(x, 'sketch', SK({ name: 'L profile', on: 'Front', entities: [E('p', 'polyline', L)], constraints: [C('o', 'coincident', ['p.p0', 'origin']), C('a', 'distance', ['p.1'], '50 mm'), C('b', 'distance', ['p.6'], '40 mm'), C('t1', 'distance', ['p.2'], '5 mm'), C('t2', 'distance', ['p.5'], '5 mm')], infer: true }));
  await ok(x, 'extrude', EXTRUDE({ name: 'Bracket', sketch: 'L profile', extent: 'symmetric', distance: '30 mm' }));
  expect(volume(x)).toBeCloseTo(425 * 30, 6);
}

describe('a cut that points away', () => {
  it(
    'is wrong_side: the body it would cut the other way, the flip hint; with flip it cuts',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      await ok(h, 'sketch', disc('Pocket sketch', 'Plate.end', 0, 0));
      const same = unchanged(h);
      const e = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', op: 'cut' }));
      expect(e).toMatchObject({
        code: 'failed',
        hint: HINTS.wrong_side,
        detail: {
          reason: 'feature_failed',
          feature: 'Pocket',
          sub: 'wrong_side',
          other_way: 'Body 1',
          message: 'Nothing to cut: Pocket does not overlap any body made before it (touching is not enough): tick Flip direction to cut into Body 1',
          frame: { origin_mm: [0, 0, 6], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], words: 'u runs +X, v runs +Y, origin (0, 0, 6)' },
          profile_bbox_mm: [[-5, -5, 6], [5, 5, 6]],
          bodies: [{ body: 'Body 1', bbox_mm: [[-30, -20, 0], [30, 20, 6]] }],
        },
      });
      expect(e.message).toBe('feature_failed: Pocket fails: Nothing to cut: Pocket does not overlap any body made before it (touching is not enough): tick Flip direction to cut into Body 1. It points away from the body: with flip true it would cut Body 1.');
      same();
      expect(names(h)).toEqual(['Plate sketch', 'Plate', 'Pocket sketch']);
      // Through, the wrong way: the same answer.
      const thru = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', extent: 'through', op: 'cut' }));
      expect(thru).toMatchObject({ code: 'failed', hint: HINTS.wrong_side, detail: { reason: 'feature_failed', sub: 'wrong_side', other_way: 'Body 1' } });
      same();
      // flip true goes into the plate.
      await ok(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', flip: true, op: 'cut' }));
      expect(volume(h)).toBeCloseTo(14400 - 25 * PI * 3, 3);
    },
    REAL_KERNEL_MS,
  );

  it(
    'says set flip false when flip is already true',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      // On Top (z 0, normal +Z): flip true goes down, away from the plate above it.
      await ok(h, 'sketch', disc('Under', 'Top', 0, 0));
      const same = unchanged(h);
      const e = await fail(h, 'extrude', EXTRUDE({ sketch: 'Under', distance: '3 mm', flip: true, op: 'cut' }));
      expect(e).toMatchObject({ hint: 'The cut points away from the body: set flip false, or use hole.', detail: { sub: 'wrong_side', other_way: 'Body 1' } });
      expect(e.message).toMatch(/It points away from the body: with flip false it would cut Body 1\.$/);
      same();
    },
    REAL_KERNEL_MS,
  );

  it(
    'when OCCT answers the common of the other way as if apart (kernel API 10, as_if_apart wrong; GitHub issue 15): still wrong_side with the body and the flip hint, never a plain miss',
    async () => {
      // The real kernel, but every common with volume comes back as OCCT gave issue 15's: empty, answered as if apart.
      const k = commonsAsIfApart(realKernelAnywhere());
      h = await assistantHarness({ sketchMode: true, kernel: k.kernel });
      await plate(h);
      await ok(h, 'sketch', disc('Pocket sketch', 'Plate.end', 0, 0));
      const same = unchanged(h);
      k.set(true);
      const e = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', op: 'cut' }));
      expect(e).toMatchObject({
        code: 'failed',
        hint: HINTS.wrong_side,
        detail: { reason: 'feature_failed', feature: 'Pocket', sub: 'wrong_side', other_way: 'Body 1', message: 'Nothing to cut: Pocket does not overlap any body made before it (touching is not enough): tick Flip direction to cut into Body 1' },
      });
      same();
    },
    REAL_KERNEL_MS,
  );
});

describe('a cut beside the body (the L bracket walk)', () => {
  it(
    'is off_body with the face\'s frame in words and the boxes; where the frame says, it cuts',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await bracket(h);
      // Bracket.side(p.6) is the -X face at x = 0: u runs +Y, v runs -Z, so v = +22.5 is z = -22.5, below the bracket.
      await ok(h, 'sketch', disc('Hole sketch', 'Bracket.side(p.6)', 0, 22.5, 3));
      const same = unchanged(h);
      const e = await fail(h, 'extrude', EXTRUDE({ name: 'Hole', sketch: 'Hole sketch', extent: 'through', flip: true, op: 'cut' }));
      expect(e).toMatchObject({
        code: 'failed',
        hint: HINTS.off_body,
        detail: {
          reason: 'feature_failed',
          feature: 'Hole',
          sub: 'off_body',
          frame: { origin_mm: [0, 0, 0], u: [0, 1, 0], v: [0, 0, -1], normal: [-1, 0, 0], words: 'u runs +Y, v runs -Z, origin (0, 0, 0)' },
          profile_bbox_mm: [[0, -3, -25.5], [0, 3, -19.5]],
          bodies: [{ body: 'Body 1', bbox_mm: [[0, -15, 0], [50, 15, 40]] }],
        },
      });
      expect(e.message).toBe(
        'feature_failed: Hole fails: Nothing to cut: Hole does not overlap any body made before it (touching is not enough). The profile lies beside Body 1, so no way of this extrude meets it. On Hole sketch, u runs +Y, v runs -Z, origin (0, 0, 0); the profile spans x 0, y -3 to 3, z -25.5 to -19.5 mm; Body 1 spans x 0 to 50, y -15 to 15, z 0 to 40 mm.',
      );
      same();
      // Moved where the frame says (v = -22.5 is z = +22.5): the hole goes through the 5 mm wall.
      await ok(h, 'sketch', { ...disc('Hole sketch', '', 0, -22.5, 3), edit: 'Hole sketch' });
      await ok(h, 'extrude', EXTRUDE({ name: 'Hole', sketch: 'Hole sketch', extent: 'through', flip: true, op: 'cut' }));
      expect(volume(h)).toBeCloseTo(425 * 30 - 9 * PI * 5, 3);
    },
    REAL_KERNEL_MS,
  );
});

describe('a cut that stops short, and cuts on given bodies', () => {
  it(
    'is too_short when the profile is in line with a body the extent does not reach',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      await ok(h, 'sketch', disc('High', 'Top offset 10 mm', 0, 0));
      const same = unchanged(h);
      const e = await fail(h, 'extrude', EXTRUDE({ sketch: 'High', distance: '2 mm', flip: true, op: 'cut' }));
      expect(e).toMatchObject({ hint: HINTS.too_short, detail: { reason: 'feature_failed', sub: 'too_short', in_line: 'Body 1' } });
      expect(e.message).toMatch(/The profile is in line with Body 1, but the extrude stops before it reaches it\./);
      same();
    },
    REAL_KERNEL_MS,
  );

  it(
    'is wrong_side, with how far the body starts, when the cut points away from a body beyond its distance; the hint works',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      // 10 mm up, pointing up (flip false): the plate (z 0 to 6) is the other way, 4 mm away.
      await ok(h, 'sketch', disc('High', 'Top offset 10 mm', 0, 0));
      const same = unchanged(h);
      const e = await fail(h, 'extrude', EXTRUDE({ sketch: 'High', distance: '2 mm', flip: false, op: 'cut' }));
      expect(e).toMatchObject({ detail: { reason: 'feature_failed', sub: 'wrong_side', other_way: 'Body 1', gap_mm: 4 }, hint: 'The cut points away from the body: set flip true and a distance over 4 mm (or extent through), or use hole.' });
      expect(e.message).toMatch(/It points away from the body, and Body 1 starts 4 mm away on the other side: with flip true and a distance over 4 mm it would cut Body 1\./);
      same();
      // As the hint says: the cut goes 2 mm into the plate.
      await ok(h, 'extrude', EXTRUDE({ sketch: 'High', distance: '6 mm', flip: true, op: 'cut' }));
      expect(volume(h)).toBeCloseTo(14400 - 25 * PI * 2, 3);
    },
    REAL_KERNEL_MS,
  );

  it(
    'until the walls meet, pointing away from the plate: wrong_side with the flip hint the panel gives, never too_short; with flip it cuts the cone',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      await ok(h, 'sketch', disc('Cone sketch', 'Plate.end', 0, 0));
      const same = unchanged(h);
      const e = await fail(h, 'extrude', EXTRUDE({ name: 'Cone', sketch: 'Cone sketch', distance: '', taper: '59 deg', op: 'cut' }));
      expect(e).toMatchObject({
        code: 'failed',
        hint: HINTS.wrong_side,
        detail: { reason: 'feature_failed', feature: 'Cone', sub: 'wrong_side', other_way: 'Body 1', message: 'Nothing to cut: Cone does not overlap any body made before it (touching is not enough): tick Flip direction to cut into Body 1' },
      });
      expect(e.message).toBe('feature_failed: Cone fails: Nothing to cut: Cone does not overlap any body made before it (touching is not enough): tick Flip direction to cut into Body 1. It points away from the body: with flip true it would cut Body 1.');
      same();
      // As both say: flipped, the cone (r 5, its walls meeting 5 / tan 59 deg = 3.00 mm down) goes into the plate.
      await ok(h, 'extrude', EXTRUDE({ name: 'Cone', sketch: 'Cone sketch', distance: '', taper: '59 deg', flip: true, op: 'cut' }));
      expect(volume(h)).toBeCloseTo(14400 - (PI * 25 * (5 / Math.tan((59 * PI) / 180))) / 3, 2);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a drafted cut whose walls, flipped, meet short of the plate gets no flip hint and says the draft narrows it off the plate first; a smaller draft that reaches gets the hint, and cuts',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      // 25 mm up (the plate is z 0 to 6), r 10, pointing up. Flipped at 30 deg the walls meet 10 / tan 30 deg = 17.32 mm down, at z 7.68.
      await ok(h, 'sketch', disc('High', 'Top offset 25 mm', 0, 0, 10));
      const same = unchanged(h);
      const e = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'High', distance: '30 mm', taper: '30 deg', op: 'cut' }));
      expect(e).toMatchObject({
        code: 'failed',
        hint: 'The cut narrows off the body before it reaches it: set a smaller taper (or taper 0) with a distance that reaches it, and flip true; or use hole.',
        detail: { reason: 'feature_failed', feature: 'Pocket', sub: 'too_short', in_line: 'Body 1', message: 'Nothing to cut: Pocket does not overlap any body made before it (touching is not enough)' },
      });
      expect(e.message).toMatch(/The profile is in line with Body 1, but drafted at 30 deg it narrows off it before it reaches it, whichever way it points: a smaller draft angle reaches farther\./);
      same();
      // At 10 deg, flipped, the walls are still 6.65 mm out where they reach the plate's top (19 mm down): the hint names it.
      const r = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'High', distance: '30 mm', taper: '10 deg', op: 'cut' }));
      expect(r).toMatchObject({
        hint: HINTS.wrong_side,
        detail: { sub: 'wrong_side', other_way: 'Body 1', message: 'Nothing to cut: Pocket does not overlap any body made before it (touching is not enough): tick Flip direction to cut into Body 1' },
      });
      same();
      await ok(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'High', distance: '30 mm', taper: '10 deg', flip: true, op: 'cut' }));
      // The frustum through the plate, 19 to 25 mm down.
      const t = Math.tan((10 * PI) / 180);
      const [r1, r2] = [10 - 19 * t, 10 - 25 * t];
      expect(volume(h)).toBeCloseTo(14400 - (PI * 6 * (r1 * r1 + r1 * r2 + r2 * r2)) / 3, 2);
    },
    REAL_KERNEL_MS,
  );

  it(
    'drafted cuts that stop short or point away get hints with no extent through (a draft goes only with Blind); a drafted check the kernel refuses leaves the sub-reason out',
    async () => {
      const real = realKernelAnywhere();
      let refuse = false;
      // The kernel refusing a drafted extrude past 31 mm (the checks out to where the walls meet), as OCCT can.
      const kernel = new Proxy(real, {
        get(t, p) {
          if (p === 'call')
            return async (op: string, params: Record<string, unknown>, opts?: object) => {
              const ext = params.extent as { kind?: string; d?: number } | undefined;
              if (refuse && op === 'extrude_regions' && params.taper_deg && ext?.kind === 'blind' && (ext.d ?? 0) > 31) throw Object.assign(new Error('tapered extrude failed'), { kind: 'occt' });
              return (real.call as (o: string, q: unknown, s?: object) => Promise<unknown>)(op, params, opts);
            };
          const v = Reflect.get(t, p);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }) as KernelAdapter;
      h = await assistantHarness({ sketchMode: true, kernel });
      await plate(h);
      // 10 mm up, r 5; the plate's top is 4 mm below.
      await ok(h, 'sketch', disc('High', 'Top offset 10 mm', 0, 0));
      const same = unchanged(h);
      const NO_THROUGH = 'The cut stops before it reaches the body: make distance larger (a draft angle goes only with Blind).';
      // Widening, pointing at the plate, 2 mm: a longer distance reaches it.
      const wide = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'High', distance: '2 mm', taper: '-5 deg', flip: true, op: 'cut' }));
      expect(wide).toMatchObject({ hint: NO_THROUGH, detail: { sub: 'too_short', in_line: 'Body 1' } });
      // Narrowing at 10 deg, pointing at the plate: still 4.29 mm across where it reaches the plate, so a longer distance does too.
      const narrow = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'High', distance: '2 mm', taper: '10 deg', flip: true, op: 'cut' }));
      expect(narrow).toMatchObject({ hint: NO_THROUGH, detail: { sub: 'too_short', in_line: 'Body 1' } });
      // Pointing away: wrong_side with the gap, and no extent through in its hint.
      const away = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'High', distance: '2 mm', taper: '10 deg', op: 'cut' }));
      expect(away).toMatchObject({ hint: 'The cut points away from the body: set flip true and a distance over 4 mm, or use hole.', detail: { sub: 'wrong_side', other_way: 'Body 1', gap_mm: 4 } });
      same();
      // The kernel refuses the drafted checks out to where the walls meet: which way it missed is not guessed.
      await ok(h, 'sketch', disc('Higher', 'Top offset 25 mm', 0, 0, 10));
      const same2 = unchanged(h);
      refuse = true;
      const unknown = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'Higher', distance: '30 mm', taper: '30 deg', op: 'cut' }));
      expect(unknown.detail).toMatchObject({ reason: 'feature_failed', feature: 'Pocket' });
      expect(unknown.detail).not.toHaveProperty('sub');
      expect(unknown.message).toMatch(/Which way it missed could not be checked \(the geometry kernel could not make the drafted extrude out to where its walls meet\)\. On Higher, /);
      same2();
    },
    REAL_KERNEL_MS,
  );

  it(
    'cut_removed_nothing for a cut on given bodies that cuts nothing away; one of two cut is kept with a warning; an intersect that misses fails',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      await ok(h, 'sketch', disc('Pocket sketch', 'Plate.end', 0, 0));
      const same = unchanged(h);
      const away = await fail(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', op: 'cut', bodies: ['Body 1'] }));
      expect(away).toMatchObject({ code: 'failed', hint: HINTS.wrong_side, detail: { reason: 'cut_removed_nothing', feature: 'Pocket', scope: ['Body 1'], sub: 'wrong_side', other_way: 'Body 1' } });
      expect(away.message).toMatch(/^cut_removed_nothing: Pocket cut nothing away from Body 1\. It points away from the body: with flip true it would cut Body 1\.$/);
      same();
      // A disc beside the plate, on given bodies: off_body.
      await ok(h, 'sketch', disc('Beside', 'Top', 60, 0));
      const same2 = unchanged(h);
      const beside = await fail(h, 'extrude', EXTRUDE({ sketch: 'Beside', distance: '6 mm', op: 'cut', bodies: ['Body 1'] }));
      expect(beside).toMatchObject({ detail: { reason: 'cut_removed_nothing', sub: 'off_body' }, hint: HINTS.off_body });
      // An intersect on the plate it misses would leave nothing of it.
      const inter = await fail(h, 'extrude', EXTRUDE({ sketch: 'Beside', distance: '6 mm', op: 'intersect', bodies: ['Body 1'] }));
      expect(inter).toMatchObject({ code: 'failed', detail: { reason: 'feature_failed', sub: 'off_body', scope: ['Body 1'] } });
      expect(inter.message).toMatch(/^feature_failed: Extrude \d fails: it overlaps none of Body 1, so the intersect would leave nothing of it\. /);
      same2();
      // A second plate beside, at the disc: a cut on both cuts the second only, and warns of the first.
      await ok(h, 'extrude', EXTRUDE({ name: 'Second', sketch: 'Beside', distance: '6 mm', body_name: 'Disc' }));
      await ok(h, 'sketch', disc('Both', 'Top offset 6 mm', 60, 0, 2));
      const both = await ok(h, 'extrude', EXTRUDE({ sketch: 'Both', distance: '3 mm', flip: true, op: 'cut', bodies: ['Body 1', 'Disc'] }));
      expect(both.data.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Extrude \d cut nothing away from Body 1$/)]));
      expect(volume(h, 'Disc')).toBeCloseTo(25 * PI * 6 - 4 * PI * 3, 3);
      expect(volume(h)).toBeCloseTo(14400, 6);
    },
    REAL_KERNEL_MS,
  );
});

describe('a join that meets nothing, and a revolve that turns away', () => {
  it(
    'a join beside the plate is feature_failed no_overlap with CAD\'s words; no feature, no undo entry',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      h.fake.emitTurn({ id: 't-test', title: 'A boss' });
      await plate(h);
      await ok(h, 'sketch', disc('Boss sketch', 'Top', 60, 0));
      const same = unchanged(h);
      const e = await fail(h, 'extrude', EXTRUDE({ name: 'Boss', sketch: 'Boss sketch', distance: '6 mm', op: 'join' }));
      expect(e).toMatchObject({
        code: 'failed',
        hint: HINTS.no_overlap,
        detail: { reason: 'feature_failed', feature: 'Boss', sub: 'no_overlap', message: 'Nothing to join: Boss shares no face with a body made before it', profile_bbox_mm: [[55, -5, 0], [65, 5, 0]] },
      });
      expect(e.message).toMatch(/^feature_failed: Boss fails: Nothing to join: Boss shares no face with a body made before it\. It touches no body\. On Boss sketch, u runs \+X, v runs \+Y, origin \(0, 0, 0\); /);
      same();
      expect(undoLabel(h)).toBe('Assistant: A boss');
    },
    REAL_KERNEL_MS,
  );

  it(
    'a revolve cut turning away from a quarter ring is wrong_side, with the revolve\'s own hint',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // A quarter ring: x 10..40 on Front turned 90 deg about Z (toward +Y).
      await ok(h, 'sketch', SK({ name: 'Ring sketch', on: 'Front', entities: [E('r', 'rect', [10, 0, 40, 8])] }));
      await ok(h, 'revolve', REVOLVE({ name: 'Quarter', sketch: 'Ring sketch', extent: 'one', angle: '90 deg' }));
      const v0 = volume(h)!;
      await ok(h, 'sketch', SK({ name: 'Groove sketch', on: 'Front', entities: [E('g', 'rect', [20, 2, 25, 6])] }));
      const same = unchanged(h);
      const e = await fail(h, 'revolve', REVOLVE({ sketch: 'Groove sketch', extent: 'one', angle: '45 deg', flip: true, op: 'cut' }));
      expect(e).toMatchObject({ hint: 'The cut turns away from the body: set flip false.', detail: { reason: 'feature_failed', sub: 'wrong_side', other_way: 'Body 1' } });
      expect(e.message).toMatch(/It turns away from the body: with flip false it would cut Body 1\.$/);
      same();
      await ok(h, 'revolve', REVOLVE({ sketch: 'Groove sketch', extent: 'one', angle: '45 deg', op: 'cut' }));
      expect(volume(h)).toBeCloseTo(v0 - (PI * (25 * 25 - 20 * 20) * 4) / 8, 2);
    },
    REAL_KERNEL_MS,
  );
});

/** The real kernel with its next call that `pick` takes held until released, and a restart it can fire. */
function holdingKernel() {
  const real = realKernelAnywhere();
  let pick: ((op: string, params: Record<string, unknown>) => boolean) | null = null;
  let reached: () => void = () => {};
  let go: () => void = () => {};
  const call: KernelAdapter['call'] = async (op, params, opts) => {
    if (pick && pick(op, params as Record<string, unknown>)) {
      pick = null;
      const gate = new Promise<void>((resolve) => (go = resolve));
      reached();
      await gate;
    }
    return real.call(op, params, opts);
  };
  const kernel = new Proxy(real, {
    get(t, prop) {
      if (prop === 'call') return call;
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return {
    kernel,
    /** Hold the next call `p` takes; resolves once it is held. */
    hold(p: (op: string, params: Record<string, unknown>) => boolean): Promise<void> {
      pick = p;
      return new Promise<void>((resolve) => (reached = resolve));
    },
    release: () => go(),
    restart: () => real.restart('test restart'),
  };
}

/** The diagnosis's own overlap test (boolean common keeping its tool; the build's own booleans do not keep it). */
const overlapCheck = (op: string, params: Record<string, unknown>) => op === 'boolean' && params.op === 'common' && params.keep_tools === true;

describe('races while the miss is checked', () => {
  it(
    "the person's Escape while the miss is checked answers taken_over; nothing is kept and the Assistant pauses",
    async () => {
      const k = holdingKernel();
      h = await assistantHarness({ sketchMode: true, kernel: k.kernel });
      await plate(h);
      await ok(h, 'sketch', disc('Pocket sketch', 'Plate.end', 0, 0));
      h.fake.emitTurn({ id: 't-1', title: 'A pocket' });
      const same = unchanged(h);
      const held = k.hold(overlapCheck);
      const r = h.call('extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', op: 'cut' }), { turn: 't-1' });
      await held;
      // The Assistant's own Extrude panel is still open (its draft fails): the person's Escape takes it over.
      expect(uiFor(h.services).state.get().panel).toMatchObject({ kind: 'feature', owner: 'assistant', type: 'extrude' });
      uiFor(h.services).closePanel();
      k.release();
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'taken_over', why: 'escape' } } });
      same();
      expect(runtimeOf(h.services)!.pause.get()).toMatchObject({ why: 'take_over', turn: 't-1' });
    },
    REAL_KERNEL_MS,
  );

  it(
    'a kernel restart while the miss is checked leaves the sub-reason out; nothing is kept',
    async () => {
      const k = holdingKernel();
      h = await assistantHarness({ sketchMode: true, kernel: k.kernel });
      await plate(h);
      await ok(h, 'sketch', disc('Pocket sketch', 'Plate.end', 0, 0));
      const same = unchanged(h);
      const respawns = h.services.kernel.status.get().respawns;
      const held = k.hold(overlapCheck);
      const r = h.call('extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', op: 'cut' }));
      await held;
      const restarted = k.restart();
      k.release();
      await restarted;
      const out = await r;
      expect(h.services.kernel.status.get().respawns).toBe(respawns + 1);
      expect(out).toMatchObject({ ok: false, error: { code: 'failed', detail: { reason: 'feature_failed', feature: 'Pocket' } } });
      const e = (out as { error: Err }).error;
      expect(e.detail.sub).toBeUndefined();
      expect(e.message).toMatch(/Which way it missed could not be checked \(the geometry kernel restarted\)\. On Pocket sketch, u runs \+X, v runs \+Y, origin \(0, 0, 6\)\.$/);
      await h.settle();
      same();
    },
    REAL_KERNEL_MS,
  );

  it(
    "a kernel restart while a scoped cut's volumes are read answers busy changed; nothing is kept",
    async () => {
      const k = holdingKernel();
      h = await assistantHarness({ sketchMode: true, kernel: k.kernel });
      await plate(h);
      await ok(h, 'sketch', disc('Pocket sketch', 'Plate.end', 0, 0));
      const same = unchanged(h);
      // The scoped check's first volume (props with volume and no box, after the cut's Done; the Part's own builds pass bbox_mode).
      const held = k.hold((op, params) => op === 'props' && params.volume === true && params.bbox === 'none' && !('bbox_mode' in params));
      const r = h.call('extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', flip: true, op: 'cut', bodies: ['Body 1'] }));
      await held;
      const restarted = k.restart();
      k.release();
      await restarted;
      expect(await r).toMatchObject({ ok: false, error: { code: 'busy', detail: { reason: 'changed' } } });
      await h.settle();
      same();
      // Again, with nothing in the way: the cut is kept.
      await ok(h, 'extrude', EXTRUDE({ name: 'Pocket', sketch: 'Pocket sketch', distance: '3 mm', flip: true, op: 'cut', bodies: ['Body 1'] }));
      await h.settle();
      expect(volume(h)).toBeCloseTo(14400 - 25 * PI * 3, 3);
    },
    REAL_KERNEL_MS,
  );
});
