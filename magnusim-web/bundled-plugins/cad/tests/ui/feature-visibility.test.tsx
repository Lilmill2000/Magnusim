// Hide and Show of a sketch or a reference Plane, Axis or Point (Daniel: "Let's say there's a
// construction plane. I should be able to right-click on that and hide the plane from there"):
//   - which features have an eye, and the choice kept (a sketch's default is forgotten);
//   - the row's menu says Hide <name> / Show <name> and does what the row's eye does, never
//     blocked (view state), on planes, axes, points and sketches, not on an Extrude;
//   - the row of a hidden one: its eye closed and its name and icon dimmed, as a hidden body's.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { extrudeDef } from '../../src/features/extrude/def';
import { refAxisDef, refPlaneDef, refPointDef } from '../../src/features/refgeom/defs';
import { sketchDef } from '../../src/features/sketch/def';
import type { Feature, FeatureTypeDef } from '../../src/types';
import { uiFor } from '../../src/ui/controller';
import { featureShown, visibilityChoice } from '../../src/ui/tree/model';
import { makeServices, type TestServices } from './fake-doc';
import { mountUi } from './mount';

let t: TestServices;
let ui: ReturnType<typeof mountUi> | null = null;
afterEach(() => {
  cleanup();
  ui?.dispose();
  ui = null;
});

function part() {
  t = makeServices({ viewport: true });
  for (const def of [sketchDef, extrudeDef, refPlaneDef, refAxisDef, refPointDef]) t.doc.features.register(def as unknown as FeatureTypeDef);
  const used = t.doc.seed('sketch', { name: 'Sketch 1' } as Partial<Feature>);
  const extrude = t.doc.seed('extrude', { profiles: [{ sketch: used.id, region: 'k', entities: [], sample: [0, 0] }] } as Partial<Feature>);
  const free = t.doc.seed('sketch', { name: 'Sketch 2' } as Partial<Feature>);
  const plane = t.doc.seed('ref_plane', { name: 'Plane 1' } as Partial<Feature>);
  const axis = t.doc.seed('ref_axis', { name: 'Axis 1' } as Partial<Feature>);
  const point = t.doc.seed('ref_point', { name: 'Point 1' } as Partial<Feature>);
  return { used, extrude, free, plane, axis, point };
}

const shownOf = (id: string) => {
  const s = t.doc.state.get();
  return featureShown(s.doc, s.view, t.doc.features, id);
};

describe('which features have an eye', () => {
  it('sketches and references do, an Extrude not; a reference is shown unless hidden, a used sketch hidden unless shown; a choice equal to the default is forgotten', () => {
    const f = part();
    expect([f.used, f.extrude, f.free, f.plane, f.axis, f.point].map((x) => shownOf(x.id))).toEqual([false, null, true, true, true, true]);
    const doc = t.doc.state.get().doc;
    const choice = (id: string, show: boolean) => visibilityChoice(doc, t.doc.features, id, show);
    expect([choice(f.plane.id, false), choice(f.plane.id, true), choice(f.point.id, false)]).toEqual(['hidden', null, 'hidden']);
    expect([choice(f.free.id, false), choice(f.free.id, true)]).toEqual(['hidden', null]);
    expect([choice(f.used.id, true), choice(f.used.id, false)]).toEqual(['shown', null]);
  });
});

describe("a row's menu: Hide and Show", () => {
  it('a plane, an axis, a point and a sketch: Hide <name> after Suppress, then Show <name>; the row shows it hidden; the eye says the same', () => {
    const f = part();
    ui = mountUi(t);
    for (const x of [f.plane, f.axis, f.point, f.free]) {
      const sketch = x.type === 'sketch';
      fireEvent.contextMenu(ui.row(x.id), { clientX: 40, clientY: 60 });
      const menu = ui.menu();
      expect(menu.slice(0, 4)).toEqual([`Edit ${x.name}`, `Rename ${x.name}`, `Suppress ${x.name}`, `Hide ${x.name}`]);
      fireEvent.click(ui.menuItem('visibility'));
      expect(ui.menu()).toEqual([]);
      expect(t.doc.calls).toContain(`setSketchVisibility ${x.id} hidden`);
      expect(t.doc.state.get().view.sketches?.[x.id]).toBe('hidden');
      expect(ui.node(x.id).getAttribute(sketch ? 'data-sketch-shown' : 'data-construct-shown')).toBe('0');
      expect(ui.node(x.id).className).toContain('is-hidden-feature');
      const eye = () => ui!.row(x.id).querySelector<HTMLElement>(`[data-${sketch ? 'sketch' : 'construct'}-act="visibility"]`)!;
      expect(eye().getAttribute('aria-label')).toBe(`Show ${x.name}`);
      expect(eye().getAttribute('data-visible')).toBe('0');
      // Show from the menu: the choice forgotten (shown is the default), the row as before.
      fireEvent.contextMenu(ui.row(x.id), { clientX: 40, clientY: 60 });
      expect(ui.menu()).toContain(`Show ${x.name}`);
      fireEvent.click(ui.menuItem('visibility'));
      expect(t.doc.calls).toContain(`setSketchVisibility ${x.id} null`);
      expect(t.doc.state.get().view.sketches?.[x.id]).toBeUndefined();
      expect(ui.node(x.id).className).not.toContain('is-hidden-feature');
      expect(eye().getAttribute('aria-label')).toBe(`Hide ${x.name}`);
      // The eye does the same: hidden, and its menu then offers Show.
      act(() => void fireEvent.click(eye()));
      expect(ui.node(x.id).className).toContain('is-hidden-feature');
      fireEvent.contextMenu(ui.row(x.id), { clientX: 40, clientY: 60 });
      expect(ui.menu()).toContain(`Show ${x.name}`);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      act(() => void fireEvent.click(eye()));
      expect(ui.node(x.id).className).not.toContain('is-hidden-feature');
    }
  });

  it('a sketch a later feature uses is hidden by default: its menu says Show, which keeps "shown"; Hide then forgets it', () => {
    const f = part();
    ui = mountUi(t);
    expect(ui.node(f.used.id).className).toContain('is-hidden-feature');
    fireEvent.contextMenu(ui.row(f.used.id), { clientX: 40, clientY: 60 });
    expect(ui.menu()).toContain('Show Sketch 1');
    fireEvent.click(ui.menuItem('visibility'));
    expect(t.doc.state.get().view.sketches?.[f.used.id]).toBe('shown');
    expect(ui.node(f.used.id).getAttribute('data-sketch-shown')).toBe('1');
    act(() => uiFor(t.services).setFeatureVisible(f.used.id, false));
    expect(t.doc.state.get().view.sketches?.[f.used.id]).toBeUndefined();
    expect(ui.node(f.used.id).getAttribute('data-sketch-shown')).toBe('0');
  });

  it('an Extrude has no Hide (its bodies do); Hide is offered while the model cannot be edited (a view, not an edit)', () => {
    const f = part();
    const c = uiFor(t.services);
    expect(c.featureMenu(f.extrude.id).some((m) => m.id === 'visibility')).toBe(false);
    const off = c.addEditBlock(() => 'Read only here');
    const item = c.featureMenu(f.plane.id).find((m) => m.id === 'visibility') as { label: string; disabled?: string | null } | undefined;
    expect(item?.label).toBe('Hide Plane 1');
    expect(item?.disabled ?? null).toBeNull();
    expect(c.featureMenu(f.plane.id).find((m) => m.id === 'suppress')).toMatchObject({ disabled: 'Read only here' });
    off();
    // A feature with no eye: nothing happens.
    const calls = t.doc.calls.length;
    c.setFeatureVisible(f.extrude.id, false);
    expect(t.doc.calls.length).toBe(calls);
  });
});
