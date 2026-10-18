// One "<plane> offset <length>" is one construction plane, whichever tool asks for it (CAD tools
// spec §6.2 for a sketch's `on`, §3.2.12 for a mirror's `about`), on the REAL kernel, through the
// page's tool handler, on a 60 x 40 x 6 plate (Body 1):
//   - a mirror about "Right offset 40" uses the plane a sketch made on "Right offset 40 mm";
//   - a sketch on "Top offset 12 mm" lies on the plane a mirror made about "Top offset 12";
//   - a bare number is stored in the Part's length unit by both tools ("12 mm").
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import type { MirrorFeature, RefPlaneFeature } from '../../src/types/doc';
import { assistantHarness, REAL_KERNEL_MS, type AssistantHarness } from './harness';
import { plate } from './parts';
import { E, featureNamed, SK } from './sketch-tools';

let h: AssistantHarness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

const MIRROR = (about: string) => ({
  edit: '',
  name: '',
  kind: 'mirror',
  of: 'bodies',
  items: ['Body 1'],
  about,
  count: '',
  spacing: '',
  symmetric: false,
  flip: false,
  about2: '',
  count2: '',
  spacing2: '',
  flip2: false,
  op: 'new',
  bodies: [],
});
const planes = (x: AssistantHarness) => x.doc.state.get().doc.features.filter((f): f is RefPlaneFeature => f.type === 'ref_plane');

describe('offset planes the sketch tool and a mirror share', () => {
  it(
    'a mirror about an offset a sketch already made uses that plane',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      await h.ok('sketch', SK({ name: 'Side sk', on: 'Right offset 40 mm', entities: [E('c', 'circle', [0, 3, 2])] }));
      const plane = featureNamed<RefPlaneFeature>(h, 'Side sk plane');
      expect(plane).toMatchObject({ method: 'offset', plane: { kind: 'origin', plane: 'origin:right' }, distance: '40 mm', flip: false });
      // The same offset written as a bare number: the mirror finds the sketch's plane.
      const m = await h.ok('pattern', MIRROR('Right offset 40'));
      expect(m.data.plane).toBeUndefined();
      expect(planes(h).map((p) => p.name)).toEqual(['Side sk plane']);
      expect(featureNamed<MirrorFeature>(h, 'Mirror 1').plane).toEqual({ kind: 'feature', feature: plane.id });
      const copy = h.doc.state.get().rebuild.bodies.find((b) => b.name !== 'Body 1')!;
      expect(copy.bbox.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([50, -20, 0, 110, 20, 6]);
    },
    REAL_KERNEL_MS,
  );

  it(
    'a sketch on an offset a mirror already made lies on that plane, stored in the Part\'s unit',
    async () => {
      h = await assistantHarness({ sketchMode: true });
      await plate(h);
      const m = await h.ok('pattern', MIRROR('Top offset 12'));
      expect(m.data.plane).toBe('Plane 1');
      const plane = featureNamed<RefPlaneFeature>(h, 'Plane 1');
      expect(plane).toMatchObject({ method: 'offset', plane: { kind: 'origin', plane: 'origin:top' }, distance: '12 mm', flip: false });
      await h.ok('sketch', SK({ name: 'Lid sk', on: 'Top offset 12 mm', entities: [E('c', 'circle', [0, 0, 5])] }));
      expect(featureNamed(h, 'Lid sk').support).toEqual({ kind: 'feature', feature: plane.id });
      expect(planes(h).map((p) => p.name)).toEqual(['Plane 1']);
    },
    REAL_KERNEL_MS,
  );
});
