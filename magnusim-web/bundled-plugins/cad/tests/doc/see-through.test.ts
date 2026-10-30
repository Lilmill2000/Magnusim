// See-through bodies as the Part keeps them (Daniel 2026-10-29: a view state like hiddenBodies):
// CadView.seeThroughBodies read from view.json (an older one without it loads unchanged), set by
// DocService.setBodiesSeeThrough with no undo step and saved, read back on reopen, and a body that
// goes with its feature's delete leaves the list as it leaves hiddenBodies.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../src/doc';
import { emptyView, readView } from '../../src/doc/schema';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { CadView } from '../../src/types/doc';
import type { DocService } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace, type FakeWorkspace } from '../fakes/workspace-sdk';
import { block, BlockKernel, registerSolidFeatures } from './blocks';

const VIEW = 'studies/st-test/view.json';

const services: DocService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

async function open(ws: FakeWorkspace = createFakeWorkspace()) {
  const doc = createDocService({ bridge: createBridge(ws), kernel: new BlockKernel(), bus: createBus<CadEvents>(), saveIntervalMs: 20, saveViewIntervalMs: 20 });
  registerSolidFeatures(doc);
  services.push(doc);
  await doc.load();
  return { ws, doc };
}

async function rebuilt(doc: DocService) {
  await vi.waitFor(() => expect(doc.state.get().rebuild.status).toBe('done'), { timeout: 2000, interval: 5 });
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(() => expect(doc.state.get().rebuild.status).toBe('done'), { timeout: 2000, interval: 5 });
}

const savedView = (ws: FakeWorkspace) => (ws.json(VIEW) as { view: CadView }).view;

describe('see-through bodies in the Part view (CadView.seeThroughBodies)', () => {
  it('an older view.json without the list loads unchanged (none see-through, no field); a stored list is read as hiddenBodies is (strings only), once each; an empty one is no field', () => {
    const old = { rollback: null, hiddenBodies: ['b_2'], expanded: ['origin'] };
    expect(readView(old, 3)).toEqual({ ...emptyView(), hiddenBodies: ['b_2'] });
    expect(readView(old, 3)).not.toHaveProperty('seeThroughBodies');
    expect(emptyView()).not.toHaveProperty('seeThroughBodies');
    expect(readView({ ...old, seeThroughBodies: ['b_1', 7, null, 'b_3', 'b_1'] }, 3).seeThroughBodies).toEqual(['b_1', 'b_3']);
    expect(readView({ ...old, seeThroughBodies: [] }, 3)).not.toHaveProperty('seeThroughBodies');
    expect(readView({ ...old, seeThroughBodies: 'b_1' }, 3)).not.toHaveProperty('seeThroughBodies');
  });

  it('setBodiesSeeThrough: no undo step, saved in view.json, read back on reopen; opaque again takes the field away', async () => {
    const { doc, ws } = await open();
    const one = block(doc).body!;
    const two = block(doc, { at: [40, 0, 0] }).body!;
    await rebuilt(doc);
    const steps = doc.state.get().history.undoLabel;
    const rebuilds = doc.state.get().rebuild.seq;
    doc.setBodiesSeeThrough([one, two, one], true);
    expect(doc.state.get().view.seeThroughBodies).toEqual([one, two]);
    // A view state: no undo step, no rebuild.
    expect(doc.state.get().history.undoLabel).toBe(steps);
    expect(doc.state.get().rebuild.seq).toBe(rebuilds);
    // Again: nothing changes (the same view object).
    const view = doc.state.get().view;
    doc.setBodiesSeeThrough([one], true);
    expect(doc.state.get().view).toBe(view);
    await doc.flush();
    expect(savedView(ws).seeThroughBodies).toEqual([one, two]);
    doc.dispose();

    const again = (await open(ws)).doc;
    expect(again.state.get().view.seeThroughBodies).toEqual([one, two]);
    again.setBodiesSeeThrough([one], false);
    expect(again.state.get().view.seeThroughBodies).toEqual([two]);
    again.setBodiesSeeThrough([two], false);
    expect(again.state.get().view).not.toHaveProperty('seeThroughBodies');
    await again.flush();
    expect(savedView(ws)).not.toHaveProperty('seeThroughBodies');
  });

  it("deleting the feature that makes a see-through body takes the body out of the list, as out of hiddenBodies; Undo brings the body back opaque (view state is not undone)", async () => {
    const { doc } = await open();
    const keep = block(doc).body!;
    const made = block(doc, { at: [40, 0, 0] });
    await rebuilt(doc);
    doc.setBodiesSeeThrough([keep, made.body!], true);
    doc.setBodyVisible(made.body!, false);
    expect(doc.remove(made.extrude)).toEqual({ ok: true });
    expect(doc.state.get().view.seeThroughBodies).toEqual([keep]);
    expect(doc.state.get().view.hiddenBodies).toEqual([]);
    // The last one gone: no field.
    doc.undo();
    await rebuilt(doc);
    expect(doc.state.get().view.seeThroughBodies).toEqual([keep]);
    const first = doc.state.get().doc.features.find((f) => f.type === 'extrude')!;
    expect(doc.remove(first.id)).toEqual({ ok: true });
    expect(doc.state.get().view).not.toHaveProperty('seeThroughBodies');
  });
});
