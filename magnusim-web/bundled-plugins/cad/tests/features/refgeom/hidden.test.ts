// A hidden reference Plane, Axis or Point (its row's eye, or Hide in its menu) is not drawn in the
// view and not picked there: the overlay leaves it out of what it draws (its label and its
// meshes) and out of the list picking reads; selected in the tree it stays out; shown again it
// is drawn and picked as before.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Group } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { ConstructOverlay, LAYER_CONSTRUCT } from '../../../src/features/refgeom/overlay';
import { hitConstruct } from '../../../src/features/refgeom/pick';
import { createSelectionStore } from '../../../src/lib/selection';
import { createStateStore } from '../../../src/lib/store';
import type { AppServices } from '../../../src/types/app';
import type { Mode } from '../../../src/types/commands';
import type { CadView, Vec3 } from '../../../src/types/doc';
import type { ViewportHandle } from '../../../src/types/viewport';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  document.body.innerHTML = '';
});

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
    setPlanesBusy() {},
    pixelSize: () => 0.1,
    project: () => [10, 10] as [number, number],
    pick: () => null,
    lineResolution: () => [800, 600] as [number, number],
  };
  return { handle: handle as unknown as ViewportHandle, groups };
}

const TOP = { origin: [0, 0, 10] as Vec3, normal: [0, 0, 1] as Vec3, xdir: [1, 0, 0] as Vec3 };

describe('a hidden reference in the view', () => {
  it('is not drawn and not picked; selected in the tree it stays out; shown again it is both', () => {
    const view: Partial<CadView> = {};
    const doc = createStateStore<{ doc: unknown; view: Partial<CadView>; rebuild: unknown; session: null }>({
      doc: { features: [{ id: 'f_p', type: 'ref_plane', name: 'Plane 1' }, { id: 'f_a', type: 'ref_axis', name: 'Axis 1' }, { id: 'f_q', type: 'ref_point', name: 'Point 1' }] },
      view,
      rebuild: { outputs: { f_p: { type: 'plane', frame: TOP }, f_a: { type: 'axis', origin: [0, 0, 0], dir: [1, 0, 0] }, f_q: { type: 'point', p: [20, 0, 0] } }, bodies: [], features: {} },
      session: null,
    });
    const s = { doc: { state: doc, features: { get: () => ({ parents: () => [] }) } }, selection: createSelectionStore(), mode: createStateStore<{ mode: Mode }>({ mode: 'model' }) } as unknown as AppServices;
    const { handle, groups } = fakeHandle();
    const overlay = new ConstructOverlay(s, handle);
    disposers.push(() => overlay.dispose());
    overlay.sync();
    const group = groups.get(LAYER_CONSTRUCT)!;
    const meshes = () => [...new Set(group.children.map((o) => o.name).filter((n) => n.startsWith('construct:')))].sort();
    const labels = () => [...document.querySelectorAll<HTMLElement>('[data-construct-label]')].map((l) => l.dataset.constructLabel).sort();
    // Screen = model x, -y; the ray straight down.
    const at = (x: number, y: number) => ({ x, y: -y, ray: { origin: [x, y, 100] as Vec3, dir: [0, 0, -1] as Vec3 } });
    const project = (p: Vec3): [number, number] => [p[0], -p[1]];
    const hit = (x: number, y: number) => hitConstruct(overlay.items(), at(x, y), project)?.feature ?? null;
    expect(labels()).toEqual(['f_a', 'f_p', 'f_q']);
    expect(meshes()).toEqual(expect.arrayContaining(['construct:f_a', 'construct:f_p', 'construct:f_q']));
    expect([hit(-30, 20), hit(-30, 0), hit(20, 0)]).toEqual(['f_p', 'f_a', 'f_q']);

    // Plane 1 and Point 1 hidden (CadView.sketches, as the eye and the menu keep it).
    doc.set((x) => ({ ...x, view: { ...x.view, sketches: { f_p: 'hidden', f_q: 'hidden' } } }));
    s.selection.set((x) => ({ ...x, items: [{ kind: 'feature', feature: 'f_p' }] }));
    overlay.sync();
    expect(labels()).toEqual(['f_a']);
    expect(meshes().filter((n) => n === 'construct:f_p' || n === 'construct:f_q')).toEqual([]);
    expect(overlay.items().map((c) => c.feature)).toEqual(['f_a']);
    expect(overlay.states()).toEqual({ f_a: 'none' });
    // Where the plane and the point were, nothing is picked (the axis still is).
    expect([hit(-30, 20), hit(-30, 0), hit(20, 0)]).toEqual([null, 'f_a', 'f_a']);

    // Shown again: drawn (picked: it is selected), and picked in the view.
    doc.set((x) => ({ ...x, view: { ...x.view, sketches: {} } }));
    overlay.sync();
    expect(labels()).toEqual(['f_a', 'f_p', 'f_q']);
    expect(overlay.states()).toMatchObject({ f_p: 'pick' });
    expect([hit(-30, 20), hit(20, 0)]).toEqual(['f_p', 'f_q']);
  });
});
