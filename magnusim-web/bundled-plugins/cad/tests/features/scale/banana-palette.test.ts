// The banana's snap guide (features/scale/view.ts) in the view's palette: the light view's blue,
// the dark view's light blue, and in a dark view the light view's blue over a light face (E2: its
// material's face ink, which the view draws as a twin, src/viewport/onface.ts; none in light),
// from when the banana is shown and as the palette changes. The banana's mesh file is left out
// (a one-triangle stand-in); only its layer's wiring runs.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Group, type Line, type LineBasicMaterial } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBananaView } from '../../../src/features/scale/view';
import { createStateStore } from '../../../src/lib/store';
import type { AppServices } from '../../../src/types/app';
import type { ViewportHandle } from '../../../src/types/viewport';
import { faceInkOf } from '../../../src/viewport/onface';
import { DARK, LIGHT, type MarkPalette } from '../../../src/viewport/palette';

vi.mock('../../../src/features/scale/banana-mesh', async (orig) => ({
  ...(await orig<typeof import('../../../src/features/scale/banana-mesh')>()),
  loadBanana: async () => ({ positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), colors: new Float32Array(9), indices: new Uint16Array([0, 1, 2]), min: [-17, -104, 0], max: [17, 104, 82], length: 208 }),
}));

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  document.body.innerHTML = '';
});

/** A view with the banana's layer: its group and its palette hook kept. */
function app(start: MarkPalette) {
  let palette = start;
  const groups = new Map<string, Group>();
  const hooks = new Map<string, (p: MarkPalette) => void>();
  const handle = {
    palette: () => palette,
    addLayer(id: string, o: { palette?: (p: MarkPalette) => void } = {}) {
      const group = new Group();
      groups.set(id, group);
      if (o.palette) hooks.set(id, o.palette);
      const html = document.createElement('div');
      document.body.appendChild(html);
      return { id, group, html, setVisible() {}, changed() {}, dispose: () => html.remove() };
    },
    pushTool: () => () => {},
  } as unknown as ViewportHandle;
  const state = createStateStore({ status: 'ready', view: { scaleModels: { banana: { at: [0, 0, 0], rot: 0 } } }, rebuild: { bodies: [] } } as never);
  const services = { doc: { state }, viewport: createStateStore({ handle }), bridge: { toast: vi.fn() } } as unknown as AppServices;
  offs.push(installBananaView(services));
  const setPalette = (p: MarkPalette) => {
    palette = p;
    hooks.get('scale-banana')!(p);
  };
  return { groups, setPalette };
}

/** The guide's material, once the banana is shown. */
async function guideOf(groups: Map<string, Group>): Promise<LineBasicMaterial> {
  await vi.waitFor(() => expect(groups.get('scale-banana')?.children.some((o) => (o as Line).isLine)).toBe(true));
  return (groups.get('scale-banana')!.children.find((o) => (o as Line).isLine) as Line).material as LineBasicMaterial;
}

describe("the banana's snap guide and the palette", () => {
  it("is the light view's blue in light, the dark view's in dark with the light view's over a light face, and follows a new palette", async () => {
    const v = app(LIGHT);
    const guide = await guideOf(v.groups);
    expect([guide.color.getHex(), faceInkOf(guide) ?? null]).toEqual([LIGHT.ink, null]);
    v.setPalette(DARK);
    expect([guide.color.getHex(), faceInkOf(guide) ?? null]).toEqual([DARK.ink, LIGHT.ink]);
    expect(DARK.ink).toBe(0x7aa7ff);
    expect(LIGHT.ink).toBe(0x1570ef);
    v.setPalette(LIGHT);
    expect([guide.color.getHex(), faceInkOf(guide) ?? null]).toEqual([LIGHT.ink, null]);
  });

  it('shown while the view is dark: dark from the start, its face ink the light blue', async () => {
    const v = app(DARK);
    const guide = await guideOf(v.groups);
    expect([guide.color.getHex(), faceInkOf(guide) ?? null]).toEqual([DARK.ink, LIGHT.ink]);
  });
});
