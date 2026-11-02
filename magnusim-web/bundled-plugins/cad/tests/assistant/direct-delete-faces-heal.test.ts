// @vitest-environment jsdom
// The Assistant's Delete faces (direct, kind delete_faces) on the real kernel does what the
// person's does when the heal would fill past the gap (2026-10-30; parity: the same feature
// build): Fillet 1 of every face R2, then direct delete_faces of Fillet 1's faces. On an L-block
// (Extrude, Extrude Cut) OCCT gave the full 60 x 40 x 20 box; now the heal is tried again in two
// goes and the reply is the sharp L-block. Kernel API 8 (Delete faces version 2, which the
// Assistant's Delete faces is, as the person's): on a T-block (a bar on a stem), which two goes
// cannot make right, the fillets come off as fillets: the reply is ok with the person's note, word
// for word, and Body 1 is the sharp T-block. With a hole in the bar (its rims are rings) that fails
// too: the reply says why both failed and that the body is unchanged, in the person's words. With
// one fillet left out, get_model full lists the rest, and the Assistant's edit with faces plus rest
// makes it right, as the person's Add the rest does.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { pickFace } from '../../src/features/p2/refs';
import type { DeleteFacesOutput } from '../../src/types/doc-service';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { bodyNamed, extrude, regions, Shapes, sketchOn } from './parts';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const NO_TURN = { angle: '', axis: '', pivot: [] };
const DIRECT = (o: Record<string, unknown>) => ({ edit: '', name: '', kind: 'press_pull', faces: [], distance: '', bodies: [], tool: '', keep_tool: false, move: [], turn: NO_TURN, copy: false, shape: 'box', padding: 'zero', sides: [], ...o });
type Failed = { ok: boolean; error: { code: string; message: string; detail: { reason: string; feature: string; message: string } } };
const NOTE = "Taken off as fillets up to R2 by Analysis Situs: OCCT's heal could not do it cleanly";

/** Fillet 1: every face of Body 1, radius 2 mm. Body 1's volume after it. */
async function roundAll(x: AssistantHarness): Promise<number> {
  const b = bodyNamed(x, 'Body 1');
  const faces = [];
  for (let i = 0; i < b.faces; i++) {
    const p = await pickFace(x.services, b, i, null);
    if (!p.ok) throw new Error(p.reason);
    faces.push(p.ref);
  }
  await x.add('fillet', { name: 'Fillet 1', body: b.id, edges: [], faces, radius: '2 mm' });
  return bodyNamed(x, 'Body 1').volume!;
}

/** A bar 60 x 40 x 10 on a stem 20 x 40 x 10 (32,000 mm³), with a Ø8 hole through the bar at (10, 20) when `hole`. */
async function tBlock(x: AssistantHarness, hole = false) {
  const sk1 = await sketchOn(x, 'Sketch 1', 'origin:top', new Shapes().rect('a', 0, 0, 60, 40));
  await extrude(x, 'Extrude 1', regions(x, sk1), { extent: { kind: 'two', distance: '20 mm', distance2: '-10 mm' } });
  const sk2 = await sketchOn(x, 'Sketch 2', 'origin:top', new Shapes().rect('b', 20, 0, 40, 40));
  await extrude(x, 'Extrude 2', regions(x, sk2), { op: 'join', distance: '10 mm' });
  expect(bodyNamed(x, 'Body 1').volume).toBeCloseTo(32000, 3);
  if (hole) {
    const sk3 = await sketchOn(x, 'Sketch 3', 'origin:top', new Shapes().circle('h', [10, 20], 4));
    await extrude(x, 'Extrude 3', regions(x, sk3), { op: 'cut', distance: '20 mm' });
    expect(bodyNamed(x, 'Body 1').volume).toBeCloseTo(32000 - Math.PI * 16 * 10, 3);
  }
}

/**
 * The same T as one sketch (a T outline on Front, extruded 40 mm): its fillets are whole faces (on the
 * two-extrude T the bar's split underside splits them), so get_model writes each one by its label.
 */
async function tProfile(x: AssistantHarness) {
  const s = new Shapes();
  const pts: [number, number][] = [[20, 0], [40, 0], [40, 10], [60, 10], [60, 20], [0, 20], [0, 10], [20, 10]];
  pts.forEach((p, i) => s.line(`t${i + 1}`, p, pts[(i + 1) % pts.length]));
  const sk = await sketchOn(x, 'Sketch 1', 'origin:front', s);
  await extrude(x, 'Extrude 1', regions(x, sk), { distance: '40 mm' });
  expect(bodyNamed(x, 'Body 1').volume).toBeCloseTo(32000, 3);
}

const statusOf = (x: AssistantHarness, name: string) => {
  const s = x.doc.state.get();
  const f = s.doc.features.find((g) => g.name === name)!;
  return { id: f.id, st: s.rebuild.features[f.id] };
};

describe("direct delete_faces: a heal past the gap, as the person's Delete faces", () => {
  it(
    'every blend of a rounded L-block: Delete faces 1 is ok and Body 1 is the sharp L-block (36,000 mm³)',
    async () => {
      h = await assistantHarness();
      const sk1 = await sketchOn(h, 'Sketch 1', 'origin:top', new Shapes().rect('a', 0, 0, 60, 40));
      await extrude(h, 'Extrude 1', regions(h, sk1), { distance: '20 mm' });
      const sk2 = await sketchOn(h, 'Sketch 2', 'origin:top', new Shapes().rect('b', 30, 0, 60, 40));
      await extrude(h, 'Extrude 2', regions(h, sk2), { op: 'cut', extent: { kind: 'two', distance: '20 mm', distance2: '-10 mm' } });
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(36000, 3);
      expect(await roundAll(h)).toBeCloseTo(35601.626, 2);
      const r = await h.ok('direct', DIRECT({ kind: 'delete_faces', faces: ['feature Fillet 1 faces'] }));
      expect(r.data).toMatchObject({ feature: { name: 'Delete faces 1', type: 'delete_faces', state: 'ok' } });
      expect((r.data.feature as { note?: string }).note).toBeUndefined();
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(36000, 6);
      expect(bodyNamed(h, 'Body 1').faces).toBe(8);
    },
    REAL_KERNEL_MS,
  );

  it(
    "every blend of a rounded T-block: the fillets come off as fillets; the reply is ok with the person's note, and Body 1 is the sharp T-block",
    async () => {
      h = await assistantHarness();
      await tBlock(h);
      await roundAll(h);
      const r = await h.ok('direct', DIRECT({ kind: 'delete_faces', faces: ['feature Fillet 1 faces'] }));
      expect(r.data).toMatchObject({ feature: { name: 'Delete faces 1', type: 'delete_faces', state: 'ok', note: NOTE } });
      // The same feature as the person's: version 2, and the note their panel and tree show, word for word.
      const { id, st } = statusOf(h, 'Delete faces 1');
      expect(h.doc.state.get().doc.features.find((f) => f.id === id)).toMatchObject({ version: 2 });
      expect((r.data.feature as { note: string }).note).toBe(st.note);
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(32000, 6);
      expect(bodyNamed(h, 'Body 1').faces).toBe(10);
      // get_model says it too, and lists no rest.
      const full = (await h.ok('get_model', { detail: 'full', feature: 'Delete faces 1' })).data.feature as Record<string, unknown>;
      expect(full).toMatchObject({ state: 'ok', note: NOTE });
      expect(full.rest).toBeUndefined();
    },
    REAL_KERNEL_MS,
  );

  it(
    'a T-block with a hole in its bar (the rims are rings): Delete faces 1 fails, says why both ways failed and that the body is unchanged, as the person reads it',
    async () => {
      h = await assistantHarness();
      await tBlock(h, true);
      const v0 = await roundAll(h);
      const faces0 = bodyNamed(h, 'Body 1').faces;
      // Fillet 1's faces are every fillet, the hole's rims among them (its wall is Extrude 3's).
      const r = (await h.call('direct', DIRECT({ kind: 'delete_faces', faces: ['feature Fillet 1 faces'] }))) as unknown as Failed;
      expect(r.ok).toBe(false);
      expect(r.error.detail).toMatchObject({ reason: 'feature_failed', feature: 'Delete faces 1' });
      const message = r.error.detail.message;
      expect(message).toMatch(
        /^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add [\d,.]+ mm³ over faces you kept \([^)]*\); taking them off as fillets did not work either: 1 of the 42 fillet faces could not be taken off \(a ring round a boss or a hole cannot be taken off as a fillet\); the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead$/,
      );
      // The person's words (the feature's own build), whole: the reply carries them.
      expect(r.error.message).toContain(message);
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(v0, 6);
      expect(bodyNamed(h, 'Body 1').faces).toBe(faces0);
    },
    REAL_KERNEL_MS,
  );

  it(
    "one fillet of the T-block left out: get_model full lists the rest the person's Add the rest adds, and an edit with faces plus rest takes them off as fillets",
    async () => {
      h = await assistantHarness();
      await tProfile(h);
      await roundAll(h);
      const b = bodyNamed(h, 'Body 1');
      const t = (await h.services.kernel.call('topo', { id: b.shape, edges: 'none', vertices: 'none', face_bbox: 'none' })).result;
      const round = t.faces.filter((f) => f.type !== 'plane').map((f) => f.i);
      expect(round).toHaveLength(40);
      // The person's Delete faces of all but the first (their clicks: references by name).
      const refs = [];
      for (const i of round.slice(1)) {
        const p = await pickFace(h.services, b, i, null);
        if (!p.ok) throw new Error(p.reason);
        refs.push(p.ref);
      }
      await h.add('delete_faces', { body: b.id, faces: refs });
      const { id, st } = statusOf(h, 'Delete faces 1');
      expect(st.state).toBe('error');
      expect(st.message).toMatch(/\. Every fillet up to R2 on Body 1 is 40 faces and 39 are picked: with all 40, Delete faces can take them off as fillets$/);
      const out = h.doc.state.get().rebuild.outputs[id] as DeleteFacesOutput;
      expect(out.restRefs.map((x) => x.name)).toEqual([b.names!.faces[round[0]]]);
      // get_model full: the same words, and the rest (the panel's Add the rest) as one face selector.
      const full = (await h.ok('get_model', { detail: 'full', feature: 'Delete faces 1' })).data.feature as { message: string; rest: string[]; inputs: { faces: string[] } };
      expect(full.message).toBe(st.message);
      expect(full.rest).toHaveLength(1);
      expect(full.inputs.faces).toHaveLength(39);
      expect(full.inputs.faces).not.toContain(full.rest[0]);
      // The Assistant's edit with faces plus rest: every fillet up to R2, so ok as fillets, the sharp T-block.
      const r = await h.ok('direct', DIRECT({ edit: 'Delete faces 1', kind: 'delete_faces', faces: [...full.inputs.faces, ...full.rest] }));
      expect(r.data).toMatchObject({ feature: { name: 'Delete faces 1', state: 'ok', note: NOTE } });
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(32000, 6);
    },
    REAL_KERNEL_MS,
  );
});
