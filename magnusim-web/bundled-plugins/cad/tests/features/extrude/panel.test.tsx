// The Extrude command and panel, and profile picking, in the mounted UI over
// the real DocService: the command's reason without profiles, select-first
// (selected regions, a selected sketch, the only profile), the profile list
// (area, remove, hover), clicks on regions toggling profiles (one sketch),
// extent kinds and their fields, flip, the Operation row rule, the distance
// arrow's drag, "Profile lost" in the list and the foot, the region tool's
// selection rules in model mode, the open-profile chip, and the sketch's tree
// row (prefix, lock, dimension count, eye).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { profilesView } from '../../../src/features/sketch/view';
import { overlayOf } from '../../../src/features/sketch';
import type { ExtrudeFeature, Feature, SketchFeature } from '../../../src/types/doc';
import { rectRegion } from '../sketch/fake-profiles-kernel';
import { startApp, type FakeApp } from './fake-app';

let app: FakeApp | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

/** Two side-by-side 20 x 10 rectangles' regions (A at x 0..20, B at x 20..40) in one sketch. */
const KEY_A = '+e_1[p:origin>p:pt_b] +e_2[p:pt_b>p:pt_c] +e_3[p:pt_c>p:pt_d] +e_4[p:pt_d>p:origin]';
const KEY_B = '+e_5[p:pt_b>p:pt_e] +e_6[p:pt_e>p:pt_f] +e_7[p:pt_f>p:pt_c] -e_2[p:pt_b>p:pt_c]';
const twoRects = (): Partial<SketchFeature> => ({
  id: 'f_sk',
  points: { pt_b: [20, 0], pt_c: [20, 10], pt_d: [0, 10], pt_e: [40, 0], pt_f: [40, 10] },
  entities: [
    { id: 'e_1', kind: 'line', p: ['origin', 'pt_b'] },
    { id: 'e_2', kind: 'line', p: ['pt_b', 'pt_c'] },
    { id: 'e_3', kind: 'line', p: ['pt_c', 'pt_d'] },
    { id: 'e_4', kind: 'line', p: ['pt_d', 'origin'] },
    { id: 'e_5', kind: 'line', p: ['pt_b', 'pt_e'] },
    { id: 'e_6', kind: 'line', p: ['pt_e', 'pt_f'] },
    { id: 'e_7', kind: 'line', p: ['pt_f', 'pt_c'] },
  ],
  constraints: [
    { id: 'c_1', kind: 'distance', refs: ['e_1'], expr: '20 mm', driving: true },
    { id: 'c_2', kind: 'distance', refs: ['e_2'], expr: '10 mm', driving: true },
  ],
  solved: { values: { c_1: 20, c_2: 10 }, dof: 3, state: 'under' },
});

async function withSketch(opts: { regions?: 'two' | 'one'; open?: boolean } = {}) {
  app = await startApp();
  const a = app;
  a.kernel.regionsFor = () => ({
    regions: opts.regions === 'one' ? [rectRegion(KEY_A, ['e_1', 'e_2', 'e_3', 'e_4'], 0, 0, 20, 10)] : [rectRegion(KEY_A, ['e_1', 'e_2', 'e_3', 'e_4'], 0, 0, 20, 10), rectRegion(KEY_B, ['e_2', 'e_5', 'e_6', 'e_7'], 20, 0, 40, 10)],
    open: opts.open ? [{ at: [50, 0], entity: 'e_9', point: 'pt_g' }, { at: [60, 0], entity: 'e_9', point: 'pt_h' }] : [],
  });
  act(() => a.doc.beginNew('sketch', twoRects() as Partial<Feature>).commit());
  await a.settle();
  return a;
}

const cmd = (a: FakeApp, id: string) => a.$(`[data-command="${id}"]`)!;
const panel = (a: FakeApp) => a.$('[data-cad-panel="feature"]');
const listed = (a: FakeApp) => a.$$('[data-profile-list] [data-profile]').map((li) => `${li.querySelector('.cad-profile-name')!.textContent} · ${li.querySelector('.mat-assign-state')!.textContent}`);
const extrude = (a: FakeApp) => a.doc.state.get().doc.features.find((f) => f.type === 'extrude') as ExtrudeFeature | undefined;
/** The last extrude in the history (the one the open panel made). */
const newest = (a: FakeApp) => [...a.doc.state.get().doc.features].reverse().find((f) => f.type === 'extrude') as ExtrudeFeature | undefined;

describe('Extrude command', () => {
  it('is there with its reason until a sketch has a closed profile', async () => {
    app = await startApp();
    const a = app;
    expect(cmd(a, 'solid.extrude').getAttribute('aria-disabled')).toBe('true');
    expect(cmd(a, 'solid.extrude').getAttribute('data-disabled-reason')).toBe('Draw a closed profile in a sketch first');
    a.kernel.regionsFor = () => ({ regions: [rectRegion(KEY_A, ['e_1'], 0, 0, 20, 10)] });
    act(() => a.doc.beginNew('sketch', twoRects() as Partial<Feature>).commit());
    await a.settle();
    expect(cmd(a, 'solid.extrude').getAttribute('aria-disabled')).toBeNull();
  });

  it('opens with the selected profiles; then a click on a region toggles it, and Done keeps the extrude', async () => {
    const a = await withSketch();
    // The region tool: a click on region B selects it; a click on A while only profiles are selected adds it.
    let took = false;
    act(() => void (took = a.vp.offer(a.vp.at('click', [30, 5, 0]))));
    expect(took).toBe(true);
    expect(a.services.selection.get().items).toEqual([{ kind: 'region', feature: 'f_sk', key: KEY_B }]);
    act(() => void a.vp.offer(a.vp.at('click', [5, 5, 0])));
    expect(a.services.selection.get().items.map((i) => i.kind === 'region' && i.key)).toEqual([KEY_B, KEY_A]);
    // Ctrl+click toggles A off again; a click on empty space is not the tool's.
    act(() => void a.vp.offer(a.vp.at('click', [5, 5, 0], { ctrl: true })));
    expect(a.services.selection.get().items).toHaveLength(1);
    act(() => void (took = a.vp.offer(a.vp.at('click', [100, 100, 0]))));
    expect(took).toBe(false);
    act(() => void a.vp.offer(a.vp.at('click', [5, 5, 0])));

    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    expect(panel(a)!.querySelector('[data-panel-title], .mgk-panel-title, input')).not.toBeNull();
    expect(a.$('[data-feature-panel="extrude"]')).not.toBeNull();
    expect(listed(a)).toEqual(['Profile 1 · 200 mm²', 'Profile 2 · 200 mm²']);
    expect(a.$('.cad-field-group-title')!.textContent).toBe('Profiles (Sketch 1)');
    expect(a.$('[data-chip="volume"] [data-volume-mm3]')!.getAttribute('data-volume-mm3')).toBe('4000');
    expect(cmd(a, 'solid.extrude').className).toContain('is-active');
    // The extrude's profiles draw as picked; the sketch stays drawn while it picks from it.
    expect(profilesView(a.services).get()).toMatchObject({ forced: ['f_sk'], ignoreUser: extrude(a)!.id });
    expect(profilesView(a.services).get().used.map((u) => u.key).sort()).toEqual([KEY_A, KEY_B].sort());

    // A click on B in the view takes it out of the profiles; another puts it back.
    act(() => void a.vp.offer(a.vp.at('click', [30, 5, 0])));
    await a.settle();
    expect(listed(a)).toEqual(['Profile 1 · 200 mm²']);
    expect(a.$('[data-chip="volume"] [data-volume-mm3]')!.getAttribute('data-volume-mm3')).toBe('2000');
    act(() => void a.vp.offer(a.vp.at('click', [30, 5, 0])));
    await a.settle();
    expect(extrude(a)!.profiles.map((p) => p.region)).toEqual([KEY_A, KEY_B]);
    // x removes one; removing the last leaves a new extrude that cannot be created yet.
    act(() => void fireEvent.click(a.$('[data-profile-remove="1"]')!));
    act(() => void fireEvent.click(a.$('[data-profile-remove="0"]')!));
    expect(a.$('[data-panel-done]')!.getAttribute('data-disabled-reason')).toBe('Pick a profile');
    act(() => void a.vp.offer(a.vp.at('click', [5, 5, 0])));
    await a.settle();
    expect(a.$('[data-panel-done]')!.getAttribute('data-disabled-reason')).toBeNull();
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await a.settle();
    expect(panel(a)).toBeNull();
    expect(profilesView(a.services).get()).toMatchObject({ forced: [], used: [], ignoreUser: null });
    expect(a.$$('[data-feature-type="extrude"] .tl').map((e) => e.textContent)).toEqual(['Extrude 1']);
    expect(a.doc.state.get().rebuild.bodies[0].volume).toBe(2000);
  });

  it('says how to show a profile when every sketch with one is hidden', async () => {
    const a = await withSketch({ regions: 'one' });
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await a.settle();
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    expect((a.doc.session()!.draft as ExtrudeFeature)).toMatchObject({ name: 'Extrude 2', profiles: [] });
    expect(a.$('[data-cad-panel] .mgk-hint')!.textContent).toBe('No profiles yet: click a flat face of a body in the view (the sketches with closed profiles are hidden; show one with its eye in the tree)');
    act(() => void fireEvent.click(a.$('[data-tree-node="f_sk"] [data-sketch-act="visibility"]')!));
    // A body exists (Extrude 1): its flat faces can be extruded too (P4a).
    expect(a.$('[data-cad-panel] .mgk-hint')!.textContent).toBe('No profiles yet: click a shaded region of a sketch, or a flat face of a body, in the view');
  });

  it('opens with every profile of a selected sketch, or the only profile there is', async () => {
    let a = await withSketch();
    act(() => a.services.selection.set({ items: [{ kind: 'feature', feature: 'f_sk' }] }));
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    expect(extrude(a)!.profiles).toHaveLength(2);
    a.dispose();
    app = null;
    a = await withSketch({ regions: 'one' });
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    expect(extrude(a)!.profiles.map((p) => p.region)).toEqual([KEY_A]);
  });

  it('refuses, in the panel, a profile of a sketch that comes after the extrude', async () => {
    const a = await withSketch({ regions: 'one' });
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await a.settle();
    // The later sketch lies 100 mm along X: its region is there.
    a.kernel.regionsFor = (curves) => {
      const u0 = Math.min(...curves.flatMap((c) => (c.kind === 'line' ? [c.a[0], c.b[0]] : [])));
      return { regions: [rectRegion(KEY_A, ['e_1', 'e_2', 'e_3', 'e_4'], u0, 0, u0 + 20, 10)] };
    };
    const shifted = Object.fromEntries(Object.entries(twoRects().points!).map(([k, p]) => [k, [p[0] + 100, p[1]]]));
    act(() => a.doc.beginNew('sketch', { ...twoRects(), points: shifted, entities: twoRects().entities!.map((e) => (e.kind === 'line' ? { ...e, p: e.p.map((q) => (q === 'origin' ? 'pt_o' : q)) } : e)), id: 'f_later' } as Partial<Feature>).commit());
    act(() => a.doc.beginEdit('f_later').update({ points: { ...shifted, pt_o: [100, 0] } } as Partial<Feature>));
    act(() => a.doc.session()!.commit());
    await a.settle();
    const id = extrude(a)!.id;
    act(() => a.services.bus.emit('ui:edit-feature', { feature: id }));
    await a.settle();
    // Remove the profile it has, then click a region of the later sketch (drawn: nothing uses it).
    expect(a.$('[data-cad-panel] .mgk-hint')!.textContent).toBe('Click shaded regions in the view to add or remove profiles');
    act(() => void fireEvent.click(a.$('[data-profile-remove="0"]')!));
    act(() => void a.vp.offer(a.vp.at('click', [105, 5, 0])));
    expect(a.$('[data-cad-panel] [data-run-reason] .mgk-reason-msg')!.textContent).toBe('Sketch 2 comes after Extrude 1 in the history: pick a profile of a sketch above it');
    expect((a.doc.session()!.draft as ExtrudeFeature).profiles).toEqual([]);
  });

  it('refuses profiles from two sketches, in words', async () => {
    const a = await withSketch({ regions: 'one' });
    act(() => a.doc.beginNew('sketch', { ...twoRects(), id: 'f_sk2' } as Partial<Feature>).commit());
    await a.settle();
    act(() =>
      a.services.selection.set({
        items: [
          { kind: 'region', feature: 'f_sk', key: KEY_A },
          { kind: 'region', feature: 'f_sk2', key: KEY_A },
        ],
      }),
    );
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    expect(panel(a)).toBeNull();
    expect(a.doc.state.get().doc.features.filter((f) => f.type === 'extrude')).toHaveLength(0);
    expect(a.ws.log.toasts.at(-1)).toEqual({ message: 'Extrude: Pick profiles from one sketch', kind: 'info' });
  });
});

describe('Extrude panel', () => {
  async function opened(extra: Partial<ExtrudeFeature> = {}) {
    const a = await withSketch({ regions: 'one' });
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    if (Object.keys(extra).length) {
      act(() => a.doc.session()!.update(extra as Partial<Feature>));
      await a.settle();
    }
    return a;
  }
  const field = (a: FakeApp, f: string) => a.$<HTMLInputElement>(`[data-cad-panel] .nui[data-field="${f}"] input`)!;
  const setField = (a: FakeApp, f: string, v: string) => {
    act(() => {
      fireEvent.focus(field(a, f));
      fireEvent.change(field(a, f), { target: { value: v } });
    });
    act(() => void fireEvent.keyDown(field(a, f), { key: 'Enter' }));
  };

  it('switches the extent between Blind, Symmetric and Two sides with their fields and words', async () => {
    const a = await opened();
    const labels = () => a.$$('[data-cad-panel] [data-field-row] .mgk-field-k').map((l) => l.textContent);
    expect(labels()).toEqual(['Extent', 'Distance', 'Flip direction']);
    expect(field(a, 'distance').value).toBe('10');
    setField(a, 'distance', '0');
    expect(a.$('[data-cad-panel] .nui[data-field="distance"] [data-nui-error]')!.textContent).toBe('Distance must not be 0');
    setField(a, 'distance', '-25');
    await a.settle();
    expect(extrude(a)!.extent).toEqual({ kind: 'blind', distance: '-25 mm' });
    act(() => void fireEvent.change(a.$('[data-cad-panel] [data-field="extent"] select')!, { target: { value: 'symmetric' } }));
    expect(labels()).toEqual(['Extent', 'Total distance', 'Flip direction']);
    await a.settle();
    expect(extrude(a)!.extent).toEqual({ kind: 'symmetric', distance: '25 mm' });
    setField(a, 'distance', '-3');
    expect(a.$('[data-cad-panel] .nui[data-field="distance"] [data-nui-error]')!.textContent).toBe('Distance must be more than 0');
    setField(a, 'distance', '30');
    await a.settle();
    expect(extrude(a)!.extent).toEqual({ kind: 'symmetric', distance: '30 mm' });
    act(() => void fireEvent.change(a.$('[data-cad-panel] [data-field="extent"] select')!, { target: { value: 'two' } }));
    expect(labels()).toEqual(['Extent', 'Distance 1', 'Distance 2', 'Flip direction']);
    await a.settle();
    expect(extrude(a)!.extent).toEqual({ kind: 'two', distance: '30 mm', distance2: '30 mm' });
    setField(a, 'distance2', '-30');
    expect(a.$('[data-cad-panel] .nui[data-field="distance2"] [data-nui-error]')!.textContent).toBe('The two distances must not add up to 0');
    act(() => void fireEvent.click(a.$('[data-cad-panel] input[data-field="flip"]')!));
    await a.settle();
    expect(extrude(a)!.flip).toBe(true);
    expect(a.kernel.calls.filter((c) => c.op === 'extrude_regions').at(-1)!.params).toMatchObject({ flip: true, extent: { kind: 'two', d1: 30, d2: 30 } });
  });

  it('shows the Operation row only once a body is made before it', async () => {
    let a = await opened();
    expect(a.$('[data-cad-panel] [data-field-row="op"]')).toBeNull();
    a.dispose();
    app = null;
    app = await startApp();
    a = app;
    a.kernel.regionsFor = () => ({ regions: [rectRegion(KEY_A, ['e_1', 'e_2', 'e_3', 'e_4'], 0, 0, 20, 10)] });
    // A 20 x 10 x 5 block first (its own sketch, extruded): a body made before the new extrude.
    act(() => a.doc.beginNew('sketch', { ...twoRects(), id: 'f_base' } as Partial<Feature>).commit());
    act(() => a.doc.beginNew('extrude', { profiles: [{ sketch: 'f_base', region: KEY_A, entities: ['e_1', 'e_2', 'e_3', 'e_4'], sample: [10, 5] }], extent: { kind: 'blind', distance: '5 mm' } } as Partial<Feature>).commit());
    act(() => a.doc.beginNew('sketch', twoRects() as Partial<Feature>).commit());
    await a.settle();
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    expect(a.$('[data-cad-panel] [data-field="op"] select')).not.toBeNull();
    act(() => void fireEvent.change(a.$('[data-cad-panel] [data-field="op"] select')!, { target: { value: 'join' } }));
    await a.settle();
    expect(newest(a)).toMatchObject({ op: 'join', creates: null });
    expect(a.doc.state.get().rebuild.features[newest(a)!.id].state).toBe('ok');
  });

  it('drags the distance with the arrow (live, rounded to what a pixel shows), and a click after the drag picks nothing', async () => {
    const a = await opened();
    a.vp.view = 'front';
    // Blind 10 mm up from the Top plane at the profile's inside point (10, 5): the arrow starts at z = 10.
    // Taken 4 mm up its shaft, it keeps that offset to the pointer.
    const down = a.vp.at('down', [10, 5, 14]);
    let took = false;
    act(() => void (took = a.vp.offer(down)));
    expect(took).toBe(true);
    act(() => void a.vp.offer(a.vp.at('move', [10, 5, 23.26], { buttons: 1 })));
    expect(document.querySelector('[data-extrude-value]')!.textContent).toBe('19.3 mm');
    act(() => void a.vp.offer(a.vp.at('move', [10, 5, 31.74], { buttons: 1 })));
    act(() => void a.vp.offer(a.vp.at('up', [10, 5, 31.74])));
    act(() => void a.vp.offer(a.vp.at('click', [10, 5, 31.74])));
    await a.settle();
    expect(extrude(a)!.extent).toEqual({ kind: 'blind', distance: '27.7 mm' });
    expect(field(a, 'distance').value).toBe('27.7');
    expect(a.doc.state.get().rebuild.bodies[0].volume).toBeCloseTo(200 * 27.7, 9);
    // Below the profile the arrow turns round: a negative distance (taken 7.3 mm up its shaft).
    act(() => void a.vp.offer(a.vp.at('down', [10, 5, 35])));
    act(() => void a.vp.offer(a.vp.at('move', [10, 5, -12], { buttons: 1 })));
    act(() => void a.vp.offer(a.vp.at('up', [10, 5, -12])));
    await a.settle();
    expect(extrude(a)!.extent).toEqual({ kind: 'blind', distance: '-19.3 mm' });
    // A press away from the arrow is not the tool's (it orbits).
    act(() => void (took = a.vp.offer(a.vp.at('down', [40, 5, 40]))));
    expect(took).toBe(false);
  });

  it('shows a lost profile in the list and the foot, and a repaired one in amber', async () => {
    const a = await opened();
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await a.settle();
    const id = extrude(a)!.id;
    a.kernel.regionsFor = () => ({ regions: [rectRegion('renamed', ['e_1', 'e_2', 'e_3', 'e_4'], 0, 0, 20, 10)] });
    let s = null as unknown as ReturnType<typeof a.doc.beginEdit>;
    act(() => void (s = a.doc.beginEdit('f_sk')));
    act(() => s.update({ points: { ...twoRects().points, pt_z: [1, 1] } } as Partial<Feature>));
    act(() => s.commit());
    await a.settle();
    act(() => a.services.bus.emit('ui:edit-feature', { feature: id }));
    await a.settle();
    expect(listed(a)).toEqual(['Profile 1 · repaired · 200 mm²']);
    expect(a.$('[data-cad-panel] [data-warning="profile-repaired"]')!.textContent).toBe('Profile repaired · check');
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await a.settle();
    a.kernel.regionsFor = () => ({ regions: [] });
    let s2 = null as unknown as ReturnType<typeof a.doc.beginEdit>;
    act(() => void (s2 = a.doc.beginEdit('f_sk')));
    act(() => s2.update({ points: { ...twoRects().points, pt_z: [2, 2] } } as Partial<Feature>));
    act(() => s2.commit());
    await a.settle();
    expect(a.$(`[data-tree-node="${id}"]`)!.getAttribute('data-state')).toBe('error');
    act(() => a.services.bus.emit('ui:edit-feature', { feature: id }));
    await a.settle();
    expect(listed(a)).toEqual(['Profile 1 · lost']);
    expect(a.$('[data-cad-panel] [data-run-reason] .mgk-reason-msg')!.textContent).toBe('Extrude 1 failed: Profile lost: the region of Sketch 1 it used is gone');
  });
});

describe('the profile overlay and the sketch row', () => {
  it('draws the shown sketches, hides one once an extrude uses it, and follows the eye', async () => {
    const a = await withSketch({ regions: 'one' });
    const ov = overlayOf(a.services)!;
    expect(ov.shown()).toEqual(['f_sk']);
    const row = () => a.$('[data-tree-node="f_sk"]')!;
    expect(row().querySelector('.tl')!.textContent).toBe('(-) Sketch 1');
    expect(row().querySelector('.tree-sub')!.textContent).toBe('2 dimensions');
    expect(row().querySelector('[data-sketch-lock]')).toBeNull();
    expect(row().getAttribute('data-sketch-shown')).toBe('1');
    // Hover pre-highlights a region; leaving clears it.
    act(() => void a.vp.offer(a.vp.at('move', [5, 5, 0])));
    expect(profilesView(a.services).get().hover).toEqual({ feature: 'f_sk', key: KEY_A });
    act(() => void a.vp.offer(a.vp.at('leave', [5, 5, 0])));
    expect(profilesView(a.services).get().hover).toBeNull();
    // An extrude uses it: hidden by default.
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    expect(ov.shown()).toEqual(['f_sk']);
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await a.settle();
    expect(ov.shown()).toEqual([]);
    expect(row().getAttribute('data-sketch-shown')).toBe('0');
    act(() => void fireEvent.click(row().querySelector('[data-sketch-act="visibility"]')!));
    await a.settle();
    expect(a.doc.state.get().view.sketches).toEqual({ f_sk: 'shown' });
    expect(ov.shown()).toEqual(['f_sk']);
    expect(row().querySelector('[data-sketch-act="visibility"]')!.getAttribute('aria-label')).toBe('Hide Sketch 1');
    // Back to its default (used, so hidden): the choice is forgotten.
    act(() => void fireEvent.click(row().querySelector('[data-sketch-act="visibility"]')!));
    expect(a.doc.state.get().view.sketches).toBeUndefined();
    // A fully defined sketch has no prefix and a lock.
    let s = null as unknown as ReturnType<typeof a.doc.beginEdit>;
    act(() => void (s = a.doc.beginEdit('f_sk')));
    act(() => s.update({ solved: { values: { c_1: 20, c_2: 10 }, dof: 0, state: 'fully' } } as Partial<Feature>));
    act(() => s.commit());
    await a.settle();
    expect(row().querySelector('.tl')!.textContent).toBe('Sketch 1');
    expect(row().querySelector('[data-sketch-lock]')!.getAttribute('aria-label')).toBe('Fully defined');
  });

  it('a right-click on a profile selects it and offers "Extrude profile", which opens Extrude with it', async () => {
    const a = await withSketch();
    let took = false;
    act(() => void (took = a.vp.offer(a.vp.at('contextmenu', [30, 5, 0], { button: 2 }))));
    expect(took).toBe(true);
    expect(a.services.selection.get().items).toEqual([{ kind: 'region', feature: 'f_sk', key: KEY_B }]);
    const items = a.$$('[data-cad-menu] [data-menu-item]');
    expect(items.map((b) => b.textContent)).toContain('Extrude profile');
    act(() => void fireEvent.click(items.find((b) => b.textContent === 'Extrude profile')!));
    await a.settle();
    expect(extrude(a)!.profiles.map((p) => p.region)).toEqual([KEY_B]);
  });

  it('draws only the edited sketch in sketch mode, without its lines (sketch mode draws them)', async () => {
    const a = await withSketch();
    act(() => a.doc.beginNew('sketch', { ...twoRects(), id: 'f_sk2' } as Partial<Feature>).commit());
    await a.settle();
    const ov = overlayOf(a.services)!;
    expect(ov.shown()).toEqual(['f_sk', 'f_sk2']);
    act(() => void a.doc.beginEdit('f_sk'));
    act(() => a.services.mode.set({ mode: 'sketch' }));
    await a.settle();
    expect(ov.shown()).toEqual(['f_sk']);
    expect(a.vp.layers.get('profiles.sketches')!.group.children).toHaveLength(0);
    expect(a.vp.layers.get('profiles.regions')!.group.children.length).toBe(2);
    // The region tool leaves the pointer to sketch mode.
    let took = true;
    act(() => void (took = a.vp.offer(a.vp.at('click', [5, 5, 0]))));
    expect(took).toBe(false);
    act(() => a.services.mode.set({ mode: 'model' }));
    act(() => a.doc.session()!.commit());
    await a.settle();
    expect(ov.shown()).toEqual(['f_sk', 'f_sk2']);
    expect(a.vp.layers.get('profiles.sketches')!.group.children.length).toBeGreaterThan(0);
  });

  // Review P2/P3 round 1: in model mode a dimensioned rectangle was drawn blue beside free lines, and
  // the Top plane's square sat under a sketch on an empty Part.
  it('draws each line in its own definition colour, and keeps the origin planes hidden while a sketch is shown', async () => {
    const a = await withSketch();
    const colours = () =>
      (a.vp.layers.get('profiles.sketches')!.group.children as unknown as { material: { color: { getHex(): number } }; geometry: { attributes: { instanceStart: { count: number } } } }[]).map((c) => [c.material.color.getHex(), c.geometry.attributes.instanceStart.count]);
    // Under defined, nothing known to be fully defined: all 7 lines blue.
    expect(colours()).toEqual([[0x1570ef, 7]]);
    expect([...a.vp.planesBusy]).toEqual(['profiles.sketches']);
    // The rectangle e_1..e_4 fully defined: 4 lines in #101828, 3 in blue.
    let s = null as unknown as ReturnType<typeof a.doc.beginEdit>;
    act(() => void (s = a.doc.beginEdit('f_sk')));
    act(() => s.update({ solved: { values: { c_1: 20, c_2: 10 }, dof: 3, state: 'under', fully: ['e_1', 'e_2', 'e_3', 'e_4'] } } as Partial<Feature>));
    act(() => s.commit());
    await a.settle();
    expect(colours()).toEqual([
      [0x1570ef, 3],
      [0x101828, 4],
    ]);
    // Hidden: nothing drawn, the planes may show again.
    act(() => void fireEvent.click(a.$('[data-tree-node="f_sk"] [data-sketch-act="visibility"]')!));
    await a.settle();
    expect(overlayOf(a.services)!.shown()).toEqual([]);
    expect([...a.vp.planesBusy]).toEqual([]);
  });

  it('says how many open ends the sketch in focus has', async () => {
    const a = await withSketch({ open: true });
    expect(a.$('[data-chip="open-profile"]')).toBeNull();
    act(() => a.services.selection.set({ items: [{ kind: 'feature', feature: 'f_sk' }] }));
    expect(a.$('[data-chip="open-profile"]')!.textContent).toBe('Open profile: 2 open ends');
    expect(document.querySelectorAll('[data-open-end="f_sk"]')).toHaveLength(2);
  });
});
