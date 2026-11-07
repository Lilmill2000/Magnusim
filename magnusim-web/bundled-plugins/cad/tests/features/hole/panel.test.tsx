// The Hole panel in the mounted UI over the real DocService (a fake kernel): centres taken From a
// sketch stay its points when the face changes (picked again, from the selection, or removed), so
// Done does not refuse them; its note says which points the holes follow; a tapped hole's size
// and its thread model are two fields with two names. The Thread panel's hint says whether the
// thread is cut, its hole has no thread, or its hole is gone.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import holeModule, { HOLE_TOOL } from '../../../src/features/hole';
import type { Feature, SketchFeature } from '../../../src/types/doc';
import { uiFor } from '../../../src/ui/controller';
import { startApp, type FakeApp } from '../extrude/fake-app';
import { rectRegion } from '../sketch/fake-profiles-kernel';

let app: FakeApp | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

/** A sketch "Pts" of two points. */
const points = (): Partial<SketchFeature> => ({
  id: 'f_pts',
  name: 'Pts',
  points: { pt_p: [0, 10], pt_q: [0, -10] },
  entities: [
    { id: 'p', kind: 'point', p: 'pt_p' },
    { id: 'q', kind: 'point', p: 'pt_q' },
  ],
  constraints: [],
  solved: { values: {}, dof: 4, state: 'under' },
});

async function opened(): Promise<FakeApp> {
  app = await startApp({ modules: [holeModule] });
  const a = app;
  act(() => a.doc.beginNew('sketch', points() as Partial<Feature>).commit());
  await a.settle();
  act(() => uiFor(a.services).openTool(HOLE_TOOL));
  await a.settle();
  return a;
}

const head = (a: FakeApp) => a.$('[data-pick-field="hole-centres"] .cad-pick-label')!.textContent;
const pickFace = (a: FakeApp, index: number) => act(() => a.services.selection.set({ items: [{ kind: 'face', body: 'b_1', index }] }));

describe('Hole panel', () => {
  it("keeps a sketch's points as the centres when the face changes, and says which points the holes follow", async () => {
    const a = await opened();
    act(() => void fireEvent.change(a.$('[data-cad-panel] [data-field="from-sketch"] select')!, { target: { value: 'Pts' } }));
    expect(head(a)).toBe("Centres: Pts's points (2)");
    expect(a.$$('[data-cad-panel] .mgk-hint').map((h) => h.textContent)).toContain("2 holes at Pts's points: they follow those points when they move (a point added to Pts later gets no hole)");
    // A face from the selection, then another one: the points stay the centres.
    pickFace(a, 3);
    expect(a.$$('[data-pick-field="hole-face"] [data-pick-row]')).toHaveLength(1);
    expect(head(a)).toBe("Centres: Pts's points (2)");
    pickFace(a, 5);
    expect(head(a)).toBe("Centres: Pts's points (2)");
    // The face removed: still the points.
    act(() => void fireEvent.click(a.$('[data-pick-field="hole-face"] [data-pick-remove]')!));
    expect(head(a)).toBe("Centres: Pts's points (2)");
    expect(a.$$('[data-hole-centre]')).toHaveLength(2);
  });

  it("words the Thread panel's hint from its hole, the hole's thread and its own rebuild", async () => {
    app = await startApp({ modules: [holeModule] });
    const a = app;
    const KEY = '+e_1[p:origin>p:pt_b] +e_2[p:pt_b>p:pt_c] +e_3[p:pt_c>p:pt_d] +e_4[p:pt_d>p:origin]';
    a.kernel.regionsFor = () => ({ regions: [rectRegion(KEY, ['e_1', 'e_2', 'e_3', 'e_4'], 0, 0, 20, 10)] });
    act(() =>
      a.doc
        .beginNew('sketch', {
          id: 'f_sk',
          points: { pt_b: [20, 0], pt_c: [20, 10], pt_d: [0, 10] },
          entities: [
            { id: 'e_1', kind: 'line', p: ['origin', 'pt_b'] },
            { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
            { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
            { id: 'e_4', kind: 'line', p: ['pt_d', 'origin'] },
          ],
          constraints: [],
          solved: { values: {}, dof: 4, state: 'under' },
        } as Partial<Feature>)
        .commit(),
    );
    act(() => a.doc.beginNew('extrude', { id: 'f_cut', name: 'Cut', profiles: [{ sketch: 'f_sk', region: KEY, entities: ['e_1', 'e_2', 'e_3', 'e_4'], sample: [10, 5] }], extent: { kind: 'blind', distance: '5 mm' }, thread: { designation: 'M6x1', major: 6, pitch: 1 } } as Partial<Feature>).commit());
    await a.settle();
    const body = a.doc.state.get().rebuild.bodies[0].id;
    act(() => a.doc.beginNew('thread', { id: 'f_th', name: 'Cut thread', hole: 'f_cut', body, length: '' } as Partial<Feature>).commit());
    await a.settle();
    // This kernel cuts no thread: the feature fails, and the hint does not say it is cut.
    expect(a.doc.state.get().rebuild.features.f_th?.state).toBe('error');
    act(() => uiFor(a.services).openEdit('f_th'));
    await a.settle();
    const hint = () => a.$('[data-cad-panel] .mgk-hint')!.textContent;
    expect(hint()).toBe('M6x1 in Cut is not cut now: its rebuild fails (the reason is below).');
    act(() => uiFor(a.services).closePanel());
    // The cut's thread taken off (its Extrude panel's Remove): the hole is there, its thread is not.
    act(() => {
      const s = a.doc.beginEdit('f_cut');
      s.update({ thread: null } as Partial<Feature>);
      s.commit();
    });
    await a.settle();
    act(() => uiFor(a.services).openEdit('f_th'));
    await a.settle();
    expect(hint()).toBe('Cut has no thread now (it was removed from that cut): there is nothing to cut.');
  });

  it("names a tapped hole's thread size and its thread model apart", async () => {
    const a = await opened();
    act(() => void fireEvent.change(a.$('[data-cad-panel] [data-field="sizing"] select')!, { target: { value: 'tapped' } }));
    const labels = a.$$('[data-cad-panel] [data-field-row] .mgk-field-k').map((l) => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Thread size', 'Thread model']));
    expect(labels.filter((l) => l === 'Thread')).toEqual([]);
  });
});
