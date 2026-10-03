// The Enclosure command and panel in the mounted UI over the real DocService
// (the toy kernel of tests/features/sketch/fake-profiles-kernel.ts): greyed
// until a body exists, the CFD PREP group, a new Enclosure 1 applied live and
// tight to the part, no Operation row, Box and Cylinder with the axis, the
// padding modes and the per-side fields (set on their own, back to the
// padding, refused inline), the drag arrows, the bodies field, and the panel
// chrome the shell's own Box panel had (moved here with it: Done, Delete,
// rename, Escape, Ctrl+Z in a panel, the rebuild's error in the foot, a field
// refused while another tab changed the part, the edited feature selected).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import enclosureModule from '../../../src/features/enclosure';
import type { EnclosureFeature, ExtrudeFeature, Feature } from '../../../src/types/doc';
import { block, blockRegions, blockSketch, profileOf } from '../../doc/blocks';
import { startApp, type FakeApp } from '../extrude/fake-app';

let app: FakeApp | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

/** The app with the Enclosure module, and (with `body`) a 20 mm cube sketched and extruded. */
async function start(body = true) {
  app = await startApp({ modules: [enclosureModule] });
  const a = app;
  a.kernel.regionsFor = blockRegions;
  if (body) {
    act(() => void block(a.doc));
    await a.settle();
  }
  return a;
}

const cmd = (a: FakeApp, id: string) => a.$(`[data-command="${id}"]`)!;
const panel = (a: FakeApp) => a.$('[data-cad-panel="feature"]');
const title = (a: FakeApp) => a.$('[data-cad-panel] [data-panel-title]')?.textContent ?? null;
const enclosure = (a: FakeApp) => a.doc.state.get().doc.features.find((f) => f.type === 'enclosure') as EnclosureFeature | undefined;
/** History labels, without a sketch's definition prefix ("(-) Sketch 1"). */
const history = (a: FakeApp) => a.$$('[data-cad-tree] [data-feature-row] > .tree-row .tl').map((e) => (e.textContent ?? '').replace(/^[(][-+?][)] /, ''));
const field = (a: FakeApp, f: string) => a.$<HTMLInputElement>(`[data-cad-panel] .nui[data-field="${f}"] input`)!;
const fieldError = (a: FakeApp, f: string) => a.$(`[data-cad-panel] .nui[data-field="${f}"] [data-nui-error]`)?.textContent ?? null;
const setField = (a: FakeApp, f: string, v: string) => {
  act(() => {
    fireEvent.focus(field(a, f));
    fireEvent.change(field(a, f), { target: { value: v } });
  });
  act(() => void fireEvent.keyDown(field(a, f), { key: 'Enter' }));
};
const select = (a: FakeApp, f: string, value: string) => act(() => void fireEvent.change(a.$(`[data-cad-panel] [data-field="${f}"] select`)!, { target: { value } }));
const size = (a: FakeApp) => a.$('[data-enclosure-size]')?.textContent ?? null;
const sides = (a: FakeApp) => a.$$('[data-cad-panel] .cad-enclosure-side').map((s) => `${s.getAttribute('data-side')} ${s.querySelector('input')!.value} ${s.getAttribute('data-side-source')}`);
const key = (k: string, init: KeyboardEventInit = {}) => act(() => void fireEvent.keyDown(document.body, { key: k, ...init }));

async function opened(a: FakeApp) {
  act(() => void fireEvent.click(cmd(a, 'cfd.enclosure')));
  await a.settle();
  return a;
}

describe('the Enclosure command', () => {
  it('sits in CFD PREP after the modelling groups, greyed with the reason until a body exists', async () => {
    const a = await start(false);
    const groups = a.$$('[data-cad-toolbar] .tb-group-label').map((g) => g.textContent);
    expect(groups.indexOf('CFD PREP')).toBeGreaterThan(groups.indexOf('MODIFY'));
    expect(groups.indexOf('CFD PREP')).toBeGreaterThan(groups.indexOf('SOLID'));
    expect(a.$$('[data-group="cfd"] .tb-txt').map((b) => b.textContent)).toEqual(['Enclosure']);
    // No one-click solids anywhere: SOLID is Extrude only.
    expect(a.$$('[data-group="solid"] .tb-txt').map((b) => b.textContent)).toEqual(['Extrude']);
    expect(a.$('[data-command="solid.box"]')).toBeNull();
    expect(a.$('[data-command="solid.cylinder"]')).toBeNull();
    expect(cmd(a, 'cfd.enclosure').getAttribute('aria-disabled')).toBe('true');
    expect(cmd(a, 'cfd.enclosure').getAttribute('data-disabled-reason')).toBe('Add or import a body first');
    act(() => void fireEvent.click(cmd(a, 'cfd.enclosure')));
    expect(panel(a)).toBeNull();
    // A sketch alone is not a body.
    act(() => a.doc.beginNew('sketch', blockSketch() as Partial<Feature>).commit());
    await a.settle();
    expect(cmd(a, 'cfd.enclosure').getAttribute('data-disabled-reason')).toBe('Add or import a body first');
    act(() => a.doc.beginNew('extrude', { profiles: [profileOf(a.doc.state.get().doc.features[0].id, blockSketch())] } as Partial<Feature>).commit());
    await a.settle();
    expect(cmd(a, 'cfd.enclosure').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('the Enclosure panel', () => {
  it('makes Enclosure 1 live, tight to the part, as a new body only: no Operation row; Done keeps it as one undo step', async () => {
    const a = await opened(await start());
    expect(title(a)).toBe('Enclosure 1');
    expect(cmd(a, 'cfd.enclosure').className).toContain('is-active');
    // No tick in the head; Done and Delete in the foot.
    expect(a.$('[data-cad-panel] .mgk-panel-head')!.textContent).toBe('Enclosure 1');
    expect(a.$$('[data-cad-panel] .mgk-panel-foot button').map((b) => b.textContent)).toEqual(['Delete', 'Done']);
    // It only makes a body: never an Operation, though a body exists before it.
    expect(a.$('[data-cad-panel] [data-field-row="op"]')).toBeNull();
    expect(history(a)).toEqual(['Sketch 1', 'Extrude 1', 'Enclosure 1']);
    expect(a.doc.state.get().rebuild.bodies.map((b) => b.name)).toEqual(['Body 1', 'Enclosure 1']);
    expect((a.$<HTMLSelectElement>('[data-cad-panel] [data-field="padding"] select')!).value).toBe('zero');
    expect(sides(a)).toEqual(['+x 0 padding', '-x 0 padding', '+y 0 padding', '-y 0 padding', '+z 0 padding', '-z 0 padding']);
    expect(size(a)).toBe('Size: 20 mm × 20 mm × 20 mm · 8000 mm³');
    // The bodies field itself says what it encloses (SD review round 1: it said "(none)").
    expect(a.$('[data-pick-field="bodies"] [data-pick-empty]')!.textContent).toBe('All solid bodies (1): Body 1');
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    expect(panel(a)).toBeNull();
    expect(a.doc.state.get().history.undoLabel).toBe('Enclosure 1');
    key('z', { ctrlKey: true });
    await a.settle();
    expect(history(a)).toEqual(['Sketch 1', 'Extrude 1']);
    key('y', { ctrlKey: true });
    await a.settle();
    expect(history(a)).toEqual(['Sketch 1', 'Extrude 1', 'Enclosure 1']);
  });

  it('Fixed and Percent set every side; a side typed on its own keeps its value until "Use padding"; impossible values are refused inline', async () => {
    const a = await opened(await start());
    select(a, 'padding', 'fixed');
    await a.settle();
    expect(field(a, 'distance').value).toBe('10');
    expect(size(a)).toBe('Size: 40 mm × 40 mm × 40 mm · 64,000 mm³');
    setField(a, 'distance', '5');
    await a.settle();
    expect(enclosure(a)!.distance).toBe('5 mm');
    expect(sides(a)).toEqual(['+x 5 padding', '-x 5 padding', '+y 5 padding', '-y 5 padding', '+z 5 padding', '-z 5 padding']);
    // +X on its own.
    setField(a, 'side-px', '25');
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '25 mm' });
    expect(sides(a)[0]).toBe('+x 25 set');
    expect(size(a)).toBe('Size: 50 mm × 30 mm × 30 mm · 45,000 mm³');
    // The padding's distance changes: +X keeps its 25.
    setField(a, 'distance', '2');
    await a.settle();
    expect(sides(a).slice(0, 2)).toEqual(['+x 25 set', '-x 2 padding']);
    act(() => void fireEvent.click(a.$('[data-side-reset="px"]')!));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({});
    expect(sides(a)[0]).toBe('+x 2 padding');
    // A side may go into the part (with a note), but never past the part's far side (SD review
    // round 1: −X = −60 on a 40 mm block made a slab beside the part), nor past the other side.
    setField(a, 'side-nx', '-30');
    expect(fieldError(a, 'side-nx')).toBe('−X would put the enclosure past the part (x ≥ 20 mm)');
    expect(enclosure(a)!.sides).toEqual({});
    setField(a, 'side-nx', '-20');
    expect(fieldError(a, 'side-nx')).toBe('−X would put the enclosure past the part (x ≥ 20 mm)');
    expect(a.$('[data-side-note]')).toBeNull();
    setField(a, 'side-px', '-15');
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '-15 mm' });
    expect(a.$('[data-side-note="px"]')!.textContent).toBe('+X cuts through Body 1: Combine Cut will leave the cut-off part of Body 1 out of the fluid');
    // Several sides into the part: one note naming them (SD review round 2: six identical lines).
    setField(a, 'side-py', '-2');
    setField(a, 'side-nz', '-3');
    await a.settle();
    expect(a.$$('[data-side-note]').map((n) => [n.getAttribute('data-side-note'), n.textContent])).toEqual([
      ['px py nz', '+X, +Y and −Z cut through Body 1: Combine Cut will leave the cut-off parts of Body 1 out of the fluid'],
    ]);
    act(() => void fireEvent.click(a.$('[data-side-reset="py"]')!));
    act(() => void fireEvent.click(a.$('[data-side-reset="nz"]')!));
    await a.settle();
    setField(a, 'side-nx', '-10');
    expect(fieldError(a, 'side-nx')).toBe("The enclosure has no size along X: the −X and +X sides take away the part's whole X size");
    act(() => void fireEvent.click(a.$('[data-side-reset="px"]')!));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({});
    expect(a.$('[data-side-note]')).toBeNull();
    setField(a, 'distance', '-1');
    expect(fieldError(a, 'distance')).toBe('Distance must not be negative');
    // Percent of the part's size in each direction (10 % of 20 mm = 2 mm a side); a side set on its
    // own keeps its value (SD review round 1: changing Padding wiped it without a word).
    setField(a, 'side-pz', '7');
    await a.settle();
    select(a, 'padding', 'percent');
    await a.settle();
    expect(enclosure(a)).toMatchObject({ padding: 'percent', percent: '10', sides: { '+z': '7 mm' } });
    expect(sides(a)[4]).toBe('+z 7 set');
    expect(size(a)).toBe('Size: 24 mm × 24 mm × 29 mm · 16,704 mm³');
    act(() => void fireEvent.click(a.$('[data-side-reset="pz"]')!));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({});
    expect(a.$('[data-cad-panel] .cad-enclosure-pct-unit > span:first-child')!.textContent).toBe('%');
    expect(size(a)).toBe('Size: 24 mm × 24 mm × 24 mm · 13,824 mm³');
    setField(a, 'percent', '-5');
    expect(fieldError(a, 'percent')).toBe('Percent must not be negative');
    setField(a, 'percent', '50');
    await a.settle();
    expect(size(a)).toBe('Size: 40 mm × 40 mm × 40 mm · 64,000 mm³');
  });

  it('a Cylinder has an axis (Z by default) and the sides Radius, Top and Bottom', async () => {
    const a = await opened(await start());
    expect(a.$('[data-cad-panel] [data-field="axis"] select')).toBeNull();
    select(a, 'shape', 'cylinder');
    await a.settle();
    const axis = a.$<HTMLSelectElement>('[data-cad-panel] [data-field="axis"] select')!;
    expect([...axis.options].map((o) => o.textContent)).toEqual(['X', 'Y', 'Z']);
    expect(axis.value).toBe('origin:z');
    expect(sides(a)).toEqual(['radius 0 padding', 'top 0 padding', 'bottom 0 padding']);
    // Through the corners of the 20 x 20 box: r = 10 √2.
    expect(size(a)).toBe(`Size: Ø${Number((20 * Math.SQRT2).toPrecision(6))} mm × 20 mm · ${Number((Math.PI * 200 * 20).toPrecision(6)).toLocaleString('en-US')} mm³`);
    select(a, 'axis', 'origin:x');
    await a.settle();
    expect(enclosure(a)).toMatchObject({ shape: 'cylinder', axis: 'origin:x' });
    setField(a, 'side-top', '30');
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ top: '30 mm' });
  });

  it("drags a side's arrow: that side moves out live, the value shows beside it, and the release keeps it", async () => {
    const a = await opened(await start());
    // Top view (x right, y up, 2 px per mm). The +X arrow starts at the middle of the +X face (20, 10, 10).
    const down = a.vp.at('down', [30, 10, 10]);
    let took = false;
    act(() => void (took = a.vp.offer(down)));
    expect(took).toBe(true);
    act(() => void a.vp.offer(a.vp.at('move', [42.5, 10, 10], { buttons: 1 })));
    expect(document.querySelector('[data-enclosure-value]')!.textContent).toBe('+X 12.5 mm');
    act(() => void a.vp.offer(a.vp.at('up', [42.5, 10, 10])));
    act(() => void a.vp.offer(a.vp.at('click', [42.5, 10, 10])));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '12.5 mm' });
    expect(sides(a)[0]).toBe('+x 12.5 set');
    expect(a.doc.state.get().rebuild.bodies.find((b) => b.name === 'Enclosure 1')!.volume).toBe(32.5 * 20 * 20);
    // The -Y arrow (from the middle of the -Y face, now x = 16.25), dragged in by 5 mm: a side may go into the part.
    act(() => void a.vp.offer(a.vp.at('down', [16.25, -10, 10])));
    act(() => void a.vp.offer(a.vp.at('move', [16.25, -5, 10], { buttons: 1 })));
    // One minus sign in the label: U+2212 in the side's name and in its value (SD review round 2: "−Y -5 mm").
    expect(document.querySelector('[data-enclosure-value]')!.textContent).toBe('−Y −5 mm');
    act(() => void a.vp.offer(a.vp.at('up', [16.25, -5, 10])));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '12.5 mm', '-y': '-5 mm' });
    // A press away from the arrows is not the tool's (it orbits or selects).
    act(() => void (took = a.vp.offer(a.vp.at('down', [-40, -40, 0]))));
    expect(took).toBe(false);
  });

  it('Escape during a drag puts the side back and keeps the panel open (SD review round 2: it closed the panel and kept the dragged value)', async () => {
    const a = await opened(await start());
    setField(a, 'side-px', '4');
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '4 mm' });
    // +X (set on its own) dragged out live, then Escape with the button still down.
    act(() => void a.vp.offer(a.vp.at('down', [24, 10, 10])));
    act(() => void a.vp.offer(a.vp.at('move', [34, 10, 10], { buttons: 1 })));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '14 mm' });
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(esc));
    await a.settle();
    expect(esc.defaultPrevented).toBe(true);
    expect(enclosure(a)!.sides).toEqual({ '+x': '4 mm' });
    expect(a.$('[data-cad-panel]')).not.toBeNull();
    expect((document.querySelector('[data-enclosure-value]') as HTMLElement).style.display).toBe('none');
    // The rest of that press is the drag's: moving and letting go changes nothing.
    act(() => void a.vp.offer(a.vp.at('move', [44, 10, 10], { buttons: 1 })));
    act(() => void a.vp.offer(a.vp.at('up', [44, 10, 10])));
    act(() => void a.vp.offer(a.vp.at('click', [44, 10, 10])));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '4 mm' });
    // A side that followed the padding goes back to following it.
    act(() => void a.vp.offer(a.vp.at('down', [10, 30, 10])));
    act(() => void a.vp.offer(a.vp.at('move', [10, 40, 10], { buttons: 1 })));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '4 mm', '+y': '10 mm' });
    act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '4 mm' });
    act(() => void a.vp.offer(a.vp.at('up', [10, 40, 10])));
    // With no drag, Escape is the panel's again: it closes.
    act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await a.settle();
    expect(a.$('[data-cad-panel]')).toBeNull();
  });

  it('a quick release stores where the arrow was let go, even when the last moves were not seen (a 25 mm drag stored 22.7 mm in the browser)', async () => {
    const a = await opened(await start());
    act(() => void a.vp.offer(a.vp.at('down', [30, 10, 10])));
    // The first move applies at once (live); the rest of the way is not seen before the release.
    act(() => void a.vp.offer(a.vp.at('move', [35, 10, 10], { buttons: 1 })));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '5 mm' });
    act(() => void a.vp.offer(a.vp.at('up', [55, 10, 10])));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '25 mm' });
    // Taken and let go in place after a live update: the side goes back to what it was.
    act(() => void a.vp.offer(a.vp.at('down', [55, 10, 10])));
    act(() => void a.vp.offer(a.vp.at('move', [60, 10, 10], { buttons: 1 })));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '30 mm' });
    act(() => void a.vp.offer(a.vp.at('up', [55, 10, 10])));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '25 mm' });
    // A press and release on an arrow with no move sets nothing on a side that follows the padding.
    act(() => void a.vp.offer(a.vp.at('down', [10, 30, 10])));
    act(() => void a.vp.offer(a.vp.at('up', [10, 30, 10])));
    await a.settle();
    expect(enclosure(a)!.sides).toEqual({ '+x': '25 mm' });
  });

  it('wraps the bodies picked in its field, or every solid body when none is picked', async () => {
    const a = await start();
    act(() => void block(a.doc, { at: [100, 0, 0] }));
    await a.settle();
    await opened(a);
    expect(a.$('[data-pick-field="bodies"] [data-pick-empty]')!.textContent).toBe('All solid bodies (2): Body 1, Body 2');
    expect(size(a)).toBe('Size: 120 mm × 20 mm × 20 mm · 48,000 mm³');
    const [b1] = a.doc.state.get().rebuild.bodies;
    // Click the list, then a body (here: its row in the tree).
    act(() => void fireEvent.click(a.$('[data-pick-list="bodies"]')!));
    act(() => a.services.selection.set({ items: [{ kind: 'body', body: b1.id }] }));
    await a.settle();
    expect(enclosure(a)!.bodies).toEqual([b1.id]);
    expect(a.$('[data-pick-field="bodies"] [data-pick-empty]')).toBeNull();
    expect(size(a)).toBe('Size: 20 mm × 20 mm × 20 mm · 8000 mm³');
    // Its own body cannot be picked.
    const own = enclosure(a)!.creates;
    act(() => a.services.selection.set({ items: [{ kind: 'body', body: own }] }));
    expect(a.$('[data-pick-error="bodies"]')!.textContent).toBe('Enclosure 1 cannot enclose its own body');
  });
});

describe('panel chrome (as the shell\'s Box panel had it)', () => {
  it('selects the feature it edits while open and lets go on Done', async () => {
    const a = await opened(await start());
    const id = enclosure(a)!.id;
    expect(a.services.selection.get().items).toEqual([{ kind: 'feature', feature: id }]);
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await a.settle();
    expect(a.services.selection.get().items).toEqual([]);
  });

  it('refuses field changes while another tab changed the part, and says why', async () => {
    const a = await opened(await start());
    select(a, 'padding', 'fixed');
    await a.settle();
    const editable = vi.spyOn(a.doc, 'editable').mockReturnValue('Changed in another tab · Reload to keep editing');
    setField(a, 'distance', '77');
    expect(fieldError(a, 'distance')).toBe('Changed in another tab · Reload to keep editing');
    expect(field(a, 'distance').value).toBe('77');
    expect(enclosure(a)!.distance).toBe('10 mm');
    editable.mockRestore();
  });

  it('Delete on a new enclosure discards it; Delete on an existing one removes it (one undo step)', async () => {
    const a = await opened(await start());
    act(() => void fireEvent.click(a.$('[data-panel-delete]')!));
    await a.settle();
    expect(panel(a)).toBeNull();
    expect(history(a)).toEqual(['Sketch 1', 'Extrude 1']);
    expect(a.doc.state.get().history.undoLabel).toBe('Extrude 1');
    await opened(a);
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    const id = enclosure(a)!.id;
    act(() => void fireEvent.doubleClick(a.$(`[data-tree-node="${id}"] > .tree-row`)!));
    expect(title(a)).toBe('Enclosure 1');
    act(() => void fireEvent.click(a.$('[data-panel-delete]')!));
    await a.settle();
    expect(history(a)).toEqual(['Sketch 1', 'Extrude 1']);
    act(() => a.doc.undo());
    await a.settle();
    expect(history(a)).toEqual(['Sketch 1', 'Extrude 1', 'Enclosure 1']);
  });

  it('renames from the title pencil, refusing a name another feature has', async () => {
    const a = await opened(await start());
    act(() => void fireEvent.click(a.$('[data-cad-panel] [data-rename-btn]')!));
    const input = a.$<HTMLInputElement>('[data-cad-panel] .mesh-rename-input')!;
    act(() => void fireEvent.change(input, { target: { value: 'Extrude 1' } }));
    act(() => void fireEvent.keyDown(input, { key: 'Enter' }));
    expect(a.$('[data-cad-panel] .cad-rename-err')!.textContent).toBe('A feature named "Extrude 1" already exists');
    act(() => void fireEvent.change(input, { target: { value: 'Air box' } }));
    act(() => void fireEvent.keyDown(input, { key: 'Enter' }));
    expect(title(a)).toBe('Air box');
    expect(history(a)).toEqual(['Sketch 1', 'Extrude 1', 'Air box']);
    await a.settle();
  });

  it('Ctrl+Z inside a panel cancels that panel only; Escape closes it', async () => {
    const a = await start();
    act(() => void a.doc.rename(a.doc.state.get().doc.features[1].id, 'Base'));
    await a.settle();
    await opened(a);
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    const id = enclosure(a)!.id;
    act(() => void fireEvent.doubleClick(a.$(`[data-tree-node="${id}"] > .tree-row`)!));
    select(a, 'padding', 'fixed');
    await a.settle();
    expect(enclosure(a)!.padding).toBe('fixed');
    act(() => void fireEvent.click(cmd(a, 'edit.undo')));
    await a.settle();
    expect(panel(a)).toBeNull();
    expect(enclosure(a)!.padding).toBe('zero');
    // The earlier rename is still there.
    expect(history(a)).toEqual(['Sketch 1', 'Base', 'Enclosure 1']);
    act(() => void fireEvent.doubleClick(a.$(`[data-tree-node="${id}"] > .tree-row`)!));
    expect(title(a)).toBe('Enclosure 1');
    key('Escape');
    await a.settle();
    expect(panel(a)).toBeNull();
  });

  it('shows the rebuild\'s error in the foot: a picked body that is gone', async () => {
    const a = await opened(await start());
    const b = a.doc.state.get().rebuild.bodies[0].id;
    act(() => a.doc.session()!.update({ bodies: [b] } as Partial<Feature>));
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    act(() => void a.doc.setSuppressed(a.doc.state.get().doc.features[1].id, true));
    await a.settle();
    const id = enclosure(a)!.id;
    expect(a.doc.state.get().rebuild.features[id]).toMatchObject({ state: 'error', message: 'Enclosure 1 failed: Body 1 is not there at this point' });
    act(() => void fireEvent.doubleClick(a.$(`[data-tree-node="${id}"] > .tree-row`)!));
    expect(a.$('[data-cad-panel] [data-run-reason]')!.textContent).toBe('Enclosure 1 failed: Body 1 is not there at this point');
  });

  it('Done is disabled with the reason while a new feature is incomplete, and Escape discards it (an Extrude with no profile)', async () => {
    const a = await start();
    // Two closed profiles shown: Extrude opens with none picked.
    act(() => a.doc.beginNew('sketch', blockSketch(50, 0) as Partial<Feature>).commit());
    act(() => a.doc.beginNew('sketch', blockSketch(80, 0) as Partial<Feature>).commit());
    await a.settle();
    act(() => void fireEvent.click(cmd(a, 'solid.extrude')));
    await a.settle();
    expect(title(a)).toBe('Extrude 2');
    expect((a.doc.state.get().doc.features.find((f) => f.name === 'Extrude 2') as ExtrudeFeature | undefined)).toBeUndefined();
    const done = a.$('[data-panel-done]')!;
    expect(done.getAttribute('aria-disabled')).toBe('true');
    expect(a.$('[data-cad-panel] [data-run-reason]')!.textContent).toBe('Pick a profile');
    act(() => void fireEvent.click(done));
    expect(panel(a)).not.toBeNull();
    key('Escape');
    expect(panel(a)).toBeNull();
    expect(history(a)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Sketch 3']);
  });
});
