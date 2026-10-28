// The measure line and its ends take the view's palette (features/measure/overlay.ts): the light
// view's darker blue, the dark view's lighter --cad-p2-measure (the label's), recoloured live, and
// in a dark view the light view's blue over a light face (E2: their materials' face ink, which the
// view draws as a twin, src/viewport/onface.ts; none in light); a picture leaves the measure out
// (SNAPSHOT_HIDDEN_LAYERS), so it never needs LIGHT for one.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Group, type Line, type Points } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { createMeasureMarks } from '../../../src/features/measure/overlay';
import type { ViewportHandle } from '../../../src/types/viewport';
import { SNAPSHOT_HIDDEN_LAYERS } from '../../../src/viewport/snapshot';
import { faceInkOf } from '../../../src/viewport/onface';
import { DARK, LIGHT, type MarkPalette } from '../../../src/viewport/palette';

afterEach(() => {
  document.body.innerHTML = '';
});

function fakeHandle(start: MarkPalette) {
  const hooks = new Map<string, (p: MarkPalette) => void>();
  const group = new Group();
  const handle = {
    palette: () => start,
    addLayer(id: string, o: { palette?: (p: MarkPalette) => void } = {}) {
      if (o.palette) hooks.set(id, o.palette);
      const html = document.createElement('div');
      document.body.appendChild(html);
      return { id, group, html, setVisible() {}, changed() {}, dispose: () => html.remove() };
    },
    onFrame: () => () => {},
    project: () => [10, 10] as [number, number],
  };
  return { handle: handle as unknown as ViewportHandle, hooks, group };
}

const colours = (g: Group) => g.children.map((o) => ((o as Line | Points).material as unknown as { color: { getHex(): number } }).color.getHex());
const faceInks = (g: Group) => g.children.map((o) => faceInkOf((o as Line | Points).material as never) ?? null);

describe('the measure marks and the palette', () => {
  it('start in the view palette, follow a new one, and are left out of pictures', () => {
    const v = fakeHandle(LIGHT);
    const marks = createMeasureMarks(v.handle);
    marks.show([0, 0, 0], [10, 0, 0], '10 mm');
    expect(colours(v.group)).toEqual([0x1a4fbf, 0x1a4fbf]);
    expect(faceInks(v.group)).toEqual([null, null]);
    v.hooks.get('p2-measure')!(DARK);
    expect(colours(v.group)).toEqual([0x8fb5ff, 0x8fb5ff]);
    expect(faceInks(v.group)).toEqual([LIGHT.measure, LIGHT.measure]);
    v.hooks.get('p2-measure')!(LIGHT);
    expect(colours(v.group)).toEqual([LIGHT.measure, LIGHT.measure]);
    expect(faceInks(v.group)).toEqual([null, null]);
    expect(SNAPSHOT_HIDDEN_LAYERS.has('p2-measure')).toBe(true);
    marks.dispose();
    // Opened while the view is dark: dark from the start.
    const d = fakeHandle(DARK);
    const dm = createMeasureMarks(d.handle);
    dm.show([0, 0, 0], [0, 5, 0], '5 mm');
    expect(colours(d.group)).toEqual([DARK.measure, DARK.measure]);
    expect(faceInks(d.group)).toEqual([LIGHT.measure, LIGHT.measure]);
    dm.dispose();
  });
});
