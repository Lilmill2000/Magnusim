// @vitest-environment jsdom
// The Assistant's Delete faces (direct, kind delete_faces) on the real kernel gets the person's
// refusal word for word when the heal would fill past the gap (2026-10-30): an L-block (Extrude,
// Extrude Cut), Fillet 1 of every face R2, then direct delete_faces of Fillet 1's faces. OCCT
// gave the full 60 x 40 x 20 box; the reply now says the feature fails, why, and that the body
// is unchanged, and Body 1 keeps Fillet 1's volume (parity: the same feature build).
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

describe('direct delete_faces: a heal past the gap is refused in the person\'s words', () => {
  it(
    'every blend of a rounded L-block: Delete faces 1 fails, says what the heal would do and that the body is unchanged',
    async () => {
      h = await assistantHarness();
      const sk1 = await sketchOn(h, 'Sketch 1', 'origin:top', new Shapes().rect('a', 0, 0, 60, 40));
      await extrude(h, 'Extrude 1', regions(h, sk1), { distance: '20 mm' });
      const sk2 = await sketchOn(h, 'Sketch 2', 'origin:top', new Shapes().rect('b', 30, 0, 60, 40));
      await extrude(h, 'Extrude 2', regions(h, sk2), { op: 'cut', extent: { kind: 'two', distance: '20 mm', distance2: '-10 mm' } });
      const b = bodyNamed(h, 'Body 1');
      expect(b.volume).toBeCloseTo(36000, 3);
      const faces = [];
      for (let i = 0; i < b.faces; i++) {
        const p = await pickFace(h.services, b, i, null);
        if (!p.ok) throw new Error(p.reason);
        faces.push(p.ref);
      }
      await h.add('fillet', { name: 'Fillet 1', body: b.id, edges: [], faces, radius: '2 mm' });
      const v0 = bodyNamed(h, 'Body 1').volume!;
      expect(v0).toBeCloseTo(35601.626, 2);
      const r = (await h.call('direct', DIRECT({ kind: 'delete_faces', faces: ['feature Fillet 1 faces'] }))) as unknown as { ok: boolean; error: { code: string; message: string; detail: { reason: string; feature: string; message: string } } };
      expect(r.ok).toBe(false);
      expect(r.error.detail).toMatchObject({ reason: 'feature_failed', feature: 'Delete faces 1' });
      // The person's panel words (the feature's own build), whole.
      const message = r.error.detail.message;
      expect(message).toMatch(/^Delete faces 1 failed: healing filled more than the gap the deleted faces leave: it would add 12,398\.\d+ mm³ over faces you kept \([^)]*Extrude 2[^)]*\); the body is unchanged\. To take the whole fillet off, delete Fillet 1 instead$/);
      expect(r.error.message).toContain(message);
      expect(bodyNamed(h, 'Body 1').volume).toBeCloseTo(v0, 6);
      expect(bodyNamed(h, 'Body 1').faces).toBe(38);
    },
    REAL_KERNEL_MS,
  );
});
