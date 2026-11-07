// A tapped hole's cosmetic thread in the view (features/hole/threads.ts) and in words (sizes.ts
// threadWords, get_model's row and the Extrude panel), on the REAL kernel: the helix runs along
// that hole's own wall as the body has it, not a cut's distance or the body's box; a blind hole
// deeper than the body (Magnusim CAD issue 14) is drawn and said as through; a hidden body's
// threads are not drawn, and come back with it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Box3, Group } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installThreads } from '../../../src/features/hole/threads';
import { threadWords } from '../../../src/features/hole/sizes';
import type { ExtrudeFeature } from '../../../src/types/doc';
import type { ViewportHandle } from '../../../src/types/viewport';
import { EXTRUDE, ok } from '../../assistant/extrude-tools';
import { assistantHarness, type AssistantHarness } from '../../assistant/harness';
import { block, E, featureNamed, SK, type Row } from '../../assistant/sketch-tools';

let h: AssistantHarness | null = null;
const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  h?.dispose();
  h = null;
  document.body.innerHTML = '';
});

const MS = 240_000;
const HOLE = (o: Row = {}): Row => ({ name: '', face: 'Base.end', centers: [], points: '', diameter: '', size: 'M6', fit: 'tapped', depth: 'through', distance: '', type: 'simple', cb_diameter: '', cb_depth: '', cs_diameter: '', cs_angle: '', tip: '', thread: 'cosmetic', ...o });
const CTR = (x: string, y: string) => ({ x, y, z: '' });

/** A viewport with layers only (no drawing): the thread layer's group and its labels. */
function fakeHandle() {
  const groups = new Map<string, Group>();
  const handle = {
    addLayer(id: string) {
      const group = new Group();
      groups.set(id, group);
      const html = document.createElement('div');
      document.body.appendChild(html);
      return { id, group, html, setVisible() {}, changed() {}, dispose: () => html.remove() };
    },
    onFrame: () => () => {},
    project: () => [10, 10] as [number, number],
    lineResolution: () => [800, 600] as [number, number],
  };
  return { handle: handle as unknown as ViewportHandle, groups };
}

/** Each drawn helix's span along Z (the holes run along Z here), and the labels shown. */
function drawn(groups: Map<string, Group>): { z: [number, number][]; labels: string[] } {
  const g = groups.get('hole.threads');
  const z = (g?.children ?? []).map((o) => {
    const box = new Box3().setFromObject(o);
    return [box.min.z, box.max.z] as [number, number];
  });
  return { z, labels: [...document.querySelectorAll<HTMLElement>('.cad-thread-label')].map((l) => l.dataset.thread ?? '') };
}

const words = (x: AssistantHarness, name: string) => {
  const s = x.doc.state.get();
  return threadWords(s.doc.features, s.rebuild.features, featureNamed<ExtrudeFeature>(x, name), s.rebuild.bodies);
};

describe('a cosmetic thread', () => {
  it(
    "runs along its hole's own wall: a blind hole deeper than the body is drawn and said as through, a through hole beside a foot only as far as its wall; a hidden body's are not drawn",
    async () => {
      h = await assistantHarness({ sketchMode: true });
      // The 10 mm block (z 0..10) with a foot under its +X half (z -10..0).
      await block(h);
      await ok(h, 'sketch', SK({ name: 'Foot sketch', entities: [E('r', 'rect', [0, -20, 30, 20])] }));
      await ok(h, 'extrude', EXTRUDE({ name: 'Foot', sketch: 'Foot sketch', distance: '10 mm', flip: true, op: 'join' }));
      const { handle, groups } = fakeHandle();
      h.services.viewport.set({ handle });
      offs.push(installThreads(h.services));

      // Issue 14: blind 20 mm where the block is 10 mm: the thread runs z 10 down to 0, not to -10.
      await ok(h, 'hole', HOLE({ name: 'Deep', centers: [CTR('-15 mm', '10 mm')], depth: 'blind', distance: '20 mm' }));
      await vi.waitFor(() => expect(drawn(groups).z).toHaveLength(1), { timeout: 60_000 });
      expect(drawn(groups).z[0][0]).toBeCloseTo(0, 6);
      expect(drawn(groups).z[0][1]).toBeCloseTo(10, 6);
      expect(words(h, 'Deep')).toBe('M6x1 thread, through the hole (its 20 mm reaches through the body there) (cosmetic: drawn and listed, not modelled)');
      // get_model's row says the same (with no view: get_model reads the camera of a real one).
      h.services.viewport.set({ handle: null });
      const row = ((await ok(h, 'get_model', { detail: 'brief' })).data.features as Row[]).find((f) => f.name === 'Deep');
      expect(row).toMatchObject({ thread: words(h, 'Deep') });
      h.services.viewport.set({ handle });
      await vi.waitFor(() => expect(drawn(groups).z).toHaveLength(1), { timeout: 60_000 });

      // Through, at x -15: its wall is the block's 10 mm, though the body's box runs down to -10.
      await ok(h, 'hole', HOLE({ name: 'Through', centers: [CTR('-15 mm', '-10 mm')] }));
      await vi.waitFor(() => expect(drawn(groups).z).toHaveLength(2), { timeout: 60_000 });
      for (const [lo, hi] of drawn(groups).z) {
        expect(lo).toBeCloseTo(0, 6);
        expect(hi).toBeCloseTo(10, 6);
      }
      expect(words(h, 'Through')).toBe('M6x1 thread, the whole hole (cosmetic: drawn and listed, not modelled)');
      // A blind hole that keeps its bottom: as deep as asked.
      await ok(h, 'hole', HOLE({ name: 'Kept', centers: [CTR('15 mm', '0 mm')], depth: 'blind', distance: '12 mm' }));
      await vi.waitFor(() => expect(drawn(groups).z).toHaveLength(3), { timeout: 60_000 });
      expect(words(h, 'Kept')).toBe('M6x1 thread, 12 mm deep (cosmetic: drawn and listed, not modelled)');
      expect(drawn(groups).labels.sort()).toEqual(['Deep', 'Kept', 'Through']);

      // The body hidden: its threads and their labels go; shown again, they come back.
      const body = h.doc.state.get().rebuild.bodies[0].id;
      h.doc.setBodyVisible(body, false);
      await vi.waitFor(() => expect(drawn(groups)).toEqual({ z: [], labels: [] }), { timeout: 60_000 });
      h.doc.setBodyVisible(body, true);
      await vi.waitFor(() => expect(drawn(groups).z).toHaveLength(3), { timeout: 60_000 });
    },
    MS,
  );
});
