// Move/copy body where the person finds it and what is said of it: the body menu's "Move/copy
// Body 1…" above its Delete (several bodies selected: "Move/copy 2 bodies…"), disabled with the
// reason while the Part cannot be edited, opening the panel with the bodies in it; MODIFY's command
// (key M in model mode) with the selected bodies; the feature's name following Keep a copy
// (Body-Move 1 / Body-Copy 1, a name the person gave stays); and the words the history's readers
// get (get_model's "does", the person's changes the Assistant is told): "moved Body 1 by (20, 0, 0) mm".
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandRegistry } from '../../../src/app/commands';
import { KEYMAP } from '../../../src/app/keymap';
import { createKeyboard } from '../../../src/app/keyboard';
import { describeChanges } from '../../../src/assistant/rev';
import { createDocService } from '../../../src/doc';
import { emptyDoc } from '../../../src/doc/schema';
import { copyBodyName, storedBodyName } from '../../../src/doc/features/body-ids';
import deleteBodyModule from '../../../src/features/delete_body';
import { deleteBodyDef } from '../../../src/features/delete_body/feature';
import moveBodyModule, { MOVE_BODY_COMMAND } from '../../../src/features/move_body';
import { moveBodyDef, nameForCopy } from '../../../src/features/move_body/feature';
import { isZeroExpr, moveWords, vecWords } from '../../../src/features/move_body/words';
import { createBridge } from '../../../src/lib/bridge';
import { createBus } from '../../../src/lib/bus';
import { createSelectionStore } from '../../../src/lib/selection';
import { createStateStore } from '../../../src/lib/store';
import { createModuleRegistry } from '../../../src/modules';
import type { AppServices, AreaApis } from '../../../src/types/app';
import type { Mode } from '../../../src/types/commands';
import type { CadDoc, MoveBodyFeature } from '../../../src/types/doc';
import type { DocService, FeatureTypeDef } from '../../../src/types/doc-service';
import type { CadEvents } from '../../../src/types/events';
import type { ViewportHandle } from '../../../src/types/viewport';
import { uiFor } from '../../../src/ui/controller';
import type { MenuEntry, MenuItem } from '../../../src/ui/kit';
import { createFakeWorkspace } from '../../fakes/workspace-sdk';
import { block, BlockKernel, registerSolidFeatures } from '../../doc/blocks';

const live: DocService[] = [];
afterEach(() => {
  for (const d of live.splice(0)) d.dispose();
});

async function makeServices() {
  const ws = createFakeWorkspace({ hostVersion: '1.2' });
  const bridge = createBridge(ws);
  const bus = createBus<CadEvents>();
  const kernel = new BlockKernel();
  const doc = createDocService({ bridge, kernel, bus, saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  doc.features.register(deleteBodyDef as unknown as FeatureTypeDef);
  doc.features.register(moveBodyDef as unknown as FeatureTypeDef);
  live.push(doc);
  let services: AppServices | null = null;
  services = {
    bridge,
    bus,
    commands: createCommandRegistry(() => services!),
    keyboard: createKeyboard(document),
    kernel,
    doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle: null }),
    modules: createModuleRegistry([deleteBodyModule, moveBodyModule]),
    apis: createStateStore<AreaApis>({ sketch: null, solver: null, files: null }),
  };
  await doc.load();
  return { doc, services };
}

const item = (menu: MenuEntry[], id: string) => menu.find((e): e is MenuItem => e.id === id && !('sep' in e));

describe('Move/copy body: where the person finds it', () => {
  it("the body menu has Move/copy Body 1… just above Delete Body 1; disabled with the reason while the Part cannot be edited; it opens the panel with the body", async () => {
    const { doc, services } = await makeServices();
    const one = block(doc);
    const two = block(doc, { at: [40, 0, 0] });
    await doc.settled();
    const ui = uiFor(services);
    let menu = ui.bodyMenu(one.body!);
    expect(menu.map((e) => e.id).slice(-3)).toEqual(['sep-body-delete', 'body-move', 'body-delete']);
    expect(item(menu, 'body-move')).toMatchObject({ label: 'Move/copy Body 1…', disabled: null });
    expect(item(menu, 'body-move')).not.toHaveProperty('danger');
    const off = ui.addEditBlock(() => 'Edit in CAD is still opening the geometry');
    menu = ui.bodyMenu(one.body!);
    expect(item(menu, 'body-move')?.disabled).toBe('Edit in CAD is still opening the geometry');
    off();
    item(ui.bodyMenu(one.body!), 'body-move')!.run();
    expect(ui.state.get().panel).toMatchObject({ kind: 'feature', type: 'move_body', isNew: true });
    const s = doc.session()!;
    expect(s.draft).toMatchObject({ type: 'move_body', name: 'Body-Move 1', bodies: [one.body] });
    // Nothing typed yet: not applied (nothing to move), and Done says why.
    expect(s.incomplete()).toBe('Nothing to move: give a distance or an angle');
    ui.closePanel();
    // Two bodies selected, this one among them: "Move/copy 2 bodies…" with both.
    services.selection.set((st) => ({ ...st, items: [{ kind: 'body', body: one.body! }, { kind: 'body', body: two.body! }] }));
    const both = item(ui.bodyMenu(two.body!), 'body-move')!;
    expect(both.label).toBe('Move/copy 2 bodies…');
    both.run();
    expect(doc.session()!.draft).toMatchObject({ bodies: [one.body, two.body] });
    ui.closePanel();
    ui.dispose();
  });

  it("MODIFY's command opens it with the selected bodies; its key is M in model mode (M is Mirror only in a sketch)", async () => {
    const { doc, services } = await makeServices();
    const one = block(doc);
    await doc.settled();
    const ui = uiFor(services);
    const off = moveBodyModule.install!(services);
    const cmd = services.commands.get(MOVE_BODY_COMMAND)!;
    expect(cmd).toMatchObject({ label: 'Move/copy body', group: 'modify' });
    services.selection.set((st) => ({ ...st, items: [{ kind: 'body', body: one.body! }] }));
    await services.commands.run(MOVE_BODY_COMMAND);
    expect(doc.session()!.draft).toMatchObject({ type: 'move_body', bodies: [one.body] });
    ui.closePanel();
    expect(KEYMAP.find((e) => e.id === MOVE_BODY_COMMAND)).toMatchObject({ label: 'Move/copy body', group: 'Modify', context: 'model', keys: ['KeyM'] });
    expect(KEYMAP.filter((e) => e.keys.includes('KeyM')).map((e) => [e.id, e.context])).toEqual([
      ['modify.move-body', 'model'],
      ['sketch.mirror', 'sketch'],
    ]);
    off();
    ui.dispose();
  });
});

describe('Move/copy body: its name and its words', () => {
  it('Body-Move 1 becomes Body-Copy 1 with Keep a copy and back; a name the person gave stays', () => {
    expect(nameForCopy('Body-Move 1', true, ['Body-Move 2'])).toBe('Body-Copy 1');
    expect(nameForCopy('Body-Copy 1', false, ['Body-Move 1'])).toBe('Body-Move 2');
    expect(nameForCopy('Body-Move 3', false, [])).toBe('Body-Move 3');
    expect(nameForCopy('Lift', true, [])).toBe('Lift');
    expect(moveBodyDef.create(emptyDoc('metric'), { copy: true }).name).toBe('Body-Copy 1');
  });

  it('a copy is "<body> (Copy)", "(Copy 2)" for a second copy of the same body; the Part alone names one not built', () => {
    const f = (id: string, bodies: string[], copy = true) => ({ id, type: 'move_body', name: id, bodies, move: ['1 mm', '0 mm', '0 mm'], angle: '0 deg', about: 'z', axis: null, pivot: null, copy }) as MoveBodyFeature;
    const doc: CadDoc = { ...emptyDoc('metric'), bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } }, features: [f('f_a', ['b_1']), f('f_m', ['b_1'], false), f('f_b', ['b_1'])] };
    expect(copyBodyName(doc, 'f_a', 'b_1', 'Body 1')).toBe('Body 1 (Copy)');
    expect(copyBodyName(doc, 'f_b', 'b_1', 'Body 1')).toBe('Body 1 (Copy 2)');
    expect(storedBodyName(doc, 'b_1.b.1')).toBe('Body 1 (Copy 2)');
    expect(storedBodyName(doc, 'b_1.a.1')).toBe('Body 1 (Copy)');
  });

  it('what it does, in words; get_model and the changes the Assistant is told say it', () => {
    const name = (id: string) => ({ b_1: 'Body 1', b_2: 'Body 2' })[id] ?? id;
    const base = moveBodyDef.create(emptyDoc('metric'), { bodies: ['b_1'] });
    expect(moveWords({ ...base, move: ['20 mm', '0 mm', '0 mm'] }, name, () => '')).toBe('moved Body 1 by (20, 0, 0) mm');
    expect(moveWords({ ...base, copy: true, bodies: ['b_1', 'b_2'], move: ['L / 2', '0 mm', '5 mm'] }, name, () => '')).toBe('copied Body 1 and Body 2 by (L / 2, 0 mm, 5 mm)');
    expect(moveWords({ ...base, angle: '90 deg', about: 'z', move: ['0 mm', '0 mm', '5 mm'] }, name, () => '')).toBe('moved Body 1, turned 90 deg about Z through its centre, then moved by (0, 0, 5) mm');
    expect(moveWords({ ...base, angle: '45 deg', about: 'x', pivot: ['0 mm', '10 mm', '0 mm'] }, name, () => '')).toBe('moved Body 1, turned 45 deg about X through (0, 10, 0) mm');
    expect(moveWords({ ...base, angle: '30 deg', about: 'axis', axis: { kind: 'origin', axis: 'origin:y' } }, name, () => 'Y axis')).toBe('moved Body 1, turned 30 deg about Y axis');
    expect(moveWords({ ...base, copy: true }, name, () => '')).toBe('copied Body 1 in place');
    expect(vecWords(['1 in', '2 in', '0 mm'])).toBe('(1, 2, 0) in');
    expect(isZeroExpr('-0.0 deg')).toBe(true);
    expect(isZeroExpr('a')).toBe(false);
    // The person's changes, as the Assistant is told them.
    const before: CadDoc = { ...emptyDoc('metric'), bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } } };
    const added: CadDoc = { ...before, features: [{ ...base, id: 'f_m', move: ['20 mm', '0 mm', '0 mm'] }] };
    expect(describeChanges(before, added)).toEqual(['added Body-Move 1 (move_body): moved Body 1 by (20, 0, 0) mm']);
    const changed: CadDoc = { ...added, features: [{ ...(added.features[0] as MoveBodyFeature), move: ['0 mm', '0 mm', '0 mm'], angle: '90 deg', about: 'axis', axis: { kind: 'origin', axis: 'origin:x' } }] };
    expect(describeChanges(added, changed)).toEqual(['changed Body-Move 1: now moved Body 1, turned 90 deg about X axis']);
  });
});
