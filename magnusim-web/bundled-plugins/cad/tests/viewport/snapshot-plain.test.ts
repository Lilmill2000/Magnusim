// A snapshot draws without the selection, hover and flash colours (ViewportHandle.snapshot, spec
// §9.1 step 4). The viewport clears its own highlight; the overlay layers that colour by the
// selection or hover draw plain through addLayer's `plain` hook, which the snapshot calls with
// true before it draws and false after (camera-count.test.ts pins that order on the real viewport):
//   - the profile regions (profiles.regions): a selected region, the open Extrude's profiles
//     (pick green) and the hovered region (hover blue) in the normal shading, their states kept;
//   - the reference geometry (CONSTRUCT): a selected or edited plane in its plain look, and the
//     origin's axes drawn only because they are selected or hovered left out.
// Both come back as they were when the hook is called with false.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Group, type LineBasicMaterial, type LineLoop, type Mesh, type MeshBasicMaterial } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { LAYER_CONSTRUCT, ConstructOverlay } from '../../src/features/refgeom/overlay';
import { constructView } from '../../src/features/refgeom/scene';
import { LAYER_REGIONS, ProfileOverlay } from '../../src/features/sketch/overlay';
import { profilesView } from '../../src/features/sketch/view';
import { createSelectionStore } from '../../src/lib/selection';
import { createStateStore } from '../../src/lib/store';
import type { AppServices } from '../../src/types/app';
import type { Mode } from '../../src/types/commands';
import type { SketchOutput, SketchRegion } from '../../src/types/sketch';
import type { ViewportHandle } from '../../src/types/viewport';
import { HOVER_COLOR, PICK_COLOR, PLANE_BORDER, PLANE_FILL, PLANE_PICK_FILL } from '../../src/viewport/colors';
import { DARK, LIGHT, type MarkPalette } from '../../src/viewport/palette';
import { wantOriginAxes } from '../../src/features/refgeom/scene';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  document.body.innerHTML = '';
});

/** A viewport handle with what the overlays use; addLayer keeps each layer's group and options. */
function fakeHandle() {
  const layers = new Map<string, { group: Group; plain?: (on: boolean) => void; palette?: (p: MarkPalette) => void }>();
  const handle = {
    addLayer(id: string, o: { plain?: (on: boolean) => void; palette?: (p: MarkPalette) => void } = {}) {
      const group = new Group();
      layers.set(id, { group, plain: o.plain, palette: o.palette });
      const html = document.createElement('div');
      document.body.appendChild(html);
      return { id, group, html, setVisible() {}, changed() {}, dispose: () => html.remove() };
    },
    onFrame: () => () => {},
    setPlanesBusy() {},
    pixelSize: () => 0.1,
    project: () => [10, 10] as [number, number],
    pick: () => null,
    lineResolution: () => [800, 600] as [number, number],
  };
  return { handle: handle as unknown as ViewportHandle, layers };
}

function services(state: unknown) {
  return {
    doc: { state: createStateStore(state as never), features: { get: () => ({ parents: () => [] }) } },
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
  } as unknown as AppServices;
}

const SK = 'f_sk';
const region = (key: string, du: number): SketchRegion => ({
  key,
  loops: [],
  entities: [],
  area: 50,
  sample: [du + 7, 2],
  bbox: [du, 0, du + 10, 10],
  tri: { uv: new Float32Array([du, 0, du + 10, 0, du + 10, 10]), idx: new Uint32Array([0, 1, 2]) },
});

describe('the profile regions in a snapshot', () => {
  it('a selected, a used and a hovered region draw in the normal shading, then as they were', () => {
    const output: SketchOutput = {
      type: 'sketch',
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
      points: {},
      radii: {},
      curves: [],
      regions: [region('r1', 0), region('r2', 20), region('r3', 40), region('r4', 60)],
      open: [],
      dangling: [],
      measured: {},
      source: 'stored',
    };
    const s = services({
      doc: { features: [{ id: SK, type: 'sketch', name: 'Sketch 1', entities: [], constraints: [] }] },
      view: { sketches: { [SK]: 'shown' } },
      rebuild: { outputs: { [SK]: output }, bodies: [], features: {} },
      session: null,
    });
    // r1 selected, r2 the open Extrude's profile, r3 under the pointer, r4 nothing.
    s.selection.set((x) => ({ ...x, items: [{ kind: 'region', feature: SK, key: 'r1' }] }));
    profilesView(s).set({ used: [{ feature: SK, key: 'r2' }], hover: { feature: SK, key: 'r3' } });
    const { handle, layers } = fakeHandle();
    const overlay = new ProfileOverlay(s, handle);
    disposers.push(() => overlay.dispose());
    overlay.sync();
    const meshes = layers.get(LAYER_REGIONS)!.group.children as Mesh<never, MeshBasicMaterial>[];
    const look = () => Object.fromEntries(meshes.map((m) => [m.userData.key as string, [m.userData.state as string, m.material.opacity]]));
    const before = look();
    expect(before).toEqual({ r1: ['picked', 0.4], r2: ['picked', 0.4], r3: ['hover', 0.55], r4: ['normal', 0.12] });

    const plain = layers.get(LAYER_REGIONS)!.plain!;
    plain(true);
    // Drawn plain at once (the snapshot draws in this task); the states are kept.
    expect(look()).toEqual({ r1: ['picked', 0.12], r2: ['picked', 0.12], r3: ['hover', 0.12], r4: ['normal', 0.12] });
    plain(false);
    expect(look()).toEqual(before);
  });
});

describe('the reference geometry in a snapshot', () => {
  it('a selected plane draws in its plain look, an origin axis shown for its selection is left out; both come back', () => {
    const s = services({
      doc: { features: [{ id: 'f_pl', type: 'ref_plane', name: 'Plane 1' }] },
      view: {},
      rebuild: { outputs: { f_pl: { type: 'plane', frame: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] } } }, bodies: [], features: {} },
      session: null,
    });
    s.selection.set((x) => ({ ...x, items: [{ kind: 'feature', feature: 'f_pl' }, { kind: 'origin', ref: 'origin:x' }] }));
    constructView(s).set({ hover: 'origin:y' });
    const { handle, layers } = fakeHandle();
    const overlay = new ConstructOverlay(s, handle);
    disposers.push(() => overlay.dispose());
    const group = layers.get(LAYER_CONSTRUCT)!.group;
    const fill = () => (group.children.find((o) => o.name === 'construct:f_pl') as Mesh<never, MeshBasicMaterial>).material;
    const border = () => group.children.find((o) => o.type === 'LineLoop') as LineLoop<never, LineBasicMaterial>;
    const axes = () => group.children.filter((o) => o.name.startsWith('construct:origin:')).map((o) => o.name);
    expect(overlay.states()).toEqual({ f_pl: 'pick', 'origin:x': 'pick', 'origin:y': 'hover' });
    expect(fill().opacity).toBe(PLANE_PICK_FILL.opacity);
    expect(border().material.opacity).toBe(0.9);
    expect(new Set(axes())).toEqual(new Set(['construct:origin:x', 'construct:origin:y']));

    const plain = layers.get(LAYER_CONSTRUCT)!.plain!;
    plain(true);
    expect(fill().opacity).toBe(PLANE_FILL.opacity);
    expect(fill().color.getHex()).toBe(PLANE_FILL.color);
    expect(border().material.color.getHex()).toBe(PLANE_BORDER.color);
    expect(border().material.opacity).toBe(PLANE_BORDER.opacity);
    expect(axes()).toEqual([]);
    expect(overlay.states()).toEqual({ f_pl: 'pick' });

    plain(false);
    expect(overlay.states()).toEqual({ f_pl: 'pick', 'origin:x': 'pick', 'origin:y': 'hover' });
    expect(fill().opacity).toBe(PLANE_PICK_FILL.opacity);
    expect(border().material.opacity).toBe(0.9);
    expect(new Set(axes())).toEqual(new Set(['construct:origin:x', 'construct:origin:y']));
  });
});

describe('the reference geometry and the palette', () => {
  it("draws axes and points at rest in the palette's construct colour (light in a dark view, LIGHT for a picture); tints, hover and pick stay", () => {
    const s = services({
      doc: { features: [{ id: 'f_pl', type: 'ref_plane', name: 'Plane 1' }] },
      view: {},
      rebuild: { outputs: { f_pl: { type: 'plane', frame: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] } } }, bodies: [], features: {} },
      session: null,
    });
    wantOriginAxes(s, 'test', true);
    constructView(s).set({ hover: 'origin:y' });
    const { handle, layers } = fakeHandle();
    const overlay = new ConstructOverlay(s, handle);
    disposers.push(() => overlay.dispose());
    const group = layers.get(LAYER_CONSTRUCT)!.group;
    const colour = (name: string) => (group.children.find((o) => o.name === name) as unknown as { material: { color: { getHex(): number } } }).material.color.getHex();
    const look = () => [colour('construct:origin:x'), colour('construct:origin:y'), colour('construct:f_pl')];
    expect(look()).toEqual([LIGHT.constructLine, HOVER_COLOR, PLANE_FILL.color]);
    const palette = layers.get(LAYER_CONSTRUCT)!.palette!;
    palette(DARK);
    expect(look()).toEqual([DARK.constructLine, HOVER_COLOR, PLANE_FILL.color]);
    s.selection.set((x) => ({ ...x, items: [{ kind: 'origin', ref: 'origin:x' }] }));
    overlay.sync();
    expect(colour('construct:origin:x')).toBe(PICK_COLOR);
    s.selection.set((x) => ({ ...x, items: [] }));
    overlay.sync();
    palette(LIGHT);
    expect(look()).toEqual([LIGHT.constructLine, HOVER_COLOR, PLANE_FILL.color]);
  });
});
