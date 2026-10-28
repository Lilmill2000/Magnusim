// The workspace tool and the widened body, undo and view (Daniel's rule: whatever a person can do,
// use or see in the CAD program, the Assistant can too): every action through the person's own
// paths, view state reported as no undo step, the person's view moved only when they asked or
// while the camera latch allows, the Export panel opened filled in, the send to the project with
// its honest outcomes, and undo or redo of the person's own steps with whose step it was.
// On the toy kernel (BlockKernel) with a recording viewport handle.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeybinds, setKeybindsFor } from '../../src/app/keybinds';
import { KEYMAP } from '../../src/app/keymap';
import { runtimeOf } from '../../src/assistant/runtime';
import type { PrefsApi } from '../../src/lib/bridge';
import { readViewInput } from '../../src/assistant/view';
import { LEAVE_AFTER_MS } from '../../src/assistant/tools/workspace';
import exportModule from '../../src/features/export';
import { takeExportPrefill } from '../../src/features/export/prefill';
import { createStateStore } from '../../src/lib/store';
import { createModuleRegistry } from '../../src/modules';
import { railsFor } from '../../src/ui/left-rails';
import { toolbarPrefs } from '../../src/ui/toolbar-layout';
import { uiFor } from '../../src/ui/controller';
import type { LinkController, LinkOutcome } from '../../src/link/controller';
import type { ViewportHandle } from '../../src/types/viewport';
import { block, BlockKernel } from '../doc/blocks';
import { assistantHarness, FEATURE_MODULES, type AssistantHarness } from './harness';

let h: AssistantHarness | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  h?.dispose();
  h = null;
});

const W = (action: string, o: { target?: string; value?: string; items?: string[]; person_asked?: boolean } = {}) => ({ action, target: o.target ?? '', value: o.value ?? '', items: o.items ?? [], person_asked: o.person_asked ?? false });

async function part(): Promise<AssistantHarness> {
  h = await assistantHarness({ kernel: new BlockKernel(), solver: false });
  block(h.doc);
  block(h.doc, { at: [40, 0, 0] });
  await h.settle();
  return h;
}

/** A viewport handle that records the calls the workspace tool makes on the person's view. */
function viewHandle() {
  const calls: { call: string; args: unknown[] }[] = [];
  const rec =
    (call: string) =>
    (...args: unknown[]) =>
      void calls.push({ call, args });
  const state = createStateStore({ display: 'shaded-edges', projection: 'perspective', section: { on: false, plane: 'origin:top', offset: 0, flip: false }, planes: 'auto' });
  const handle = {
    moves: 0,
    state,
    calls,
    userCameraMoves: () => handle.moves,
    fit: rec('fit'),
    setView: rec('setView'),
    lookAt: rec('lookAt'),
    orbitAround: rec('orbitAround'),
    setSection: (p: object) => {
      calls.push({ call: 'setSection', args: [p] });
      state.set({ section: { ...state.get().section, ...p } });
    },
    setProjection: (p: string) => {
      calls.push({ call: 'setProjection', args: [p] });
      state.set({ projection: p });
    },
    setDisplay: (d: string) => {
      calls.push({ call: 'setDisplay', args: [d] });
      state.set({ display: d });
    },
    setPlanes: rec('setPlanes'),
    planeNormal: () => [0, 0, 1],
    refitIfOffScreen: () => false,
    reframe: () => true,
    flash: () => {},
    highlight: () => {},
  };
  return handle;
}

describe('workspace: the tree and the view state', () => {
  it('rolls the bar back after a feature and to the end; an edit of the same request then answers rolled_back at once', async () => {
    const t = await part();
    const r = await t.ok('workspace', W('roll_back_to', { target: 'Extrude 1' }));
    expect(r.text).toMatch(/Rolled back after Extrude 1: 2 features rolled back/);
    expect(r.data.undo_step).toBe(false);
    expect(t.doc.state.get().view.rollback).toBe(2);
    const t0 = Date.now();
    const e = await t.call('set_params', { set: [{ name: 'a', kind: 'length', expr: '3 mm', comment: '', rename_to: '' }], remove: [] });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error.message).toMatch(/You rolled the bar back to after Extrude 1 with workspace: call workspace roll_to_end/);
    expect(Date.now() - t0).toBeLessThan(5000);
    const end = await t.ok('workspace', W('roll_to_end'));
    expect(end.text).toMatch(/at the end/);
    expect(t.doc.state.get().view.rollback).toBeNull();
    expect((await t.call('set_params', { set: [{ name: 'a', kind: 'length', expr: '3 mm', comment: '', rename_to: '' }], remove: [] })).ok).toBe(true);
  });

  it('refuses the bar while the person has a panel open, and names an unknown feature', async () => {
    const t = await part();
    const s = t.doc.beginEdit(t.doc.state.get().doc.features[1].id);
    const busy = await t.call('workspace', W('roll_back_to', { target: 'Sketch 1' }));
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.code).toBe('busy');
    s.discard();
    const nf = await t.call('workspace', W('roll_back_to', { target: 'Nope' }));
    expect(!nf.ok && nf.error.message).toMatch(/No feature is called "Nope"/);
  });

  it("shows and hides a sketch, a body (the eye) and through body's visibility; origin planes", async () => {
    const t = await part();
    const hide = await t.ok('workspace', W('hide', { target: 'Body 1' }));
    expect(hide.text).toBe('Hid Body 1 in the view');
    expect(t.doc.state.get().view.hiddenBodies).toHaveLength(1);
    expect((await t.ok('workspace', W('hide', { target: 'Body 1' }))).text).toBe('Body 1 is already hidden');
    const show = await t.ok('body', { body: 'Body 1', rename_to: '', color: '', simulation: 'keep', visibility: 'show' });
    expect(show.text).toBe('Body Body 1: shown in the view (view state, not an undo step)');
    expect(t.doc.state.get().view.hiddenBodies).toHaveLength(0);
    // A rename and a hide in one call: the rename is the step, the eye after it.
    const both = await t.ok('body', { body: 'Body 2', rename_to: 'Lid', color: '', simulation: 'keep', visibility: 'hide' });
    expect(both.text).toMatch(/renamed Lid; hidden in the view/);
    expect(t.doc.state.get().history.undoLabel).toMatch(/Assistant/);
    const sk = await t.ok('workspace', W('show', { target: 'Sketch 1' }));
    expect(sk.text).toBe('Showed Sketch 1 in the view');
    expect(t.doc.state.get().view.sketches?.[t.doc.state.get().doc.features[0].id]).toBe('shown');
    const ex = await t.call('workspace', W('hide', { target: 'Extrude 1' }));
    expect(!ex.ok && ex.error.message).toMatch(/Extrude 1 has no eye/);
    const vh = viewHandle();
    t.services.viewport.set({ handle: vh as unknown as ViewportHandle });
    expect((await t.ok('workspace', W('origin_planes', { value: 'always' }))).text).toMatch(/always drawn/);
    expect(t.doc.state.get().view.planes).toBe('always');
    expect(vh.calls.find((c) => c.call === 'setPlanes')?.args).toEqual(['always']);
  });

  it('selects features, origin planes and bodies, clears, and sets the filter', async () => {
    const t = await part();
    const r = await t.ok('workspace', W('select', { items: ['Extrude 1', 'Top plane'] }));
    expect(r.text).toBe('Selected 2 things: Extrude 1, Top plane');
    expect(t.services.selection.get().items).toEqual([{ kind: 'feature', feature: t.doc.state.get().doc.features[1].id }, { kind: 'origin', ref: 'origin:top' }]);
    expect((await t.ok('workspace', W('select'))).text).toBe('Cleared the selection');
    expect(t.services.selection.get().items).toEqual([]);
    expect((await t.ok('workspace', W('selection_filter', { items: ['face', 'edge'] }))).text).toBe('Selection filter: face, edge');
    expect(t.services.selection.get().filter).toEqual(['face', 'edge']);
    const bad = await t.call('workspace', W('selection_filter', { items: ['wing'] }));
    expect(!bad.ok && bad.error.message).toMatch(/not wing/);
  });

  it('expands and collapses the tree folders, the tree card and the Sketch panel', async () => {
    const t = await part();
    await t.ok('workspace', W('expand', { target: 'bodies' }));
    expect(t.doc.state.get().view.expanded).toContain('bodies');
    await t.ok('workspace', W('collapse', { target: 'bodies' }));
    expect(t.doc.state.get().view.expanded).not.toContain('bodies');
    await t.ok('workspace', W('collapse', { target: 'tree' }));
    expect(railsFor(t.services).state.get().treeCollapsed).toBe(true);
    await t.ok('workspace', W('collapse', { target: 'sketch_panel' }));
    expect(railsFor(t.services).state.get().sketchCollapsed).toBe(true);
    await t.ok('workspace', W('expand', { target: 'sketch_details' }));
    expect(railsFor(t.services).state.get().sketchDetails).toBe(true);
    const bad = await t.call('workspace', W('expand', { target: 'params' }));
    expect(!bad.ok && bad.error.message).toMatch(/target: origin, bodies, tree/);
  });

  it("moves, shows, hides and resets the person's toolbar layout", async () => {
    const t = await part();
    for (const [id, order] of [
      ['modify.fillet', 1],
      ['modify.chamfer', 2],
      ['modify.shell', 3],
    ] as const)
      t.services.commands.register({ id, label: id.slice(7), group: 'modify', icon: 'M0 0', order, run() {} });
    const prefs = toolbarPrefs(t.services);
    await t.ok('workspace', W('toolbar_show', { target: 'modify.shell' }));
    expect(prefs.state.get().layout.model.place['modify.shell']).toBe('bar');
    await t.ok('workspace', W('toolbar_hide', { target: 'modify.fillet' }));
    expect(prefs.state.get().layout.model.place['modify.fillet']).toBe('more');
    const mv = await t.ok('workspace', W('toolbar_move', { target: 'modify.shell', value: 'before modify.fillet' }));
    expect(mv.data.order).toEqual(['modify.shell', 'modify.fillet', 'modify.chamfer']);
    const bad = await t.call('workspace', W('toolbar_move', { target: 'modify.shell', value: 'before solid.extrude' }));
    expect(!bad.ok && bad.error.message).toMatch(/not another command of shell's group/);
    await t.ok('workspace', W('toolbar_reset', { value: 'model' }));
    expect(prefs.state.get().layout.model).toEqual({ place: {}, order: {} });
    const nf = await t.call('workspace', W('toolbar_show', { target: 'modify.nope' }));
    expect(!nf.ok && nf.error.message).toMatch(/is not a toolbar command/);
    // v0.5.0 ribbon: a group's width and the toolbar's rows, as the person drags them.
    const w = await t.ok('workspace', W('toolbar_width', { target: 'modify', value: '120' }));
    expect(w.data).toMatchObject({ group: 'modify', mode: 'model', width: 120 });
    expect(prefs.state.get().layout.model.widths).toEqual({ modify: 120 });
    await t.ok('workspace', W('toolbar_width', { target: 'modify', value: 'auto' }));
    expect(prefs.state.get().layout.model.widths).toBeUndefined();
    const badW = await t.call('workspace', W('toolbar_width', { target: 'modify', value: '5' }));
    expect(!badW.ok && badW.error.message).toMatch(/24 to 1200/);
    const badG = await t.call('workspace', W('toolbar_width', { target: 'nope', value: '100' }));
    expect(!badG.ok && badG.error.message).toMatch(/a toolbar group/);
    const r = await t.ok('workspace', W('toolbar_rows', { target: 'model', value: '2' }));
    expect(r.data).toMatchObject({ mode: 'model', rows: 2 });
    expect(prefs.state.get().layout.model.rows).toBe(2);
    const badR = await t.call('workspace', W('toolbar_rows', { target: 'model', value: '6' }));
    expect(!badR.ok && badR.error.message).toMatch(/1 to 4/);
    await t.ok('workspace', W('toolbar_rows', { value: 'auto' }));
    expect(prefs.state.get().layout.model.rows).toBeUndefined();
    // Review 9: "" reads them, as the person sees them (no toolbar on screen here: the stored values).
    await t.ok('workspace', W('toolbar_width', { target: 'modify', value: '150' }));
    const rw = await t.ok('workspace', W('toolbar_width', { target: 'modify' }));
    expect(rw.data).toMatchObject({ group: 'modify', mode: 'model', width: 150, shown: false });
    const rr = await t.ok('workspace', W('toolbar_rows', { target: 'model' }));
    expect(rr.data).toMatchObject({ mode: 'model', rows: 3, widths: { modify: 150 } });
    expect(rr.text).toMatch(/modify 150 px/);
  });

  it('toolbar_width and toolbar_show answer what the person sees: the width applied (never under the group\'s first command and its More), what is on the bar and in its More, a command a narrowed group still holds', async () => {
    const t = await part();
    t.services.commands.register({ id: 'modify.shell', label: 'Shell', group: 'modify', icon: 'M0 0', order: 3, run() {} });
    const prefs = toolbarPrefs(t.services);
    // The toolbar as the person sees it (jsdom has no layout: the group's measured state as drawn).
    const bar = document.createElement('div');
    bar.setAttribute('data-cad-toolbar', 'model');
    bar.innerHTML =
      '<div class="tb-group" data-group="modify" data-width="90" data-min-width="90" data-width-folded="1">' +
      '<div class="tb-items"><button class="tb-btn" data-command="modify.fillet"></button>' +
      '<button class="tb-btn" data-tb-more="modify" data-more-commands="modify.shell"></button></div></div>';
    document.body.append(bar);
    try {
      // Review 1: 40 px is narrower than Fillet and its More (90 px): 90 px is kept, and said.
      const w = await t.ok('workspace', W('toolbar_width', { target: 'modify', value: '40' }));
      expect(prefs.state.get().layout.model.widths).toEqual({ modify: 90 });
      expect(w.data).toMatchObject({ width: 90, min_width: 90, bar: ['modify.fillet'], more: ['modify.shell'], shown: true });
      expect(w.text).toMatch(/40 px is narrower than its first command and its More: 90 px is the least/);
      // Review 2: Shell set to show, but the narrowed group still holds it in its More: said so.
      const s = await t.ok('workspace', W('toolbar_show', { target: 'modify.shell' }));
      expect(s.text).toMatch(/still in its group's More: the group is narrowed to 90 px/);
      expect(s.data).toMatchObject({ shown: 'more', narrowed: true });
      // Integration review 6: a command the narrowed group could not fit even with its other commands
      // folded (the person's Show in toolbar is greyed): nothing changes, and the reply says why.
      await t.ok('workspace', W('toolbar_hide', { target: 'modify.shell' }));
      bar.querySelector<HTMLElement>('.tb-group')!.dataset.tooNarrowFor = 'modify.shell';
      const blocked = await t.ok('workspace', W('toolbar_show', { target: 'modify.shell' }));
      expect(blocked.text).toMatch(/does not fit its group at 90 px.*nothing changed/);
      expect(blocked.data).toMatchObject({ changed: false, narrowed: true });
      expect(prefs.state.get().layout.model.place['modify.shell']).toBe('more');
    } finally {
      bar.remove();
    }
  });

  it('a flyout variant moves with its flyout, as a toolbar button of the person does (v0.5.0 flyouts)', async () => {
    const t = await part();
    for (const [id, order, flyout] of [
      ['sketch.line', 1, 'line'],
      ['sketch.centerline', 2, 'line'],
      ['sketch.point', 3, undefined],
    ] as const)
      t.services.commands.register({ id, label: id.slice(7), group: 'draw', mode: 'sketch', icon: 'M0 0', order, ...(flyout ? { flyout } : {}), run() {} });
    const prefs = toolbarPrefs(t.services);
    const r = await t.ok('workspace', W('toolbar_hide', { target: 'sketch.centerline' }));
    expect(r.data).toMatchObject({ command: 'sketch.line', place: 'more', mode: 'sketch' });
    expect(prefs.state.get().layout.sketch.place).toEqual({ 'sketch.line': 'more' });
    const mv = await t.ok('workspace', W('toolbar_move', { target: 'sketch.point', value: 'before sketch.centerline' }));
    expect(mv.data.order).toEqual(['sketch.point', 'sketch.line']);
  });

  it('places and takes away the banana, and a sketch\'s taped banana', async () => {
    const t = await part();
    const r = await t.ok('workspace', W('banana_place', { value: '60, 10, 0, 90' }));
    expect(r.text).toMatch(/at \(60, 10, 0\) mm/);
    expect(t.doc.state.get().view.scaleModels?.banana).toEqual({ at: [60, 10, 0], rot: 90 });
    expect((await t.ok('workspace', W('banana_show'))).text).toBe('The banana is already shown');
    await t.ok('workspace', W('banana_hide'));
    expect(t.doc.state.get().view.scaleModels?.banana).toBeUndefined();
    const sk = await t.ok('workspace', W('banana_show', { target: 'Sketch 1' }));
    expect(sk.text).toMatch(/taped banana is in Sketch 1/);
    const id = t.doc.state.get().doc.features[0].id;
    expect(t.doc.state.get().view.scaleModels?.sketch?.[id]).toBeTruthy();
    await t.ok('workspace', W('banana_place', { target: 'Sketch 1', value: '5, 6' }));
    expect(t.doc.state.get().view.scaleModels?.sketch?.[id]).toEqual({ at: [5, 6] });
    await t.ok('workspace', W('banana_hide', { target: 'Sketch 1' }));
    expect(t.doc.state.get().view.scaleModels?.sketch?.[id]).toBeUndefined();
  });
});

describe('workspace: the Part and the session', () => {
  it('renames the Part (the study title) as the tree does', async () => {
    const t = await part();
    const r = await t.ok('workspace', W('rename_part', { value: 'Bracket' }));
    expect(r.text).toBe('Renamed the Part Bracket (was Part 1)');
    expect((await t.services.bridge.study.get()).title).toBe('Bracket');
  });

  it('save and kernel retries say when there is nothing to do; reload and Keep mine ask the person on a conflict', async () => {
    const t = await part();
    expect((await t.ok('workspace', W('retry_save'))).text).toMatch(/Nothing to retry: the save is/);
    expect((await t.ok('workspace', W('retry_kernel'))).text).toBe('Nothing to retry: the kernel is ready');
    expect((await t.ok('workspace', W('reload'))).text).toMatch(/Nothing to reload/);
    expect((await t.ok('workspace', W('keep_mine'))).text).toMatch(/Nothing to keep/);
    const real = t.doc.state.get.bind(t.doc.state);
    vi.spyOn(t.doc.state, 'get').mockImplementation(() => ({ ...real(), save: { state: 'conflict', message: 'Changed in another tab' } }));
    const keep = vi.spyOn(t.doc, 'keepMine').mockResolvedValue();
    const reload = vi.spyOn(t.doc, 'reload').mockResolvedValue();
    t.ws.answers.confirm = false;
    expect((await t.ok('workspace', W('keep_mine'))).text).toMatch(/did not confirm/);
    expect((await t.ok('workspace', W('reload'))).text).toMatch(/kept this tab as it is/);
    expect(keep).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    t.ws.answers.confirm = true;
    expect((await t.ok('workspace', W('keep_mine'))).text).toMatch(/Kept this tab's version/);
    expect((await t.ok('workspace', W('reload'))).text).toMatch(/Reloaded/);
    expect(keep).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(t.ws.log.confirms.map((c) => c.confirmLabel)).toEqual(['Keep mine', 'Reload', 'Keep mine', 'Reload']);
  });

  it("asks the person to pick a STEP file, and refuses a heal of a feature that is no import", async () => {
    const t = await part();
    const r = await t.ok('workspace', W('import_step'));
    expect(r.data.asked_person).toBe(true);
    expect(t.ws.log.toasts.at(-1)?.message).toMatch(/pick a STEP file/);
    const heal = await t.call('workspace', W('reheal', { target: 'Extrude 1', value: '0.01 mm', items: ['knit'] }));
    expect(!heal.ok && heal.error.message).toMatch(/Extrude 1 is not an Imported STEP/);
  });

  it("opens the person's Export STEP panel filled in; refused while they have a panel open", async () => {
    const t = await part();
    t.services.modules = createModuleRegistry([...FEATURE_MODULES, exportModule]);
    t.services.commands.register({ id: 'file.export-step', label: 'Export STEP', group: 'file', icon: 'M0 0', run() {} });
    const r = await t.ok('workspace', W('export_step', { target: 'AP242', value: 'bracket v2', items: ['Body 2'] }));
    expect(r.text).toBe('Opened Export STEP filled in: bracket v2.step, AP242, Body 2; the person clicks Export to download it');
    expect(uiFor(t.services).state.get().panel).toEqual({ kind: 'tool', tool: 'file.export-step', owner: 'person' });
    const b2 = t.doc.state.get().rebuild.bodies.find((b) => b.name === 'Body 2')!.id;
    expect(takeExportPrefill(t.services)).toEqual({ schema: 'AP242', name: 'bracket v2.step', bodies: [b2] });
    const again = await t.call('workspace', W('export_step'));
    expect(!again.ok && again.error.message).toMatch(/Export STEP waits for the person: the Export STEP panel is open/);
  });

  it('sends the Part to the project with the honest outcome, and leaves after its answer only when asked', async () => {
    const t = await part();
    const none = await t.call('workspace', W('send_to_simulation'));
    expect(!none.ok && none.error.message).toMatch(/cannot link the Part/);
    let next: LinkOutcome = { outcome: 'linked', sourceVersion: 4, result: { geometryId: 'g1', created: false } as never };
    const link = { sync: vi.fn(async () => next), running: false, last: null } as unknown as LinkController;
    t.services.apis.set({ link });
    const r = await t.ok('workspace', W('send_to_simulation'));
    expect(r.text).toBe("Sent the Part to the project: its geometry is updated (version 4)");
    expect(r.data).toMatchObject({ outcome: 'linked', geometry: 'g1', leaving: false });
    next = { outcome: 'kept-editing', sourceVersion: 4 };
    expect((await t.ok('workspace', W('send_to_simulation', { value: 'leave' }))).data).toMatchObject({ outcome: 'kept-editing', leaving: false });
    // A host with no project (the CAD desktop edition): saved, nowhere to send it, said plainly.
    next = { outcome: 'nothing', message: '', empty: false, linked: false, noProject: true };
    const np = await t.ok('workspace', W('send_to_simulation'));
    expect(np.text).toBe('This app has no project to send the Part to: the Part is saved, and nothing was sent');
    expect(np.data).toMatchObject({ outcome: 'no_project', leaving: false });
    next = { outcome: 'failed', code: 'plugin_needed', message: 'The project needs the Heat Transfer plugin.' };
    const f = await t.call('workspace', W('send_to_simulation'));
    expect(!f.ok && f.error).toMatchObject({ code: 'failed', message: 'link_failed: The project needs the Heat Transfer plugin.' });
    // Leave: the answer first, Back after it.
    next = { outcome: 'unchanged', sourceVersion: 4, geometryId: 'g1' };
    const backs = t.ws.log.backs;
    const l = await t.ok('workspace', W('send_to_simulation', { value: 'leave' }));
    expect(l.text).toMatch(/nothing was sent; the Part closes now/);
    expect(t.ws.log.backs).toBe(backs);
    await vi.waitFor(() => expect(t.ws.log.backs).toBe(backs + 1), { timeout: LEAVE_AFTER_MS + 3000 });
  });
});

describe("workspace: the person's view", () => {
  it('moves while the latch allows, refuses once the person moved the view, and moves when the person asked', async () => {
    const t = await part();
    const vh = viewHandle();
    t.services.viewport.set({ handle: vh as unknown as ViewportHandle });
    t.fake.emitTurn({ id: 't1', title: 'Look' });
    const r = await t.ok('workspace', W('standard_view', { value: 'top' }), { turn: 't1' });
    expect(r.text).toBe("Turned the person's view to top");
    expect(vh.calls.at(-1)).toEqual({ call: 'setView', args: ['top', { auto: true, animate: true }] });
    vh.moves += 1;
    const latched = await t.call('workspace', W('fit'), { turn: 't1' });
    expect(latched.ok).toBe(false);
    if (!latched.ok) expect(latched.error).toMatchObject({ code: 'busy', detail: { reason: 'view_latched' } });
    const asked = await t.ok('workspace', W('fit', { person_asked: true }), { turn: 't1' });
    expect(asked.data.person_asked).toBe(true);
    expect(vh.calls.at(-1)?.call).toBe('fit');
    // A pointer held in the frame: never, asked or not.
    vi.spyOn(runtimeOf(t.services)!.soft, 'held').mockReturnValue(true);
    expect((await t.call('workspace', W('fit', { person_asked: true }), { turn: 't1' })).ok).toBe(false);
  });

  it('normal to, orbit pivot, section, projection and display', async () => {
    const t = await part();
    const vh = viewHandle();
    t.services.viewport.set({ handle: vh as unknown as ViewportHandle });
    const A = { person_asked: true };
    await t.ok('workspace', W('normal_to', { target: 'Top plane', ...A }));
    expect(vh.calls.at(-1)?.call).toBe('lookAt');
    expect(vh.calls.at(-1)?.args[0]).toEqual([0, 0, 1]);
    await t.ok('workspace', W('normal_to', { target: 'Sketch 1', ...A }));
    expect(vh.calls.at(-1)?.call).toBe('lookAt');
    expect(vh.calls.at(-1)?.args[0]).toEqual([0, 0, 1]);
    await t.ok('workspace', W('orbit_pivot', { target: 'origin', ...A }));
    expect(vh.calls.at(-1)).toEqual({ call: 'orbitAround', args: [[0, 0, 0], { auto: true }] });
    await t.ok('workspace', W('orbit_pivot', { target: '(1, 2, 3)', ...A }));
    expect(vh.calls.at(-1)?.args[0]).toEqual([1, 2, 3]);
    const sec = await t.ok('workspace', W('section', { value: 'Top offset 5 mm flip', ...A }));
    expect(vh.state.get().section).toMatchObject({ on: true, plane: 'origin:top', offset: 5, flip: true });
    expect(sec.data.view).toMatchObject({ section: { plane: 'top', offset_mm: 5, flip: true } });
    await t.ok('workspace', W('section', { value: 'off', ...A }));
    expect(vh.state.get().section.on).toBe(false);
    await t.ok('workspace', W('projection', { value: 'orthographic', ...A }));
    expect(vh.state.get().projection).toBe('orthographic');
    const d = await t.ok('workspace', W('display', { value: 'wireframe', ...A }));
    expect(vh.state.get().display).toBe('wireframe');
    expect(d.data.view).toMatchObject({ display: 'wireframe', projection: 'orthographic' });
    const bad = await t.call('workspace', W('display', { value: 'xray', ...A }));
    expect(!bad.ok && bad.error.message).toMatch(/shaded_edges, shaded or wireframe/);
  });

  it('says so without a view', async () => {
    const t = await part();
    const r = await t.call('workspace', W('fit', { person_asked: true }));
    expect(!r.ok && r.error).toMatchObject({ code: 'not_ready' });
  });

  it("view's pictures take a display mode and a projection (shaded with edges, orthographic when absent)", () => {
    const base = { views: ['iso'], hide: [], section: '', labels: 'none', size: 'small' };
    expect(readViewInput(base)).toMatchObject({ display: 'shaded-edges', projection: 'orthographic' });
    expect(readViewInput({ ...base, display: 'wireframe', projection: 'perspective' })).toMatchObject({ display: 'wireframe', projection: 'perspective' });
    expect(() => readViewInput({ ...base, display: 'xray' })).toThrow(/display must be/);
  });
});

describe('undo and redo of anyone\'s steps', () => {
  it("undoes and redoes the person's own step, and says whose it was", async () => {
    const t = await part();
    expect(t.doc.state.get().doc.features).toHaveLength(4);
    const u = await t.ok('undo', { action: 'undo', steps: 1, previous_turn: false });
    expect(u.text).toMatch(/^Undid .+ \(the person's\)$/);
    expect(u.data.undone).toEqual([{ label: expect.any(String), by: 'person' }]);
    expect(t.doc.state.get().doc.features).toHaveLength(3);
    const r = await t.ok('undo', { action: 'redo', steps: 1, previous_turn: false });
    expect(r.text).toMatch(/^Redid .+ \(the person's\)$/);
    expect(t.doc.state.get().doc.features).toHaveLength(4);
    // An Assistant request's step is named as one.
    await t.ok('set_params', { set: [{ name: 'a', kind: 'length', expr: '3 mm', comment: '', rename_to: '' }], remove: [] });
    const a = await t.ok('undo', { action: 'undo', steps: 1, previous_turn: false }, { turn: 't-other' });
    expect(a.text).toMatch(/\(an Assistant request\)$/);
    expect(t.doc.state.get().doc.params).toHaveLength(0);
    const tooMany = await t.call('undo', { action: 'redo', steps: 5, previous_turn: false });
    expect(!tooMany.ok && tooMany.error.message).toMatch(/1 step can be redone, not 5/);
    // own stays as it was (no action: own).
    const own = await t.call('undo', { steps: 1, previous_turn: false });
    expect(!own.ok && own.error.message).toMatch(/None of your calls|person changed/);
  });
});

// ------------------------------------------------------------------ keybinds

/** ws.prefs in memory: what was written, and a change made elsewhere (Settings) told to the page. */
function memoryPrefs() {
  const values: Record<string, unknown> = {};
  const writes: string[] = [];
  const listeners = new Set<(key: string, value: unknown) => void>();
  const api: PrefsApi = {
    get: async <T,>(key: string) => (key in values ? (JSON.parse(JSON.stringify(values[key])) as T) : null),
    set: async (key, value) => {
      writes.push(`set ${key}`);
      values[key] = JSON.parse(JSON.stringify(value));
    },
    remove: async (key) => {
      writes.push(`remove ${key}`);
      delete values[key];
    },
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return { api, values, writes };
}

async function keybindPart() {
  const t = await part();
  const prefs = memoryPrefs();
  const k = createKeybinds({ prefs: prefs.api, layout: false });
  setKeybindsFor(t.services, k);
  await k.ready;
  return { t, k, prefs };
}

describe('workspace: keybinds (Daniel: read any time, changed only when the person asks, and they confirm)', () => {
  it('keybind_get answers any time, without person_asked and without a question: one command or all', async () => {
    const { t } = await keybindPart();
    const one = await t.ok('workspace', W('keybind_get', { target: 'sketch.rectangle' }));
    expect(one.text).toBe('Rectangle: R');
    expect(one.data.keybind).toEqual({ id: 'sketch.rectangle', label: 'Rectangle', context: 'sketch', keys: ['KeyR'], shown: 'R', default: true, set_in: 'in a sketch, right-click Rectangle on the toolbar, then Set keybind…' });
    // By label too; a label two commands share needs the id.
    expect((await t.ok('workspace', W('keybind_get', { target: 'show relations' }))).text).toBe('Show relations: Shift+R');
    const twin = await t.call('workspace', W('keybind_get', { target: 'Undo' }));
    expect(!twin.ok && twin.error.message).toMatch(/names 2 commands: edit.undo \(model\), sketch.undo \(sketch\)/);
    const all = await t.ok('workspace', W('keybind_get'));
    const rows = all.data.keybinds as { id: string; keys: string[] }[];
    expect(rows.map((r) => r.id)).toEqual(KEYMAP.map((e) => e.id));
    expect(rows.find((r) => r.id === 'edit.redo')!.keys).toEqual(['Ctrl+KeyY', 'Ctrl+Shift+KeyZ']);
    expect(t.ws.log.confirms).toEqual([]);
  });

  it('keybind_set without person_asked is refused (not_asked): nothing changes, no question', async () => {
    const { t, k, prefs } = await keybindPart();
    const r = await t.call('workspace', W('keybind_set', { target: 'sketch.rectangle', value: 'Shift+T' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.detail).toMatchObject({ reason: 'not_asked' });
      expect(r.error.hint).toMatch(/explicitly asked .* Set keybind/);
    }
    for (const action of ['keybind_reset', 'keybind_clear']) {
      const x = await t.call('workspace', W(action, { target: 'sketch.rectangle' }));
      expect(!x.ok && (x.error.detail as { reason: string }).reason, action).toBe('not_asked');
    }
    expect(k.current('sketch.rectangle')).toEqual(['KeyR']);
    expect(prefs.writes).toEqual([]);
    expect(t.ws.log.confirms).toEqual([]);
  });

  it("person_asked with the person's No in the app's dialog: step_declined, nothing changes; Yes: changed and stored", async () => {
    const { t, k, prefs } = await keybindPart();
    t.ws.answers.confirm = false;
    const no = await t.call('workspace', W('keybind_set', { target: 'sketch.rectangle', value: 'Shift+T', person_asked: true }));
    expect(!no.ok && (no.error.detail as { reason: string }).reason).toBe('step_declined');
    expect(k.current('sketch.rectangle')).toEqual(['KeyR']);
    expect(prefs.writes).toEqual([]);
    // The app's guarded dialog: Yes takes a deliberate click (never a stray Enter: Enter answers Cancel).
    // The wording the host's Settings and core__set_keybind ask with too.
    expect(t.ws.log.confirms).toEqual([{ title: 'Change a keybind?', message: 'Magnusim CAD · Rectangle: R → Shift+T', confirmLabel: 'Change', cancelLabel: 'Keep it', guard: true, safe: true }]);
    t.ws.answers.confirm = true;
    const yes = await t.ok('workspace', W('keybind_set', { target: 'sketch.rectangle', value: 'Shift+T', person_asked: true }));
    expect(yes.text).toBe('Rectangle: Shift+T (was R)');
    expect(yes.data).toMatchObject({ keybind: { keys: ['Shift+KeyT'], default: false, defaults: 'R' }, stored: true, undo_step: false });
    expect(k.current('sketch.rectangle')).toEqual(['Shift+KeyT']);
    expect(prefs.values.keybinds).toEqual({ 'sketch.rectangle': ['Shift+KeyT'] });
    // Every change asks, every time: clear, then reset.
    expect((await t.ok('workspace', W('keybind_clear', { target: 'sketch.rectangle', person_asked: true }))).text).toBe('Rectangle: none (was Shift+T)');
    expect(prefs.values.keybinds).toEqual({ 'sketch.rectangle': [] });
    expect((await t.ok('workspace', W('keybind_reset', { target: 'sketch.rectangle', person_asked: true }))).text).toBe('Rectangle: R (was none)');
    expect(prefs.values.keybinds).toBeUndefined();
    expect(t.ws.log.confirms.map((c) => [c.title, c.message, c.confirmLabel])).toEqual([
      ['Change a keybind?', 'Magnusim CAD · Rectangle: R → Shift+T', 'Change'],
      ['Change a keybind?', 'Magnusim CAD · Rectangle: R → Shift+T', 'Change'],
      ['Clear a keybind?', 'Magnusim CAD · Rectangle: Shift+T → no key', 'Clear'],
      ['Reset a keybind?', 'Magnusim CAD · Rectangle: no key → R', 'Reset'],
    ]);
    // A reset to what it has already asks nothing.
    expect((await t.ok('workspace', W('keybind_reset', { target: 'sketch.rectangle', person_asked: true }))).text).toBe('Rectangle already has R: nothing changed');
    expect(t.ws.log.confirms).toHaveLength(4);
  });

  it("another command's key is key_taken unless items replace (asked too); browser and app keys are refused before any question", async () => {
    const { t, k } = await keybindPart();
    const taken = await t.call('workspace', W('keybind_set', { target: 'sketch.rectangle', value: 'Shift+R', person_asked: true }));
    expect(!taken.ok && taken.error.detail).toMatchObject({ reason: 'key_taken', with: ['view.sketch-relations'], labels: ['Show relations (sketch)'] });
    expect(t.ws.log.confirms).toEqual([]);
    const r = await t.ok('workspace', W('keybind_set', { target: 'sketch.rectangle', value: 'shift+r', items: ['replace'], person_asked: true }));
    expect(t.ws.log.confirms.at(-1)!.message).toBe('Magnusim CAD · Rectangle: R → Shift+R; Magnusim CAD · Show relations (sketch): Shift+R → no key');
    expect(r.text).toBe('Rectangle: Shift+R (was R); Show relations (sketch) no longer has it');
    expect(k.current('view.sketch-relations')).toEqual([]);
    for (const [value, words] of [
      ['Ctrl+W', /"Ctrl\+KeyW" is kept for the browser and the system \(Close the tab\)/],
      ['Ctrl+/', /"Ctrl\+Slash" is the app's own key \(Open or close the Assistant panel\)/],
      ['Escape', /"Escape" is CAD's built-in cancel key/],
      ['Ctrl+P', /"Ctrl\+KeyP" is kept for the browser and the system \(Print the page\)/],
    ] as const) {
      const x = await t.call('workspace', W('keybind_set', { target: 'sketch.circle', value, person_asked: true }));
      expect(!x.ok && x.error.message, value).toMatch(words);
    }
    expect(t.ws.log.confirms).toHaveLength(1);
    expect(k.current('sketch.circle')).toEqual(['KeyC']);
  });

  it('a key no keyboard reports, a modifier a shortcut cannot use or two keys are refused with why, before any question (review: a dead key could be stored)', async () => {
    const { t, k, prefs } = await keybindPart();
    for (const [value, words] of [
      ['Ctrl+PgDown2', /^bad_input: value: "Ctrl\+PgDown2" is not a key \(modifiers Ctrl, Alt, Shift, Meta in that order, then a KeyboardEvent\.code such as KeyR\)/],
      ['Shift+?', /"Shift\+\?" is not a key/],
      ['AltGr+Q', /"AltGr\+Q" is not a key/],
      ['Ctrl+A+B', /"Ctrl\+A\+B" is not a key/],
      ['F (no change: keep)', /is not a key/],
      ['Ctrl+Numpad5', /"Ctrl\+Numpad5" never comes from a press: write "Ctrl\+Digit5"/],
    ] as const) {
      const x = await t.call('workspace', W('keybind_set', { target: 'view.fit', value, person_asked: true }));
      expect(!x.ok && x.error.message, value).toMatch(words);
    }
    // A name people write is read as the key it is: PgDn is PageDown.
    expect((await t.ok('workspace', W('keybind_set', { target: 'view.fit', value: 'Shift+PgDn', person_asked: true }))).text).toBe('Fit: Shift+PageDown (was F)');
    expect(t.ws.log.confirms.map((c) => c.message)).toEqual(['Magnusim CAD · Fit: F → Shift+PageDown']);
    expect(k.current('view.fit')).toEqual(['Shift+PageDown']);
    expect(prefs.values.keybinds).toEqual({ 'view.fit': ['Shift+PageDown'] });
  });

  it('a key two commands have: the question names both and where they work (review)', async () => {
    const { t } = await keybindPart();
    await t.ok('workspace', W('keybind_set', { target: 'view.front', value: 'Delete', items: ['replace'], person_asked: true }));
    expect(t.ws.log.confirms.at(-1)!.message).toBe(
      'Magnusim CAD · Front view: 1 → Delete; Magnusim CAD · Delete selected features (model): Delete → no key; Magnusim CAD · Delete (sketch): Delete → no key',
    );
  });

  it('the keybinds changed while the person was asked: nothing changes, and the Assistant is told to ask again (review: Replace took a key the question did not name)', async () => {
    const { t, k } = await keybindPart();
    // While the dialog is open, Settings gives Plane the key R too (a conflict stored elsewhere).
    vi.spyOn(t.services.bridge, 'confirm').mockImplementation(async () => {
      k.replace('construct.plane', 'R');
      return true;
    });
    const r = await t.call('workspace', W('keybind_set', { target: 'view.fit', value: 'R', items: ['replace'], person_asked: true }));
    expect(!r.ok && r.error.detail).toMatchObject({ reason: 'changed' });
    expect(!r.ok && r.error.hint).toBe('Call keybind_get, then ask the person again with the new wording.');
    // Fit kept F; Rectangle and Plane keep R.
    expect(k.current('view.fit')).toEqual(['KeyF']);
    expect(k.current('sketch.rectangle')).toEqual(['KeyR']);
    expect(k.current('construct.plane')).toEqual(['KeyR']);
  });

  it("not_asked tells where the person sets that command's keybind; keybind_get says it per command (review: the hint named a right-click that did not exist)", async () => {
    const { t } = await keybindPart();
    const r = await t.call('workspace', W('keybind_set', { target: 'ui.delete', value: 'Backspace' }));
    const where = "right-click the Part's row at the top of the design tree (or a feature's row), then Set keybind for Delete…";
    expect(!r.ok && r.error.hint).toBe(`Only change keybinds when the person explicitly asked for that change in this request; otherwise tell them how to do it themselves: ${where}.`);
    expect(!r.ok && r.error.detail).toMatchObject({ reason: 'not_asked', set_in: where });
    const all = await t.ok('workspace', W('keybind_get'));
    const rows = all.data.keybinds as { id: string; set_in: string }[];
    expect(rows.every((x) => /Set keybind/.test(x.set_in))).toBe(true);
    expect(rows.find((x) => x.id === 'sketch.enter')!.set_in).toMatch(/right-click Finish sketch on the toolbar/);
  });

  it("the person's keybinds unreadable: keybind_get says the keys are the defaults, and a change is refused before any question (review)", async () => {
    const t = await part();
    const prefs = memoryPrefs();
    prefs.values.keybinds = { 'view.fit': ['KeyG'] };
    prefs.api.get = async () => {
      throw new Error('the host did not answer');
    };
    const k = createKeybinds({ prefs: prefs.api, layout: false });
    setKeybindsFor(t.services, k);
    await k.ready;
    const g = await t.ok('workspace', W('keybind_get', { target: 'view.fit' }));
    expect(g.text).toBe("Not the person's keys: your keybinds could not be read, so they cannot be changed now (nothing was changed): the host did not answer; these are the defaults. Fit: F");
    expect(g.data).toMatchObject({ known: false });
    const x = await t.call('workspace', W('keybind_set', { target: 'inspect.measure', value: 'F', items: ['replace'], person_asked: true }));
    expect(!x.ok && x.error.detail).toMatchObject({ reason: 'not_editable', known: false });
    expect(!x.ok && x.error.message).toMatch(/Your keybinds could not be read, so they cannot be changed now/);
    expect(t.ws.log.confirms).toEqual([]);
    expect(prefs.writes).toEqual([]);
  });

  it("keybind_get on Finish sketch says what the person sees: none of its own, Enter (Place or finish) finishes the sketch (review)", async () => {
    const { t } = await keybindPart();
    const r = await t.ok('workspace', W('keybind_get', { target: 'sketch.finish' }));
    expect(r.text).toBe('Finish sketch: none of its own; Enter runs Place or finish');
    expect(r.data.keybind).toMatchObject({ keys: [], shown: 'none of its own; Enter runs Place or finish', via: { id: 'sketch.enter', label: 'Place or finish', shown: 'Enter' } });
    await t.ok('workspace', W('keybind_set', { target: 'sketch.finish', value: 'Ctrl+Enter', person_asked: true }));
    expect(t.ws.log.confirms.at(-1)!.message).toBe('Magnusim CAD · Finish sketch: no key → Ctrl+Enter');
  });
});
