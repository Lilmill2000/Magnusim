// Delete body (Daniel 2026-10-28: "I can hide it or rename it or even color it, but I can't remove
// it"): the feature's build (no kernel call: the bodies are dropped; a body not there at this point
// fails it), its record through the document over the toy kernel (one undo step, Undo brings the
// body back and Redo takes it again, suppress brings it back, a lost body fails red and an edit
// recovers it, a stored Part keeps it), and the body menu's Delete on the real document (danger,
// last, disabled with the reason while the Part cannot be edited; several bodies selected: one
// feature for them all) and the Delete key with only bodies selected.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../../src/app/commands';
import { createKeyboard } from '../../../src/app/keyboard';
import { createDocService } from '../../../src/doc';
import { emptyDoc, readDoc } from '../../../src/doc/schema';
import { createUnitsService } from '../../../src/doc/units';
import deleteBodyModule from '../../../src/features/delete_body';
import { deleteBodyDef } from '../../../src/features/delete_body/feature';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import { createSelectionStore } from '../../../src/lib/selection';
import { createStateStore } from '../../../src/lib/store';
import { createModuleRegistry } from '../../../src/modules';
import type { AppServices, AreaApis } from '../../../src/types/app';
import type { Mode } from '../../../src/types/commands';
import type { CadDoc, DeleteBodyFeature, Feature } from '../../../src/types/doc';
import type { BuiltBody, DocService, FeatureTypeDef } from '../../../src/types/doc-service';
import type { CadEvents } from '../../../src/types/events';
import type { ViewportHandle } from '../../../src/types/viewport';
import { installUi } from '../../../src/ui/commands';
import { uiFor } from '../../../src/ui/controller';
import type { MenuEntry, MenuItem } from '../../../src/ui/kit';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';
import { block, BlockKernel, registerSolidFeatures } from '../../doc/blocks';
import { ctxOf, scriptKernel } from '../p2/script-kernel';

const units = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));
const built = (id: string, shape: number): BuiltBody => ({ id, shape, valid: true, feature: `f_${id}`, names: null });
const BODIES = [built('b_1', 1), built('b_2', 2)];
const docOf: CadDoc = { ...emptyDoc('metric'), bodies: { b_1: { name: 'Body 1', color: '#bdc9db' }, b_2: { name: 'Body 2', color: '#bdc9db' } } };
const f = (over: Partial<DeleteBodyFeature> = {}): DeleteBodyFeature => ({ id: 'f_d', type: 'delete_body', name: 'Body-Delete 1', bodies: ['b_1'], ...over });

describe('Delete body: the build', () => {
  it('drops the bodies with no kernel call; a body named twice once', async () => {
    const k = scriptKernel();
    const r = await deleteBodyDef.build(f({ bodies: ['b_1', 'b_2', 'b_1'] }), {}, ctxOf(k, BODIES, { doc: docOf }));
    expect(r).toEqual({ ok: true, bodies: [], removed: ['b_1', 'b_2'] });
    expect(k.calls).toEqual([]);
    expect(deleteBodyDef.uses!(f({ bodies: ['b_1', 'b_1'] }))).toEqual(['b_1']);
  });

  it('a body that is not there at this point fails it, by name; nothing picked is said', async () => {
    const r = await deleteBodyDef.build(f({ bodies: ['b_1', 'b_9'] }), {}, ctxOf(scriptKernel(), BODIES, { doc: docOf }));
    expect(r).toEqual({ ok: false, message: 'Body-Delete 1 failed: a deleted body is not there at this point' });
    const two = await deleteBodyDef.build(f({ bodies: ['b_1', 'b_2'] }), {}, ctxOf(scriptKernel(), [BODIES[0]], { doc: docOf }));
    expect(two).toEqual({ ok: false, message: 'Body-Delete 1 failed: Body 2 is not there at this point' });
    expect(deleteBodyDef.incomplete(f({ bodies: [] }), units)).toBe('Pick the bodies to delete');
    expect(deleteBodyDef.create(docOf, {})).toMatchObject({ type: 'delete_body', name: 'Body-Delete 1', bodies: [] });
  });
});

const live: DocService[] = [];
afterEach(() => {
  for (const d of live.splice(0)) d.dispose();
});

function makeDoc() {
  const ws = createFakeWorkspace({ hostVersion: '1.2' });
  const bridge = createBridge(ws);
  const bus = createBus<CadEvents>();
  const kernel = new BlockKernel();
  const doc = createDocService({ bridge, kernel, bus, saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  doc.features.register(deleteBodyDef as unknown as FeatureTypeDef);
  live.push(doc);
  return { ws, bridge, bus, kernel, doc };
}

const shown = (doc: DocService) => doc.state.get().rebuild.bodies.map((b) => b.name);
const names = (doc: DocService) => doc.state.get().doc.features.map((g) => g.name);

describe('Delete body: through the document', () => {
  it('one feature, one undo step: the body goes from the model; Undo brings it back, Redo takes it again; suppress brings it back', async () => {
    const { doc } = makeDoc();
    await doc.load();
    const one = block(doc);
    const two = block(doc, { at: [40, 0, 0] });
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 1', 'Body 2']);
    const steps = doc.state.get().history;
    doc.beginNew('delete_body', { bodies: [one.body!] } as Partial<Feature>).commit();
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 2']);
    expect(names(doc).at(-1)).toBe('Body-Delete 1');
    const id = doc.state.get().doc.features.at(-1)!.id;
    expect(doc.state.get().rebuild.features[id]?.state).toBe('ok');
    expect(doc.state.get().history).toMatchObject({ canUndo: true, undoLabel: 'Body-Delete 1' });
    // Its body's definition stays (Extrude 1 still makes it): Undo and Redo only move the feature.
    expect(doc.state.get().doc.bodies[one.body!]?.name).toBe('Body 1');
    doc.undo();
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 1', 'Body 2']);
    expect(doc.state.get().history.undoLabel).toBe(steps.undoLabel);
    doc.redo();
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 2']);
    expect(doc.setSuppressed(id, true)).toEqual({ ok: true });
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 1', 'Body 2']);
    expect(doc.setSuppressed(id, false)).toEqual({ ok: true });
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 2']);
    // It uses the body: the Extrude that makes it cannot go first, nor move below it.
    expect(doc.removeBlock(one.extrude)).toBe('Body-Delete 1 uses Body 1 of Extrude 1: delete Body-Delete 1 or change what it uses first');
    // Deleted, the body is back.
    expect(doc.remove(id)).toEqual({ ok: true });
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 1', 'Body 2']);
    void two;
  });

  it('a body lost before it fails it red with the model as before it; an edit brings it back to ok', async () => {
    const { doc } = makeDoc();
    await doc.load();
    const one = block(doc);
    block(doc, { at: [40, 0, 0] });
    await doc.settled();
    doc.beginNew('delete_body', { bodies: [one.body!, 'b_gone'] } as Partial<Feature>).commit();
    await doc.settled();
    const id = doc.state.get().doc.features.at(-1)!.id;
    expect(doc.state.get().rebuild.features[id]).toMatchObject({ state: 'error', message: 'Body-Delete 1 failed: a deleted body is not there at this point' });
    expect(shown(doc)).toEqual(['Body 1', 'Body 2']);
    const s = doc.beginEdit(id);
    s.update({ bodies: [one.body!] } as Partial<Feature>);
    s.commit();
    await doc.settled();
    expect(doc.state.get().rebuild.features[id]?.state).toBe('ok');
    expect(shown(doc)).toEqual(['Body 2']);
  });

  it('a stored Part keeps it as it is', () => {
    const raw = { schema: 2, units: { length: 'mm', angle: 'deg' }, params: [], bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } }, features: [{ id: 'f_d', type: 'delete_body', name: 'Body-Delete 1', bodies: ['b_1'] }] };
    expect(readDoc(raw).features).toEqual([{ id: 'f_d', type: 'delete_body', name: 'Body-Delete 1', bodies: ['b_1'] }]);
  });
});

/** The app's services on the real document over the toy kernel, the delete_body module installed. */
async function makeServices() {
  const d = makeDoc();
  let services: AppServices | null = null;
  services = {
    bridge: d.bridge,
    bus: d.bus,
    commands: createCommandRegistry(() => services!),
    keyboard: createKeyboard(document),
    kernel: d.kernel,
    doc: d.doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle: null }),
    modules: createModuleRegistry([deleteBodyModule]),
    apis: createStateStore<AreaApis>({ sketch: null, solver: null, files: null }),
  };
  await d.doc.load();
  return { ...d, services };
}

const item = (menu: MenuEntry[], id: string) => menu.find((e): e is MenuItem => e.id === id && !('sep' in e));

describe("Delete body: the body menu's Delete and the Delete key", () => {
  it('Delete <body> is the last item, in danger red; disabled with the reason while the Part cannot be edited; it adds Body-Delete 1 in one undo step', async () => {
    const { doc, services } = await makeServices();
    const one = block(doc);
    block(doc, { at: [40, 0, 0] });
    await doc.settled();
    const ui = uiFor(services);
    let menu = ui.bodyMenu(one.body!);
    expect(menu.at(-1)).toMatchObject({ id: 'body-delete', label: 'Delete Body 1', danger: true, disabled: null });
    expect(menu.map((e) => e.id).slice(-5)).toEqual(['sep-keybinds', 'set-keybind-ui.delete', 'set-keybind-ui.rename', 'sep-body-delete', 'body-delete']);
    const off = ui.addEditBlock(() => 'Edit in CAD is still opening the geometry');
    menu = ui.bodyMenu(one.body!);
    expect(item(menu, 'body-delete')?.disabled).toBe('Edit in CAD is still opening the geometry');
    off();
    const undoBefore = doc.state.get().history.undoLabel;
    item(ui.bodyMenu(one.body!), 'body-delete')!.run();
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 2']);
    expect(names(doc).at(-1)).toBe('Body-Delete 1');
    doc.undo();
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 1', 'Body 2']);
    expect(doc.state.get().history.undoLabel).toBe(undoBefore);
    ui.dispose();
  });

  it('two bodies selected: "Delete 2 bodies", one feature for both; the Delete key with only bodies selected does the same; the deleted bodies leave the selection', async () => {
    const { doc, services } = await makeServices();
    const one = block(doc);
    const two = block(doc, { at: [40, 0, 0] });
    block(doc, { at: [80, 0, 0] });
    await doc.settled();
    const ui = uiFor(services);
    services.selection.set((s) => ({ ...s, items: [{ kind: 'body', body: one.body! }, { kind: 'body', body: two.body! }] }));
    const del = item(ui.bodyMenu(two.body!), 'body-delete')!;
    expect(del.label).toBe('Delete 2 bodies');
    del.run();
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 3']);
    const made = doc.state.get().doc.features.filter((g) => g.type === 'delete_body') as DeleteBodyFeature[];
    expect(made.map((g) => g.bodies)).toEqual([[one.body, two.body]]);
    expect(services.selection.get().items).toEqual([]);
    doc.undo();
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 1', 'Body 2', 'Body 3']);
    // The Delete key (ui.delete) with only bodies selected.
    const offUi = installUi(services);
    services.selection.set((s) => ({ ...s, items: [{ kind: 'body', body: one.body! }, { kind: 'body', body: two.body! }] }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(doc.state.get().doc.features.filter((g) => g.type === 'delete_body')).toHaveLength(1));
    await doc.settled();
    expect(shown(doc)).toEqual(['Body 3']);
    expect((doc.state.get().doc.features.at(-1) as DeleteBodyFeature).bodies).toEqual([one.body, two.body]);
    offUi();
  });
});
