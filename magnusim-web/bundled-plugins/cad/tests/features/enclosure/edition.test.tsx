// Magnusim CAD's Part (Daniel 2026-10-29: hide every project and simulation item there) in the
// mounted UI over the real DocService, against Magnusim's. The host's welcome says projectLinks
// false: no CFD PREP group and no Enclosure command (toolbar, key, registry, the Part's keybinds),
// the Banana's hint says nothing of a simulation, an Enclosure made in Magnusim keeps building its
// body and opens read-only (shape, bodies, size and why: no fields, no arrows, no word of the fluid
// or the air), a Combine on its body leaves Keep the tool bodies as the person set it, and the
// volume chip puts no body first for being an Enclosure's. Absent (Magnusim), all of them are there.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createKeybinds } from '../../../src/app/keybinds';
import { KEYMAP, keymapFor } from '../../../src/app/keymap';
import combineModule from '../../../src/features/combine';
import enclosureModule from '../../../src/features/enclosure';
import { HANDLES_TOOL_ID } from '../../../src/features/enclosure/handles';
import { KEPT_WORDS } from '../../../src/features/enclosure/kept';
import scaleModule from '../../../src/features/scale';
import type { EnclosureFeature, Feature } from '../../../src/types/doc';
import { cfdFirst, volumeListShown } from '../../../src/ui/StatusDock';
import { block, blockRegions } from '../../doc/blocks';
import { startApp, type FakeApp } from '../extrude/fake-app';

let app: FakeApp | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

/** A 20 mm block and an Enclosure around it (5 mm out on every side), as a Part made in Magnusim has them. */
async function start(projectLinks?: boolean) {
  app = await startApp({ modules: [enclosureModule, combineModule, scaleModule], ...(projectLinks === undefined ? {} : { projectLinks }) });
  const a = app;
  a.kernel.regionsFor = blockRegions;
  act(() => void block(a.doc));
  await a.settle();
  act(() => {
    const s = a.doc.beginNew('enclosure', { padding: 'fixed', distance: '5 mm' } as Partial<EnclosureFeature>);
    s.commit();
  });
  await a.settle();
  return a;
}

const enclosure = (a: FakeApp) => a.doc.state.get().doc.features.find((f) => f.type === 'enclosure') as EnclosureFeature;
const groups = (a: FakeApp) => a.$$('[data-cad-toolbar] .tb-group-label').map((g) => g.textContent);
const panel = (a: FakeApp) => a.$('[data-cad-panel="feature"]');
const openEnclosure = (a: FakeApp) => act(() => void fireEvent.doubleClick(a.$(`[data-tree-node="${enclosure(a).id}"] > .tree-row`)!));
const body = (a: FakeApp, name: string) => a.doc.state.get().rebuild.bodies.find((b) => b.name === name)!;

/** A new Combine with the Enclosure's body picked first in the tree, as the person picks it: its targets and Keep the tool bodies as the panel shows them. */
async function combineOnEnclosure(a: FakeApp): Promise<{ targets: string; keep: boolean }> {
  act(() => void fireEvent.click(a.$('[data-command="modify.combine"]')!));
  await a.settle();
  const folder = a.$('[data-cad-tree] [data-bodies-folder]')!;
  if (folder.getAttribute('aria-expanded') !== 'true') act(() => void fireEvent.click(folder.querySelector(':scope > .tree-row .tw')!));
  act(() => void fireEvent.click(a.$('[data-pick-list="targets"]')!));
  act(() => void fireEvent.click(a.$(`[data-body-row="${body(a, 'Enclosure 1').id}"] > .tree-row`)!));
  await a.settle();
  if (!panel(a)) throw new Error(`no Combine panel: ${a.$('[data-command="modify.combine"]')?.getAttribute('data-disabled-reason')}`);
  return { targets: a.$('[data-pick-list="targets"]')?.textContent ?? '', keep: a.$<HTMLInputElement>('[data-switch="keep-tools"] input')!.checked };
}

describe('Magnusim CAD (projectLinks false): no project or simulation items', () => {
  it('has no CFD PREP group and no Enclosure command: not on the toolbar, not in the registry, not among the Part\'s keys', async () => {
    const a = await start(false);
    expect(a.services.bridge.projectLinks()).toBe(false);
    expect(groups(a)).not.toContain('CFD PREP');
    expect(groups(a)).toEqual(expect.arrayContaining(['SOLID', 'MODIFY']));
    expect(a.$('[data-group="cfd"]')).toBeNull();
    expect(a.$('[data-command="cfd.enclosure"]')).toBeNull();
    expect(a.services.commands.get('cfd.enclosure')).toBeUndefined();
    expect(a.services.commands.toolbar('model').map((g) => g.group)).not.toContain('cfd');
    // The Part's keybinds (Set keybind, the Assistant's keybind_get) do not list it either.
    const keys = createKeybinds({ prefs: null, layout: false, projectLinks: false });
    expect(keys.entries().map((e) => e.id)).not.toContain('cfd.enclosure');
    expect(keys.entry('cfd.enclosure')).toBeNull();
    expect(keys.entries().map((e) => e.group)).not.toContain('CFD prep');
    expect(keymapFor(false)).toHaveLength(KEYMAP.length - 1);
    // The Banana's hint says nothing of a simulation.
    expect(a.services.commands.get('scale.banana')!.hint).toBe("Show a banana for scale. It's not part of the model");
  });

  it('an Enclosure made in Magnusim keeps its body and opens read-only: shape, bodies, size and why; no fields, arrows, fluid or air', async () => {
    const a = await start(false);
    expect(a.doc.state.get().rebuild.features[enclosure(a).id].state).toBe('ok');
    expect(body(a, 'Enclosure 1')).toBeTruthy();
    openEnclosure(a);
    await a.settle();
    expect(panel(a)).not.toBeNull();
    expect(a.$('[data-cad-panel] [data-panel-title]')?.textContent).toBe('Enclosure 1');
    expect(a.$('[data-enclosure-readout="shape"]')?.textContent).toBe('Box');
    expect(a.$('[data-enclosure-readout="bodies"]')?.textContent).toBe('All solid bodies (1): Body 1');
    expect(a.$('[data-enclosure-size]')?.textContent).toBe('Size: 30 mm × 30 mm × 30 mm · 27,000 mm³');
    expect(a.$('[data-enclosure-kept]')?.textContent).toBe(KEPT_WORDS);
    // Nothing to change: no inputs, no selects, no pick list, no "Use padding", no arrows in the view.
    expect(a.$$('[data-cad-panel] input, [data-cad-panel] select')).toEqual([]);
    expect(a.$('[data-cad-panel] [data-pick-list]')).toBeNull();
    expect(a.vp.tools.map((t) => t.id)).not.toContain(HANDLES_TOOL_ID);
    expect(panel(a)!.textContent).not.toMatch(/fluid|air|simulation|Combine/i);
    // Done closes it; the Enclosure is as it was.
    const before = enclosure(a);
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    await a.settle();
    expect(panel(a)).toBeNull();
    expect(enclosure(a)).toBe(before);
  });

  it("a Combine on the Enclosure's body leaves Keep the tool bodies off; the volume chip puts no Enclosure first", async () => {
    const a = await start(false);
    const c = await combineOnEnclosure(a);
    expect(c.targets).toContain('Enclosure 1');
    expect(c.keep).toBe(false);
    expect(cfdFirst(a.doc.state.get().doc.features, false).size).toBe(0);
  });
});

describe('Magnusim (projectLinks absent): every one of them is there', () => {
  it('has CFD PREP with Enclosure on the toolbar, in the registry and among the keys; the Banana\'s hint names the simulation', async () => {
    const a = await start();
    expect(a.services.bridge.projectLinks()).toBe(true);
    expect(groups(a)).toContain('CFD PREP');
    expect(a.$$('[data-group="cfd"] .tb-txt').map((b) => b.textContent)).toEqual(['Enclosure']);
    expect(a.services.commands.get('cfd.enclosure')?.hint).toBe('A box or a cylinder around the bodies, as a new body (for the air around the part: then Combine, Cut)');
    const keys = createKeybinds({ prefs: null, layout: false });
    expect(keys.entry('cfd.enclosure')).toMatchObject({ label: 'Enclosure', group: 'CFD prep', projects: true });
    expect(keymapFor(true)).toBe(KEYMAP);
    expect(a.services.commands.get('scale.banana')!.hint).toBe("Show a banana for scale. It's not part of the model or the simulation");
  });

  it('an Enclosure opens with its fields, its arrows and the air volume hint', async () => {
    const a = await start();
    openEnclosure(a);
    await a.settle();
    expect(a.$('[data-enclosure-kept]')).toBeNull();
    expect(a.$('[data-cad-panel] [data-field="padding"] select')).not.toBeNull();
    expect(a.vp.tools.map((t) => t.id)).toContain(HANDLES_TOOL_ID);
    expect(panel(a)!.textContent).toContain('The air volume is a separate Combine: Cut, with Keep the tool bodies on.');
  });

  it("a Combine on the Enclosure's body turns Keep the tool bodies on; the volume chip puts the Enclosure first", async () => {
    const a = await start();
    const c = await combineOnEnclosure(a);
    expect(c.targets).toContain('Enclosure 1');
    expect(c.keep).toBe(true);
    const enc = body(a, 'Enclosure 1').id;
    expect([...cfdFirst(a.doc.state.get().doc.features, true)]).toEqual([enc]);
  });
});

describe('the volume chip with more bodies than it lists', () => {
  // Five bodies, the Enclosure's the smallest: Magnusim keeps it in view, Magnusim CAD lists the biggest.
  const bodies = [
    { id: 'b_1', name: 'Body 1', volume: 500 },
    { id: 'b_2', name: 'Body 2', volume: 400 },
    { id: 'b_3', name: 'Body 3', volume: 300 },
    { id: 'b_4', name: 'Body 4', volume: 200 },
    { id: 'b_enc', name: 'Enclosure 1', volume: 100 },
  ];
  const features = [{ id: 'f_e', type: 'enclosure', name: 'Enclosure 1', creates: 'b_enc' }] as unknown as Feature[];
  it('Magnusim: the Enclosure first; Magnusim CAD: the biggest', () => {
    expect(volumeListShown(bodies, cfdFirst(features, true)).map((b) => b.id)).toEqual(['b_1', 'b_2', 'b_3', 'b_enc']);
    expect(volumeListShown(bodies, cfdFirst(features, false)).map((b) => b.id)).toEqual(['b_1', 'b_2', 'b_3', 'b_4']);
  });
});
