// DocService.editParams: parameters added, changed and removed in one undo
// step, the final set checked once, so the rows can come in any order (uses of
// parameters added later in the same call, swaps, a rename and a use of the new
// name), and a refusal names the row at fault.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createDocService } from '../../src/doc';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { ExtrudeFeature, ParamId } from '../../src/types/doc';
import type { DocService } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { block, BlockKernel, registerSolidFeatures } from './blocks';

const services: DocService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

async function open() {
  const doc = createDocService({ bridge: createBridge(createFakeWorkspace()), kernel: new BlockKernel(), bus: createBus<CadEvents>(), saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
  registerSolidFeatures(doc);
  services.push(doc);
  await doc.load();
  return doc;
}

const len = (name: string) => ({ name, quantity: 'length' as const });
const valueOf = (doc: DocService, name: string) => {
  const r = doc.units.evaluate(name, 'length');
  return r.ok ? Math.round(r.value * 1e9) / 1e9 : r.error;
};
const params = (doc: DocService) => doc.state.get().doc.params.map((p) => [p.name, p.expr]);
const idOf = (doc: DocService, name: string) => doc.state.get().doc.params.find((p) => p.name === name)!.id;
const history = (doc: DocService) => doc.state.get().history;

describe('DocService.editParams', () => {
  it('adds that use parameters added after them, in one undo step', async () => {
    const doc = await open();
    const r = doc.editParams({
      add: [
        { ...len('floor_t'), expr: '(chip_t - disc_t)/2' },
        { ...len('chip_t'), expr: '3.3 mm' },
        { ...len('disc_t'), expr: '1 mm' },
      ],
      change: [],
      remove: [],
    });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.ids!)).toEqual(['floor_t', 'chip_t', 'disc_t']);
    expect(r.ids!.chip_t).toBe(idOf(doc, 'chip_t'));
    expect(valueOf(doc, 'floor_t')).toBe(1.15);
    expect(history(doc).undoLabel).toBe('Parameters: 3 changed');
    doc.undo();
    expect(params(doc)).toEqual([]);
    expect(history(doc).canUndo).toBe(false);
    // Row by row, the first would have been refused.
    expect(doc.addParam({ ...len('floor_t'), expr: '(chip_t - disc_t)/2' })).toMatchObject({ ok: false });
  });

  it('a swap of which uses which (w = 2*d, d = 10 mm, where d was w/2)', async () => {
    const doc = await open();
    doc.editParams({ add: [{ ...len('w'), expr: '20 mm' }, { ...len('d'), expr: 'w/2' }], change: [], remove: [] });
    const w = idOf(doc, 'w');
    const d = idOf(doc, 'd');
    // One row at a time it is a cycle.
    expect(doc.updateParam(w, { expr: '2*d' })).toMatchObject({ ok: false, reason: expect.stringMatching(/^Circular reference/) });
    const r = doc.editParams({ add: [], change: [{ id: w, patch: { expr: '2*d' } }, { id: d, patch: { expr: '10 mm' } }], remove: [] }, 'Swap');
    expect(r).toEqual({ ok: true, ids: {} });
    expect(params(doc)).toEqual([
      ['w', '2*d'],
      ['d', '10 mm'],
    ]);
    expect(valueOf(doc, 'w')).toBe(20);
    expect(history(doc).undoLabel).toBe('Swap');
  });

  it('a rename rewrites every use, and a row of the same call may use the new name', async () => {
    const doc = await open();
    doc.editParams({ add: [{ ...len('w'), expr: '20 mm' }, { ...len('h'), expr: 'w*2' }], change: [], remove: [] });
    const a = block(doc, { extrude: { extent: { kind: 'blind', distance: 'w' } } });
    const r = doc.editParams({ add: [{ ...len('half'), expr: 'width/2' }], change: [{ id: idOf(doc, 'w'), patch: { name: 'width' } }], remove: [] });
    expect(r.ok).toBe(true);
    expect(params(doc)).toEqual([
      ['width', '20 mm'],
      ['h', 'width*2'],
      ['half', 'width/2'],
    ]);
    const ex = doc.state.get().doc.features.find((f) => f.id === a.extrude) as ExtrudeFeature;
    expect(ex.extent).toMatchObject({ kind: 'blind', distance: 'width' });
    expect(valueOf(doc, 'half')).toBe(10);
    expect(history(doc).undoLabel).toBe('Parameters: 2 changed');
  });

  it('a removal still used in the final model is refused, naming the row; one no longer used goes', async () => {
    const doc = await open();
    doc.editParams({ add: [{ ...len('w'), expr: '20 mm' }, { ...len('d'), expr: '5 mm' }, { ...len('t'), expr: 'd*2' }], change: [], remove: [] });
    block(doc, { extrude: { extent: { kind: 'blind', distance: 'w' } } });
    const before = doc.state.get();
    expect(doc.editParams({ add: [], change: [], remove: [idOf(doc, 'd'), idOf(doc, 'w')] })).toEqual({ ok: false, row: 'remove[0]', reason: "d can't be deleted: t uses it" });
    expect(doc.editParams({ add: [], change: [{ id: idOf(doc, 't'), patch: { expr: '10 mm' } }], remove: [idOf(doc, 'w')] })).toEqual({ ok: false, row: 'remove[0]', reason: "w can't be deleted: Extrude 1 uses it" });
    expect(doc.state.get().doc).toBe(before.doc);
    expect(history(doc)).toEqual(before.history);
    // The use goes in the same call: the removal is fine.
    expect(doc.editParams({ add: [], change: [{ id: idOf(doc, 't'), patch: { expr: '10 mm' } }], remove: [idOf(doc, 'd')] })).toEqual({ ok: true, ids: {} });
    expect(params(doc)).toEqual([
      ['w', '20 mm'],
      ['t', '10 mm'],
    ]);
  });

  it('every refusal names its row and changes nothing', async () => {
    const doc = await open();
    doc.editParams({ add: [{ ...len('w'), expr: '20 mm' }, { ...len('d'), expr: '5 mm' }, { ...len('h'), expr: 'w*2' }], change: [], remove: [] });
    const w = idOf(doc, 'w');
    const d = idOf(doc, 'd');
    const before = doc.state.get();
    const cases: [Parameters<DocService['editParams']>[0], { row?: string; reason: string | RegExp }][] = [
      [{ add: [{ ...len('ok'), expr: '1 mm' }, { ...len('2bad'), expr: '1 mm' }], change: [], remove: [] }, { row: 'add[1]', reason: 'A name starts with a letter or _ and has only letters, digits and _' }],
      [{ add: [{ ...len('w'), expr: '1 mm' }], change: [], remove: [] }, { row: 'add[0]', reason: 'There is already a parameter called w' }],
      [{ add: [{ ...len('x'), expr: 'nope + 1 mm' }], change: [], remove: [] }, { row: 'add[0]', reason: /nope/ }],
      [{ add: [], change: [{ id: 'p_missing' as ParamId, patch: { expr: '1 mm' } }], remove: [] }, { row: 'change[0]', reason: 'That parameter is not in the part' }],
      [{ add: [], change: [{ id: w, patch: { expr: '1 mm' } }, { id: w, patch: { expr: '2 mm' } }], remove: [] }, { row: 'change[1]', reason: 'w is changed twice in this edit' }],
      [{ add: [], change: [], remove: ['p_missing' as ParamId] }, { row: 'remove[0]', reason: 'That parameter is not in the part' }],
      [{ add: [], change: [{ id: d, patch: { expr: '1 mm' } }], remove: [d] }, { row: 'remove[0]', reason: 'd is both changed and removed in this edit' }],
      // A rename to the old name of another parameter this call renames or removes: its uses could not be told apart.
      [{ add: [], change: [{ id: w, patch: { name: 'd' } }, { id: d, patch: { name: 'w' } }], remove: [] }, { row: 'change[0]', reason: 'd is the name of a parameter this edit renames or removes: rename them in two edits' }],
      [{ add: [], change: [{ id: w, patch: { name: 'd' } }], remove: [d] }, { row: 'change[0]', reason: 'd is the name of a parameter this edit renames or removes: rename them in two edits' }],
      [{ add: [], change: [{ id: w, patch: { quantity: 'volume' as never } }], remove: [] }, { row: 'change[0]', reason: 'Pick length, angle or number' }],
      // A parameter no row names that evaluated before breaks: refused in its own name.
      [{ add: [], change: [{ id: w, patch: { expr: '30 deg', quantity: 'angle' } }], remove: [] }, { reason: /^h: / }],
    ];
    for (const [rows, want] of cases) {
      const r = doc.editParams(rows);
      expect(r.ok, JSON.stringify(rows)).toBe(false);
      if (r.ok) continue;
      if (want.row) expect(r.row, JSON.stringify(rows)).toBe(want.row);
      else expect(r.row, JSON.stringify(rows)).toBeUndefined();
      if (typeof want.reason === 'string') expect(r.reason).toBe(want.reason);
      else expect(r.reason).toMatch(want.reason);
      expect(doc.state.get().doc, JSON.stringify(rows)).toBe(before.doc);
      expect(history(doc)).toEqual(before.history);
    }
  });

  it('nothing to do makes no undo step; a parameter already broken does not block others', async () => {
    const ws = createFakeWorkspace({
      study: { doc: { rel: 'studies/st-test/model.json', schema: 1, store: 'data', view: 'studies/st-test/view.json' } },
    });
    ws.folder.putJson('studies/st-test/model.json', {
      format: 'magnusim-cad/model',
      etag: '1',
      saved_at: '',
      doc: {
        schema: 2,
        units: { length: 'mm', angle: 'deg' },
        params: [
          { id: 'p_bad', name: 'bad', expr: 'missing * 2', quantity: 'length' },
          { id: 'p_w', name: 'w', expr: '20 mm', quantity: 'length' },
        ],
        bodies: {},
        features: [],
        meta: { created_at: '2026-10-17T00:00:00.000Z', written_by: '0.1.0' },
      },
    });
    const doc = createDocService({ bridge: createBridge(ws), kernel: new BlockKernel(), bus: createBus<CadEvents>(), saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
    registerSolidFeatures(doc);
    services.push(doc);
    await doc.load();
    expect(doc.state.get().status).toBe('ready');
    const before = doc.state.get();
    expect(doc.editParams({ add: [], change: [], remove: [] })).toEqual({ ok: true, ids: {} });
    expect(doc.editParams({ add: [], change: [{ id: 'p_w', patch: { expr: '20 mm' } }], remove: [] })).toEqual({ ok: true, ids: {} });
    expect(doc.state.get().doc).toBe(before.doc);
    expect(history(doc).canUndo).toBe(false);
    expect(doc.editParams({ add: [], change: [{ id: 'p_w', patch: { expr: '25 mm' } }], remove: [] })).toEqual({ ok: true, ids: {} });
    expect(valueOf(doc, 'w')).toBe(25);
    expect(history(doc).undoLabel).toBe('Parameters: 1 changed');
  });
});
