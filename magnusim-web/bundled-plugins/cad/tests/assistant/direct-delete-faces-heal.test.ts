// @vitest-environment jsdom
// The Assistant's Delete faces (direct, kind delete_faces) on the real kernel does what the
// person's does when the heal would fill past the gap (2026-10-30; parity: the same feature
// build): Fillet 1 of every face R2, then direct delete_faces of Fillet 1's faces. On an L-block
// (Extrude, Extrude Cut) OCCT gave the full 60 x 40 x 20 box; now the heal is tried again in two
// goes and the reply is the sharp L-block. On a T-block (a bar on a stem) that cannot be made
// right: the reply says the feature fails, why, and that the body is unchanged, in the person's
// words, and Body 1 keeps Fillet 1's volume.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { pickFace } from '../../src/features/p2/refs';
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
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(36000, 6);
      expect(bodyNamed(h, 'Body 1').faces).toBe(8);
    },
    REAL_KERNEL_MS,
  );

  it(
    'every blend of a rounded T-block: Delete faces 1 fails, says what the heal would do and that the body is unchanged',
    async () => {
      h = await assistantHarness();
      const sk1 = await sketchOn(h, 'Sketch 1', 'origin:top', new Shapes().rect('a', 0, 0, 60, 40));
      await extrude(h, 'Extrude 1', regions(h, sk1), { extent: { kind: 'two', distance: '20 mm', distance2: '-10 mm' } });
      const sk2 = await sketchOn(h, 'Sketch 2', 'origin:top', new Shapes().rect('b', 20, 0, 40, 40));
      await extrude(h, 'Extrude 2', regions(h, sk2), { op: 'join', distance: '10 mm' });
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(32000, 3);
      const v0 = await roundAll(h);
      const faces0 = bodyNamed(h, 'Body 1').faces;
      const r = (await h.call('direct', DIRECT({ kind: 'delete_faces', faces: ['feature Fillet 1 faces'] }))) as unknown as Failed;
      expect(r.ok).toBe(false);
      expect(r.error.detail).toMatchObject({ reason: 'feature_failed', feature: 'Delete faces 1' });
      // The person's panel words (the feature's own build), whole.
      const message = r.error.detail.message;
      expect(message).toMatch(/^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add 16,39\d\.\d+ mm³ over faces you kept \([^)]*Extrude [12][^)]*\); the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead$/);
      expect(r.error.message).toContain(message);
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(v0, 6);
      expect(bodyNamed(h, 'Body 1').faces).toBe(faces0);
    },
    REAL_KERNEL_MS,
  );
});
